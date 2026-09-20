import * as THREE from 'three';
import type { GameEvent, PlayerState, ProjectileState, Vec3 } from '../shared/protocol';
import type { GrenadeFlight } from '../shared/grenade';
import type { VoxelWorld } from '../shared/voxel';
import { createParticleMaterial, particleColor, type ParticleEvent } from './particle-material';
import { BulletVisuals } from './bullet-visuals';
import { GrenadeVisuals } from './grenade-visuals';

interface Particle { position: THREE.Vector3; velocity: THREE.Vector3; life: number; maxLife: number; color: THREE.Color; size: number }

export class Effects {
  readonly ready: Promise<void>;
  private readonly particles: Particle[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly bullets: BulletVisuals;
  private readonly grenades: GrenadeVisuals;
  private readonly transform = new THREE.Object3D();

  constructor(scene: THREE.Scene, fogDistance = 160, grenadeLoader?: () => Promise<THREE.Group>) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), createParticleMaterial(fogDistance), 384);
    this.mesh.name = 'UBERCUBE impact particles';
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(384 * 3), 3);
    this.bullets = new BulletVisuals(scene, fogDistance);
    this.grenades = new GrenadeVisuals(scene, fogDistance, 256, grenadeLoader);
    this.ready = this.grenades.ready;
    this.mesh.frustumCulled = false; this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(this.mesh);
  }

  setFogDistance(distance: number): void {
    if (Number.isFinite(distance) && distance > 0) (this.mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value = distance;
    this.bullets.setFogDistance(distance);
    this.grenades.setFogDistance(distance);
  }

  snapshot(projectiles: readonly ProjectileState[], tick: number, now: number): void {
    this.grenades.snapshot(projectiles, tick, now);
  }

  predictGrenade(owner: number, seq: number, launch: GrenadeFlight, world: VoxelWorld, now: number): void {
    this.grenades.predict(owner, seq, launch, world, now);
  }

  availableGrenades(player: PlayerState): number {
    return Math.max(0, player.grenades - this.grenades.pendingThrows(player.id, player.lastSeq));
  }

  acknowledgeInputs(player: PlayerState): void { this.grenades.acknowledge(player.id, player.lastSeq, player.alive); }

  event(event: GameEvent, now: number): void {
    this.bullets.event(event, now);
    this.grenades.event(event, now);
    this.emitParticles(event);
  }

  blood(position: Vec3): void { this.emitParticles({ event: 'blood', position }); }

  private emitParticles(event: ParticleEvent & { position: Vec3 }): void {
    const count = event.event === 'explosion' ? 65 : event.event === 'death' ? 16 : 8;
    for (let i = 0; i < count && this.particles.length < 384; i++) {
      const force = event.event === 'explosion' ? 11 : 4;
      const color = particleColor(event, Math.random());
      if (!color) return;
      const maxLife = 0.3 + Math.random() * (event.event === 'explosion' ? 1.5 : 0.65);
      this.particles.push({ position: new THREE.Vector3(event.position.x, event.position.y, event.position.z), velocity: new THREE.Vector3((Math.random() - 0.5) * force, Math.random() * force, (Math.random() - 0.5) * force), life: maxLife, maxLife, color, size: event.event === 'explosion' ? 0.12 + Math.random() * 0.2 : 0.07 + Math.random() * 0.09 });
    }
  }

  update(dt: number, time: number): void {
    this.bullets.update(time);
    this.grenades.update(time);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.life -= dt;
      if (particle.life <= 0) { this.particles.splice(i, 1); continue; }
      particle.velocity.y -= dt * 13;
      particle.position.addScaledVector(particle.velocity, dt);
    }
    this.particles.forEach((particle, index) => {
      this.transform.position.copy(particle.position);
      this.transform.rotation.set(time * 2 + index, time + index, 0);
      this.transform.scale.setScalar(particle.size * Math.min(1, particle.life * 4));
      this.transform.updateMatrix();
      this.mesh.setMatrixAt(index, this.transform.matrix);
      this.mesh.setColorAt(index, particle.color);
    });
    this.mesh.count = this.particles.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void { this.particles.length = 0; this.bullets.clear(); this.grenades.clear(); this.update(0, 0); }
}

export class GameAudio {
  private context: AudioContext | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Set<string>();
  private active = 0;
  private enabled = true;
  private volume = 1;

  activate(): void {
    this.context ??= new AudioContext();
    void this.context.resume();
    for (const file of ['AK47Shoot', 'AWPShoot', 'dig', 'place', 'waterexplode', 'playerhit', 'footstep1', 'footstep2', 'jump', 'land']) void this.load(file);
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  setVolume(volume: number): void { this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1; }

  private async load(file: string): Promise<void> {
    if (!this.context || this.buffers.has(file) || this.pending.has(file)) return;
    this.pending.add(file);
    try {
      const response = await fetch(`/assets/audio/${file}.wav`);
      if (response.ok) this.buffers.set(file, await this.context.decodeAudioData(await response.arrayBuffer()));
    } catch { /* Audio failure does not interrupt the session. */ }
    finally { this.pending.delete(file); }
  }

  play(file: string, origin?: Vec3, listener?: Vec3, yaw = 0, volume = 0.36): void {
    if (!this.context || this.context.state !== 'running' || !this.enabled || this.active > 30) return;
    const buffer = this.buffers.get(file);
    if (!buffer) { void this.load(file); return; }
    const source = this.context.createBufferSource(); source.buffer = buffer;
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    let attenuation = 1;
    if (origin && listener) {
      const dx = origin.x - listener.x; const dz = origin.z - listener.z;
      const distance = Math.hypot(dx, origin.y - listener.y, dz);
      if (distance > 180) return;
      attenuation = 1 / (1 + distance * 0.075);
      pan.pan.value = Math.max(-0.85, Math.min(0.85, (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / Math.max(1, distance)));
    }
    gain.gain.value = volume * attenuation * this.volume / 50;
    source.connect(gain).connect(pan).connect(this.context.destination);
    this.active++;
    source.onended = () => { this.active--; source.disconnect(); gain.disconnect(); pan.disconnect(); };
    source.start();
  }
}
