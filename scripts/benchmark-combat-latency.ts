import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { startServer } from '../src/server/index';
import { RemotePlayers } from '../src/client/remote-players';
import { EYE_HEIGHT } from '../src/shared/movement';
import { PROTOCOL_VERSION, type ClientMessage, type GameEvent, type InputFrame, type PlayerState, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';
import { packBlock } from '../src/shared/voxel';

// Local diagnostic only: real sockets/ticks, artificial symmetric transport delay, no game-rule changes.
const args = new Map(Bun.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, '').split('='); return [key, value] as const;
}));
const seconds = Number(args.get('seconds') ?? 12);
const leadMs = Number(args.get('lead-ms') ?? 150);
const compensated = !args.has('uncompensated');
const output = resolve(args.get('output') ?? `.runtime/lag-compensation-20260922/${compensated ? 'compensated' : 'baseline'}`);
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 120) throw new Error('seconds must be 3..120');
if (!Number.isFinite(leadMs) || leadMs < 0 || leadMs > 500) throw new Error('lead-ms must be 0..500');
const cases = [
  { rtt: 0, speed: 9, lead: false, weapon: 'ak47' },
  { rtt: 50, speed: 0, lead: false, weapon: 'ak47' },
  { rtt: 50, speed: 3, lead: false, weapon: 'ak47' },
  { rtt: 50, speed: 6, lead: false, weapon: 'ak47' },
  { rtt: 50, speed: 9, lead: false, weapon: 'ak47' },
  { rtt: 50, speed: 6, lead: true, weapon: 'ak47' },
  { rtt: 50, speed: 9, lead: true, weapon: 'ak47' },
  { rtt: 100, speed: 9, lead: false, weapon: 'ak47' },
  { rtt: 50, speed: 9, lead: false, weapon: 'awp' },
  { rtt: 50, speed: 9, lead: true, weapon: 'awp' },
] as const;
type Case = typeof cases[number];
type StateAtTick = { at: number; x: number; vx: number; lastSeq: number; health: number };
type ShotInput = { seq: number; at: number; pressAt: number; renderedX: number; renderedVx: number; serverX: number; aimX: number; receivedAt?: number };

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(3)) : null;
  return { count: sorted.length, min: p(0), p50: p(.5), p95: p(.95), max: p(1) };
}

