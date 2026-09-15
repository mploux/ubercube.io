import { afterEach, expect, test } from 'bun:test';
import { startQaVideoServer } from '../scripts/qa-video-server.ts';
import { PROTOCOL_VERSION, type GameEvent, type InputFrame, type ServerMessage, type Vec3 } from '../src/shared/protocol.ts';
import { decodeServerMessage } from '../src/shared/wire.ts';

const hosts: Awaited<ReturnType<typeof startQaVideoServer>>[] = [];
const sockets: WebSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); for (const host of hosts.splice(0)) host.stop(); });

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

test('video fixture uses real socket inputs, lethal combat events, and voxel cover', async () => {
  const host = await startQaVideoServer(0);
  hosts.push(host);
  const base = `http://127.0.0.1:${host.server.port}`;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  sockets.push(socket);
  socket.binaryType = 'arraybuffer';
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', event => messages.push(decodeServerMessage(event.data)));
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'QA proof' })));
  await until(() => messages.some(message => message.type === 'welcome') && [...host.game.connections].every(connection => !connection.initial));
  const welcome = messages.find(message => message.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
  let seq = 0;
  for (const scene of ['ak-body', 'awp-body', 'wall'] as const) {
    const response = await fetch(`${base}/qa/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene, shooterId: welcome.id }) });
    expect(response.status).toBe(200);
    const setup = await response.json() as { yaw: number; pitch: number; targetId: number;
      weapon: 'ak47' | 'awp'; impulseScale: null; impulseMagnitude: number };
    expect(setup.impulseScale).toBeNull();
    expect(setup.impulseMagnitude).toBe(scene === 'awp-body' ? 80 : 48);
    messages.length = 0;
    const frame = (fire: boolean): InputFrame => ({ seq: ++seq, roundId: welcome.roundId, moveX: 0, moveZ: 0,
      yaw: setup.yaw, pitch: setup.pitch, jump: false, sprint: false, fire, alt: true, weapon: setup.weapon });
    for (let i = 0; i < (scene === 'awp-body' ? 170 : 100); i++) {
      socket.send(JSON.stringify({ type: 'input', frames: [frame(i >= 50 && (scene !== 'wall' || i < 78))] }));
      await Bun.sleep(17);
    }
    const state = await (await fetch(`${base}/qa/state`)).json() as { events: GameEvent[]; inputs: unknown[] };
    const target = host.game.players.get(setup.targetId)!;
    const shots = state.events.filter(event => event.event === 'shot');
    expect(shots.length).toBeGreaterThan(0);
    expect(state.inputs.length).toBeGreaterThan(0);
    for (const shot of shots) {
      expect(shot.endPosition).toBeDefined();
      expect(host.game.projectiles.has(shot.projectileId!)).toBe(false);
      const impact = state.events.find(event => event.event === 'impact' && event.projectileId === shot.projectileId);
      if (impact) expect(impact.tick).toBe(shot.tick);
    }
    if (scene !== 'wall') {
      expect(target.alive).toBe(false);
      const deaths = state.events.filter(event => event.event === 'death' && event.targetId === target.id);
      expect(deaths).toHaveLength(1);
      expect(deaths[0].death?.hitPoint.z).toBeCloseTo(35.3, 3);
      const impulse = deaths[0].death!.impulse;
      expect(Math.hypot(impulse.x, impulse.y, impulse.z)).toBeCloseTo(scene === 'awp-body' ? 80 : 48, 8);
      expect(impulse.z).toBeLessThan(-47);
      expect(deaths[0]).toMatchObject(messages.find(message => message.type === 'event' && message.event === 'death')!);
    } else {
      expect(target.health).toBe(100);
      expect(target.alive).toBe(true);
      expect(state.events.some(event => event.event === 'impact' && event.blockColor !== undefined)).toBe(true);
      expect(state.events.some(event => event.event === 'death')).toBe(false);
    }
  }
  expect((await fetch(`${base}/qa/scene`, { method: 'POST', headers: { Origin: 'https://www.ubercube.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'ak-body', shooterId: welcome.id }) })).status).toBe(403);
}, 20000);

test('impulse review preserves historical magnitudes, direction, and hit point after production tuning', async () => {
  const host = await startQaVideoServer(0);
  hosts.push(host);
  const base = `http://127.0.0.1:${host.server.port}`;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  sockets.push(socket);
  socket.binaryType = 'arraybuffer';
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', event => messages.push(decodeServerMessage(event.data)));
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Impulse proof' })));
  await until(() => messages.some(message => message.type === 'welcome') && [...host.game.connections].every(connection => !connection.initial));
  const welcome = messages.find(message => message.type === 'welcome') as Extract<ServerMessage, { type: 'welcome' }>;
  let seq = 0;
  for (const scene of ['ak-body', 'ak-head', 'awp-body'] as const) {
    let baseline: { point: Vec3; direction: Vec3 } | undefined;
    for (const impulseScale of [1, 2, 4, 8]) {
      const response = await fetch(`${base}/qa/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene, shooterId: welcome.id, impulseScale }) });
      expect(response.status).toBe(200);
      const setup = await response.json() as { yaw: number; pitch: number; targetId: number;
        weapon: 'ak47' | 'awp'; impulseScale: number; impulseMagnitude: number };
      const magnitude = (setup.weapon === 'awp' ? 20 : 12) * impulseScale;
      expect(setup.impulseScale).toBe(impulseScale);
      expect(setup.impulseMagnitude).toBe(magnitude);
      expect(host.game.players.get(setup.targetId)?.health).toBe(1);
      messages.length = 0;
      const frame = (fire: boolean): InputFrame => ({ seq: ++seq, roundId: welcome.roundId, moveX: 0, moveZ: 0,
        yaw: setup.yaw, pitch: setup.pitch, jump: false, sprint: false, fire, alt: true, weapon: setup.weapon });
      socket.send(JSON.stringify({ type: 'input', frames: [frame(false)] }));
      const settleTick = host.game.tick + 90;
      await until(() => host.game.tick >= settleTick);
      socket.send(JSON.stringify({ type: 'input', frames: [frame(true)] }));
      await until(() => messages.some(message => message.type === 'event' && message.event === 'death'));
      socket.send(JSON.stringify({ type: 'input', frames: [frame(false)] }));
      const state = await (await fetch(`${base}/qa/state`)).json() as { impulseScale: number; events: GameEvent[] };
      expect(state.impulseScale).toBe(impulseScale);
      const deaths = state.events.filter(event => event.event === 'death');
      expect(deaths).toHaveLength(1);
      const death = deaths[0]!;
      expect(death).toMatchObject(messages.find(message => message.type === 'event' && message.event === 'death')!);
      expect(death.weapon).toBe(setup.weapon);
      expect(death.headshot).toBe(scene === 'ak-head');
      expect(death.death?.player.alive).toBe(false);
      expect(death.death?.player.health).toBe(0);
      expect(host.game.players.get(setup.targetId)?.health).toBe(0);
      const { impulse, hitPoint } = death.death!;
      expect(Math.hypot(impulse.x, impulse.y, impulse.z)).toBeCloseTo(magnitude, 8);
      const direction = { x: impulse.x / magnitude, y: impulse.y / magnitude, z: impulse.z / magnitude };
      const shots = state.events.filter(event => event.event === 'shot');
      expect(shots).toHaveLength(1);
      expect(shots[0]!.endPosition).toEqual(hitPoint);
      const origin = shots[0]!.position;
      const distance = Math.hypot(hitPoint.x - origin.x, hitPoint.y - origin.y, hitPoint.z - origin.z);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(direction[axis]).toBeCloseTo((hitPoint[axis] - origin[axis]) / distance, 8);
        if (baseline) {
          expect(hitPoint[axis]).toBeCloseTo(baseline.point[axis], 5);
          expect(direction[axis]).toBeCloseTo(baseline.direction[axis], 6);
        }
      }
      baseline ??= { point: hitPoint, direction };
    }
  }
  for (const impulseScale of [0, 3, 16, -1, null, '4']) {
    expect((await fetch(`${base}/qa/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'ak-body', shooterId: welcome.id, impulseScale }) })).status).toBe(400);
  }
  for (const endpoint of ['video', 'report']) {
    expect((await fetch(`${base}/qa/${endpoint}?review=unknown`, { method: 'POST', body: '{}' })).status).toBe(400);
  }
}, 30000);
