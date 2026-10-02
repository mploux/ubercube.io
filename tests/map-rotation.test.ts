import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GameServer, type Connection, type Peer } from '../src/server/game.ts';
import { readConfig, startServer } from '../src/server/index.ts';
import { loadMap, readMapCatalog } from '../src/server/maps.ts';
import { encodeImportedMap, type ImportedMap } from '../src/shared/imported-map.ts';
import { PROTOCOL_VERSION, type MapChoice, type ServerMessage } from '../src/shared/protocol.ts';
import { packBlock } from '../src/shared/voxel.ts';
import { decodeServerMessage } from '../src/shared/wire.ts';

const maps: MapChoice[] = [1, 2, 3].map(seed => ({ id: `map-${seed}`, name: `Map ${seed}`, world: { seed, size: 64, height: 48 } }));
const directories: string[] = [];
const hosts: ReturnType<typeof startServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of hosts.splice(0)) host.stop();
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'ubercube-maps-'))) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

class TestPeer implements Peer {
  messages: ServerMessage[] = [];
  buffered = 0;
  send(data: string | Uint8Array): number { this.messages.push(decodeServerMessage(data)); return 1; }
  close(): void {}
  bufferedAmount(): number { return this.buffered; }
}
function enter(game: GameServer, name = 'Player') {
  const peer = new TestPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name }));
  return { peer, connection, player: connection.player! };
}
function spawn(game: GameServer, connection: Connection) {
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
}
function select(game: GameServer, connection: Connection, mapId: string, roundId = game.roundId) {
  game.receive(connection, JSON.stringify({ type: 'select-map', roundId, mapId }));
}
function flatMap(size = 512, height = 64): ImportedMap {
  const offsets = Uint32Array.from({ length: size * size + 1 }, (_, i) => i * 2);
  const runs = Uint32Array.from({ length: size * size * 2 }, (_, i) => i % 2 ? packBlock(90, 120, 60) : 8 << 16);
  return { size, height, offsets, runs };
}
function mapFixture(map = flatMap()) {
  const root = mkdtempSync(join(tmpdir(), 'ubercube-maps-'));
  directories.push(root);
  const bytes = encodeImportedMap(map), hash = createHash('sha256').update(bytes).digest('hex');
  const entry = { id: 'fixture', name: 'Test map', hash, source: 'test fixture', license: 'CC0-1.0' };
  writeFileSync(join(root, `${hash}.ucmap`), bytes);
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: 1, maps: [entry] }));
  return { root, bytes, entry };
}

