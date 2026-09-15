import * as THREE from 'three';
import type { GameEvent } from '../shared/protocol';
import { createParticleMaterial } from './particle-material';

interface Bullet {
  origin: THREE.Vector3; direction: THREE.Vector3; rotation: THREE.Quaternion;
  start: number; distance: number; rendered: boolean;
}

const TRACE_LIFETIME = .06;
const REMEMBER_SECONDS = 8;
const FORWARD = new THREE.Vector3(0, 0, 1);

export class BulletVisuals {
  private readonly mesh: THREE.InstancedMesh;
  private readonly bullets = new Map<number, Bullet>();
  private readonly seen = new Map<number, number>();
  private readonly transform = new THREE.Object3D();
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, fogDistance = 160, private readonly capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('Invalid bullet capacity');
    // Preserve the Java bullet's thickness and particle shader along the confirmed ray.
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
    const origin = event.position, end = event.endPosition;
    if (this.disposed || event.event !== 'shot' || (event.weapon !== 'ak47' && event.weapon !== 'awp')
      || !Number.isFinite(now) || typeof id !== 'number' || !Number.isInteger(id) || id < 0
      || typeof event.tick !== 'number' || !Number.isInteger(event.tick) || event.tick < 0
      || this.bullets.has(id) || this.seen.has(id) || !end
      || ![origin.x, origin.y, origin.z, end.x, end.y, end.z].every(Number.isFinite)) return;
    const direction = new THREE.Vector3(end.x - origin.x, end.y - origin.y, end.z - origin.z);
    const distance = direction.length();
    if (!Number.isFinite(distance) || distance < .001) return;
    direction.divideScalar(distance);
    if (this.bullets.size === this.capacity) this.bullets.delete(this.bullets.keys().next().value!);
    this.bullets.set(id, { origin: new THREE.Vector3(origin.x, origin.y, origin.z), direction,
      rotation: new THREE.Quaternion().setFromUnitVectors(FORWARD, direction), start: now,
      distance, rendered: false });
    this.seen.set(id, now + REMEMBER_SECONDS);
    if (this.seen.size > this.capacity * 2) this.seen.delete(this.seen.keys().next().value!);
  }

  update(now: number): void {
    if (this.disposed || !Number.isFinite(now)) return;
    for (const [id, until] of this.seen) if (now >= until) this.seen.delete(id);
    let count = 0;
    for (const [id, bullet] of this.bullets) {
      const age = Math.max(0, now - bullet.start);
      // An event received between frames still gets one frame, without simulating travel time.
      if (age >= REMEMBER_SECONDS || (bullet.rendered && age >= TRACE_LIFETIME)) {
        this.bullets.delete(id);
        continue;
      }
      this.transform.position.copy(bullet.origin).addScaledVector(bullet.direction, bullet.distance * .5);
      this.transform.quaternion.copy(bullet.rotation);
      this.transform.scale.set(1, 1, bullet.distance / .8);
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
