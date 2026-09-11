import { describe, expect, test } from 'bun:test';
import { clampMinimap, MINIMAP_LAYOUT, minimapTilePixels, projectMinimap } from '../src/client/minimap';
import { damageBlock, packBlock, VoxelWorld } from '../src/shared/voxel';

describe('Java minimap projection', () => {
  test('preserves the fixed dimensions and Java integer zoom', () => {
    expect(MINIMAP_LAYOUT.width).toBe(300);
    expect(MINIMAP_LAYOUT.height).toBe(200);
    expect(Math.trunc(Math.trunc(200 / 30) / 2)).toBe(MINIMAP_LAYOUT.scale);
    expect(MINIMAP_LAYOUT.iconSize).toBe(20);
  });

  test('keeps forward at the top and right at the right for all cardinal headings', () => {
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const forward = projectMinimap(-Math.sin(yaw) * 10, -Math.cos(yaw) * 10, yaw);
      const right = projectMinimap(Math.cos(yaw) * 10, -Math.sin(yaw) * 10, yaw);
      expect(forward.x).toBeCloseTo(0);
      expect(forward.y).toBeCloseTo(-30);
      expect(right.x).toBeCloseTo(30);
      expect(right.y).toBeCloseTo(0);
    }
  });

  test('matches the Java object formula after converting its left-handed +Z camera', () => {
    const yaw = 0.731, dx = 11.75, dz = -24.125, scale = 4;
    const javaAngle = Math.PI / 2 + yaw;
    const javaX = dx * scale, javaY = dz * scale;
    const expected = { x: javaX * Math.sin(javaAngle) + javaY * Math.cos(javaAngle),
      y: javaY * Math.sin(javaAngle) - javaX * Math.cos(javaAngle) };
    const actual = projectMinimap(dx, dz, yaw, scale);
    expect(actual.x).toBeCloseTo(expected.x);
    expect(actual.y).toBeCloseTo(expected.y);
  });

  test('clamps markers along their ray to the same 5px inset on both map sizes', () => {
    expect(clampMinimap({ x: 0, y: -1000 })).toEqual({ x: 0, y: -95 });
    expect(clampMinimap({ x: 1000, y: 0 })).toEqual({ x: 145, y: 0 });
    const diagonal = clampMinimap({ x: 900, y: -300 });
    expect(diagonal.x).toBe(145);
    expect(diagonal.y / diagonal.x).toBeCloseTo(-1 / 3);
    expect(clampMinimap({ x: 25, y: -10 })).toEqual({ x: 25, y: -10 });
  });
});

describe('topmost voxel pixels', () => {
  test('uses exact RGB, ignores block health as alpha and removes former height shading', () => {
    const world = new VoxelWorld({ seed: 42, size: 32, height: 64 });
    const value = packBlock(121, 68, 203, 63);
    world.set(4, 55, 7, value);
    world.set(5, 46, 7, value);
    let pixels = minimapTilePixels(world, 0, 0);
    const pixel = (x: number, z: number) => Array.from(pixels.slice((x + z * 16) * 4, (x + z * 16) * 4 + 4));
    expect(pixel(4, 7)).toEqual([121, 68, 203, 255]);
    expect(pixel(5, 7)).toEqual(pixel(4, 7));
    world.set(4, 55, 7, damageBlock(value, 0.1));
    pixels = minimapTilePixels(world, 0, 0);
    expect(pixel(4, 7)[0]).toBeLessThan(121);
    expect(pixel(4, 7)[3]).toBe(255);
    world.set(4, 55, 7, 0);
    pixels = minimapTilePixels(world, 0, 0);
    const surface = world.get(4, world.surfaceY(4, 7) - 1, 7);
    expect(pixel(4, 7)).toEqual([(surface >>> 16) & 255, (surface >>> 8) & 255, surface & 255, 255]);
  });

  test('leaves pixels beyond the map transparent for the original grey clear color', () => {
    const world = new VoxelWorld({ seed: 42, size: 20, height: 64 });
    const pixels = minimapTilePixels(world, 16, 16);
    expect(pixels[(3 + 3 * 16) * 4 + 3]).toBe(255);
    expect(pixels[(4 + 3 * 16) * 4 + 3]).toBe(0);
    expect(pixels[(3 + 4 * 16) * 4 + 3]).toBe(0);
  });

  test('ships the original PNG icon dimensions without resized replacements', async () => {
    for (const name of ['North', 'South', 'East', 'West', 'player_icon', 'house_icon', 'player_minimap']) {
      const png = new DataView(await Bun.file(new URL(`../public/assets/minimap/${name}.png`, import.meta.url)).arrayBuffer());
      expect(png.getUint32(0)).toBe(0x89504e47);
      expect(png.getUint32(16)).toBe(name === 'player_minimap' ? 150 : 20);
      expect(png.getUint32(20)).toBe(name === 'player_minimap' ? 150 : 20);
    }
  });
});
