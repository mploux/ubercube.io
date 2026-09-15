import { describe, expect, test } from 'bun:test';
import { GameServer, type Peer } from '../src/shared/game.ts';
import { PROTOCOL_VERSION, type PlayerState, type ServerMessage } from '../src/shared/protocol.ts';
import { captureSnapshot, createServerMessageDecoder, decodeServerMessage, encodeServerMessage, encodeSnapshot, serverMessageType } from '../src/shared/wire.ts';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
const world = { seed: 12345, size: 64, height: 32 };

function snapshot(): Snapshot {
  return { type: 'snapshot', roundId: 7, tick: 42, scores: [4, 6], remaining: 45,
    players: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `Équipe 🧊 ${index}`, team: 2,
      kit: 'assault', weapon: 'ak47', alive: true, grounded: true, aiming: true, health: 100, ammo: 30,
      grenades: 10, kills: 2, deaths: 1, lastSeq: 4294967399,
      position: { x: index + .123456789, y: 8, z: 12 }, velocity: { x: 1, y: 2, z: 3 }, yaw: .45678912, pitch: -.12345678 })),
    projectiles: [{ id: 0xffffffff, owner: 1, weapon: 'grenade', position: { x: .123456789, y: 8, z: 12 },
      velocity: { x: 3, y: 2, z: 1 } }] };
}

function canonical(message: Snapshot): Snapshot {
  return decodeServerMessage(encodeServerMessage(message)) as Snapshot;
}

