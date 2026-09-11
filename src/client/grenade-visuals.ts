import * as THREE from 'three';
import { TICK_RATE, type GameEvent, type ProjectileState, type Vec3 } from '../shared/protocol';
import { stepGrenade, type GrenadeFlight } from '../shared/grenade';
import type { VoxelWorld } from '../shared/voxel';
import { WEAPON_MODEL_SCALE } from '../shared/weapon-pose';
import { loadWeaponModel } from './weapon-model';

interface Sample { tick: number; position: THREE.Vector3 }
interface Grenade { samples: Sample[]; born: number; received: number; prediction?: LocalGrenade }
interface LocalGrenade {
  owner: number; seq: number; started: number; received: number; world: VoxelWorld;
  state: GrenadeFlight; tick: number; born?: number; id?: number;
  correction: THREE.Vector3; corrected: number;
}
const INTERPOLATION_DELAY = .1;

function copyFlight(state: GrenadeFlight): GrenadeFlight {
  return { ...state, position: { ...state.position }, velocity: { ...state.velocity } };
}

export class GrenadeVisuals {
  readonly ready: Promise<void>;
  private mesh: THREE.InstancedMesh | null = null;
  private readonly grenades = new Map<number, Grenade>();
  private readonly predictions = new Map<number, LocalGrenade>();
  private readonly reservations = new Map<number, { owner: number; started: number }>();
  private readonly ended = new Set<number>();
  private readonly transform = new THREE.Object3D();
  private latestTick = -1;
  private snapshotTick = -1;
  private clockOffset: number | null = null;
  private renderTick = -Infinity;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private fogDistance = 160, private readonly capacity = 256,
    loader: () => Promise<THREE.Group> = () => loadWeaponModel('grenade')) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid grenade capacity');
    this.transform.scale.set(WEAPON_MODEL_SCALE, WEAPON_MODEL_SCALE, -WEAPON_MODEL_SCALE);
    this.ready = loader().then(model => {
      const source = model.getObjectByProperty('isMesh', true) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined;
      if (!source) throw new Error('Grenade model has no mesh');
      if (this.disposed) { source.geometry.dispose(); source.material.dispose(); return; }
      source.material.uniforms.fogDistance.value = this.fogDistance;
      this.mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity);
      this.mesh.name = 'UBERCUBE thrown grenades';
      this.mesh.frustumCulled = false;
      this.mesh.count = 0;
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(this.mesh);
    });
  }

  setFogDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) return;
    this.fogDistance = distance;
    if (this.mesh) (this.mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value = distance;
  }

  predict(owner: number, seq: number, launch: GrenadeFlight, world: VoxelWorld, now: number): void {
    if (this.disposed || this.predictions.has(seq) || this.predictions.size >= this.capacity) return;
    this.predictions.set(seq, { owner, seq, started: now, received: now, world, state: copyFlight(launch), tick: 0,
      correction: new THREE.Vector3(), corrected: now });
    this.reservations.set(seq, { owner, started: now });
  }

  pendingThrows(owner: number, afterSeq: number): number {
    let count = 0;
    for (const [seq, reservation] of this.reservations) if (reservation.owner === owner && seq > afterSeq) count++;
    return count;
  }

  acknowledge(owner: number, seq: number, alive = true): void {
    // Reliable shot events precede the snapshot acknowledging their input; no shot means rejection.
    for (const [key, prediction] of this.predictions) {
      if (prediction.owner === owner && (prediction.seq <= seq || !alive) && prediction.id === undefined) this.predictions.delete(key);
    }
    for (const [key, reservation] of this.reservations) if (reservation.owner === owner && (key <= seq || !alive)) this.reservations.delete(key);
  }

  private project(prediction: LocalGrenade, now: number, target: THREE.Vector3): void {
    const age = Math.max(prediction.tick, Math.min(2 * TICK_RATE, (now - prediction.started) * TICK_RATE));
    const state = copyFlight(prediction.state);
    for (let tick = prediction.tick; tick < Math.floor(age); tick++) stepGrenade(state, prediction.world);
    target.set(state.position.x, state.position.y, state.position.z);
    if (age % 1 > 0) {
      stepGrenade(state, prediction.world);
      target.lerp(new THREE.Vector3(state.position.x, state.position.y, state.position.z), age % 1);
    }
    target.addScaledVector(prediction.correction, Math.exp(-Math.max(0, now - prediction.corrected) * 20));
  }

  private reconcile(prediction: LocalGrenade, position: Vec3, velocity: Vec3, tick: number, now: number, launch = false): void {
    if (!launch && tick < prediction.tick) return;
    const before = new THREE.Vector3(); this.project(prediction, now, before);
    if (launch) { prediction.state = { position: { ...position }, velocity: { ...velocity } }; prediction.tick = 0; }
    else {
      while (prediction.tick < tick) { stepGrenade(prediction.state, prediction.world); prediction.tick++; }
      Object.assign(prediction.state.position, position); Object.assign(prediction.state.velocity, velocity);
    }
    prediction.correction.set(0, 0, 0);
    const after = new THREE.Vector3(); this.project(prediction, now, after);
    prediction.correction.copy(before).sub(after); prediction.corrected = now; prediction.received = now;
  }

  private observe(tick: number, now: number): void {
    if (tick < this.latestTick) return;
    this.latestTick = tick;
    const offset = now - tick / TICK_RATE;
    // A server stall can discard ticks; rebuffer instead of keeping a permanently outdated clock.
    if (this.clockOffset === null || offset < this.clockOffset || offset - this.clockOffset > INTERPOLATION_DELAY) {
      this.clockOffset = offset;
    }
  }

  private add(id: number, position: Vec3, tick: number, now: number): void {
    if (this.ended.has(id) || !Number.isInteger(id) || id < 0 || ![position.x, position.y, position.z].every(Number.isFinite)) return;
    let grenade = this.grenades.get(id);
    if (!grenade) {
      if (this.grenades.size >= this.capacity) {
        for (const [key, candidate] of this.grenades) {
          if (candidate.prediction && this.predictions.has(candidate.prediction.seq)) continue;
          this.grenades.delete(key); break;
        }
        if (this.grenades.size >= this.capacity) return;
      }
      grenade = { samples: [], born: tick, received: now };
      this.grenades.set(id, grenade);
    }
    if (grenade.samples.length && grenade.samples.at(-1)!.tick >= tick) return;
    grenade.received = now;
    grenade.samples.push({ tick, position: new THREE.Vector3(position.x, position.y, position.z) });
    if (grenade.samples.length > 8) grenade.samples.shift();
  }

  snapshot(projectiles: readonly ProjectileState[], tick: number, now: number): void {
    if (this.disposed || !Number.isFinite(now) || !Number.isInteger(tick) || tick < 0 || tick <= this.snapshotTick) return;
    this.snapshotTick = tick;
    this.observe(tick, now);
    const present = new Set<number>();
    for (const projectile of projectiles) {
      if (projectile.weapon !== 'grenade') continue;
      present.add(projectile.id);
      this.add(projectile.id, projectile.position, tick, now);
      const prediction = this.grenades.get(projectile.id)?.prediction;
      if (prediction) this.reconcile(prediction, projectile.position, projectile.velocity, tick - prediction.born!, now);
    }
    for (const [id, grenade] of this.grenades) {
      if (!present.has(id) && grenade.samples.at(-1)!.tick < tick) this.remove(id);
    }
  }

  private remove(id: number): void {
    const prediction = this.grenades.get(id)?.prediction;
    if (prediction) this.predictions.delete(prediction.seq);
    this.grenades.delete(id);
    this.ended.add(id);
    if (this.ended.size > this.capacity * 2) this.ended.delete(this.ended.values().next().value!);
  }

  event(event: GameEvent, now: number): void {
    const id = event.projectileId;
    if (this.disposed || event.weapon !== 'grenade' || !Number.isInteger(id) || id! < 0
      || !Number.isInteger(event.tick) || event.tick! < 0 || !Number.isFinite(now)) return;
    if (event.event === 'shot') {
      this.observe(event.tick!, now);
      // A shot is emitted before this tick's physics; snapshots contain its end position.
      this.add(id!, event.position, event.tick! - 1, now);
      const prediction = this.predictions.get(event.inputSeq!);
      const grenade = this.grenades.get(id!);
      if (grenade && prediction && prediction.owner === event.shooterId && prediction.id === undefined && event.velocity) {
        prediction.id = id; prediction.born = event.tick! - 1; grenade.prediction = prediction;
        this.reconcile(prediction, event.position, event.velocity, 0, now, true);
      }
    } else if (event.event === 'explosion' || event.event === 'projectile-end') this.remove(id!);
  }

  update(now: number): void {
    if (this.disposed || !this.mesh || !Number.isFinite(now)) return;
    // Remote throws retain the interpolation buffer; local throws render on their release timeline.
    if (this.clockOffset !== null) this.renderTick = Math.min(this.latestTick, Math.max(this.renderTick, (now - this.clockOffset - INTERPOLATION_DELAY) * TICK_RATE));
    let count = 0;
    for (const [seq, reservation] of this.reservations) if (now - reservation.started > 1) this.reservations.delete(seq);
    for (const [seq, prediction] of this.predictions) {
      if (now - prediction.received > 1) { this.predictions.delete(seq); continue; }
      this.project(prediction, now, this.transform.position);
      const age = Math.max(0, now - prediction.started);
      this.transform.rotation.set(age * 3, age * 2 + seq, 0);
      this.transform.updateMatrix(); this.mesh.setMatrixAt(count++, this.transform.matrix);
    }
    for (const [id, grenade] of this.grenades) {
      if (now - grenade.received > 1) { this.grenades.delete(id); continue; }
      if (grenade.prediction && this.predictions.has(grenade.prediction.seq)) continue;
      if (count >= this.capacity) break;
      if (this.renderTick + 1e-6 < grenade.born) continue;
      const samples = grenade.samples;
      while (samples.length > 2 && samples[1].tick <= this.renderTick) samples.shift();
      const before = samples[0], after = samples[1] ?? before;
      const fraction = before === after ? 0 : THREE.MathUtils.clamp((this.renderTick - before.tick) / (after.tick - before.tick), 0, 1);
      this.transform.position.lerpVectors(before.position, after.position, fraction);
      const age = Math.max(0, (this.renderTick - grenade.born) / TICK_RATE);
      this.transform.rotation.set(age * 3, age * 2 + id, 0);
      this.transform.updateMatrix();
      this.mesh.setMatrixAt(count++, this.transform.matrix);
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.grenades.clear(); this.predictions.clear(); this.reservations.clear(); this.ended.clear();
    this.latestTick = this.snapshotTick = -1;
    this.clockOffset = null; this.renderTick = -Infinity;
    if (this.mesh) this.mesh.count = 0;
  }

  dispose(): void {
    this.clear(); this.disposed = true;
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose();
  }
}
