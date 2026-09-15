import { describe, expect, test } from 'bun:test';
import { GameServer, type Connection, type Peer } from '../src/shared/game';
import { PROTOCOL_VERSION, type InputFrame, type ServerMessage } from '../src/shared/protocol';
import { createServerMessageDecoder, serverMessageType } from '../src/shared/wire';

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
const world = { seed: 12345, size: 64, height: 32 };

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
  get snapshot() { return this.messages.filter(message => message.type === 'snapshot').at(-1) as Snapshot; }
  get packet() { return this.packets.filter(packet => serverMessageType(packet) === 'snapshot').at(-1) as Uint8Array; }
  get rosters() { return this.messages.filter(message => message.type === 'roster'); }
}

function join(game: GameServer) {
  const peer = new RecordingPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Player${game.players.size}` }));
  return { peer, connection };
}

function input(game: GameServer, connection: Connection, fields: Partial<InputFrame>) {
  game.receive(connection, JSON.stringify({ type: 'input', frames: [{ seq: connection.highestSeq + 1,
    roundId: game.roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false,
    fire: false, alt: false, weapon: connection.player!.weapon, ...fields }] }));
}

describe('scoped authoritative replication', () => {
  test('shares the public frame while keeping correction and private state specific to each recipient', () => {
    const game = new GameServer({ world }), clients = Array.from({ length: 3 }, () => join(game));
    game.sendSnapshot();
    expect(new Set(clients.map(client => client.connection.snapshot)).size).toBe(1);
    const previous = clients[0].peer.snapshot, saved = structuredClone(previous);
    Object.assign(clients[0].connection.player!, { health: 42, ammo: 7, kit: 'medic', grenades: 3, lastSeq: 123456789 });
    clients[0].connection.player!.velocity.y = 12;
    clients[0].peer.result = -1;
    game.sendSnapshot();
    expect(new Set(clients.map(client => client.connection.snapshot)).size).toBe(1);
    expect(clients[0].peer.snapshot.owner).toMatchObject({ health: 42, ammo: 7, kit: 'medic', grenades: 3, lastSeq: 123456789,
      velocity: { y: 12 } });
    expect(clients[1].peer.snapshot.owner?.id).toBe(clients[1].connection.player!.id);
    expect(clients[1].peer.snapshot.owner?.health).toBe(100);
    for (const client of clients) {
      for (const player of client.peer.snapshot.players) {
        for (const field of ['health', 'ammo', 'grenades', 'kit', 'lastSeq', 'grounded']) expect(player).not.toHaveProperty(field);
        expect(player.velocity).not.toHaveProperty('y');
        expect(player.hasGrenades).toBe(true);
      }
      expect(client.peer.snapshot.players).toEqual(clients[0].peer.snapshot.players);
    }
    expect(previous).toEqual(saved);
    clients[0].connection.player!.grenades = 0;
    game.sendSnapshot();
    expect(clients[1].peer.snapshot.players[0].hasGrenades).toBe(false);
  });

  test('repairs skipped public and owner states together without resending cached names', () => {
    const game = new GameServer({ world }), slow = join(game), healthy = join(game), leaving = join(game);
    game.sendSnapshot();
    const rosterCount = slow.peer.rosters.length, lastPacket = slow.peer.packet;
    slow.peer.buffered = 65537;
    Object.assign(slow.connection.player!, { health: 12, ammo: 0, lastSeq: 990 });
    game.sendSnapshot();
    expect(slow.peer.packet).toBe(lastPacket);
    expect(slow.connection.snapshot).toBeNull();
    expect(slow.connection.ownerSnapshot).toBeNull();
    game.disconnect(leaving.connection);
    game.sendSnapshot();
    expect(slow.peer.rosters.length).toBe(rosterCount + 1);
    expect(slow.peer.rosters.at(-1)?.upserts).toEqual([]);
    slow.peer.buffered = 0;
    game.sendSnapshot();
    expect(slow.peer.snapshot.players).toEqual(healthy.peer.snapshot.players);
    expect(slow.peer.snapshot.owner).toMatchObject({ health: 12, ammo: 0, lastSeq: 990 });
    expect(slow.peer.rosters.length).toBe(rosterCount + 1);
    expect(slow.connection.snapshot).toBe(healthy.connection.snapshot);
    expect(slow.peer.snapshot.players.map(player => player.id)).toEqual([...game.players.keys()]);
  });

  test('same-tick spawns, resets and reconnects retain the right roster and life generation', () => {
    const game = new GameServer({ world, roundSeconds: 300 }), first = join(game), second = join(game);
    game.sendSnapshot();
    const before = first.connection.snapshot;
    game.receive(first.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'sniper' }));
    expect(first.connection.snapshot?.tick).toBe(before?.tick);
    expect(first.connection.snapshot?.id).not.toBe(before?.id);
    expect(first.peer.snapshot.owner).toMatchObject({ alive: true, kit: 'sniper', ammo: 5 });
    first.connection.player!.deaths = 4;
    game.sendSnapshot();
    const oldSnapshot = second.peer.snapshot, saved = structuredClone(oldSnapshot);
    first.connection.player!.name = 'Renamed 🧊';
    first.connection.player!.team = 2;
    game.sendSnapshot();
    expect(second.peer.snapshot.players[0]).toMatchObject({ deaths: 4, name: 'Renamed 🧊', team: 2 });
    expect(first.peer.snapshot.owner).toMatchObject({ name: 'Renamed 🧊', team: 2 });
    expect(oldSnapshot).toEqual(saved);
    const rosterCount = first.peer.rosters.length;
    for (let tick = 0; tick < 6; tick++) game.step();
    expect(first.peer.snapshot.roundEndTick).toBe(18000);
    game.resetRound();
    expect(first.peer.rosters.length).toBe(rosterCount);
    expect(first.peer.snapshot.roundEndTick).toBe(18006);
    expect(first.peer.snapshot.players.every(player => !player.alive && player.deaths === 0)).toBe(true);
    expect(first.peer.snapshot.owner?.lastSeq).toBe(0);
    first.peer.result = 0;
    game.sendSnapshot();
    expect(first.connection.closed && first.peer.closed).toBe(true);
    expect(first.connection.snapshot).toBeNull();
    expect(first.connection.ownerSnapshot).toBeNull();
    expect(second.connection.closed).toBe(false);
    const replacement = join(game);
    expect(replacement.peer.snapshot.owner?.id).toBe(replacement.connection.player!.id);
    expect(replacement.peer.snapshot.players.map(player => player.id)).toEqual([...game.players.keys()]);
  });

  test('only the thrower receives projectile correction velocities and input sequence', () => {
    const game = new GameServer({ world }), owner = join(game), observer = join(game);
    game.receive(owner.connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    owner.connection.player!.position = { x: 30, y: 50, z: 30 };
    input(game, owner.connection, { weapon: 'grenade', fire: true }); game.step();
    input(game, owner.connection, { weapon: 'grenade', fire: false }); game.step();
    game.sendSnapshot();
    const projectile = [...game.projectiles.values()][0];
    expect(projectile).toBeDefined();
    expect(owner.peer.snapshot.projectileVelocities).toHaveLength(1);
    expect(owner.peer.snapshot.projectileVelocities[0].id).toBe(projectile.id);
    expect(observer.peer.snapshot.projectileVelocities).toEqual([]);
    expect(observer.peer.snapshot.projectiles).toEqual(owner.peer.snapshot.projectiles);
    expect(observer.peer.snapshot.projectiles[0]).not.toHaveProperty('velocity');
    const ownShot = owner.peer.messages.find(message => message.type === 'event' && message.event === 'shot');
    const remoteShot = observer.peer.messages.find(message => message.type === 'event' && message.event === 'shot');
    expect(ownShot).toHaveProperty('inputSeq', 2);
    expect(remoteShot).not.toHaveProperty('inputSeq');
    game.projectiles.clear(); game.sendSnapshot();
    expect(owner.peer.snapshot.projectiles).toEqual([]);
    expect(owner.peer.snapshot.projectileVelocities).toEqual([]);
  });
});
