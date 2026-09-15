import { expect, test } from 'bun:test';
import { decodeServerMessage, encodeServerMessage } from '../src/shared/wire';
import type { ServerMessage } from '../src/shared/protocol';

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

test('aiming uses an existing flag bit and old snapshots decode as not aiming', () => {
  const scoped = encodeServerMessage(snapshot) as Uint8Array;
  const hip = encodeServerMessage({ ...snapshot, players: [{ ...snapshot.players[0], aiming: false }] }) as Uint8Array;
  expect(scoped.length).toBe(hip.length);
  const differences = [...scoped].flatMap((byte, index) => byte === hip[index] ? [] : [index]);
  expect(differences).toEqual([37]);
  expect(scoped[37] ^ hip[37]).toBe(4);
  const legacy = decodeServerMessage(hip) as typeof snapshot;
  expect(legacy.players[0].aiming).toBe(false);
  expect(legacy.players[0].alive && legacy.players[0].grounded).toBe(true);
});
test('events remain human-readable JSON', () => {
  const event: ServerMessage = { type: 'pong', time: 42 };
  expect(decodeServerMessage(encodeServerMessage(event))).toEqual(event);
});

test('hitscan events preserve the complete ray and command correlation as JSON', () => {
  const event: ServerMessage = { type: 'event', event: 'shot', roundId: 12, tick: 221,
    shooterId: 7, weapon: 'awp', projectileId: 3, inputSeq: 4294967400,
    position: { x: 16.123456789, y: 10.27345, z: 89.3 }, endPosition: { x: 16.123456789, y: 10.27345, z: 0 } };
  const encoded = encodeServerMessage(event);
  expect(typeof encoded).toBe('string');
  expect(decodeServerMessage(encoded)).toEqual(event);
});
test('truncated frames and unknown versions are rejected', () => {
  const encoded = encodeServerMessage(snapshot) as Uint8Array;
  expect(() => decodeServerMessage(encoded.subarray(0, encoded.length - 1))).toThrow();
  encoded[4] = 2;
  expect(() => decodeServerMessage(encoded)).toThrow();
});