describe('differential snapshot codec', () => {
  test('captures immutable canonical fields once and identifies full frames independently of ticks', () => {
    const message = snapshot(), frame = captureSnapshot(message, 1), decode = createServerMessageDecoder();
    const expected = canonical(message);
    message.players[0].position.x = 999;
    message.players[0].name = 'changed'; message.scores[0] = 999;
    message.projectiles[0].velocity.y = 999;
    expect(decode(frame.full)).toStrictEqual(expected);
    expect(decodeServerMessage(frame.full)).toStrictEqual(expected);
    expect(frame.players.get(1)?.[13]).toBe(expected.players[0].position.x);
    expect(frame.scores).toEqual(expected.scores);
    expect(frame.projectiles.get(0xffffffff)?.[6]).toBe(2);
    const next = captureSnapshot(message, 2), delta = encodeSnapshot(next, frame);
    expect(delta[5]).toBe(5);
    expect(serverMessageType(frame.full)).toBe('snapshot');
    expect(serverMessageType(delta)).toBe('snapshot');
    expect(decode(delta)).toStrictEqual(canonical(message));
    expect(() => decodeServerMessage(delta)).toThrow('createServerMessageDecoder');
    expect(() => encodeServerMessage({ type: 'snapshot-delta' } as unknown as ServerMessage)).toThrow('encodeSnapshot');
    expect(() => decodeServerMessage('{"type":"snapshot-delta"}')).toThrow('createServerMessageDecoder');
  });

  const changes: [string, (player: PlayerState) => void][] = [
    ['name', player => { player.name = 'À zéro 🧊'; }], ['team', player => { player.team = 0; }],
    ['kit', player => { player.kit = 'medic'; }], ['weapon', player => { player.weapon = 'medic'; }],
    ['alive', player => { player.alive = false; }], ['grounded', player => { player.grounded = false; }],
    ['aiming', player => { player.aiming = false; }], ['health', player => { player.health = 0; }],
    ['ammo', player => { player.ammo = 0; }], ['grenades', player => { player.grenades = 0; }],
    ['kills', player => { player.kills = 0xffffffff; }], ['deaths', player => { player.deaths = 0; }],
    ['lastSeq', player => { player.lastSeq = Number.MAX_SAFE_INTEGER; }],
    ['position.x', player => { player.position.x = -0; }], ['position.y', player => { player.position.y = 0; }],
    ['position.z', player => { player.position.z = 1e-20; }], ['velocity.x', player => { player.velocity.x = 0; }],
    ['velocity.y', player => { player.velocity.y = -0; }], ['velocity.z', player => { player.velocity.z = -.654321987; }],
    ['yaw', player => { player.yaw = 0; }], ['pitch', player => { player.pitch = -0; }],
  ];
  test.each(changes)('transmits only the changed player field %s without mutating retained history', (_name, change) => {
    const message = snapshot(), first = captureSnapshot(message, 10), decode = createServerMessageDecoder();
    const before = decode(first.full) as Snapshot, saved = structuredClone(before);
    Object.freeze(before.players[0].position); Object.freeze(before.players[0].velocity); Object.freeze(before.players[0]);
    change(message.players[0]);
    const next = captureSnapshot(message, 11), delta = encodeSnapshot(next, first);
    expect(delta[5]).toBe(5);
    expect(delta.length).toBeLessThan(70);
    const received = decode(delta) as Snapshot;
    expect(received).toStrictEqual(canonical(message));
    expect(before).toStrictEqual(saved);
    expect(received.players[0]).not.toBe(before.players[0]);
    expect(received.players[1]).toBe(before.players[1]);
  });

  test('preserves every projectile field, additions, removals, global values and array order', () => {
    const message = snapshot(), first = captureSnapshot(message, 1), decode = createServerMessageDecoder();
    const before = decode(first.full) as Snapshot, saved = structuredClone(before);
    message.players.splice(2, 1);
    message.players.push({ ...structuredClone(message.players[0]), id: 0xffffffff, name: 'Entrant' });
    Object.assign(message.projectiles[0], { owner: 0xffffffff, weapon: 'shovel', position: { x: -0, y: 0, z: 1e-20 },
      velocity: { x: -.123456789, y: -0, z: 0 } });
    message.projectiles.push({ ...structuredClone(message.projectiles[0]), id: 0 });
    message.scores = [0, 0xffffffff]; message.remaining = null; message.tick++;
    const second = captureSnapshot(message, 2), delta = encodeSnapshot(second, first);
    expect(delta[5]).toBe(5);
    expect(decode(delta)).toStrictEqual(canonical(message));
    expect(before).toStrictEqual(saved);
    message.projectiles = [];
    const third = captureSnapshot(message, 3);
    expect(decode(encodeSnapshot(third, second))).toStrictEqual(canonical(message));
    message.players.reverse();
    const reordered = captureSnapshot(message, 4);
    expect(encodeSnapshot(reordered, third)).toBe(reordered.full);
    expect(decode(reordered.full)).toStrictEqual(canonical(message));
  });

  test('compares values at the existing float32 precision and uses a full frame when a delta would be larger', () => {
    const message = snapshot(), first = captureSnapshot(message, 1), decode = createServerMessageDecoder();
    decode(first.full);
    message.players[0].position.x += 1e-12;
    const second = captureSnapshot(message, 2), delta = encodeSnapshot(second, first);
    expect(delta.length).toBe(31);
    expect(decode(delta)).toStrictEqual(canonical(message));
    for (const player of message.players) for (const [, change] of changes) change(player);
    message.players = message.players.map((player, index) => ({ ...player, id: index + 100 }));
    const third = captureSnapshot(message, 3);
    expect(encodeSnapshot(third, second)).toBe(third.full);
    expect(decode(third.full)).toStrictEqual(canonical(message));
  });

  test('requires the exact last accepted reference, resets on lifecycle messages and recovers with a full frame', () => {
    const message = snapshot(), first = captureSnapshot(message, 1), decode = createServerMessageDecoder();
    message.players[0].ammo--;
    const second = captureSnapshot(message, 2), delta = encodeSnapshot(second, first);
    expect(() => decode(delta)).toThrow('baseline mismatch');
    decode(first.full);
    const wrong = delta.slice(); new DataView(wrong.buffer).setUint32(18, 123, true);
    expect(() => decode(wrong)).toThrow('baseline mismatch');
    expect(decode(delta)).toStrictEqual(canonical(message));
    expect(() => decode(delta)).toThrow('baseline mismatch');
    for (const lifecycle of [
      { type: 'reset', roundId: 8, world },
      { type: 'welcome', id: 1, roundId: 7, mode: 'ffa', maxPlayers: 100, world, tickRate: 60 },
    ] satisfies ServerMessage[]) {
      decode(first.full); decode(encodeServerMessage(lifecycle));
      expect(() => decode(delta)).toThrow('baseline mismatch');
      expect(decode(second.full)).toStrictEqual(canonical(message));
    }
    message.roundId++;
    const reset = captureSnapshot(message, 3);
    expect(encodeSnapshot(reset, second)).toBe(reset.full);
    expect(decode(reset.full)).toStrictEqual(canonical(message));
    expect(() => decode(delta)).toThrow('baseline mismatch');
    const freshConnection = createServerMessageDecoder();
    expect(() => freshConnection(delta)).toThrow('baseline mismatch');
    expect(freshConnection(reset.full)).toStrictEqual(canonical(message));
  });

  test('rejects malformed deltas transactionally, including truncation, flags, counts and numeric encodings', () => {
    const message = snapshot(), first = captureSnapshot(message, 1), decode = createServerMessageDecoder();
    decode(first.full); message.players[0].ammo = 0;
    const second = captureSnapshot(message, 2), delta = encodeSnapshot(second, first);
    expect(delta[5]).toBe(5);
    for (let length = 0; length < delta.length; length++) expect(() => decode(delta.subarray(0, length))).toThrow();
    const trailing = new Uint8Array(delta.length + 1); trailing.set(delta);
    expect(() => decode(trailing)).toThrow();
    for (const [offset, value] of [[4, 255], [22, 128], [27, 127], [28, 0], [29, 255]]) {
      const corrupt = delta.slice(); corrupt[offset] = value;
      expect(() => decode(corrupt)).toThrow();
    }
    for (const [offset, value] of [[6, 9], [14, 0], [14, 1], [18, 9]]) {
      const corrupt = delta.slice(); new DataView(corrupt.buffer).setUint32(offset, value, true);
      expect(() => decode(corrupt)).toThrow();
    }
    const count = delta.slice(); new DataView(count.buffer).setUint16(25, 1001, true);
    expect(() => decode(count)).toThrow();
    expect(decode(delta)).toStrictEqual(canonical(message));
    message.players[0].alive = false;
    const third = captureSnapshot(message, 3), boolean = encodeSnapshot(third, second);
    const invalidBoolean = boolean.slice(); invalidBoolean[29] = 2;
    expect(() => decode(invalidBoolean)).toThrow('Invalid player flags');
    expect(decode(boolean)).toStrictEqual(canonical(message));
    message.players[0].yaw = .1;
    const fourth = captureSnapshot(message, 4), floating = encodeSnapshot(fourth, third);
    const nan = floating.slice(); new DataView(nan.buffer).setFloat32(31, NaN, true);
    expect(() => decode(nan)).toThrow('Invalid wire float');
    expect(decode(floating)).toStrictEqual(canonical(message));
  });

  test('supports byte views and rejects duplicate identities and invalid full-frame IDs', () => {
    const message = snapshot(), first = captureSnapshot(message, 1);
    message.players[0].ammo--;
    const second = captureSnapshot(message, 2), delta = encodeSnapshot(second, first);
    for (const asView of [false, true]) {
      const decode = createServerMessageDecoder(); decode(first.full);
      const padded = new Uint8Array(delta.length + 19).fill(255); padded.set(delta, 7);
      expect(decode(asView ? new DataView(padded.buffer, 7, delta.length) : padded.subarray(7, 7 + delta.length)))
        .toStrictEqual(canonical(message));
    }
    expect(() => captureSnapshot(message, 0)).toThrow('Invalid snapshot id');
    message.players[1].id = message.players[0].id;
    expect(() => captureSnapshot(message, 3)).toThrow('Duplicate snapshot id');
    const invalid = first.full.slice(); new DataView(invalid.buffer).setUint32(6, 0, true);
    expect(() => decodeServerMessage(invalid)).toThrow('Invalid snapshot id');
  });
});

