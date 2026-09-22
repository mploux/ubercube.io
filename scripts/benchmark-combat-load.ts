import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { startServer } from '../src/server/index';
import { RemotePlayers } from '../src/client/remote-players';
import { EYE_HEIGHT } from '../src/shared/movement';
import { DT, PROTOCOL_VERSION, type ClientMessage, type InputFrame, type PlayerState, type ServerMessage, type Vec3 } from '../src/shared/protocol';
import { VoxelWorld } from '../src/shared/voxel';
import { decodeServerMessage } from '../src/shared/wire';

// Local experiment: both arms use the stock server, scheduler, socket transport and client interpolation.
const args = new Map(Bun.argv.slice(2).map(argument => argument.replace(/^--/, '').split('=') as [string, string]));
const seconds = Number(args.get('seconds') ?? 20), resetSeconds = Number(args.get('reset-seconds') ?? 10);
const rtt = Number(args.get('rtt') ?? 50), count = Number(args.get('players') ?? 100);
if (![seconds, resetSeconds, rtt, count].every(Number.isFinite) || seconds < 3 || resetSeconds < 3 || rtt < 0
  || !Number.isInteger(count) || count < 2 || count > 100) throw new Error('Invalid benchmark arguments');
const size = 64, height = 32;
const world = { seed: 12345, size, height };
type Metrics = { tick: number; tickWork: { p50: number; p95: number; p99: number; max: number; samples: number }; pendingInput: number; lateTicks: number; droppedInputs: number; rss: number; players: number; roundId: number };
type Bot = { index: number; socket: WebSocket; remote: RemotePlayers; world: VoxelWorld; id: number; roundId: number; revision: number; ready: boolean; seq: number;
  state?: PlayerState; lastSpawn: number; lastInputAt: number; accumulator: number; lastAck: number; ackProgress: number; ackMax: number;
  inputs: number; activeMs: number; moved: number; healthLost: number; snapshots: number; resets: number; lastPosition?: Vec3;
};
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(3)) : null;
  return { samples: sorted.length, min: p(0), p50: p(.5), p95: p(.95), p99: p(.99), max: p(1) };
};

