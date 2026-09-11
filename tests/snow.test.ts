import { expect, spyOn, test } from 'bun:test';
import * as THREE from 'three';
import { Snow } from '../src/client/snow';
import { DT } from '../src/shared/protocol';
import { EYE_HEIGHT } from '../src/shared/movement';

const camera = { x: 100, y: 40, z: 100 };
const air = { get: () => 0 };

test('snow can be disabled, reset between rounds and disposed without retained instances', () => {
  const scene = new THREE.Scene(), snow = new Snow(scene);
  const get = spyOn(air, 'get');
  try {
    snow.update(1, camera, air);
    expect(get).not.toHaveBeenCalled();
    expect(snow.instance.visible).toBe(false);
    snow.setEnabled(true);
    snow.update(DT, camera, air);
    expect(snow.stats.activeCount).toBe(15);
    snow.setEnabled(false);
    const calls = get.mock.calls.length;
    snow.update(1, camera, air);
    expect(get.mock.calls.length).toBe(calls);
    expect(snow.instance.count).toBe(0);
    snow.setEnabled(true);
    snow.update(DT, camera, air);
    snow.reset();
    expect(snow.stats.activeCount).toBe(0);
    snow.update(DT, camera, air);
    expect(snow.stats.activeCount).toBe(15);
    const geometryDisposed = spyOn(snow.instance.geometry, 'dispose');
    const materialDisposed = spyOn(snow.instance.material, 'dispose');
    snow.dispose(); snow.dispose();
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    expect(scene.getObjectByName('snow')).toBeUndefined();
    snow.setEnabled(true); snow.update(DT, camera, air);
    expect(snow.stats.activeCount).toBe(0);
  } finally { snow.dispose(); get.mockRestore(); }
});

test('the same elapsed time produces the same snow at 30 and 120 rendered frames per second', () => {
  const results: Float32Array[] = [];
  for (const fps of [30, 120]) {
    let seed = 42;
    const random = spyOn(Math, 'random').mockImplementation(() => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 0x100000000));
    const snow = new Snow(new THREE.Scene());
    try {
      snow.setEnabled(true);
      for (let frame = 0; frame < fps * 2; frame++) snow.update(1 / fps, camera, air);
      expect(snow.stats.activeCount).toBe(1800);
      results.push(new Float32Array(snow.instance.instanceMatrix.array.slice(0, snow.instance.count * 16)));
    } finally { snow.dispose(); random.mockRestore(); }
  }
  expect(results[0]).toEqual(results[1]);
});

test('flakes stop in occupied voxels and resume after destruction without modifying the world', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.5);
  let solid = true;
  const world = { get: () => Number(solid) };
  const snow = new Snow(new THREE.Scene());
  try {
    snow.setEnabled(true);
    snow.update(DT, camera, world, { x: 1, y: 0, z: 0 });
    const matrix = new THREE.Matrix4();
    snow.instance.getMatrixAt(0, matrix);
    const original = matrix.elements.slice(12, 15);
    expect(original[0]).toBe(120);
    expect(original[1]).toBeCloseTo(camera.y - EYE_HEIGHT + 15, 4);
    expect(original[2]).toBe(100);
    for (let tick = 0; tick < 30; tick++) snow.update(DT, camera, world);
    snow.instance.getMatrixAt(0, matrix);
    expect(matrix.elements.slice(12, 15)).toEqual(original);
    solid = false;
    snow.update(DT, camera, world);
    snow.instance.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBeCloseTo(original[1] - 0.001, 4);
  } finally { snow.dispose(); random.mockRestore(); }
});

test('moving the emitter preserves existing flakes and the original cube size and raw palette', () => {
  const random = spyOn(Math, 'random').mockReturnValue(0.5);
  const snow = new Snow(new THREE.Scene());
  try {
    snow.setEnabled(true);
    snow.update(DT, camera, air, { x: 1, y: 0, z: 0 });
    snow.update(DT, { ...camera, x: 200 }, air, { x: 1, y: 0, z: 0 });
    const matrix = new THREE.Matrix4(), scale = new THREE.Vector3(), color = new THREE.Color();
    snow.instance.getMatrixAt(0, matrix);
    expect(matrix.elements[12]).toBe(120);
    snow.instance.getMatrixAt(15, matrix);
    expect(matrix.elements[12]).toBe(220);
    scale.setFromMatrixScale(matrix);
    expect(scale.x).toBeCloseTo(0.055, 6);
    snow.instance.geometry.computeBoundingBox();
    expect(snow.instance.geometry.boundingBox!.max.x - snow.instance.geometry.boundingBox!.min.x).toBe(2);
    snow.instance.getColorAt(0, color);
    expect(color.r).toBeCloseTo(0.8, 6);
    expect(color.g).toBeCloseTo(0.8, 6);
    expect(color.b).toBeCloseTo(0.9, 6);
    expect(snow.instance.material.toneMapped).toBe(false);
  } finally { snow.dispose(); random.mockRestore(); }
});

test('long stalls have bounded catch-up and continuous snowfall reuses a fixed pool', () => {
  const snow = new Snow(new THREE.Scene());
  try {
    const matrices = snow.instance.instanceMatrix.array, colors = snow.instance.instanceColor!.array;
    snow.setEnabled(true);
    snow.update(3600, camera, air);
    expect(snow.stats.activeCount).toBe(90);
    snow.update(NaN, camera, air);
    expect(snow.stats.activeCount).toBe(90);
    for (let tick = 0; tick < 1200; tick++) snow.update(DT, camera, air);
    expect(snow.stats.activeCount).toBeGreaterThan(6000);
    expect(snow.stats.activeCount).toBeLessThanOrEqual(9000);
    expect(snow.instance.instanceMatrix.array).toBe(matrices);
    expect(snow.instance.instanceColor!.array).toBe(colors);
    expect(matrices.length).toBe(10000 * 16);
  } finally { snow.dispose(); }
});
