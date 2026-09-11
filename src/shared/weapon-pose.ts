import type { Vec3, WeaponId } from './protocol';

interface WeaponPreset { scale: Vec3; idle: Vec3; zoom: Vec3; hide: Vec3; muzzle?: Vec3; zoomAmount: number }

export const WEAPON_MODEL_SCALE = 1 / 16;

// Muzzles are the centers of the original OBJ barrel end caps, in raw model coordinates.
export const WEAPON_POSES: Record<WeaponId, WeaponPreset> = {
  ak47: { scale: { x: -.35, y: .35, z: .35 }, idle: { x: .2, y: -.05, z: -.3 }, zoom: { x: 0, y: 0, z: -1 }, hide: { x: .2, y: -1.05, z: 0 }, muzzle: { x: 0, y: -5.278345, z: 98.273787 }, zoomAmount: 40 },
  awp: { scale: { x: .65, y: .65, z: .65 }, idle: { x: .2, y: 0, z: -.3 }, zoom: { x: 0, y: 0, z: .3 }, hide: { x: .2, y: -1, z: 1.5 }, muzzle: { x: 0, y: -3.1084115, z: 64.970720 }, zoomAmount: 150 },
  shovel: { scale: { x: .3, y: .3, z: .3 }, idle: { x: .1, y: -.2, z: .2 }, zoom: { x: .1, y: -.2, z: .2 }, hide: { x: .1, y: -1.2, z: .2 }, zoomAmount: 0 },
  grenade: { scale: { x: 1, y: 1, z: 1 }, idle: { x: .4, y: -.3, z: 1 }, zoom: { x: .4, y: -.3, z: 1 }, hide: { x: .3, y: -1.05, z: 0 }, zoomAmount: 0 },
  medic: { scale: { x: 3, y: 3, z: 3 }, idle: { x: .09, y: -.4, z: .85 }, zoom: { x: 0, y: 0, z: 0 }, hide: { x: 0, y: 0, z: 0 }, zoomAmount: 0 },
};

export interface WeaponPoseState {
  weapon: WeaponId;
  position: Vec3;
  quaternion: { x: number; y: number; z: number; w: number };
  rotationFactor: Vec3;
  zoom: number;
  bobTime: number;
  bobSide: number;
  shot: boolean;
  shootTimer: number;
  attacking: boolean;
  attackTime: number;
  charge: number;
  fireHeld: boolean;
  altHeld: boolean;
}

export interface WeaponPoseInput {
  fire: boolean;
  alt: boolean;
  sprint: boolean;
  localVelocity: Vec3;
  lookDeltaYaw: number;
  lookDeltaPitch: number;
  mouseDX?: number;
  mouseDY?: number;
  grenades: number;
  cancelActions?: boolean;
}

export interface WeaponPoseActions { fired: boolean; thrown: boolean; force: number; melee: boolean; heal: boolean; build: boolean }

export function createWeaponPose(weapon: WeaponId): WeaponPoseState {
  const state: WeaponPoseState = {
    weapon, position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
    rotationFactor: { x: 0, y: 0, z: 0 }, zoom: 0, bobTime: 0, bobSide: 1,
    shot: false, shootTimer: 0, attacking: false, attackTime: 0, charge: 0, fireHeld: false, altHeld: false,
  };
  if (weapon === 'shovel') hideWeaponPose(state);
  return state;
}

export function hideWeaponPose(state: WeaponPoseState): void {
  const hide = WEAPON_POSES[state.weapon].hide;
  state.position.x += hide.x; state.position.y += hide.y; state.position.z += hide.z;
  Object.assign(state.quaternion, { x: 0, y: 0, z: 0, w: 1 });
}

export function stepWeaponMotion(velocity: Vec3, input: { moveX: number; moveZ: number; sprint: boolean }): void {
  const speed = input.sprint ? .015 : .01;
  // ECKeyMovement's local visual velocity differs from collision-resolved player velocity.
  velocity.x = velocity.x * .9 - input.moveX * speed;
  velocity.z = velocity.z * .9 + input.moveZ * speed;
  velocity.y = 0;
}

function rotate(vector: Vec3, q: WeaponPoseState['quaternion']): Vec3 {
  const x = 2 * (q.y * vector.z - q.z * vector.y);
  const y = 2 * (q.z * vector.x - q.x * vector.z);
  const z = 2 * (q.x * vector.y - q.y * vector.x);
  return { x: vector.x + q.w * x + q.y * z - q.z * y,
    y: vector.y + q.w * y + q.z * x - q.x * z,
    z: vector.z + q.w * z + q.x * y - q.y * x };
}

export function getWeaponMuzzle(state: WeaponPoseState): { position: Vec3; direction: Vec3 } {
  const preset = WEAPON_POSES[state.weapon], muzzle = preset.muzzle ?? { x: 0, y: 0, z: 0 };
  const position = rotate({ x: muzzle.x * preset.scale.x * WEAPON_MODEL_SCALE,
    y: muzzle.y * preset.scale.y * WEAPON_MODEL_SCALE, z: muzzle.z * preset.scale.z * WEAPON_MODEL_SCALE }, state.quaternion);
  position.x += state.position.x; position.y += state.position.y; position.z += state.position.z;
  return { position, direction: rotate({ x: 0, y: 0, z: 1 }, state.quaternion) };
}

