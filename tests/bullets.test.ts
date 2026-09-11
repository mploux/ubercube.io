import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { BulletVisuals } from '../src/client/bullet-visuals';
import type { GameEvent, ProjectileState } from '../src/shared/protocol';

const shot = (id = 1): GameEvent => ({ type: 'event', roundId: 1, event: 'shot', projectileId: id,
  weapon: 'ak47', shooterId: 7, tick: 10, position: { x: 20, y: 40, z: 20 }, velocity: { x: 0, y: 0, z: 300 } });
const projectile = (id = 1): ProjectileState => ({ id, owner: 7, weapon: 'ak47',
  position: { x: 20, y: 40, z: 20 }, velocity: { x: 0, y: 0, z: 300 } });

function setup(capacity = 8) {
  const scene = new THREE.Scene();
  const visuals = new BulletVisuals(scene, 160, capacity);
  const mesh = scene.children[0] as THREE.InstancedMesh;
  const position = (index = 0) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
  };
  return { scene, visuals, mesh, position };
}

describe('authoritative bullet replay', () => {
  test('uses the Java yellow .08 by .08 by .8 body and raw entity shader', () => {
    const { visuals, mesh } = setup();
    visuals.event(shot(), 1);
    visuals.update(1.02);
    expect(mesh.count).toBe(1);
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(.08, 6);
    expect(size.y).toBeCloseTo(.08, 6);
    expect(size.z).toBeCloseTo(.8, 6);
    const color = new THREE.Color();
    mesh.getColorAt(0, color);
    expect(color.toArray()).toEqual([1, 1, 0]);
    const material = mesh.material as THREE.ShaderMaterial;
    expect(material.toneMapped).toBe(false);
    expect(material.depthTest).toBe(true);
    expect(material.fragmentShader).toContain('particleColor * 1.3');
    expect(material.fragmentShader).toContain('distance(cameraPosition, particleWorld)');
    visuals.setFogDistance(320);
    expect(material.uniforms.fogDistance.value).toBe(320);
    visuals.dispose();
  });

  test('moves continuously between snapshots without resetting to repeated authoritative positions', () => {
    const { visuals, position } = setup();
    visuals.event(shot(), 1);
    visuals.update(1.01);
    expect(position().z).toBeCloseTo(23, 5);
    visuals.snapshot([projectile()], 12, 1.02);
    visuals.event(shot(), 1.025);
    visuals.update(1.035);
    expect(position().z).toBeCloseTo(30.5, 5);
    visuals.dispose();
  });

  test('a shot and impact before the first frame remain visible once, inside the confirmed path', () => {
    const { visuals, mesh, position } = setup();
    visuals.event(shot(), 1);
    visuals.event({ ...shot(), event: 'impact', tick: 11, position: { x: 20, y: 40, z: 30 } }, 1.001);
    visuals.update(1.05);
    expect(mesh.count).toBe(1);
    expect(position().z).toBeCloseTo(25, 5);
    expect(position().z + .4).toBeLessThanOrEqual(30);
    visuals.update(1.066);
    expect(mesh.count).toBe(0);
    visuals.snapshot([projectile()], 12, 1.07);
    visuals.update(1.08);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });

  test('clips the body before a very close hit instead of stretching it through the wall', () => {
    const { visuals, mesh } = setup();
    visuals.event({ ...shot(), velocity: { x: 600, y: 0, z: 0 } }, 1);
    visuals.event({ ...shot(), event: 'impact', position: { x: 20.1, y: 40, z: 20 } }, 1);
    visuals.update(1.016);
    expect(mesh.count).toBe(1);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(0, matrix);
    const bounds = new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(matrix);
    expect(bounds.min.x).toBeCloseTo(20, 5);
    expect(bounds.max.x).toBeCloseTo(20.1, 5);
    visuals.update(1.033);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });

  test('matches impacts by projectile ID even for the same shooter and preserves other shots', () => {
    const { visuals, mesh, position } = setup();
    visuals.event(shot(1), 1);
    visuals.event(shot(2), 1);
    visuals.update(1.01);
    visuals.event({ ...shot(1), event: 'impact', position: { x: 20, y: 40, z: 24 } }, 1.02);
    visuals.update(1.03);
    expect(mesh.count).toBe(1);
    expect(position().z).toBeCloseTo(29, 5);
    visuals.dispose();
  });

  test('hydrates a late join from snapshots, ignores grenades and rejects stale snapshots', () => {
    const { visuals, mesh, position } = setup();
    visuals.snapshot([projectile(3), { ...projectile(4), weapon: 'grenade' }], 12, 1);
    visuals.snapshot([projectile(5)], 11, 1.01);
    visuals.update(1.025);
    expect(mesh.count).toBe(1);
    expect(position().z).toBeCloseTo(27.5, 5);
    visuals.event({ ...shot(3), event: 'projectile-end', tick: 14, position: { x: 20, y: 40, z: 29 } }, 1.03);
    visuals.update(1.04);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });

  test('capacity, eight second lifetime and clear bound retained visual work', () => {
    const { visuals, mesh, scene } = setup(2);
    for (let id = 1; id <= 20; id++) visuals.event(shot(id), 1);
    visuals.update(1.02);
    expect(mesh.count).toBe(2);
    visuals.update(9);
    expect(mesh.count).toBe(0);
    visuals.clear();
    visuals.event(shot(1), 10);
    visuals.update(10.01);
    expect(mesh.count).toBe(1);
    visuals.clear();
    expect(mesh.count).toBe(0);
    visuals.dispose();
    expect(scene.children.length).toBe(0);
  });

  test('ignores incomplete shot metadata and non-finite or zero velocity', () => {
    const { visuals, mesh } = setup();
    visuals.event({ ...shot(), projectileId: undefined }, 1);
    visuals.event({ ...shot(), velocity: undefined }, 1);
    visuals.event({ ...shot(), velocity: { x: NaN, y: 0, z: 300 } }, 1);
    visuals.event({ ...shot(), velocity: { x: 0, y: 0, z: 0 } }, 1);
    visuals.update(1.02);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });
});
