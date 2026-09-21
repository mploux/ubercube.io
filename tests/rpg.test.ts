import { expect, test } from 'bun:test';
import { GameServer, type Connection, type Peer } from '../src/shared/game';
import { KITS, PROTOCOL_VERSION, WEAPONS, type GameEvent, type InputFrame, type Kit, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage, encodeServerMessage } from '../src/shared/wire';
import { packBlock, VoxelWorld } from '../src/shared/voxel';

class TestPeer implements Peer {
  messages: ServerMessage[] = [];
  send(data: string | Uint8Array): number { this.messages.push(decodeServerMessage(data)); return data.length; }
  close(): void {}
  bufferedAmount(): number { return 0; }
}
function join(game: GameServer, kit: Kit = 'assault') {
  const peer = new TestPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: kit }));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit }));
  return { connection, peer, player: connection.player! };
}
function send(game: GameServer, connection: Connection, values: Partial<InputFrame> = {}) {
  const frame: InputFrame = { seq: connection.highestSeq + 1, roundId: game.roundId, moveX: 0, moveZ: 0,
    yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, alt: true, weapon: 'rpg', ...values };
  game.receive(connection, JSON.stringify({ type: 'input', frames: [frame] }));
}
function setup() {
  const game = new GameServer({ world: { seed: 12345, size: 128, height: 128 } });
  const shooter = join(game);
  shooter.player.position = { x: 60.5, y: 90, z: 100.5 };
  // A small platform keeps the fixture stationary without replacing movement or collision code.
  for (let x = 58; x <= 62; x++) for (let z = 98; z <= 102; z++) game.world.set(x, 89, z, packBlock(90, 90, 90));
  for (let tick = 0; tick < 80; tick++) { send(game, shooter.connection); game.step(); }
  shooter.peer.messages.length = 0;
  return { game, ...shooter };
}
const events = (peer: TestPeer, event: GameEvent['event']) => peer.messages.filter((m): m is GameEvent => m.type === 'event' && m.event === event && m.weapon === 'rpg');

test('bazooka belongs only to assault; medic retains healing and rejects bazooka input', () => {
  expect(KITS.assault).toEqual(['ak47', 'rpg', 'grenade', 'shovel']);
  expect(KITS.medic).toEqual(['medic', 'ak47', 'grenade', 'shovel']);
  const { game, connection, player } = setup();
  const medic = join(game, 'medic'), sniper = join(game, 'sniper');
  for (const client of [medic, sniper]) {
    send(game, client.connection, { fire: true });
    expect(client.connection.queue).toHaveLength(0);
    expect(client.peer.messages.some(m => m.type === 'error')).toBe(true);
  }
  player.position = { x: 60.5, y: 90, z: 99.5 }; player.health = 70;
  medic.player.position = { x: 60.5, y: 90, z: 101.5 };
  send(game, connection, { fire: false });
  send(game, medic.connection, { weapon: 'medic', fire: true, alt: false });
  game.step();
  expect(player.health).toBe(80);
  expect(medic.player.weapon).toBe('medic');
  expect(game.projectiles.size).toBe(0);
});

test('rocket travels at 60 blocks/s without gravity, and snapshots carry its identity and ammo', () => {
  const { game, connection, player, peer } = setup();
  send(game, connection, { fire: true }); game.step();
  const shot = events(peer, 'shot')[0];
  expect(shot.endPosition).toBeUndefined();
  expect(Math.hypot(shot.velocity!.x, shot.velocity!.y, shot.velocity!.z)).toBeCloseTo(60, 8);
  expect(player.ammo).toBe(29); expect(player.grenades).toBe(10);
  const rocket = game.projectiles.get(shot.projectileId!)!;
  const initial = { ...rocket.position };
  for (let tick = 0; tick < 30; tick++) { send(game, connection); game.step(); }
  expect(rocket.position.z).toBeCloseTo(initial.z - 30, 8);
  expect(rocket.position.y).toBeCloseTo(initial.y, 8);
  const snapshots = peer.messages.filter(m => m.type === 'snapshot');
  const latest = snapshots.at(-1)!;
  const decoded = decodeServerMessage(encodeServerMessage(latest));
  expect(decoded.type).toBe('snapshot');
  if (decoded.type !== 'snapshot') throw new Error('snapshot missing');
  expect(decoded.projectiles[0].weapon).toBe('rpg');
  expect(decoded.projectiles[0].owner).toBe(player.id);
  expect(decoded.players.find(p => p.id === player.id)!.ammo).toBe(29);
});

