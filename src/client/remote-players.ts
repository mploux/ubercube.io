import { TICK_RATE, type RemotePlayerState } from '../shared/protocol';

interface Delivery { tick: number; offset: number }
interface Track { samples: RemotePlayerState[]; renderTick: number }
const TICK_MS = 1000 / TICK_RATE;

export class RemotePlayers {
  private readonly deliveries: Delivery[] = [];
  private readonly players = new Map<number, Track>();
  private clockOffset = 0;
  private renderTime = -Infinity;

  snapshot(tick: number, players: readonly RemotePlayerState[], now: number): void {
    if (!Number.isInteger(tick) || tick < 0 || !Number.isFinite(now)) return;
    const latest = this.deliveries.at(-1);
    if (latest && tick < latest.tick) return;
    if (!latest || tick > latest.tick) {
      this.deliveries.push({ tick, offset: now - tick * TICK_MS });
      if (this.deliveries.length > 40) this.deliveries.shift();
      const offsets = this.deliveries.map(delivery => delivery.offset).sort((a, b) => a - b);
      // Only envelope delivery measures network jitter; retained player samples are deliberately old.
      this.clockOffset = offsets[Math.ceil(offsets.length * .95) - 1];
    }
    const present = new Set<number>();
    for (const player of players) {
      if (!Number.isInteger(player.sampleTick) || player.sampleTick < 0 || player.sampleTick > tick
        || (player.sampleInterval !== 3 && player.sampleInterval !== 6 && player.sampleInterval !== 12)) continue;
      present.add(player.id);
      const track = this.players.get(player.id), previous = track?.samples.at(-1);
      if (previous && player.sampleTick < previous.sampleTick) continue;
      if (!track || !previous || previous.alive !== player.alive || previous.deaths !== player.deaths
        || Math.hypot(player.position.x - previous.position.x, player.position.y - previous.position.y, player.position.z - previous.position.z) > 15) {
        this.players.set(player.id, { samples: [player], renderTick: player.sampleTick });
      } else if (player.sampleTick === previous.sampleTick) {
        track.samples[track.samples.length - 1] = player;
      } else {
        track.samples.push(player);
        if (track.samples.length > 40) track.samples.shift();
      }
    }
    for (const id of this.players.keys()) if (!present.has(id)) this.players.delete(id);
  }

  sample(now: number): RemotePlayerState[] {
    if (!Number.isFinite(now)) return [];
    const elapsed = Math.max(0, (now - this.renderTime) / TICK_MS);
    this.renderTime = Math.max(this.renderTime, now);
    const serverTick = (now - this.clockOffset) / TICK_MS;
    return [...this.players.values()].map(track => {
      const first = track.samples[0], current = track.samples.at(-1)!;
      const targetTick = Math.max(track.renderTick, first.sampleTick, Math.min(current.sampleTick, serverTick - current.sampleInterval));
      // Catch up after a promotion without jumping or ever replaying an older pose.
      track.renderTick = Math.max(first.sampleTick, Math.min(targetTick, track.renderTick + elapsed * 2));
      let before = first, after = current;
      for (const state of track.samples) {
        if (state.sampleTick <= track.renderTick) before = state;
        if (state.sampleTick >= track.renderTick) { after = state; break; }
      }
      const fraction = before === after ? 1 : (track.renderTick - before.sampleTick) / (after.sampleTick - before.sampleTick);
      const lerp = (a: number, b: number) => a + (b - a) * fraction;
      const turn = Math.atan2(Math.sin(after.yaw - before.yaw), Math.cos(after.yaw - before.yaw));
      return {
        ...(fraction < 1 ? before : after), name: current.name, team: current.team,
        position: { x: lerp(before.position.x, after.position.x), y: lerp(before.position.y, after.position.y), z: lerp(before.position.z, after.position.z) },
        velocity: { x: lerp(before.velocity.x, after.velocity.x), z: lerp(before.velocity.z, after.velocity.z) },
        yaw: before.yaw + turn * fraction, pitch: lerp(before.pitch, after.pitch),
      };
    });
  }

  clear(): void {
    this.deliveries.length = 0;
    this.players.clear();
    this.clockOffset = 0;
    this.renderTime = -Infinity;
  }
}
