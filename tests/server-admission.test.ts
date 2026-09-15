import { afterEach, describe, expect, test } from 'bun:test';
import { clientAddress, startServer, type StartOptions } from '../src/server/index.ts';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/shared/protocol.ts';
import { createServerMessageDecoder } from '../src/shared/wire.ts';

const running: ReturnType<typeof startServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of running.splice(0)) host.stop();
});

function start(options: StartOptions = {}) {
  const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false,
    world: { seed: 12, size: 64, height: 32 }, ...options });
  running.push(host);
  return host;
}

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await Bun.sleep(5);
  }
}

function connect(host: ReturnType<typeof startServer>, name: string | null = 'Admission') {
  const decode = createServerMessageDecoder();
  const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/ws`);
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  const result = { socket, messages: [] as ServerMessage[], receivedBytes: 0, opened: false, failed: false, closeCode: null as number | null };
  socket.addEventListener('open', () => {
    result.opened = true;
    if (name !== null) socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name }));
  });
  socket.addEventListener('error', () => { result.failed = true; });
  socket.addEventListener('close', event => { result.closeCode = event.code; });
  socket.addEventListener('message', event => {
    result.receivedBytes += typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength;
    result.messages.push(decode(event.data));
  });
  return result;
}

async function status(host: ReturnType<typeof startServer>) {
  const response = await fetch(`http://127.0.0.1:${host.server.port}/health`);
  expect(response.status).toBe(200);
  return response.json();
}

describe('trusted client addresses', () => {
  test.each(['203.0.113.9', '::ffff:203.0.113.9', '::FFFF:CB00:7109', '0:0:0:0:0:ffff:cb00:7109'])('canonicalizes IPv4 and mapped IPv6: %s', address => {
    expect(clientAddress(address, null, 'none')).toBe('203.0.113.9');
  });

  test('normalizes native IPv6 and rejects malformed peer addresses', () => {
    expect(clientAddress('2001:0DB8:0000:0000:0000:0000:0000:0001', null, undefined)).toBe('2001:db8::1');
    for (const address of ['not-an-ip', '127.0.0.1:80', '', '999.0.0.1']) expect(clientAddress(address, null, 'none')).toBeNull();
  });

  test('ignores forwarded spoofing by default and from non-loopback peers', () => {
    expect(clientAddress('127.0.0.1', '198.51.100.1', undefined)).toBe('127.0.0.1');
    expect(clientAddress('::1', '198.51.100.1', 'none')).toBe('::1');
    expect(clientAddress('203.0.113.9', '198.51.100.1', 'loopback')).toBe('203.0.113.9');
    expect(clientAddress('::ffff:203.0.113.9', '127.0.0.1', 'loopback')).toBe('203.0.113.9');
  });

  test.each(['127.0.0.1', '127.2.3.4', '::1', '::ffff:127.0.0.1'])('only trusts the final proxy-appended address through loopback %s', peer => {
    expect(clientAddress(peer, 'untrusted-prefix, 198.51.100.1, ::ffff:203.0.113.9 ', 'loopback')).toBe('203.0.113.9');
    expect(clientAddress(peer, '198.51.100.1, invalid-last', 'loopback')).toBeNull();
    expect(clientAddress(peer, '198.51.100.1, ', 'loopback')).toBeNull();
    expect(clientAddress(peer, 'a'.repeat(257), 'loopback')).toBeNull();
    expect(clientAddress(peer, null, 'loopback')).toBe(clientAddress(peer, null, 'none'));
  });
});

