import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { startServer } from '../src/server/index.ts';
import type { Connection, GameServer } from '../src/shared/game.ts';
import { PROTOCOL_VERSION, type ServerMessage, type VoxelEdit } from '../src/shared/protocol.ts';
import { createServerMessageDecoder, encodeServerMessage } from '../src/shared/wire.ts';

const running: ReturnType<typeof startServer>[] = [];
const sockets: WebSocket[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of running.splice(0)) host.stop();
});

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for batched transport');
    await Bun.sleep(5);
  }
}

function fixture() {
  let now = 0;
  const host = startServer({ port: 0, hostname: '127.0.0.1', now: () => now,
    world: { seed: 12, size: 64, height: 32 } });
  running.push(host);
  return { host, advance: () => { now += 20; } };
}

async function connect(host: ReturnType<typeof startServer>, name: string) {
  const decode = createServerMessageDecoder();
  const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/ws`);
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  const peer = { socket, messages: [] as ServerMessage[], bytes: 0, closeCode: null as number | null };
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name })));
  socket.addEventListener('message', event => {
    peer.bytes += typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength;
    peer.messages.push(decode(event.data));
  });
  socket.addEventListener('close', event => { peer.closeCode = event.code; });
  await waitFor(() => peer.messages.some(message => message.type === 'snapshot'));
  const welcome = peer.messages.find(message => message.type === 'welcome')!;
  const connection = [...host.game.connections].find(connection => connection.player?.id === welcome.id)!;
  peer.messages.length = 0;
  peer.bytes = 0;
  return { connection, received: peer };
}

function send(game: GameServer, connection: Connection, message: ServerMessage, replaceable = false) {
  return (game as unknown as {
    send(connection: Connection, message: ServerMessage, replaceable?: boolean): boolean;
  }).send(connection, message, replaceable);
}

function encodedBytes(message: ServerMessage) {
  const encoded = encodeServerMessage(message);
  return typeof encoded === 'string' ? Buffer.byteLength(encoded) : encoded.byteLength;
}

async function status(host: ReturnType<typeof startServer>) {
  // Invoke the HTTP handler directly so a status captured inside step observes the unflushed queue.
  const response = await host.server.fetch(new Request(`http://127.0.0.1:${host.server.port}/health`));
  return response.json();
}

