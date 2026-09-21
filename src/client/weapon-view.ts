import * as THREE from 'three';
import type { Vec3, WeaponId } from '../shared/protocol';
import { createWeaponPose, hideWeaponPose, stepWeaponMotion, stepWeaponPose, WEAPON_POSES, WEAPON_MODEL_SCALE,
  type WeaponPoseActions, type WeaponPoseInput, type WeaponPoseState } from '../shared/weapon-pose';
import { loadWeaponModel, WEAPON_MODEL_FILES, WEAPON_PREVIEWS } from './weapon-model';

export interface WeaponViewInput extends Omit<WeaponPoseInput, 'localVelocity'> { moveX: number; moveZ: number }

const weapons = Object.keys(WEAPON_MODEL_FILES) as WeaponId[];

function disposeModel(model: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

export class WeaponView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, .05, 1000);
  readonly ready: Promise<void>;
  private readonly root = new THREE.Group();
  private readonly models = new Map<WeaponId, THREE.Group>();
  private readonly previewModels = new Map<WeaponId, THREE.Group>();
  private readonly previewRoot = new THREE.Group();
  private readonly previewCamera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 100);
  private readonly poses = Object.fromEntries(weapons.map(weapon => [weapon, createWeaponPose(weapon)])) as Record<WeaponId, WeaponPoseState>;
  private readonly motion: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly conversion = new THREE.Matrix4().makeScale(1, 1, -1);
  private readonly localMatrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly fallback = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 32).translate(0, -3, 32), new THREE.MeshBasicMaterial({ color: 0x65705d }));
  private current: WeaponId = 'ak47';
  private fireHeld = false;
  private altHeld = false;
  private pendingSwitch = false;
  private visible = true;
  private disposed = false;

  constructor(loader: (weapon: WeaponId) => Promise<THREE.Group> = loadWeaponModel) {
    this.root.name = 'first-person weapon';
    this.root.matrixAutoUpdate = false;
    this.previewRoot.visible = false;
    this.previewRoot.matrixAutoUpdate = false;
    this.scene.add(this.root, this.previewRoot);
    this.reset();
    this.ready = Promise.all(weapons.map(async weapon => {
      try {
        const model = await loader(weapon);
        if (this.disposed) { disposeModel(model); return; }
        this.models.set(weapon, model);
        this.previewModels.set(weapon, model.clone(true));
        if (this.current === weapon) this.attach();
      } catch {
        // The placeholder lasts only while the original asset is unavailable.
      }
    })).then(() => undefined);
  }

  get pose(): { readonly [Key in keyof WeaponPoseState]: Readonly<WeaponPoseState[Key]> } { return this.poses[this.current]; }
  get fov(): number { return 70 - this.pose.zoom; }

  setWeapon(weapon: WeaponId): void {
    if (this.disposed || this.current === weapon) return;
    const outgoing = this.poses[this.current];
    hideWeaponPose(outgoing);
    outgoing.charge = 0; outgoing.fireHeld = false; outgoing.altHeld = false;
    this.current = weapon;
    this.pendingSwitch = true;
    this.visible = true;
    this.attach();
    this.updateMatrix();
  }

  reset(weapon: WeaponId = this.current): void {
    if (this.disposed) return;
    for (const id of weapons) this.poses[id] = createWeaponPose(id);
    this.current = weapon;
    hideWeaponPose(this.poses[this.current]);
    this.fireHeld = false; this.altHeld = false;
    this.pendingSwitch = false;
    this.motion.x = 0; this.motion.y = 0; this.motion.z = 0;
    this.visible = true;
    this.attach();
    this.updateMatrix();
  }

  tick(input: WeaponViewInput, random: () => number = Math.random): WeaponPoseActions {
    if (this.disposed) return { fired: false, thrown: false, force: 0, melee: false, heal: false, build: false };
    if (this.pendingSwitch) {
      // Wheel events precede the next input frame: transfer held buttons, never an old release.
      this.poses[this.current].fireHeld = this.fireHeld && input.fire;
      this.poses[this.current].altHeld = this.altHeld && input.alt;
      this.pendingSwitch = false;
    }
    stepWeaponMotion(this.motion, input.cancelActions ? { moveX: 0, moveZ: 0, sprint: false } : input);
    const actions = stepWeaponPose(this.poses[this.current], { ...input, localVelocity: this.motion }, random);
    this.fireHeld = input.fire && !input.cancelActions;
    this.altHeld = input.alt && !input.cancelActions;
    this.visible = this.current !== 'grenade' || input.grenades > 0;
    this.updateMatrix();
    return actions;
  }

  private attach(): void {
    this.root.clear();
    this.root.add(this.models.get(this.current) ?? this.fallback);
  }

  private updateMatrix(): void {
    const pose = this.pose, scale = WEAPON_POSES[this.current].scale;
    const round = this.models.get('rpg')?.getObjectByName('RPG_rocket');
    const rpgPose = this.poses.rpg;
    if (round) round.visible = !rpgPose.shot || rpgPose.shootTimer >= 62;
    const sights = this.models.get('rpg')?.getObjectByName('RPG_sights');
    // The magnified optic focuses past the nearby iron sight; keep its aperture unobstructed.
    if (sights) sights.visible = !rpgPose.altHeld;
    this.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.rotation.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
    this.scale.set(scale.x * WEAPON_MODEL_SCALE, scale.y * WEAPON_MODEL_SCALE, scale.z * WEAPON_MODEL_SCALE);
    // Java projects +Z; reflect that axis after the original T*R*S, without recentering its OBJ.
    this.localMatrix.compose(this.position, this.rotation, this.scale).premultiply(this.conversion);
    this.root.matrix.copy(this.camera.matrixWorld).multiply(this.localMatrix);
  }

  render(renderer: THREE.WebGLRenderer, worldCamera?: THREE.Camera): void {
    if (this.disposed || !this.visible) return;
    this.models.get(this.current)?.traverse(object => {
      if (object instanceof THREE.Mesh) (object.material as THREE.ShaderMaterial).uniforms.preview.value = false;
    });
    if (worldCamera) {
      const q = worldCamera.quaternion;
      // WeaponShader lights raw OBJ normals with the Java camera view, independently of its pose.
      this.camera.quaternion.set(-q.x, -q.y, q.z, q.w);
    } else this.camera.quaternion.identity();
    this.camera.fov = this.fov;
    this.camera.aspect = renderer.domElement.clientWidth / Math.max(1, renderer.domElement.clientHeight);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.updateMatrix();
    this.root.visible = true;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try { renderer.clearDepth(); renderer.render(this.scene, this.camera); }
    finally { renderer.autoClear = autoClear; }
  }

  renderKitPreview(renderer: THREE.WebGLRenderer, time: number, weapon: WeaponId, rect: DOMRect): void {
    if (this.disposed || (weapon !== 'ak47' && weapon !== 'awp' && weapon !== 'medic')) return;
    const model = this.previewModels.get(weapon);
    if (!model || rect.width <= 0 || rect.height <= 0) return;
    const canvas = renderer.domElement.getBoundingClientRect();
    const viewport = renderer.getViewport(new THREE.Vector4());
    const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest();
    const autoClear = renderer.autoClear;
    const x = rect.left - canvas.left;
    const y = canvas.height - (rect.top - canvas.top) - rect.height;
    const spec = WEAPON_PREVIEWS[weapon];
    this.previewRoot.clear();
    this.previewRoot.add(model);
    // Preserve Java's GUI FBO flip and original 30-degrees-per-second preview transform.
    this.previewRoot.matrix.makeTranslation(0, 0, -5)
      .multiply(new THREE.Matrix4().makeScale(spec.scale[0], -spec.scale[1], -spec.scale[2]))
      .multiply(new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(time * 30 + spec.rotation)))
      .multiply(new THREE.Matrix4().makeTranslation(spec.center[0], spec.center[1], spec.center[2]));
    this.previewCamera.aspect = rect.width / rect.height;
    this.previewCamera.updateProjectionMatrix();
    model.traverse(object => {
      if (object instanceof THREE.Mesh) (object.material as THREE.ShaderMaterial).uniforms.preview.value = true;
    });
    this.root.visible = false;
    this.previewRoot.visible = true;
    renderer.autoClear = false;
    renderer.setViewport(x, y, rect.width, rect.height);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setScissorTest(true);
    try { renderer.clearDepth(); renderer.render(this.scene, this.previewCamera); }
    finally {
      renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
      renderer.autoClear = autoClear;
      this.previewRoot.visible = false; this.root.visible = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.clear();
    for (const model of this.models.values()) disposeModel(model);
    this.models.clear(); this.previewModels.clear();
    this.fallback.geometry.dispose(); this.fallback.material.dispose();
  }
}
