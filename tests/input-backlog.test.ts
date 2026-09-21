import { expect, test } from 'bun:test';
import { GameServer } from '../src/server/game';
import { DT, PROTOCOL_VERSION, type GameEvent, type InputFrame, type Kit, type ServerMessage, type WeaponId } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';
import { packBlock } from '../src/shared/voxel';

function join(game = new GameServer(), kit: Kit = 'assault') {
  const messages: ServerMessage[] = [];
  const connection = game.connect({
    send(data) { messages.push(decodeServerMessage(data)); return typeof data === 'string' ? data.length : data.byteLength; },
    close() {}, bufferedAmount: () => 0,
  })!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Player${game.players.size}` }));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit }));
  const player = connection.player!;
  const send = (...values: Partial<InputFrame>[]) => {
    const frames = values.map((value, index): InputFrame => ({ seq: connection.highestSeq + index + 1,
      roundId: game.roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
      jump: false, sprint: false, fire: false, alt: false, weapon: player.weapon, ...value }));
    game.receive(connection, JSON.stringify({ type: 'input', frames }));
    return frames;
  };
  const events = (event: GameEvent['event']) => messages.filter((message): message is GameEvent => message.type === 'event' && message.event === event);
  return { game, connection, player, messages, send, events };
}

test('a resumed backlog uses the newest held movement without extra simulation or weapon motion steps', () => {
  const { game, connection, player, send } = join();
  player.position = { x: 100.5, y: 60, z: 100.5 };
  send({}); game.step();
  const start = { ...player.position };
  send(...Array.from({ length: 8 }, (_, index) => ({ moveX: 1, moveZ: 1, sprint: true, yaw: index / 8, pitch: index / 10 })));
  game.step();
  expect(connection.queue).toHaveLength(0);
  expect(player.lastSeq).toBe(9);
  expect(player.yaw).toBe(7 / 8);
  expect(player.pitch).toBe(.7);
  expect(Math.hypot(player.position.x - start.x, player.position.z - start.z)).toBeLessThanOrEqual(9 * DT);
  expect(connection.weaponMotion).toEqual({ x: -.015, y: 0, z: .015 });
  expect(connection.weaponPoses.get('ak47')!.bobTime).toBe(2);
});

test.each([
  { fire: true }, { alt: true }, { jump: true }, { sneak: true }, { cancelActions: true }, { weapon: 'shovel' as WeaponId },
])('preserves the first %j transition and its original sequence', change => {
  const { game, player, send } = join();
  send({}); game.step();
  send(change, change, change, {});
  game.step(); expect(player.lastSeq).toBe(2);
  game.step(); expect(player.lastSeq).toBe(4);
  game.step(); expect(player.lastSeq).toBe(5);
});

test('omitted and explicit false cancellation and sneak are equivalent held inputs', () => {
  const { game, connection, player, send } = join();
  send({}); game.step();
  send({ cancelActions: false, sneak: false }, {}, { cancelActions: false, sneak: false });
  game.step();
  expect(player.lastSeq).toBe(4);
  expect(connection.queue).toHaveLength(0);
});

test('self healing preserves right-button edges through coalesced inputs', () => {
  const { game, player, send, events } = join(undefined, 'medic');
  player.health = 40;
  send({}); game.step();
  send({ alt: true }, { alt: true }, { alt: true }, {}, { alt: true }, { alt: true }, { alt: true }, {});
  for (let tick = 0; tick < 6; tick++) game.step();
  expect(player.health).toBe(60);
  expect(events('heal')).toHaveLength(2);
  expect(events('heal').every(event => event.shooterId === player.id && event.targetId === player.id)).toBe(true);
});

test('grenade charges once per server tick and throws once using the original release sequence', () => {
  const { game, connection, player, send, events } = join();
  player.position = { x: 128.5, y: 55, z: 160.5 };
  send({ weapon: 'grenade', fire: true }); game.step();
  send(...Array.from({ length: 6 }, () => ({ weapon: 'grenade' as WeaponId, fire: true })),
    { weapon: 'grenade', fire: false }, { weapon: 'grenade', fire: false });
  game.step();
  expect(player.lastSeq).toBe(7);
  expect(connection.weaponPoses.get('grenade')!.charge).toBeCloseTo(2.7 * (1 - .9 ** 2));
  expect(player.grenades).toBe(10);
  game.step(); game.step();
  const shots = events('shot');
  expect(shots).toHaveLength(1);
  expect(shots[0].inputSeq).toBe(8);
  expect(shots[0].tick).toBe(3);
  expect(Math.hypot(shots[0].velocity!.x, shots[0].velocity!.y, shots[0].velocity!.z)).toBeCloseTo(2.7 * (1 - .9 ** 2) * .9 * 60);
  expect(player.grenades).toBe(9);
});

test('queued grenade cancellation stays an edge, cannot throw, and allows a later independent press/release', () => {
  const { game, connection, player, send, events } = join();
  send({ weapon: 'grenade', fire: true }); game.step();
  send({ fire: true }, { fire: true }, { fire: true }, { cancelActions: true }, { cancelActions: true }, {});
  game.step(); expect(player.lastSeq).toBe(4);
  game.step(); expect(player.lastSeq).toBe(5);
  expect(connection.weaponPoses.get('grenade')!.charge).toBe(0);
  game.step(); game.step();
  expect(events('shot')).toHaveLength(0);
  expect(player.grenades).toBe(10);
  send({ fire: true }, { fire: true }, {});
  game.step(); game.step(); game.step();
  expect(events('shot')).toHaveLength(1);
  expect(events('shot')[0].inputSeq).toBe(10);
  expect(player.grenades).toBe(9);
});

test('initial and timed-out commands retain their first frame instead of reusing stale action state', () => {
  const { game, connection, player, send, events } = join();
  send(...Array.from({ length: 6 }, () => ({ weapon: 'grenade' as WeaponId, fire: true })));
  game.step(); expect(player.lastSeq).toBe(1);
  game.step(); expect(player.lastSeq).toBe(6);
  for (let tick = 0; tick < 16; tick++) game.step();
  expect(connection.weaponPoses.get('grenade')!.charge).toBe(0);
  send({ fire: true }, { fire: true }, { fire: true });
  game.step(); expect(player.lastSeq).toBe(7);
  expect(connection.weaponPoses.get('grenade')!.charge).toBeCloseTo(.27);
  game.step(); expect(player.lastSeq).toBe(9);
  send({}); game.step();
  expect(events('shot')).toHaveLength(1);
  expect(events('shot')[0].inputSeq).toBe(10);
  expect(Math.hypot(events('shot')[0].velocity!.x, events('shot')[0].velocity!.y, events('shot')[0].velocity!.z)).toBeCloseTo(2.7 * (1 - .9 ** 2) * .9 * 60);
});

test.each(['assault', 'sniper'] as const)('%s firing cadence stays tied to server ticks when six identical held commands arrive together', kit => {
  const { game, player, send, events, messages } = join(undefined, kit);
  const duration = kit === 'assault' ? 96 : 187;
  for (let tick = 0; tick < duration; tick++) {
    if (tick % 6 === 0) send(...Array.from({ length: 6 }, () => ({ fire: true, alt: true, pitch: 1.4 })));
    game.step();
  }
  const interval = kit === 'assault' ? 8 : 62;
  const shots = events('shot');
  expect(shots).toHaveLength(Math.ceil(duration / interval));
  for (let index = 1; index < shots.length; index++) expect(shots[index].tick! - shots[index - 1].tick!).toBe(interval);
  expect(player.alive).toBe(true);
  expect(messages.filter(message => message.type === 'error')).toEqual([]);
});

test.each(['medic', 'shovel'] as const)('%s keeps two separate presses and never repeats an action for coalesced held inputs', weapon => {
  const { game, player, send, events } = join(undefined, 'medic');
  const target = join(game);
  player.position = { x: 100.5, y: 45, z: 100.5 };
  target.player.position = { x: 100.5, y: 45, z: 99.5 };
  target.player.health = weapon === 'medic' ? 40 : 100;
  const pressed = { weapon, fire: true, pitch: weapon === 'shovel' ? -.7 : 0 };
  send({ weapon }); game.step();
  send(pressed, pressed, pressed, { weapon }, pressed, pressed, pressed, { weapon });
  for (let tick = 0; tick < 6; tick++) game.step();
  expect(target.player.health).toBe(60);
  expect(events(weapon === 'medic' ? 'heal' : 'impact')).toHaveLength(2);
});

test('held shovel building creates only one block per preserved right-button press', () => {
  const { game, player, send, events } = join();
  player.position = { x: 100.5, y: 40, z: 100.5 };
  game.world.set(100, 42, 97, packBlock(120, 120, 120));
  send({ weapon: 'shovel' }); game.step();
  send({ alt: true }, { alt: true }, { alt: true }, {}, { alt: true }, { alt: true }, { alt: true }, {});
  for (let tick = 0; tick < 6; tick++) game.step();
  expect(events('build')).toHaveLength(2);
  expect(game.world.get(100, 42, 98)).toBe(packBlock(85, 85, 85));
  expect(game.world.get(100, 42, 99)).toBe(packBlock(85, 85, 85));
  expect(game.world.get(100, 42, 100)).toBe(0);
});

test.each([false, true])('a 100 ms network spike does not leave a permanent backlog with fireHeld=%j', fire => {
  const { game, connection, player, send, messages } = join();
  const arrivals: number[] = [];
  for (let seq = 1; seq <= 1200; seq++) arrivals.push(Math.max(arrivals.at(-1) ?? 0, seq * 1000 / 60 + 25 + (seq === 180 ? 100 : 0)));
  let next = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    while (next < arrivals.length && arrivals[next] <= tick * 1000 / 60 + 1e-7) {
      send({ weapon: 'grenade', fire, yaw: Math.sin(next / 60) }); next++;
    }
    game.step();
    if ([120, 240, 600, 1200].includes(tick)) {
      expect(player.lastSeq).toBe(tick - 2);
      expect(connection.queue).toHaveLength(0);
    }
  }
  expect(game.droppedInputs).toBe(0);
  expect(messages.filter(message => message.type === 'error')).toEqual([]);
});
