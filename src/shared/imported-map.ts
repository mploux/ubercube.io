export interface ImportedMap {
  size: number;
  height: number;
  /** Word offsets into runs, indexed by x + z * size, with one final sentinel. */
  offsets: Uint32Array;
  /** Pairs of [startY | (exclusiveEndY << 16), 0x7fRRGGBB]; air is implicit. */
  runs: Uint32Array;
}

const MAGIC = 0x314d4355; // UCM1, little endian.
const HEADER_BYTES = 16;
const VXL_SIZE = 512;
const VXL_HEIGHT = 64;
const MAX_VOXELS = VXL_SIZE * VXL_SIZE * VXL_HEIGHT;

function validateDimensions(size: number, height: number): void {
  if (!Number.isInteger(size) || size < 1 || size > VXL_SIZE
    || !Number.isInteger(height) || height < 1 || height > 256 || size * size * height > MAX_VOXELS) {
    throw new Error('Invalid imported map dimensions');
  }
}

function validateMap(map: ImportedMap): void {
  validateDimensions(map.size, map.height);
  const { offsets, runs } = map;
  if (!(offsets instanceof Uint32Array) || !(runs instanceof Uint32Array)
    || offsets.length !== map.size * map.size + 1 || offsets[0] !== 0
    || runs.length % 2 !== 0 || runs.length > map.size * map.size * map.height * 2
    || offsets[offsets.length - 1] !== runs.length) {
    throw new Error('Invalid imported map column index');
  }
  for (let column = 0; column < offsets.length - 1; column++) {
    const first = offsets[column], limit = offsets[column + 1];
    if (first > limit || limit > runs.length || limit % 2 !== 0) {
      throw new Error('Invalid imported map column offset');
    }
    let previousEnd = 0;
    for (let i = first; i < limit; i += 2) {
      const start = runs[i] & 0xffff, end = runs[i] >>> 16;
      if (start < previousEnd || start >= end || end > map.height || (runs[i + 1] >>> 24) !== 127) {
        throw new Error('Invalid imported map solid run');
      }
      previousEnd = end;
    }
  }
}

export function encodeImportedMap(map: ImportedMap): Uint8Array {
  validateMap(map);
  const bytes = new Uint8Array(HEADER_BYTES + (map.offsets.length + map.runs.length) * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, map.size, true);
  view.setUint16(6, map.height, true);
  view.setUint32(8, map.size * map.size, true);
  view.setUint32(12, map.runs.length, true);
  let cursor = HEADER_BYTES;
  for (const words of [map.offsets, map.runs]) for (const word of words) {
    view.setUint32(cursor, word, true);
    cursor += 4;
  }
  return bytes;
}

export function decodeImportedMap(bytes: Uint8Array): ImportedMap {
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Truncated imported map header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('Unsupported imported map format');
  const size = view.getUint16(4, true), height = view.getUint16(6, true);
  validateDimensions(size, height);
  const columns = view.getUint32(8, true), words = view.getUint32(12, true);
  if (columns !== size * size || words % 2 !== 0 || words > columns * height * 2
    || bytes.byteLength !== HEADER_BYTES + (columns + 1 + words) * 4) {
    throw new Error('Invalid imported map byte length or counts');
  }
  const offsets = new Uint32Array(columns + 1), runs = new Uint32Array(words);
  let cursor = HEADER_BYTES;
  for (const destination of [offsets, runs]) for (let i = 0; i < destination.length; i++) {
    destination[i] = view.getUint32(cursor, true);
    cursor += 4;
  }
  const map = { size, height, offsets, runs };
  validateMap(map);
  return map;
}

export function importedBlock(map: ImportedMap, x: number, y: number, z: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)
    || x < 0 || y < 0 || z < 0 || x >= map.size || y >= map.height || z >= map.size) return 0;
  const column = x + z * map.size;
  let low = map.offsets[column] / 2, high = map.offsets[column + 1] / 2;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), range = map.runs[middle * 2];
    if (y < (range & 0xffff)) high = middle;
    else if (y >= (range >>> 16)) low = middle + 1;
    else return map.runs[middle * 2 + 1];
  }
  return 0;
}

