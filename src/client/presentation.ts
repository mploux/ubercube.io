import * as THREE from 'three';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { GameEvent, PlayerState, ProjectileState, Vec3, WeaponId } from '../shared/protocol';

export const teamColor = (team: number): string => team === 1 ? '#ff776a' : team === 2 ? '#78b9ed' : '#ffaf61';

const modelFiles: Record<WeaponId, string> = {
  ak47: 'ak47/AK47', awp: 'awp/AWP', shovel: 'shovel/SHOVEL',
  grenade: 'grenade/GRENADE', medic: 'medicbag/MEDICBAG',
};

export class WeaponView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(48, 1, 0.01, 20);
  private readonly root = new THREE.Group();
  private readonly models = new Map<WeaponId, THREE.Group>();
  private current: WeaponId = 'ak47';
  private recoil = 0;
  private moving = 0;
  private readonly bounds = new THREE.Box3();
  private readonly size = new THREE.Vector3();

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x788169, 2.5));
    const key = new THREE.DirectionalLight(0xffe4c5, 3.4);
    key.position.set(-3, 5, 4);
    const fill = new THREE.DirectionalLight(0xe4f2ff, 1.5);
    fill.position.set(3, 2, 2);
    this.scene.add(key, fill, this.root);
    this.setWeapon('ak47');
    for (const weapon of Object.keys(modelFiles) as WeaponId[]) void this.load(weapon);
  }

  private async load(weapon: WeaponId): Promise<void> {
    const path = `/assets/weapons/${modelFiles[weapon]}`;
    try {
      const materials = await new MTLLoader().loadAsync(`${path}.mtl`);
      materials.preload();
      const model = await new OBJLoader().setMaterials(materials).loadAsync(`${path}.obj`);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      const length = weapon === 'ak47' || weapon === 'awp' ? 1.5 : weapon === 'shovel' ? 1.2 : 0.55;
      const scale = length / Math.max(size.x, size.y, size.z);
      model.position.copy(center).multiplyScalar(-scale);
      model.scale.setScalar(scale);
      const adjusted = new Set<THREE.Material>();
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (adjusted.has(material)) continue;
            adjusted.add(material);
            material.side = THREE.DoubleSide;
            if (material instanceof THREE.MeshPhongMaterial) {
              // Preserve the legacy diffuse values under the linear lighting pipeline.
              material.color.convertLinearToSRGB();
              material.shininess = 24;
            }
          }
        }
      });
      const wrapper = new THREE.Group();
      wrapper.add(model);
      this.models.set(weapon, wrapper);
      if (this.current === weapon) this.setWeapon(weapon);
    } catch {
      // The temporary mesh keeps the game usable when an asset fails to load.
    }
  }

  setWeapon(weapon: WeaponId): void {
    this.current = weapon;
    for (const child of this.root.children) {
      if (child.userData.fallback && child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    this.root.clear();
    const model = this.models.get(weapon);
    if (model) this.root.add(model);
    else {
      const fallback = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.8), new THREE.MeshStandardMaterial({ color: 0x46513e }));
      fallback.userData.fallback = true;
      this.root.add(fallback);
    }
  }

  kick(): void { this.recoil = 1; }

  render(renderer: THREE.WebGLRenderer, time: number, dt: number, lobby: boolean, moving: number, zoom: boolean): void {
    this.camera.aspect = renderer.domElement.clientWidth / renderer.domElement.clientHeight;
    this.camera.updateProjectionMatrix();
    this.recoil = Math.max(0, this.recoil - dt * 8);
    this.moving = THREE.MathUtils.damp(this.moving, moving, 8, dt);
    if (lobby) {
      const distance = 2.8;
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * distance;
      const halfWidth = halfHeight * this.camera.aspect;
      const narrow = renderer.domElement.clientWidth < 731;
      this.root.position.set(0, 0, 0);
      this.root.scale.setScalar(1);
      this.root.rotation.set(0.06 + Math.sin(time * 0.3) * 0.025, -1.2 + Math.sin(time * 0.2) * 0.12, -0.08);
      this.bounds.setFromObject(this.root).getSize(this.size);
      const widthScale = halfWidth * 2 * (narrow ? 0.46 : 0.36) / Math.max(0.1, this.size.x);
      const heightScale = halfHeight * 0.5 / Math.max(0.1, this.size.y);
      this.root.scale.setScalar(Math.min(1.15, widthScale, heightScale));
      this.root.position.set(halfWidth * 0.4, halfHeight * 0.2, -distance);
    } else {
      const gun = this.current === 'ak47' || this.current === 'awp';
      this.root.position.set(zoom && gun ? 0 : 0.31, zoom && gun ? -0.25 : -0.32, -0.92 + this.recoil * 0.075);
      this.root.position.y += Math.sin(time * 11) * 0.015 * Math.min(1, this.moving / 5);
      this.root.position.x += Math.cos(time * 5.5) * 0.012 * Math.min(1, this.moving / 5);
      this.root.rotation.set(-this.recoil * 0.08, Math.PI, gun ? 0 : -0.12);
      this.root.scale.setScalar(gun ? 0.77 : 0.6);
    }
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}