test('a direct player hit explodes and deals 80 damage once, even at head height', () => {
  const { game, connection, peer } = setup();
  const target = join(game);
  target.player.position = { x: 60.5, y: 90, z: 93.5 };
  game.world.set(60, 89, 93, packBlock(90, 90, 90));
  send(game, connection, { fire: true }); game.step();
  expect(target.player.health).toBe(100);
  for (let tick = 0; tick < 20 && !events(peer, 'impact').length; tick++) { send(game, connection); game.step(); }
  expect(target.player.health).toBe(20);
  expect(events(peer, 'impact')).toHaveLength(1);
  expect(events(peer, 'impact')[0].targetId).toBe(target.player.id);
  expect(events(peer, 'impact')[0].headshot).not.toBe(true);
  expect(events(peer, 'explosion')).toHaveLength(1);
  expect(game.projectiles.size).toBe(0);
});

test('terrain hit explodes once, destroys blocks and damages and pushes the shooter', () => {
  const { game, connection, player, peer } = setup();
  for (let x = 58; x <= 62; x++) for (let y = 90; y <= 94; y++) game.world.set(x, y, 94, packBlock(90, 90, 90));
  const initial = game.world.get(60, 92, 94);
  send(game, connection, { fire: true }); game.step();
  expect(game.world.get(60, 92, 94)).toBe(initial);
  for (let tick = 0; tick < 20 && !events(peer, 'explosion').length; tick++) { send(game, connection); game.step(); }
  expect(events(peer, 'explosion')).toHaveLength(1);
  expect(game.world.get(60, 92, 94)).toBe(0);
  expect(game.projectiles.size).toBe(0);
  expect(player.health).toBeGreaterThan(20);
  expect(player.health).toBeLessThan(100);
  expect(player.velocity.z).toBeGreaterThan(0);
  const mutations = peer.messages.filter(m => m.type === 'world').flatMap(m => m.edits);
  expect(mutations.length).toBeGreaterThan(0);
  const late = join(game, 'medic');
  const copy = new VoxelWorld(game.world.config);
  for (const message of late.peer.messages) if (message.type === 'world') for (const [x, y, z, value] of message.edits) copy.set(x, y, z, value);
  expect(copy.get(60, 92, 94)).toBe(0);
  expect(copy.getEdits().sort()).toEqual(game.world.getEdits().sort());
});

test('RPG splash falls off over ten blocks at 80% grenade damage and leaves the grenade unchanged', () => {
  for (const weapon of ['rpg', 'grenade'] as const) {
    const { game, player, peer } = setup();
    const distances = [1.3125, 5.15625, 8.8125, 10, 11];
    const targets = distances.map(distance => {
      const target = join(game).player;
      target.position = { x: 64.5 + distance, y: 94, z: 65.001 };
      game.world.set(Math.floor(target.position.x), 93, 65, packBlock(90, 90, 90));
      return target;
    });
    const edgeBlock = packBlock(90, 90, 90);
    game.world.set(67, 96, 65, edgeBlock);
    if (weapon === 'rpg') game.world.set(64, 94, 64, edgeBlock);
    game.projectiles.set(500, { id: 500, owner: player.id, weapon,
      position: { x: 64.5, y: 94, z: weapon === 'rpg' ? 65.1 : 65.001 },
      velocity: { x: 0, y: 0, z: -60 }, damage: WEAPONS[weapon].damage,
      expires: game.tick + (weapon === 'rpg' ? 120 : 1) });
    game.step();
    expect(targets.map(target => target.health)).toEqual(weapon === 'rpg' ? [31, 62, 91, 100, 100] : [14, 52, 89, 100, 100]);
    expect(targets[1].velocity.x).toBeCloseTo(weapon === 'rpg' ? 4.65 : 5.8125, 6);
    expect(targets[1].velocity.y).toBeCloseTo(weapon === 'rpg' ? 3.2 : 4, 8);
    expect(targets[3].velocity).toEqual({ x: 0, y: 0, z: 0 });
    if (weapon === 'rpg') expect(game.world.get(67, 96, 65)).toBe(edgeBlock);
    else expect(game.world.get(67, 96, 65)).not.toBe(edgeBlock);
    expect(peer.messages.filter(message => message.type === 'event' && message.event === 'explosion' && message.weapon === weapon)).toHaveLength(1);
  }
});

test('direct impact damages nearby players and lethal splash attributes the kill to the shooter', () => {
  const { game, connection, player, peer } = setup();
  const direct = join(game).player, nearby = join(game).player;
  direct.position = { x: 60.5, y: 90, z: 93.5 };
  nearby.position = { x: 63.5, y: 90, z: 93.5 }; nearby.health = 30;
  for (const target of [direct, nearby]) game.world.set(Math.floor(target.position.x), 89, 93, packBlock(90, 90, 90));
  send(game, connection, { fire: true }); game.step();
  for (let tick = 0; tick < 20 && !events(peer, 'explosion').length; tick++) { send(game, connection); game.step(); }
  expect(direct.health).toBe(20);
  expect(nearby.alive).toBe(false);
  expect(player.kills).toBe(1);
  expect(events(peer, 'death')).toHaveLength(1);
  expect(events(peer, 'death')[0]).toMatchObject({ targetId: nearby.id, shooterId: player.id, headshot: false });
  expect(events(peer, 'death')[0].death?.impulse.x).toBeGreaterThan(0);
});

