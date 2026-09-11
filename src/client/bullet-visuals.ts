import * as THREE from 'three';
import type { GameEvent, ProjectileState, Vec3 } from '../shared/protocol';
import { createParticleMaterial } from './particle-material';

interface Bullet {
  origin: THREE.Vector3; direction: THREE.Vector3; rotation: THREE.Quaternion;
  speed: number; start: number; tick: number; distance: number; rendered: boolean;
}

const MAX_LIFETIME = 8;
const FORWARD = new THREE.Vector3(0, 0, 1);

export class BulletVisuals {
  private readonly mesh: THREE.InstancedMesh;
  private readonly bullets = new Map<number, Bullet>();
  private readonly seen = new Map<number, number>();
  private readonly transform = new THREE.Object3D();
  private snapshotTick = -1;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, fogDistance = 160, private readonly capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid bullet capacity');
    // Java scales a cube spanning [-1, 1] by (.04, .04, .4), with the entity particle shader.
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(.08, .08, .8), createParticleMaterial(fogDistance), capacity);
    this.mesh.name = 'UBERCUBE bullets';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const yellow = new THREE.Color(1, 1, 0);
    for (let index = 0; index < capacity; index++) this.mesh.setColorAt(index, yellow);
    scene.add(this.mesh);
  }

  setFogDistance(distance: number): void {
    if (Number.isFinite(distance) && distance > 0) (this.mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value = distance;
  }

  event(event: GameEvent, now: number): void {
    const id = event.projectileId;
    if (this.disposed || !Number.isFinite(now) || !Number.isInteger(id) || id! < 0
      || !Number.isInteger(event.tick) || event.tick! < 0) return;
    if (event.event === 'shot' && (event.weapon === 'ak47' || event.weapon === 'awp') && event.velocity) {
      this.add(id!, event.position, event.velocity, event.tick!, now);
    } else if (event.event === 'impact' || event.event === 'projectile-end') {
      const bullet = this.bullets.get(id!);
      if (!bullet) { this.remember(id!, now); return; }
      if (event.tick! < bullet.tick) return;
      const dx = event.position.x - bullet.origin.x, dy = event.position.y - bullet.origin.y, dz = event.position.z - bullet.origin.z;
      const distance = dx * bullet.direction.x + dy * bullet.direction.y + dz * bullet.direction.z;
      if (Number.isFinite(distance)) bullet.distance = Math.min(bullet.distance, Math.max(0, distance));
    }
  }

  snapshot(projectiles: readonly ProjectileState[], tick: number, now: number): void {
    if (this.disposed || !Number.isFinite(now) || !Number.isInteger(tick) || tick <= this.snapshotTick) return;
    this.snapshotTick = tick;
    for (const projectile of projectiles) {
      if (projectile.weapon === 'ak47' || projectile.weapon === 'awp') {
        this.add(projectile.id, projectile.position, projectile.velocity, tick, now);
      }
    }
  }

  private add(id: number, origin: Vec3, velocity: Vec3, tick: number, now: number): void {
    if (this.bullets.has(id) || this.seen.has(id) || !Number.isInteger(id) || id < 0
      || ![origin.x, origin.y, origin.z, velocity.x, velocity.y, velocity.z].every(Number.isFinite)) return;
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    if (speed < .001) return;
    if (this.bullets.size === this.capacity) this.bullets.delete(this.bullets.keys().next().value!);
    const direction = new THREE.Vector3(velocity.x, velocity.y, velocity.z).divideScalar(speed);
    this.bullets.set(id, { origin: new THREE.Vector3(origin.x, origin.y, origin.z), direction,
      rotation: new THREE.Quaternion().setFromUnitVectors(FORWARD, direction), speed, start: now,
      tick, distance: speed * MAX_LIFETIME, rendered: false });
    this.remember(id, now);
  }

  private remember(id: number, now: number): void {
    this.seen.set(id, now + MAX_LIFETIME);
    if (this.seen.size > this.capacity * 2) this.seen.delete(this.seen.keys().next().value!);
  }

  update(now: number): void {
    if (this.disposed || !Number.isFinite(now)) return;
    for (const [id, until] of this.seen) if (now >= until) this.seen.delete(id);
    let count = 0;
    for (const [id, bullet] of this.bullets) {
      const age = Math.max(0, now - bullet.start);
      const duration = bullet.distance / bullet.speed;
      if (age >= MAX_LIFETIME || (bullet.rendered && age >= duration) || bullet.distance <= 0) {
        this.bullets.delete(id);
        continue;
      }
      // A shot and its impact can arrive between frames: show one point on their actual segment.
      const distance = age >= duration ? bullet.distance * .5 : age * bullet.speed;
      const back = Math.max(0, distance - .4), front = Math.min(bullet.distance, distance + .4);
      this.transform.position.copy(bullet.origin).addScaledVector(bullet.direction, (back + front) * .5);
      this.transform.quaternion.copy(bullet.rotation);
      this.transform.scale.set(1, 1, (front - back) / .8);
      this.transform.updateMatrix();
      this.mesh.setMatrixAt(count++, this.transform.matrix);
      bullet.rendered = true;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.bullets.clear();
    this.seen.clear();
    this.snapshotTick = -1;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
