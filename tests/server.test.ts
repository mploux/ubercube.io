import { afterEach, describe, expect, test } from 'bun:test';
import { GameServer } from '../src/server/game.ts';
import type { Connection, Peer } from '../src/server/game.ts';
import { readConfig, startServer } from '../src/server/index.ts';
import { PROTOCOL_VERSION } from '../src/shared/protocol.ts';
import type { InputFrame, Kit, ServerMessage } from '../src/shared/protocol.ts';
import { packBlock, VoxelWorld } from '../src/shared/voxel.ts';
import { decodeServerMessage } from '../src/shared/wire.ts';

class TestPeer implements Peer {
  messages: ServerMessage[] = [];
  closed = false;
  buffered = 0;
  send(data: string | Uint8Array): number { this.messages.push(decodeServerMessage(data)); return typeof data === 'string' ? data.length : data.byteLength; }
  close(): void { this.closed = true; }
  bufferedAmount(): number { return this.buffered; }
}

function join(game: GameServer, name = 'Player', kit: Kit | null = 'assault') {
  const peer = new TestPeer();
  const connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name }));
  if (kit) game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit }));
  return { peer, connection, player: connection.player! };
}

function frame(game: GameServer, connection: Connection, values: Partial<InputFrame> = {}): InputFrame {
  return { seq: connection.highestSeq + 1, roundId: game.roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
    jump: false, sprint: false, fire: false, alt: false, weapon: connection.player!.weapon, ...values };
}
function input(game: GameServer, connection: Connection, values: Partial<InputFrame> = {}): void {
  game.receive(connection, JSON.stringify({ type: 'input', frames: [frame(game, connection, values)] }));
}

