import { describe, expect, spyOn, test } from 'bun:test';
import { GameServer, type Peer } from '../src/shared/game.ts';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/shared/protocol.ts';
import { packBlock, VoxelWorld } from '../src/shared/voxel.ts';
import { createServerMessageDecoder, decodeServerMessage } from '../src/shared/wire.ts';

const world = { seed: 12345, size: 64, height: 32 };
const block = packBlock(70, 70, 70);
const hello = JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Stability' });

class TestPeer implements Peer {
  messages: ServerMessage[] = [];
  buffered = 0;
  closed = false;
  result = 1;
  private readonly decode = createServerMessageDecoder();
  send(data: string | Uint8Array): number { this.messages.push(this.decode(data)); return this.result; }
  close(): void { this.closed = true; }
  bufferedAmount(): number { return this.buffered; }
}

// Drive authoritative terrain changes directly to exercise transport limits without a long combat fixture.
function mutations(game: GameServer) {
  return game as unknown as { mutate(x: number, y: number, z: number, value: number): void; flushWorld(): void };
}

function addBaseline(game: GameServer) {
  for (let i = 0; i < 600; i++) mutations(game).mutate(i % 64, 31, Math.floor(i / 64), block);
  mutations(game).flushWorld();
}

function join(game: GameServer, peer = new TestPeer()) {
  const connection = game.connect(peer)!;
  game.receive(connection, hello);
  return { peer, connection };
}

function addLargeDelta(game: GameServer) {
  for (let i = 0; i < 33000; i++) {
    mutations(game).mutate(i % 64, 1 + Math.floor(i / 4096), Math.floor(i / 64) % 64, block);
  }
  mutations(game).flushWorld();
}

function fillLargeWorld(game: GameServer, count: number) {
  for (let i = 0; i < count; i++) game.world.set(i % 128, 1 + Math.floor(i / 16384), Math.floor(i / 128) % 128, block);
}