describe('real server admission and resource accounting', () => {
  test('rejects a third same-IP WebSocket, preserves existing players, and frees a closed slot', async () => {
    const host = start({ admission: { maxConnectionsPerIp: 2, ipBurst: 20 } });
    const first = connect(host, 'First'), second = connect(host, 'Second');
    await waitFor(() => host.game.players.size === 2, 'two admitted players');
    const rejected = connect(host, 'Rejected');
    await waitFor(() => rejected.closeCode !== null, 'third handshake rejection');
    expect(rejected.opened).toBe(false);
    expect(rejected.failed).toBe(true);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    expect((await status(host)).admission).toMatchObject({ activeConnections: 2, accepted: 2, rejected: 1,
      rejectedByReason: { ipConnections: 1 } });
    first.socket.close();
    await waitFor(() => host.game.connections.size === 1, 'closed lease released');
    const replacement = connect(host, 'Replacement');
    await waitFor(() => replacement.messages.some(message => message.type === 'welcome'), 'replacement admission');
    expect(host.game.players.size).toBe(2);
    expect(second.socket.readyState).toBe(WebSocket.OPEN);
    expect((await status(host)).admission).toMatchObject({ activeConnections: 2, accepted: 3, rejected: 1 });
  });

  test('releases admission leases after failed upgrades without refunding the opening count', async () => {
    const host = start({ admission: { maxConnectionsPerIp: 1, ipBurst: 20 } });
    const response = await fetch(`http://127.0.0.1:${host.server.port}/ws`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect([400, 426]).toContain(response.status);
    expect((await status(host)).admission).toMatchObject({ activeConnections: 0, accepted: 1, rejected: 0 });
    const peer = connect(host);
    await waitFor(() => peer.messages.some(message => message.type === 'welcome'), 'admission after failed upgrade');
    expect((await status(host)).admission).toMatchObject({ activeConnections: 1, accepted: 2 });
  });

  test('status reports the protocol and actual UTF-8 and binary message bytes', async () => {
    const host = start();
    const peer = connect(host, 'Équipe');
    await waitFor(() => peer.messages.some(message => message.type === 'snapshot'), 'initial messages');
    const ping = JSON.stringify({ type: 'ping', time: 1234 });
    peer.socket.send(ping);
    await waitFor(() => peer.messages.some(message => message.type === 'pong'), 'pong');
    const metrics = await status(host);
    expect(metrics.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(metrics.network.receivedMessages).toBe(2);
    expect(metrics.network.receivedBytes).toBe(Buffer.byteLength(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Équipe' })) + Buffer.byteLength(ping));
    expect(metrics.network.sentMessages).toBe(peer.messages.length);
    expect(metrics.network.sentBytes).toBe(peer.receivedBytes);
    const byType = metrics.network.sentBytesByType as Record<string, number>;
    expect(Object.values(byType).reduce((total, bytes) => total + bytes, 0)).toBe(peer.receivedBytes);
    for (const type of ['welcome', 'world', 'snapshot', 'pong']) expect(byType[type]).toBeGreaterThan(0);
  });

  test('records a one-second loop stall and bounds catch-up to four simulation steps', async () => {
    let now = 0;
    const host = start({ autoTick: true, now: () => now });
    now = 1000;
    await waitFor(() => host.game.tick > 0, 'catch-up after simulated stall');
    const metrics = await status(host);
    expect(host.game.tick).toBe(4);
    expect(metrics.loopDelay.max).toBeCloseTo(996, 5);
    expect(metrics.lateTicks).toBeGreaterThanOrEqual(55);
    expect(metrics.lateTicks).toBeLessThanOrEqual(56);
    expect(metrics.abandonedMs).toBeGreaterThan(900);
    expect(metrics.tickWork.samples).toBe(4);
    expect(metrics.loopDelay.samples).toBeGreaterThan(0);
  });

  test('expires an unfinished hello using real elapsed time despite limited catch-up', async () => {
    let now = 0;
    const host = start({ autoTick: true, now: () => now });
    const peer = connect(host, null);
    await waitFor(() => peer.opened, 'raw WebSocket open');
    expect(host.game.connections.size).toBe(1);
    now = 5001;
    await waitFor(() => peer.closeCode !== null, 'hello timeout');
    expect(peer.closeCode).toBe(1008);
    expect(host.game.tick).toBe(4);
    expect(peer.messages.some(message => message.type === 'error' && message.fatal)).toBe(true);
    expect((await status(host)).admission.activeConnections).toBe(0);
  });

  test('repeated malformed commands close only the offender and release its admission lease', async () => {
    const host = start({ admission: { maxConnectionsPerIp: 2, ipBurst: 20 } });
    const offender = connect(host, 'Malformed'), healthy = connect(host, 'Healthy');
    await waitFor(() => host.game.players.size === 2, 'players admitted');
    for (let i = 0; i < 8; i++) offender.socket.send('{ malformed');
    await waitFor(() => offender.closeCode !== null, 'malformed sender closed');
    expect(offender.closeCode).toBe(1008);
    expect(offender.messages.filter(message => message.type === 'error')).toHaveLength(8);
    expect(offender.messages.some(message => message.type === 'error' && message.fatal)).toBe(true);
    healthy.socket.send(JSON.stringify({ type: 'ping', time: 42 }));
    await waitFor(() => healthy.messages.some(message => message.type === 'pong' && message.time === 42), 'healthy peer remains responsive');
    expect((await status(host)).admission.activeConnections).toBe(1);
  });
});
