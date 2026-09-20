import * as THREE from 'three';
import { PLAYER_HEIGHT } from '../shared/movement';
import type { GameEvent, PlayerState, Vec3, VoxelEdit, WeaponId } from '../shared/protocol';
import type { VoxelWorld } from '../shared/voxel';
import { loadWeaponModel } from './weapon-model';
import { Ragdolls } from './ragdolls';

const BONES = [
  { name: 'body', parent: -1, position: [0, -.15, 0], size: [.65, 1.1, .3], color: [6, 46, 6] },
  { name: 'head', parent: 0, position: [0, 1.15, 0], size: [.5, .5, .5], color: [208, 164, 134] },
  { name: 'left upper arm', parent: 0, position: [-.35, 1, 0], size: [.25, .5, .25], color: [3, 34, 3] },
  { name: 'left forearm', parent: 2, position: [0, .5, 0], size: [.2, .5, .2], color: [208, 164, 134] },
  { name: 'right upper arm', parent: 0, position: [.35, 1, 0], size: [.25, .5, .25], color: [3, 34, 3] },
  { name: 'right forearm', parent: 4, position: [0, .5, 0], size: [.2, .5, .2], color: [208, 164, 134] },
  { name: 'left thigh', parent: 0, position: [-.2, 0, 0], size: [.3, .65, .3], color: [3, 34, 3] },
  { name: 'left shin', parent: 6, position: [0, .65, 0], size: [.3, .65, .3], color: [3, 34, 3] },
  { name: 'right thigh', parent: 0, position: [.2, 0, 0], size: [.3, .65, .3], color: [3, 34, 3] },
  { name: 'right shin', parent: 8, position: [0, .65, 0], size: [.3, .65, .3], color: [3, 34, 3] },
] as const;
const WEAPONS: WeaponId[] = ['ak47', 'awp', 'shovel', 'grenade', 'medic'];
const DEGREES = Math.PI / 180;
const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

export class PlayerVisuals {
  readonly ready: Promise<void>;
  private readonly group = new THREE.Group();
  private readonly root = new THREE.Object3D();
  private readonly bones = BONES.map(spec => {
    const node = new THREE.Object3D();
    node.name = spec.name;
    node.position.set(spec.position[0], spec.position[1], spec.position[2]);
    return node;
  });
  private readonly sizes = BONES.map(spec => new THREE.Vector3(...spec.size));
  private readonly colors = BONES.map(spec => new THREE.Color().setRGB(spec.color[0] / 255, spec.color[1] / 255, spec.color[2] / 255));
  private body: THREE.InstancedMesh;
  private readonly weapons = new Map<WeaponId, THREE.InstancedMesh[]>();
  private readonly names = new Map<number, THREE.Sprite>();
  private readonly aliveIds = new Set<number>();
  private readonly lastPoses = new Map<number, { matrices: THREE.Matrix4[]; position: THREE.Vector3; yaw: number; deaths: number }>();
  private readonly deathCounts = new Map<number, number>();
  private readonly corpseShots = new Map<number, number>();
  private ragdolls: Ragdolls | null = null;
  private lastTime: number | null = null;
  private readonly transform = new THREE.Object3D();
  private readonly matrix = new THREE.Matrix4();
  private readonly leftHand = new THREE.Vector3();
  private readonly rightHand = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private capacity = 100;
  private fontReady = false;

