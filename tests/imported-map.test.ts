import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { convertVxl, decodeImportedMap, encodeImportedMap, importedBlock } from '../src/shared/imported-map';
import type { ImportedMap } from '../src/shared/imported-map';
import { importVxl } from '../scripts/import-vxl';

const red = 0x7fd02010, green = 0x7f20d030, blue = 0x7f1030d0;
const color = (packed: number, alpha = 255): number[] => [packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, alpha];
const ground = [0, 60, 60, 0, ...color(green)];

function vxl(special: number[] = ground, index = 0): Uint8Array {
  const data = new Uint8Array(512 * 512 * 8 + special.length - 8);
  let cursor = 0;
  for (let column = 0; column < 512 * 512; column++) {
    const bytes = column === index ? special : ground;
    data.set(bytes, cursor);
    cursor += bytes.length;
  }
  return data;
}

const sample: ImportedMap = { size: 2, height: 8, offsets: new Uint32Array([0, 4, 6, 6, 8]),
  runs: new Uint32Array([3 << 16, red, 5 | (8 << 16), blue, 3 | (8 << 16), green, 8 << 16, 0x7f000000]) };

describe('compact imported map format', () => {
  test('round trips exact bounds, colors, empty columns and air gaps with little endian encoding', () => {
    const encoded = encodeImportedMap(sample);
    expect([...encoded.slice(0, 8)]).toEqual([85, 67, 77, 49, 2, 0, 8, 0]);
    const decoded = decodeImportedMap(encoded);
    expect(decoded).toEqual(sample);
    const expected = [[red, red, red, 0, 0, blue, blue, blue], [0, 0, 0, green, green, green, green, green],
      Array(8).fill(0), Array(8).fill(0x7f000000)];
    for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) for (let y = 0; y < 8; y++) {
      expect(importedBlock(decoded, x, y, z)).toBe(expected[x + z * 2][y]);
    }
    expect([...encodeImportedMap(decoded)]).toEqual([...encoded]);
  });

  test('accepts an unaligned input view and owns decoded buffers', () => {
    const encoded = encodeImportedMap(sample), padded = new Uint8Array(encoded.length + 7);
    padded.set(encoded, 3);
    const decoded = decodeImportedMap(padded.subarray(3, 3 + encoded.length));
    padded.fill(0);
    expect(decoded).toEqual(sample);
  });

  test('out of bounds and noninteger reads return air', () => {
    for (const [x, y, z] of [[-1, 0, 0], [2, 0, 0], [0, -1, 0], [0, 8, 0], [0, 0, 2],
      [0.5, 0, 0], [0, NaN, 0], [0, 0, Infinity]]) expect(importedBlock(sample, x, y, z)).toBe(0);
  });

  test('rejects invalid headers, counts, dimensions, truncation and excess bytes before allocation', () => {
    const encoded = encodeImportedMap(sample);
    for (const length of [0, 15, encoded.length - 1]) expect(() => decodeImportedMap(encoded.slice(0, length))).toThrow();
    expect(() => decodeImportedMap(new Uint8Array([...encoded, 0]))).toThrow();
    for (const [offset, value] of [[0, 0], [4, 0], [4, 0xffffffff], [8, 0xffffffff], [12, 0xffffffff]]) {
      const invalid = encoded.slice();
      new DataView(invalid.buffer).setUint32(offset, value, true);
      expect(() => decodeImportedMap(invalid)).toThrow();
    }
  });

  test('rejects offsets outside runs, overlaps, backwards ranges and invalid health', () => {
    const badOffsets = [[2, 4, 6, 6, 8], [0, 5, 6, 6, 8], [0, 8, 6, 6, 8], [0, 4, 6, 10, 8], [0, 4, 6, 6, 6]];
    for (const offsets of badOffsets) {
      expect(() => encodeImportedMap({ ...sample, offsets: new Uint32Array(offsets) })).toThrow();
      const bytes = encodeImportedMap(sample), view = new DataView(bytes.buffer);
      offsets.forEach((value, index) => view.setUint32(16 + index * 4, value, true));
      expect(() => decodeImportedMap(bytes)).toThrow();
    }
    for (const [index, value] of [[0, 0], [0, 9 << 16], [2, 2 | (8 << 16)], [2, 8 | (5 << 16)], [1, 0], [1, 0xffd02010]]) {
      const runs = sample.runs.slice();
      runs[index] = value;
      expect(() => encodeImportedMap({ ...sample, runs })).toThrow();
    }
  });
});

