import { aimDirection, EYE_HEIGHT } from './movement';
import { DT, TICK_RATE, type MotionState, type Vec3 } from './protocol';
import { raycast, type VoxelWorld } from './voxel';

export interface GrenadeFlight {
  position: Vec3;
  velocity: Vec3;
  gravity?: number;
  bounce?: number;
  restitution?: number;
  grounded?: boolean;
}

export function grenadeLaunch(world: VoxelWorld, player: MotionState,
  muzzle: { position: Vec3; direction: Vec3 }, force: number): { position: Vec3; velocity: Vec3 } {
  const eye = { x: player.position.x, y: player.position.y + EYE_HEIGHT, z: player.position.z };
  const aim = aimDirection(player.yaw, player.pitch);
  const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw), sp = Math.sin(player.pitch), cp = Math.cos(player.pitch);
  const toWorld = (v: Vec3): Vec3 => ({ x: cy * v.x + sy * sp * v.y + aim.x * v.z,
    y: cp * v.y + aim.y * v.z, z: -sy * v.x + cy * sp * v.y + aim.z * v.z });
  const offset = toWorld(muzzle.position);
  offset.x += aim.x * 1.5; offset.y += aim.y * 1.5; offset.z += aim.z * 1.5;
  let position = { x: eye.x + offset.x, y: eye.y + offset.y, z: eye.z + offset.z };
  const obstruction = raycast(world, eye, offset, Math.hypot(offset.x, offset.y, offset.z));
  if (obstruction) position = { x: obstruction.point.x + obstruction.normal.x * .001,
    y: obstruction.point.y + obstruction.normal.y * .001, z: obstruction.point.z + obstruction.normal.z * .001 };
  const direction = toWorld(muzzle.direction);
  const speed = force * TICK_RATE;
  return { position, velocity: { x: direction.x * speed, y: direction.y * speed, z: direction.z * speed } };
}

export function stepGrenade(grenade: GrenadeFlight, world: VoxelWorld): void {
  // Preserve the original ten substeps so cosmetic prediction and server collisions agree.
  for (let step = 0; step < 10; step++) {
    grenade.gravity = (grenade.gravity ?? 0) + .25;
    grenade.velocity.y += (grenade.bounce ?? 0) - grenade.gravity / 600;
    grenade.bounce = 0;
    if (grenade.grounded && (grenade.restitution ?? 1) > 0) {
      const impulse = Math.hypot(grenade.velocity.x, grenade.velocity.y, grenade.velocity.z) * .4;
      grenade.bounce = impulse;
      grenade.restitution = impulse / TICK_RATE < .01 ? 0 : impulse / TICK_RATE;
    }
    const drag = grenade.grounded ? .97 : .996;
    const speed = Math.hypot(grenade.velocity.x, grenade.velocity.y, grenade.velocity.z);
    if (speed < 1e-8) continue;
    const direction = { x: grenade.velocity.x / speed, y: grenade.velocity.y / speed, z: grenade.velocity.z / speed };
    const block = raycast(world, grenade.position, direction, speed * DT / 10);
    if (!block) {
      grenade.position.x += grenade.velocity.x * DT / 10;
      grenade.position.y += grenade.velocity.y * DT / 10;
      grenade.position.z += grenade.velocity.z * DT / 10;
    }
    grenade.velocity.x *= drag; grenade.velocity.y *= drag; grenade.velocity.z *= drag;
    grenade.grounded = false;
    if (block) {
      grenade.position = { x: block.point.x + block.normal.x * .02,
        y: block.point.y + block.normal.y * .02, z: block.point.z + block.normal.z * .02 };
      const dot = grenade.velocity.x * block.normal.x + grenade.velocity.y * block.normal.y + grenade.velocity.z * block.normal.z;
      grenade.velocity.x -= dot * block.normal.x;
      grenade.velocity.y -= dot * block.normal.y;
      grenade.velocity.z -= dot * block.normal.z;
      if (block.normal.y > 0) { grenade.gravity = 0; grenade.grounded = true; }
    }
  }
}
