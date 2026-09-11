import * as THREE from 'three';
import type { Vec3, VoxelEdit } from '../shared/protocol';
import { CHUNK_SIZE, VoxelWorld } from '../shared/voxel';
import type { TerrainMesh, TerrainWorkerRequest } from './terrain.worker';

interface ChunkEntry { x: number; y: number; z: number; mesh: THREE.Mesh | null; version: number }
interface WorkerSlot { worker: Worker; busy: string | null; edits: Map<number, VoxelEdit>; failures: number; failed: boolean }
const MAX_RESIDENT_CHUNKS = 2048;

export class TerrainRenderer {
  readonly stats = { chunks: 0, queued: 0, error: null as string | null };
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly entries = new Map<string, ChunkEntry>();
  private readonly versions = new Map<string, number>();
  private readonly wanted = new Map<string, { x: number; y: number; z: number }>();
  private readonly queued = new Set<string>();
  private queue: string[] = [];
  private readonly workers: WorkerSlot[] = [];
  private readonly active = new Set<string>();
  private epoch = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private disposed = false;

  constructor(private readonly scene: THREE.Scene, private world: VoxelWorld, private readonly viewDistance = 160) {
    this.startWorkers();
  }

  private startWorkers(): void {
    const count = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < count; i++) {
      const slot: WorkerSlot = { worker: new Worker('/terrain.worker.js', { type: 'module' }),
        busy: null, edits: new Map(), failures: 0, failed: false };
      this.workers.push(slot);
      this.connectWorker(slot);
    }
  }

  private connectWorker(slot: WorkerSlot): void {
    const worker = slot.worker;
    worker.onmessage = ({ data }: MessageEvent<TerrainMesh>) => {
      if (slot.worker === worker) this.receive(slot, data);
    };
    worker.onerror = event => {
      if (slot.worker !== worker || this.disposed) return;
      console.error('Terrain worker failed:', event.message);
      worker.terminate();
      if (slot.busy) { this.active.delete(slot.busy); this.enqueue(slot.busy, true); }
      slot.busy = null;
      if (slot.failures++ === 0) {
        slot.edits.clear();
        slot.worker = new Worker('/terrain.worker.js', { type: 'module' });
        this.connectWorker(slot);
      } else {
        slot.failed = true;
        this.stats.error = 'Le calcul du terrain a échoué. Rechargez la page.';
      }
      this.dispatch();
    };
    this.send(slot, { type: 'init', config: this.world.config, edits: this.world.getEdits(), epoch: this.epoch });
  }

  private send(slot: WorkerSlot, message: TerrainWorkerRequest): void { slot.worker.postMessage(message); }

  update(position: Vec3): void {
    if (this.disposed) return;
    const cx = Math.floor(position.x / CHUNK_SIZE), cz = Math.floor(position.z / CHUNK_SIZE);
    if (cx !== this.lastX || cz !== this.lastZ) {
      this.lastX = cx; this.lastZ = cz;
      const radius = Math.ceil(Math.max(16, this.viewDistance) / CHUNK_SIZE);
      const limit = Math.ceil(this.world.config.size / CHUNK_SIZE);
      const candidates: { x: number; y: number; z: number; distance: number }[] = [];
      for (let z = Math.max(0, cz - radius); z <= Math.min(limit - 1, cz + radius); z++) {
        for (let x = Math.max(0, cx - radius); x <= Math.min(limit - 1, cx + radius); x++) {
          const distance = (x * CHUNK_SIZE + 8 - position.x) ** 2 + (z * CHUNK_SIZE + 8 - position.z) ** 2;
          if (distance > (this.viewDistance + CHUNK_SIZE) ** 2) continue;
          for (let y = 0; y < Math.ceil(this.world.config.height / CHUNK_SIZE); y++) {
            candidates.push({ x, y, z, distance: distance + (y * CHUNK_SIZE + 8 - position.y) ** 2 });
          }
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      this.wanted.clear();
      this.queue = []; this.queued.clear();
      for (const chunk of candidates.slice(0, MAX_RESIDENT_CHUNKS)) {
        const key = `${chunk.x},${chunk.y},${chunk.z}`;
        this.wanted.set(key, chunk);
        if (this.entries.get(key)?.version !== (this.versions.get(key) ?? 0)) this.enqueue(key);
      }
      for (const [key, entry] of this.entries) {
        if (!this.wanted.has(key)) { this.remove(entry); this.entries.delete(key); }
      }
      for (const key of this.versions.keys()) if (!this.wanted.has(key) && !this.active.has(key)) this.versions.delete(key);
    }
    this.dispatch();
    this.stats.chunks = this.sceneChunkCount();
    this.stats.queued = this.queued.size + this.active.size;
  }

  private enqueue(key: string, urgent = false): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    if (urgent) this.queue.unshift(key);
    else this.queue.push(key);
  }

  private dispatch(): void {
    for (const slot of this.workers) {
      if (slot.busy || slot.failed) continue;
      while (this.queue.length) {
        const key = this.queue.shift()!;
        this.queued.delete(key);
        const chunk = this.wanted.get(key);
        if (!chunk || this.active.has(key)) continue;
        slot.busy = key; this.active.add(key);
        if (slot.edits.size) {
          this.send(slot, { type: 'edits', edits: Array.from(slot.edits.values()), epoch: this.epoch });
          slot.edits.clear();
        }
        this.send(slot, { type: 'mesh', x: chunk.x, y: chunk.y, z: chunk.z,
          version: this.versions.get(key) ?? 0, epoch: this.epoch });
        break;
      }
    }
  }

  private receive(slot: WorkerSlot, result: TerrainMesh): void {
    if (this.disposed || result.epoch !== this.epoch) return;
    const key = `${result.x},${result.y},${result.z}`;
    this.active.delete(key); slot.busy = null;
    if (this.wanted.has(key)) {
      if (result.version !== (this.versions.get(key) ?? 0)) this.enqueue(key, true);
      else {
        const previous = this.entries.get(key);
        if (previous) this.remove(previous);
        let mesh: THREE.Mesh | null = null;
        if (result.indices.length) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
          geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3, true));
          geometry.setAttribute('color', new THREE.BufferAttribute(result.colors, 3, true));
          geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
          geometry.computeBoundingSphere();
          mesh = new THREE.Mesh(geometry, this.material);
          mesh.position.set(result.x * CHUNK_SIZE, result.y * CHUNK_SIZE, result.z * CHUNK_SIZE);
          this.scene.add(mesh);
        }
        this.entries.set(key, { x: result.x, y: result.y, z: result.z, mesh, version: result.version });
      }
    }
    this.stats.chunks = this.sceneChunkCount();
    this.stats.queued = this.queued.size + this.active.size;
    this.dispatch();
  }

  applyEdits(edits: VoxelEdit[]): void {
    if (this.disposed || !edits.length) return;
    this.world.applyEdits(edits);
    const size = this.world.config.size;
    for (const slot of this.workers) {
      for (const edit of edits) slot.edits.set(edit[0] + size * (edit[2] + size * edit[1]), edit);
    }
    const dirty = new Set<string>();
    for (const [x, y, z] of edits) {
      for (let cz = Math.floor((z - 1) / CHUNK_SIZE); cz <= Math.floor((z + 1) / CHUNK_SIZE); cz++) {
        for (let cy = Math.floor((y - 1) / CHUNK_SIZE); cy <= Math.floor((y + 1) / CHUNK_SIZE); cy++) {
          for (let cx = Math.floor((x - 1) / CHUNK_SIZE); cx <= Math.floor((x + 1) / CHUNK_SIZE); cx++) dirty.add(`${cx},${cy},${cz}`);
        }
      }
    }
    for (const key of dirty) {
      if (!this.wanted.has(key) && !this.active.has(key)) continue;
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
      if (this.wanted.has(key)) this.enqueue(key, true);
    }
    this.dispatch();
  }

  private sceneChunkCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.mesh) count++;
    return count;
  }

  private remove(entry: ChunkEntry): void {
    if (!entry.mesh) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
  }

  reset(world: VoxelWorld): void {
    for (const slot of this.workers) slot.worker.terminate();
    this.workers.length = 0;
    for (const entry of this.entries.values()) this.remove(entry);
    this.entries.clear(); this.wanted.clear(); this.versions.clear();
    this.queue = []; this.queued.clear(); this.active.clear();
    this.world = world; this.epoch++;
    this.lastX = NaN; this.lastZ = NaN;
    this.stats.chunks = 0; this.stats.queued = 0;
    this.stats.error = null;
    if (!this.disposed) this.startWorkers();
  }

  dispose(): void {
    this.disposed = true;
    this.reset(this.world);
    this.material.dispose();
  }
}