interface Part { mesh: THREE.InstancedMesh; position: THREE.Vector3; scale: THREE.Vector3; limb: number }

export class PlayerVisuals {
  private readonly group = new THREE.Group();
  private readonly parts: Part[] = [];
  private readonly names = new Map<number, THREE.Sprite>();
  private readonly transform = new THREE.Object3D();
  private readonly base = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private capacity = 0;

  constructor(scene: THREE.Scene) { scene.add(this.group); }

  private allocate(capacity: number): void {
    for (const part of this.parts) { this.group.remove(part.mesh); part.mesh.geometry.dispose(); (part.mesh.material as THREE.Material).dispose(); }
    this.parts.length = 0;
    this.capacity = Math.max(100, capacity);
    const parts = [
      { p: [0, 1.54, 0], s: [0.76, 0.88, 0.44], limb: 0, color: 0xc5cdad },
      { p: [0, 2.36, 0], s: [0.57, 0.58, 0.54], limb: 0, color: 0xe3c8a3 },
      { p: [0, 2.64, 0.01], s: [0.65, 0.2, 0.62], limb: 0, color: 0xa3af80 },
      { p: [0, 2.39, -0.282], s: [0.43, 0.15, 0.04], limb: 0, color: 0x202d2c },
      { p: [-0.205, 0.61, 0], s: [0.31, 1.14, 0.37], limb: 1, color: 0x3e4d3f },
      { p: [0.205, 0.61, 0], s: [0.31, 1.14, 0.37], limb: -1, color: 0x3e4d3f },
      { p: [-0.49, 1.61, -0.08], s: [0.27, 0.8, 0.28], limb: -2, color: 0xaab691 },
      { p: [0.49, 1.61, -0.08], s: [0.27, 0.8, 0.28], limb: 2, color: 0xaab691 },
      { p: [0.32, 1.58, -0.43], s: [0.12, 0.16, 0.7], limb: 0, color: 0x25312c },
    ];
    for (const spec of parts) {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: spec.color }), this.capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.parts.push({ mesh, position: new THREE.Vector3(...spec.p), scale: new THREE.Vector3(...spec.s), limb: spec.limb });
      this.group.add(mesh);
    }
  }

  update(players: PlayerState[], localId: number, time: number, camera: THREE.Camera): void {
    const visible = players.filter((player) => player.id !== localId && player.alive);
    if (this.capacity < visible.length || this.capacity === 0) this.allocate(visible.length);
    const aliveIds = new Set(visible.map((player) => player.id));
    for (const [id, sprite] of this.names) {
      if (!aliveIds.has(id)) {
        this.group.remove(sprite);
        sprite.material.map?.dispose();
        sprite.material.dispose();
        this.names.delete(id);
      }
    }
    visible.forEach((player, index) => {
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      const walk = Math.sin(time * 11 + player.id) * Math.min(0.6, speed * 0.08);
      this.base.position.set(player.position.x, player.position.y, player.position.z);
      this.base.rotation.set(0, player.yaw, 0);
      this.base.updateMatrix();
      this.parts.forEach((part, partIndex) => {
        this.transform.position.copy(part.position);
        this.transform.scale.copy(part.scale);
        this.transform.rotation.set(part.limb === 0 ? 0 : part.limb * walk * (Math.abs(part.limb) === 2 ? 0.3 : 1), 0, 0);
        this.transform.updateMatrix();
        this.transform.matrix.premultiply(this.base.matrix);
        part.mesh.setMatrixAt(index, this.transform.matrix);
        if (partIndex === 0 || partIndex === 2) part.mesh.setColorAt(index, this.color.set(teamColor(player.team)));
      });
      let name = this.names.get(player.id);
      if (!name) {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 40;
        const ctx = canvas.getContext('2d')!;
        ctx.font = '600 19px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = '#142016'; ctx.shadowBlur = 5;
        ctx.fillStyle = '#ffffff'; ctx.fillText(player.name, 128, 20, 246);
        const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: true, depthWrite: false });
        name = new THREE.Sprite(material);
        this.names.set(player.id, name); this.group.add(name);
      }
      name.position.set(player.position.x, player.position.y + 3.04, player.position.z);
      const distance = camera.position.distanceTo(name.position);
      name.visible = distance < 85;
      name.scale.set(2.4, 0.375, 1);
      name.material.opacity = Math.min(1, Math.max(0, (85 - distance) / 20));
    });
    for (const part of this.parts) {
      part.mesh.count = visible.length;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void { this.update([], -1, 0, new THREE.Camera()); }
}