class RecordingPeer implements Peer {
  readonly messages: ServerMessage[] = [];
  readonly packets: (string | Uint8Array)[] = [];
  private readonly decode = createServerMessageDecoder();
  buffered = 0;
  result = 1;
  closed = false;
  send(data: string | Uint8Array) {
    if (!this.result) return 0;
    this.packets.push(data); this.messages.push(this.decode(data)); return this.result;
  }
  bufferedAmount() { return this.buffered; }
  close() { this.closed = true; }
  get lastSnapshot() { return this.messages.filter(message => message.type === 'snapshot').at(-1) as Snapshot; }
  get lastPacket() { return this.packets.filter(packet => serverMessageType(packet) === 'snapshot').at(-1) as Uint8Array; }
}

function join(game: GameServer) {
  const peer = new RecordingPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Player${game.players.size}` }));
  return { peer, connection };
}

describe('authoritative snapshot streams', () => {
  test('shares one immutable reference and packet for recipients with the same baseline, including accepted backpressure', () => {
    const game = new GameServer({ world }), clients = Array.from({ length: 3 }, () => join(game));
    game.sendSnapshot();
    expect(new Set(clients.map(client => client.connection.snapshot)).size).toBe(1);
    const previous = clients[0].connection.snapshot;
    clients[0].connection.player!.ammo--;
    clients[0].peer.result = -1;
    game.sendSnapshot();
    expect(new Set(clients.map(client => client.peer.lastPacket)).size).toBe(1);
    expect(clients[0].peer.lastPacket[5]).toBe(5);
    expect(new Set(clients.map(client => client.connection.snapshot)).size).toBe(1);
    expect(clients[0].connection.snapshot).not.toBe(previous);
    expect(clients[0].peer.lastSnapshot).toStrictEqual(clients[1].peer.lastSnapshot);
    expect(previous?.players.get(1)?.[8]).toBe(30);
  });

  test('repairs a skipped recipient with a complete frame while healthy recipients continue using deltas', () => {
    const game = new GameServer({ world }), slow = join(game), healthy = join(game), leaving = join(game);
    game.sendSnapshot();
    slow.peer.buffered = 65537;
    const lastPacket = slow.peer.lastPacket;
    leaving.connection.player!.position.x += 4;
    game.sendSnapshot();
    expect(slow.peer.lastPacket).toBe(lastPacket);
    expect(slow.connection.snapshot).toBeNull();
    expect(healthy.peer.lastPacket[5]).toBe(5);
    game.disconnect(leaving.connection);
    expect(leaving.connection.snapshot).toBeNull();
    healthy.connection.player!.ammo = 0;
    game.sendSnapshot();
    slow.peer.buffered = 0;
    game.sendSnapshot();
    expect(slow.peer.lastPacket[5]).toBe(4);
    expect(healthy.peer.lastPacket[5]).toBe(5);
    expect(slow.peer.lastSnapshot).toStrictEqual(healthy.peer.lastSnapshot);
    expect(slow.peer.lastSnapshot.players.map(player => player.id)).toEqual([...game.players.keys()]);
    expect(slow.connection.snapshot).toBe(healthy.connection.snapshot);
  });

  test('same-tick spawns, resets, failed sends and reconnections cannot reuse an incompatible reference', () => {
    const game = new GameServer({ world }), first = join(game), second = join(game);
    const before = first.connection.snapshot;
    game.receive(first.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    expect(first.connection.snapshot?.tick).toBe(before?.tick);
    expect(first.connection.snapshot?.id).not.toBe(before?.id);
    expect(first.peer.lastSnapshot.players[0].alive).toBe(true);
    game.resetRound();
    expect(first.peer.lastPacket[5]).toBe(4);
    expect(first.peer.lastSnapshot.roundId).toBe(game.roundId);
    expect(first.peer.lastSnapshot.players.every(player => !player.alive)).toBe(true);
    first.peer.result = 0;
    game.sendSnapshot();
    expect(first.connection.snapshot).toBeNull();
    expect(first.connection.closed && first.peer.closed).toBe(true);
    expect(second.connection.closed).toBe(false);
    const replacement = join(game);
    expect(replacement.peer.lastPacket[5]).toBe(4);
    expect(replacement.peer.lastSnapshot.players.map(player => player.id)).toEqual([...game.players.keys()]);
  });
});
