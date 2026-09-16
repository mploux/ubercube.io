import { describe, expect, test } from 'bun:test';
import { GameServer, type Connection, type Peer } from '../src/shared/game';
import { PROTOCOL_VERSION, type PlayerState, type RemotePlayerState, type ServerMessage, type Vec3 } from '../src/shared/protocol';
import { createServerMessageDecoder } from '../src/shared/wire';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
const world = { seed: 12345, size: 256, height: 64 };

class RecordingPeer implements Peer {
  readonly decode = createServerMessageDecoder();
  snapshot!: Snapshot;
  snapshotBytes = 0;
  readonly snapshotTicks: number[] = [];
  buffered = 0;
  closed = false;
  send(data: string | Uint8Array) {
    const message = this.decode(data);
    if (message.type === 'snapshot') {
      this.snapshot = message;
      this.snapshotTicks.push(message.tick);
      this.snapshotBytes += typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    }
    return 1;
  }
  bufferedAmount() { return this.buffered; }
  close() { this.closed = true; }
}

function join(game: GameServer, position: Vec3 = { x: 128, y: 32, z: 128 }) {
  const peer = new RecordingPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Player${game.players.size}` }));
  const player = connection.player!;
  Object.assign(player, { alive: true, position: { ...position }, yaw: 0, pitch: 0 });
  return { peer, connection, player };
}

function remote(peer: RecordingPeer, player: PlayerState): RemotePlayerState {
  return peer.snapshot.players.find(value => value.id === player.id)!;
}

function advance(game: GameServer, observer: Connection, ticks = 3) {
  for (let elapsed = 0; elapsed < ticks; elapsed += 3) {
    game.tick += 3;
    // Move everyone equally so only scheduling, rather than unchanged coordinates, suppresses updates.
    for (const player of game.players.values()) player.position.x += 1 / 1024;
    game.sendSnapshot(observer);
  }
}

describe('recipient movement relevancy', () => {
  test('spreads 100 recipients over three ticks while every recipient receives 20 snapshots per second', () => {
    const game = new GameServer({ world }), clients = Array.from({ length: 100 }, () => join(game));
    for (const client of clients) {
      client.player.alive = false;
      client.peer.snapshotTicks.length = 0;
    }
    for (let tick = 0; tick < 60; tick++) game.step();
    const perTick = new Map<number, number>();
    for (const client of clients) {
      expect(client.peer.snapshotTicks).toHaveLength(20);
      for (const [index, tick] of client.peer.snapshotTicks.entries()) {
        expect(tick % 3).toBe(client.connection.snapshotPhase);
        if (index) expect(tick - client.peer.snapshotTicks[index - 1]).toBe(3);
        perTick.set(tick, (perTick.get(tick) ?? 0) + 1);
      }
    }
    expect([...perTick.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect([perTick.get(3), perTick.get(1), perTick.get(2)]).toEqual([34, 33, 33]);
    expect(Math.max(...perTick.values())).toBe(34);
    const phases = clients.map(client => client.connection.snapshotPhase);
    game.resetRound();
    expect(clients.map(client => client.connection.snapshotPhase)).toEqual(phases);
    expect(clients.every(client => client.peer.snapshot.tick === game.tick)).toBe(true);
  });

  test('balances replacement recipients after selective departures instead of following their player IDs', () => {
    const game = new GameServer({ world });
    let clients = Array.from({ length: 100 }, () => join(game));
    for (const phase of [0, 1, 2]) {
      const leaving = clients.filter(client => client.connection.snapshotPhase === phase);
      for (const client of leaving) game.disconnect(client.connection);
      clients = clients.filter(client => !client.connection.closed);
      for (const _ of leaving) {
        clients.push(join(game));
        expect(Math.max(...[0, 1, 2].map(value => clients.filter(client => client.connection.snapshotPhase === value).length))).toBeLessThanOrEqual(34);
      }
      expect([0, 1, 2].map(value => clients.filter(client => client.connection.snapshotPhase === value).length).sort()).toEqual([33, 33, 34]);
    }
    for (const client of clients) {
      client.player.alive = false;
      client.peer.snapshotTicks.length = 0;
    }
    for (let tick = 0; tick < 3; tick++) game.step();
    const counts = [1, 2, 3].map(tick => clients.filter(client => client.peer.snapshotTicks.includes(tick)).length);
    expect(counts.sort()).toEqual([33, 33, 34]);
    expect(clients.every(client => client.peer.snapshotTicks.length === 1)).toBe(true);
    game.sendSnapshot();
    expect(clients.every(client => client.peer.snapshotTicks.length === 2)).toBe(true);
  });

  test.each([0, 1, 2])('preserves 20/10/5 Hz sample times on recipient phase %s', phase => {
    const game = new GameServer({ world });
    for (let index = 0; index < phase; index++) join(game);
    const observer = join(game, { x: 128, y: 512, z: 128 });
    const targets: { target: ReturnType<typeof join>; interval: 3 | 6 | 12; count: number; received: number }[] = [
      { target: join(game, { x: 128, y: 512, z: 98 }), interval: 3, count: 40, received: 0 },
      { target: join(game, { x: 128, y: 512, z: 28 }), interval: 6, count: 20, received: 0 },
      { target: join(game, { x: 128, y: 512, z: 228 }), interval: 12, count: 10, received: 0 },
    ];
    expect(observer.connection.snapshotPhase).toBe(phase);
    for (let tick = 0; tick < 24; tick++) game.step();
    observer.peer.snapshotTicks.length = 0;
    for (let tick = 0; tick < 120; tick++) {
      game.step();
      if (observer.peer.snapshot.tick !== game.tick) continue;
      expect(game.tick % 3).toBe(phase);
      expect(remote(observer.peer, observer.player).sampleTick).toBe(game.tick);
      for (const entry of targets) {
        const state = remote(observer.peer, entry.target.player);
        expect(state.sampleInterval).toBe(entry.interval);
        if (state.sampleTick === game.tick) entry.received++;
      }
    }
    expect(observer.peer.snapshotTicks).toHaveLength(40);
    expect(targets.map(entry => entry.received)).toEqual(targets.map(entry => entry.count));
  });

  test('keeps nearby and forward movement at 20 Hz, distant movement at 10 Hz and rear movement at 5 Hz', () => {
    const game = new GameServer({ world }), observer = join(game);
    const cases = ([
      { position: { x: 128, y: 32, z: 133 }, interval: 3, count: 40 },
      { position: { x: 128, y: 32, z: 133.125 }, interval: 12, count: 10 },
      { position: { x: 128, y: 32, z: 98 }, interval: 3, count: 40 },
      { position: { x: 158, y: 32, z: 128 }, interval: 3, count: 40 },
      { position: { x: 128, y: 32, z: 78 }, interval: 3, count: 40 },
      { position: { x: 128, y: 32, z: 48 }, interval: 6, count: 20 },
      { position: { x: 128, y: 32, z: 208 }, interval: 12, count: 10 },
    ] satisfies { position: Vec3; interval: 3 | 6 | 12; count: number }[])
      .map(value => ({ ...value, target: join(game, value.position), received: 0 }));
    game.sendSnapshot(observer.connection);
    const initial = observer.peer.snapshot, saved = structuredClone(initial);
    advance(game, observer.connection, 24);
    let ownUpdates = 0;
    for (let tick = 0; tick < 120; tick += 3) {
      advance(game, observer.connection);
      if (remote(observer.peer, observer.player).sampleTick === game.tick) ownUpdates++;
      expect(observer.peer.snapshot.owner!.position).toEqual(observer.player.position);
      for (const entry of cases) {
        const state = remote(observer.peer, entry.target.player);
        expect(state.sampleInterval).toBe(entry.interval);
        if (state.sampleTick === game.tick) entry.received++;
      }
    }
    expect(ownUpdates).toBe(40);
    expect(cases.map(entry => entry.received)).toEqual(cases.map(entry => entry.count));
    expect(initial).toEqual(saved);
  });

  test('keeps independent schedules and baselines for observers looking in opposite directions', () => {
    const game = new GameServer({ world }), forward = join(game), backward = join(game);
    const target = join(game, { x: 128, y: 32, z: 158 });
    backward.player.yaw = Math.PI;
    game.sendSnapshot();
    for (let tick = 0; tick < 36; tick += 3) {
      game.tick += 3;
      target.player.position.x += 1 / 1024;
      game.sendSnapshot();
      expect(remote(backward.peer, target.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
    }
    let held = 0;
    for (let tick = 0; tick < 12; tick += 3) {
      game.tick += 3;
      target.player.position.x += 1 / 1024;
      game.sendSnapshot();
      const slow = remote(forward.peer, target.player), fast = remote(backward.peer, target.player);
      expect(slow.sampleInterval).toBe(12);
      expect(fast).toMatchObject({ sampleTick: game.tick, position: target.player.position });
      if (slow.sampleTick < fast.sampleTick) held++;
    }
    expect(held).toBe(3);
    expect(forward.connection.snapshot).not.toBe(backward.connection.snapshot);
    target.player.position = { ...forward.player.position, z: forward.player.position.z + 4 };
    game.tick += 3;
    game.sendSnapshot();
    expect(remote(forward.peer, target.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
  });

  test('keeps a margin behind the view plane and respects camera pitch', () => {
    const game = new GameServer({ world }), observer = join(game);
    const margin = join(game, { x: 158, y: 32, z: 133 });
    const rear = join(game, { x: 158, y: 32, z: 138 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    expect(remote(observer.peer, margin.player).sampleInterval).toBe(3);
    expect(remote(observer.peer, rear.player).sampleInterval).toBe(12);
    observer.player.pitch = Math.PI / 2;
    rear.player.position = { x: observer.player.position.x, y: 62, z: observer.player.position.z };
    advance(game, observer.connection);
    expect(remote(observer.peer, rear.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
  });

  test('prioritizes distant sniper targets before zoom and keeps them fresh while aiming', () => {
    const game = new GameServer({ world }), observer = join(game);
    const forward = join(game, { x: 128, y: 32, z: 28 });
    const side = join(game, { x: 188, y: 32, z: 48 });
    const rear = join(game, { x: 128, y: 32, z: 228 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    expect(remote(observer.peer, forward.player).sampleInterval).toBe(6);
    observer.player.weapon = 'awp';
    expect(observer.player.aiming).toBe(false);
    advance(game, observer.connection);
    for (const target of [forward, side]) {
      expect(remote(observer.peer, target.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
    }
    expect(remote(observer.peer, rear.player).sampleInterval).toBe(12);
    observer.player.aiming = true;
    for (let tick = 0; tick < 60; tick += 3) {
      advance(game, observer.connection);
      expect(remote(observer.peer, forward.player).sampleTick).toBe(game.tick);
    }
  });

  test('promotes targets immediately on a turn and waits for a persistent lower priority before demoting', () => {
    const game = new GameServer({ world }), observer = join(game), target = join(game, { x: 128, y: 32, z: 158 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    expect(remote(observer.peer, target.player).sampleInterval).toBe(12);
    observer.player.yaw = Math.PI;
    advance(game, observer.connection);
    expect(remote(observer.peer, target.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
    observer.player.yaw = 0;
    for (let tick = 0; tick < 12; tick += 3) {
      advance(game, observer.connection);
      expect(remote(observer.peer, target.player).sampleInterval).toBe(3);
    }
    advance(game, observer.connection, 12);
    expect(remote(observer.peer, target.player).sampleInterval).toBe(12);
    observer.player.yaw = Math.PI;
    advance(game, observer.connection);
    for (let index = 0; index < 8; index++) {
      observer.player.yaw = index % 2 ? Math.PI : 0;
      advance(game, observer.connection);
      expect(remote(observer.peer, target.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
    }
  });

  test.each([
    ['weapon', 'awp'], ['alive', false], ['aiming', true], ['grenades', 0], ['kills', 1], ['deaths', 1],
  ] as const)('sends critical %s changes with fresh motion outside the movement cadence', (field, value) => {
    const game = new GameServer({ world }), observer = join(game), target = join(game, { x: 128, y: 32, z: 158 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    do advance(game, observer.connection); while (remote(observer.peer, target.player).sampleTick === game.tick);
    Object.assign(target.player, { [field]: value });
    target.player.position.y += 1;
    game.sendSnapshot(observer.connection);
    const state = remote(observer.peer, target.player);
    expect(state.sampleTick).toBe(game.tick);
    expect(state.position).toEqual(target.player.position);
    expect(state).toHaveProperty(field === 'grenades' ? 'hasGrenades' : field, field === 'grenades' ? false : value);
  });

  test('updates every player at full cadence for a dead observer with a detached camera', () => {
    const game = new GameServer({ world }), observer = join(game), target = join(game, { x: 128, y: 32, z: 228 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    observer.player.alive = false;
    for (let tick = 0; tick < 30; tick += 3) {
      advance(game, observer.connection);
      expect(remote(observer.peer, target.player)).toMatchObject({ sampleTick: game.tick, sampleInterval: 3 });
    }
  });

  test('repairs all movement and private corrections after a skipped snapshot', () => {
    const game = new GameServer({ world }), observer = join(game), target = join(game, { x: 128, y: 32, z: 228 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    const before = observer.peer.snapshot;
    observer.peer.buffered = 65537;
    advance(game, observer.connection);
    expect(observer.peer.snapshot).toBe(before);
    expect(observer.connection.snapshot).toBeNull();
    observer.peer.buffered = 0;
    observer.player.health = 19;
    advance(game, observer.connection);
    expect(remote(observer.peer, target.player)).toMatchObject({ sampleTick: game.tick, position: target.player.position });
    expect(observer.peer.snapshot.owner).toMatchObject({ health: 19, position: observer.player.position });
  });

  test('introduces, removes and respawns distant players without waiting for their movement slot', () => {
    const game = new GameServer({ world }), observer = join(game), leaving = join(game, { x: 128, y: 32, z: 228 });
    game.sendSnapshot(observer.connection);
    advance(game, observer.connection, 24);
    const arriving = join(game, { x: 128, y: 32, z: 218 });
    advance(game, observer.connection);
    expect(remote(observer.peer, arriving.player)).toMatchObject({ sampleTick: game.tick, position: arriving.player.position });
    game.disconnect(leaving.connection);
    advance(game, observer.connection);
    expect(remote(observer.peer, leaving.player)).toBeUndefined();
    arriving.player.alive = false;
    arriving.player.deaths++;
    advance(game, observer.connection);
    expect(remote(observer.peer, arriving.player)).toMatchObject({ alive: false, deaths: 1, sampleTick: game.tick });
    game.receive(arriving.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'sniper' }));
    expect(arriving.player.alive).toBe(true);
    advance(game, observer.connection);
    expect(remote(observer.peer, arriving.player)).toMatchObject({ alive: true, weapon: 'awp', deaths: 1, sampleTick: game.tick });
    const previousRound = game.roundId;
    game.resetRound();
    expect(observer.peer.snapshot.roundId).toBe(previousRound + 1);
    for (const player of observer.peer.snapshot.players) {
      expect(player).toMatchObject({ alive: false, deaths: 0, sampleTick: game.tick });
    }
  });

  test('preserves a pending demotion when another departure shifts player order', () => {
    const game = new GameServer({ world }), observer = join(game);
    const leaving = join(game, { x: 128, y: 32, z: 133 });
    const target = join(game, { x: 128, y: 32, z: 98 });
    game.sendSnapshot(observer.connection);
    target.player.position.z = 158;
    advance(game, observer.connection, 9);
    expect(remote(observer.peer, target.player).sampleInterval).toBe(3);
    game.disconnect(leaving.connection);
    advance(game, observer.connection);
    expect(remote(observer.peer, target.player).sampleInterval).toBe(3);
    advance(game, observer.connection);
    expect(remote(observer.peer, target.player).sampleInterval).toBe(12);
  });

  test('reduces recipient snapshot bytes for 100 equally moving players when rear players use 5 Hz', () => {
    const measure = (behind: boolean) => {
      const game = new GameServer({ world }), observer = join(game);
      for (let index = 0; index < 99; index++) join(game, { x: 128 + index / 128, y: 32, z: behind ? 158 : 98 });
      game.sendSnapshot(observer.connection);
      advance(game, observer.connection, 24);
      observer.peer.snapshotBytes = 0;
      const updates: number[] = [];
      for (let tick = 0; tick < 120; tick += 3) {
        advance(game, observer.connection);
        updates.push(observer.peer.snapshot.players.filter(player => player.sampleTick === game.tick).length);
      }
      return { bytes: observer.peer.snapshotBytes, updates };
    };
    const front = measure(false), rear = measure(true);
    expect(rear.bytes).toBeLessThan(front.bytes * .5);
    expect(front.updates.every(count => count === 100)).toBe(true);
    expect(Math.min(...rear.updates)).toBe(25);
    expect(Math.max(...rear.updates)).toBe(26);
  });
});