async function run(config: Case) {
  const host = startServer({ port: 0, hostname: '127.0.0.1', mode: 'ffa', roundSeconds: 0,
    world: { seed: 12345, size: 256, height: 128 } });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sockets: WebSocket[] = [];
  const frames = new Map<number, ShotInput>();
  const history = new Map<number, StateAtTick>();
  const shots: { event: GameEvent; at: number }[] = [];
  const impacts = new Set<number>();
  const inputTimes: number[] = [];
  const rtts: number[] = [], errors: string[] = [];
  let target: PlayerState | undefined, shooter: PlayerState | undefined;
  let inputTimer: ReturnType<typeof setInterval> | undefined;
  let active = true;
  const delay = (callback: () => void) => {
    if (!config.rtt) { if (active) callback(); return; }
    const timer = setTimeout(() => { timers.delete(timer); if (active) callback(); }, config.rtt / 2);
    timers.add(timer);
  };
  const wait = async (ready: () => boolean, label: string) => {
    const deadline = performance.now() + 10000;
    while (!ready()) {
      if (errors.length || performance.now() >= deadline) throw new Error(`${label}: ${errors.join('; ') || 'timeout'}`);
      await Bun.sleep(5);
    }
  };
  const connect = (name: string, observer: boolean) => {
    const remote = new RemotePlayers();
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/ws`);
    socket.binaryType = 'arraybuffer'; sockets.push(socket);
    let id = 0, seq = 0, worldRevision = 0;
    const send = (message: ClientMessage) => {
      const text = JSON.stringify(message);
      delay(() => { if (socket.readyState === WebSocket.OPEN) socket.send(text); });
    };
    socket.addEventListener('open', () => send({ type: 'hello', version: PROTOCOL_VERSION, name }));
    socket.addEventListener('message', event => {
      const message = decodeServerMessage(event.data);
      delay(() => {
        const now = performance.now(); messages.push(message);
        if (message.type === 'welcome') id = message.id;
        if (message.type === 'error') errors.push(message.message);
        if (message.type === 'snapshot') remote.snapshot(message.tick, message.players, now);
        if (message.type === 'world') worldRevision = message.revision;
        if (message.type === 'pong' && observer) rtts.push(now - message.time);
        if (observer && message.type === 'event' && message.shooterId === id) {
          if (message.event === 'shot') shots.push({ event: message, at: now });
          if (message.event === 'impact' && message.targetId === target?.id) impacts.add(message.projectileId!);
        }
      });
    });
    socket.addEventListener('error', () => errors.push(`${name}: socket error`));
    return { remote, messages, send, get id() { return id; },
      input(values: Partial<InputFrame>) {
        const frame: InputFrame = { seq: ++seq, roundId: host.game.roundId, moveX: 0, moveZ: 0,
          yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, alt: false, weapon: 'ak47',
          ...(compensated && remote.viewTick !== undefined ? { viewTick: remote.viewTick, viewLatestTick: remote.viewLatestTick, worldRevision } : {}), ...values };
        send({ type: 'input', frames: [frame] }); return frame.seq;
      },
    };
  };
  try {
    const first = connect('Latency shooter', true), second = connect('Moving target', false);
    for (const peer of [first, second]) {
      await wait(() => peer.messages.some(message => message.type === 'world' && message.complete), 'initial world');
      peer.send({ type: 'spawn', roundId: host.game.roundId, kit: peer === first && config.weapon === 'awp' ? 'sniper' : 'assault' });
      await wait(() => !!host.game.players.get(peer.id)?.alive, 'spawn');
    }
    shooter = host.game.players.get(first.id)!; target = host.game.players.get(second.id)!;
    // A small level arena above generated terrain; health is restored after each nonlethal body shot.
    for (let x = 113; x <= 143; x++) for (let z = 99; z <= 121; z++) {
      host.game.world.set(x, 119, z, packBlock(128, 128, 128));
      for (let y = 120; y < 125; y++) host.game.world.set(x, y, z, 0);
    }
    Object.assign(shooter, { position: { x: 128, y: 120, z: 120 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true, yaw: 0, pitch: 0 });
    Object.assign(target, { position: { x: 128, y: 120, z: 100 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true, yaw: 0, pitch: 0 });
    host.game.sendSnapshot();
    const originalStep = host.game.step.bind(host.game);
    host.game.step = () => {
      originalStep();
      if (!target || !shooter) return;
      history.set(host.game.tick, { at: performance.now(), x: target.position.x, vx: target.velocity.x,
        lastSeq: shooter.lastSeq, health: target.health });
      if (!target.alive) errors.push('Unexpected lethal shot in body-shot fixture');
      target.health = 100;
    };
    const originalReceive = host.game.receive.bind(host.game);
    host.game.receive = (connection, data) => {
      if (connection.player === shooter) {
        const message = JSON.parse(data);
        if (message.type === 'input') for (const frame of message.frames) {
          const trace = frames.get(frame.seq); if (trace) trace.receivedAt = performance.now();
        }
      }
      originalReceive(connection, data);
    };
    const started = performance.now(), warmup = 2500;
    let nextFrame = started, nextShot = started + warmup, nextPing = started, direction = 1;
    let pressAt = -Infinity, attemptedShots = 0;
    inputTimer = setInterval(() => {
      const now = performance.now();
      if (now < nextFrame || !target || !shooter) return;
      nextFrame += 1000 / 60;
      if (nextFrame < now - 100) nextFrame = now;
      inputTimes.push(now);
      const seen = first.remote.sample(now).find(player => player.id === second.id);
      const ownTarget = second.remote.sample(now).find(player => player.id === second.id);
      if (ownTarget && ownTarget.position.x > 138) direction = -1;
      if (ownTarget && ownTarget.position.x < 118) direction = 1;
      second.input({ moveX: config.speed ? direction : 0, sprint: config.speed === 9, sneak: config.speed === 3 });
      if (!seen) return;
      const leadSeconds = config.lead ? leadMs / 1000 : 0;
      const aimX = seen.position.x + seen.velocity.x * leadSeconds;
      const dx = aimX - shooter.position.x, dz = seen.position.z - shooter.position.z;
      const pitch = Math.atan2(seen.position.y + 1.4 - shooter.position.y - EYE_HEIGHT, Math.hypot(dx, dz));
      if (now >= nextShot && now < started + warmup + seconds * 1000) {
        pressAt = now; attemptedShots++; nextShot = now + (config.weapon === 'awp' ? 1200 : 400);
      }
      // Hold across several inputs: the existing weapon re-arms on the tick preceding its next shot.
      const fire = now < pressAt + 75;
      const seq = first.input({ yaw: Math.atan2(-dx, -dz), pitch, alt: true, fire, weapon: config.weapon });
      if (fire) frames.set(seq, { seq, at: now, pressAt, renderedX: seen.position.x, renderedVx: seen.velocity.x,
        serverX: target.position.x, aimX });
      if (now >= nextPing) { nextPing = now + 250; first.send({ type: 'ping', time: now }); }
    }, 1);
    await Bun.sleep(warmup + seconds * 1000 + config.rtt + 300);
    clearInterval(inputTimer); inputTimer = undefined;
    const rows = shots.map(({ event, at }) => {
      const frame = frames.get(event.inputSeq!)!;
      const state = history.get(event.tick!)!;
      if (!frame || !state || frame.receivedAt === undefined) throw new Error('Missing shot input/tick evidence');
      const steady = config.speed === 0 || (Math.abs(Math.abs(frame.renderedVx) - config.speed) < .03
        && Math.abs(Math.abs(state.vx) - config.speed) < .03 && frame.renderedVx * state.vx > 0);
      const end = event.endPosition!;
      const fraction = (100 - event.position.z) / (end.z - event.position.z);
      const rayX = event.position.x + fraction * (end.x - event.position.x);
      return { ...frame, tick: event.tick, projectileId: event.projectileId, resolvedAt: state.at, confirmedAt: at,
        rayXAtTargetPlane: rayX, rayAimErrorBlocks: rayX - frame.aimX,
        targetX: state.x, targetVx: state.vx, healthAfter: state.health, acknowledged: state.lastSeq >= frame.seq,
        steady, hit: impacts.has(event.projectileId!),
        visualGapBlocks: Math.abs(frame.serverX - frame.renderedX),
        resolutionGapBlocks: Math.abs(state.x - frame.renderedX),
        resolutionGapMs: config.speed ? Math.abs(state.x - frame.renderedX) / config.speed * 1000 : null,
        inputToServerMs: frame.receivedAt - frame.at, serverWaitMs: state.at - frame.receivedAt,
        inputToResolutionMs: state.at - frame.at, inputToConfirmationMs: at - frame.at,
        pressToConfirmationMs: at - frame.pressAt };
    });
    const steady = rows.filter(row => row.steady);
    const metrics = await (await fetch(`http://127.0.0.1:${host.server.port}/health`)).json();
    if (errors.length || attemptedShots !== rows.length || rows.some(row => !row.acknowledged || row.hit !== (row.healthAfter < 100))) {
      throw new Error(`Invalid run: ${JSON.stringify({ errors, attemptedShots, shots: rows.length })}`);
    }
    const result = { config, leadMs: config.lead ? leadMs : 0, seconds, measuredRttMs: summary(rtts),
      measuredInputHz: (inputTimes.length - 1) * 1000 / (inputTimes.at(-1)! - inputTimes[0]),
      attemptedShots, confirmedShots: rows.length,
      steadyShots: steady.length, steadyHits: steady.filter(row => row.hit).length,
      steadyHitPercent: steady.length ? 100 * steady.filter(row => row.hit).length / steady.length : null,
      visualGapBlocks: summary(steady.map(row => row.visualGapBlocks)),
      resolutionGapBlocks: summary(steady.map(row => row.resolutionGapBlocks)),
      resolutionGapMs: summary(steady.flatMap(row => row.resolutionGapMs === null ? [] : [row.resolutionGapMs])),
      inputToResolutionMs: summary(rows.map(row => row.inputToResolutionMs)),
      inputToConfirmationMs: summary(rows.map(row => row.inputToConfirmationMs)),
      pressToConfirmationMs: summary(rows.map(row => row.pressToConfirmationMs)),
      serverWaitMs: summary(rows.map(row => row.serverWaitMs)), metrics, rows };
    console.log(JSON.stringify({ ...result, rows: undefined }));
    return result;
  } finally {
    if (inputTimer) clearInterval(inputTimer);
    active = false; for (const timer of timers) clearTimeout(timer);
    await Promise.all(sockets.map(socket => new Promise<void>(done => {
      if (socket.readyState === WebSocket.CLOSED) { done(); return; }
      socket.addEventListener('close', () => done(), { once: true }); socket.close();
    })));
    const deadline = performance.now() + 1000;
    while (host.game.connections.size && performance.now() < deadline) await Bun.sleep(5);
    const remaining = host.game.connections.size; host.stop();
    if (remaining) throw new Error(`Cleanup left ${remaining} connections`);
  }
}

