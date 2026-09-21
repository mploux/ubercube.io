import * as THREE from 'three';
import { TICK_RATE, type GameEvent, type ProjectileState, type Vec3 } from '../shared/protocol';
import { createParticleMaterial, createParticleSorter } from './particle-material';
import { loadWeaponModel } from './weapon-model';

interface Rocket {
  position: THREE.Vector3; velocity: THREE.Vector3; rotation: THREE.Quaternion;
  tick: number; received: number; nextSmoke: number;
  launchOffset: THREE.Vector3; launchTime: number;
}
interface Smoke {
  position: THREE.Vector3; velocity: THREE.Vector3; rotation: THREE.Quaternion;
  born: number; life: number; size: number; color: THREE.Color;
}
const FORWARD = new THREE.Vector3(0, 0, -1);

export class RocketVisuals {
  readonly ready: Promise<void>;
  private mesh: THREE.InstancedMesh | null = null;
  private readonly smokeMesh: THREE.InstancedMesh;
  private readonly sortSmoke: (camera: THREE.Camera) => void;
  private readonly rockets = new Map<number, Rocket>();
  private readonly ended = new Set<number>();
  private readonly smoke: Smoke[] = [];
  private readonly transform = new THREE.Object3D();
  private snapshotTick = -1;
  private latestTick = -1;
  private clockOffset: number | null = null;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private fogDistance = 160, private readonly capacity = 256,
    private readonly smokeCapacity = 16384, loader: () => Promise<THREE.Group> = () => loadWeaponModel('rpg')) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(smokeCapacity) || smokeCapacity < 1) throw new RangeError('Invalid rocket capacity');
    this.ready = loader().then(model => {
      const source = model.getObjectByName('RPG_rocket') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | undefined;
      const geometry = source?.geometry.clone().translate(0, 1.6, 24).scale(2 / 16, 2 / 16, 2 / 16);
      const material = source?.material.clone();
      const discarded = new Set<THREE.Material>();
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        for (const original of Array.isArray(object.material) ? object.material : [object.material]) discarded.add(original);
      });
      for (const original of discarded) original.dispose();
      if (!geometry || !material) throw new Error('RPG model has no RPG_rocket mesh');
      if (this.disposed) { geometry.dispose(); material.dispose(); return; }
      material.uniforms.fogDistance.value = this.fogDistance;
      this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
      this.mesh.name = 'UBERCUBE rockets';
      this.mesh.count = 0;
      this.mesh.frustumCulled = false;
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(this.mesh);
    });
    const smokeGeometry = new THREE.BoxGeometry(1, 1, 1);
    smokeGeometry.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(new Float32Array(smokeCapacity).fill(.7), 1));
    this.smokeMesh = new THREE.InstancedMesh(smokeGeometry, createParticleMaterial(fogDistance, true), smokeCapacity);
    this.smokeMesh.name = 'UBERCUBE rocket smoke';
    this.smokeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(smokeCapacity * 3), 3);
    this.sortSmoke = createParticleSorter(this.smokeMesh);
    this.smokeMesh.count = 0;
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.smokeMesh);
  }

  setFogDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) return;
    this.fogDistance = distance;
    for (const mesh of [this.mesh, this.smokeMesh]) if (mesh) (mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value = distance;
  }

  private observe(tick: number, now: number): void {
    if (tick < this.latestTick) return;
    this.latestTick = tick;
    const offset = now - tick / TICK_RATE;
    if (this.clockOffset === null || offset < this.clockOffset || offset - this.clockOffset > .1) this.clockOffset = offset;
  }

  private add(id: number, position: Vec3, velocity: Vec3, tick: number, now: number): void {
    if (this.ended.has(id) || !Number.isInteger(id) || id < 0
      || ![position.x, position.y, position.z, velocity.x, velocity.y, velocity.z].every(Number.isFinite)
      || Math.hypot(velocity.x, velocity.y, velocity.z) < .001) return;
    let rocket = this.rockets.get(id);
    if (rocket && tick <= rocket.tick) return;
    if (!rocket) {
      if (this.rockets.size >= this.capacity) this.remove(this.rockets.keys().next().value!);
      rocket = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), rotation: new THREE.Quaternion(), tick, received: now, nextSmoke: now,
        launchOffset: new THREE.Vector3(), launchTime: now };
      this.rockets.set(id, rocket);
    }
    rocket.position.set(position.x, position.y, position.z);
    rocket.velocity.set(velocity.x, velocity.y, velocity.z);
    rocket.rotation.setFromUnitVectors(FORWARD, rocket.velocity.clone().normalize());
    rocket.tick = tick; rocket.received = now;
  }

  private remove(id: number): void {
    this.rockets.delete(id);
    this.ended.add(id);
    if (this.ended.size > this.capacity * 2) this.ended.delete(this.ended.values().next().value!);
  }

  event(event: GameEvent, now: number, visualOrigin?: Vec3): void {
    const id = event.projectileId, tick = event.tick;
    if (this.disposed || event.weapon !== 'rpg' || typeof id !== 'number' || !Number.isInteger(id) || id < 0
      || typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0 || !Number.isFinite(now)) return;
    if (event.event === 'shot') {
      if (!event.velocity || tick <= this.snapshotTick || this.rockets.has(id) || this.ended.has(id)) return;
      // Shots precede physics; snapshots describe the end of their server tick.
      this.observe(tick - 1, now);
      this.add(id, event.position, event.velocity, tick - 1, now);
      const rocket = this.rockets.get(id);
      if (rocket && visualOrigin && [visualOrigin.x, visualOrigin.y, visualOrigin.z].every(Number.isFinite)) {
        rocket.launchOffset.set(visualOrigin.x - event.position.x, visualOrigin.y - event.position.y, visualOrigin.z - event.position.z);
        if (rocket.launchOffset.lengthSq() > 9) rocket.launchOffset.set(0, 0, 0);
      }
    } else if (event.event === 'impact' || event.event === 'explosion' || event.event === 'projectile-end') {
      if (tick < (this.rockets.get(id)?.tick ?? -1)) return;
      this.remove(id);
    }
  }

  snapshot(projectiles: readonly ProjectileState[], tick: number, now: number): void {
    if (this.disposed || !Number.isFinite(now) || !Number.isInteger(tick) || tick < 0 || tick <= this.snapshotTick) return;
    this.snapshotTick = tick;
    this.observe(tick, now);
    const present = new Set<number>();
    for (const projectile of projectiles) {
      if (projectile.weapon !== 'rpg') continue;
      present.add(projectile.id);
      this.add(projectile.id, projectile.position, projectile.velocity, tick, now);
    }
    for (const [id, rocket] of this.rockets) if (!present.has(id) && rocket.tick < tick) this.remove(id);
  }

  private project(rocket: Rocket, now: number): THREE.Vector3 {
    return this.transform.position.copy(rocket.position).addScaledVector(rocket.velocity,
      THREE.MathUtils.clamp(now - this.clockOffset! - rocket.tick / TICK_RATE, 0, 1))
      .addScaledVector(rocket.launchOffset, THREE.MathUtils.clamp(1 - (now - rocket.launchTime) / .1, 0, 1));
  }

  update(now: number, camera?: THREE.Camera): void {
    if (this.disposed || !Number.isFinite(now)) return;
    for (let index = this.smoke.length - 1; index >= 0; index--) {
      if (Math.floor((now - this.smoke[index].born) * TICK_RATE + 1e-8) > this.smoke[index].life) {
        this.smoke[index] = this.smoke.at(-1)!;
        this.smoke.pop();
      }
    }
    let count = 0;
    for (const [id, rocket] of this.rockets) {
      if (now - rocket.received > 1) { this.remove(id); continue; }
      // Skip missed frames instead of emitting an unbounded backlog after a suspended tab.
      rocket.nextSmoke = Math.max(rocket.nextSmoke, now - 5 / TICK_RATE);
      for (; rocket.nextSmoke <= now + 1e-8; rocket.nextSmoke += 1 / TICK_RATE) {
        const exhaust = this.project(rocket, rocket.nextSmoke).clone().addScaledVector(rocket.velocity, -.75 / rocket.velocity.length());
        for (let index = 0; index < 10 && this.smoke.length < this.smokeCapacity; index++) {
          const velocity = rocket.velocity.clone().normalize().multiplyScalar(-.9);
          velocity.add(new THREE.Vector3(Math.random() * .1 - .05, Math.random() * .1 - .05, Math.random() * .1 - .05));
          velocity.normalize().multiplyScalar(.9 + Math.random() * .1);
          const shade = .5 + Math.random() * .4 - .2;
          this.smoke.push({ position: exhaust.clone(), velocity,
            rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random(), Math.random(), Math.random())),
            born: rocket.nextSmoke, life: 10 + Math.floor(Math.random() * 180), size: 2 * (.02 + Math.random() * .18), color: new THREE.Color(shade, shade, shade) });
        }
      }
      this.project(rocket, now);
      this.transform.quaternion.copy(rocket.rotation);
      this.transform.scale.setScalar(1);
      this.transform.updateMatrix();
      this.mesh?.setMatrixAt(count++, this.transform.matrix);
    }
    if (this.mesh) { this.mesh.count = count; this.mesh.instanceMatrix.needsUpdate = true; }
    this.smoke.forEach((particle, index) => {
      const age = Math.max(0, (now - particle.born) * TICK_RATE);
      // Closed form of Java's 60 Hz v=(v+(0,.001,0))*.8, then p+=v.
      const drag = .8 * (1 - .8 ** age) / .2;
      this.transform.position.copy(particle.position).addScaledVector(particle.velocity, drag);
      this.transform.position.y += .004 * (age - drag);
      this.transform.quaternion.copy(particle.rotation);
      this.transform.scale.setScalar(particle.size);
      this.transform.updateMatrix();
      this.smokeMesh.setMatrixAt(index, this.transform.matrix);
      this.smokeMesh.setColorAt(index, particle.color);
    });
    this.smokeMesh.count = this.smoke.length;
    this.smokeMesh.instanceMatrix.needsUpdate = true;
    this.smokeMesh.instanceColor!.needsUpdate = true;
    if (camera) this.sortSmoke(camera);
  }

  clear(): void {
    this.rockets.clear(); this.ended.clear(); this.smoke.length = 0;
    this.latestTick = this.snapshotTick = -1; this.clockOffset = null;
    if (this.mesh) this.mesh.count = 0;
    this.smokeMesh.count = 0;
  }

  dispose(): void {
    this.clear(); this.disposed = true;
    for (const mesh of [this.mesh, this.smokeMesh]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
    }
  }
}