describe('authoritative simulation', () => {
  test('admits 100 immediately, balances TDM atomically, refuses 101 and releases a disconnected slot', () => {
    const game = new GameServer();
    const clients = Array.from({ length: 100 }, (_, i) => join(game, `Player${i}`, null));
    expect(game.players.size).toBe(100);
    expect([...game.players.values()].filter(player => player.team === 1)).toHaveLength(50);
    expect([...game.players.values()].filter(player => player.team === 2)).toHaveLength(50);
    expect(clients[0].player.team).toBe(2);
    const refused = join(game, 'Overflow', null);
    expect(refused.peer.closed).toBe(true);
    expect(refused.peer.messages.some(message => message.type === 'error' && message.message === 'Serveur complet.' && message.fatal)).toBe(true);
    game.disconnect(clients[0].connection);
    expect(join(game, 'Replacement', null).player.team).toBe(2);
    expect(game.players.size).toBe(100);
  });

  test('FFA has no teams and one player can spawn without waiting', () => {
    const game = new GameServer({ mode: 'ffa' });
    const { player } = join(game);
    expect(player.team).toBe(0);
    expect(player.alive).toBe(true);
    expect(player.position.y).toBeGreaterThanOrEqual(game.world.surfaceY(Math.floor(player.position.x), Math.floor(player.position.z)));
  });

  test.each(['assault', 'sniper', 'medic'] as const)('%s spawns with the correct weapon and magazine in the first snapshot', selectedKit => {
    const game = new GameServer();
    const { player, peer } = join(game, selectedKit, selectedKit);
    const expected = selectedKit === 'assault' ? ['ak47', 30] as const : selectedKit === 'sniper' ? ['awp', 5] as const : ['medic', 0] as const;
    expect(player.weapon).toBe(expected[0]);
    expect(player.ammo).toBe(expected[1]);
    const state = peer.messages.filter(message => message.type === 'snapshot').at(-1)?.players.find(state => state.id === player.id);
    expect(state?.kit).toBe(selectedKit);
    expect(state?.weapon).toBe(expected[0]);
    expect(state?.ammo).toBe(expected[1]);
  });

  test('a batch advances at most one simulation step and only acknowledges a consumed frame', () => {
    const game = new GameServer();
    const { connection, player } = join(game);
    player.position = { x: 100.5, y: 45, z: 100.5 };
    const start = { ...player.position };
    const frames = Array.from({ length: 8 }, (_, index) => frame(game, connection, { seq: index + 1, moveZ: 1, sprint: true }));
    game.receive(connection, JSON.stringify({ type: 'input', frames }));
    expect(player.position).toEqual(start);
    expect(player.lastSeq).toBe(0);
    game.step();
    expect(player.lastSeq).toBe(1);
    expect(connection.queue).toHaveLength(7);
    expect(start.z - player.position.z).toBeLessThanOrEqual(9 / 60);
  });

  test('remote aiming reflects validated weapon state and clears on cancellation, timeout, death and reset', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game);
    expect(player.aiming).toBe(false);
    input(game, connection, { alt: true }); game.step();
    expect(player.aiming).toBe(true);
    game.sendSnapshot(connection);
    const snapshot = peer.messages.filter(message => message.type === 'snapshot').at(-1)!;
    expect(snapshot.players.find(state => state.id === player.id)?.aiming).toBe(true);
    input(game, connection, { alt: true, cancelActions: true }); game.step();
    expect(player.aiming).toBe(false);
    input(game, connection, { alt: true }); game.step();
    for (let tick = 0; tick < 16; tick++) game.step();
    expect(player.aiming).toBe(false);
    input(game, connection, { weapon: 'grenade', alt: true }); game.step();
    expect(player.aiming).toBe(false);
    input(game, connection, { weapon: 'ak47', alt: true }); game.step();
    expect(player.aiming).toBe(true);
    player.position.y = -20;
    game.step();
    expect(player.alive).toBe(false);
    expect(player.aiming).toBe(false);
    game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'sniper' }));
    expect(player.aiming).toBe(false);
    input(game, connection, { weapon: 'awp', alt: true }); game.step();
    expect(player.aiming).toBe(true);
    game.resetRound();
    expect(player.aiming).toBe(false);
  });

  test('rejects forged state, nonfinite inputs, repeated sequence, disallowed kit weapons and excessive queues', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game);
    const position = { ...player.position };
    game.receive(connection, JSON.stringify({ type: 'input', frames: [{ ...frame(game, connection), position: { x: 999, y: 999, z: 999 } }] }));
    game.receive(connection, JSON.stringify({ type: 'input', frames: [{ ...frame(game, connection), yaw: null }] }));
    input(game, connection, { weapon: 'medic' });
    expect(connection.queue).toHaveLength(0);
    expect(player.position).toEqual(position);
    input(game, connection);
    input(game, connection, { seq: 1 });
    expect(connection.queue).toHaveLength(1);
    const frames = Array.from({ length: 8 }, (_, index) => frame(game, connection, { seq: index + 2 }));
    game.receive(connection, JSON.stringify({ type: 'input', frames }));
    game.receive(connection, JSON.stringify({ type: 'input', frames: frames.map(value => ({ ...value, seq: value.seq + 8 })) }));
    expect(connection.queue.length).toBeLessThanOrEqual(12);
    expect(game.droppedInputs).toBe(8);
    expect(peer.messages.filter(message => message.type === 'error').length).toBeGreaterThanOrEqual(4);
    const forged = join(game, 'Forged', null);
    game.receive(forged.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: '__proto__' }));
    expect(forged.player.alive).toBe(false);
  });

  test('old-round commands cannot spawn or act after reset', () => {
    const game = new GameServer();
    const { connection, player } = join(game);
    const oldFrame = frame(game, connection, { fire: true, moveZ: 1 });
    game.receive(connection, JSON.stringify({ type: 'input', frames: [oldFrame] }));
    game.resetRound();
    game.receive(connection, JSON.stringify({ type: 'spawn', roundId: oldFrame.roundId, kit: 'assault' }));
    game.receive(connection, JSON.stringify({ type: 'input', frames: [oldFrame] }));
    game.step();
    expect(player.alive).toBe(false);
    expect(connection.queue).toHaveLength(0);
    expect(player.lastSeq).toBe(0);
    expect(game.projectiles.size).toBe(0);
  });

  test('headshot and repeated shots count one death, with legacy TDM friendly fire scoring', () => {
    const game = new GameServer();
    const shooter = join(game, 'Shooter');
    const victim = join(game, 'Victim');
    for (let tick = 0; tick < 20; tick++) { input(game, shooter.connection, { alt: true }); game.step(); }
    shooter.player.position = { x: 100.5, y: 40, z: 100.5 };
    victim.player.position = { x: 100.5, y: 40, z: 96.5 };
    shooter.player.velocity = { x: 0, y: 0, z: 0 }; victim.player.velocity = { x: 0, y: 0, z: 0 };
    victim.player.team = shooter.player.team;
    input(game, shooter.connection, { fire: true, alt: true });
    game.step();
    expect(victim.player.health).toBe(0);
    expect(victim.player.deaths).toBe(1);
    expect(shooter.player.kills).toBe(1);
    for (let tick = 0; tick < 12; tick++) { input(game, shooter.connection, { fire: true, alt: true }); game.step(); }
    expect(victim.player.deaths).toBe(1);
    expect(shooter.player.kills).toBe(1);
    expect(game.scores[0] + game.scores[1]).toBe(1);
  });

  test('cadence and magazine rollover remain server-controlled and input timeout stops firing', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game);
    player.position = { x: 120, y: 40, z: 120 };
    for (let tick = 0; tick < 241; tick++) { input(game, connection, { fire: true, pitch: 1.5 }); game.step(); }
    const shots = peer.messages.filter(message => message.type === 'event').filter(message => message.event === 'shot');
    expect(shots).toHaveLength(31);
    expect(player.ammo).toBe(30);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i].tick! - shots[i - 1].tick!).toBe(8);
    }
    expect(player.ammo).toBeGreaterThanOrEqual(0);
    for (let tick = 0; tick < 30; tick++) game.step();
    const stopped = peer.messages.filter(message => message.type === 'event' && message.event === 'shot').length;
    for (let tick = 0; tick < 30; tick++) game.step();
    expect(peer.messages.filter(message => message.type === 'event' && message.event === 'shot')).toHaveLength(stopped);
  });

  test.each(['assault', 'sniper'] as const)('%s sends the full authoritative shot before an impact between snapshots', selectedKit => {
    const game = new GameServer();
    const { connection, player, peer } = join(game, 'Shooter', selectedKit);
    player.position = { x: 120.5, y: 45, z: 120.5 };
    for (let x = 119; x <= 122; x++) for (let y = 44; y <= 49; y++) game.world.set(x, y, 118, packBlock(80, 120, 60));
    input(game, connection, { fire: true, alt: true });
    game.step();
    const events = peer.messages.filter(message => message.type === 'event');
    const shot = events.find(event => event.event === 'shot')!;
    const impact = events.find(event => event.event === 'impact')!;
    expect(shot).toBeDefined();
    expect(impact).toBeDefined();
    expect(events.indexOf(shot)).toBeLessThan(events.indexOf(impact));
    expect(shot.projectileId).toBe(impact.projectileId);
    expect(shot.tick).toBe(impact.tick);
    expect(shot.inputSeq).toBe(1);
    expect(shot.shooterId).toBe(player.id);
    expect(shot.position.z).toBeGreaterThanOrEqual(119); // The AWP muzzle would otherwise start behind this wall.
    expect(shot.roundId).toBe(game.roundId);
    expect(Math.hypot(shot.velocity!.x, shot.velocity!.y, shot.velocity!.z)).toBeCloseTo(selectedKit === 'assault' ? 300 : 600, 6);
    expect(game.projectiles.size).toBe(0);
    expect(peer.messages.filter(message => message.type === 'snapshot').at(-1)?.projectiles).toHaveLength(0);
  });

  test.each(['assault', 'sniper'] as const)('%s cannot skip a player between the eye and an overlapping barrel', selectedKit => {
    const game = new GameServer();
    const shooter = join(game, 'Shooter', selectedKit);
    const victim = join(game, 'Close target');
    for (let tick = 0; tick < 80; tick++) { input(game, shooter.connection, { alt: true }); game.step(); }
    shooter.player.position = { x: 100.5, y: 40, z: 100.5 };
    victim.player.position = { x: 100.5, y: 40, z: 99.8 };
    shooter.player.velocity = { x: 0, y: 0, z: 0 }; victim.player.velocity = { x: 0, y: 0, z: 0 };
    input(game, shooter.connection, { fire: true, alt: true }); game.step();
    const impact = shooter.peer.messages.find(message => message.type === 'event' && message.event === 'impact');
    expect(impact?.type === 'event' && impact.targetId).toBe(victim.player.id);
    expect(victim.player.health).toBeLessThan(100);
  });

  test('expiry identifies the authoritative projectile without an impact or duplicate termination', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game);
    player.position = { x: 120.5, y: 55, z: 120.5 };
    input(game, connection, { fire: true, pitch: 1.4 }); game.step();
    const projectile = [...game.projectiles.values()][0];
    expect(projectile).toBeDefined();
    projectile.expires = game.tick + 1;
    const origin = { ...projectile.position };
    input(game, connection, { fire: false }); game.step(); game.step();
    const ends = peer.messages.filter(message => message.type === 'event').filter(message => message.event === 'projectile-end');
    expect(ends).toHaveLength(1);
    expect(ends[0].projectileId).toBe(projectile.id);
    expect(ends[0].tick).toBe(projectile.expires);
    expect(ends[0].position).toEqual(origin);
  });

  test('cancelActions clears a charged grenade without treating pause as a release and rejects non-booleans', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game);
    input(game, connection, { weapon: 'grenade', fire: true }); game.step();
    input(game, connection, { weapon: 'grenade', fire: false, cancelActions: true }); game.step();
    input(game, connection, { weapon: 'grenade', fire: false }); game.step();
    expect(player.grenades).toBe(10);
    expect(game.projectiles.size).toBe(0);
    expect(peer.messages.some(message => message.type === 'event' && message.event === 'shot')).toBe(false);
    game.receive(connection, JSON.stringify({ type: 'input', frames: [{ ...frame(game, connection), cancelActions: 'true' }] }));
    expect(connection.queue).toHaveLength(0);
    expect(peer.messages.at(-1)?.type).toBe('error');
  });

  test('switching to a grenade on the release of another weapon does not throw it', () => {
    const game = new GameServer();
    const { connection, player } = join(game);
    input(game, connection, { fire: true }); game.step();
    input(game, connection, { weapon: 'grenade', fire: false }); game.step();
    expect(player.grenades).toBe(10);
    expect([...game.projectiles.values()].some(projectile => projectile.weapon === 'grenade')).toBe(false);
  });

  test('AWP fires every 62 selected ticks and rolls from zero back to five without manual reload', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game, 'Sniper', 'sniper');
    for (let tick = 0; tick < 311; tick++) { input(game, connection, { fire: true, alt: true, pitch: 1.4 }); game.step(); }
    const shots = peer.messages.filter(message => message.type === 'event').filter(event => event.event === 'shot');
    expect(shots).toHaveLength(6);
    expect(player.ammo).toBe(5);
    for (let i = 1; i < shots.length; i++) expect(shots[i].tick! - shots[i - 1].tick!).toBe(62);
    game.receive(connection, JSON.stringify({ type: 'reload' }));
    expect(peer.messages.at(-1)?.type).toBe('error');
    expect(player.ammo).toBe(5);
  });

  test('switching weapons preserves each gun cadence and never turns an already-held button into melee', () => {
    const game = new GameServer();
    const { connection, player, peer } = join(game);
    const other = join(game, 'Target');
    player.position = { x: 100.5, y: 50, z: 100.5 };
    input(game, connection, { fire: true, pitch: 1.4 }); game.step();
    other.player.position = { x: 100.5, y: 50, z: 99.5 };
    for (let i = 0; i < 2; i++) { input(game, connection, { weapon: 'shovel', fire: true, pitch: 0 }); game.step(); }
    expect(other.player.health).toBe(100);
    for (let i = 0; i < 7; i++) { input(game, connection, { weapon: 'ak47', fire: true, pitch: 1.4 }); game.step(); }
    expect(player.ammo).toBe(29);
    input(game, connection, { fire: true, pitch: 1.4 }); game.step();
    expect(player.ammo).toBe(28);
    const shots = peer.messages.filter(message => message.type === 'event').filter(event => event.event === 'shot');
    expect(shots).toHaveLength(2);
    expect(shots[1].tick! - shots[0].tick!).toBe(10);
  });

  test('medic and shovel act once per press with Java amounts and no invented shared cooldown', () => {
    const game = new GameServer();
    const healer = join(game, 'Healer', 'medic');
    const other = join(game, 'Target');
    healer.player.position = { x: 100.5, y: 45, z: 100.5 };
    other.player.position = { x: 100.5, y: 45, z: 99.5 };
    other.player.health = 40;
    for (let press = 0; press < 3; press++) {
      input(game, healer.connection, { fire: true }); game.step();
      input(game, healer.connection, { fire: false }); game.step();
    }
    expect(other.player.health).toBe(70);
    // Aim at the torso, below the original centre + .813 head threshold.
    input(game, healer.connection, { weapon: 'shovel', fire: true, pitch: -.7 }); game.step();
    expect(other.player.health).toBe(50);
    input(game, healer.connection, { weapon: 'shovel', fire: true, pitch: -.7 }); game.step();
    expect(other.player.health).toBe(50);
    input(game, healer.connection, { weapon: 'shovel', fire: false, pitch: -.7 }); game.step();
    input(game, healer.connection, { weapon: 'shovel', fire: true, pitch: -.7 }); game.step();
    expect(other.player.health).toBe(30);
  });

  test('grenade charge and sixty ticks of free flight match Java force, ten-step drag and accumulated gravity', () => {
    const game = new GameServer({ world: { seed: 12345, size: 256, height: 128 } });
    const { connection, player, peer } = join(game);
    player.position = { x: 128.5, y: 100, z: 160.5 };
    for (let i = 0; i < 10; i++) { input(game, connection, { weapon: 'grenade', fire: true }); game.step(); }
    input(game, connection, { weapon: 'grenade', fire: false }); game.step();
    const shot = peer.messages.filter(message => message.type === 'event').find(event => event.event === 'shot')!;
    expect(Math.hypot(shot.velocity!.x, shot.velocity!.y, shot.velocity!.z)).toBeCloseTo(2.7 * (1 - .9 ** 10) * .9 * 60, 6);
    const expected = { ...shot.position };
    const velocity = { x: shot.velocity!.x / 60, y: shot.velocity!.y / 60, z: shot.velocity!.z / 60 };
    let gravity = 0;
    for (let i = 0; i < 600; i++) {
      gravity += 2.5 / 10;
      velocity.y -= gravity / 60 / 60 / 10;
      expected.x += velocity.x / 10; expected.y += velocity.y / 10; expected.z += velocity.z / 10;
      velocity.x *= .906 + .09; velocity.y *= .906 + .09; velocity.z *= .906 + .09;
    }
    for (let i = 0; i < 59; i++) game.step();
    const grenade = game.projectiles.get(shot.projectileId!)!;
    expect(grenade).toBeDefined();
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(grenade.position[axis]).toBeCloseTo(expected[axis], 6);
      expect(grenade.velocity[axis]).toBeCloseTo(velocity[axis] * 60, 6);
    }
    expect(player.grenades).toBe(9);
  });

  test('terrain is authoritative, arrives completely before spawn, and catches edits made during the initial transfer', () => {
    const game = new GameServer();
    for (let x = 0; x < 20; x++) for (let z = 0; z < 30; z++) game.world.set(x, 50, z, packBlock(70, 70, 70));
    const builder = join(game, 'Builder', null);
    while (builder.connection.initial) game.step();
    game.receive(builder.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    builder.player.position = { x: 60.5, y: 40, z: 60.5 };
    game.world.set(60, 42, 57, packBlock(90, 90, 90));
    const arrival = join(game, 'Arrival', null);
    expect(arrival.connection.initial).not.toBeNull();
    game.receive(arrival.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    expect(arrival.player.alive).toBe(false);
    input(game, builder.connection, { weapon: 'shovel', fire: true });
    game.step();
    while (arrival.connection.initial) game.step();
    const replica = new VoxelWorld(game.options.world);
    const messages = arrival.peer.messages.filter(message => message.type === 'world');
    for (const message of messages) replica.applyEdits(message.edits);
    expect(replica.get(60, 42, 57)).toBe(game.world.get(60, 42, 57));
    expect(messages.at(-1)?.complete).toBe(true);
    expect(messages.at(-1)?.revision).toBe(game.revision);
    game.receive(arrival.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    expect(arrival.player.alive).toBe(true);
    game.resetRound();
    expect(game.world.get(60, 42, 57)).toBe(0);
    expect(game.world.getEdits()).toHaveLength(0);
    expect(game.revision).toBe(0);
  });

  test('grenade stock changes on release only, and expired grenades damage the current terrain', () => {
    const game = new GameServer();
    const { connection, player } = join(game);
    player.position = { x: 100.5, y: 40, z: 100.5 };
    input(game, connection, { weapon: 'grenade', fire: true }); game.step();
    expect(player.grenades).toBe(10);
    input(game, connection, { weapon: 'grenade', fire: false }); game.step();
    expect(player.grenades).toBe(9);
    expect(game.projectiles.size).toBe(1);
    const grenade = [...game.projectiles.values()][0];
    grenade.position = { x: 100.5, y: 40.5, z: 90.5 };
    grenade.velocity = { x: 0, y: 0, z: 0 };
    grenade.expires = game.tick + 1;
    game.world.set(100, 40, 90, packBlock(85, 85, 85));
    game.step();
    expect(game.projectiles.size).toBe(0);
    expect(game.world.get(100, 40, 90)).toBe(0);
    expect(game.revision).toBeGreaterThan(0);
  });

  test('build uses the server ray and blocks placement inside a player, while digging damages the targeted block', () => {
    const game = new GameServer();
    const { connection, player } = join(game);
    player.position = { x: 100.5, y: 40, z: 100.5 };
    game.world.set(100, 42, 97, packBlock(120, 120, 120));
    input(game, connection, { weapon: 'shovel', alt: true }); game.step();
    expect(game.world.get(100, 42, 98)).toBe(packBlock(85, 85, 85));
    const before = game.world.get(100, 42, 98);
    input(game, connection, { weapon: 'shovel', alt: false }); game.step();
    for (let i = 0; i < 15; i++) game.step();
    player.position = { x: 100.5, y: 40, z: 100.5 };
    player.velocity = { x: 0, y: 0, z: 0 };
    input(game, connection, { weapon: 'shovel', fire: true }); game.step();
    expect(game.world.get(100, 42, 98)).not.toBe(before);

    input(game, connection, { weapon: 'shovel' }); game.step();
    for (let i = 0; i < 15; i++) game.step();
    player.position = { x: 100.5, y: 40, z: 100.5 };
    player.velocity = { x: 0, y: 0, z: 0 };
    game.world.set(100, 42, 99, packBlock(85, 85, 85));
    input(game, connection, { weapon: 'shovel', alt: true }); game.step();
    expect(game.world.get(100, 42, 100)).toBe(0);
  });

  test('an explicit round duration resets the world, whereas the default does not invent a time limit', () => {
    const timed = new GameServer({ roundSeconds: 1 });
    const { player } = join(timed);
    timed.world.set(40, 40, 40, packBlock(10, 20, 30));
    for (let i = 0; i < 60; i++) timed.step();
    expect(timed.roundId).toBe(2);
    expect(timed.world.get(40, 40, 40)).toBe(0);
    expect(player.alive).toBe(false);
    const untimed = new GameServer();
    for (let i = 0; i < 120; i++) untimed.step();
    expect(untimed.roundId).toBe(1);
  });

  test('medic can heal another team but cannot heal through a solid voxel', () => {
    const game = new GameServer();
    const medic = join(game, 'Medic', 'medic');
    const other = join(game, 'Other');
    medic.player.position = { x: 100.5, y: 40, z: 100.5 };
    other.player.position = { x: 100.5, y: 40, z: 97.5 };
    other.player.health = 50;
    input(game, medic.connection, { weapon: 'medic', fire: true }); game.step();
    expect(other.player.health).toBe(60);
    input(game, medic.connection, { weapon: 'medic', fire: false }); game.step();
    for (let i = 0; i < 15; i++) game.step();
    game.world.set(100, Math.floor(medic.player.position.y + 2.4), 99, packBlock(85, 85, 85));
    input(game, medic.connection, { weapon: 'medic', fire: true }); game.step();
    expect(other.player.health).toBe(60);
  });

  test('closes a saturated connection without delaying other players', () => {
    const game = new GameServer();
    const slow = join(game, 'Slow');
    const other = join(game, 'Other');
    slow.peer.buffered = 600_000;
    input(game, other.connection, { moveZ: 1 });
    game.step();
    expect(slow.peer.closed).toBe(true);
    expect(game.players.size).toBe(1);
    expect(other.player.lastSeq).toBe(1);
  });
});

describe('Bun transport and configuration', () => {
  const running: ReturnType<typeof startServer>[] = [];
  afterEach(() => { for (const instance of running.splice(0)) instance.stop(); });

  test('mode and bounded configuration come from args/env, default rounds stay open', () => {
    expect(readConfig([], {}).roundSeconds).toBe(0);
    expect(readConfig(['--mode=ffa'], { MODE: 'tdm' }).mode).toBe('ffa');
    expect(() => readConfig([], { MAX_PLAYERS: '-1' })).toThrow();
    expect(() => readConfig([], { MODE: 'other' })).toThrow();
    expect(() => new GameServer({ world: { size: 65, height: 64, seed: 1 } })).toThrow();
    expect(() => new GameServer({ roundSeconds: NaN })).toThrow();
  });

  test('public status creates no player and websocket binds a server-assigned identity', async () => {
    const instance = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false, mode: 'ffa' });
    running.push(instance);
    const base = `http://127.0.0.1:${instance.server.port}`;
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status.players).toBe(0);
    expect(status.mode).toBe('ffa');
    expect(status.tickWork.samples).toBe(0);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`);
      socket.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket test timed out')); }, 2000);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Browser' }));
      socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket error')); };
      socket.onmessage = event => {
        const message = decodeServerMessage(event.data);
        if (message.type === 'welcome') {
          expect(message.id).toBe(1);
          expect(instance.game.players.get(message.id)?.name).toBe('Browser');
        }
        if (message.type === 'world' && message.complete) {
          for (let i = 0; i < 3; i++) instance.game.step();
        }
        if (message.type === 'snapshot' && message.tick === 3) {
          expect(message.players.map(player => player.name)).toEqual(['Browser']);
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      };
    });
  });
});
