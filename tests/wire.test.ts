import { describe, expect, test } from 'bun:test';
import { decodeServerMessage, encodeServerMessage, serverMessageType } from '../src/shared/wire';
import type { GameEvent, Kit, PlayerState, ServerMessage, VoxelEdit, WeaponId } from '../src/shared/protocol';

const snapshot: Extract<ServerMessage, { type: 'snapshot' }> = {
  type: 'snapshot', roundId: 12, tick: 220, scores: [12, 19], remaining: null,
  players: [{ id: 7, name: 'Élodie 🧊', team: 2, kit: 'sniper', weapon: 'awp', alive: true, grounded: true, aiming: true,
    position: { x: 16.123456, y: 8, z: 92 }, velocity: { x: 1, y: 0, z: -6 }, yaw: 0.2, pitch: -0.4,
    health: 70, kills: 3, deaths: 2, ammo: 4, grenades: 8, lastSeq: 4294967399 }],
  projectiles: [{ id: 2, owner: 7, weapon: 'grenade', position: { x: 1, y: 2, z: 3 }, velocity: { x: 4, y: 5, z: 6 } }],
};
test('binary snapshots preserve identity, state, Unicode and large input sequences', () => {
  const encoded = encodeServerMessage(snapshot);
  expect(encoded).toBeInstanceOf(Uint8Array);
  const result = decodeServerMessage(encoded) as typeof snapshot;
  expect(result.players[0].name).toBe(snapshot.players[0].name);
  expect(result.players[0].lastSeq).toBe(4294967399);
  expect(result.players[0].position.x).toBeCloseTo(snapshot.players[0].position.x, 4);
  expect(result.projectiles).toEqual(snapshot.projectiles);
  expect(result.scores).toEqual([12, 19]);
  expect(result.remaining).toBeNull();
  expect(result.players[0].alive && result.players[0].grounded).toBe(true);
  expect(result.players[0].aiming).toBe(true);
  expect((encoded as Uint8Array).byteLength).toBeLessThan(JSON.stringify(snapshot).length / 3);
});