describe('authoritative map selection and rotation', () => {
  test('first hello owns the choice, followers cannot select or race its first spawn', () => {
    const game = new GameServer({ maps });
    const waitingPeer = new TestPeer(), waitingConnection = game.connect(waitingPeer)!;
    const first = enter(game, 'First');
    game.receive(waitingConnection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Second' }));
    const second = { peer: waitingPeer, connection: waitingConnection, player: waitingConnection.player! };
    const choice = second.peer.messages.find(message => message.type === 'map-choice');
    expect(choice).toMatchObject({ chooserId: first.player.id, maps });
    expect(first.peer.messages.slice(0, 2).map(message => message.type)).toEqual(['welcome', 'map-choice']);
    select(game, second.connection, maps[1].id);
    spawn(game, second.connection);
    expect(game.options.world).toEqual(maps[0].world);
    expect(second.player.alive).toBe(false);
    select(game, first.connection, maps[1].id);
    expect(game.options.world).toEqual(maps[1].world);
    expect(game.roundId).toBe(2);
    for (const peer of [first.peer, second.peer]) {
      expect(peer.messages.filter(message => message.type === 'reset').at(-1)).toMatchObject({ roundId: 2, world: maps[1].world });
      expect(peer.messages.filter(message => message.type === 'map-choice').at(-1)).toMatchObject({ roundId: 2, chooserId: first.player.id });
    }
    spawn(game, first.connection);
    spawn(game, second.connection);
    expect(first.player.alive && second.player.alive).toBe(true);
    expect(first.peer.messages.filter(message => message.type === 'map-choice').at(-1)).toMatchObject({ chooserId: null });
    first.player.alive = false;
    select(game, first.connection, maps[2].id);
    expect(game.options.world).toEqual(maps[1].world);
  });

  test('departing chooser transfers to the oldest remaining player and empty server starts clean on the same map', () => {
    const game = new GameServer({ maps, roundSeconds: 1 });
    const first = enter(game, 'First'), second = enter(game, 'Second');
    game.disconnect(first.connection);
    expect(second.peer.messages.filter(message => message.type === 'map-choice').at(-1)).toMatchObject({ chooserId: second.player.id });
    select(game, second.connection, maps[1].id);
    spawn(game, second.connection);
    game.world.set(10, 40, 10, packBlock(1, 2, 3));
    game.scores = [4, 8];
    game.disconnect(second.connection);
    const emptyRound = game.roundId;
    expect(game.scores).toEqual([0, 0]);
    expect(game.world.get(10, 40, 10)).toBe(0);
    for (let tick = 0; tick < 120; tick++) game.step();
    expect(game.roundId).toBe(emptyRound);
    expect(game.options.world).toEqual(maps[1].world);
    const next = enter(game, 'Next session');
    expect(next.peer.messages.find(message => message.type === 'map-choice')).toMatchObject({ chooserId: next.player.id });
    select(game, next.connection, maps[2].id);
    expect(game.options.world).toEqual(maps[2].world);
  });

  test('clock starts at first spawn, cycles without immediate repetition and returns everyone to the lobby', () => {
    const game = new GameServer({ maps, roundSeconds: 1 });
    for (let tick = 0; tick < 120; tick++) game.step();
    const first = enter(game, 'First'), second = enter(game, 'Second');
    for (let tick = 0; tick < 120; tick++) game.step();
    expect(game.roundId).toBe(1);
    for (const expected of [maps[1], maps[2], maps[0]]) {
      spawn(game, first.connection);
      spawn(game, second.connection);
      first.player.kills = 4;
      second.player.deaths = 4;
      game.scores = [4, 0];
      game.world.set(10, 40, 10, packBlock(1, 2, 3));
      for (let tick = 0; tick < 60; tick++) game.step();
      expect(game.options.world).toEqual(expected.world);
      expect(first.player.alive || second.player.alive).toBe(false);
      expect(first.player.kills + second.player.deaths).toBe(0);
      expect(game.scores).toEqual([0, 0]);
      expect(game.world.get(10, 40, 10)).toBe(0);
      const snapshot = first.peer.messages.filter(message => message.type === 'snapshot').at(-1);
      expect(snapshot?.type === 'snapshot' && snapshot.players.every(player => !player.alive)).toBe(true);
      const roundId = game.roundId;
      for (let tick = 0; tick < 60; tick++) game.step();
      expect(game.roundId).toBe(roundId);
      select(game, first.connection, maps[0].id);
      expect(game.roundId).toBe(roundId);
    }
  });

  test('fifteen minutes are the default, with an explicit zero preserving unlimited play', () => {
    const game = new GameServer({ maps });
    expect(game.options.roundSeconds).toBe(900);
    const first = enter(game);
    spawn(game, first.connection);
    game.tick = 900 * 60 - 2;
    first.connection.lastMessage = game.tick;
    game.step();
    expect(game.roundId).toBe(1);
    game.step();
    expect(game.options.world).toEqual(maps[1].world);
    const untimed = new GameServer({ maps, roundSeconds: 0 }), peer = enter(untimed);
    spawn(untimed, peer.connection);
    untimed.tick = 900 * 60;
    peer.connection.lastMessage = untimed.tick;
    untimed.step();
    expect(untimed.roundId).toBe(1);
  });

  test('rejects unknown, malformed and stale choices; replacing a streamed round discards its old terrain', () => {
    const game = new GameServer({ maps });
    for (let i = 0; i < 1100; i++) game.world.set(i % 64, 40, Math.floor(i / 64), packBlock(1, 2, 3));
    const first = enter(game, 'First'), second = enter(game, 'Second');
    expect(first.connection.initial).not.toBeNull();
    select(game, first.connection, '../../bad');
    game.receive(first.connection, JSON.stringify({ type: 'select-map', roundId: game.roundId, mapId: maps[1].id, forged: true }));
    expect(game.roundId).toBe(1);
    select(game, first.connection, maps[1].id);
    select(game, first.connection, maps[2].id, 1);
    expect(game.roundId).toBe(2);
    expect(game.options.world).toEqual(maps[1].world);
    for (const peer of [first.peer, second.peer]) {
      const resetAt = peer.messages.findIndex(message => message.type === 'reset');
      expect(peer.messages.slice(resetAt + 1).filter(message => message.type === 'world'))
        .toEqual([{ type: 'world', roundId: 2, revision: 0, initial: true, complete: true, edits: [] }]);
    }
    const late = enter(game, 'Late');
    expect(late.peer.messages[0]).toMatchObject({ type: 'welcome', roundId: 2, world: maps[1].world });
    expect(late.connection.initial).toBeNull();
  });

  test('imported spawning falls back beyond a blocked team base and resets reuse immutable source data', () => {
    const imported = flatMap(64, 48);
    for (let column = 0; column < 64 * 64; column++) if (column % 64 >= 10) imported.runs[column * 2] = 48 << 16;
    const choice: MapChoice = { id: 'imported', name: 'Imported', world: { seed: 1, size: 64, height: 48, map: { id: 'imported', hash: 'a'.repeat(64) } } };
    let loads = 0;
    const game = new GameServer({ maps: [choice], loadMap: () => { loads++; return imported; } });
    const first = enter(game);
    spawn(game, first.connection);
    expect(first.player.alive).toBe(true);
    expect(first.player.position.x).toBeLessThan(10);
    game.world.set(2, 7, 2, 0);
    game.resetRound();
    expect(game.world.get(2, 7, 2)).toBe(packBlock(90, 120, 60));
    expect(loads).toBe(1);
    const blocked = flatMap(64, 48);
    for (let index = 0; index < blocked.runs.length; index += 2) blocked.runs[index] = 48 << 16;
    const blockedGame = new GameServer({ maps: [choice, maps[0]], loadMap: map => map === choice ? blocked : undefined });
    const blockedPlayer = enter(blockedGame);
    spawn(blockedGame, blockedPlayer.connection);
    expect(blockedPlayer.player.alive).toBe(false);
    select(blockedGame, blockedPlayer.connection, maps[0].id);
    expect(blockedGame.options.world).toEqual(maps[0].world);
    spawn(blockedGame, blockedPlayer.connection);
    expect(blockedPlayer.player.alive).toBe(true);
  });

  test('a failed map load preserves the current round; automatic rotation falls back to a clean current map', () => {
    const missing: MapChoice = { id: 'missing', name: 'Missing', world: { seed: 0, size: 512, height: 64, map: { id: 'missing', hash: 'a'.repeat(64) } } };
    const game = new GameServer({ maps: [maps[0], missing], roundSeconds: 1 });
    const first = enter(game);
    select(game, first.connection, missing.id);
    expect(game.roundId).toBe(1);
    expect(first.peer.messages.at(-1)).toMatchObject({ type: 'error' });
    spawn(game, first.connection);
    for (let tick = 0; tick < 60; tick++) game.step();
    expect(game.roundId).toBe(2);
    expect(game.options.world).toEqual(maps[0].world);
    expect(first.player.alive).toBe(false);
  });
});

describe('map assets and server configuration', () => {
  test('configuration accepts a bounded starting map and unique rotation, with CLI taking precedence', () => {
    expect(readConfig([], {})).toMatchObject({ roundSeconds: 900, map: 'ubercube' });
    expect(readConfig([], { MAP_ROTATION: 'fixture,ubercube' })).toMatchObject({ map: 'fixture' });
    expect(readConfig(['--map=fixture', '--map-rotation=fixture,ubercube', '--round-seconds=0'], { MAP: 'other', MAP_ROTATION: 'other' }))
      .toMatchObject({ map: 'fixture', mapRotation: ['fixture', 'ubercube'], roundSeconds: 0 });
    for (const value of ['../map', 'one,one', 'one,', ',one', ' ']) {
      expect(() => readConfig([], { MAP_ROTATION: value })).toThrow();
    }
    expect(() => startServer({ maps, map: 'absent', port: 0 })).toThrow();
    expect(() => startServer({ maps, mapRotation: ['absent'], port: 0 })).toThrow();
  });

  test('catalogs require source/license, canonical identities and matching hashes and dimensions', () => {
    const { root, entry, bytes } = mapFixture();
    const choices = readMapCatalog(root, maps[0].world);
    expect(choices.map(choice => choice.id)).toEqual(['ubercube', 'fixture']);
    expect(loadMap(root, choices[1])?.size).toBe(512);
    writeFileSync(join(root, `${entry.hash}.ucmap`), new Uint8Array(bytes.length));
    expect(() => loadMap(root, choices[1])).toThrow('hash mismatch');
    for (const patch of [{ license: '' }, { source: '' }, { id: '../fixture' }, { hash: '../fixture' }]) {
      writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: 1, maps: [{ ...entry, ...patch }] }));
      expect(() => readMapCatalog(root, maps[0].world)).toThrow();
    }
    const small = mapFixture(flatMap(64, 48));
    expect(() => loadMap(small.root, readMapCatalog(small.root, maps[0].world)[1])).toThrow('dimensions');
  });

  test('real sockets agree on lobby selection, stale commands, rotation, late join, asset bytes and CORS', async () => {
    const fixture = mapFixture();
    const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false, mapsRoot: fixture.root,
      world: maps[0].world, roundSeconds: 1, allowedOrigins: ['https://client.example'] });
    hosts.push(host);
    const base = `http://127.0.0.1:${host.server.port}`;
    const url = `${base}/maps/${fixture.entry.hash}.ucmap`;
    const response = await fetch(url, { headers: { Origin: 'https://client.example' } });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://client.example');
    expect(createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex')).toBe(fixture.entry.hash);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(url, { headers: { Origin: 'https://other.example' } })).status).toBe(403);
    expect((await fetch(`${base}/maps/${'f'.repeat(64)}.ucmap`)).status).toBe(404);
    expect((await fetch(`${base}/maps/catalog.json`)).status).toBe(404);

    function connect(name: string) {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`), messages: ServerMessage[] = [];
      sockets.push(socket);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name }));
      socket.onmessage = event => messages.push(decodeServerMessage(event.data));
      return { socket, async wait<T extends ServerMessage['type']>(type: T, matches: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          const index = messages.findIndex(message => message.type === type && matches(message as Extract<ServerMessage, { type: T }>));
          if (index >= 0) return messages.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
          await Bun.sleep(5);
        }
        throw new Error(`Missing ${type}`);
      } };
    }
    const first = connect('First'), welcome = await first.wait('welcome');
    await first.wait('world');
    const second = connect('Second');
    await second.wait('welcome');
    expect((await second.wait('map-choice')).chooserId).toBe(welcome.id);
    first.socket.send(JSON.stringify({ type: 'select-map', roundId: welcome.roundId, mapId: 'fixture' }));
    const reset = await first.wait('reset');
    expect((await second.wait('reset')).world).toEqual(reset.world);
    expect(reset.world.map?.hash).toBe(fixture.entry.hash);
    await first.wait('world', message => message.roundId === reset.roundId && !!message.complete);
    const late = connect('Late');
    expect((await late.wait('welcome')).world).toEqual(reset.world);
    second.socket.send(JSON.stringify({ type: 'spawn', roundId: welcome.roundId, kit: 'assault' }));
    first.socket.send(JSON.stringify({ type: 'spawn', roundId: reset.roundId, kit: 'assault' }));
    await first.wait('snapshot', message => message.players.some(player => player.id === welcome.id && player.alive));
    expect([...host.game.players.values()].filter(player => player.alive)).toHaveLength(1);
    for (let tick = 0; tick < 60; tick++) host.game.step();
    const rotated = await first.wait('reset', message => message.roundId > reset.roundId);
    expect(rotated.world.map).toBeUndefined();
    expect((await second.wait('reset', message => message.roundId === rotated.roundId)).world).toEqual(rotated.world);
    expect((await late.wait('reset')).world).toEqual(rotated.world);
    expect((await first.wait('map-choice', message => message.roundId === rotated.roundId)).chooserId).toBeNull();
    expect([...host.game.players.values()].every(player => !player.alive)).toBe(true);
    for (const socket of sockets) socket.close();
    const deadline = performance.now() + 2000;
    while (host.game.connections.size && performance.now() < deadline) await Bun.sleep(5);
    expect(host.game.connections.size).toBe(0);
  });
});
