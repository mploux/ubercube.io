import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { BulletVisuals } from '../src/client/bullet-visuals';
import type { GameEvent } from '../src/shared/protocol';

const shot = (id = 1): GameEvent => ({ type: 'event', roundId: 1, event: 'shot', projectileId: id,
  weapon: 'ak47', shooterId: 7, tick: 10, position: { x: 20, y: 40, z: 20 }, endPosition: { x: 20, y: 40, z: 120 } });

function setup(capacity = 8) {
  const scene = new THREE.Scene();
  const visuals = new BulletVisuals(scene, 160, capacity);
  const mesh = scene.children[0] as THREE.InstancedMesh;
  const bounds = (index = 0) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    return new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(matrix);
  };
  return { scene, visuals, mesh, bounds };
}

describe('authoritative hitscan traces', () => {
  test('preserves the Java yellow thickness and raw entity shader', () => {
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

  test('shows the whole confirmed segment immediately and never advances or restarts on a duplicate shot', () => {
    const { visuals, mesh, bounds } = setup();
    visuals.event(shot(), 1);
    visuals.update(1);
    expect(mesh.count).toBe(1);
    expect(bounds().min.z).toBeCloseTo(20, 5);
    expect(bounds().max.z).toBeCloseTo(120, 5);
    visuals.event(shot(), 1.025);
    visuals.update(1.035);
    expect(mesh.count).toBe(1);
    expect(bounds().min.z).toBeCloseTo(20, 5);
    expect(bounds().max.z).toBeCloseTo(120, 5);
    visuals.update(1.061);
    expect(mesh.count).toBe(0);
    visuals.event(shot(), 1.07);
    visuals.update(1.08);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });

  test('a same-tick shot and impact remain visible for one frame when both arrive between frames', () => {
    for (const impactFirst of [false, true]) {
      const { visuals, mesh, bounds } = setup();
      const confirmed = { ...shot(), endPosition: { x: 20, y: 40, z: 30 } };
      const impact: GameEvent = { ...confirmed, event: 'impact', position: confirmed.endPosition };
      for (const event of impactFirst ? [impact, confirmed] : [confirmed, impact]) visuals.event(event, 1);
      visuals.update(1.1);
      expect(mesh.count).toBe(1);
      expect(bounds().min.z).toBeCloseTo(20, 5);
      expect(bounds().max.z).toBeCloseTo(30, 5);
      visuals.update(1.116);
      expect(mesh.count).toBe(0);
      visuals.dispose();
    }
  });

  test('ends at a very close hit instead of extending through the wall', () => {
    const { visuals, mesh, bounds } = setup();
    visuals.event({ ...shot(), endPosition: { x: 20.1, y: 40, z: 20 } }, 1);
    visuals.update(1.016);
    expect(mesh.count).toBe(1);
    expect(bounds().min.x).toBeCloseTo(20, 5);
    expect(bounds().max.x).toBeCloseTo(20.1, 5);
    visuals.update(1.061);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });

  test('uses the same short lifetime for AK hits and long AWP misses without an impact event', () => {
    const { visuals, mesh, bounds } = setup();
    visuals.event({ ...shot(1), endPosition: { x: 20, y: 40, z: 21 } }, 1);
    visuals.event({ ...shot(2), weapon: 'awp', endPosition: { x: 20, y: 40, z: 2000 } }, 1);
    visuals.update(1);
    expect(mesh.count).toBe(2);
    expect(bounds(0).max.z).toBeCloseTo(21, 5);
    expect(bounds(1).max.z).toBeCloseTo(2000, 3);
    visuals.update(1.05);
    expect(mesh.count).toBe(2);
    visuals.update(1.061);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });

  test('ignores grenades, unrelated impacts and projectile-end events', () => {
    const { visuals, mesh } = setup();
    visuals.event({ ...shot(1), weapon: 'grenade' }, 1);
    visuals.event({ ...shot(2), event: 'impact' }, 1);
    visuals.event({ ...shot(3), event: 'projectile-end' }, 1);
    visuals.update(1.02);
    expect(mesh.count).toBe(0);
    visuals.event(shot(2), 1.03);
    visuals.update(1.03);
    expect(mesh.count).toBe(1);
    visuals.dispose();
  });

  test('capacity, deduplication retention and clear bound retained visual work', () => {
    const { visuals, mesh, scene } = setup(2);
    for (let id = 1; id <= 20; id++) visuals.event(shot(id), 1);
    visuals.update(1.02);
    expect(mesh.count).toBe(2);
    visuals.event(shot(19), 1.03);
    visuals.update(1.061);
    expect(mesh.count).toBe(0);
    visuals.event(shot(20), 2);
    visuals.update(2);
    expect(mesh.count).toBe(0);
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
    visuals.event(shot(2), 11);
    visuals.update(11);
    expect(mesh.count).toBe(0);
  });

  test('ignores incomplete metadata, invalid endpoints and zero-length rays', () => {
    const { visuals, mesh } = setup();
    visuals.event({ ...shot(), projectileId: undefined }, 1);
    visuals.event({ ...shot(), tick: -1 }, 1);
    visuals.event({ ...shot(), tick: undefined }, 1);
    visuals.event({ ...shot(), endPosition: undefined }, 1);
    visuals.event({ ...shot(), endPosition: { x: NaN, y: 40, z: 120 } }, 1);
    visuals.event({ ...shot(), position: { x: Infinity, y: 40, z: 20 } }, 1);
    visuals.event({ ...shot(), endPosition: shot().position }, 1);
    visuals.event(shot(), NaN);
    visuals.update(1.02);
    expect(mesh.count).toBe(0);
    visuals.dispose();
  });
});