describe('Ace of Spades VXL conversion', () => {
  test('preserves native coordinates, BGRA surface colors and implicit solid below the surface', () => {
    const source = vxl([0, 10, 11, 255, ...color(red, 0), ...color(blue, 99)], 2 + 3 * 512);
    const map = convertVxl(source);
    expect([map.size, map.height, map.offsets.length]).toEqual([512, 64, 512 * 512 + 1]);
    expect(importedBlock(map, 2, 53, 3)).toBe(red);
    expect(importedBlock(map, 2, 52, 3)).toBe(blue);
    expect(importedBlock(map, 2, 54, 3)).toBe(0);
    for (const y of [0, 1, 20, 51]) expect(importedBlock(map, 2, y, 3)).toBe(blue);
    expect(importedBlock(map, 3, 53, 2)).toBe(0);
    expect(importedBlock(map, 511, 3, 511)).toBe(green);
    expect(importedBlock(map, 511, 4, 511)).toBe(0);
    expect(map.runs.byteLength + map.offsets.byteLength).toBeLessThan(4 * 1024 * 1024);
  });

  test('preserves overhangs, their bottom colors, enclosed air and nearest-surface interior colors', () => {
    const source = vxl([5, 10, 11, 0, ...color(red), ...color(red), ...color(blue), ...color(blue),
      0, 40, 41, 22, ...color(green), ...color(green)]);
    const map = decodeImportedMap(encodeImportedMap(convertVxl(source)));
    for (let depth = 0; depth < 64; depth++) {
      const expected = depth < 10 || (depth >= 22 && depth < 40) ? 0
        : depth >= 40 ? green : depth <= 15 ? red : blue;
      expect(importedBlock(map, 0, 63 - depth, 0)).toBe(expected);
    }
  });

  test('supports consecutive spans without an air gap and without bottom colors', () => {
    const map = convertVxl(vxl([2, 1, 1, 0, ...color(red), 0, 3, 3, 3, ...color(blue)]));
    expect(importedBlock(map, 0, 63, 0)).toBe(0);
    expect(importedBlock(map, 0, 62, 0)).toBe(red);
    expect(importedBlock(map, 0, 61, 0)).toBe(red);
    expect(importedBlock(map, 0, 60, 0)).toBe(blue);
    expect(importedBlock(map, 0, 0, 0)).toBe(blue);
  });

  test('preserves all 64 distinct colored blocks including the bottom voxel', () => {
    const colors = Array.from({ length: 64 }, (_, i) => 0x7f001000 | i);
    const map = convertVxl(vxl([0, 0, 63, 0, ...colors.flatMap(value => color(value))]));
    for (let depth = 0; depth < 64; depth++) expect(importedBlock(map, 0, 63 - depth, 0)).toBe(colors[depth]);
  });

  test('accepts zero-length top colors used by legacy maps and preserves their bottom surface', () => {
    const map = convertVxl(vxl([2, 10, 9, 0, ...color(blue), 0, 40, 40, 22, ...color(green)]));
    expect(importedBlock(map, 0, 54, 0)).toBe(0);
    for (let depth = 10; depth < 22; depth++) expect(importedBlock(map, 0, 63 - depth, 0)).toBe(blue);
    expect(importedBlock(map, 0, 41, 0)).toBe(0);
    expect(importedBlock(map, 0, 23, 0)).toBe(green);
  });

  test('accepts terminal columns without colors, retaining implicit solid and truly empty columns', () => {
    const solid = convertVxl(vxl([0, 63, 62, 0]));
    expect(importedBlock(solid, 0, 0, 0)).toBe(0x7f7f7f7f);
    expect(importedBlock(solid, 0, 1, 0)).toBe(0);
    const empty = convertVxl(vxl([0, 64, 63, 0]));
    expect(importedBlock(empty, 0, 0, 0)).toBe(0);
    expect(importedBlock(empty, 1, 0, 0)).toBe(green);
  });

  test('rejects malformed spans, reversed or overlapping positions and trailing data', () => {
    const normal = vxl();
    expect(() => convertVxl(normal.slice(0, -4))).toThrow();
    expect(() => convertVxl(new Uint8Array([...normal, 0, 0, 0, 0]))).toThrow();
    for (const [offset, value] of [[0, 1], [0, 255], [1, 61], [2, 64]]) {
      const malformed = normal.slice();
      malformed[offset] = value;
      expect(() => convertVxl(malformed)).toThrow();
    }
    for (const special of [
      [3, 10, 10, 0, ...color(red), ...color(blue), 0, 30, 30, 10, ...color(green)],
      [2, 10, 10, 0, ...color(red), 0, 20, 20, 21, ...color(green)],
      [2, 10, 10, 0, ...color(red), 0, 40, 40, 64, ...color(green)],
    ]) expect(() => convertVxl(vxl(special))).toThrow();
    const unterminated = normal.slice();
    unterminated[unterminated.length - 8] = 2;
    expect(() => convertVxl(unterminated)).toThrow();
  });
});

describe('VXL import CLI', () => {
  test('recurses, hashes exact output, records failures and never executes companion metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ubercube-vxl-'));
    try {
      const input = join(root, 'input'), output = join(root, 'output');
      await mkdir(join(input, 'nested'), { recursive: true });
      const source = vxl();
      await writeFile(join(input, 'nested', 'Café map.VXL'), source);
      await writeFile(join(input, 'nested', 'Café map.txt'), 'raise Exception("must never execute metadata")');
      await writeFile(join(input, 'bad.vxl'), new Uint8Array(16));
      await expect(importVxl([input, `--output=${output}`])).rejects.toThrow('1 map(s) rejected');
      const report = JSON.parse(await readFile(join(output, 'import-report.json'), 'utf8'));
      expect(report.version).toBe(1);
      expect(report.maps).toHaveLength(1);
      expect(report.failed).toHaveLength(1);
      const entry = report.maps[0];
      expect(entry.id).toMatch(/^cafe-map-[a-f0-9]{12}$/);
      expect(entry.file).toBe(`${entry.hash}.ucmap`);
      const encoded = await readFile(join(output, entry.file));
      expect(createHash('sha256').update(encoded).digest('hex')).toBe(entry.hash);
      expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sourceSha256);
      expect(importedBlock(decodeImportedMap(encoded), 511, 0, 511)).toBe(green);
      expect((await readdir(output)).sort()).toEqual([entry.file, 'import-report.json'].sort());
      expect(entry.license).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('requires one input and an explicit output directory', async () => {
    for (const args of [[], ['map.vxl'], ['map.vxl', '--output='], ['map.vxl', '--output=out', '--other']]) {
      await expect(importVxl(args)).rejects.toThrow('Usage:');
    }
  });
});