/** AoS v1: https://www.piqueserver.org/aosprotocol/mapformat.html (public-domain specification). */
export function convertVxl(bytes: Uint8Array): ImportedMap {
  const columns = VXL_SIZE * VXL_SIZE;
  if (bytes.length < columns * 4 || bytes.length > MAX_VOXELS * 8 || bytes.length % 4 !== 0) {
    throw new Error('Invalid VXL byte length; expected an uncompressed 512 x 512 x 64 AoS map');
  }
  const offsets = new Uint32Array(columns + 1), column = new Uint32Array(VXL_HEIGHT);
  let runs = new Uint32Array(columns * 2), used = 0, cursor = 0;
  for (let index = 0; index < columns; index++) {
    offsets[index] = used;
    column.fill(0);
    let airStart = 0;
    for (;;) {
      if (cursor + 4 > bytes.length) throw new Error(`Truncated VXL span at column ${index}`);
      const chunks = bytes[cursor], start = bytes[cursor + 1], end = bytes[cursor + 2];
      if (start < airStart || end < start - 1 || end >= VXL_HEIGHT || start > VXL_HEIGHT) {
        throw new Error(`Invalid VXL top span at column ${index}`);
      }
      const topCount = end - start + 1, bottomCount = chunks ? chunks - 1 - topCount : 0;
      const next = cursor + (chunks || topCount + 1) * 4;
      if (bottomCount < 0 || chunks > VXL_HEIGHT + 1 || next > bytes.length
        || (chunks !== 0 && next + 4 > bytes.length)) {
        throw new Error(`Invalid or truncated VXL color run at column ${index}`);
      }
      const solidEnd = chunks ? bytes[next + 3] : VXL_HEIGHT;
      const bottomStart = solidEnd - bottomCount;
      if (bottomStart < end + 1 || solidEnd > VXL_HEIGHT || (chunks !== 0 && solidEnd >= VXL_HEIGHT)) {
        throw new Error(`Invalid VXL bottom span at column ${index}`);
      }
      let colorOffset = cursor + 4;
      for (let depth = start; depth <= end; depth++, colorOffset += 4) {
        column[depth] = (0x7f000000 | (bytes[colorOffset + 2] << 16)
          | (bytes[colorOffset + 1] << 8) | bytes[colorOffset]) >>> 0;
      }
      for (let depth = bottomStart; depth < solidEnd; depth++, colorOffset += 4) {
        column[depth] = (0x7f000000 | (bytes[colorOffset + 2] << 16)
          | (bytes[colorOffset + 1] << 8) | bytes[colorOffset]) >>> 0;
      }
      // Hidden solids have no stored color; inherit the nearest vertical surface, ties toward the sky.
      for (let depth = end + 1; depth < bottomStart; depth++) {
        column[depth] = (bottomCount && (!topCount || bottomStart - depth < depth - end))
          ? column[bottomStart] : column[end] || 0x7f7f7f7f;
      }
      cursor = next;
      if (chunks === 0) break;
      airStart = solidEnd;
    }
    for (let y = 0; y < VXL_HEIGHT;) {
      const value = column[VXL_HEIGHT - 1 - y], start = y++;
      while (y < VXL_HEIGHT && column[VXL_HEIGHT - 1 - y] === value) y++;
      if (!value) continue;
      if (used + 2 > runs.length) {
        const expanded = new Uint32Array(Math.min(MAX_VOXELS * 2, runs.length * 2));
        expanded.set(runs);
        runs = expanded;
      }
      runs[used++] = start | (y << 16);
      runs[used++] = value;
    }
  }
  if (cursor !== bytes.length) throw new Error('Unexpected trailing VXL data');
  offsets[columns] = used;
  return { size: VXL_SIZE, height: VXL_HEIGHT, offsets, runs: runs.slice(0, used) };
}