/** One Java gameplay tick (60 Hz). Angles are current-client radians; raw mouse Y is positive down. */
export function stepWeaponPose(state: WeaponPoseState, input: WeaponPoseInput, random: () => number = Math.random): WeaponPoseActions {
  const preset = WEAPON_POSES[state.weapon];
  const gun = state.weapon === 'ak47' || state.weapon === 'awp';
  const fire = input.fire && !input.cancelActions, alt = input.alt && !input.cancelActions;
  const pressed = fire && !state.fireHeld, released = !fire && state.fireHeld;
  const actions: WeaponPoseActions = { fired: gun && fire && !state.shot, thrown: false, force: 0,
    melee: state.weapon === 'shovel' && pressed, heal: state.weapon === 'medic' && pressed,
    build: state.weapon === 'shovel' && alt && !state.altHeld };
  if (input.cancelActions) {
    state.charge = 0; state.attacking = false; state.attackTime = 0;
  }

  if (actions.fired) {
    const forward = rotate({ x: 0, y: 0, z: 1 }, state.quaternion);
    state.position.z -= forward.z * (alt ? .001 : .025);
    if (!alt) { state.rotationFactor.x += random() * .05 - .025; state.rotationFactor.y += random() * .05 - .05; }
  }
  if (actions.melee) state.attacking = true;
  if (state.weapon === 'grenade' && input.grenades > 0) {
    if (fire) state.charge = (state.charge + .3) * .9;
    if (released && !input.cancelActions) { actions.thrown = true; actions.force = state.charge * .9; state.charge = 0; }
  }

  const target = alt ? preset.zoom : preset.idle;
  state.position.x += (target.x - state.position.x) * .4;
  state.position.y += (target.y - state.position.y) * .4;
  state.position.z += (target.z - state.position.z) * .4;
  state.rotationFactor.x *= .7; state.rotationFactor.y *= .7; state.rotationFactor.z *= .7;
  if (gun) state.zoom = (state.zoom + (alt ? preset.zoomAmount * .1667 : 0)) * .7;

  // Quat.euler(Vec3) passes (x,z,y) to the Java scalar overload; preserve that order.
  const a = state.rotationFactor.x / 2, b = state.rotationFactor.z / 2, c = state.rotationFactor.y / 2;
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b), sc = Math.sin(c), cc = Math.cos(c);
  Object.assign(state.quaternion, { x: cc * cb * sa + sc * sb * ca, y: sc * cb * ca + cc * sb * sa,
    z: cc * sb * ca - sc * cb * sa, w: cc * cb * ca - sc * sb * sa });

  if ((gun || state.weapon === 'shovel') && !alt) {
    const velocity = input.localVelocity;
    const speed = Math.hypot(velocity.x, velocity.z);
    state.bobTime++;
    const factor = input.sprint ? (gun ? .2 : .4) : .15;
    const bob = Math.sin(state.bobTime * (input.sprint ? .3 : .2) * .5) * factor * speed;
    if (bob * state.bobSide > 0) state.bobSide = -state.bobSide;
    state.rotationFactor.x += bob * state.bobSide; state.rotationFactor.y += bob;
    if (input.sprint) {
      state.rotationFactor.x += gun ? .1 : -.05;
      state.rotationFactor.y += gun ? -.2 : 0;
      state.rotationFactor.z += gun ? 0 : -.05;
    } else {
      const dx = gun ? -input.lookDeltaYaw * 180 / Math.PI * 4 : input.mouseDX ?? 0;
      const dy = gun ? -input.lookDeltaPitch * 180 / Math.PI * 4 : input.mouseDY ?? 0;
      state.rotationFactor.x += dy * .0008 + velocity.z * .2;
      state.rotationFactor.y += dx * .0008;
      state.rotationFactor.z += -dx * .0008 + velocity.x * .2;
    }
  }
  if (gun) {
    if (actions.fired) {
      state.shot = true; state.shootTimer = 0;
      state.rotationFactor.x -= state.weapon === 'ak47' ? (alt ? .01 : .15) : (alt ? .1 : .3);
    }
    if (fire && state.shootTimer > (state.weapon === 'ak47' ? 6 : 60)) state.shot = false;
    if (state.shot) state.shootTimer++;
  }
  if (state.weapon === 'shovel') {
    if (state.attacking && state.attackTime < 5) {
      state.rotationFactor.x += .9; state.rotationFactor.y -= .4; state.rotationFactor.z -= .4;
      state.attackTime++;
    } else { state.attacking = false; state.attackTime = 0; }
  }
  if (state.weapon === 'grenade') state.position.z = 1 - state.charge * .15;
  state.fireHeld = fire; state.altHeld = alt;
  return actions;
}
