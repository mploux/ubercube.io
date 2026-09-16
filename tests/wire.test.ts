import { describe, expect, test } from 'bun:test';
import { decodeServerMessage, encodeServerMessage, serverMessageType } from '../src/shared/wire';
import type { DeathPlayerState, GameEvent, ServerMessage, VoxelEdit } from '../src/shared/protocol';

const deathPlayer: DeathPlayerState = { id: 7, weapon: 'awp', alive: false, aiming: true, deaths: 2,
  position: { x: 16.123456789, y: 8, z: 92 }, velocity: { x: 1, y: 2, z: -6 }, yaw: .2, pitch: -.4 };
test('pong remains human-readable JSON', () => {
  const event: ServerMessage = { type: 'pong', time: 42 };
  expect(decodeServerMessage(encodeServerMessage(event))).toEqual(event);
});

test('binary hitscan events preserve the complete ray and command correlation exactly', () => {
  const event: ServerMessage = { type: 'event', event: 'shot', roundId: 12, tick: 221,
    shooterId: 7, weapon: 'awp', projectileId: 3, inputSeq: 4294967400,
    position: { x: 16.123456789, y: 10.27345, z: 89.3 }, endPosition: { x: 16.123456789, y: 10.27345, z: 0 } };
  const encoded = encodeServerMessage(event);
  expect(encoded).toBeInstanceOf(Uint8Array);
  expect(decodeServerMessage(encoded)).toEqual(event);
});
const world: Extract<ServerMessage, { type: 'world' }> = {
  type: 'world', roundId: 12, revision: 321, initial: true, complete: false,
  edits: [[123, 45, 231, 0x7fabcdef], [15, 17, 19, 0]],
};
const eventBase: GameEvent = { type: 'event', event: 'impact', roundId: 12,
  position: { x: 16.123456789, y: -0, z: 89.3 } };
const eventOptions = {
  shooterId: 7, targetId: 123, weapon: 'awp' as const, headshot: true,
  blockColor: 0xc0ffee, projectileId: 321, velocity: { x: -16.123456789, y: 0, z: 1e-200 },
  tick: 654321, inputSeq: 4294967400, endPosition: { x: 0, y: 27.23894756783, z: -Number.MIN_VALUE },
};
const frequentEvents = ['shot', 'impact', 'explosion', 'heal', 'build', 'projectile-end'] as const;

