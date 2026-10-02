import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readMapCatalog } from '../src/server/maps';
import { GameServer } from '../src/shared/game';
import type { ImportedMap } from '../src/shared/imported-map';
import { PROTOCOL_VERSION, type MapChoice, type SpawnRegion } from '../src/shared/protocol';
import { packBlock } from '../src/shared/voxel';

const regions: [SpawnRegion, SpawnRegion] = [
  { minX: 4, maxX: 20, minZ: 8, maxZ: 24, minY: 8, maxY: 8 },
  { minX: 44, maxX: 60, minZ: 8, maxZ: 24, minY: 8, maxY: 8 },
];
const choice: MapChoice = { id: 'fixture', name: 'Fixture', spawnRegions: regions,
  world: { seed: 1, size: 64, height: 48, map: { id: 'fixture', hash: 'a'.repeat(64) } } };
const imported: ImportedMap = { size: 64, height: 48,
  offsets: Uint32Array.from({ length: 64 * 64 + 1 }, (_, i) => i * 2),
  runs: Uint32Array.from({ length: 64 * 64 * 2 }, (_, i) => i % 2 ? packBlock(90, 120, 60) : 8 << 16) };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir(), 'ubercube-spawns-'))) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function enter(game: GameServer) {
  const connection = game.connect({ send: () => 1, close() {}, bufferedAmount: () => 0 })!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Player' }));
  return connection;
}

test('destroyed spawn floor cannot fall back to a lower surface, and a reset restores admission', () => {
  const game = new GameServer({ maps: [choice], loadMap: () => imported });
  const connection = enter(game);
  for (let x = 44; x < 60; x++) for (let z = 8; z < 24; z++) game.world.set(x, 7, z, 0);
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  expect(connection.player!.alive).toBe(false);
  game.resetRound();
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  expect(connection.player!.alive).toBe(true);
  expect(connection.player!.position.y).toBe(8.01);
  expect(connection.player!.position.x).toBeGreaterThanOrEqual(44);
  expect(connection.player!.position.x).toBeLessThan(60);
});

test('blocked spawn headroom cannot move the player onto a roof or outside the region', () => {
  const game = new GameServer({ maps: [choice], loadMap: () => imported });
  const connection = enter(game);
  for (let x = 44; x < 60; x++) for (let z = 8; z < 24; z++) game.world.set(x, 10, z, packBlock(1, 2, 3));
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  expect(connection.player!.alive).toBe(false);
});

test('occupied regions retain player clearance instead of overlapping or escaping', () => {
  const tiny: MapChoice = { ...choice, spawnRegions: regions.map(region => ({ ...region,
    maxX: region.minX + 1, maxZ: region.minZ + 1 })) as [SpawnRegion, SpawnRegion] };
  const game = new GameServer({ maps: [tiny], loadMap: () => imported });
  const players = Array.from({ length: 3 }, () => enter(game));
  for (const connection of players) game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  expect(players.map(connection => connection.player!.alive)).toEqual([true, true, false]);
});

test('map rotation applies the destination regions instead of retaining the previous ones', () => {
  const next: MapChoice = { ...choice, id: 'next', world: { ...choice.world, map: { ...choice.world.map!, id: 'next' } },
    spawnRegions: regions.map(region => ({ ...region, minZ: 32, maxZ: 48 })) as [SpawnRegion, SpawnRegion] };
  const game = new GameServer({ maps: [choice, next], loadMap: () => imported, roundSeconds: 1 });
  const connection = enter(game);
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  expect(connection.player!.position.z).toBeLessThan(24);
  for (let tick = 0; tick < 60; tick++) game.step();
  expect(game.options.world.map!.id).toBe('next');
  expect(connection.player!.alive).toBe(false);
  game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  expect(connection.player!.alive).toBe(true);
  expect(connection.player!.position.z).toBeGreaterThanOrEqual(32);
  expect(connection.player!.position.z).toBeLessThan(48);
});

test('direct configuration rejects malformed regions before loading a map', () => {
  const invalid = [null, [], new Array(2), [regions[0]], [...regions, regions[0]], [null, regions[1]],
    ...[{ minX: -1 }, { maxX: 65 }, { minZ: -1 }, { maxZ: 65 }, { minX: 20 }, { minZ: 24 },
      { minY: 0 }, { maxY: 46 }, { minY: 9 }, { maxX: 4.5 }, { minX: NaN }, { maxY: Infinity },
      { minY: '8' }].map(change => [{ ...regions[0], ...change }, regions[1]])];
  for (const spawnRegions of invalid) {
    expect(() => new GameServer({ maps: [{ ...choice, spawnRegions } as MapChoice], loadMap: () => imported }))
      .toThrow('Invalid map rotation');
  }
});

test('catalog preserves valid regions and rejects malformed or out-of-world regions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ubercube-spawns-'));
  directories.push(root);
  const entry = { id: choice.id, name: choice.name, hash: choice.world.map!.hash, source: 'test fixture', license: 'CC0-1.0' };
  writeFileSync(join(root, `${entry.hash}.ucmap`), new Uint8Array(16));
  for (const spawnRegions of [regions, null, [], [regions[0]],
    ...[{ maxX: 513 }, { maxZ: 513 }, { minY: 0 }, { maxY: 62 }, { maxX: 4 }, { minZ: 24 },
      { minX: -1 }, { minY: 8.5 }, { maxY: 7 }, { minX: '4' }].map(change => [{ ...regions[0], ...change }, regions[1]])]) {
    writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: 1, maps: [{ ...entry, spawnRegions }] }));
    const read = () => readMapCatalog(root, { seed: 12345, size: 256, height: 64 });
    if (spawnRegions === regions) expect(read()[1].spawnRegions).toEqual(regions);
    else expect(read).toThrow('Invalid map spawn regions');
  }
});
