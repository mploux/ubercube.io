import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GameServer, type Connection, type Peer } from '../src/shared/game';
import { RemotePlayers } from '../src/client/remote-players';
import { decodeServerMessage } from '../src/shared/wire';
import { PROTOCOL_VERSION, DT, type InputFrame, type GameEvent, type ServerMessage } from '../src/shared/protocol';
import { EYE_HEIGHT, PLAYER_RADIUS } from '../src/shared/movement';
import { packBlock } from '../src/shared/voxel';

const tickMs = DT * 1000;
const compensated = !Bun.argv.includes('--uncompensated');
const output = `.runtime/lag-compensation-20260922/deterministic-${compensated ? 'compensated' : 'baseline'}.json`;
const size = 128;
type Spec = { rtt: number; speed: number; weapon: 'ak47' | 'awp'; lead: boolean; phase: number; snapshotPhase: number; seed: number };

function trial(spec: Spec) {
  const { rtt, speed, weapon, lead, phase, snapshotPhase, seed } = spec;
  const half = rtt / 2;
  let now = 0;
  let worldRevision = 0;
  const remote = new RemotePlayers();
  const down: { time: number; message: ServerMessage }[] = [];
  const up: { time: number; connection: Connection; frame: InputFrame }[] = [];
  const events: { time: number; event: GameEvent }[] = [];
  const errors: string[] = [];
  const game = new GameServer({ mode: 'ffa', world: { seed, size, height: 64 }, roundSeconds: 0 });
  const peer = (shooter: boolean): Peer => ({ bufferedAmount: () => 0,
    close: (code, reason) => { errors.push(`close ${code}: ${reason}`); },
    send: data => {
      const message = decodeServerMessage(data);
      if (message.type === 'error') errors.push(message.message);
      if (shooter) {
        down.push({ time: now + half, message });
        if (message.type === 'event') events.push({ time: now, event: message });
      }
      return data.length;
    },
  });
  const join = (name: string, shooter: boolean) => {
    const connection = game.connect(peer(shooter))!;
    game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name }));
    game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: shooter && weapon === 'awp' ? 'sniper' : 'assault' }));
    if (!connection.player?.alive) throw new Error('Fixture spawn failed');
    return connection;
  };
  const shooter = join('Shooter', true), target = join('Target', false);
  // Carve the firing lane after admission so fixture edits do not enter the initial-world transfer.
  for (let z = 57; z <= 103; z++) {
    const fraction = Math.max(0, Math.min(1, (100 - z) / 40));
    for (let x = Math.floor(64 - 24 * fraction) - 3; x <= Math.ceil(64 + 10 * fraction) + 3; x++) {
      game.world.set(x, 7, z, packBlock(90, 120, 60));
      for (let y = 8; y <= 12; y++) game.world.set(x, y, z, 0);
    }
  }
  Object.assign(shooter.player!, { position: { x: 64, y: 8, z: 100 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
  Object.assign(target.player!, { position: { x: 40, y: 8, z: 60 }, velocity: { x: speed, y: 0, z: 0 }, grounded: true });
  down.length = 0;
  game.sendSnapshot(shooter);
  const positions = [{ time: 0, x: target.player!.position.x }];
  const shotFrame = 180 + snapshotPhase;
  let nextClient = phase, clientFrame = 0;
  let nextServer = tickMs;
  let observation: { sentAt: number; renderedX: number; sourceTime: number | null; leadMs: number; aimX: number; yaw: number; pitch: number } | null = null;
  let resolution: { time: number; targetX: number; health: number } | null = null;
  while (now < 4000) {
    now = Math.min(nextClient, nextServer, up[0]?.time ?? Infinity, down[0]?.time ?? Infinity);
    while (down.length && down[0].time <= now + 1e-7) {
      const delivered = down.shift()!;
      if (delivered.message.type === 'snapshot') remote.snapshot(delivered.message.tick, delivered.message.players, delivered.time);
      if (delivered.message.type === 'world') worldRevision = delivered.message.revision;
    }
    while (up.length && up[0].time <= now + 1e-7) {
      const delivered = up.shift()!;
      game.receive(delivered.connection, JSON.stringify({ type: 'input', frames: [delivered.frame] }));
    }
    if (nextServer <= now + 1e-7) {
      game.step();
      positions.push({ time: now, x: target.player!.position.x });
      if (!resolution && events.some(item => item.event.event === 'shot' && item.event.shooterId === shooter.player!.id)) {
        resolution = { time: now, targetX: target.player!.position.x, health: target.player!.health };
      }
      nextServer = (game.tick + 1) * tickMs;
    }
    if (nextClient <= now + 1e-7) {
      const sample = remote.sample(now).find(player => player.id === target.player!.id);
      const renderedX = sample?.position.x ?? target.player!.position.x;
      const receiveAt = now + half;
      const resolveAt = Math.ceil((receiveAt - 1e-7) / tickMs) * tickMs;
      const leadMs = lead ? rtt + 50 + resolveAt - receiveAt : 0;
      const aimX = renderedX + speed * leadMs / 1000;
      const dx = aimX - shooter.player!.position.x, dz = target.player!.position.z - shooter.player!.position.z;
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.atan2(-1, Math.hypot(dx, dz));
      if (clientFrame === shotFrame) {
        let sourceTime: number | null = null;
        if (speed) {
          for (let i = 1; i < positions.length; i++) {
            const a = positions[i - 1], b = positions[i];
            if (renderedX >= a.x && renderedX <= b.x && b.x > a.x) {
              sourceTime = a.time + (renderedX - a.x) / (b.x - a.x) * (b.time - a.time); break;
            }
          }
        }
        observation = { sentAt: now, renderedX, sourceTime, leadMs, aimX, yaw, pitch };
      }
      const base: InputFrame = { seq: clientFrame + 1, roundId: game.roundId, moveX: 0, moveZ: 0,
        yaw, pitch, jump: false, sprint: false, fire: clientFrame === shotFrame, alt: true, weapon,
        ...(compensated && remote.viewTick !== undefined ? { viewTick: remote.viewTick, viewLatestTick: remote.viewLatestTick, worldRevision } : {}) };
      up.push({ time: now + half, connection: shooter, frame: base });
      up.push({ time: now + half, connection: target, frame: { ...base, yaw: 0, pitch: 0, fire: false, alt: false,
        moveX: speed ? 1 : 0, sneak: speed === 3, sprint: speed === 9, weapon: 'ak47' } });
      clientFrame++;
      nextClient = clientFrame * tickMs + phase;
    }
    if (resolution) break;
  }
  if (!observation || !resolution) throw new Error(`No shot: ${JSON.stringify(spec)}`);
  const shot = events.find(item => item.event.event === 'shot' && item.event.shooterId === shooter.player!.id)!.event;
  const impact = events.find(item => item.event.event === 'impact' && item.event.projectileId === shot.projectileId)?.event;
  if (!shot.endPosition) throw new Error('Expected real hitscan endpoint');
  const ray = { x: shot.endPosition.x - shot.position.x, y: shot.endPosition.y - shot.position.y, z: shot.endPosition.z - shot.position.z };
  const atTargetZ = (target.player!.position.z - shot.position.z) / ray.z;
  const rayX = shot.position.x + ray.x * atTargetZ;
  const rayY = shot.position.y + ray.y * atTargetZ;
  const result = { ...spec, targetId: target.player!.id, sequence: shot.inputSeq, serverTick: shot.tick,
    sentAtMs: observation.sentAt, resolvedAtMs: resolution.time,
    inputToResolveMs: resolution.time - observation.sentAt,
    sourceTimeMs: observation.sourceTime,
    renderedAgeMs: observation.sourceTime === null ? null : observation.sentAt - observation.sourceTime,
    effectiveTargetAgeMs: observation.sourceTime === null ? null : resolution.time - observation.sourceTime,
    displayedTargetX: observation.renderedX, authoritativeTargetX: resolution.targetX,
    targetShiftBlocks: resolution.targetX - observation.renderedX,
    leadMs: observation.leadMs, aimX: observation.aimX, rayXAtTargetPlane: rayX,
    rayYAboveTargetFeet: rayY - target.player!.position.y,
    aimRayErrorBlocks: rayX - observation.aimX,
    rayErrorToCurrentTargetBlocks: rayX - resolution.targetX,
    hit: impact?.targetId === target.player!.id, healthAfter: resolution.health, damage: 100 - resolution.health,
    eventCount: events.length, droppedInputs: game.droppedInputs, errors };
  if (errors.length || game.droppedInputs || Math.abs(result.aimRayErrorBlocks) > .001) throw new Error(`Invalid fixture: ${JSON.stringify(result)}`);
  if (result.hit !== (result.damage > 0)) throw new Error('Impact and health disagree');
  if (shot.inputSeq !== shotFrame + 1 || events.filter(item => item.event.event === 'shot').length !== 1) throw new Error('Wrong or duplicate firing command');
  if (result.hit && result.damage !== (weapon === 'ak47' ? 20 : 70)) throw new Error('Expected one body hit');
  return result;
}

const started = performance.now();
const rows: ReturnType<typeof trial>[] = [];
for (const rtt of [0, 50, 100]) for (const speed of [0, 3, 6, 9]) for (const weapon of ['ak47', 'awp'] as const)
  for (const lead of [false, true]) for (const snapshotPhase of [0, 1, 2]) for (const phase of [.5, 4.5, 8.5, 12.5])
    for (const seed of [12345, 54321]) rows.push(trial({ rtt, speed, weapon, lead, snapshotPhase, phase, seed }));
const stats = (values: (number | null)[]) => {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return sorted.length ? { min: sorted[0], median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) } : null;
};
const summary = [];
for (const rtt of [0, 50, 100]) for (const speed of [0, 3, 6, 9]) for (const weapon of ['ak47', 'awp'] as const) for (const lead of [false, true]) {
  const group = rows.filter(row => row.rtt === rtt && row.speed === speed && row.weapon === weapon && row.lead === lead);
  summary.push({ rttMs: rtt, speedBlocksPerSecond: speed, weapon, aim: lead ? 'lead RTT + 50ms + server tick phase' : 'visible center',
    trials: group.length, hits: group.filter(row => row.hit).length, hitRate: group.filter(row => row.hit).length / group.length,
    damageTotal: group.reduce((sum, row) => sum + row.damage, 0), renderedAgeMs: stats(group.map(row => row.renderedAgeMs)),
    inputToResolveMs: stats(group.map(row => row.inputToResolveMs)), effectiveTargetAgeMs: stats(group.map(row => row.effectiveTargetAgeMs)),
    targetShiftBlocks: stats(group.map(row => row.targetShiftBlocks)), rayErrorToCurrentTargetBlocks: stats(group.map(row => row.rayErrorToCurrentTargetBlocks)) });
}
const invariantFailures = rows.filter(row => compensated ? (!row.lead && !row.hit) || (row.speed === 0 && !row.hit)
  : ((row.speed === 0 || row.lead) && !row.hit) || (row.rtt >= 50 && row.speed >= 6 && !row.lead && row.hit));
const sourceSha256: Record<string, string> = {};
for (const path of ['src/shared/game.ts', 'src/shared/movement.ts', 'src/shared/protocol.ts', 'src/shared/weapon-pose.ts', 'src/shared/wire.ts', 'src/client/remote-players.ts']) {
  sourceSha256[path] = createHash('sha256').update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest('hex');
}
const report = { createdAt: new Date().toISOString(), compensated, kind: 'deterministic virtual clock transport simulation', protocol: PROTOCOL_VERSION,
  description: 'Real GameServer, movement, muzzle, hitscan, health effects, codec and RemotePlayers. Ordered virtual uplink/downlink with symmetric RTT. No real sockets, browser frames, jitter, packet loss or production access.',
  fixture: { worldSize: size, flatLaneFloorY: 8, targetZ: 60, shooterZ: 100, shooterEyeHeight: EYE_HEIGHT, hitboxWidth: PLAYER_RADIUS * 2,
    aiming: true, warmupFrames: 180, shotsPerTrial: 1, seeds: [12345, 54321], inputTickPhaseMs: [.5, 4.5, 8.5, 12.5], snapshotPhases: [0, 1, 2],
    note: 'The generated world contains a carved flat firing lane at y=8, made through public VoxelWorld.set after initial admission; this is fixture geometry, not replicated player destruction. Initial positions are set once. Thereafter positions and health change only through GameServer. Visible target sampling at input time is idealized and excludes an extra previous-render-frame delay. Lead uses known virtual transport and tick phase; it is an explanatory control, not implemented lag compensation.' },
  trialCount: rows.length, wallTimeMs: performance.now() - started, sourceSha256,
  rowsSha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  invariantFailures: invariantFailures.length, summary, rows };
mkdirSync('.runtime/lag-compensation-20260922', { recursive: true });
await Bun.write(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ trialCount: report.trialCount, wallTimeMs: report.wallTimeMs,
  invariantFailures: report.invariantFailures, rowsSha256: report.rowsSha256 }));
console.table(summary.filter(row => row.rttMs === 50).map(row => ({ speed: row.speedBlocksPerSecond, weapon: row.weapon,
  aim: row.aim, hits: `${row.hits}/${row.trials}`, effectiveAgeP50: row.effectiveTargetAgeMs?.median ?? null,
  shiftMin: row.targetShiftBlocks?.min, shiftMax: row.targetShiftBlocks?.max })));
if (invariantFailures.length) process.exitCode = 1;