describe('binary terrain batches', () => {
  test('preserves all combinations of absent, false and true synchronization flags', () => {
    for (const initial of [undefined, false, true]) for (const complete of [undefined, false, true]) {
      const message: typeof world = { type: 'world', roundId: 12, revision: 321, edits: world.edits,
        ...(initial === undefined ? {} : { initial }), ...(complete === undefined ? {} : { complete }) };
      const encoded = encodeServerMessage(message);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(decodeServerMessage(encoded)).toStrictEqual(message);
    }
  });

  test('preserves empty terminators and the maximum representable coordinates and values', () => {
    for (const edits of [[], [[65535, 32767, 65535, 0xffffffff], [0, 0, 0, 0]]] as VoxelEdit[][]) {
      const message: typeof world = { ...world, roundId: 0xffffffff, revision: 0xffffffff, edits, complete: true };
      expect(decodeServerMessage(encodeServerMessage(message))).toStrictEqual(message);
    }
  });

  test('admits 512 edits but rejects oversized and inconsistent counts before decoding records', () => {
    const edits: VoxelEdit[] = Array.from({ length: 512 }, (_, index) => [index % 256, 48, index >> 8, 0x7fabcdef]);
    const encoded = encodeServerMessage({ ...world, edits }) as Uint8Array;
    expect(encoded.byteLength).toBe(5137);
    expect(decodeServerMessage(encoded)).toStrictEqual({ ...world, edits });
    expect(() => encodeServerMessage({ ...world, edits: [...edits, [0, 0, 0, 0]] })).toThrow();
    for (const count of [0, 511, 513, 65535]) {
      const corrupted = encoded.slice();
      new DataView(corrupted.buffer).setUint16(15, count, true);
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
    const oversized = new Uint8Array(17 + 513 * 10);
    oversized.set(encoded);
    new DataView(oversized.buffer).setUint16(15, 513, true);
    expect(() => decodeServerMessage(oversized)).toThrow();
  });

  test('rejects unknown flags and values without a presence bit', () => {
    for (const flags of [2, 8, 16, 32, 128, 255]) {
      const encoded = encodeServerMessage(world) as Uint8Array;
      encoded[14] = flags;
      expect(() => decodeServerMessage(encoded)).toThrow();
    }
  });

  test.each([-1, 65536, 1.5, NaN, Infinity])('does not silently wrap invalid coordinates: %s', value => {
    for (const axis of [0, 1, 2]) {
      const edit: VoxelEdit = [0, 0, 0, 0]; edit[axis] = value;
      expect(() => encodeServerMessage({ ...world, edits: [edit] })).toThrow();
    }
  });

  test.each([-1, 0x100000000, 1.5, NaN, Infinity])('does not silently wrap invalid revisions or block values: %s', value => {
    expect(() => encodeServerMessage({ ...world, revision: value })).toThrow();
    expect(() => encodeServerMessage({ ...world, roundId: value })).toThrow();
    expect(() => encodeServerMessage({ ...world, edits: [[0, 0, 0, value]] })).toThrow();
  });
});

describe('binary combat events', () => {
  test.each([...frequentEvents])('%s preserves every optional-field combination exactly', event => {
    const fields = Object.entries(eventOptions);
    for (let mask = 0; mask < 1 << fields.length; mask++) {
      const message: GameEvent = { ...eventBase, event };
      for (const [index, [key, value]] of fields.entries()) if (mask & (1 << index)) Object.assign(message, { [key]: value });
      if (message.headshot !== undefined) message.headshot = !!(mask & 1);
      const encoded = encodeServerMessage(message);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(decodeServerMessage(encoded)).toStrictEqual(message);
    }
  });

  test('preserves zero values, explicit false, uint32 maxima and safe large command sequences', () => {
    for (const value of [0, 0xffffffff]) {
      const message: GameEvent = { ...eventBase, shooterId: value, targetId: value, projectileId: value,
        tick: value, blockColor: value, headshot: false, inputSeq: value === 0 ? 0 : Number.MAX_SAFE_INTEGER };
      expect(decodeServerMessage(encodeServerMessage(message))).toStrictEqual(message);
    }
  });

  test('keeps death payloads in JSON without losing corpse state, hit point or impulse', () => {
    for (const event of ['death', 'shot'] as const) {
      const message: GameEvent = { ...eventBase, event, ...eventOptions, position: { x: 1, y: 2, z: 3 },
        velocity: { x: 1, y: 2, z: 3 }, endPosition: { x: 4, y: 5, z: 6 },
        death: { player: deathPlayer, hitPoint: { x: 1.23456789, y: 2, z: 3 }, impulse: { x: 80, y: -40, z: 48 } } };
      const encoded = encodeServerMessage(message);
      expect(typeof encoded).toBe('string');
      expect(decodeServerMessage(encoded)).toStrictEqual(message);
    }
    const message: GameEvent = { ...eventBase, event: 'death', position: { x: 1, y: 2, z: 3 } };
    expect(typeof encodeServerMessage(message)).toBe('string');
    expect(decodeServerMessage(encodeServerMessage(message))).toStrictEqual(message);
  });

  test('rejects unknown event and weapon enums', () => {
    const encoded = encodeServerMessage({ ...eventBase, weapon: 'awp' }) as Uint8Array;
    for (const value of [6, 255]) {
      const corrupted = encoded.slice(); corrupted[10] = value;
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
    for (const value of [5, 255]) {
      const corrupted = encoded.slice(); corrupted[37] = value;
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
  });

  test('rejects unknown flag bits and a headshot value without presence', () => {
    for (const flags of [16, 2048, 32768, 65535]) {
      const encoded = encodeServerMessage(eventBase) as Uint8Array;
      new DataView(encoded.buffer).setUint16(11, flags, true);
      expect(() => decodeServerMessage(encoded)).toThrow();
    }
  });

  test.each([NaN, Infinity, -Infinity])('rejects non-finite event vectors on both sides: %s', value => {
    for (const key of ['position', 'velocity', 'endPosition'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(() => encodeServerMessage({ ...eventBase, [key]: { x: 0, y: 0, z: 0, [axis]: value } })).toThrow();
      }
    }
    const encoded = encodeServerMessage({ ...eventBase, ...eventOptions }) as Uint8Array;
    for (const offset of [13, 21, 29, 54, 62, 70, 90, 98, 106]) {
      const corrupted = encoded.slice(); new DataView(corrupted.buffer).setFloat64(offset, value, true);
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects invalid command sequences: %s', value => {
    expect(() => encodeServerMessage({ ...eventBase, inputSeq: value })).toThrow();
    const encoded = encodeServerMessage({ ...eventBase, inputSeq: 1 }) as Uint8Array;
    new DataView(encoded.buffer).setFloat64(37, value, true);
    expect(() => decodeServerMessage(encoded)).toThrow();
  });
});

describe('wire frame boundaries', () => {
  const frames: ServerMessage[] = [world, { ...eventBase, ...eventOptions }];

  test('rejects truncation at every byte and trailing bytes for every binary message kind', () => {
    const batch: typeof world = { ...world, edits: Array.from({ length: 512 }, (_, index) => [index, 12, 23, 0x7f123456]) };
    for (const message of [...frames, batch]) {
      const encoded = encodeServerMessage(message) as Uint8Array;
      for (let length = 0; length < encoded.length; length++) expect(() => decodeServerMessage(encoded.subarray(0, length))).toThrow();
      for (const tail of [1, 16]) {
        const oversized = new Uint8Array(encoded.length + tail); oversized.set(encoded);
        expect(() => decodeServerMessage(oversized)).toThrow();
      }
    }
  });

  test('decodes subviews without reading surrounding bytes', () => {
    for (const message of frames) {
      const encoded = encodeServerMessage(message) as Uint8Array;
      const padded = new Uint8Array(encoded.length + 37).fill(255); padded.set(encoded, 13);
      const expected = decodeServerMessage(encoded);
      for (const view of [padded.subarray(13, 13 + encoded.length), new DataView(padded.buffer, 13, encoded.length)]) {
        expect(decodeServerMessage(view)).toStrictEqual(expected);
        expect(serverMessageType(view)).toBe(message.type);
      }
      expect(decodeServerMessage(new Uint8Array(encoded).buffer)).toStrictEqual(expected);
    }
  });

  test('rejects unknown magic, versions and message kinds in decoder and classifier', () => {
    for (const message of frames) {
      const encoded = encodeServerMessage(message) as Uint8Array;
      for (const [offset, value] of [[0, 0], [4, 0], [4, 1], [4, 2], [4, 3], [4, 4], [4, 255], [5, 0], [5, 6], [5, 255]]) {
        const corrupted = encoded.slice(); corrupted[offset] = value;
        expect(() => decodeServerMessage(corrupted)).toThrow();
        expect(() => serverMessageType(corrupted)).toThrow();
      }
      for (let length = 0; length < 6; length++) expect(() => serverMessageType(encoded.subarray(0, length))).toThrow();
    }
  });

  test('classifies outgoing JSON and binary frames without parsing their full payload', () => {
    const json: ServerMessage[] = [
      { type: 'welcome', id: 1, roundId: 2, mode: 'ffa', maxPlayers: 100, world: { seed: 1, size: 256, height: 64 }, tickRate: 60 },
      { type: 'reset', roundId: 3, world: { seed: 1, size: 256, height: 64 } },
      { type: 'error', message: 'Erreur de connexion Élodie 🧊', fatal: false },
      { type: 'pong', time: 12345 }, { ...eventBase, event: 'death' },
    ];
    for (const message of [...frames, ...json]) expect(serverMessageType(encodeServerMessage(message))).toBe(message.type);
    expect(serverMessageType('{"type":"error","message":')).toBe('error');
    expect(() => serverMessageType('{"type":"hello"}')).toThrow();
    expect(() => serverMessageType('{"type":"world-extra"}')).toThrow();
  });

});

describe('public metadata and fatal poses', () => {
  test('whitelists roster metadata and death fields even when callers pass wider objects', () => {
    const privatePlayer = { ...deathPlayer, name: 'Élodie 🧊', team: 2 as const, health: 43, ammo: 8, grenades: 7,
      kit: 'sniper', lastSeq: 999, grounded: true, kills: 123 };
    const roster: ServerMessage = { type: 'roster', upserts: [privatePlayer], removed: [] };
    const encodedRoster = encodeServerMessage(roster);
    expect(serverMessageType(encodedRoster)).toBe('roster');
    expect(decodeServerMessage(encodedRoster)).toEqual({ type: 'roster', upserts: [{ id: 7, name: 'Élodie 🧊', team: 2 }], removed: [] });
    const death: GameEvent = { ...eventBase, event: 'death', death: { player: privatePlayer,
      hitPoint: { x: 1.23456789, y: 2, z: 3 }, impulse: { x: 80, y: -40, z: 48 } } };
    const encoded = encodeServerMessage(death) as string;
    expect(JSON.parse(encoded).death.player).toEqual(deathPlayer);
    for (const key of ['health', 'ammo', 'grenades', 'kit', 'lastSeq', 'grounded', 'kills', 'name', 'team']) {
      expect(encoded).not.toContain(`"${key}"`);
    }
    expect((decodeServerMessage(JSON.stringify(death)) as GameEvent).death?.player).toEqual(deathPlayer);
  });

  test('bounds Unicode names in UTF-8, identities, teams and roster operations', () => {
    const valid: Extract<ServerMessage, { type: 'roster' }> = { type: 'roster', upserts: [{ id: 1, name: 'é'.repeat(127), team: 0 }], removed: [2] };
    expect(decodeServerMessage(encodeServerMessage(valid))).toEqual(valid);
    const invalid = [
      { ...valid, upserts: [{ id: 1, name: 'é'.repeat(128), team: 0 }] },
      { ...valid, upserts: [{ id: 0, name: '', team: 0 }] },
      { ...valid, upserts: [{ id: 1.5, name: '', team: 0 }] },
      { ...valid, upserts: [{ id: 1, name: '', team: 3 }] },
      { ...valid, upserts: [valid.upserts[0], valid.upserts[0]] },
      { ...valid, removed: [1] }, { ...valid, removed: [2, 2] },
      { ...valid, removed: [0xffffffff + 1] }, { ...valid, removed: Array(1001).fill(2) },
      { ...valid, upserts: Array(1001).fill(valid.upserts[0]) }, { ...valid, upserts: null },
    ];
    for (const message of invalid) {
      expect(() => encodeServerMessage(message as ServerMessage)).toThrow();
      expect(() => decodeServerMessage(JSON.stringify(message))).toThrow();
    }
  });
});
