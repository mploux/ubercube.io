import { expect, test } from 'bun:test';
import { decodeServerMessage, encodeServerMessage } from '../src/shared/wire';
import type { ServerMessage } from '../src/shared/protocol';

const snapshot: Extract<ServerMessage, { type: 'snapshot' }> = {
  type: 'snapshot', roundId: 12, tick: 220, scores: [12, 19], remaining: null,
  players: [{ id: 7, name: 'Élodie 🧊', team: 2, kit: 'sniper', weapon: 'awp', alive: true, grounded: true,
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
  expect((encoded as Uint8Array).byteLength).toBeLessThan(JSON.stringify(snapshot).length / 3);
});
test('events remain human-readable JSON', () => {
  const event: ServerMessage = { type: 'pong', time: 42 };
  expect(decodeServerMessage(encodeServerMessage(event))).toEqual(event);
});
test('truncated frames and unknown versions are rejected', () => {
  const encoded = encodeServerMessage(snapshot) as Uint8Array;
  expect(() => decodeServerMessage(encoded.subarray(0, encoded.length - 1))).toThrow();
  encoded[4] = 2;
  expect(() => decodeServerMessage(encoded)).toThrow();
});
