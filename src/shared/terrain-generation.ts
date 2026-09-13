import type { WorldConfig } from './protocol';

const f = Math.fround;
const WORD = 0x1000000;

// Java's 48-bit Random, split into exact 24-bit integer limbs for browsers.
export class JavaRandom {
  private low: number;
  private high: number;

  constructor(seed: number) {
    seed = ((seed % 0x1000000000000) + 0x1000000000000) % 0x1000000000000;
    this.low = (seed % WORD) ^ 0xece66d;
    this.high = (Math.floor(seed / WORD) % WORD) ^ 0x5de;
  }

  private next(bits: number): number {
    const product = this.low * 0xece66d + 11;
    this.high = (this.high * 0xece66d + this.low * 0x5de + Math.floor(product / WORD)) % WORD;
    this.low = product % WORD;
    return bits <= 24 ? this.high >>> (24 - bits)
      : this.high * 2 ** (bits - 24) + (this.low >>> (48 - bits));
  }

  nextFloat(): number { return this.next(24) / WORD; }
  nextDouble(): number { return (this.next(26) * 0x8000000 + this.next(27)) / 0x20000000000000; }
}

export function terrainHash(x: number, z: number, seed: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}

function interpolate(a: number, b: number, t: number): number {
  const blend = f((1 - Math.cos(f(t * Math.PI))) * 0.5);
  return f(f(a * f(1 - blend)) + f(b * blend));
}

function lattice(x: number, z: number, seed: number): number {
  const randomSeed = Math.trunc(f(f(f(x * f(43594546)) + f(z * f(29438876))) + f(seed)));
  return f(new JavaRandom(randomSeed).nextDouble());
}

function pass(x: number, z: number, seed: number, octave: number, amplitude: number, height: number, inverse: number): number {
  const ix = Math.trunc(x / octave), iz = Math.trunc(z / octave);
  const u = f((x - ix * octave) / octave), v = f((z - iz * octave) / octave);
  const a = interpolate(lattice(ix, iz, seed), lattice(ix + 1, iz, seed), u);
  const b = interpolate(lattice(ix, iz + 1, seed), lattice(ix + 1, iz + 1, seed), u);
  const value = interpolate(a, b, v);
  return f(f(f(f(f(value * 2) - 1) * inverse) + f(height)) * amplitude);
}

// Game.createWorld selects SNOWY: preserve its three max-combined noise passes.
export function terrainHeight(config: WorldConfig, x: number, z: number): number {
  x = f(x); z = f(z);
  const height = f(Math.max(pass(x, z, config.seed, 60, 5, 0, 1),
    pass(x, z, config.seed, 40, 10, 0.4, -1), pass(x, z, config.seed, 40, 15, 0.45, -1)) + 8);
  return Math.max(2, Math.min(config.height - 12, height));
}
