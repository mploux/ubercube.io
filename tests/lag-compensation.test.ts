import { describe, expect, test } from 'bun:test';
import { GameServer, type Connection, type Peer } from '../src/shared/game';
import { PLAYER_RADIUS } from '../src/shared/movement';
import { PROTOCOL_VERSION, WEAPONS, type GameEvent, type InputFrame, type Kit, type ServerMessage } from '../src/shared/protocol';
import { damageBlock, packBlock, type VoxelWorld } from '../src/shared/voxel';
import { decodeServerMessage } from '../src/shared/wire';

const size = 64;

function prepareGround(world: VoxelWorld): void {
  const ground = packBlock(90, 120, 60);
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) {
    world.set(x, 7, z, ground);
    for (let y = 8; y < world.config.height; y++) world.set(x, y, z, 0);
  }
}

class TestPeer implements Peer {
  readonly messages: ServerMessage[] = [];
  send(data: string | Uint8Array): number { this.messages.push(decodeServerMessage(data)); return data.length; }
  close(): void {}
  bufferedAmount(): number { return 0; }
}

function join(game: GameServer, name: string, kit: Kit = 'assault') {
  const peer = new TestPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name }));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit }));
  expect(connection.player?.alive).toBe(true);
  return { peer, connection, player: connection.player! };
}

function input(game: GameServer, connection: Connection, values: Partial<InputFrame> = {}): void {
  const frame: InputFrame = { seq: connection.highestSeq + 1, roundId: game.roundId, moveX: 0, moveZ: 0,
    yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, alt: false,
    weapon: connection.player!.weapon, ...values };
  game.receive(connection, JSON.stringify({ type: 'input', frames: [frame] }));
}

