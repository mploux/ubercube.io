import { expect, spyOn, test } from 'bun:test';
import { deathCamera } from '../src/client/death-camera';
import { VoxelWorld } from '../src/shared/voxel';

test('death camera follows the corpse from above and rotates its offset with the victim yaw', () => {
  const world = new VoxelWorld({ size: 64, height: 64, seed: 1 });
  const get = spyOn(world, 'get').mockReturnValue(0);
  const focus = { x: 20, y: 10, z: 20 };
  try {
    const behind = deathCamera(world, focus, 0);
    expect(behind.target).toEqual({ x: 20, y: 10.5, z: 20 });
    expect(behind.position).toEqual({ x: 22, y: 13.5, z: 24 });
    const rotated = deathCamera(world, focus, Math.PI / 2);
    expect(rotated.position.x).toBeCloseTo(24);
    expect(rotated.position.y).toBeCloseTo(13.5);
    expect(rotated.position.z).toBeCloseTo(18);
    const moved = deathCamera(world, { x: 23, y: 8, z: 21 }, 0);
    expect(moved.target).toEqual({ x: 23, y: 8.5, z: 21 });
    expect(moved.position).toEqual({ x: 25, y: 11.5, z: 25 });
    expect(focus).toEqual({ x: 20, y: 10, z: 20 });
  } finally { get.mockRestore(); }
});

test.each(['wall', 'ceiling'] as const)('death camera stops before a solid %s along the view path', obstacle => {
  const world = new VoxelWorld({ size: 64, height: 64, seed: 1 });
  const get = spyOn(world, 'get').mockImplementation((_x, y, z) => obstacle === 'wall' ? Number(z === 23) : Number(y === 12));
  try {
    const { target, position } = deathCamera(world, { x: 20.5, y: 10, z: 20.5 }, 0);
    expect(target).toEqual({ x: 20.5, y: 10.5, z: 20.5 });
    expect(position.y).toBeGreaterThan(target.y);
    expect(position.z).toBeGreaterThan(target.z);
    expect(world.get(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))).toBe(0);
    if (obstacle === 'wall') expect(position.z).toBeLessThan(23);
    else expect(position.y).toBeLessThan(12);
    const contactScale = obstacle === 'wall' ? (23 - target.z) / 4 : (12 - target.y) / 3;
    const contact = { x: target.x + 2 * contactScale, y: target.y + 3 * contactScale, z: target.z + 4 * contactScale };
    expect(Math.hypot(position.x - contact.x, position.y - contact.y, position.z - contact.z)).toBeCloseTo(.35);
  } finally { get.mockRestore(); }
});

test('very close obstacles never push the camera behind its corpse target', () => {
  const world = new VoxelWorld({ size: 64, height: 64, seed: 1 });
  const get = spyOn(world, 'get').mockImplementation((_x, _y, z) => Number(z === 21));
  try {
    const { target, position } = deathCamera(world, { x: 20.5, y: 10, z: 20.95 }, 0);
    expect(position).toEqual(target);
    expect(world.get(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))).toBe(0);
  } finally { get.mockRestore(); }
});
