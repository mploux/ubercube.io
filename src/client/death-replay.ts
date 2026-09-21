import { TICK_RATE, type GameEvent, type PlayerState, type ProjectileState, type ServerMessage, type Vec3 } from '../shared/protocol';

export const DEATH_REPLAY_SECONDS = 3;
const ACTION_SECONDS = 2.7;
const HISTORY_TICKS = 4 * TICK_RATE;
const MAX_SNAPSHOTS = 100;
const MAX_EVENTS = 4096;
const MAX_PLAYERS = 100;
const MAX_PROJECTILES = 512;
type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
interface Snapshot { tick: number; players: Map<number, PlayerState>; projectiles: Map<number, ProjectileState> }
interface Playback {
  snapshots: Snapshot[]; events: GameEvent[]; death: GameEvent; killer: PlayerState;
  startTick: number; endTick: number; tick: number; eventIndex: number; started: boolean;
}
export interface DeathReplayFrame {
  tick: number; players: PlayerState[]; projectiles: ProjectileState[]; killer: PlayerState; events: GameEvent[];
}

function copyState<T extends { position: Vec3; velocity: Vec3 }>(state: T): T {
  return { ...state, position: { ...state.position }, velocity: { ...state.velocity } };
}

export class DeathReplay {
  private readonly snapshots: Snapshot[] = [];
  private readonly events: GameEvent[] = [];
  private roundId: number | null = null;
  private playback: Playback | null = null;

  recordSnapshot(message: SnapshotMessage): void {
    if (!Number.isInteger(message.tick) || message.tick < 0 || !this.acceptRound(message.roundId)) return;
    const latest = this.snapshots.at(-1);
    if (latest && message.tick < latest.tick) return;
    const snapshot: Snapshot = { tick: message.tick,
      players: new Map(message.players.slice(0, MAX_PLAYERS).map(player => [player.id, copyState(player)])),
      projectiles: new Map(message.projectiles.slice(0, MAX_PROJECTILES).map(projectile => [projectile.id, copyState(projectile)])),
    };
    if (latest?.tick === message.tick) this.snapshots[this.snapshots.length - 1] = snapshot;
    else this.snapshots.push(snapshot);
    this.prune(message.tick);
  }

  recordEvent(event: GameEvent): void {
    if (!this.acceptRound(event.roundId)) return;
    const tick = event.tick ?? this.snapshots.at(-1)?.tick;
    if (tick === undefined || !Number.isInteger(tick) || tick < 0) return;
    const recorded = { ...structuredClone(event), tick };
    this.events.push(recorded);
    const playback = this.playback;
    // Impact/explosion messages can follow the death in the same authoritative tick.
    if (playback && !playback.started && tick === playback.endTick
      && !(event.event === 'death' && event.targetId === playback.death.targetId)) {
      playback.events.push(recorded);
      if (playback.events.length > MAX_EVENTS) playback.events.shift();
    }
    this.prune(Math.max(tick, this.snapshots.at(-1)?.tick ?? tick));
  }

  start(death: GameEvent, localId: number): boolean {
    this.resetPlayback();
    const tick = death.tick ?? this.snapshots.at(-1)?.tick;
    if (death.event !== 'death' || death.targetId !== localId || !death.death || death.death.player.id !== localId
      || death.shooterId === undefined || death.shooterId === localId || tick === undefined || !Number.isInteger(tick)
      || tick < 0 || (this.roundId !== null && this.roundId !== death.roundId)) return false;
    const snapshots = this.snapshots.filter(snapshot => snapshot.tick <= tick && snapshot.tick >= tick - HISTORY_TICKS).slice(-(MAX_SNAPSHOTS - 1));
    const historyKiller = [...snapshots].reverse().map(snapshot => snapshot.players.get(death.shooterId!)).find(Boolean);
    const killer = death.death.killer?.id === death.shooterId ? death.death.killer : historyKiller;
    if (!killer) return false;
    this.roundId = death.roundId;
    const fatal = { ...structuredClone(death), tick };
    const terminal = snapshots.at(-1);
    if (terminal?.tick === tick) snapshots.pop();
    const players = new Map(terminal?.players);
    // The exact fatal pose is alive until its event, even if no snapshot caught this life.
    players.set(localId, { ...copyState(death.death.player), alive: true, health: 1, deaths: Math.max(0, death.death.player.deaths - 1) });
    players.set(killer.id, copyState(killer));
    while (players.size > MAX_PLAYERS) {
      const id = [...players.keys()].find(id => id !== localId && id !== killer.id)!;
      players.delete(id);
    }
    snapshots.push({ tick, players, projectiles: new Map(terminal?.projectiles) });
    const startTick = tick - ACTION_SECONDS * TICK_RATE;
    const events = this.events.filter(event => event.tick! >= startTick && event.tick! <= tick
      && !(event.event === 'death' && event.targetId === localId && event.tick === tick));
    events.push(fatal);
    events.sort((a, b) => a.tick! - b.tick!);
    this.playback = { snapshots, events: events.slice(-MAX_EVENTS), death: fatal, killer: copyState(killer),
      startTick, endTick: tick, tick: startTick, eventIndex: 0, started: false };
    return true;
  }