describe('bounded WebSocket batching', () => {
  test('preserves message order and byte accounting, and records traffic only when flushed', async () => {
    const { host, advance } = fixture();
    const peer = await connect(host, 'Ordered');
    const before = await status(host);
    const messages: ServerMessage[] = [
      { type: 'pong', time: 1 },
      { type: 'world', roundId: 1, revision: 1, edits: [[0, 1, 0, 0]] },
      { type: 'event', roundId: 1, event: 'build', position: { x: .5, y: 1.5, z: .5 } },
      { type: 'pong', time: 2 },
    ];
    const bytes = messages.reduce((sum, message) => sum + encodedBytes(message), 0);
    let queuedBytes = 0, during: ReturnType<typeof status> | undefined;
    const step = spyOn(host.game, 'step').mockImplementation(() => {
      for (const message of messages) expect(send(host.game, peer.connection, message)).toBe(true);
      queuedBytes = peer.connection.peer.bufferedAmount();
      during = status(host);
    });
    spies.push(step);
    advance();
    await waitFor(() => peer.received.messages.length === messages.length);
    expect(step).toHaveBeenCalledTimes(1);
    expect(queuedBytes).toBe(bytes);
    expect(peer.received.messages).toEqual(messages);
    expect(peer.received.bytes).toBe(bytes);
    const pending = await during!;
    expect(pending.bufferedBytes).toBe(bytes);
    expect(pending.network.sentMessages).toBe(before.network.sentMessages);
    expect(pending.network.sentBytes).toBe(before.network.sentBytes);
    const after = await status(host);
    expect(after.network.sentMessages - before.network.sentMessages).toBe(messages.length);
    expect(after.network.sentBytes - before.network.sentBytes).toBe(bytes);
    expect(peer.connection.peer.bufferedAmount()).toBe(0);
  });

  test('suspends snapshots above 64 KiB of queued traffic while reliable traffic continues', async () => {
    const { host, advance } = fixture();
    const peer = await connect(host, 'Snapshot budget');
    const reliable: ServerMessage = { type: 'error', message: 'é'.repeat(33000), fatal: false };
    let queuedBytes = 0;
    const step = spyOn(host.game, 'step').mockImplementation(() => {
      expect(send(host.game, peer.connection, reliable)).toBe(true);
      queuedBytes = peer.connection.peer.bufferedAmount();
      host.game.sendSnapshot(peer.connection);
      expect(send(host.game, peer.connection, { type: 'pong', time: 2 })).toBe(true);
    });
    spies.push(step);
    advance();
    await waitFor(() => peer.received.messages.some(message => message.type === 'pong'));
    expect(queuedBytes).toBe(encodedBytes(reliable));
    expect(queuedBytes).toBeGreaterThan(64 * 1024);
    expect(peer.received.messages.map(message => message.type)).toEqual(['error', 'pong']);
    expect(peer.connection.closed).toBe(false);
    expect(peer.connection.peer.bufferedAmount()).toBe(0);
  });

  test.each(['messages', 'bytes'] as const)('the %s cap closes only its destination and clears its queued traffic', async budget => {
    const { host, advance } = fixture();
    const slow = await connect(host, 'Limited');
    const healthy = await connect(host, 'Healthy');
    const message: ServerMessage = budget === 'messages' ? { type: 'pong', time: 1 } : {
      type: 'world', roundId: 1, revision: 1,
      edits: Array.from({ length: 512 }, (_, index): VoxelEdit => [index % 64, 1, Math.floor(index / 64), 0]),
    };
    const expected = budget === 'messages' ? 1024 : Math.floor(512 * 1024 / encodedBytes(message));
    let accepted = 0, peakQueued = 0;
    const step = spyOn(host.game, 'step').mockImplementation(() => {
      for (let index = 0; index <= expected; index++) {
        if (send(host.game, slow.connection, message)) accepted++;
        peakQueued = Math.max(peakQueued, slow.connection.peer.bufferedAmount());
      }
      expect(send(host.game, healthy.connection, { type: 'pong', time: 123 })).toBe(true);
    });
    spies.push(step);
    advance();
    await waitFor(() => slow.received.closeCode !== null && healthy.received.messages.some(message => message.type === 'pong'));
    expect(accepted).toBe(expected);
    expect(peakQueued).toBe(expected * encodedBytes(message));
    expect(peakQueued).toBeLessThanOrEqual(512 * 1024);
    expect(slow.connection.closed).toBe(true);
    expect(slow.connection.peer.bufferedAmount()).toBe(0);
    expect(healthy.connection.closed).toBe(false);
    expect(healthy.received.messages).toEqual([{ type: 'pong', time: 123 }]);
    expect((await status(host)).admission.activeConnections).toBe(1);
  });

  test('sends outside a simulation tick remain immediate and do not enter the queue', async () => {
    const { host } = fixture();
    const peer = await connect(host, 'Direct');
    const before = await status(host);
    const message: ServerMessage = { type: 'pong', time: 999 };
    expect(send(host.game, peer.connection, message)).toBe(true);
    const after = await status(host);
    expect(after.network.sentMessages - before.network.sentMessages).toBe(1);
    expect(after.network.sentBytes - before.network.sentBytes).toBe(encodedBytes(message));
    expect(host.game.tick).toBe(0);
    await waitFor(() => peer.received.messages.length === 1);
    expect(peer.received.messages).toEqual([message]);
    expect(peer.connection.peer.bufferedAmount()).toBe(0);
  });
});