async function run(compensated: boolean) {
  const host = startServer({ port: 0, hostname: '127.0.0.1', maxPlayers: count, mode: 'ffa', roundSeconds: 0,
    world });
  const statusUrl = `http://127.0.0.1:${host.server.port}/health`;
  const bots: Bot[] = [], errors: Record<string, number> = {};
  const deliveries: { at: number; run: () => void }[] = [];
  let deliveryIndex = 0, stopping = false, drive = false, combat = false, measuring = false;
  let bytes = 0, inputs = 0, inputMessages = 0, inputBytes = 0, cappedMs = 0, maxFrames = 0;
  let nextPing = 0, maxHistoryPerConnection = 0, maxHistoryReferences = 0, maxUniqueHistories = 0, maxUniquePlayerEntries = 0;
  let shots = new Set<number>(), impacts = new Set<number>(), shotSources = new Set<number>(), impactTargets = new Set<number>();
  let terrainEdits = 0, terrainRevisions = 0, deaths = 0, builds = 0;
  let rtts: number[] = [], ackLagFrames: number[] = [];
  let phaseStart = 0;
  const delayed = (run: () => void) => { deliveries.push({ at: performance.now() + rtt / 2, run }); };
  const send = (bot: Bot, message: ClientMessage) => {
    const data = JSON.stringify(message);
    if (measuring && message.type === 'input') { inputs += message.frames.length; inputMessages++; inputBytes += data.length; maxFrames = Math.max(maxFrames, message.frames.length); }
    delayed(() => { if (!stopping && bot.socket.readyState === WebSocket.OPEN) bot.socket.send(data); });
  };
  const error = (message: string) => { errors[message] = (errors[message] ?? 0) + 1; };
  const readStatus = async () => await (await fetch(statusUrl, { signal: AbortSignal.timeout(5000) })).json() as Metrics;
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = performance.now() + 20000;
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`${label} timeout: ${JSON.stringify(errors)}`);
      await Bun.sleep(10);
    }
  };
  const observe = (bot: Bot, message: ServerMessage) => {
    const now = performance.now();
    if (message.type === 'welcome') { bot.id = message.id; bot.roundId = message.roundId; }
    else if (message.type === 'reset') {
      bot.roundId = message.roundId; bot.seq = 0; bot.ready = false; bot.revision = 0; bot.state = undefined;
      bot.remote.clear(); bot.world = new VoxelWorld(world); bot.accumulator = 0; bot.lastAck = 0; bot.resets++;
    } else if (message.type === 'world' && message.roundId === bot.roundId) {
      for (const [x, y, z, value] of message.edits) bot.world.set(x, y, z, value);
      bot.revision = message.revision;
      if (message.complete) bot.ready = true;
      if (measuring && bot.index === 0 && !message.initial) { terrainEdits += message.edits.length; terrainRevisions++; }
    } else if (message.type === 'snapshot' && message.roundId === bot.roundId) {
      bot.remote.snapshot(message.tick, message.players, now);
      const state = message.players.find(player => player.id === bot.id);
      if (measuring && state) {
        bot.snapshots++;
        if (state.lastSeq > bot.lastAck) { bot.ackProgress++; bot.ackMax = state.lastSeq; }
        if (bot.state?.alive && state.health < bot.state.health) bot.healthLost += bot.state.health - state.health;
        if (bot.state?.alive && state.alive && state.deaths === bot.state.deaths && bot.lastPosition) {
          bot.moved += Math.hypot(state.position.x - bot.lastPosition.x, state.position.z - bot.lastPosition.z);
        }
        ackLagFrames.push(Math.max(0, bot.seq - state.lastSeq));
      }
      bot.lastAck = state?.lastSeq ?? bot.lastAck;
      bot.lastPosition = state?.position;
      if (state?.alive !== bot.state?.alive) { bot.accumulator = 0; bot.lastInputAt = now; }
      bot.state = state;
    } else if (message.type === 'pong' && measuring) rtts.push(now - message.time);
    else if (message.type === 'event' && measuring && bot.index === 0 && message.roundId === bot.roundId) {
      if (message.event === 'shot' && message.projectileId !== undefined) { shots.add(message.projectileId); if (message.shooterId !== undefined) shotSources.add(message.shooterId); }
      if (message.event === 'impact' && message.projectileId !== undefined && message.targetId !== undefined) { impacts.add(message.projectileId); impactTargets.add(message.targetId); }
      if (message.event === 'death') deaths++;
      if (message.event === 'build') builds++;
    } else if (message.type === 'error') error(message.message);
  };
  const connect = (index: number) => {
    const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/ws`); socket.binaryType = 'arraybuffer';
    const bot: Bot = { index, socket, remote: new RemotePlayers(), world: new VoxelWorld(world), id: 0, roundId: 0, revision: 0, ready: false, seq: 0,
      lastSpawn: -Infinity, lastInputAt: performance.now(), accumulator: 0, lastAck: 0, ackProgress: 0, ackMax: 0, inputs: 0, activeMs: 0, moved: 0, healthLost: 0, snapshots: 0, resets: 0 };
    bots.push(bot);
    socket.onopen = () => send(bot, { type: 'hello', version: PROTOCOL_VERSION, name: `Load-${index}` });
    socket.onmessage = event => {
      if (measuring) bytes += typeof event.data === 'string' ? event.data.length : event.data.byteLength;
      const data = event.data;
      delayed(() => { if (!stopping) observe(bot, decodeServerMessage(data)); });
    };
    socket.onerror = () => error('socket');
    socket.onclose = () => { if (!stopping) error('closed'); };
    return bot;
  };
  const timer = setInterval(() => {
    const now = performance.now();
    while (deliveryIndex < deliveries.length && deliveries[deliveryIndex].at <= now) deliveries[deliveryIndex++].run();
    if (deliveryIndex > 4096) { deliveries.splice(0, deliveryIndex); deliveryIndex = 0; }
    if (!drive) return;
    for (const bot of bots) {
      const elapsed = now - bot.lastInputAt; bot.lastInputAt = now;
      if (!bot.ready || bot.socket.readyState !== WebSocket.OPEN) { bot.accumulator = 0; continue; }
      if (!bot.state?.alive) {
        bot.accumulator = 0;
        if (now - bot.lastSpawn > 500) {
          send(bot, { type: 'spawn', roundId: bot.roundId, kit: bot.index % 5 === 1 ? 'sniper' : 'assault' }); bot.lastSpawn = now;
        }
        continue;
      }
      bot.accumulator += Math.min(elapsed, 100) / 1000;
      if (measuring) { cappedMs += Math.max(0, elapsed - 100); bot.activeMs += elapsed; }
      if (bot.accumulator < DT) continue;
      const seen = bot.remote.sample(now), own = bot.state;
      const target = seen[(bot.index + Math.floor(count / 2)) % count];
      const victim = target?.alive && target.id !== bot.id ? target : seen.find(player => player.alive && player.id !== bot.id);
      const frames: InputFrame[] = [];
      while (bot.accumulator >= DT && frames.length < 6) {
        bot.accumulator -= DT;
        const seq = ++bot.seq;
        const terrain = combat && bot.index % 10 === 0 && seq % 480 >= 180 && seq % 480 < 300;
        const dx = (victim?.position.x ?? 32) - own.position.x, dz = (victim?.position.z ?? 32) - own.position.z;
        const yaw = Math.atan2(-dx, -dz);
        const pitch = terrain ? -1.3 : Math.atan2((victim?.position.y ?? own.position.y) + 1.4 - own.position.y - EYE_HEIGHT, Math.hypot(dx, dz));
        const angle = bot.index * Math.PI * 2 / count + seq / 300;
        const goalX = 32 + Math.cos(angle) * 13 - own.position.x, goalZ = 32 + Math.sin(angle) * 13 - own.position.z;
        const distance = Math.max(1, Math.hypot(goalX, goalZ));
        const moveX = (Math.cos(yaw) * goalX - Math.sin(yaw) * goalZ) / distance;
        const moveZ = (-Math.sin(yaw) * goalX - Math.cos(yaw) * goalZ) / distance;
        const frame: InputFrame = { seq, roundId: bot.roundId, moveX, moveZ, yaw, pitch, jump: seq % 120 < 3, sprint: bot.index % 3 === 0,
          fire: combat && (terrain ? seq % 60 >= 30 && seq % 60 < 36 : seq % 30 < 6), alt: terrain ? seq % 60 < 6 : true,
          weapon: terrain ? 'shovel' : bot.index % 5 === 1 ? 'awp' : 'ak47',
          ...(compensated && bot.remote.viewTick !== undefined && bot.remote.viewLatestTick !== undefined
            ? { viewTick: bot.remote.viewTick, viewLatestTick: bot.remote.viewLatestTick, worldRevision: bot.revision } : {}),
        };
        frames.push(frame); if (measuring) bot.inputs++;
      }
      if (frames.length) send(bot, { type: 'input', frames });
    }
    if (measuring && now >= nextPing) { nextPing = now + 1000; for (const bot of bots) send(bot, { type: 'ping', time: now }); }
  }, 1);
  const phase = async (name: string, duration: number) => {
    for (const bot of bots) { bot.inputs = 0; bot.activeMs = 0; bot.ackProgress = 0; bot.ackMax = bot.lastAck; bot.moved = 0; bot.healthLost = 0; bot.snapshots = 0; }
    bytes = 0; inputs = 0; inputMessages = 0; inputBytes = 0; cappedMs = 0; maxFrames = 0;
    shots = new Set(); impacts = new Set(); shotSources = new Set(); impactTargets = new Set(); terrainEdits = 0; terrainRevisions = 0; deaths = 0; builds = 0;
    rtts = []; ackLagFrames = []; maxHistoryPerConnection = 0; maxHistoryReferences = 0; maxUniqueHistories = 0; maxUniquePlayerEntries = 0;
    const before = await readStatus(), samples: unknown[] = [];
    phaseStart = performance.now(); measuring = true; combat = true;
    while (performance.now() - phaseStart < duration * 1000) {
      await Bun.sleep(Math.min(1000, duration * 1000 - (performance.now() - phaseStart)));
      const status = await readStatus();
      const histories = [...host.game.connections].flatMap(connection => connection.hitSnapshots);
      const unique = [...new Set(histories)];
      maxHistoryPerConnection = Math.max(maxHistoryPerConnection, ...[...host.game.connections].map(connection => connection.hitSnapshots.length));
      maxHistoryReferences = Math.max(maxHistoryReferences, histories.length); maxUniqueHistories = Math.max(maxUniqueHistories, unique.length);
      maxUniquePlayerEntries = Math.max(maxUniquePlayerEntries, unique.reduce((sum, snapshot) => sum + snapshot.players.size, 0));
      samples.push({ atSeconds: (performance.now() - phaseStart) / 1000, alive: [...host.game.players.values()].filter(player => player.alive).length,
        revision: host.game.revision, hitSnapshotsMax: maxHistoryPerConnection, ...status });
    }
    combat = false;
    await Bun.sleep(rtt + 150);
    measuring = false;
    const elapsed = (performance.now() - phaseStart) / 1000, after = await readStatus();
    const validations = {
      connected100: bots.length === count && host.game.connections.size === count && bots.every(bot => bot.socket.readyState === WebSocket.OPEN),
      allAcknowledged: bots.every(bot => bot.ackProgress > 5 && bot.inputs > 100), allMoved: bots.every(bot => bot.moved > .5),
      shotsConfirmed: shots.size > 0 && shotSources.size >= count * .8, playerImpactsConfirmed: impacts.size > 0,
      healthLossConfirmed: bots.reduce((sum, bot) => sum + bot.healthLost, 0) > 0, terrainConfirmed: terrainEdits > 0 && terrainRevisions > 0,
      noDroppedInputs: after.droppedInputs === before.droppedInputs, noUnexpectedErrors: Object.keys(errors).length === 0,
    };
    return { name, compensated, elapsed, targetSeconds: duration, before, after, validations, passed: Object.values(validations).every(Boolean),
      activeClients: bots.filter(bot => bot.inputs > 0).length, activePlayerSeconds: bots.reduce((sum, bot) => sum + bot.activeMs, 0) / 1000,
      framesPerActivePlayerSecond: inputs / (bots.reduce((sum, bot) => sum + bot.activeMs, 0) / 1000), inputs, inputMessages, maxFramesPerMessage: maxFrames, cappedClientMilliseconds: cappedMs,
      receivedMbitPerSecond: bytes * 8 / elapsed / 1e6, inputMbitPerSecond: inputBytes * 8 / elapsed / 1e6,
      shots: shots.size, shotSources: shotSources.size, impacts: impacts.size, impactTargets: impactTargets.size, healthLost: bots.reduce((sum, bot) => sum + bot.healthLost, 0), deaths, builds,
      terrainEdits, terrainRevisions, measuredRttMs: summarize(rtts), observedAckLagFrames: summarize(ackLagFrames),
      droppedInputs: after.droppedInputs - before.droppedInputs, lateTicks: after.lateTicks - before.lateTicks,
      history: { maxPerConnection: maxHistoryPerConnection, maxReferences: maxHistoryReferences, maxUniqueSnapshots: maxUniqueHistories, maxUniquePlayerEntries },
      bots: bots.map(bot => ({ id: bot.id, inputs: bot.inputs, ackProgress: bot.ackProgress, maxAcknowledged: bot.ackMax, moved: bot.moved, healthLost: bot.healthLost, snapshots: bot.snapshots, resets: bot.resets })), samples };
  };
  const phases: Awaited<ReturnType<typeof phase>>[] = [];
  let historyEmptyImmediatelyAfterReset = false, allClientsReceivedReset = false, connectionsAfterCleanup = 0;
  let failure: string | undefined;
  try {
    const first = connect(0);
    await wait(() => first.ready, 'first world');
    send(first, { type: 'spawn', roundId: first.roundId, kit: 'assault' });
    await wait(() => first.state?.alive === true, 'first spawn');
    for (let index = 1; index < count; index++) connect(index);
    await wait(() => bots.every(bot => bot.ready), 'all worlds');
    drive = true;
    await wait(() => bots.every(bot => bot.state?.alive), 'all spawns');
    await Bun.sleep(1500);
    phases.push(await phase('generated-terrain-combat', seconds));
    drive = false; await Bun.sleep(rtt + 150);
    const previousRound = host.game.roundId;
    host.game.resetRound();
    historyEmptyImmediatelyAfterReset = [...host.game.connections].every(connection => connection.hitSnapshots.every(snapshot => snapshot.tick === host.game.tick));
    await wait(() => bots.every(bot => bot.roundId > previousRound && bot.ready), 'reset worlds');
    allClientsReceivedReset = bots.every(bot => bot.resets === 1);
    drive = true;
    await wait(() => bots.every(bot => bot.state?.alive), 'reset spawns');
    await Bun.sleep(1500);
    phases.push(await phase('after-reset', resetSeconds));
  } catch (caught) {
    failure = caught instanceof Error ? caught.message : String(caught);
  } finally {
    drive = false; stopping = true; clearInterval(timer);
    for (const bot of bots) bot.socket.close();
    const deadline = performance.now() + 5000;
    while (host.game.connections.size && performance.now() < deadline) await Bun.sleep(10);
    connectionsAfterCleanup = host.game.connections.size;
    host.stop();
  }
  const passed = !failure && phases.length === 2 && phases.every(result => result.passed)
    && allClientsReceivedReset && historyEmptyImmediatelyAfterReset && connectionsAfterCleanup === 0;
  return { compensated, passed, errors, failure, historyEmptyImmediatelyAfterReset, allClientsReceivedReset, phases, connectionsAfterCleanup };
}

const sourceHashes: Record<string, string> = {};
for (const path of ['src/shared/game.ts', 'src/shared/protocol.ts', 'src/client/remote-players.ts', 'src/server/index.ts', 'scripts/benchmark-combat-load.ts']) {
  sourceHashes[path] = createHash('sha256').update(await Bun.file(path).bytes()).digest('hex');
}
const results: unknown[] = [];
for (const compensated of args.get('arm') === 'on' ? [true] : args.get('arm') === 'off' ? [false] : [false, true]) {
  const result = await run(compensated); results.push(result);
  const output = resolve(args.get('output') ?? '.runtime/combat-load-latest.json');
  await Bun.write(output, JSON.stringify({ date: new Date().toISOString(), bun: Bun.version, protocol: PROTOCOL_VERSION,
    players: count, requestedRtt: rtt, sourceHashes,
    method: 'Real local WebSocket clients and unmodified production startServer/GameServer scheduler. Symmetric client transport queues request 25 ms each way by default. RemotePlayers renders every generated frame batch; view tick/latest snapshot/revision come from received and applied state. The stock generated 64x64x32 world and normal server spawn selection are retained before and after reset, without position or terrain fixtures. Bots steer toward a radius-13 circle around the center, periodically jump, and aim from received states; natural terrain can prevent concentration or occlude shots. All movement, firing, health, deaths, spawning and terrain changes are authoritative. Bots shoot AK/AWP in ADS and 10% periodically use the shovel. 60 Hz elapsed-time input accumulator, maximum 100 ms catchup. Both A/B arms retain current server history collection, sending identical bot rules with metadata omitted/present; combat outcomes may differ, so this does not isolate total overhead versus an older server. Explicit public resetRound between phases; old transport input packets remain subject to normal round filtering.',
    limitations: 'Server plus all clients share one Bun process; RSS includes the generator and 100 client worlds/interpolation buffers. Windows timers can raise actual RTT. No GPU, browser rendering, WAN, production server capacity or 100-browser guarantee. Stock tickWork covers at most the latest 1024 ticks, max is since server start; per-second stock metrics are saved. Terrain-history storage is private and not inspected; its source bound is 32768 voxel entries and 15 ticks. Client ack progress, unique server events and received health/position/terrain effects are required, not merely emitted intentions.',
    results }, null, 2) + '\n');
  console.log(JSON.stringify({ output, compensated, passed: result.passed, connectionsAfterCleanup: result.connectionsAfterCleanup }));
  if (!result.passed) process.exitCode = 1;
}
