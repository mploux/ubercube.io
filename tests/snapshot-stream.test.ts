import { describe, expect, test } from 'bun:test';
import type { Kit, PlayerState, RemotePlayerState, ServerMessage, WeaponId } from '../src/shared/protocol.ts';
import { captureOwnerState, captureSnapshot, createServerMessageDecoder, decodeServerMessage, encodeRecipientSnapshot,
  encodeServerMessage, encodeSnapshot, serverMessageType, type OwnerState, type SnapshotFrame } from '../src/shared/wire.ts';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type Encoded = { frame: SnapshotFrame; owner: OwnerState; common: Uint8Array; packet: Uint8Array };
const world = { seed: 12, size: 64, height: 48 };

function publicPlayer(player: PlayerState): RemotePlayerState {
  return { id: player.id, name: player.name, team: player.team, weapon: player.weapon, alive: player.alive, aiming: player.aiming,
    kills: player.kills, deaths: player.deaths, hasGrenades: player.grenades > 0, position: { ...player.position },
    velocity: { x: player.velocity.x, z: player.velocity.z }, yaw: player.yaw, pitch: player.pitch };
}

function snapshot(count = 20): Snapshot {
  const owner: PlayerState = { id: 1, name: 'Élodie 🧊', team: 2, kit: 'sniper', weapon: 'awp', alive: true,
    grounded: true, aiming: true, health: 70, ammo: 4, grenades: 8, kills: 3, deaths: 2, lastSeq: 4294967399,
    position: { x: .123456789, y: 8, z: 92 }, velocity: { x: 1, y: 2, z: -6 }, yaw: .45678912, pitch: -.12345678 };
  return { type: 'snapshot', roundId: 7, tick: 42, scores: [4, 6], roundEndTick: null, owner,
    players: Array.from({ length: count }, (_, index) => publicPlayer({ ...owner, id: index + 1, name: index ? `Player${index}` : owner.name })),
    projectiles: [{ id: 0xffffffff, owner: 1, weapon: 'grenade', position: { x: .123456789, y: 8, z: 12 } },
      { id: 0, owner: 2, weapon: 'grenade', position: { x: 3, y: 4, z: 5 } }],
    projectileVelocities: [{ id: 0xffffffff, velocity: { x: 3, y: .23456789, z: -0 } }] };
}

function encode(message: Snapshot, id: number, previous?: Encoded): Encoded {
  const frame = captureSnapshot(message, id), owner = captureOwnerState(message.owner, message.projectileVelocities, frame);
  const common = encodeSnapshot(frame, previous?.frame);
  return { frame, owner, common, packet: encodeRecipientSnapshot(common, owner, previous?.owner) };
}

function roster(message: Snapshot): ServerMessage {
  return { type: 'roster', upserts: message.players.map(({ id, name, team }) => ({ id, name, team })), removed: [] };
}

function client(message: Snapshot) {
  const decode = createServerMessageDecoder();
  decode(encodeServerMessage({ type: 'welcome', id: message.owner?.id ?? 1, roundId: message.roundId, mode: 'ffa', maxPlayers: 1000, world, tickRate: 60 }));
  decode(encodeServerMessage(roster(message)));
  return decode;
}

function expected(message: Snapshot): Snapshot {
  const f = Math.fround, vec = (v: { x: number; y: number; z: number }) => ({ x: f(v.x), y: f(v.y), z: f(v.z) });
  const players = message.players.map(player => ({ ...player, position: vec(player.position),
    velocity: { x: f(player.velocity.x), z: f(player.velocity.z) }, yaw: f(player.yaw), pitch: f(player.pitch) }));
  let owner: PlayerState | null = null;
  if (message.owner) {
    const { hasGrenades: _hasGrenades, ...shared } = players.find(player => player.id === message.owner!.id)!;
    owner = { ...shared, kit: message.owner.kit, health: message.owner.health, ammo: message.owner.ammo,
      grenades: message.owner.grenades, grounded: message.owner.grounded, lastSeq: message.owner.lastSeq,
      velocity: { ...shared.velocity, y: f(message.owner.velocity.y) } };
  }
  return { ...message, scores: [...message.scores], players, owner, projectiles: message.projectiles.map(projectile => ({ ...projectile, position: vec(projectile.position) })),
    projectileVelocities: message.projectileVelocities.map(projectile => ({ id: projectile.id, velocity: vec(projectile.velocity) })) };
}

