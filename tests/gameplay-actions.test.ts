import { expect, test } from 'bun:test';
import { GameServer } from '../src/shared/game';
import { PROTOCOL_VERSION, type GameEvent, type InputFrame, type Kit, type ServerMessage } from '../src/shared/protocol';
import { packBlock } from '../src/shared/voxel';
import { decodeServerMessage } from '../src/shared/wire';

function join(game = new GameServer(), kit: Kit = 'medic') {
  const messages: ServerMessage[] = [];
  const connection = game.connect({ send(data) { messages.push(decodeServerMessage(data)); return 1; },
    close() {}, bufferedAmount: () => 0 })!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Gameplay' }));
  const spawn = () => game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit }));
  spawn();
  const player = connection.player!;
  const frame = (values: Partial<InputFrame> = {}): InputFrame => ({ seq: connection.highestSeq + 1,
    roundId: game.roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false,
    fire: false, alt: false, weapon: player.weapon, ...values });
  const send = (values: Partial<InputFrame> = {}) => game.receive(connection, JSON.stringify({ type: 'input', frames: [frame(values)] }));
  const events = (kind: GameEvent['event']) => messages.filter((message): message is GameEvent => message.type === 'event' && message.event === kind);
  return { game, connection, player, messages, spawn, frame, send, events };
}

function floor(game: GameServer): void {
  for (let x = 99; x <= 101; x++) for (let z = 97; z <= 102; z++) {
    for (let y = 40; y < 64; y++) game.world.set(x, y, z, 0);
    game.world.set(x, 39, z, packBlock(90, 90, 90));
  }
}

test.each([[1, 100], [2.5, 100], [6, 100], [7, 93], [10, 72], [13, 50], [19.99, 1], [20, 0], [22, 0]])(
  'a fall of %s blocks leaves %s health, exactly once on landing', (height, health) => {
    const { game, player, events } = join();
    floor(game);
    player.position = { x: 100.5, y: 40 + height, z: 100.5 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.grounded = false;
    for (let tick = 0; tick < 120 && !player.grounded && player.alive; tick++) {
      expect(player.health).toBe(100);
      game.step();
    }
    expect(player.grounded).toBe(true);
    expect(player.health).toBe(health);
    expect(player.alive).toBe(health > 0);
    for (let tick = 0; tick < 90; tick++) game.step();
    expect(player.health).toBe(health);
    expect(events('death')).toHaveLength(health === 0 ? 1 : 0);
    expect(player.kills).toBe(0);
    if (health === 0) {
      const death = events('death')[0];
      expect(death.shooterId).toBe(player.id);
      expect(death.weapon).toBeUndefined();
      expect(death.death!.killer).toBeUndefined();
      expect(death.death!.impulse).toEqual({ x: 0, y: 0, z: 0 });
      expect(game.scores).toEqual(player.team === 2 ? [1, 0] : [0, 1]);
    }
  });

test('ordinary repeated jumps cause no fall damage', () => {
  const { game, player, send } = join();
  floor(game);
  player.position = { x: 100.5, y: 40, z: 100.5 };
  player.grounded = true;
  for (let tick = 0; tick < 240; tick++) { send({ jump: true }); game.step(); }
  expect(player.alive).toBe(true);
  expect(player.health).toBe(100);
});

test('a fatal landing prevents a queued heal from reviving the victim', () => {
  const { game, player, send, events } = join();
  floor(game);
  player.position = { x: 100.5, y: 60, z: 100.5 };
  player.grounded = false;
  for (let tick = 0; tick < 120 && player.alive; tick++) {
    send({ alt: tick % 2 === 0 });
    game.step();
  }
  expect(player.alive).toBe(false);
  expect(player.health).toBe(0);
  const death = events('death')[0];
  expect(death).toBeDefined();
  expect(events('heal').every(event => event.tick! < death.tick!)).toBe(true);
  send({ alt: true }); game.step();
  expect(player.health).toBe(0);
});

test('fall height is cleared after death, respawn and round reset', () => {
  const { game, player, spawn, connection } = join();
  floor(game);
  player.position = { x: 100.5, y: 60, z: 100.5 };
  game.step();
  expect(connection.fallPeakY).toBe(60);
  player.position.y = -20;
  game.step();
  spawn();
  for (let tick = 0; tick < 60; tick++) game.step();
  expect(player.health).toBe(100);
  player.position.y = 60;
  player.grounded = false;
  game.step();
  game.resetRound();
  spawn();
  for (let tick = 0; tick < 60; tick++) game.step();
  expect(player.health).toBe(100);
  expect(player.alive).toBe(true);
});

test('medic right click heals oneself once per press, caps at 100 and prioritizes self over a target', () => {
  const { game, player, send, events } = join();
  const other = join(game);
  floor(game);
  player.position = { x: 100.5, y: 40, z: 100.5 };
  other.player.position = { x: 100.5, y: 40, z: 98.5 };
  player.health = 85;
  other.player.health = 40;
  send({ alt: true, fire: true }); game.step();
  expect(player.health).toBe(95);
  expect(other.player.health).toBe(40);
  for (let tick = 0; tick < 10; tick++) { send({ alt: true }); game.step(); }
  expect(player.health).toBe(95);
  expect(events('heal')).toHaveLength(1);
  send(); game.step();
  send({ alt: true }); game.step();
  expect(player.health).toBe(100);
  send(); game.step();
  send({ fire: true }); game.step();
  expect(other.player.health).toBe(50);
  expect(events('heal').map(event => event.targetId)).toEqual([player.id, player.id, other.player.id]);
});

test('medic cancellation, weapon switching and old-round commands cannot invent a self heal', () => {
  const { game, connection, player, send, frame, spawn, events } = join();
  player.health = 50;
  send({ alt: true, cancelActions: true }); game.step();
  send({ weapon: 'ak47', alt: true }); game.step();
  send({ weapon: 'medic', alt: true }); game.step();
  expect(player.health).toBe(50);
  send(); game.step();
  const stale = frame({ alt: true });
  game.resetRound();
  spawn();
  player.health = 50;
  game.receive(connection, JSON.stringify({ type: 'input', frames: [stale] }));
  game.step();
  expect(player.health).toBe(50);
  expect(events('heal')).toHaveLength(0);
  send({ alt: true }); game.step();
  expect(player.health).toBe(60);
});

test.each([null, 1, 'true', {}, []].map(sneak => ({ sneak })))('rejects invalid sneak value %j before consuming the frame', ({ sneak }) => {
  const { game, connection, player, frame } = join();
  game.receive(connection, JSON.stringify({ type: 'input', frames: [{ ...frame({ alt: true }), sneak }] }));
  player.health = 50;
  game.step();
  expect(connection.invalid).toBe(1);
  expect(player.lastSeq).toBe(0);
  expect(player.health).toBe(50);
});

test('accepts optional sneak with cancellation and refuses forged fall state', () => {
  const { game, connection, player, send, frame } = join();
  send({ sneak: true, cancelActions: true }); game.step();
  expect(player.lastSeq).toBe(1);
  expect(connection.invalid).toBe(0);
  game.receive(connection, JSON.stringify({ type: 'input', frames: [{ ...frame(), fallPeakY: 0 }] }));
  game.step();
  expect(connection.invalid).toBe(1);
  expect(player.lastSeq).toBe(1);
});
