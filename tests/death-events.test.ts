import { expect, test } from 'bun:test';
import { GameServer, type Connection, type Peer } from '../src/shared/game';
import { DT, PROTOCOL_VERSION, WEAPONS, type GameEvent, type InputFrame, type Kit, type ServerMessage } from '../src/shared/protocol';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/shared/movement';
import { createServerMessageDecoder } from '../src/shared/wire';

class TestPeer implements Peer {
  messages: ServerMessage[] = [];
  private readonly decode = createServerMessageDecoder();
  send(data: string | Uint8Array): number { this.messages.push(this.decode(data)); return 1; }
  close(): void {}
  bufferedAmount(): number { return 0; }
  events(kind: GameEvent['event']): GameEvent[] {
    return this.messages.filter(message => message.type === 'event' && message.event === kind) as GameEvent[];
  }
}

function join(game: GameServer, kit: Kit = 'assault') {
  const peer = new TestPeer();
  const connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Player' }));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit }));
  return { peer, connection, player: connection.player! };
}

function input(game: GameServer, connection: Connection, values: Partial<InputFrame> = {}): void {
  game.receive(connection, JSON.stringify({ type: 'input', frames: [{ seq: connection.highestSeq + 1,
    roundId: game.roundId, moveX: 0, moveZ: 0, yaw: connection.player!.yaw, pitch: connection.player!.pitch,
    jump: false, sprint: false, fire: false, alt: false, weapon: connection.player!.weapon, ...values }] }));
}

function shootAtTarget(kit: Kit, health: number) {
  const game = new GameServer({ mode: 'ffa' });
  const shooter = join(game, kit);
  const victim = join(game);
  for (let tick = 0; tick < 40; tick++) { input(game, shooter.connection, { alt: true, yaw: .7, pitch: .12 }); game.step(); }
  shooter.player.position = { x: 100.5, y: 80, z: 100.5 };
  shooter.player.velocity = { x: 0, y: 0, z: 0 };
  const direction = { x: -Math.sin(.7) * Math.cos(.12), y: Math.sin(.12), z: -Math.cos(.7) * Math.cos(.12) };
  victim.player.position = { x: 100.5 + direction.x * 18,
    y: 80.8 + direction.y * 18, z: 100.5 + direction.z * 18 };
  victim.player.velocity = { x: 0, y: 0, z: 0 };
  victim.player.health = health;
  input(game, victim.connection, { alt: true, yaw: -.4, pitch: -.2 });
  input(game, shooter.connection, { fire: true, alt: true, yaw: .7, pitch: .12 });
  game.step();
  const shot = shooter.peer.events('shot')[0];
  expect(shot).toBeDefined();
  expect(shooter.peer.events('impact')[0]?.tick).toBe(shot.tick);
  expect(game.projectiles.size).toBe(0);
  return { game, shooter, victim, shot, direction };
}

test.each(['assault', 'sniper'] as const)('%s immediate death carries the reviewed fourfold impulse, ray contact and victim pose', kit => {
  const { game, shooter, victim, shot, direction } = shootAtTarget(kit, 1);
  const event = shooter.peer.events('death')[0];
  const impact = shooter.peer.events('impact')[0];
  expect(event?.death).toBeDefined();
  expect(event.targetId).toBe(victim.player.id);
  expect(event.weapon).toBe(shot.weapon);
  expect(event.position).toEqual(victim.player.position);
  expect(event.death!.hitPoint).toEqual(impact.position);
  expect(event.death!.hitPoint).toEqual(shot.endPosition!);
  expect(event.tick).toBe(shot.tick);
  expect(Math.abs(event.death!.hitPoint.z - victim.player.position.z)).toBeCloseTo(PLAYER_RADIUS);
  expect(event.death!.hitPoint.y - victim.player.position.y).toBeGreaterThan(1);
  expect(event.headshot).toBe(false);
  const strength = kit === 'sniper' ? 80 : 48;
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(event.death!.impulse[axis]).toBeCloseTo(direction[axis] * strength, 9);
  }
  expect(event.death!.impulse.x).toBeLessThan(0);
  expect(victim.player.position.x - shooter.player.position.x).toBeLessThan(0);
  expect(event.death!.player).toEqual({ ...victim.player, aiming: true });
  expect(event.death!.player.deaths).toBe(1);
  expect(victim.player.aiming).toBe(false);
  expect(shooter.player.kills).toBe(1);

  const corpse = structuredClone(event.death);
  shooter.player.position = { x: 80.5, y: 50, z: 80.5 };
  shooter.player.yaw = -2;
  shooter.player.pitch = -.5;
  game.receive(victim.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'sniper' }));
  expect(victim.player.alive).toBe(true);
  victim.player.velocity.x = 100;
  victim.player.position.z += 20;
  expect(event.death).toEqual(corpse);
  expect(shooter.peer.events('death')).toHaveLength(1);
});