describe('scoped snapshot codec', () => {
  test('captures public and owner states separately without leaking wider input objects or serializing metadata in snapshots', () => {
    const message = snapshot(), first = encode(message, 1), decode = client(message), wanted = expected(message);
    message.owner!.health = 1; message.owner!.velocity.y = 999; message.players[0].position.x = 999; message.scores[0] = 999;
    expect(decode(first.packet)).toStrictEqual(wanted);
    expect(new TextDecoder().decode(first.packet)).not.toContain('Élodie');
    expect(serverMessageType(first.packet)).toBe('snapshot');
    expect(() => decodeServerMessage(first.packet)).toThrow('createServerMessageDecoder');
    expect(() => encodeServerMessage(message)).toThrow('encodeRecipientSnapshot');
    expect(() => decodeServerMessage(JSON.stringify(message))).toThrow();
    const wider = snapshot();
    wider.players[0] = { ...wider.owner!, hasGrenades: true };
    wider.projectiles[0] = { ...wider.projectiles[0], velocity: { x: 999, y: 999, z: 999 } } as typeof wider.projectiles[0];
    const decoded = client(wider)(encode(wider, 1).packet) as Snapshot;
    expect(Object.keys(decoded.players[0]).sort()).toEqual(Object.keys(publicPlayer(wider.owner!)).sort());
    expect(Object.keys(decoded.players[0].velocity)).toEqual(['x', 'z']);
    expect(Object.keys(decoded.projectiles[0]).sort()).toEqual(['id', 'owner', 'position', 'weapon']);
    expect(decoded.owner?.lastSeq).toBe(4294967399);
    expect(decoded.projectileVelocities.map(projectile => projectile.id)).toEqual([0xffffffff]);
  });

  const changes: [string, (message: Snapshot) => void][] = [
    ['weapon', message => { message.players[0].weapon = 'medic'; }], ['alive', message => { message.players[0].alive = false; }],
    ['aiming', message => { message.players[0].aiming = false; }], ['hasGrenades', message => { message.players[0].hasGrenades = false; }],
    ['kills', message => { message.players[0].kills = 0xffffffff; }], ['deaths', message => { message.players[0].deaths = 0; }],
    ['position.x', message => { message.players[0].position.x = -0; }], ['position.y', message => { message.players[0].position.y = 0; }],
    ['position.z', message => { message.players[0].position.z = 1e-20; }], ['velocity.x', message => { message.players[0].velocity.x = 0; }],
    ['velocity.z', message => { message.players[0].velocity.z = -0; }], ['yaw', message => { message.players[0].yaw = 0; }],
    ['pitch', message => { message.players[0].pitch = -0; }], ['owner.kit', message => { message.owner!.kit = 'medic'; }],
    ['owner.health', message => { message.owner!.health = 0; }], ['owner.ammo', message => { message.owner!.ammo = 0; }],
    ['owner.grenades', message => { message.owner!.grenades = 0; }], ['owner.grounded', message => { message.owner!.grounded = false; }],
    ['owner.lastSeq', message => { message.owner!.lastSeq = Number.MAX_SAFE_INTEGER; }], ['owner.velocity.y', message => { message.owner!.velocity.y = -0; }],
  ];
  test.each(changes)('preserves changed field %s without mutating history', (_name, change) => {
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    const before = decode(first.packet) as Snapshot, saved = structuredClone(before);
    Object.freeze(before.players[0]); Object.freeze(before.players[0].position); Object.freeze(before.owner!);
    change(message);
    const second = encode(message, 2, first);
    expect(second.common[5]).toBe(5);
    expect(second.packet.length).toBeLessThan(70);
    expect(decode(second.packet)).toStrictEqual(expected(message));
    expect(before).toStrictEqual(saved);
  });

  test('uses identical public bytes for distinct recipients and binds private deltas to the same reference', () => {
    const message = snapshot(), first = encode(message, 1);
    const otherOwner = { ...message.owner!, id: 2, name: 'Player1', health: 9, ammo: 1, lastSeq: 456 };
    const other = captureOwnerState(otherOwner, [{ id: 0, velocity: { x: 7, y: 8, z: 9 } }], first.frame);
    const otherPacket = encodeRecipientSnapshot(first.common, other);
    expect([...otherPacket.subarray(0, first.common.length)]).toEqual([...first.common]);
    const secondClient = client({ ...message, owner: otherOwner });
    const result = secondClient(otherPacket) as Snapshot;
    expect(result.owner?.id).toBe(2); expect(result.owner?.health).toBe(9); expect(result.owner?.lastSeq).toBe(456);
    expect(result.projectileVelocities).toEqual([{ id: 0, velocity: { x: 7, y: 8, z: 9 } }]);
    expect(() => client(message)(otherPacket)).toThrow('owner mismatch');
    message.owner!.ammo--;
    const second = encode(message, 2, first);
    expect(() => encodeRecipientSnapshot(second.common, second.owner)).toThrow('baseline mismatch');
    expect(() => encodeRecipientSnapshot(second.common, second.owner, { ...first.owner, snapshotId: 7 })).toThrow('baseline mismatch');
  });

  test('resolves roster-only changes without motion changes, retaining immutable history and metadata across reset', () => {
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    const before = decode(first.packet) as Snapshot, saved = structuredClone(before);
    message.players[0].name = 'Nouveau 🧊'; message.players[0].team = 0;
    decode(encodeServerMessage({ type: 'roster', upserts: [{ id: 1, name: message.players[0].name, team: 0 }], removed: [] }));
    const second = encode(message, 2, first);
    expect(second.common.length).toBe(35);
    expect(decode(second.packet)).toStrictEqual(expected(message));
    expect(before).toStrictEqual(saved);
    message.roundId++;
    decode(encodeServerMessage({ type: 'reset', roundId: message.roundId, world }));
    const reset = encode(message, 3, second);
    expect(reset.common[5]).toBe(4);
    expect(decode(reset.packet)).toStrictEqual(expected(message));
    expect(() => decode(first.packet)).toThrow('round mismatch');
    decode(encodeServerMessage({ type: 'welcome', id: 1, roundId: message.roundId, mode: 'ffa', maxPlayers: 100, world, tickRate: 60 }));
    expect(() => decode(reset.packet)).toThrow('Unknown snapshot player');
    decode(encodeServerMessage(roster(message)));
    expect(decode(reset.packet)).toStrictEqual(expected(message));
  });

  test('handles public entities and private projectile additions/removals, null owners and full fallback', () => {
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    decode(first.packet);
    message.players.splice(2, 1);
    message.players.push({ ...structuredClone(message.players[0]), id: 100 });
    decode(encodeServerMessage({ type: 'roster', upserts: [{ id: 100, name: message.players[0].name, team: 2 }], removed: [3] }));
    message.projectiles[0].position = { x: -0, y: 0, z: 1e-20 };
    message.projectileVelocities[0].velocity = { x: -.123456789, y: -0, z: 0 };
    message.projectiles.push({ id: 7, owner: 1, weapon: 'grenade', position: { x: 1, y: 2, z: 3 } });
    message.projectileVelocities.push({ id: 7, velocity: { x: 4, y: 5, z: 6 } });
    message.scores = [0, 0xffffffff]; message.roundEndTick = 0xffffffff;
    const second = encode(message, 2, first);
    expect(second.common[5]).toBe(5); expect(decode(second.packet)).toStrictEqual(expected(message));
    message.owner = null; message.projectileVelocities = []; message.projectiles = [];
    const third = encode(message, 3, second);
    expect(decode(third.packet)).toStrictEqual(expected(message));
    message.players.reverse();
    const fourth = encode(message, 4, third);
    expect(fourth.common).toBe(fourth.frame.full); expect(decode(fourth.packet)).toStrictEqual(expected(message));
    message.players = message.players.map(player => ({ ...player, id: player.id + 1000, position: { x: 0, y: 0, z: 0 } }));
    decode(encodeServerMessage({ type: 'roster', upserts: (roster(message) as Extract<ServerMessage, { type: 'roster' }>).upserts,
      removed: [...fourth.frame.players.keys()] }));
    const replaced = encode(message, 5, fourth);
    expect(replaced.common).toBe(replaced.frame.full); expect(decode(replaced.packet)).toStrictEqual(expected(message));
  });

  test('rejects malformed public and private data transactionally, then accepts the original valid delta', () => {
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    decode(first.packet); message.owner!.ammo--;
    const second = encode(message, 2, first), packet = second.packet, boundary = second.common.length;
    expect(boundary).toBe(35);
    for (let length = 0; length < packet.length; length++) expect(() => decode(packet.subarray(0, length))).toThrow();
    const tail = new Uint8Array(packet.length + 1); tail.set(packet); expect(() => decode(tail)).toThrow();
    for (const [offset, value] of [[4, 255], [26, 128], [boundary, 2], [boundary + 1, 128]]) {
      const corrupted = packet.slice(); corrupted[offset] = value; expect(() => decode(corrupted)).toThrow();
    }
    for (const [offset, value] of [[6, 34], [6, packet.length], [10, 8], [18, 0], [18, 1], [22, 99]]) {
      const corrupted = packet.slice(); new DataView(corrupted.buffer).setUint32(offset, value, true);
      expect(() => decode(corrupted)).toThrow();
    }
    const count = packet.slice(); new DataView(count.buffer).setUint16(29, 1001, true); expect(() => decode(count)).toThrow();
    expect(decode(packet)).toStrictEqual(expected(message));
    message.owner!.velocity.y = .1;
    const third = encode(message, 3, second), nan = third.packet.slice();
    new DataView(nan.buffer).setFloat32(third.common.length + 2, NaN, true);
    expect(() => decode(nan)).toThrow('Invalid wire float');
    expect(decode(third.packet)).toStrictEqual(expected(message));
    expect(() => captureOwnerState(message.owner, [{ id: 0, velocity: { x: 1, y: 2, z: 3 } }], third.frame)).toThrow('private projectile');
    expect(() => captureOwnerState({ ...message.owner!, id: 123 }, [], third.frame)).toThrow('owner');
  });

  test('checks private projectile ownership after decoding without committing either baseline', () => {
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    decode(first.packet);
    message.projectileVelocities[0].velocity.x++;
    const second = encode(message, 2, first);
    const wrong: OwnerState = { ...second.owner, projectileVelocities: new Map([[0, [1, 2, 3]]]) };
    const corrupted = encodeRecipientSnapshot(second.common, wrong, first.owner);
    expect(() => decode(corrupted)).toThrow('Invalid private projectile');
    expect(decode(second.packet)).toStrictEqual(expected(message));
  });

  test('supports byte subviews without reading adjacent bytes and recovers with full data after a skipped delta', () => {
    const message = snapshot(), first = encode(message, 1);
    message.owner!.ammo--; const second = encode(message, 2, first);
    message.players[0].position.x++; const third = encode(message, 3, second);
    for (const dataView of [false, true]) {
      const decode = client(message); decode(first.packet);
      expect(() => decode(third.packet)).toThrow('baseline mismatch');
      const recovery = encode(message, 4), padded = new Uint8Array(recovery.packet.length + 19).fill(255);
      padded.set(recovery.packet, 7);
      const data = dataView ? new DataView(padded.buffer, 7, recovery.packet.length) : padded.subarray(7, 7 + recovery.packet.length);
      expect(decode(data)).toStrictEqual(expected(message));
    }
  });

  test('preserves integer boundaries, enums, flags and exact Float32 behavior', () => {
    const values = [0, 1, 0xffffffff, Number.MAX_SAFE_INTEGER];
    for (let bit = 7; bit <= 49; bit += 7) values.push(2 ** bit - 1, 2 ** bit, 2 ** bit + 1);
    for (const value of values) {
      const message = snapshot(1); message.owner!.lastSeq = value;
      message.players[0].kills = message.players[0].deaths = Math.min(value, 0xffffffff);
      expect(client(message)(encode(message, 1).packet)).toStrictEqual(expected(message));
    }
    for (const team of [0, 1, 2] as const) for (const kit of ['assault', 'sniper', 'medic'] as Kit[]) {
      for (const weapon of ['ak47', 'awp', 'shovel', 'grenade', 'medic'] as WeaponId[]) for (let bits = 0; bits < 16; bits++) {
        const message = snapshot(1);
        Object.assign(message.players[0], { team, weapon, alive: !!(bits & 1), aiming: !!(bits & 2), hasGrenades: !!(bits & 4) });
        Object.assign(message.owner!, { kit, grounded: !!(bits & 8) });
        expect(client(message)(encode(message, 1).packet)).toStrictEqual(expected(message));
      }
    }
    const floats = [-0, 0, 1e-50, -1e-50, -Number.MIN_VALUE, Math.PI, 3.4028234663852886e38, -1 / 3];
    for (let mask = 0; mask < 256; mask++) {
      const message = snapshot(1), f = floats.map((value, index) => mask & (1 << index) ? 0 : value);
      Object.assign(message.players[0], { position: { x: f[0], y: f[1], z: f[2] }, velocity: { x: f[3], z: f[4] }, yaw: f[5], pitch: f[6] });
      message.owner!.velocity.y = f[7];
      expect(client(message)(encode(message, 1).packet)).toStrictEqual(expected(message));
    }
  });

  test('rejects invalid floats, integer narrowing, duplicate IDs, counts and unknown enums', () => {
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      const message = snapshot(); message.players[0].yaw = value; expect(() => encode(message, 1)).toThrow();
      const owner = snapshot(); owner.owner!.velocity.y = value; expect(() => encode(owner, 1)).toThrow();
    }
    for (const key of ['id', 'kills', 'deaths'] as const) for (const value of [-1, 1.5, 0x100000000, NaN, Infinity]) {
      const message = snapshot(); message.players[0][key] = value; expect(() => encode(message, 1)).toThrow();
    }
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      const message = snapshot(); message.owner!.lastSeq = value; expect(() => encode(message, 1)).toThrow();
    }
    const duplicate = snapshot(); duplicate.players[1].id = 1; expect(() => encode(duplicate, 1)).toThrow();
    duplicate.players = snapshot().players; duplicate.projectiles[1].id = duplicate.projectiles[0].id; expect(() => encode(duplicate, 1)).toThrow();
    const oversized = snapshot(1001); expect(() => encode(oversized, 1)).toThrow('limit');
    const projectiles = snapshot(); projectiles.projectiles = Array(32001).fill(projectiles.projectiles[0]); expect(() => encode(projectiles, 1)).toThrow('limit');
    const invalidWeapon = snapshot(); invalidWeapon.players[0].weapon = 'unknown' as WeaponId; expect(() => encode(invalidWeapon, 1)).toThrow();
    const invalidKit = snapshot(); invalidKit.owner!.kit = 'unknown' as Kit; expect(() => encode(invalidKit, 1)).toThrow();
  });

  test('rejects noncanonical, overflowing and overlong varints at public and owner integer fields', () => {
    const message = snapshot(1); message.players[0].kills = 0; message.players[0].deaths = 0;
    message.owner!.lastSeq = 0; message.projectiles = []; message.projectileVelocities = [];
    const base = encode(message, 1), boundary = base.common.length;
    for (const offset of [40, 47, 48, boundary + 7]) {
      for (const value of [[128, 0], [129, 0], [255, 128, 0], Array(9).fill(128),
        offset === boundary + 7 ? [255, 255, 255, 255, 255, 255, 255, 16] : [255, 255, 255, 255, 16]]) {
        const corrupted = new Uint8Array(base.packet.length - 1 + value.length);
        corrupted.set(base.packet.subarray(0, offset)); corrupted.set(value, offset);
        corrupted.set(base.packet.subarray(offset + 1), offset + value.length);
        if (offset < boundary) new DataView(corrupted.buffer).setUint32(6, boundary + value.length - 1, true);
        expect(() => client(message)(corrupted)).toThrow();
      }
    }
  });

  test('validates full-frame flags, enums, booleans, floats and truncation before changing the baseline', () => {
    const message = snapshot(1); message.players[0].kills = 0; message.players[0].deaths = 0;
    message.owner!.lastSeq = 0; message.projectiles = []; message.projectileVelocities = [];
    const base = encode(message, 1), boundary = base.common.length, decode = client(message);
    for (let length = 0; length < base.packet.length; length++) expect(() => decode(base.packet.subarray(0, length))).toThrow();
    for (const [offset, value] of [[26, 0], [40, 0], [43, 255], [44, 2], [45, 2], [46, 2], [boundary + 2, 255], [boundary + 6, 2]]) {
      const corrupted = base.packet.slice(); corrupted[offset] = value; expect(() => decode(corrupted)).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity]) for (const offset of [49, 53, 57, 61, 65, 69, 73, boundary + 8]) {
      const corrupted = base.packet.slice(); new DataView(corrupted.buffer).setFloat32(offset, value, true);
      expect(() => decode(corrupted)).toThrow();
    }
    for (const [offset, count] of [[38, 1001], [79, 32001]]) {
      const corrupted = base.packet.slice(); new DataView(corrupted.buffer).setUint16(offset, count, true);
      expect(() => decode(corrupted)).toThrow();
    }
    expect(decode(base.packet)).toStrictEqual(expected(message));
  });

  test('bounds retained roster entries transactionally and rejects missing or removed metadata', () => {
    const message = snapshot(1000), decode = client(message), first = encode(message, 1);
    decode(first.packet);
    expect(() => decode(encodeServerMessage({ type: 'roster', upserts: [{ id: 1001, name: 'excess', team: 0 }], removed: [] }))).toThrow('limit');
    expect(decode(first.packet)).toStrictEqual(expected(message));
    expect(() => decode(encodeServerMessage({ type: 'roster', upserts: [], removed: [1001] }))).toThrow('Unknown roster removal');
    decode(encodeServerMessage({ type: 'roster', upserts: [], removed: [1] }));
    expect(() => decode(first.packet)).toThrow('Unknown snapshot player');
    decode(encodeServerMessage({ type: 'roster', upserts: [{ id: 1, name: message.players[0].name, team: 2 }], removed: [] }));
    expect(decode(first.packet)).toStrictEqual(expected(message));
  });
});
