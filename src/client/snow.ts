import * as THREE from 'three';
import { DT, type Vec3 } from '../shared/protocol';
import { EYE_HEIGHT } from '../shared/movement';
import type { VoxelWorld } from '../shared/voxel';
import { createParticleMaterial } from './particle-material';

const CAPACITY = 10000;
const PER_TICK = 15;
const DEFAULT_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };

export class Snow {
  readonly instance: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly stats = { activeCount: 0 };
  private readonly velocity = new Float32Array(CAPACITY * 3);
  private readonly life = new Uint16Array(CAPACITY);
  private readonly transform = new THREE.Object3D();
  private elapsed = 0;
  private enabled = false;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, fogDistance = 160) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1,
      -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6,
      4, 0, 3, 4, 3, 7, 1, 0, 4, 1, 4, 5, 3, 2, 6, 3, 6, 7]);
    const material = createParticleMaterial(fogDistance);
    this.instance = new THREE.InstancedMesh(geometry, material, CAPACITY);
    this.instance.name = 'snow';
    this.instance.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instance.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.instance.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.instance.count = 0;
    this.instance.visible = false;
    // Instance positions change every tick; GPU clipping avoids stale aggregate bounds.
    this.instance.frustumCulled = false;
    this.scene.add(this.instance);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    this.instance.visible = enabled;
    if (!enabled) this.reset();
  }

  update(dt: number, cameraPosition: Vec3, world: Pick<VoxelWorld, 'get'>, forward: Vec3 = DEFAULT_FORWARD): void {
    if (this.disposed || !this.enabled || !Number.isFinite(dt) || dt <= 0) return;
    // Cosmetics skip long background stalls instead of issuing an unbounded catch-up burst.
    this.elapsed += Math.min(dt, DT * 6);
    let changed = false;
    while (this.elapsed + 1e-10 >= DT) {
      this.elapsed = Math.max(0, this.elapsed - DT);
      this.tick(cameraPosition, world, forward);
      changed = true;
    }
    if (changed) {
      this.instance.instanceMatrix.needsUpdate = true;
      this.instance.instanceColor!.needsUpdate = true;
      this.stats.activeCount = this.instance.count;
    }
  }

  private tick(camera: Vec3, world: Pick<VoxelWorld, 'get'>, forward: Vec3): void {
    const matrices = this.instance.instanceMatrix.array;
    const colors = this.instance.instanceColor!.array;
    for (let spawned = 0; spawned < PER_TICK && this.instance.count < CAPACITY; spawned++) {
      const index = this.instance.count++, offset = index * 3;
      this.transform.position.set(camera.x + forward.x * 20 + Math.random() * 75 - 37.5,
        camera.y - EYE_HEIGHT + 15, camera.z + forward.z * 20 + Math.random() * 75 - 37.5);
      this.transform.scale.setScalar(0.01 + Math.random() * 0.09);
      const yaw = Math.random() / 2, pitch = Math.random() / 2, roll = Math.random() / 2;
      const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch), sr = Math.sin(roll), cr = Math.cos(roll);
      this.transform.quaternion.set(cr * cp * sy + sr * sp * cy, sr * cp * cy + cr * sp * sy,
        cr * sp * cy - sr * cp * sy, cr * cp * cy - sr * sp * sy).normalize();
      this.transform.updateMatrix();
      this.instance.setMatrixAt(index, this.transform.matrix);
      const shade = Math.random() * 0.1 - 0.05;
      colors[offset] = 0.8 + shade; colors[offset + 1] = 0.8 + shade; colors[offset + 2] = 0.9 + shade;
      // Particle.java adds nextInt(200): lifetime is 400..599 ticks, not a symmetric interval.
      this.life[index] = 400 + Math.floor(Math.random() * 200);
      const x = Math.random() - 0.5, y = Math.random() - 0.5, z = Math.random() - 0.5;
      const speed = Math.random() * 0.02 / (Math.hypot(x, y, z) || 1);
      this.velocity[offset] = x * speed; this.velocity[offset + 1] = y * speed; this.velocity[offset + 2] = z * speed;
    }
    for (let index = 0; index < this.instance.count;) {
      const offset = index * 3, matrix = index * 16;
      if (this.life[index] === 0) {
        const last = --this.instance.count;
        this.life[index] = this.life[last];
        this.velocity.copyWithin(offset, last * 3, last * 3 + 3);
        colors.copyWithin(offset, last * 3, last * 3 + 3);
        matrices.copyWithin(matrix, last * 16, last * 16 + 16);
        continue;
      }
      this.life[index]--;
      if (!world.get(Math.floor(matrices[matrix + 12]), Math.floor(matrices[matrix + 13]), Math.floor(matrices[matrix + 14]))) {
        this.velocity[offset + 1] -= 0.001;
        matrices[matrix + 12] += this.velocity[offset];
        matrices[matrix + 13] += this.velocity[offset + 1];
        matrices[matrix + 14] += this.velocity[offset + 2];
      }
      index++;
    }
  }

  reset(): void {
    this.elapsed = 0;
    this.instance.count = 0;
    this.stats.activeCount = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.setEnabled(false);
    this.disposed = true;
    this.scene.remove(this.instance);
    this.instance.geometry.dispose();
    this.instance.material.dispose();
    this.instance.dispose();
  }
}