test.each(['assault', 'sniper'] as const)('%s nonfatal impact keeps its damage and emits no corpse state', kit => {
  const { shooter, victim, shot } = shootAtTarget(kit, 100);
  expect(victim.player.alive).toBe(true);
  expect(victim.player.health).toBe(100 - WEAPONS[shot.weapon!].damage);
  expect(victim.player.deaths).toBe(0);
  expect(shooter.peer.events('death')).toHaveLength(0);
  expect(shooter.peer.events('impact')).toHaveLength(1);
  expect(shooter.peer.events('impact')[0].death).toBeUndefined();
});

test('shovel death uses the melee contact point and an impulse of eight along the server aim', () => {
  const game = new GameServer();
  const shooter = join(game);
  const victim = join(game);
  shooter.player.position = { x: 100.5, y: 50, z: 100.5 };
  victim.player.position = { x: 100.5, y: 50.7, z: 99 };
  victim.player.health = 1;
  input(game, shooter.connection, { weapon: 'shovel', fire: true, yaw: 0, pitch: 0 });
  game.step();
  const event = shooter.peer.events('death')[0];
  expect(event?.death).toBeDefined();
  expect(event.weapon).toBe('shovel');
  expect(event.death!.hitPoint).toEqual(shooter.peer.events('impact')[0].position);
  expect(event.death!.impulse).toEqual({ x: 0, y: 0, z: -8 });
});

test('grenade deaths carry bounded radial torso impulses and velocity before gameplay knockback', () => {
  const game = new GameServer();
  const shooter = join(game);
  const victims = [join(game), join(game), join(game)];
  const survivor = join(game);
  shooter.player.position = { x: 120.5, y: 50, z: 120.5 };
  input(game, shooter.connection, { weapon: 'grenade', fire: true }); game.step();
  input(game, shooter.connection, { weapon: 'grenade', fire: false }); game.step();
  const grenade = [...game.projectiles.values()][0];
  expect(grenade?.weapon).toBe('grenade');
  grenade.position = { x: 100.5, y: 50, z: 100.5 };
  grenade.velocity = { x: 0, y: 0, z: 0 };
  grenade.expires = game.tick + 1;
  for (const [index, victim] of [...victims, survivor].entries()) {
    victim.player.position = { x: 100.5 + [0, 3, 8, 5][index], y: 50, z: 100.5 };
    victim.player.velocity = { x: 0, y: 28 * DT, z: 0 };
    victim.player.grounded = false;
    victim.player.health = index < 3 ? 1 : 100;
  }
  game.step();
  const deaths = shooter.peer.events('death');
  expect(deaths).toHaveLength(3);
  for (const [index, event] of deaths.entries()) {
    const death = event.death!;
    expect(event.weapon).toBe('grenade');
    expect(death.hitPoint).toEqual({ x: event.position.x, y: event.position.y + PLAYER_HEIGHT * .65, z: event.position.z });
    expect(Math.hypot(death.impulse.x, death.impulse.y, death.impulse.z)).toBeCloseTo([20, 14, 4][index]);
    expect(death.impulse.y).toBeGreaterThan(0);
    expect(death.impulse.z).toBe(0);
    expect(death.player.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(victims[index].player.velocity.y).toBe(4);
  }
  expect(survivor.player.alive).toBe(true);
  expect(survivor.player.health).toBe(50);
  expect(survivor.player.velocity).toEqual({ x: 6, y: 4, z: 0 });
});

test('environmental death retains its pose with a zero impulse and no weapon cause', () => {
  const game = new GameServer();
  const { player, connection, peer } = join(game);
  player.position = { x: 100.5, y: -20, z: 100.5 };
  input(game, connection, { alt: true }); game.step();
  const event = peer.events('death')[0];
  expect(event?.death).toBeDefined();
  expect(event.weapon).toBeUndefined();
  expect(event.death!.impulse).toEqual({ x: 0, y: 0, z: 0 });
  expect(event.death!.hitPoint).toEqual(event.position);
  expect(event.death!.player.aiming).toBe(true);
  expect(event.death!.player.deaths).toBe(1);
  game.step();
  expect(peer.events('death')).toHaveLength(1);
});