test('a 60 blocks/s rocket sweeps its full tick through a player or one-block wall', () => {
  for (const obstacle of ['player', 'wall'] as const) {
    const { game, player, peer } = setup();
    const target = join(game).player;
    target.position = { x: obstacle === 'player' ? 64.5 : 74.5, y: 94, z: 64.5 };
    game.world.set(Math.floor(target.position.x), 93, 64, packBlock(90, 90, 90));
    if (obstacle === 'wall') game.world.set(64, 95, 64, packBlock(90, 90, 90));
    game.projectiles.set(500, { id: 500, owner: player.id, weapon: 'rpg',
      position: { x: 64.5, y: 95, z: 65.1 }, velocity: { x: 0, y: 0, z: -60 }, damage: 80, expires: game.tick + 120 });
    game.step();
    expect(game.projectiles.size).toBe(0);
    expect(events(peer, 'impact')).toHaveLength(1);
    expect(events(peer, 'explosion')).toHaveLength(1);
    if (obstacle === 'player') {
      expect(events(peer, 'impact')[0].targetId).toBe(target.id);
      expect(target.health).toBe(20);
    } else expect(game.world.get(64, 95, 64)).toBe(0);
  }
});

test('a wall between eye and muzzle stops the launch instead of creating a rocket behind it', () => {
  const { game, connection, peer } = setup();
  game.world.set(60, 92, 99, packBlock(90, 90, 90));
  send(game, connection, { fire: true }); game.step();
  expect(game.projectiles.size).toBe(0);
  expect(events(peer, 'shot')).toHaveLength(1);
  expect(events(peer, 'explosion')).toHaveLength(1);
  expect(events(peer, 'shot')[0].position.z).toBeGreaterThanOrEqual(100);
});

test('the rocket blast deflects existing grenades but does not push other rockets', () => {
  const { game, connection } = setup();
  game.world.set(60, 92, 99, packBlock(90, 90, 90));
  const grenade = { id: 500, owner: connection.player!.id, weapon: 'grenade' as const,
    position: { x: 64.5, y: 94, z: 99.5 }, velocity: { x: 0, y: 0, z: 0 }, damage: 100, expires: game.tick + 120 };
  const rocket = { ...grenade, id: 501, weapon: 'rpg' as const, position: { x: 66.5, y: 94, z: 99.5 },
    velocity: { x: 0, y: 0, z: -60 } };
  game.projectiles.set(grenade.id, grenade); game.projectiles.set(rocket.id, rocket);
  send(game, connection, { fire: true }); game.step();
  expect(grenade.velocity.x).toBeGreaterThan(0);
  expect(grenade.position.x).toBeGreaterThan(64.5);
  expect(rocket.velocity).toEqual({ x: 0, y: 0, z: -60 });
  expect(rocket.position).toEqual({ x: 66.5, y: 94, z: 98.5 });
});

test('cadence and magazine renewal follow Java; switching to AK preserves both magazines', () => {
  const { game, connection, player, peer } = setup();
  for (let tick = 0; tick <= 62 * 30; tick++) { send(game, connection, { fire: true }); game.step(); }
  const shots = events(peer, 'shot');
  expect(shots).toHaveLength(31);
  expect(shots[1].tick! - shots[0].tick!).toBe(62);
  expect(player.ammo).toBe(30);
  send(game, connection, { weapon: 'ak47', fire: true }); game.step();
  expect(player.ammo).toBe(29);
  send(game, connection); game.step();
  expect(player.ammo).toBe(30);
  expect(connection.magazines.ak47).toBe(29);
});

test('map exit, death and reset never leave an old rocket able to affect the next round', () => {
  const { game, connection, player, peer } = setup();
  send(game, connection, { fire: true }); game.step();
  const rocket = [...game.projectiles.values()][0];
  rocket.position = { x: 60, y: 100, z: .1 }; rocket.velocity = { x: 0, y: 0, z: -60 };
  player.alive = false;
  game.step();
  expect(game.projectiles.size).toBe(0);
  expect(events(peer, 'projectile-end')).toHaveLength(1);
  expect(events(peer, 'explosion')).toHaveLength(0);
  const roundId = game.roundId;
  game.resetRound();
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  send(game, connection, { roundId, fire: true }); game.step();
  expect(game.projectiles.size).toBe(0);
  expect(connection.magazines.rpg).toBe(30);
});
