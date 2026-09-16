import { describe, expect, test } from 'bun:test';
import type { Kit, PlayerState, RemotePlayerState, ServerMessage, WeaponId } from '../src/shared/protocol.ts';
import { captureOwnerState, captureSnapshot, createServerMessageDecoder, decodeServerMessage, encodeCombinedSnapshot, encodeRecipientSnapshot,
  encodeServerMessage, encodeSnapshot, selectSnapshotPlayers as selectWithCadence, serverMessageType, type OwnerState, type SnapshotFrame } from '../src/shared/wire.ts';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type Encoded = { frame: SnapshotFrame; owner: OwnerState; common: Uint8Array; packet: Uint8Array };
const world = { seed: 12, size: 64, height: 48 };

function selectSnapshotPlayers(current: SnapshotFrame, previous: SnapshotFrame | null,
  updates: ReadonlyMap<number, RemotePlayerState['sampleInterval']>): SnapshotFrame {
  return selectWithCadence(current, previous, id => updates.get(id));
}

function publicPlayer(player: PlayerState): RemotePlayerState {
  return { id: player.id, name: player.name, team: player.team, weapon: player.weapon, alive: player.alive, aiming: player.aiming,
    kills: player.kills, deaths: player.deaths, hasGrenades: player.grenades > 0, position: { ...player.position },
    velocity: { x: player.velocity.x, z: player.velocity.z }, yaw: player.yaw, pitch: player.pitch, sampleTick: 42, sampleInterval: 3 };
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

function encode(message: Snapshot, id: number, previous?: Encoded, updates?: ReadonlyMap<number, RemotePlayerState['sampleInterval']>): Encoded {
  const captured = captureSnapshot(message, id), frame = updates ? selectSnapshotPlayers(captured, previous?.frame ?? null, updates) : captured;
  const owner = captureOwnerState(message.owner, message.projectileVelocities, frame);
  const common = encodeSnapshot(frame, previous?.frame);
  const packet = encodeCombinedSnapshot(frame, owner, previous?.frame, previous?.owner);
  expect(packet).toEqual(encodeRecipientSnapshot(common, owner, previous?.owner));
  return { frame, owner, common, packet };
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
    const { hasGrenades: _hasGrenades, sampleTick: _sampleTick, sampleInterval: _sampleInterval, ...shared } = players.find(player => player.id === message.owner!.id)!;
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
    wider.players[0] = { ...wider.owner!, hasGrenades: true, sampleTick: 42, sampleInterval: 3 };
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
    ['pitch', message => { message.players[0].pitch = -0; }], ['sampleTick', message => { message.players[0].sampleTick = 39; }],
    ['sampleInterval', message => { message.players[0].sampleInterval = 12; }], ['owner.kit', message => { message.owner!.kit = 'medic'; }],
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

  test('retains unscheduled samples without removing players, then refreshes them at their selected cadence', () => {
    const message = snapshot(3), decode = client(message);
    const first = encode(message, 1, undefined, new Map([[1, 3], [2, 12], [3, 6]]));
    const before = decode(first.packet) as Snapshot, saved = structuredClone(before);
    for (const player of message.players) { player.position.x += 10; player.sampleTick = 45; }
    message.tick = 45; message.scores[0]++; message.projectiles[0].position.y++;
    const second = encode(message, 2, first, new Map([[1, 3]]));
    const wanted = expected(message); wanted.players[1] = before.players[1]; wanted.players[2] = before.players[2];
    expect(decode(second.packet)).toStrictEqual(wanted);
    expect(second.frame.players.get(2)).toBe(first.frame.players.get(2));
    expect(second.frame.players.get(3)).toBe(first.frame.players.get(3));
    expect(before).toStrictEqual(saved);

    message.tick = 48;
    for (const player of message.players) { player.position.x += 10; player.sampleTick = 48; }
    const third = encode(message, 3, second, new Map([[1, 3], [3, 6]]));
    const result = decode(third.packet) as Snapshot;
    expect(result.players[1]).toStrictEqual(before.players[1]);
    expect(result.players[2]).toStrictEqual({ ...expected(message).players[2], sampleInterval: 6 });
    message.tick = 51;
    for (const player of message.players) player.sampleTick = 51;
    const fourth = encode(message, 4, third, new Map([[1, 3], [2, 3]]));
    const updated = decode(fourth.packet) as Snapshot;
    expect(updated.players[1]).toStrictEqual(expected(message).players[1]);

    const recovery = encodeRecipientSnapshot(fourth.frame.full, fourth.owner);
    expect(client(message)(recovery)).toStrictEqual(updated);
    expect((client(message)(recovery) as Snapshot).players[2]).toStrictEqual(result.players[2]);
  });

  test.each(changes.slice(0, 6))('refreshes critical public field %s immediately with its complete motion sample', (_name, change) => {
    const message = snapshot(), decode = client(message);
    const first = encode(message, 1, undefined, new Map([[1, 12]]));
    decode(first.packet);
    message.tick = 45; message.players[0].sampleTick = 45; message.players[0].position.x += 5;
    change(message);
    const second = encode(message, 2, first, new Map());
    const wanted = expected(message); wanted.players[0].sampleInterval = 12;
    expect(decode(second.packet)).toStrictEqual(wanted);
    expect(second.frame.players.get(1)).not.toBe(first.frame.players.get(1));
  });

  test('shares fresh frames when possible and seeds new players and new rounds without stale samples', () => {
    const message = snapshot(3), original = captureSnapshot(message, 1);
    expect(selectSnapshotPlayers(original, null, new Map())).toBe(original);
    const first = selectSnapshotPlayers(original, null, new Map([[1, 12]]));
    const unchanged = captureSnapshot(message, 2);
    expect(selectSnapshotPlayers(unchanged, first, new Map([[1, 3], [2, 3], [3, 3]]))).toBe(unchanged);
    message.players.splice(1, 1);
    message.players.push({ ...structuredClone(message.players[0]), id: 100 });
    message.tick = 45;
    for (const player of message.players) { player.sampleTick = 45; player.position.x++; }
    const fresh = captureSnapshot(message, 3), selected = selectSnapshotPlayers(fresh, first, new Map());
    expect([...selected.players.keys()]).toEqual([1, 3, 100]);
    expect(selected.players.get(1)).toBe(first.players.get(1));
    expect(selected.players.get(100)).toBe(fresh.players.get(100));
    message.roundId++;
    const reset = captureSnapshot(message, 4), next = selectSnapshotPlayers(reset, selected, new Map([[1, 6]]));
    const packet = encodeRecipientSnapshot(encodeSnapshot(next, selected), captureOwnerState(message.owner, message.projectileVelocities, next));
    const wanted = expected(message); wanted.players[0].sampleInterval = 6;
    expect(client(message)(packet)).toStrictEqual(wanted);
    expect(packet[5]).toBe(4);
  });

  test('classifies each current player once in frame order without copying a fully updated frame', () => {
    const message = snapshot(3); message.players.reverse();
    const frame = captureSnapshot(message, 1), visited: [number, number][] = [];
    expect(selectWithCadence(frame, null, (id, index) => { visited.push([id, index]); return 3; })).toBe(frame);
    expect(visited).toEqual([[3, 0], [2, 1], [1, 2]]);
  });

  test('encodes selected deltas without requesting either complete frame', () => {
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    const before = decode(first.packet) as Snapshot;
    Object.defineProperty(first.frame, 'players', { get() { throw new Error('Baseline player map must not be read'); } });
    message.tick = 45;
    for (const player of message.players) { player.sampleTick = 45; player.position.x++; }
    const current = captureSnapshot(message, 2);
    Object.defineProperty(current, 'full', { get() { throw new Error('Shared full must not be read'); } });
    Object.defineProperty(current, 'players', { get() { throw new Error('Shared player map must not be read'); } });
    const selected = selectSnapshotPlayers(current, first.frame, new Map([[1, 3]]));
    Object.defineProperty(selected, 'full', { get() { throw new Error('Selected full must not be materialized'); } });
    Object.defineProperty(selected, 'players', { get() { throw new Error('Selected player map must not be materialized'); } });
    const common = encodeSnapshot(selected, first.frame);
    expect(common[5]).toBe(5);
    expect(common.length).toBeLessThan(selected.fullLength);
    const owner = captureOwnerState(message.owner, message.projectileVelocities, selected);
    const wanted = expected(message); wanted.players.splice(1, wanted.players.length - 1, ...before.players.slice(1));
    const packet = encodeCombinedSnapshot(selected, owner, first.frame, first.owner);
    expect(packet).toEqual(encodeRecipientSnapshot(common, owner, first.owner));
    expect(decode(packet)).toStrictEqual(wanted);
    // Selecting an already selected frame must also leave its lazy full untouched.
    const reselected = selectSnapshotPlayers(selected, null, new Map([[1, 6]]));
    expect(reselected.fullLength).toBe(selected.fullLength);
  });

  test('complete recovery and owner capture also avoid materializing selected player maps', () => {
    const message = snapshot(), current = captureSnapshot(message, 1);
    const selected = selectSnapshotPlayers(current, null, new Map([[2, 12]]));
    Object.defineProperty(current, 'players', { get() { throw new Error('Shared player map must not be read'); } });
    Object.defineProperty(selected, 'players', { get() { throw new Error('Selected player map must not be materialized'); } });
    const owner = captureOwnerState(message.owner, message.projectileVelocities, selected);
    const full = encodeSnapshot(selected), wanted = expected(message); wanted.players[1].sampleInterval = 12;
    expect(full.length).toBe(selected.fullLength);
    expect(client(message)(encodeRecipientSnapshot(full, owner))).toStrictEqual(wanted);
  });

  test('materializes the global full buffer only on first access and reuses it', () => {
    const message = snapshot(), frame = captureSnapshot(message, 1);
    const iterate = frame.projectiles[Symbol.iterator].bind(frame.projectiles);
    let traversals = 0;
    Object.defineProperty(frame.projectiles, Symbol.iterator, { value() { traversals++; return iterate(); } });
    Object.defineProperty(frame, 'players', { get() { throw new Error('Player map must not be read'); } });
    const owner = captureOwnerState(message.owner, message.projectileVelocities, frame);
    expect(traversals).toBe(0);
    const full = frame.full;
    expect(traversals).toBe(1);
    expect(full.length).toBe(frame.fullLength);
    expect(frame.full).toBe(full); expect(encodeSnapshot(frame)).toBe(full);
    expect(traversals).toBe(1);
    expect(client(message)(encodeRecipientSnapshot(full, owner))).toStrictEqual(expected(message));
  });

  test('computes global full lengths exactly across integer boundaries, projectile owners and round ends', () => {
    for (const value of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 0xffffffff]) {
      for (const roundEndTick of [null, value]) {
        const message = snapshot(2), id = value || 1;
        message.tick = value; message.scores = [value, value]; message.roundEndTick = roundEndTick;
        message.players[0].id = message.owner!.id = id; message.players[1].id = id === 1 ? 2 : 1;
        for (const player of message.players) player.sampleTick = player.kills = player.deaths = value;
        message.projectiles[0].id = message.projectileVelocities[0].id = value;
        message.projectiles[0].owner = id;
        message.projectiles[1].id = value === 0 ? 1 : 0; message.projectiles[1].owner = message.players[1].id;
        const frame = captureSnapshot(message, id), owner = captureOwnerState(message.owner, message.projectileVelocities, frame);
        const packet = encodeCombinedSnapshot(frame, owner);
        expect(new DataView(packet.buffer).getUint32(6, true)).toBe(frame.fullLength);
        expect(frame.full.length).toBe(frame.fullLength);
        expect(client(message)(packet)).toStrictEqual(expected(message));
      }
    }
    const empty = snapshot(0); empty.owner = null; empty.projectiles = []; empty.projectileVelocities = [];
    for (const roundEndTick of [null, 0, 0xffffffff]) {
      empty.roundEndTick = roundEndTick;
      const frame = captureSnapshot(empty, 1);
      expect(frame.full.length).toBe(frame.fullLength);
      expect(frame.fullLength).toBe(roundEndTick === null ? 44 : 48);
    }
  });

  test('keeps complete fallback sizes exact across sample tick varint boundaries and caches their bytes', () => {
    for (const tick of [127, 16383, 2097151, 268435455]) {
      const message = snapshot(4);
      message.tick = tick;
      for (const player of message.players) player.sampleTick = tick;
      const first = encode(message, 1, undefined, new Map([[2, 12], [3, 6], [4, 12]]));
      const before = client(message)(first.packet) as Snapshot;
      message.tick += 3; message.players[1].kills = 128;
      for (const player of message.players) { player.sampleTick = message.tick; player.position.x++; }
      const current = captureSnapshot(message, 2), selected = selectSnapshotPlayers(current, first.frame, new Map([[1, 3]]));
      expect(current.fullLength).toBe(current.full.length);
      expect(selected.fullLength).toBe(current.fullLength - 2);
      const full = selected.full;
      expect(full.length).toBe(selected.fullLength);
      expect(selected.full).toBe(full);
      const owner = captureOwnerState(message.owner, message.projectileVelocities, selected);
      const wanted = expected(message); wanted.players[1].sampleInterval = 12;
      wanted.players[2] = before.players[2]; wanted.players[3] = before.players[3];
      expect(client(message)(encodeRecipientSnapshot(full, owner))).toStrictEqual(wanted);
      expect(encodeSnapshot(selected)).toBe(full);
    }
  });

  test('shares cadence variants without retaining a chain of copied samples', () => {
    const original = captureSnapshot(snapshot(), 1);
    const slow = selectSnapshotPlayers(original, null, new Map([[1, 12]]));
    expect(selectSnapshotPlayers(original, null, new Map([[1, 12]])).players.get(1)).toBe(slow.players.get(1));
    const medium = selectSnapshotPlayers(slow, null, new Map([[1, 6]]));
    expect(selectSnapshotPlayers(original, null, new Map([[1, 6]])).players.get(1)).toBe(medium.players.get(1));
    expect(selectSnapshotPlayers(medium, null, new Map([[1, 3]])).players.get(1)).toBe(original.players.get(1));
    expect(selectSnapshotPlayers(medium, null, new Map([[1, 12]])).players.get(1)).toBe(slow.players.get(1));
  });

  test('keeps recipient histories isolated while sharing player records and projectile groups', () => {
    const message = snapshot(4), initial = captureSnapshot(message, 1);
    const recipients = ([12, 6, 3] as const).map(interval => {
      const frame = selectSnapshotPlayers(initial, null, new Map([[2, interval], [3, 6]]));
      const owner = captureOwnerState(message.owner, message.projectileVelocities, frame), decode = client(message);
      const received = decode(encodeRecipientSnapshot(frame.full, owner)) as Snapshot;
      return { interval, frame, owner, decode, received };
    });
    for (let step = 0; step < 2; step++) {
      message.tick += 3;
      for (const player of message.players) { player.sampleTick = message.tick; player.position.x++; }
      if (!step) {
        message.projectiles.splice(1, 1, { id: 7, owner: 1, weapon: 'grenade', position: { x: 1, y: 2, z: 3 } });
        message.projectileVelocities.push({ id: 7, velocity: { x: 4, y: 5, z: 6 } });
      } else {
        message.players[2].alive = false;
        message.projectiles.shift(); message.projectileVelocities.shift(); message.projectiles[0].position.x++;
      }
      const current = captureSnapshot(message, step + 2);
      for (const [index, recipient] of recipients.entries()) {
        if (!step && index === 2) continue;
        const updates = new Map<number, RemotePlayerState['sampleInterval']>([[1, 3], [2, recipient.interval]]);
        if (!index) updates.set(4, 3);
        const frame = selectSnapshotPlayers(current, recipient.frame, updates);
        const owner = captureOwnerState(message.owner, message.projectileVelocities, frame);
        const packet = encodeRecipientSnapshot(encodeSnapshot(frame, recipient.frame), owner, recipient.owner);
        const wanted = expected(message); wanted.players[1].sampleInterval = recipient.interval;
        if (!step) wanted.players[2] = recipient.received.players[2];
        else wanted.players[2].sampleInterval = 6;
        if (index) wanted.players[3] = recipient.received.players[3];
        const received = recipient.decode(packet) as Snapshot;
        expect(received).toStrictEqual(wanted);
        Object.assign(recipient, { frame, owner, received });
      }
    }
  });

  test('cached public records keep distinct entity IDs when they share the same field arrays', () => {
    const message = snapshot(3), decode = client(message);
    let previous: Encoded | undefined;
    for (const id of [1, 2]) {
      const captured = captureSnapshot(message, id);
      const frame = { ...captured, players: new Map([...captured.players.keys()].map(id => [id, captured.players.get(1)!])) };
      const owner = captureOwnerState(message.owner, message.projectileVelocities, frame);
      const common = encodeSnapshot(frame, previous?.frame), packet = encodeCombinedSnapshot(frame, owner, previous?.frame, previous?.owner);
      expect(packet).toEqual(encodeRecipientSnapshot(common, owner, previous?.owner));
      expect(decode(packet)).toStrictEqual(expected(message));
      previous = { frame, owner, common, packet };
      message.tick += 3;
      for (const player of message.players) { player.sampleTick = message.tick; player.position.x++; }
      message.owner!.health--; message.owner!.ammo--;
    }
  });

  test('reusing one capture beyond its cache bound still encodes each independent history exactly', () => {
    const message = snapshot(4); message.tick = 600;
    for (const player of message.players) player.sampleTick = message.tick;
    const current = captureSnapshot(message, 1000), owner = captureOwnerState(message.owner, message.projectileVelocities, current);
    const histories: { before: Snapshot; encoded: Encoded; packet: Uint8Array }[] = [];
    for (let index = 0; index < 140; index++) {
      const before = snapshot(4); before.tick = index * 3;
      for (const player of before.players) { player.sampleTick = before.tick; player.position.x -= index / 10; }
      const encoded = encode(before, index + 1), decode = client(before); decode(encoded.packet);
      Object.freeze(encoded.frame);
      const packet = encodeRecipientSnapshot(encodeSnapshot(current, encoded.frame), owner, encoded.owner);
      expect(decode(packet)).toStrictEqual(expected(message));
      const independent = captureSnapshot(message, 1000);
      expect(encodeRecipientSnapshot(encodeSnapshot(independent, encoded.frame), owner, encoded.owner)).toEqual(packet);
      histories.push({ before, encoded, packet });
    }
    for (const index of [0, 98, 99, 100, 139]) {
      const history = histories[index], decode = client(history.before); decode(history.encoded.packet);
      const packet = encodeRecipientSnapshot(encodeSnapshot(current, history.encoded.frame), owner, history.encoded.owner);
      expect(packet).toEqual(history.packet);
      expect(decode(packet)).toStrictEqual(expected(message));
    }
  });

  test('rejects invalid cadence and future sample times without advancing the decoder baseline', () => {
    for (const sampleInterval of [0, 1, 2, 4, 5, 9, 13, 255, NaN, Infinity]) {
      const message = snapshot(); message.players[0].sampleInterval = sampleInterval as RemotePlayerState['sampleInterval'];
      expect(() => captureSnapshot(message, 1)).toThrow('Invalid player sample');
      const frame = captureSnapshot(snapshot(), 1);
      expect(() => selectSnapshotPlayers(frame, null, new Map([[1, message.players[0].sampleInterval]]))).toThrow('Invalid player sample');
    }
    const future = snapshot(); future.players[0].sampleTick = future.tick + 1;
    expect(() => captureSnapshot(future, 1)).toThrow('Invalid player sample');
    const message = snapshot(), first = encode(message, 1), decode = client(message);
    decode(first.packet);
    message.tick = 45; message.players[1].sampleTick = 45; message.players[1].sampleInterval = 12;
    const second = encode(message, 2, first);
    expect(second.common[5]).toBe(5);
    expect(second.packet[35]).toBe(45); expect(second.packet[36]).toBe(12);
    for (const [offset, value] of [[35, 46], [36, 0], [36, 9], [36, 255]]) {
      const corrupted = second.packet.slice(); corrupted[offset] = value;
      expect(() => decode(corrupted)).toThrow('Invalid player sample');
    }
    expect(decode(second.packet)).toStrictEqual(expected(message));
  });

  test('uses identical public bytes for distinct recipients and binds private deltas to the same reference', () => {
    const message = snapshot(), first = encode(message, 1);
    const otherOwner = { ...message.owner!, id: 2, name: 'Player1', health: 9, ammo: 1, lastSeq: 456 };
    const other = captureOwnerState(otherOwner, [{ id: 0, velocity: { x: 7, y: 8, z: 9 } }], first.frame);
    const otherPacket = encodeRecipientSnapshot(first.common, other);
    expect(encodeCombinedSnapshot(first.frame, other)).toEqual(otherPacket);
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
    expect(() => encodeCombinedSnapshot(second.frame, second.owner, first.frame)).toThrow('baseline mismatch');
    for (const previous of [{ ...first.owner, snapshotId: 7 }, { ...first.owner, roundId: 8 }]) {
      expect(() => encodeCombinedSnapshot(second.frame, second.owner, first.frame, previous)).toThrow('baseline mismatch');
    }
    for (const current of [{ ...second.owner, snapshotId: 7 }, { ...second.owner, roundId: 8 }]) {
      expect(() => encodeCombinedSnapshot(second.frame, current, first.frame, first.owner)).toThrow('Invalid common snapshot');
    }
    expect(() => encodeCombinedSnapshot(first.frame, first.owner, first.frame, first.owner)).toThrow('must advance');
  });

  test('combined full fallbacks reset private history and avoid materializing the complete public buffer', () => {
    const cases: ((message: Snapshot) => void)[] = [
      message => { message.players.reverse(); }, message => { message.projectiles.reverse(); },
      message => { message.players.splice(2); }, message => { message.roundId++; },
    ];
    for (const change of cases) {
      const message = snapshot(200), first = encode(message, 1);
      change(message); message.tick += 3;
      const current = captureSnapshot(message, 2), owner = captureOwnerState(message.owner, message.projectileVelocities, current);
      const common = encodeSnapshot(current, first.frame), expectedPacket = encodeRecipientSnapshot(common, owner);
      expect(common[5]).toBe(4);
      Object.defineProperty(current, 'full', { get() { throw new Error('Full public buffer must not be read'); } });
      Object.defineProperty(current, 'players', { get() { throw new Error('Player map must not be read'); } });
      const packet = encodeCombinedSnapshot(current, owner, first.frame, { ...first.owner, snapshotId: 99 });
      expect(packet).toEqual(expectedPacket);
      expect(encodeCombinedSnapshot(current, owner, first.frame)).toEqual(packet);
      expect(client(message)(packet)).toStrictEqual(expected(message));
    }
  });

  test('both packet assembly paths reject an oversized private section before writing it', () => {
    const message = snapshot(), first = encode(message, 1);
    const oversized = { ...first.owner,
      projectileVelocities: new Map(Array.from({ length: 140000 }, (_, id) => [id, [1, 2, 3]] as const)) };
    expect(() => encodeRecipientSnapshot(first.common, oversized)).toThrow('Snapshot exceeds wire limit');
    expect(() => encodeCombinedSnapshot(first.frame, oversized)).toThrow('Snapshot exceeds wire limit');
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
    for (const key of ['id', 'kills', 'deaths', 'sampleTick'] as const) for (const value of [-1, 1.5, 0x100000000, NaN, Infinity]) {
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
    for (const offset of [40, 48, 49, 78, boundary + 7]) {
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
    for (const [offset, value] of [[26, 0], [40, 0], [44, 255], [45, 2], [46, 2], [47, 2], [78, 43], [79, 0], [boundary + 2, 255], [boundary + 6, 2]]) {
      const corrupted = base.packet.slice(); corrupted[offset] = value; expect(() => decode(corrupted)).toThrow();
    }
    for (const value of [NaN, Infinity, -Infinity]) for (const offset of [50, 54, 58, 62, 66, 70, 74, boundary + 8]) {
      const corrupted = base.packet.slice(); new DataView(corrupted.buffer).setFloat32(offset, value, true);
      expect(() => decode(corrupted)).toThrow();
    }
    for (const [offset, count] of [[38, 1001], [82, 32001]]) {
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