interface Particle { position: THREE.Vector3; velocity: THREE.Vector3; life: number; maxLife: number; color: THREE.Color; size: number }

export class Effects {
  private readonly particles: Particle[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly bulletMesh: THREE.InstancedMesh;
  private readonly grenadeMesh: THREE.InstancedMesh;
  private readonly transform = new THREE.Object3D();
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly direction = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), 384);
    this.bulletMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.035, 0.8), new THREE.MeshBasicMaterial({ color: 0xffd38d }), 1024);
    this.grenadeMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 0.32, 0.24), new THREE.MeshLambertMaterial({ color: 0x566646 }), 256);
    for (const mesh of [this.mesh, this.bulletMesh, this.grenadeMesh]) { mesh.frustumCulled = false; mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh); }
  }

  event(event: GameEvent): void {
    if (event.event === 'shot') return;
    const count = event.event === 'explosion' ? 65 : event.event === 'death' ? 16 : 8;
    for (let i = 0; i < count && this.particles.length < 384; i++) {
      const force = event.event === 'explosion' ? 11 : 4;
      const color = event.event === 'heal' ? 0xaeea8c : event.event === 'death' || event.targetId ? 0xb05546 : event.event === 'explosion' ? (i % 2 ? 0xf79a4a : 0x524a36) : 0x9c9a73;
      const maxLife = 0.3 + Math.random() * (event.event === 'explosion' ? 1.5 : 0.65);
      this.particles.push({ position: new THREE.Vector3(event.position.x, event.position.y, event.position.z), velocity: new THREE.Vector3((Math.random() - 0.5) * force, Math.random() * force, (Math.random() - 0.5) * force), life: maxLife, maxLife, color: new THREE.Color(color), size: event.event === 'explosion' ? 0.12 + Math.random() * 0.2 : 0.07 + Math.random() * 0.09 });
    }
  }

  update(dt: number, projectiles: ProjectileState[], time: number): void {
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
    let bullets = 0; let grenades = 0;
    for (const projectile of projectiles) {
      const grenade = projectile.weapon === 'grenade';
      if (grenade ? grenades >= 256 : bullets >= 1024) continue;
      this.transform.position.set(projectile.position.x, projectile.position.y, projectile.position.z);
      this.transform.scale.setScalar(1);
      this.direction.set(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z).normalize();
      if (grenade) this.transform.rotation.set(time * 3, time * 2 + projectile.id, 0);
      else this.transform.quaternion.setFromUnitVectors(this.forward, this.direction);
      this.transform.updateMatrix();
      if (grenade) this.grenadeMesh.setMatrixAt(grenades++, this.transform.matrix);
      else this.bulletMesh.setMatrixAt(bullets++, this.transform.matrix);
    }
    this.bulletMesh.count = bullets; this.grenadeMesh.count = grenades;
    this.bulletMesh.instanceMatrix.needsUpdate = true; this.grenadeMesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void { this.particles.length = 0; this.update(0, [], 0); }
}

export class GameAudio {
  private context: AudioContext | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Set<string>();
  private active = 0;
  private enabled = true;

  activate(): void {
    this.context ??= new AudioContext();
    void this.context.resume();
    for (const file of ['AK47Shoot', 'AWPShoot', 'dig', 'place', 'waterexplode', 'playerhit', 'footstep1', 'footstep2', 'jump', 'land']) void this.load(file);
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

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
    gain.gain.value = volume * attenuation;
    source.connect(gain).connect(pan).connect(this.context.destination);
    this.active++;
    source.onended = () => { this.active--; source.disconnect(); gain.disconnect(); pan.disconnect(); };
    source.start();
  }
}
