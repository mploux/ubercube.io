import { afterEach, describe, expect, test } from 'bun:test';
import { startServer } from '../src/server/index';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/shared/protocol';
import { createServerMessageDecoder } from '../src/shared/wire';

const running: ReturnType<typeof startServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of running.splice(0)) host.stop();
});

function connect(port: number, name: string) {
  const decode = createServerMessageDecoder();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', event => messages.push(decode(event.data)));
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name })));
  return {
    socket, messages,
    async wait<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        const index = messages.findIndex(message => message.type === type);
        if (index !== -1) return messages.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
        await Bun.sleep(5);
      }
      throw new Error(`Message ${type} non reçu`);
    },
  };
}

describe('real HTTP and WebSocket transport', () => {
  test('serves status and synchronizes two independent clients', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', mode: 'tdm', world: { seed: 12, size: 64, height: 48 } });
    running.push(host);
    const status = await fetch(`http://127.0.0.1:${host.server.port}/api/status`);
    expect(status.status).toBe(200);
    const first = connect(host.server.port!, 'Alpha');
    const second = connect(host.server.port!, 'Bravo');
    const a = await first.wait('welcome');
    const b = await second.wait('welcome');
    expect(a.id).not.toBe(b.id);
    expect(a.mode).toBe('tdm');
    await first.wait('world');
    await second.wait('world');
    first.socket.send(JSON.stringify({ type: 'spawn', roundId: a.roundId, kit: 'assault' }));
    second.socket.send(JSON.stringify({ type: 'spawn', roundId: b.roundId, kit: 'sniper' }));
    await Bun.sleep(100);
    const snapshot = await first.wait('snapshot');
    const deadline = performance.now() + 2000;
    let latest = snapshot;
    while (latest.players.filter(player => player.alive).length < 2 && performance.now() < deadline) latest = await first.wait('snapshot');
    const one = latest.players.find(player => player.id === a.id)!;
    const two = latest.players.find(player => player.id === b.id)!;
    expect(one.alive).toBe(true);
    expect(two.alive).toBe(true);
    expect(one.team).not.toBe(two.team);
    first.socket.send(JSON.stringify({ type: 'ping', time: 1234 }));
    expect((await first.wait('pong')).time).toBe(1234);
  });

  test('rejects excess admission without evicting the existing player', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', maxPlayers: 1, world: { seed: 1, size: 64, height: 48 } });
    running.push(host);
    const first = connect(host.server.port!, 'One');
    await first.wait('welcome');
    const extra = connect(host.server.port!, 'Two');
    const refusal = await extra.wait('error');
    expect(refusal.fatal).toBe(true);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });

  test('a connected FFA browser receives published snapshots again after a round reset', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', mode: 'ffa', autoTick: false, world: { seed: 2, size: 64, height: 48 } });
    running.push(host);
    const peer = connect(host.server.port!, 'Roundtrip');
    const welcome = await peer.wait('welcome');
    await peer.wait('world');
    peer.socket.send(JSON.stringify({ type: 'spawn', roundId: welcome.roundId, kit: 'sniper' }));
    let first = await peer.wait('snapshot');
    while (!first.players.some(player => player.id === welcome.id && player.alive)) first = await peer.wait('snapshot');
    expect(first.players[0].team).toBe(0);
    expect(first.owner?.ammo).toBe(5);

    host.game.resetRound();
    const reset = await peer.wait('reset');
    expect(reset.roundId).toBe(welcome.roundId + 1);
    expect((await peer.wait('world')).complete).toBe(true);
    await peer.wait('snapshot');
    peer.socket.send(JSON.stringify({ type: 'spawn', roundId: reset.roundId, kit: 'medic' }));
    const respawn = await peer.wait('snapshot');
    expect(respawn.players[0].alive).toBe(true);
    expect(respawn.players[0].weapon).toBe('medic');

    host.game.step(); host.game.step(); host.game.step();
    const published = await peer.wait('snapshot');
    expect(published.roundId).toBe(reset.roundId);
    expect(published.tick).toBe(3);
    expect(published.players[0].id).toBe(welcome.id);
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
  });

  test('malformed packets cannot crash the server or change another session', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', world: { seed: 1, size: 64, height: 48 } });
    running.push(host);
    const peer = connect(host.server.port!, 'Malformed');
    const welcome = await peer.wait('welcome');
    peer.socket.send('{ broken json');
    await peer.wait('error');
    peer.socket.send(JSON.stringify({ type: 'input', frames: [{ seq: 1, roundId: welcome.roundId, moveX: 100000, playerId: 999 }] }));
    await peer.wait('error');
    const response = await fetch(`http://127.0.0.1:${host.server.port}/health`);
    expect(response.status).toBe(200);
  });
});
