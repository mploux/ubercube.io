import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { parseWeaponModel, WEAPON_MODEL_FILES } from '../src/client/weapon-model';
import type { WeaponId } from '../src/shared/protocol';

const expectedFaces: Record<WeaponId, number> = { ak47: 2308, awp: 1996, grenade: 102, shovel: 116, medic: 616, rpg: 1176 };
const expectedPalette: Record<WeaponId, number> = { ak47: 4, awp: 8, grenade: 3, shovel: 2, medic: 3, rpg: 9 };

test.each(Object.keys(WEAPON_MODEL_FILES) as WeaponId[])('%s preserves every original face, normal and raw material color', weapon => {
  const path = `public/assets/weapons/${WEAPON_MODEL_FILES[weapon]}`;
  const obj = readFileSync(`${path}.obj`, 'utf8');
  const mtl = readFileSync(`${path}.mtl`, 'utf8');
  const colors = new Map<string, number[]>();
  let materialName = '';
  for (const line of mtl.split(/\r?\n/)) {
    const [key, ...values] = line.trim().split(/\s+/);
    if (key === 'newmtl') materialName = values[0];
    if (key === 'Kd') colors.set(materialName, values.map(Number));
  }
  const positions: number[][] = [], normals: number[][] = [];
  const expectedPositions: number[] = [], expectedNormals: number[] = [], expectedColors: number[] = [];
  const used = new Set<string>();
  for (const line of obj.split(/\r?\n/)) {
    const [key, ...values] = line.trim().split(/\s+/);
    if (key === 'v') positions.push(values.map(Number));
    if (key === 'vn') normals.push(values.map(Number));
    if (key === 'usemtl') materialName = values[0];
    if (key !== 'f') continue;
    expect(values).toHaveLength(3);
    used.add(materialName);
    for (const token of values) {
      const [positionIndex, , normalIndex] = token.split('/').map(Number);
      expectedPositions.push(...positions[positionIndex - 1]);
      expectedNormals.push(...normals[normalIndex - 1]);
      expectedColors.push(...colors.get(materialName)!);
    }
  }
  const model = parseWeaponModel(obj, mtl);
  const actualPositions: number[] = [], actualNormals: number[] = [], actualColors: number[] = [];
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    actualPositions.push(...object.geometry.getAttribute('position').array);
    actualNormals.push(...object.geometry.getAttribute('normal').array);
    actualColors.push(...object.geometry.getAttribute('color').array);
    expect(object.material).toBeInstanceOf(THREE.ShaderMaterial);
    expect((object.material as THREE.ShaderMaterial).toneMapped).toBe(false);
  });
  expect(actualPositions.length / 9).toBe(expectedFaces[weapon]);
  expect(used.size).toBe(expectedPalette[weapon]);
  expect(new Float32Array(actualPositions)).toEqual(new Float32Array(expectedPositions));
  expect(new Float32Array(actualNormals)).toEqual(new Float32Array(expectedNormals));
  expect(new Float32Array(actualColors)).toEqual(new Float32Array(expectedColors));
});

test('material switches on adjacent faces preserve both palettes without Phong specular or sRGB reinterpretation', () => {
  const obj = `v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nvn 0 0 1\nusemtl wood\nf 1//1 2//1 3//1\nusemtl metal\nf 2//1 4//1 3//1\n`;
  const mtl = `newmtl wood\nKd 0.25 0.09 0.03\nKs 1 1 1\nNs 200\nnewmtl metal\nKd 0.03 0.03 0.03\nKs 1 1 1\n`;
  const mesh = parseWeaponModel(obj, mtl).children[0] as THREE.Mesh;
  expect(mesh.geometry.getAttribute('color').array).toEqual(new Float32Array([
    .25, .09, .03, .25, .09, .03, .25, .09, .03,
    .03, .03, .03, .03, .03, .03, .03, .03, .03,
  ]));
  expect(mesh.geometry.groups).toHaveLength(0);
  expect(mesh.material).toBeInstanceOf(THREE.ShaderMaterial);
});

test('an unknown face palette is an error instead of a silently grey weapon', () => {
  expect(() => parseWeaponModel('v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl absent\nf 1 2 3\n', 'newmtl other\nKd 1 0 0\n')).toThrow('Missing diffuse palette');
});

test.each([['ak47', 496], ['medic', 212]] as const)('%s keeps the first palette on original coincident faces', (weapon, expectedConflicts) => {
  const path = `public/assets/weapons/${WEAPON_MODEL_FILES[weapon]}`;
  const model = parseWeaponModel(readFileSync(`${path}.obj`, 'utf8'), readFileSync(`${path}.mtl`, 'utf8'));
  const firstPalettes = new Map<string, string>();
  let conflicts = 0;
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    const colors = object.geometry.getAttribute('color');
    for (let i = 0; i < positions.count; i += 3) {
      const triangle = [i, i + 1, i + 2].map(vertex => [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)].join(',')).sort().join('|');
      const palette = [colors.getX(i), colors.getY(i), colors.getZ(i)].join(',');
      const first = firstPalettes.get(triangle);
      if (first !== undefined && first !== palette) {
        conflicts++;
        expect((object.material as THREE.ShaderMaterial).depthFunc).toBe(THREE.LessDepth);
      }
      if (first === undefined) firstPalettes.set(triangle, palette);
    }
  });
  expect(conflicts).toBe(expectedConflicts);
});