test('aiming uses one packed flag bit and unscoped snapshots decode as not aiming', () => {
  const scoped = encodeServerMessage(snapshot) as Uint8Array;
  const hip = encodeServerMessage({ ...snapshot, players: [{ ...snapshot.players[0], aiming: false }] }) as Uint8Array;
  expect(scoped.length).toBe(hip.length);
  const differences = [...scoped].flatMap((byte, index) => byte === hip[index] ? [] : [index]);
  expect(differences).toEqual([32]);
  expect(scoped[32] ^ hip[32]).toBe(2);
  const legacy = decodeServerMessage(hip) as typeof snapshot;
  expect(legacy.players[0].aiming).toBe(false);
  expect(legacy.players[0].alive && legacy.players[0].grounded).toBe(true);
});
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
test('truncated frames and unknown versions are rejected', () => {
  const encoded = encodeServerMessage(snapshot) as Uint8Array;
  expect(() => decodeServerMessage(encoded.subarray(0, encoded.length - 1))).toThrow();
  encoded[4] = 255;
  expect(() => decodeServerMessage(encoded)).toThrow();
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
        death: { player: snapshot.players[0], hitPoint: { x: 1.23456789, y: 2, z: 3 }, impulse: { x: 80, y: -40, z: 48 } } };
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
  const frames: ServerMessage[] = [snapshot, world, { ...eventBase, ...eventOptions }];

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
      for (const [offset, value] of [[0, 0], [4, 0], [4, 1], [4, 2], [4, 255], [5, 0], [5, 6], [5, 255]]) {
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

  test('rejects invalid snapshot flags, enums, UTF-8, counts and numeric data', () => {
    const encoded = encodeServerMessage(snapshot) as Uint8Array;
    for (const [offset, value] of [[72, 255], [73, 255]]) {
      const corrupted = encoded.slice(); corrupted[offset] = value;
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
    for (const value of [3, 12, 80, 112, 1024, 32768]) {
      const corrupted = encoded.slice(); new DataView(corrupted.buffer).setUint16(31, value, true);
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
    for (const [offset, value] of [[26, 1001], [28, 32001]]) {
      const corrupted = encoded.slice(); new DataView(corrupted.buffer).setUint16(offset, value, true);
      expect(() => decodeServerMessage(corrupted)).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      for (const offset of [22, 34, 38, 42, 46, 50, 54, 58]) {
        const corrupted = encoded.slice(); new DataView(corrupted.buffer).setFloat32(offset, value, true);
        expect(() => decodeServerMessage(corrupted)).toThrow();
      }
    }
  });
});

describe('compact stateless snapshots', () => {
  const minimalPlayer: PlayerState = { ...snapshot.players[0], id: 0, name: '', team: 0, kit: 'assault', weapon: 'ak47',
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
    alive: false, grounded: false, aiming: false, health: 0, ammo: 0, grenades: 0, kills: 0, deaths: 0, lastSeq: 0 };
  const minimal = { ...snapshot, players: [minimalPlayer], projectiles: [] };

  test('preserves unsigned varint boundaries and sequences through MAX_SAFE_INTEGER', () => {
    const values = [0, 1];
    for (let bit = 7; bit <= 49; bit += 7) values.push(2 ** bit - 1, 2 ** bit, 2 ** bit + 1);
    values.push(0xffffffff, Number.MAX_SAFE_INTEGER);
    for (const value of values) {
      const player: PlayerState = { ...minimalPlayer, lastSeq: value,
        id: Math.min(value, 0xffffffff), kills: Math.min(value, 0xffffffff), deaths: Math.min(value, 0xffffffff) };
      const message = { ...minimal, players: [player] };
      const encoded = encodeServerMessage(message) as Uint8Array;
      expect(decodeServerMessage(encoded)).toStrictEqual(message);
      for (let length = 30; length < encoded.length; length++) expect(() => decodeServerMessage(encoded.subarray(0, length))).toThrow();
    }
  });

  test('preserves every team, kit, weapon and boolean flag combination', () => {
    for (const team of [0, 1, 2] as const) for (const kit of ['assault', 'sniper', 'medic'] as Kit[]) {
      for (const weapon of ['ak47', 'awp', 'shovel', 'grenade', 'medic'] as WeaponId[]) for (let flags = 0; flags < 8; flags++) {
        const player: PlayerState = { ...minimalPlayer, team, kit, weapon,
          alive: !!(flags & 1), grounded: !!(flags & 2), aiming: !!(flags & 4) };
        const message = { ...minimal, players: [player] };
        expect(decodeServerMessage(encodeServerMessage(message))).toStrictEqual(message);
      }
    }
  });

  test('preserves all combinations of zero floats without introducing quantization', () => {
    for (let mask = 0; mask < 256; mask++) {
      const values = Array.from({ length: 8 }, (_, index) => mask & (1 << index) ? 0 : -(index + 1) / 7);
      const player: PlayerState = { ...minimalPlayer, position: { x: values[0], y: values[1], z: values[2] },
        velocity: { x: values[3], y: values[4], z: values[5] }, yaw: values[6], pitch: values[7] };
      const result = decodeServerMessage(encodeServerMessage({ ...minimal, players: [player] })) as typeof minimal;
      const decoded = result.players[0];
      expect([decoded.position.x, decoded.position.y, decoded.position.z, decoded.velocity.x, decoded.velocity.y,
        decoded.velocity.z, decoded.yaw, decoded.pitch]).toStrictEqual(values.map(Math.fround));
    }
  });

  test('retains negative zero and exact existing Float32 results, including underflow', () => {
    const values = [-0, 0, 1e-50, -1e-50, -Number.MIN_VALUE, Math.PI, 3.4028234663852886e38, -1 / 3];
    for (let shift = 0; shift < values.length; shift++) {
      const floats = [...values.slice(shift), ...values.slice(0, shift)];
      const player: PlayerState = { ...minimalPlayer, position: { x: floats[0], y: floats[1], z: floats[2] },
        velocity: { x: floats[3], y: floats[4], z: floats[5] }, yaw: floats[6], pitch: floats[7] };
      const result = decodeServerMessage(encodeServerMessage({ ...minimal, players: [player] })) as typeof minimal;
      const decoded = result.players[0];
      expect([decoded.position.x, decoded.position.y, decoded.position.z, decoded.velocity.x, decoded.velocity.y,
        decoded.velocity.z, decoded.yaw, decoded.pitch]).toStrictEqual(floats.map(Math.fround));
    }
    expect(() => encodeServerMessage({ ...minimal, players: [{ ...minimalPlayer, yaw: Number.MAX_VALUE }] })).toThrow();
  });

  test('rejects noncanonical, overflowing and overlong varints at every integer field', () => {
    const base = encodeServerMessage(minimal) as Uint8Array;
    for (const offset of [30, 37, 38, 39]) {
      const malformed = [[128, 0], [129, 0], [255, 128, 0], Array(9).fill(128),
        offset === 39 ? [255, 255, 255, 255, 255, 255, 255, 16] : [255, 255, 255, 255, 16]];
      for (const value of malformed) {
        const corrupted = new Uint8Array(base.length - 1 + value.length);
        corrupted.set(base.subarray(0, offset)); corrupted.set(value, offset);
        corrupted.set(base.subarray(offset + 1), offset + value.length);
        expect(() => decodeServerMessage(corrupted)).toThrow();
      }
    }
  });

  test('rejects invalid integers before silently narrowing them', () => {
    for (const key of ['id', 'kills', 'deaths', 'lastSeq'] as const) {
      const max = key === 'lastSeq' ? Number.MAX_SAFE_INTEGER : 0xffffffff;
      for (const value of [-1, 1.5, max + 1, NaN, Infinity]) {
        expect(() => encodeServerMessage({ ...minimal, players: [{ ...minimalPlayer, [key]: value }] })).toThrow();
      }
    }
  });

  test('bounds record sizes, names, player and projectile counts', () => {
    const minimalEncoded = encodeServerMessage(minimal) as Uint8Array;
    expect(minimalEncoded.byteLength).toBe(41);
    const player: PlayerState = { ...minimalPlayer, name: 'x'.repeat(255), id: 0xffffffff, kills: 0xffffffff,
      deaths: 0xffffffff, lastSeq: Number.MAX_SAFE_INTEGER, position: { x: 1, y: 1, z: 1 },
      velocity: { x: 1, y: 1, z: 1 }, yaw: 1, pitch: 1 };
    const maximum = { ...snapshot, players: Array<PlayerState>(1000).fill(player), projectiles: Array(32000).fill(snapshot.projectiles[0]) };
    const encoded = encodeServerMessage(maximum) as Uint8Array;
    expect(encoded.byteLength).toBe(30 + 1000 * 317 + 32000 * 33);
    expect(decodeServerMessage(encoded)).toStrictEqual(maximum);
    const oversized = new Uint8Array(encoded.length + 1); oversized.set(encoded);
    expect(() => decodeServerMessage(oversized)).toThrow();
    expect(() => encodeServerMessage({ ...minimal, players: [{ ...minimalPlayer, name: 'x'.repeat(256) }] })).toThrow();
    expect(() => encodeServerMessage({ ...minimal, players: Array(1001).fill(minimalPlayer) })).toThrow();
    expect(() => encodeServerMessage({ ...minimal, projectiles: Array(32001).fill(snapshot.projectiles[0]) })).toThrow();
    expect(decodeServerMessage(encodeServerMessage({ ...minimal, players: [] }))).toStrictEqual({ ...minimal, players: [] });
  });
});
