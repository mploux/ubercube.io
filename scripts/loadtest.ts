import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { DT, KITS, PROTOCOL_VERSION, type InputFrame, type Kit, type PlayerState, type ServerMessage } from '../src/shared/protocol';
import { createServerMessageDecoder } from '../src/shared/wire';
import { VoxelWorld } from '../src/shared/voxel';

export function parseLoadtestArgs(argumentsList: string[]) {
  const args = new Map<string, string>();
  for (const argument of argumentsList) {
    const match = /^--(url|players|seconds|ramp-ms|warmup-seconds|sample-seconds|reconnect-seconds|max-server-rss-mib|output)=(.+)$/.exec(argument);
    assert(match && !args.has(match[1]), `Unknown, empty or duplicate argument: ${argument}`);
    args.set(match[1], match[2]);
  }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = args.get(name) ?? String(fallback), value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    assert(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${name}: ${raw} (expected ${min}..${max})`);
    return value;
  };
  const url = new URL(args.get('url') ?? 'ws://127.0.0.1:3000/ws');
  assert(['ws:', 'wss:'].includes(url.protocol) && url.pathname === '/ws' && !url.username
    && !url.password && !url.search && !url.hash, 'Use a ws(s)://host[:port]/ws target without credentials');
  const output = resolve(args.get('output') ?? '.runtime/loadtest-latest.json');
  assert(output.startsWith(resolve('.runtime') + sep) && output.endsWith('.json'), 'Output must be a .json file inside .runtime');
  return {
    url: url.href, output, players: integer('players', 100, 2, 1000), seconds: integer('seconds', 30, 1, 28800),
    rampMs: integer('ramp-ms', 100, 0, 10000), warmupSeconds: integer('warmup-seconds', 60, 1, 600),
    sampleSeconds: integer('sample-seconds', 5, 1, 60), reconnectSeconds: integer('reconnect-seconds', 0, 0, 3600),
    maxServerRssMiB: integer('max-server-rss-mib', 1024, 0, 1048576),
  };
}

// All peers check ordering; only the first and last peers allocate voxel replicas.
export class TerrainReplica {
  roundId = 0;
  revision = -1;
  ready = false;
  world?: VoxelWorld;
  constructor(private readonly keepWorld: boolean) {}

  receive(message: ServerMessage): void {
    if (message.type === 'welcome' || message.type === 'reset') {
      assert(message.type === 'welcome' ? this.roundId === 0 : message.roundId === this.roundId + 1,
        'Unexpected welcome or round transition');
      this.roundId = message.roundId; this.revision = -1; this.ready = false;
      if (this.keepWorld) this.world = new VoxelWorld(message.world);
      return;
    }
    if ('roundId' in message) assert(this.roundId > 0 && message.roundId === this.roundId, 'Stale or unknown round');
    if (message.type !== 'world') return;
    assert(Number.isSafeInteger(message.revision) && message.revision >= 0, 'Invalid terrain revision');
    if (message.initial) {
      assert(!this.ready, 'Initial terrain restarted without resetting the replica');
      assert(this.revision === -1 || message.revision === this.revision || message.revision === this.revision + 1,
        'Initial terrain revision gap');
      this.ready = !!message.complete;
    } else {
      assert(this.ready && message.revision === this.revision + 1, 'Live terrain revision gap');
    }
    this.revision = message.revision;
    this.world?.applyEdits(message.edits);
  }

  compare(other: TerrainReplica): number | null {
    if (!this.ready || !other.ready || this.roundId !== other.roundId || this.revision !== other.revision) return null;
    assert(this.world && other.world, 'Terrain comparison requires two replicas');
    assert.deepEqual(this.world.config, other.world.config, 'Terrain configuration differs');
    const edits = this.world.getEdits();
    assert.equal(edits.length, other.world.getEdits().length, 'Terrain override count differs');
    for (const [x, y, z, value] of edits) assert.equal(other.world.get(x, y, z), value, `Terrain differs at ${x},${y},${z}`);
    return edits.length;
  }
}

export function terrainDigest(world: VoxelWorld, roundId: number, revision: number) {
  const edits = world.getEdits().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return { roundId, revision, editCount: edits.length, sha256: createHash('sha256').update(JSON.stringify(edits), 'utf8').digest('hex') };
}

type Options = ReturnType<typeof parseLoadtestArgs>;
type ServerStatus = { players: number; roundId: number; pendingInput: number; lateTicks: number; droppedInputs: number; rss: number;
  projectiles: number; tickWork: { p99: number }; [key: string]: unknown };
type Bot = {
  socket: WebSocket; index: number; id: number; seq: number; terrain: TerrainReplica; state?: PlayerState; kit: Kit;
  closing: boolean; joinedAt: number; lastSpawn: number; lastInputAt: number; accumulator: number; inputs: number;
  activeSeconds: number; lastSnapshotAt: number; lastTick: number; pendingPing: number | null; nextPingAt: number;
};

export async function runLoadtest(options: Options, signal?: AbortSignal) {
  const bots: Bot[] = [], errors: Record<string, number> = {};
  const categories: Record<string, { messages: number; bytes: number }> = {}, rtts: number[] = [];
  const statusUrl = new URL('/api/status', options.url.replace(/^ws/, 'http'));
  const startedAt = performance.now(), journal = options.output.replace(/\.json$/, '.jsonl');
  let measurementStartedAt = 0, measuredSeconds = 0, measuring = false, stopping = false, finished = false;
  let inputs = 0, inputMessages = 0, inputBytes = 0, bytesReceived = 0, snapshots = 0, worldEdits = 0;
  let shots = 0, deaths = 0, resets = 0, reconnects = 0, terrainChecks = 0, terrainEditsChecked = 0;
  let maxFramesPerMessage = 0, cappedClientMilliseconds = 0, maxRtt = 0, maxSnapshotGap = 0, maxClientBuffer = 0;
  let peakAlive = 0, maxPendingInput = 0, sampleCount = 0, maxRss = 0, maxSampledTickP99Ms = 0;
  let serverBefore: ServerStatus | null = null, server: ServerStatus | null = null;
  let phase = 'warming', failure: string | null = null, connected = 0, alive = 0, lastComparisonRound = 0, comparedReconnect = -1;
  let measuredTerrainChecks = 0, finalTerrainConverged = false;
  let finalTerrain: ReturnType<typeof terrainDigest> | null = null;
  let cleanupComplete = false;
  let serverMemoryBudgetExceeded = false;
  const recordError = (message: string) => { errors[message] = (errors[message] ?? 0) + 1; };
  const healthy = () => {
    signal?.throwIfAborted();
    assert(Object.keys(errors).length === 0, `Loadtest error: ${Object.keys(errors).join('; ')}`);
  };
  const readStatus = async (): Promise<ServerStatus> => {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    assert(response.ok, `Status endpoint returned ${response.status}`);
    const status = await response.json() as ServerStatus;
    assert([status.players, status.roundId, status.pendingInput, status.lateTicks, status.droppedInputs,
      status.projectiles, status.tickWork?.p99, status.rss].every(Number.isFinite) && status.rss >= 0,
      'Invalid server metrics');
    server = status;
    maxRss = Math.max(maxRss, status.rss);
    serverMemoryBudgetExceeded ||= options.maxServerRssMiB > 0 && status.rss > options.maxServerRssMiB * 1024 * 1024;
    assert(!serverMemoryBudgetExceeded, `Server RSS exceeded ${options.maxServerRssMiB} MiB budget: ${status.rss} bytes`);
    return status;
  };
  const wait = async (condition: () => boolean, seconds: number, label: string, checkErrors = true) => {
    const deadline = performance.now() + seconds * 1000;
    while (!condition()) {
      if (checkErrors) healthy();
      assert(performance.now() < deadline, `Timed out: ${label}`);
      await Bun.sleep(20);
    }
  };
  const connect = (index: number) => {
    const decode = createServerMessageDecoder();
    const socket = new WebSocket(options.url);
    socket.binaryType = 'arraybuffer';
    const now = performance.now(), previous = bots[index];
    const bot: Bot = {
      socket, index, id: 0, seq: 0, terrain: new TerrainReplica(index === 0 || index === options.players - 1),
      kit: index % 4 === 0 ? 'sniper' : 'assault', closing: false, joinedAt: now, lastSpawn: -Infinity,
      lastInputAt: now, accumulator: 0, inputs: previous?.inputs ?? 0, activeSeconds: previous?.activeSeconds ?? 0,
      lastSnapshotAt: 0, lastTick: -1, pendingPing: null, nextPingAt: now,
    };
    bots[index] = bot;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Load-${index + 1}` }));
    socket.onmessage = event => {
      try {
        const message = decode(event.data), now = performance.now();
        const size = typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength;
        if (measuring) {
          const category = message.type === 'event' ? `event:${message.event}`
            : message.type === 'world' ? `world:${message.initial ? 'initial' : 'delta'}` : message.type;
          const counters = categories[category] ??= { messages: 0, bytes: 0 };
          counters.messages++; counters.bytes += size; bytesReceived += size;
        }
        bot.terrain.receive(message);
        if (message.type === 'welcome') bot.id = message.id;
        else if (message.type === 'world') { if (measuring) worldEdits += message.edits.length; }
        else if (message.type === 'snapshot') {
          assert(bot.terrain.ready && message.tick >= bot.lastTick, 'Snapshot before synchronization or tick regression');
          if (measuring) {
            snapshots++;
            if (bot.lastSnapshotAt) maxSnapshotGap = Math.max(maxSnapshotGap, now - bot.lastSnapshotAt);
          }
          bot.lastSnapshotAt = now; bot.lastTick = message.tick;
          const state = message.players.find(player => player.id === bot.id);
          assert(state, 'Own player missing from snapshot');
          if (state.alive !== bot.state?.alive) { bot.accumulator = 0; bot.lastInputAt = now; }
          bot.state = state;
        } else if (message.type === 'reset') {
          if (measuring) resets++;
          bot.seq = 0; bot.state = undefined; bot.accumulator = 0; bot.lastInputAt = now;
          bot.lastSpawn = -Infinity; bot.joinedAt = now; bot.lastTick = -1; bot.lastSnapshotAt = 0;
        } else if (message.type === 'event' && measuring) {
          if (message.event === 'death') deaths++;
          if (message.event === 'shot') shots++;
        } else if (message.type === 'error') recordError(message.message);
        else if (message.type === 'pong') {
          assert(bot.pendingPing === message.time, 'Unexpected pong');
          if (measuring) {
            const rtt = now - message.time; maxRtt = Math.max(maxRtt, rtt);
            if (rtts.length === 2048) rtts.shift();
            rtts.push(rtt);
          }
          bot.pendingPing = null;
        }
      } catch (error) { recordError(error instanceof Error ? error.message : String(error)); }
    };
    socket.onerror = () => { if (!stopping && !bot.closing) recordError('WebSocket error'); };
    socket.onclose = () => { if (!stopping && !bot.closing) recordError('Unexpected disconnection'); };
    return bot;
  };
  const timer = setInterval(() => {
    try {
      const now = performance.now();
      for (const bot of bots) {
        const elapsed = now - bot.lastInputAt;
        bot.lastInputAt = now;
        if (bot.closing || bot.socket.readyState !== WebSocket.OPEN) continue;
        maxClientBuffer = Math.max(maxClientBuffer, bot.socket.bufferedAmount);
        assert(bot.socket.bufferedAmount <= 64 * 1024, 'Load generator send buffer exceeded 64 KiB');
        assert(bot.pendingPing === null || now - bot.pendingPing < 10000, 'Pong timeout');
        if (now >= bot.nextPingAt && bot.pendingPing === null) {
          bot.pendingPing = now; bot.nextPingAt = now + 1000;
          bot.socket.send(JSON.stringify({ type: 'ping', time: now }));
        }
        if (!bot.terrain.ready) {
          assert(now - bot.joinedAt < options.warmupSeconds * 1000, 'Terrain synchronization timeout');
          bot.accumulator = 0; continue;
        }
        assert(!bot.lastSnapshotAt || now - bot.lastSnapshotAt < 10000, 'Snapshot timeout');
        if (!bot.state?.alive) {
          bot.accumulator = 0;
          if (now - bot.lastSpawn > 1000) {
            bot.socket.send(JSON.stringify({ type: 'spawn', roundId: bot.terrain.roundId, kit: bot.kit }));
            bot.lastSpawn = now;
          }
          continue;
        }
        if (!measuring) continue;
        bot.activeSeconds += elapsed / 1000;
        cappedClientMilliseconds += Math.max(0, elapsed - 100);
        bot.accumulator += Math.min(elapsed, 100) / 1000;
        const frames: InputFrame[] = [];
        while (bot.accumulator >= DT) {
          bot.accumulator -= DT;
          const seq = ++bot.seq, action = Math.floor(seq / 180) % 5;
          frames.push({
            roundId: bot.terrain.roundId, seq, moveX: Math.sin(seq / 120 + bot.index) > 0 ? .5 : -.5, moveZ: 1,
            yaw: (bot.index % 2 ? Math.PI : 0) + Math.sin(seq / 240) * .8,
            pitch: action === 3 ? -.8 : -.12, jump: seq % 100 === 0, sprint: true,
            fire: action === 3 ? seq % 30 < 15 : action === 4 ? seq % 90 < 60 : true,
            alt: action === 3 && seq % 90 > 70,
            weapon: action === 3 ? 'shovel' : action === 4 ? 'grenade' : KITS[bot.kit][0],
          });
        }
        if (!frames.length) continue;
        inputs += frames.length; inputMessages++; bot.inputs += frames.length;
        maxFramesPerMessage = Math.max(maxFramesPerMessage, frames.length);
        const message = JSON.stringify({ type: 'input', frames });
        inputBytes += Buffer.byteLength(message); bot.socket.send(message);
      }
    } catch (error) { recordError(error instanceof Error ? error.message : String(error)); }
  }, 1);
  const compareTerrain = () => {
    if (bots.length !== options.players) return;
    const edits = bots[0].terrain.compare(bots[options.players - 1].terrain);
    if (edits !== null) {
      terrainChecks++; terrainEditsChecked += edits; lastComparisonRound = bots[0].terrain.roundId; comparedReconnect = reconnects;
      if (measuring) measuredTerrainChecks++;
    }
    return edits !== null;
  };
  const report = () => {
    const duration = measuredSeconds || (measurementStartedAt ? (performance.now() - measurementStartedAt) / 1000 : 0);
    const activePlayerSeconds = bots.reduce((sum, bot) => sum + bot.activeSeconds, 0);
    const activeRatio = duration ? activePlayerSeconds / (duration * options.players) : 0;
    const frameRate = activePlayerSeconds ? inputs / activePlayerSeconds : 0;
    const sorted = [...rtts].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
    const dropped = server && serverBefore ? server.droppedInputs - serverBefore.droppedInputs : null;
    return {
      date: new Date().toISOString(), phase, finished, ok: phase === 'complete', failure, url: options.url, requested: options.players,
      connected, alive, peakAlive, measuredSeconds: duration, elapsedSeconds: (performance.now() - startedAt) / 1000,
      activeClients: bots.filter(bot => bot.inputs > 0).length, activePlayerSeconds, activePlayerRatio: activeRatio,
      framesPerActivePlayerSecond: frameRate, inputs, inputMessages, maxFramesPerMessage, cappedClientMilliseconds,
      inputMbitPerSecond: duration ? inputBytes * 8 / duration / 1e6 : 0,
      receivedMbitPerSecond: duration ? bytesReceived * 8 / duration / 1e6 : 0,
      categories, receivedBytes: bytesReceived, snapshots, worldEditDeliveries: worldEdits,
      shotEventDeliveries: shots, deathEventDeliveries: deaths, resetDeliveries: resets, reconnects,
      terrain: { checks: terrainChecks, measuredChecks: measuredTerrainChecks, finalConverged: finalTerrainConverged,
        overrideValuesCompared: terrainEditsChecked, lastComparisonRound, comparedReconnect,
        final: finalTerrain, digestFormat: 'SHA256 of UTF-8 JSON.stringify(VoxelEdit[]), sorted by x, then y, then z; each edit is [x,y,z,value]',
        kind: 'Two independent client replicas at equal round and revision; not an authoritative server comparison' },
      rttMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: maxRtt, windowSamples: sorted.length },
      maxSnapshotGapMs: maxSnapshotGap, maxClientBufferedBytes: maxClientBuffer, maxSampledPendingInput: maxPendingInput,
      maxSampledServerRss: maxRss, maxSampledTickP99Ms, droppedInputsDuringRun: dropped,
      maxServerRssMiB: options.maxServerRssMiB,
      lateTicksDuringRun: server && serverBefore ? server.lateTicks - serverBefore.lateTicks : null,
      criteria: {
        fullPopulation: connected === options.players, allClientsPlayed: bots.filter(bot => bot.inputs > 0).length === options.players,
        activeRatioAtLeast80Percent: activeRatio >= .8, activeFramesAtLeast55Hz: frameRate >= 55,
        snapshotsAndRttReceived: snapshots > 0 && rtts.length > 0, noApplicationErrors: Object.keys(errors).length === 0,
        terrainConvergedAfterLastJoin: measuredTerrainChecks > 0 && comparedReconnect === reconnects,
        finalTerrainConverged, noDroppedInputs: dropped === 0,
        noLateTicks: !!server && !!serverBefore && server.lateTicks === serverBefore.lateTicks,
        sampledTickP99Below8Ms: sampleCount > 0 && maxSampledTickP99Ms < 8,
        noServerMemoryBudgetExceeded: !serverMemoryBudgetExceeded,
      },
      errors, server, serverBefore, sampleCount, journal, cleanupComplete,
      limitation: 'Application bytes exclude WebSocket/TCP/TLS overhead. Event counts are deliveries, not unique events. RTT percentiles cover the latest 2048 pongs; max covers the measurement. Clients generate 60 Hz inputs with pauses capped at 100 ms. This does not measure browser rendering or prove production capacity. Planned reconnects temporarily reduce connected population.',
    };
  };
  const persist = async () => {
    const current = report();
    await Bun.write(options.output + '.tmp', JSON.stringify(current, null, 2));
    await rename(options.output + '.tmp', options.output);
    await appendFile(journal, JSON.stringify(current) + '\n');
  };
  const sample = async () => {
    healthy(); compareTerrain();
    server = await readStatus();
    assert(!serverBefore || server.roundId >= serverBefore.roundId, 'Server round regressed; possible restart');
    connected = bots.filter(bot => bot.id && bot.socket.readyState === WebSocket.OPEN && !bot.closing).length;
    alive = bots.filter(bot => bot.state?.alive && !bot.closing).length;
    peakAlive = Math.max(peakAlive, alive); maxPendingInput = Math.max(maxPendingInput, server.pendingInput);
    maxSampledTickP99Ms = Math.max(maxSampledTickP99Ms, server.tickWork.p99);
    sampleCount++; await persist();
  };
  try {
    await mkdir(dirname(options.output), { recursive: true });
    await Bun.write(journal, '');
    await persist();
    server = await readStatus();
    for (let index = 0; index < options.players; index++) {
      healthy(); connect(index);
      if (options.rampMs) await Bun.sleep(options.rampMs);
    }
    await wait(() => bots.every(bot => bot.id && bot.terrain.ready && bot.state?.alive), options.warmupSeconds,
      'all requested players identified, synchronized and spawned');
    serverBefore = await readStatus();
    healthy(); compareTerrain();
    measurementStartedAt = performance.now();
    for (const bot of bots) { bot.lastInputAt = measurementStartedAt; bot.lastSnapshotAt = measurementStartedAt; }
    phase = 'running'; measuring = true;
    await sample();
    let nextSample = measurementStartedAt + options.sampleSeconds * 1000;
    let nextReconnect = measurementStartedAt + options.reconnectSeconds * 1000;
    const end = measurementStartedAt + options.seconds * 1000;
    while (performance.now() < end) {
      healthy();
      if (options.reconnectSeconds && performance.now() >= nextReconnect && end - performance.now() > options.warmupSeconds * 1000) {
        const bot = bots[options.players - 1];
        bot.closing = true; bot.socket.close(1000, 'Planned loadtest reconnect');
        await wait(() => bot.socket.readyState === WebSocket.CLOSED, 5, 'planned disconnection');
        reconnects++; connect(bot.index);
        await wait(() => bots[bot.index].terrain.ready && !!bots[bot.index].state?.alive, options.warmupSeconds, 'late join synchronization');
        nextReconnect = performance.now() + options.reconnectSeconds * 1000;
      }
      if (performance.now() >= nextSample) { await sample(); nextSample = performance.now() + options.sampleSeconds * 1000; }
      await Bun.sleep(20);
    }
    measuredSeconds = (performance.now() - measurementStartedAt) / 1000;
    measuring = false; clearInterval(timer);
    phase = 'draining';
    for (const bot of bots) {
      if (!bot.state?.alive || bot.socket.readyState !== WebSocket.OPEN) continue;
      const neutral: InputFrame = { roundId: bot.terrain.roundId, seq: ++bot.seq, moveX: 0, moveZ: 0,
        yaw: bot.state.yaw, pitch: bot.state.pitch, jump: false, sprint: false, fire: false, alt: false,
        weapon: bot.state.weapon, cancelActions: true };
      bot.socket.send(JSON.stringify({ type: 'input', frames: [neutral] }));
    }
    let quietSince = performance.now(), previousTerrain = '';
    const drainDeadline = performance.now() + 10000;
    while (true) {
      healthy(); server = await readStatus();
      const current = bots.map(bot => `${bot.terrain.roundId}:${bot.terrain.revision}`).join(',');
      if (current !== previousTerrain || server.pendingInput !== 0 || server.projectiles !== 0) quietSince = performance.now();
      previousTerrain = current;
      if (performance.now() - quietSince >= 500 && compareTerrain() === true) break;
      assert(performance.now() < drainDeadline, 'Timed out draining input queues, projectiles and terrain');
      await Bun.sleep(100);
    }
    finalTerrainConverged = true;
    const witness = bots[0].terrain;
    finalTerrain = terrainDigest(witness.world!, witness.roundId, witness.revision);
    await sample();
    const failed = Object.entries(report().criteria).filter(([, passed]) => !passed).map(([name]) => name);
    assert(failed.length === 0, `Qualification criteria failed: ${failed.join(', ')}`);
    phase = 'complete';
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error); phase = 'failed';
  } finally {
    measuring = false; stopping = true; clearInterval(timer);
    for (const bot of bots) { bot.closing = true; bot.socket.close(1000, 'Loadtest cleanup'); }
    try {
      await wait(() => bots.every(bot => bot.socket.readyState === WebSocket.CLOSED), 5, 'socket cleanup', false);
      cleanupComplete = true;
    } catch (error) { failure ??= String(error); phase = 'failed'; }
    if (measurementStartedAt && !measuredSeconds) measuredSeconds = (performance.now() - measurementStartedAt) / 1000;
    finished = true; await persist();
  }
  return report();
}

if (import.meta.main) {
  if (Bun.argv.includes('--help')) console.log('bun run loadtest [--url=ws://127.0.0.1:3000/ws] [--players=100] [--seconds=28800] [--ramp-ms=100] [--warmup-seconds=60] [--sample-seconds=5] [--reconnect-seconds=60] [--max-server-rss-mib=1024] [--output=.runtime/loadtest-latest.json]\nRun only against an authorized test target. Reports are updated throughout the run. Set the RSS budget to 0 to disable it.');
  else {
    const controller = new AbortController(), abort = () => controller.abort(new Error('Loadtest interrupted'));
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    try {
      const options = parseLoadtestArgs(Bun.argv.slice(2));
      console.log(`Loadtest: ${options.players} clients, ${options.seconds}s after synchronization, ${options.url}`);
      const result = await runLoadtest(options, controller.signal);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error) { console.error(String(error)); process.exitCode = 1; }
    finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
  }
}