describe('bounded network synchronization', () => {
  test('coalesces pending voxel changes without aliasing adjacent coordinate rows or losing a generated-value return', () => {
    const game = new GameServer({ world }), { peer } = join(game), replica = new VoxelWorld(world);
    const points = [[63, 1, 0], [0, 1, 1], [0, 2, 0]] as const;
    const original = game.world.get(...points[0]);
    mutations(game).mutate(...points[0], block);
    mutations(game).flushWorld();
    mutations(game).mutate(...points[0], 0);
    mutations(game).mutate(...points[0], block);
    mutations(game).mutate(...points[0], original);
    mutations(game).mutate(...points[1], block);
    mutations(game).mutate(...points[1], 0);
    mutations(game).mutate(...points[2], block);
    mutations(game).flushWorld();
    const batches = peer.messages.filter(message => message.type === 'world');
    expect(batches.at(-1)?.edits).toEqual([[...points[0], original], [...points[1], 0], [...points[2], block]]);
    for (const batch of batches) replica.applyEdits(batch.edits);
    for (const [x, y, z] of points) expect(replica.get(x, y, z)).toBe(game.world.get(x, y, z));
    expect(replica.getEdits()).toEqual(game.world.getEdits());
  });

  test('disconnects a stalled initial transfer before its retained deltas exceed the budget', () => {
    const game = new GameServer({ world });
    addBaseline(game);
    const { connection, peer } = join(game);
    expect(connection.initial).not.toBeNull();
    peer.buffered = 65537;
    addLargeDelta(game);
    expect(connection.closed).toBe(true);
    expect(peer.closed).toBe(true);
    expect(connection.initial).toBeNull();
    expect(game.connections.size).toBe(0);
    expect(game.players.size).toBe(0);
  });

  test('fails an overloaded baseline without falsely completing and reconnects to a coherent world', () => {
    const game = new GameServer({ world });
    const replica = new VoxelWorld(world);
    const target = [0, 31, 0] as const;
    const base = game.world.get(...target);
    addBaseline(game);
    const arrival = join(game);
    for (const message of arrival.peer.messages) if (message.type === 'world') replica.applyEdits(message.edits);
    expect(replica.get(...target)).toBe(block);
    mutations(game).mutate(...target, base);
    addLargeDelta(game);
    for (let i = 0; i < 100 && arrival.connection.initial; i++) game.step();
    expect(arrival.connection.closed).toBe(true);
    expect(arrival.peer.messages.some(message => message.type === 'world' && message.complete)).toBe(false);
    const reconnect = join(game);
    for (let i = 0; i < 100 && reconnect.connection.initial; i++) game.step();
    expect(reconnect.connection.closed).toBe(false);
    expect(reconnect.connection.initial).toBeNull();
    const fresh = new VoxelWorld(world);
    for (const message of reconnect.peer.messages) if (message.type === 'world') fresh.applyEdits(message.edits);
    expect(fresh.get(...target)).toBe(base);
    expect(fresh.getEdits()).toEqual(game.world.getEdits());
    const completed = reconnect.peer.messages.filter(message => message.type === 'world').at(-1)!;
    expect(completed.complete).toBe(true);
    expect(completed.revision).toBe(game.revision);
  });

  test('bounds the number of retained tiny delta messages as well as their edits', () => {
    const game = new GameServer({ world });
    addBaseline(game);
    const { connection, peer } = join(game);
    peer.buffered = 65537;
    for (let i = 0; i < 257; i++) {
      mutations(game).mutate(0, 1, 0, i % 2 ? block : 0);
      mutations(game).flushWorld();
    }
    expect(connection.closed).toBe(true);
    expect(connection.initial).toBeNull();
  });

  test('catches a reverted generated block during a successful transfer', () => {
    const game = new GameServer({ world });
    const base = game.world.get(0, 31, 0);
    addBaseline(game);
    const arrival = join(game);
    mutations(game).mutate(0, 31, 0, base);
    mutations(game).flushWorld();
    for (let i = 0; i < 10 && arrival.connection.initial; i++) game.step();
    const replica = new VoxelWorld(world);
    for (const message of arrival.peer.messages) if (message.type === 'world') replica.applyEdits(message.edits);
    expect(arrival.connection.closed).toBe(false);
    expect(arrival.connection.initial).toBeNull();
    expect(replica.getEdits()).toEqual(game.world.getEdits());
  });

  test('completes a late join while terrain changes every tick and retains generated-block reversions', () => {
    const game = new GameServer({ world });
    const base = game.world.get(0, 31, 0);
    addBaseline(game);
    const { connection, peer } = join(game);
    const replica = new VoxelWorld(world);
    let completedAt: number | null = null;
    for (let tick = 1; tick <= 120; tick++) {
      if (tick === 1) mutations(game).mutate(0, 31, 0, base);
      mutations(game).mutate(0, 1, 0, tick % 2 ? 0 : block);
      mutations(game).flushWorld();
      game.step();
      for (const message of peer.messages.splice(0)) {
        if (message.type !== 'world') continue;
        replica.applyEdits(message.edits);
        if (message.complete) completedAt = tick;
      }
    }
    expect(completedAt).not.toBeNull();
    expect(completedAt!).toBeLessThanOrEqual(5);
    expect(connection.closed).toBe(false);
    expect(connection.initial).toBeNull();
    expect(replica.get(0, 31, 0)).toBe(base);
    expect(replica.getEdits()).toEqual(game.world.getEdits());
  });

  test.each([200000, 524288])('a %s-edit baseline completes before continuous terrain changes exhaust its retained delta budget', edits => {
    const game = new GameServer({ world: { ...world, size: 128, height: 64 } });
    const base = game.world.get(0, 1, 0);
    fillLargeWorld(game, edits);
    const { connection, peer } = join(game);
    const replica = new VoxelWorld(game.options.world);
    let completedAt: number | null = null, maximumPending = 0;
    for (let tick = 1; tick <= 400 && !connection.closed; tick++) {
      if (tick === 1) mutations(game).mutate(0, 1, 0, base);
      mutations(game).mutate(127, 63, 127, tick % 2 ? block : 0);
      mutations(game).flushWorld();
      maximumPending = Math.max(maximumPending, connection.initial?.deltas.length ?? 0);
      game.step();
      for (const message of peer.messages.splice(0)) {
        if (message.type !== 'world') continue;
        replica.applyEdits(message.edits);
        if (message.complete) completedAt = tick;
      }
    }
    expect(connection.closed).toBe(false);
    expect(completedAt).not.toBeNull();
    expect(completedAt!).toBeLessThan(edits === 200000 ? 100 : 256);
    expect(maximumPending).toBeLessThan(256);
    expect(connection.initial).toBeNull();
    expect(replica.get(0, 1, 0)).toBe(base);
    expect(replica.getEdits()).toEqual(game.world.getEdits());
  });

  test('bounds baseline pacing and checks socket saturation between baseline batches', () => {
    const game = new GameServer({ world: { ...world, size: 128, height: 64 } });
    fillLargeWorld(game, 9000);
    const { connection, peer } = join(game);
    expect(connection.initial?.offset).toBe(512);
    peer.messages.length = 0;
    game.step();
    expect(peer.messages.filter(message => message.type === 'world')).toHaveLength(8);
    expect(connection.initial?.offset).toBe(512 + 8 * 512);
    peer.messages.length = 0;
    const send = peer.send.bind(peer);
    peer.send = data => { const result = send(data); peer.buffered = 65537; return result; };
    game.step();
    expect(peer.messages.filter(message => message.type === 'world')).toHaveLength(1);
    expect(connection.initial?.offset).toBe(512 + 9 * 512);
    expect(connection.closed).toBe(false);
    game.step();
    expect(peer.messages.filter(message => message.type === 'world')).toHaveLength(1);
    expect(connection.initial?.offset).toBe(512 + 9 * 512);
  });

  test('limits catch-up batches and stops between batches when the socket becomes saturated', () => {
    const game = new GameServer({ world });
    addBaseline(game);
    const { connection, peer } = join(game);
    game.step();
    for (let i = 0; i < 10; i++) {
      mutations(game).mutate(0, 1, 0, i % 2 ? block : 0);
      mutations(game).flushWorld();
    }
    peer.messages.length = 0;
    game.step();
    expect(peer.messages.filter(message => message.type === 'world')).toHaveLength(4);
    expect(connection.initial?.deltas).toHaveLength(6);
    peer.messages.length = 0;
    const send = peer.send.bind(peer);
    peer.send = data => { const result = send(data); peer.buffered = 65537; return result; };
    game.step();
    expect(peer.messages.filter(message => message.type === 'world')).toHaveLength(1);
    expect(connection.initial?.deltas).toHaveLength(5);
    expect(connection.closed).toBe(false);
  });

  test('drops snapshots individually even when the broadcast callback is configured', () => {
    const published: ServerMessage[] = [];
    const game = new GameServer({ world }, data => published.push(decodeServerMessage(data)));
    const slow = join(game), healthy = join(game);
    slow.peer.messages.length = 0;
    healthy.peer.messages.length = 0;
    published.length = 0;
    slow.peer.buffered = 65537;
    game.sendSnapshot();
    expect(slow.peer.messages.map(message => message.type)).toEqual(['roster']);
    expect(slow.peer.messages.filter(message => message.type === 'snapshot')).toHaveLength(0);
    expect(slow.connection.closed).toBe(false);
    expect(healthy.peer.messages.filter(message => message.type === 'snapshot')).toHaveLength(1);
    expect(published).toHaveLength(0);
    slow.peer.buffered = 0;
    game.sendSnapshot();
    expect(slow.peer.messages.filter(message => message.type === 'snapshot')).toHaveLength(1);
  });

  test('a reliable mutation is still delivered while snapshots are paused', () => {
    const game = new GameServer({ world });
    const { peer, connection } = join(game);
    peer.messages.length = 0;
    peer.buffered = 65537;
    mutations(game).mutate(0, 31, 0, block);
    mutations(game).flushWorld();
    game.sendSnapshot();
    expect(connection.closed).toBe(false);
    expect(peer.messages).toHaveLength(1);
    expect(peer.messages[0].type).toBe('world');
  });

  test('accepted backpressure does not duplicate the baseline batch', () => {
    const game = new GameServer({ world });
    addBaseline(game);
    const peer = new TestPeer();
    peer.result = -1;
    const { connection } = join(game, peer);
    for (let i = 0; i < 10 && connection.initial; i++) game.step();
    const received = peer.messages.filter(message => message.type === 'world');
    expect(received.flatMap(message => message.edits)).toHaveLength(600);
    expect(received.at(-1)?.complete).toBe(true);
    expect(connection.closed).toBe(false);
  });

  test('send failure closes only its destination and leaves the other destination receiving snapshots', () => {
    const game = new GameServer({ world }, () => { throw new Error('Snapshot must use individual sends'); });
    const broken = join(game), healthy = join(game);
    broken.peer.result = 0;
    healthy.peer.messages.length = 0;
    game.sendSnapshot();
    expect(broken.connection.closed).toBe(true);
    expect(healthy.connection.closed).toBe(false);
    expect(healthy.peer.messages.filter(message => message.type === 'snapshot')).toHaveLength(1);
  });

  test('the synchronization deadline uses injected elapsed time despite pings and a stalled simulation', () => {
    let now = 0;
    const game = new GameServer({ world }, undefined, () => now);
    addBaseline(game);
    const { connection, peer } = join(game);
    peer.buffered = 65537;
    for (now = 1000; now <= 30000; now += 1000) game.receive(connection, JSON.stringify({ type: 'ping', time: now }));
    game.step();
    expect(game.tick).toBe(1);
    expect(connection.closed).toBe(true);
    expect(connection.initial).toBeNull();
    expect(peer.messages.some(message => message.type === 'world' && message.complete)).toBe(false);
  });

  test('admission and idle deadlines use elapsed time without changing simulation speed', () => {
    let now = 0;
    const game = new GameServer({ world }, undefined, () => now);
    const pending = game.connect(new TestPeer())!;
    const active = join(game);
    now = 5001;
    game.step();
    expect(pending.closed).toBe(true);
    expect(active.connection.closed).toBe(false);
    now = 30001;
    game.step();
    expect(active.connection.closed).toBe(true);
    expect(game.tick).toBe(2);
  });

  test('rate windows renew by elapsed time and cannot be refilled by catch-up simulation ticks', () => {
    let now = 0;
    const game = new GameServer({ world }, undefined, () => now);
    const { connection } = join(game);
    for (let i = 0; i < 119; i++) game.receive(connection, JSON.stringify({ type: 'ping', time: i }));
    now = 1000;
    for (let i = 0; i < 120; i++) game.receive(connection, JSON.stringify({ type: 'ping', time: i }));
    expect(connection.closed).toBe(false);
    for (let i = 0; i < 60; i++) game.step();
    game.receive(connection, JSON.stringify({ type: 'ping', time: 1001 }));
    expect(connection.closed).toBe(true);
  });

  test('limits concurrent dirty-world transfers and releases slots on disconnect', () => {
    const game = new GameServer({ world });
    addBaseline(game);
    const initial = Array.from({ length: 16 }, () => join(game));
    expect(initial.every(client => !!client.connection.initial && !client.connection.closed)).toBe(true);
    const excess = join(game);
    expect(excess.connection.closed).toBe(true);
    expect(excess.connection.initial).toBeNull();
    game.disconnect(initial[0].connection);
    expect(join(game).connection.initial).not.toBeNull();
  });

  test('reset discards a partial baseline and its queued deltas before completing the new round', () => {
    const game = new GameServer({ world });
    addBaseline(game);
    const { connection, peer } = join(game);
    mutations(game).mutate(0, 1, 0, 0);
    mutations(game).flushWorld();
    game.resetRound();
    const resetIndex = peer.messages.findIndex(message => message.type === 'reset');
    const afterReset = peer.messages.slice(resetIndex + 1).filter(message => message.type === 'world');
    expect(connection.closed).toBe(false);
    expect(connection.initial).toBeNull();
    expect(afterReset).toHaveLength(1);
    expect(afterReset[0]).toMatchObject({ roundId: 2, revision: 0, edits: [], initial: true, complete: true });
  });

  test('refuses an oversized baseline before allocating its transfer copy', () => {
    const game = new GameServer({ world: { ...world, size: 128, height: 64 } });
    fillLargeWorld(game, 524289);
    expect(game.world.editCount).toBe(524289);
    const capture = spyOn(game.world, 'getEdits');
    try {
      const { connection, peer } = join(game);
      expect(connection.closed).toBe(true);
      expect(connection.initial).toBeNull();
      expect(capture).not.toHaveBeenCalled();
      expect(peer.messages.some(message => message.type === 'world')).toBe(false);
    } finally { capture.mockRestore(); }
  });

  test('bounds distinct retained baselines, shares one revision, and releases old transfer memory', () => {
    const game = new GameServer({ world: { ...world, size: 128, height: 64 } });
    fillLargeWorld(game, 360000);
    const first = join(game), sameRevision = join(game);
    const retained = first.connection.initial!.edits;
    expect(sameRevision.connection.initial!.edits).toBe(retained);
    expect(first.connection.closed).toBe(false);
    expect(sameRevision.connection.closed).toBe(false);
    mutations(game).mutate(127, 63, 127, block);
    mutations(game).flushWorld();
    expect((game as unknown as { baseline: unknown }).baseline).toBeNull();
    expect(first.connection.initial!.edits).toBe(retained);
    expect(sameRevision.connection.initial!.edits).toBe(retained);
    const secondRevision = join(game);
    expect(secondRevision.connection.closed).toBe(false);
    mutations(game).mutate(126, 63, 127, block);
    mutations(game).flushWorld();
    const refused = join(game);
    expect(refused.connection.closed).toBe(true);
    expect(refused.connection.initial).toBeNull();
    game.disconnect(first.connection);
    game.disconnect(sameRevision.connection);
    const afterRelease = join(game);
    expect(afterRelease.connection.closed).toBe(false);
    expect(afterRelease.connection.initial).not.toBeNull();
  });
});