function fixture(weapon: 'ak47' | 'awp' = 'ak47', pitch = Math.atan2(-1, 20)) {
  const game = new GameServer({ mode: 'ffa', roundSeconds: 0,
    world: { seed: 12345, size, height: 32 } });
  const shooter = join(game, 'Shooter', weapon === 'awp' ? 'sniper' : 'assault');
  const target = join(game, 'Target');
  prepareGround(game.world);
  Object.assign(shooter.player, { position: { x: 32.5, y: 8, z: 50.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
  Object.assign(target.player, { position: { x: 32.5, y: 8, z: 30.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
  for (let tick = 0; tick < 42; tick++) {
    input(game, shooter.connection, { alt: true, pitch });
    input(game, target.connection);
    game.step();
  }
  const view = { viewTick: game.tick, viewLatestTick: game.tick, worldRevision: game.revision };
  shooter.peer.messages.length = 0;
  return { game, shooter, target, pitch, view };
}

function advance(state: ReturnType<typeof fixture>, ticks: number, movement: Partial<InputFrame> = {}): void {
  for (let tick = 0; tick < ticks; tick++) {
    input(state.game, state.shooter.connection, { alt: true, pitch: state.pitch });
    input(state.game, state.target.connection, movement);
    state.game.step();
  }
}

function fire(state: ReturnType<typeof fixture>, values: Partial<InputFrame> = {}): GameEvent[] {
  state.shooter.peer.messages.length = 0;
  input(state.game, state.shooter.connection, { alt: true, pitch: state.pitch, fire: true, ...values });
  state.game.step();
  return state.shooter.peer.messages.filter((message): message is GameEvent => message.type === 'event');
}

describe('bounded authoritative hitscan compensation', () => {
  test.each(['ak47', 'awp'] as const)('%s hits the displayed moving target and leaves its current position intact', weapon => {
    for (const compensated of [false, true]) {
      const state = fixture(weapon);
      state.target.player.velocity.x = 9;
      advance(state, 6, { moveX: 1, sprint: true });
      const before = { ...state.target.player.position };
      const events = fire(state, compensated ? state.view : {});
      expect(state.target.player.position.x).toBeCloseTo(before.x + 9 / 60, 6);
      expect(state.target.player.velocity.x).toBeCloseTo(9, 6);
      expect(state.target.player.health).toBe(compensated ? 100 - WEAPONS[weapon].damage : 100);
      const impacts = events.filter(event => event.event === 'impact' && event.targetId === state.target.player.id);
      expect(impacts).toHaveLength(compensated ? 1 : 0);
      expect(events.filter(event => event.event === 'shot')).toHaveLength(1);
      expect(state.game.projectiles.size).toBe(0);
    }
  });

  test.each([false, true])('fractional view time reproduces actual snapshot endpoints (individual snapshot: %s)', individual => {
    const state = fixture();
    const before = { ...state.target.player.position }, beforeTick = state.game.tick;
    advance(state, individual ? 2 : 3, { moveZ: -1 });
    if (individual) state.game.sendSnapshot(state.shooter.connection);
    const after = { ...state.target.player.position }, afterTick = state.game.tick;
    advance(state, 4, { moveZ: 1 });
    const events = fire(state, { ...state.view, viewTick: (beforeTick + afterTick) / 2, viewLatestTick: afterTick });
    const impact = events.find(event => event.event === 'impact' && event.targetId === state.target.player.id);
    expect(impact).toBeDefined();
    expect(impact!.position.z).toBeCloseTo((before.z + after.z) / 2 + PLAYER_RADIUS, 5);
  });

  test.each([15, 16])('rewind age %s ticks is bounded at resolution, while movement still executes', age => {
    const state = fixture();
    state.target.player.velocity.x = 9;
    advance(state, age - 1, { moveX: 1, sprint: true });
    const x = state.shooter.player.position.x;
    fire(state, { ...state.view, moveX: 1 });
    expect(state.shooter.player.position.x).toBeGreaterThan(x);
    expect(state.target.player.health).toBe(age === 15 ? 80 : 100);
    expect(state.shooter.player.lastSeq).toBe(state.shooter.connection.highestSeq);
  });

  test('the first historical player blocks a second target without being moved back', () => {
    const state = fixture();
    const nearer = join(state.game, 'Nearer');
    Object.assign(nearer.player, { position: { x: 32.5, y: 8, z: 40.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    state.game.sendSnapshot(state.shooter.connection);
    nearer.player.position.x += 4;
    state.target.player.velocity.x = 9;
    advance(state, 6, { moveX: 1, sprint: true });
    const events = fire(state, state.view);
    expect(events.filter(event => event.event === 'impact').map(event => event.targetId)).toEqual([nearer.player.id]);
    expect(nearer.player.health).toBe(80);
    expect(nearer.player.position.x).toBe(36.5);
    expect(state.target.player.health).toBe(100);
  });

  test.each([
    { viewTick: 42 }, { viewLatestTick: 42 }, { worldRevision: 0 },
    { viewTick: 42, worldRevision: 0 }, { viewTick: 42, viewLatestTick: 42 }, { viewLatestTick: 42, worldRevision: 0 },
    { viewTick: -1, viewLatestTick: 42, worldRevision: 0 },
    { viewTick: Infinity, viewLatestTick: 42, worldRevision: 0 }, { viewTick: NaN, viewLatestTick: 42, worldRevision: 0 },
    { viewTick: 45, viewLatestTick: 45, worldRevision: 0 }, { viewTick: 43, viewLatestTick: 42, worldRevision: 0 },
    { viewTick: 42, viewLatestTick: 43, worldRevision: 0 }, { viewTick: 42, viewLatestTick: 42.5, worldRevision: 0 },
    { viewTick: 42, viewLatestTick: Infinity, worldRevision: 0 }, { viewTick: 42, viewLatestTick: -1, worldRevision: 0 },
    { viewTick: 42, viewLatestTick: 42, worldRevision: .5 }, { viewTick: 42, viewLatestTick: 42, worldRevision: -1 },
    { viewTick: 42, viewLatestTick: 42, worldRevision: 1 }, { viewTick: 42, viewLatestTick: 42, worldRevision: Infinity },
  ])('rejects invalid or unobservable view metadata %j without consuming input', values => {
    const state = fixture();
    advance(state, 2);
    const sequence = state.shooter.connection.highestSeq;
    const events = fire(state, values);
    expect(state.shooter.connection.highestSeq).toBe(sequence);
    expect(state.shooter.connection.queue).toHaveLength(0);
    expect(state.shooter.peer.messages.some(message => message.type === 'error')).toBe(true);
    expect(events.some(event => event.event === 'shot')).toBe(false);
    expect(state.target.player.health).toBe(100);
  });

  test('historical headshot uses historical height and translates the corpse contact to its current position', () => {
    const state = fixture('ak47', 0);
    const oldPosition = { ...state.target.player.position };
    state.target.player.velocity.x = 9;
    advance(state, 6, { jump: true, moveX: 1, sprint: true });
    const events = fire(state, state.view);
    const impact = events.find(event => event.event === 'impact' && event.targetId === state.target.player.id)!;
    const death = events.find(event => event.event === 'death' && event.targetId === state.target.player.id)!;
    expect(impact?.headshot).toBe(true);
    expect(state.target.player.alive).toBe(false);
    expect(state.target.player.deaths).toBe(1);
    expect(death.death!.player.position).toEqual(state.target.player.position);
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(death.death!.hitPoint[axis] - impact.position[axis]).toBeCloseTo(state.target.player.position[axis] - oldPosition[axis], 5);
    }
  });

  test('a respawn cannot be hit at its previous life position', () => {
    const state = fixture();
    state.target.player.position.y = -20;
    advance(state, 1);
    expect(state.target.player.alive).toBe(false);
    state.game.receive(state.target.connection, JSON.stringify({ type: 'spawn', roundId: state.game.roundId, kit: 'assault' }));
    Object.assign(state.target.player, { position: { x: 36.5, y: 8, z: 30.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    const events = fire(state, state.view);
    expect(state.target.player.health).toBe(100);
    expect(state.target.player.deaths).toBe(1);
    expect(events.some(event => event.event === 'impact' && event.targetId === state.target.player.id)).toBe(false);
  });

  test('a newly visible arrival is hit at the latest displayed snapshot when the previous endpoint lacks it', () => {
    const state = fixture();
    advance(state, 1);
    const arrival = join(state.game, 'Arrival');
    Object.assign(arrival.player, { position: { x: 32.5, y: 8, z: 40.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    advance(state, 2);
    const view = { viewTick: 43.5, viewLatestTick: state.game.tick, worldRevision: state.game.revision };
    arrival.player.velocity.x = 9;
    input(state.game, arrival.connection, { moveX: 1, sprint: true });
    advance(state, 3);
    const events = fire(state, view);
    expect(arrival.player.position.x).toBeGreaterThan(33);
    expect(events.filter(event => event.event === 'impact').map(event => event.targetId)).toEqual([arrival.player.id]);
    expect(arrival.player.health).toBe(80);
    expect(state.target.player.health).toBe(100);
  });

  test.each([false, true])('respawn is hittable only from an image that actually contains its new life (new image: %s)', newImage => {
    const state = fixture();
    state.target.player.position.y = -20;
    advance(state, 1);
    expect(state.target.player.alive).toBe(false);
    state.game.receive(state.target.connection, JSON.stringify({ type: 'spawn', roundId: state.game.roundId, kit: 'assault' }));
    Object.assign(state.target.player, { position: { x: 32.5, y: 8, z: 30.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    advance(state, 2);
    const view = newImage ? { ...state.view, viewTick: 43.5, viewLatestTick: state.game.tick } : state.view;
    state.target.player.velocity.x = 9;
    advance(state, 3, { moveX: 1, sprint: true });
    const events = fire(state, view);
    expect(state.target.player.position.x).toBeGreaterThan(33);
    expect(events.some(event => event.event === 'impact' && event.targetId === state.target.player.id)).toBe(newImage);
    expect(state.target.player.health).toBe(newImage ? 80 : 100);
    expect(state.target.player.deaths).toBe(1);
  });

  test('a discontinuous teleport cannot be hit at the previous position', () => {
    const state = fixture();
    state.target.player.position.x += 20;
    const events = fire(state, state.view);
    expect(state.target.player.health).toBe(100);
    expect(events.some(event => event.event === 'impact' && event.targetId === state.target.player.id)).toBe(false);
  });

  test('a visible teleport uses the displayed latest position instead of interpolating across the discontinuity', () => {
    const state = fixture();
    state.target.player.position.x += 20;
    state.game.sendSnapshot(state.shooter.connection);
    advance(state, 1);
    state.target.player.position.x = 32.5;
    advance(state, 2);
    const view = { ...state.view, viewTick: 43.5, viewLatestTick: state.game.tick };
    state.target.player.velocity.x = 9;
    advance(state, 3, { moveX: 1, sprint: true });
    const events = fire(state, view);
    expect(state.target.player.position.x).toBeGreaterThan(33);
    expect(events.some(event => event.event === 'impact' && event.targetId === state.target.player.id)).toBe(true);
    expect(state.target.player.health).toBe(80);
  });

  test('old-round input is ignored after reset', () => {
    const state = fixture();
    const oldRound = state.game.roundId;
    state.game.resetRound();
    prepareGround(state.game.world);
    for (const client of [state.shooter, state.target]) {
      state.game.receive(client.connection, JSON.stringify({ type: 'spawn', roundId: state.game.roundId, kit: 'assault' }));
    }
    const sequence = state.shooter.connection.highestSeq;
    const events = fire(state, { ...state.view, roundId: oldRound });
    expect(state.shooter.connection.highestSeq).toBe(sequence);
    expect(events.some(event => event.event === 'shot')).toBe(false);
    expect(state.target.player.health).toBe(100);
  });

  test('a new-round command cannot retrieve the previous round history', () => {
    const state = fixture();
    advance(state, 2);
    state.game.resetRound();
    prepareGround(state.game.world);
    for (const client of [state.shooter, state.target]) {
      state.game.receive(client.connection, JSON.stringify({ type: 'spawn', roundId: state.game.roundId, kit: 'assault' }));
    }
    Object.assign(state.shooter.player, { position: { x: 32.5, y: 8, z: 50.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    Object.assign(state.target.player, { position: { x: 36.5, y: 8, z: 30.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    const events = fire(state, state.view);
    expect(events.filter(event => event.event === 'shot')).toHaveLength(1);
    expect(events.some(event => event.event === 'impact' && event.targetId === state.target.player.id)).toBe(false);
    expect(state.target.player.health).toBe(100);
  });

  test.each([false, true])('a wall present in the viewed revision blocks after shovel damage (destroyed: %s)', destroy => {
    const state = fixture('ak47', 0);
    const worker = join(state.game, 'Digger');
    Object.assign(worker.player, { position: { x: 34.5, y: 8, z: 38.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    const wall = packBlock(80, 120, 60, 100);
    state.game.world.set(32, 10, 38, wall);
    input(state.game, worker.connection, { weapon: 'shovel', yaw: Math.PI / 2, fire: true });
    advance(state, 1);
    if (destroy) {
      input(state.game, worker.connection, { weapon: 'shovel', yaw: Math.PI / 2 }); advance(state, 1);
      input(state.game, worker.connection, { weapon: 'shovel', yaw: Math.PI / 2, fire: true }); advance(state, 1);
    }
    const current = state.game.world.get(32, 10, 38), revision = state.game.revision;
    expect(current === 0).toBe(destroy);
    const events = fire(state, state.view);
    expect(state.target.player.health).toBe(100);
    const impact = events.find(event => event.event === 'impact' && event.shooterId === state.shooter.player.id)!;
    expect(impact?.targetId).toBeUndefined();
    expect(impact?.position.z).toBeCloseTo(39, 5);
    expect(state.game.world.get(32, 10, 38)).toBe(destroy ? 0 : damageBlock(current, WEAPONS.ak47.damage / 200));
    expect(state.game.revision).toBe(revision + (destroy ? 0 : 1));
  });

  test('a newly constructed wall blocks and takes damage from its current health', () => {
    const state = fixture('ak47', 0);
    const worker = join(state.game, 'Builder');
    Object.assign(worker.player, { position: { x: 32.5, y: 11, z: 40.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: false });
    state.game.world.set(32, 9, 38, packBlock(80, 120, 60));
    input(state.game, worker.connection, { weapon: 'shovel', pitch: Math.atan2(-3.4, 2), alt: true });
    advance(state, 1);
    const wall = state.game.world.get(32, 10, 38);
    expect(wall).not.toBe(0);
    worker.player.position.x += 4;
    const events = fire(state, state.view);
    expect(state.target.player.health).toBe(100);
    expect(events.find(event => event.event === 'impact')?.position.z).toBeCloseTo(39, 5);
    expect(state.game.world.get(32, 10, 38)).toBe(damageBlock(wall, WEAPONS.ak47.damage / 200));
  });

  test('a wall destroyed during the firing tick still blocks before world edits are flushed', () => {
    const state = fixture('ak47', 0);
    const worker = join(state.game, 'Digger');
    Object.assign(worker.player, { position: { x: 34.5, y: 8, z: 38.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
    state.game.world.set(32, 10, 38, packBlock(80, 120, 60, 1));
    input(state.game, worker.connection, { weapon: 'shovel', yaw: Math.PI / 2, fire: true });
    const events = fire(state, state.view);
    expect(state.game.world.get(32, 10, 38)).toBe(0);
    expect(state.target.player.health).toBe(100);
    const impact = events.find(event => event.event === 'impact' && event.shooterId === state.shooter.player.id)!;
    expect(impact?.targetId).toBeUndefined();
    expect(impact?.position.z).toBeCloseTo(39, 5);
  });

  test('missing terrain history falls back to current positions even with a recent view tick', () => {
    for (const knownRevision of [false, true]) {
      const state = fixture();
      const worker = join(state.game, 'Digger');
      Object.assign(worker.player, { position: { x: 34.5, y: 8, z: 38.5 }, velocity: { x: 0, y: 0, z: 0 }, grounded: true });
      state.game.world.set(32, 10, 38, packBlock(80, 120, 60, 1));
      input(state.game, worker.connection, { weapon: 'shovel', yaw: Math.PI / 2, fire: true });
      advance(state, 15);
      expect(state.game.world.get(32, 10, 38)).toBe(0);
      expect(state.game.revision).toBe(1);
      const view = { viewTick: state.game.tick, viewLatestTick: state.game.tick, worldRevision: knownRevision ? 1 : 0 };
      state.target.player.velocity.x = 9;
      advance(state, 6, { moveX: 1, sprint: true });
      const events = fire(state, view);
      expect(events.filter(event => event.event === 'shot')).toHaveLength(1);
      expect(state.target.player.health).toBe(knownRevision ? 80 : 100);
    }
  });

  test('RPG uses current positions even when valid historical view metadata is present', () => {
    const state = fixture();
    state.target.player.velocity.x = 9;
    advance(state, 6, { moveX: 1, sprint: true });
    const events = fire(state, { ...state.view, weapon: 'rpg' });
    expect(state.target.player.health).toBe(100);
    expect(events.find(event => event.event === 'shot')?.weapon).toBe('rpg');
    expect(events.some(event => event.event === 'explosion' || event.event === 'impact')).toBe(false);
    expect(state.game.projectiles.size).toBe(1);
  });
});