  sample(elapsedSeconds: number): DeathReplayFrame | null {
    const playback = this.playback;
    if (!playback || !Number.isFinite(elapsedSeconds) || elapsedSeconds >= DEATH_REPLAY_SECONDS) return null;
    playback.started = true;
    const tick = Math.max(playback.tick, Math.min(playback.endTick,
      playback.startTick + Math.max(0, elapsedSeconds) * TICK_RATE));
    playback.tick = tick;
    let before = playback.snapshots[0], after = before;
    for (const snapshot of playback.snapshots) {
      if (snapshot.tick <= tick) before = snapshot;
      after = snapshot;
      if (snapshot.tick >= tick) break;
    }
    const fraction = before === after ? 0 : Math.max(0, Math.min(1, (tick - before.tick) / (after.tick - before.tick)));
    const lerp = (a: number, b: number) => a + (b - a) * fraction;
    const blend = (a: Vec3, b: Vec3): Vec3 => ({ x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z) });
    const players = [...before.players.values()].map(previous => {
      const next = after.players.get(previous.id);
      if (!next || !previous.alive || !next.alive || previous.deaths !== next.deaths
        || Math.hypot(next.position.x - previous.position.x, next.position.y - previous.position.y, next.position.z - previous.position.z) > 15) return copyState(previous);
      const turn = Math.atan2(Math.sin(next.yaw - previous.yaw), Math.cos(next.yaw - previous.yaw));
      return { ...copyState(previous), position: blend(previous.position, next.position), velocity: blend(previous.velocity, next.velocity),
        yaw: previous.yaw + turn * fraction, pitch: lerp(previous.pitch, next.pitch) };
    });
    const events: GameEvent[] = [];
    while (playback.eventIndex < playback.events.length && playback.events[playback.eventIndex].tick! <= tick) {
      events.push(structuredClone(playback.events[playback.eventIndex++]));
    }
    const endedProjectiles = new Set<number>();
    const launchedProjectiles: GameEvent[] = [];
    for (const event of playback.events) {
      if (event.tick! > tick) break;
      if (event.event === 'shot' && event.tick! > before.tick && (event.weapon === 'rpg' || event.weapon === 'grenade')
        && event.projectileId !== undefined && event.shooterId !== undefined && event.velocity) launchedProjectiles.push(event);
      if (event.projectileId !== undefined
        && (event.event === 'projectile-end' || event.event === 'explosion' || (event.event === 'impact' && event.weapon === 'rpg'))) endedProjectiles.add(event.projectileId);
      if (!event.death || (event.tick! < before.tick && event !== playback.death)) continue;
      const index = players.findIndex(player => player.id === event.death!.player.id);
      if (index !== -1 && players[index].deaths <= event.death.player.deaths) players[index] = copyState(event.death.player);
    }
    let killer = players.find(player => player.id === playback.killer.id);
    if (!killer) {
      for (let index = playback.snapshots.length - 1; index >= 0; index--) {
        if (playback.snapshots[index].tick > tick) continue;
        const previous = playback.snapshots[index].players.get(playback.killer.id);
        if (previous) { killer = copyState(previous); break; }
      }
      killer ??= copyState(playback.killer);
    }
    const projectiles = [...before.projectiles.values()].map(previous => {
      const next = after.projectiles.get(previous.id);
      return next && next.owner === previous.owner && next.weapon === previous.weapon
        ? { ...previous, position: blend(previous.position, next.position), velocity: blend(previous.velocity, next.velocity) }
        : copyState(previous);
    }).filter(projectile => !endedProjectiles.has(projectile.id));
    for (const event of launchedProjectiles) {
      const id = event.projectileId!;
      if (projectiles.length >= MAX_PROJECTILES) break;
      if (endedProjectiles.has(id) || projectiles.some(projectile => projectile.id === id)) continue;
      const next = after.projectiles.get(id), bornTick = event.tick! - 1;
      const fraction = next ? Math.max(0, Math.min(1, (tick - bornTick) / (after.tick - bornTick))) : 0;
      const seconds = Math.max(0, Math.min(.05, (tick - bornTick) / TICK_RATE));
      const position = { ...event.position };
      for (const axis of ['x', 'y', 'z'] as const) position[axis] += next
        ? (next.position[axis] - position[axis]) * fraction : event.velocity![axis] * seconds;
      // Synthetic replay snapshots must include launches between the recorded 20 Hz snapshots.
      projectiles.push({ id, owner: event.shooterId!, weapon: event.weapon!, position, velocity: { ...(next?.velocity ?? event.velocity!) } });
    }
    return { tick, players, projectiles, killer, events };
  }

  resetPlayback(): void { this.playback = null; }

  clear(): void {
    this.snapshots.length = 0;
    this.events.length = 0;
    this.roundId = null;
    this.resetPlayback();
  }

  private acceptRound(roundId: number): boolean {
    if (this.roundId !== null && roundId < this.roundId) return false;
    if (this.roundId !== roundId) { this.clear(); this.roundId = roundId; }
    return true;
  }

  private prune(tick: number): void {
    while (this.snapshots.length > MAX_SNAPSHOTS || (this.snapshots.length > 1 && this.snapshots[0].tick < tick - HISTORY_TICKS)) this.snapshots.shift();
    while (this.events.length > MAX_EVENTS || (this.events.length && this.events[0].tick! < tick - HISTORY_TICKS)) this.events.shift();
  }
}
