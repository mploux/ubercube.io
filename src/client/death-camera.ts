import type { Vec3 } from '../shared/protocol';
import { raycast, type VoxelWorld } from '../shared/voxel';

export function deathCamera(world: VoxelWorld, focus: Vec3, yaw: number): { position: Vec3; target: Vec3 } {
  const target = { x: focus.x, y: focus.y + .5, z: focus.z };
  const offset = { x: Math.sin(yaw) * 4 + Math.cos(yaw) * 2, y: 3, z: Math.cos(yaw) * 4 - Math.sin(yaw) * 2 };
  const distance = Math.hypot(offset.x, offset.y, offset.z);
  const direction = { x: offset.x / distance, y: offset.y / distance, z: offset.z / distance };
  const hit = raycast(world, target, direction, distance);
  const length = hit ? Math.max(0, hit.distance - .35) : distance;
  return { target, position: { x: target.x + direction.x * length,
    y: target.y + direction.y * length, z: target.z + direction.z * length } };
}
