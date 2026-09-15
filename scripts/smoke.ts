import { strict as assert } from 'node:assert';
import { PROTOCOL_VERSION, type InputFrame, type ServerMessage } from '../src/shared/protocol';
import { createServerMessageDecoder } from '../src/shared/wire';

const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
type Welcome = Extract<ServerMessage, { type: 'welcome' }>;
type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;

function endpoint(value: string): URL {
  const url = new URL(value);
  assert((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,
  'Use an HTTPS origin or HTTP loopback, without credentials or path');
  return url;
}

export async function smoke(server: string, frontend: string) {
  const target = endpoint(server), origin = endpoint(frontend).origin;
  const ws = new URL('/ws', target); ws.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const checks: string[] = [];
  const peers: { socket: WebSocket; welcome?: Welcome; snapshot?: Snapshot; complete: boolean;
    closing: boolean; failure?: string; messages: ServerMessage[] }[] = [];
  const wait = async (condition: () => boolean, label: string) => {
    const end = performance.now() + 10000;
    while (!condition()) {
      assert(performance.now() < end, `Timed out: ${label}`);
      await Bun.sleep(20);
    }
  };
  const getStatus = async (path = '/api/status') => {
    const response = await fetch(new URL(path, target), { headers: { Origin: origin }, signal: AbortSignal.timeout(6000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    const body = await response.json() as { ok: boolean; mode: string; players: number };
    assert(body.ok && ['tdm', 'ffa'].includes(body.mode));
    return body;
  };
  const connect = (name: string, version = PROTOCOL_VERSION) => {
    const decode = createServerMessageDecoder();
    const socket = new Socket(ws.href, { headers: { Origin: origin } });
    socket.binaryType = 'arraybuffer';
    const peer: typeof peers[number] = { socket, complete: false, closing: false, messages: [] };
    peers.push(peer);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', name, version }));
    socket.onerror = () => { peer.failure = 'WebSocket connection failed'; };
    socket.onclose = () => { if (!peer.closing && version === PROTOCOL_VERSION) peer.failure = 'Unexpected disconnection'; };
    socket.onmessage = event => {
      try {
        const message = decode(event.data);
        if (message.type === 'welcome') peer.welcome = message;
        else if (message.type === 'world' && message.complete) peer.complete = true;
        else if (message.type === 'snapshot') {
          assert(peer.welcome && message.owner?.id === peer.welcome.id, 'Snapshot owner differs from the connection');
          for (const player of message.players) {
            assert(['health', 'kit', 'grounded', 'ammo', 'grenades', 'lastSeq'].every(key => !(key in player)),
              'Private player fields exposed in the public snapshot');
            assert(!('y' in player.velocity), 'Private vertical velocity exposed in the public snapshot');
          }
          peer.snapshot = message;
        }
        else if (message.type === 'error' && version === PROTOCOL_VERSION) peer.failure = message.message;
        else if (message.type === 'reset') peer.failure = 'Round reset during smoke test; retry on a stable round';
        if (message.type !== 'snapshot') peer.messages.push(message);
      } catch { peer.failure = 'Invalid server message'; }
    };
    return peer;
  };
  const healthy = () => { for (const peer of peers) assert(!peer.failure, peer.failure); };
  try {
    const baseline = await getStatus(); await getStatus('/health');
    const denied = await fetch(new URL('/health', target), {
      headers: { Origin: 'https://unlisted.invalid' }, signal: AbortSignal.timeout(6000),
    });
    assert.equal(denied.status, 403); await denied.arrayBuffer();
    checks.push('HTTP health/status, exact CORS and unknown-origin rejection');
    const old = connect('VersionCheck', PROTOCOL_VERSION - 1);
    await wait(() => old.socket.readyState === WebSocket.CLOSED, 'obsolete protocol rejected');
    assert(old.messages.some(message => message.type === 'error' && message.fatal));
    assert(!old.welcome && !old.messages.some(message => message.type === 'world'));
    checks.push('Previous protocol refused before welcome/world');
    const a = connect(`SmokeA${Date.now().toString(36)}`), b = connect(`SmokeB${Date.now().toString(36)}`);
    await wait(() => { healthy(); return !!a.welcome && !!b.welcome && a.complete && b.complete; }, 'initial synchronization');
    assert.notEqual(a.welcome!.id, b.welcome!.id);
    assert.deepEqual(a.welcome!.world, b.welcome!.world);
    assert.equal(a.welcome!.roundId, b.welcome!.roundId);
    assert.equal(a.welcome!.mode, baseline.mode); assert.equal(b.welcome!.mode, baseline.mode);
    for (const peer of [a, b]) peer.socket.send(JSON.stringify({ type: 'spawn', kit: 'assault', roundId: peer.welcome!.roundId }));
    await wait(() => {
      healthy();
      return [a, b].every(peer => [a, b].every(other => peer.snapshot?.players.some(p => p.id === other.welcome!.id && p.alive)));
    }, 'spawned players visible to both clients');
    const initial = a.snapshot!.owner!;
    const other = a.snapshot!.players.find(p => p.id === b.welcome!.id)!;
    if (baseline.mode === 'ffa') { assert.equal(initial.team, 0); assert.equal(other.team, 0); }
    else {
      assert([1, 2].includes(initial.team) && [1, 2].includes(other.team));
      if (baseline.players === 0) assert.notEqual(initial.team, other.team);
    }
    checks.push('Distinct players, shared world/round, mode teams, authoritative spawn and private owner state');
    const frame: InputFrame = { seq: 0, roundId: a.welcome!.roundId, moveX: 0, moveZ: 1,
      yaw: initial.yaw, pitch: 0, jump: false, sprint: false, fire: false, alt: false, weapon: 'ak47' };
    for (let i = 0; i < 36; i++) {
      a.socket.send(JSON.stringify({ type: 'input', frames: [{ ...frame, seq: ++frame.seq }] }));
      await Bun.sleep(17);
    }
    await wait(() => { healthy(); return !!a.snapshot?.owner && a.snapshot.owner.lastSeq >= frame.seq; }, 'input acknowledgement');
    for (const aiming of [true, false]) {
      const input = { ...frame, seq: ++frame.seq, moveZ: 0, alt: aiming, cancelActions: !aiming };
      a.socket.send(JSON.stringify({ type: 'input', frames: [input] }));
      await wait(() => {
        healthy();
        return !!a.snapshot?.owner && a.snapshot.owner.lastSeq >= input.seq
          && [a, b].every(peer => peer.snapshot?.players.some(p => p.id === initial.id && p.aiming === aiming));
      }, 'owner acknowledgement and replicated aim state');
    }
    a.closing = true; a.socket.close(1000, 'Smoke complete');
    await wait(() => { healthy(); return !!b.snapshot && !b.snapshot.players.some(p => p.id === initial.id); }, 'observer sees departure');
    checks.push('Inputs acknowledged, aiming/cancellation replicated, departure observed');
    return { ok: true, date: new Date().toISOString(), target: target.origin, origin,
      protocolVersion: PROTOCOL_VERSION, baselinePlayers: baseline.players, mode: baseline.mode, checks };
  } finally {
    for (const peer of peers) { peer.closing = true; peer.socket.close(1000, 'Smoke cleanup'); }
    await wait(() => peers.every(peer => peer.socket.readyState === WebSocket.CLOSED), 'socket cleanup');
  }
}

if (import.meta.main) {
  const args = Object.fromEntries(Bun.argv.slice(2).map(arg => {
    const index = arg.indexOf('='); return [arg.slice(0, index), arg.slice(index + 1)];
  }));
  if (!args['--url'] || !args['--origin']) {
    console.log('Usage: bun run smoke --url=https://game.ubercube.io --origin=https://www.ubercube.io [--output=report.json]\nCreates two short-lived players. Run only on an authorized target.');
    process.exitCode = Bun.argv.includes('--help') ? 0 : 1;
  } else {
    try {
      const result = await smoke(args['--url'], args['--origin']);
      if (args['--output']) await Bun.write(args['--output'], JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
  }
}