await mkdir(output, { recursive: true });
const sourceHashes: Record<string, string> = {};
for (const file of ['src/client/remote-players.ts', 'src/shared/game.ts', 'src/shared/movement.ts',
  'src/shared/weapon-pose.ts', 'src/shared/protocol.ts', 'src/shared/wire.ts', 'src/server/index.ts']) {
  sourceHashes[file] = createHash('sha256').update(await Bun.file(file).bytes()).digest('hex');
}
const results = [];
for (const [index, config] of cases.entries()) {
  if (args.has('case') && Number(args.get('case')) !== index) continue;
  results.push(await run(config));
  await Bun.write(resolve(output, `websocket${args.has('case') ? `-${args.get('case')}` : ''}.json`), JSON.stringify({
    recordedAt: new Date().toISOString(), compensated, protocol: PROTOCOL_VERSION, bun: Bun.version, sourceHashes,
    method: 'Two real local WebSocket clients; stock server tick scheduler and RemotePlayers; RTT/2 delay on sends and receives; synthetic body-center aim scheduled at <=60Hz (OS timers may reduce cadence); ADS; 75ms trigger hold every 400ms AK / 1200ms AWP; flat fixture and restored health. Lead uses rendered velocity times explicit lead-ms (150ms default, from this Windows baseline; not an implemented compensation). Turns excluded from steady subset. No GPU, WAN, production or human input latency measurement.',
    results, connectionsAfterEachCase: 0,
  }, null, 2) + '\n');
}
