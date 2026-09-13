import { TICK_RATE, type PlayerState } from '../shared/protocol';

interface Snapshot { tick: number; offset: number; players: Map<number, PlayerState> }
const TICK_MS = 1000 / TICK_RATE;

export class RemotePlayers {
  private readonly snapshots: Snapshot[] = [];
  private clockOffset = 0;
  private interval = 3;
  private renderTick = -Infinity;

  snapshot(tick: number, players: readonly PlayerState[], now: number): void {
    if (!Number.isInteger(tick) || tick < 0 || !Number.isFinite(now)) return;
    const latest = this.snapshots.at(-1);
    if (latest && tick < latest.tick) return;
    const states = new Map(players.map(player => [player.id, player]));
    if (latest && tick === latest.tick) { latest.players = states; return; }
    this.snapshots.push({ tick, offset: now - tick * TICK_MS, players: states });
    if (this.snapshots.length > 40) this.snapshots.shift();
    const offsets = this.snapshots.map(snapshot => snapshot.offset).sort((a, b) => a - b);
    // One snapshot interval plus observed delivery jitter supplies interpolation's next endpoint.
    this.clockOffset = offsets[Math.ceil(offsets.length * .95) - 1];
    if (this.snapshots.length > 1) {
      const intervals = this.snapshots.slice(1).map((snapshot, index) => snapshot.tick - this.snapshots[index].tick).sort((a, b) => a - b);
      this.interval = intervals[Math.floor((intervals.length - 1) / 2)];
    }
  }

  sample(now: number): PlayerState[] {
    const first = this.snapshots[0], latest = this.snapshots.at(-1);
    if (!latest || !Number.isFinite(now)) return [];
    this.renderTick = Math.max(this.renderTick, first.tick, Math.min(latest.tick, (now - this.clockOffset) / TICK_MS - this.interval));
    let before = first, after = latest;
    for (const snapshot of this.snapshots) {
      if (snapshot.tick <= this.renderTick) before = snapshot;
      if (snapshot.tick >= this.renderTick) { after = snapshot; break; }
    }
    const fraction = before === after ? 1 : (this.renderTick - before.tick) / (after.tick - before.tick);
    const lerp = (a: number, b: number) => a + (b - a) * fraction;
    return [...latest.players.values()].map(current => {
      const previous = before.players.get(current.id), next = after.players.get(current.id);
      if (!previous || !next || !current.alive || !previous.alive || !next.alive
        || previous.deaths !== current.deaths || next.deaths !== current.deaths
        || Math.hypot(current.position.x - previous.position.x, current.position.y - previous.position.y, current.position.z - previous.position.z) > 15) return current;
      const turn = Math.atan2(Math.sin(next.yaw - previous.yaw), Math.cos(next.yaw - previous.yaw));
      return {
        ...(fraction < 1 ? previous : next),
        position: { x: lerp(previous.position.x, next.position.x), y: lerp(previous.position.y, next.position.y), z: lerp(previous.position.z, next.position.z) },
        velocity: { x: lerp(previous.velocity.x, next.velocity.x), y: lerp(previous.velocity.y, next.velocity.y), z: lerp(previous.velocity.z, next.velocity.z) },
        yaw: previous.yaw + turn * fraction, pitch: lerp(previous.pitch, next.pitch),
      };
    });
  }

  clear(): void {
    this.snapshots.length = 0;
    this.clockOffset = 0;
    this.interval = 3;
    this.renderTick = -Infinity;
  }
}
