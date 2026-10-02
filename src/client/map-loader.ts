import { decodeImportedMap, type ImportedMap } from '../shared/imported-map';
import type { WorldConfig } from '../shared/protocol';

// Web Crypto is unavailable on HTTP LAN servers used for local/mobile games.
export function mapSha256(bytes: Uint8Array): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const block = new Uint8Array(64), view = new DataView(block.buffer), words = new Uint32Array(64);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const rotate = (word: number, bits: number) => (word >>> bits) | (word << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    block.fill(0); block.set(bytes.subarray(offset, offset + 64));
    if (offset <= bytes.length && bytes.length < offset + 64) block[bytes.length - offset] = 0x80;
    if (offset + 64 === length) {
      view.setUint32(56, Math.floor(bytes.length / 0x20000000)); view.setUint32(60, bytes.length * 8);
    }
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3))
        + words[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const result = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) hash[i] += result[i];
  }
  return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
}

export async function loadImportedMap(config: WorldConfig, origin: string, signal: AbortSignal): Promise<ImportedMap | undefined> {
  if (!config.map) return undefined;
  const { hash } = config.map;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid map hash');
  const response = await fetch(new URL(`/maps/${hash}.ucmap`, origin), { signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw new Error('Map download failed');
  const limit = 16 + (config.size * config.size + 1) * 4 + config.size * config.size * config.height * 8;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Map download exceeds world bounds');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const digest = globalThis.crypto?.subtle
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
    : mapSha256(bytes);
  if (digest !== hash) throw new Error('Map checksum mismatch');
  const map = decodeImportedMap(bytes);
  if (map.size !== config.size || map.height !== config.height) throw new Error('Map dimensions mismatch');
  return map;
}