  constructor(scene: THREE.Scene, private fogDistance = 160, loader: (weapon: WeaponId) => Promise<THREE.Group> = loadWeaponModel) {
    this.group.name = 'UBERCUBE Java players';
    scene.add(this.group);
    for (let i = 0; i < BONES.length; i++) {
      const parent = BONES[i].parent;
      (parent < 0 ? this.root : this.bones[parent]).add(this.bones[i]);
    }
    const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, .5, 0);
    const normals = geometry.getAttribute('normal');
    const shades = new Float32Array(normals.count);
    for (let i = 0; i < shades.length; i++) {
      shades[i] = normals.getY(i) > 0 ? 1 : normals.getY(i) < 0 ? .6 : normals.getX(i) !== 0 ? .7 : .8;
    }
    geometry.setAttribute('legacyShade', new THREE.BufferAttribute(shades, 1));
    const material = new THREE.ShaderMaterial({
      name: 'UBERCUBE Java player palette', toneMapped: false,
      uniforms: { fogDistance: { value: fogDistance } },
      vertexShader: `
        attribute float legacyShade;
        varying vec3 legacyColor;
        varying vec3 worldPosition;
        void main() {
          legacyColor = instanceColor * legacyShade;
          vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
          worldPosition = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform float fogDistance;
        varying vec3 legacyColor;
        varying vec3 worldPosition;
        void main() {
          float fog = clamp(distance(cameraPosition, worldPosition) / fogDistance * 2.0 - 0.8, 0.0, 1.0);
          gl_FragColor = vec4(mix(legacyColor, vec3(221.0, 232.0, 255.0) / 255.0, fog), 1.0);
        }
      `,
    });
    this.body = this.createInstances(geometry, material, this.capacity * BONES.length, 'UBERCUBE articulated bodies');
    this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * BONES.length * 3), 3);
    if (typeof document !== 'undefined') {
      void document.fonts.load('30px Riffic').then(fonts => { this.fontReady = fonts.length > 0; }).catch(() => {});
    }
    this.ready = Promise.all(WEAPONS.map(async weapon => {
      const model = await loader(weapon);
      model.updateMatrixWorld(true);
      const meshes: THREE.InstancedMesh[] = [];
      model.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const material = object.material as THREE.ShaderMaterial;
        material.uniforms.fogDistance.value = this.fogDistance;
        // Java's camera looks along +Z; reflecting the asset preserves hand placement in Three's -Z view.
        const positions = object.geometry.getAttribute('position');
        positions.applyMatrix4(object.matrixWorld);
        // The legacy weapon shader shades the original local normals, including on reflected viewmodels.
        for (let i = 0; i < positions.count; i++) positions.setZ(i, -positions.getZ(i));
        meshes.push(this.createInstances(object.geometry, material, this.capacity, `UBERCUBE remote ${weapon}`));
      });
      this.weapons.set(weapon, meshes);
    })).then(() => {});
  }

  private createInstances(geometry: THREE.BufferGeometry, material: THREE.Material, count: number, name: string): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  private pose(index: number, x: number, y = 0, z = 0): void {
    // Quat.deuler(x,y,z) uses YZX with its second/third axes exchanged, then Z is reflected.
    this.bones[index].rotation.set(-x * DEGREES, -z * DEGREES, y * DEGREES, 'YZX');
  }

  private updatePose(player: PlayerState, time: number): void {
    this.root.position.set(player.position.x, player.position.y + PLAYER_HEIGHT / 2, player.position.z);
    this.root.rotation.set(0, player.yaw, 0);
    // Java measured displacement every five 60 Hz ticks, multiplied by 1.5 for the skeleton.
    const movement = Math.hypot(player.velocity.x, player.velocity.z) * 5 / 60 * 1.5;
    const frames = time * 60;
    const arm = Math.sin(frames * .1) * 10 * movement;
    const speed = movement > .7 ? 1 : .65;
    const legSin = Math.sin(frames * .15 * speed) * 40 * movement;
    const legCos = Math.cos(frames * .15 * speed) * 40 * movement;
    const view = Math.sin(player.pitch) * 90;
    const firearm = player.weapon === 'ak47' || player.weapon === 'awp';
    const aiming = firearm && player.aiming;
    this.pose(1, -view);
    this.pose(2, arm + (firearm ? 160 : 185) - view * (aiming ? 1 : .4) - (aiming ? 72.5 : 0), firearm ? 0 : -5, firearm ? (aiming ? -10 : 20) : 0);
    this.pose(3, -arm - (firearm ? 60 : 10) - (aiming ? 10 : 0), 0, aiming ? -70 : 0);
    this.pose(4, -arm + (firearm ? 210 : 160) - view * (aiming ? 1 : .2) - (aiming ? 105 : 0), firearm ? 0 : 5, firearm && !aiming ? -20 : 0);
    this.pose(5, arm - (firearm ? 140 : 90) + (aiming ? 40 : 0), 0, aiming ? 50 : 0);
    this.pose(6, 180 + legSin - 10 * movement, -3);
    this.pose(7, 40 * movement - legCos);
    this.pose(8, 180 - legSin - 10 * movement, 3);
    this.pose(9, 40 * movement + legCos);
    this.root.updateMatrixWorld(true);
  }

  setFogDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) return;
    this.fogDistance = distance;
    (this.body.material as THREE.ShaderMaterial).uniforms.fogDistance.value = distance;
    for (const meshes of this.weapons.values()) {
      for (const mesh of meshes) (mesh.material as THREE.ShaderMaterial).uniforms.fogDistance.value = distance;
    }
  }

  setWorld(world: Pick<VoxelWorld, 'get' | 'config'>): void {
    this.clear();
    this.ragdolls = new Ragdolls(world);
  }

  applyEdits(edits: readonly VoxelEdit[]): void { this.ragdolls?.applyEdits(edits); }

  shot(event: GameEvent, time: number): Vec3 | null {
    const id = event.projectileId;
    if (!this.ragdolls || event.event !== 'shot' || (event.weapon !== 'ak47' && event.weapon !== 'awp')
      || !event.endPosition || !Number.isFinite(time) || typeof id !== 'number' || !Number.isInteger(id) || id < 0
      || this.corpseShots.has(id)) return null;
    this.corpseShots.set(id, time + 8);
    if (this.corpseShots.size > 2048) this.corpseShots.delete(this.corpseShots.keys().next().value!);
    // Corpses remain cosmetic; the confirmed endpoint stops this reaction at terrain or a living player.
    return this.ragdolls.hit(event.position, event.endPosition, event.weapon === 'awp' ? 80 : 48, time);
  }

  death(event: GameEvent, fallback: PlayerState | undefined, time: number): void {
    const player = event.death?.player ?? fallback;
    if (!this.ragdolls || event.event !== 'death' || !player || player.id !== event.targetId) return;
    const deaths = event.death?.player.deaths ?? player.deaths + (player.alive ? 1 : 0);
    if (deaths <= (this.deathCounts.get(player.id) ?? -1)) return;
    this.deathCounts.set(player.id, deaths);
    const cached = this.lastPoses.get(player.id);
    const useCached = cached && cached.deaths === deaths - 1 && cached.position.distanceTo(player.position) < 15;
    if (!useCached) this.updatePose(player, time);
    const hit = event.death?.hitPoint ?? { ...event.position, y: event.position.y + PLAYER_HEIGHT * .65 };
    const point = new THREE.Vector3(hit.x, hit.y, hit.z);
    if (useCached) {
      // Match the visible interpolated body while keeping the projectile's world-space impulse.
      point.sub(player.position).applyAxisAngle(UP, cached.yaw - player.yaw).add(cached.position);
    }
    this.ragdolls.spawn(BONES.map((spec, i) => ({ parent: spec.parent, size: spec.size,
      matrix: useCached ? cached.matrices[i] : this.bones[i].matrixWorld })), player.velocity, point,
      event.death?.impulse ?? { x: 0, y: 0, z: 0 }, time);
  }

  update(players: PlayerState[], localId: number, time: number, camera: THREE.Camera): void {
    for (const [id, until] of this.corpseShots) if (time >= until) this.corpseShots.delete(id);
    this.ragdolls?.update(this.lastTime === null ? 0 : Math.max(0, Math.min(.1, time - this.lastTime)), time);
    this.lastTime = time;
    const present = new Set(players.map(player => player.id));
    for (const id of this.lastPoses.keys()) if (!present.has(id)) this.lastPoses.delete(id);
    for (const id of this.deathCounts.keys()) if (!present.has(id)) this.deathCounts.delete(id);
    this.aliveIds.clear();
    let visible = this.ragdolls?.poses.length ?? 0;
    for (const player of players) {
      if (player.id !== localId && player.alive && player.deaths >= (this.deathCounts.get(player.id) ?? 0)) visible++;
    }
    if (visible > this.capacity) {
      this.capacity = Math.max(visible, this.capacity * 2);
      this.body.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * BONES.length * 16), 16).setUsage(THREE.DynamicDrawUsage);
      this.body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * BONES.length * 3), 3);
      for (const meshes of this.weapons.values()) {
        for (const mesh of meshes) mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
      }
    }
    this.body.count = 0;
    for (const meshes of this.weapons.values()) for (const mesh of meshes) mesh.count = 0;
    for (const player of players) {
      if (player.id === localId || !player.alive || player.deaths < (this.deathCounts.get(player.id) ?? 0)) continue;
      this.aliveIds.add(player.id);
      this.updatePose(player, time);
      let cached = this.lastPoses.get(player.id);
      if (!cached) {
        cached = { matrices: BONES.map(() => new THREE.Matrix4()), position: new THREE.Vector3(), yaw: 0, deaths: 0 };
        this.lastPoses.set(player.id, cached);
      }
      cached.position.copy(player.position); cached.yaw = player.yaw; cached.deaths = player.deaths;
      for (let i = 0; i < BONES.length; i++) {
        cached.matrices[i].copy(this.bones[i].matrixWorld);
        this.matrix.copy(this.bones[i].matrixWorld).scale(this.sizes[i]);
        this.body.setMatrixAt(this.body.count, this.matrix);
        this.body.setColorAt(this.body.count++, this.colors[i]);
      }
      const weaponMeshes = this.weapons.get(player.weapon);
      if (weaponMeshes?.length && (player.weapon !== 'grenade' || player.grenades > 0)) {
        this.rightHand.set(0, .5, 0).applyMatrix4(this.bones[5].matrixWorld);
        this.leftHand.set(0, .5, 0).applyMatrix4(this.bones[3].matrixWorld);
        this.transform.position.copy(this.rightHand);
        this.transform.quaternion.identity();
        const firearm = player.weapon === 'ak47' || player.weapon === 'awp';
        if (firearm) {
          this.direction.copy(this.leftHand).sub(this.rightHand).normalize();
          this.transform.quaternion.setFromUnitVectors(FORWARD, this.direction);
        }
        const scale = player.weapon === 'ak47' ? .02 : player.weapon === 'awp' ? .04 : .08;
        this.transform.scale.setScalar(scale);
        this.transform.updateMatrix();
        this.matrix.makeTranslation(0, player.weapon === 'ak47' ? 10 : player.weapon === 'awp' ? 5 : -5, player.weapon === 'ak47' ? 34 : player.weapon === 'awp' ? 17 : 0);
        this.matrix.premultiply(this.transform.matrix);
        for (const mesh of weaponMeshes) mesh.setMatrixAt(mesh.count++, this.matrix);
      }
      let name = this.names.get(player.id);
      if (!name && this.fontReady) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        ctx.font = '30px Riffic';
        canvas.width = Math.ceil(ctx.measureText(player.name).width) + 8;
        canvas.height = 48;
        ctx.font = '30px Riffic';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillText(player.name, 8, 28);
        ctx.fillStyle = '#ffffff'; ctx.fillText(player.name, 4, 24);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        name = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, toneMapped: false }));
        name.name = `Player name ${player.id}`;
        name.scale.set(canvas.width * 5 / 512, canvas.height * 5 / 512, 1);
        this.names.set(player.id, name);
        this.group.add(name);
      }
      if (name) {
        name.position.set(player.position.x, player.position.y + PLAYER_HEIGHT / 2 + 2.5, player.position.z);
        name.material.color.set(player.team === 1 ? 0xff0000 : player.team === 2 ? 0x0000ff : 0xffffff);
        name.visible = camera.position.distanceToSquared(name.position) < this.fogDistance * this.fogDistance;
      }
    }
    for (const pose of this.ragdolls?.poses ?? []) {
      for (let i = 0; i < BONES.length; i++) {
        this.matrix.copy(pose[i]).scale(this.sizes[i]);
        this.body.setMatrixAt(this.body.count, this.matrix);
        this.body.setColorAt(this.body.count++, this.colors[i]);
      }
    }
    this.body.instanceMatrix.needsUpdate = true;
    this.body.instanceColor!.needsUpdate = true;
    for (const meshes of this.weapons.values()) for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
    for (const [id, name] of this.names) {
      if (this.aliveIds.has(id)) continue;
      this.group.remove(name);
      name.material.map?.dispose();
      name.material.dispose();
      this.names.delete(id);
    }
  }

  clear(): void {
    this.ragdolls?.clear();
    this.lastPoses.clear();
    this.deathCounts.clear();
    this.corpseShots.clear();
    this.lastTime = null;
    this.body.count = 0;
    for (const meshes of this.weapons.values()) for (const mesh of meshes) mesh.count = 0;
    for (const name of this.names.values()) {
      this.group.remove(name);
      name.material.map?.dispose();
      name.material.dispose();
    }
    this.names.clear();
    this.aliveIds.clear();
  }
}
