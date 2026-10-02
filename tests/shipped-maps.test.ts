import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../src/server/index';
import { readMapCatalog, loadMap } from '../src/server/maps';
import { GameServer } from '../src/server/game';
import { convertVxl, encodeImportedMap } from '../src/shared/imported-map';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { playerCollides } from '../src/shared/movement';

const root = resolve(import.meta.dir, '../public');
const catalog = JSON.parse(readFileSync(resolve(root, 'maps/catalog.json'), 'utf8'));
const choices = readMapCatalog(resolve(root, 'maps'), { seed: 12345, size: 256, height: 64 });

test('shipped maps have complete attribution, pinned provenance and distributed license notices', () => {
  expect(catalog.maps).toHaveLength(12);
  expect(catalog.maps.filter((entry: { license: string }) => entry.license === 'MIT')).toHaveLength(10);
  expect(catalog.maps.filter((entry: { license: string }) => entry.license === 'GPL-3.0')).toHaveLength(2);
  const credits = readFileSync(resolve(root, 'map-credits/index.html'), 'utf8');
  for (const entry of catalog.maps) {
    expect(entry.source).toContain(`/blob/${entry.revision}/`);
    expect(entry.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(entry.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(credits).toContain(entry.name);
    expect(credits).toContain(entry.author);
    expect(credits).toContain(entry.source);
    expect(credits).toContain(entry.licenseUrl);
    expect(readFileSync(resolve(root, `.${entry.licenseUrl}`), 'utf8')).toContain(
      entry.license === 'MIT' ? 'Copyright (c) 2021 Daniel Klingel' : 'GNU GENERAL PUBLIC LICENSE');
  }
});

test.each(choices.filter(choice => choice.world.map).flatMap(choice => (['tdm', 'ffa'] as const).map(mode => ({ choice, mode }))))(
  '%s admits 100 players inside playable spawn regions', ({ choice, mode }) => {
  const imported = loadMap(resolve(root, 'maps'), choice)!;
  const game = new GameServer({ mode, maps: [choice], loadMap: () => imported });
  expect(choice.spawnRegions).toHaveLength(2);
  const regionCounts = [0, 0];
  for (let i = 0; i < 100; i++) {
    const connection = game.connect({ send: () => 1, close() {}, bufferedAmount: () => 0 })!;
    game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Player ${i}` }));
    game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    expect(connection.player?.alive).toBe(true);
    expect(playerCollides(game.world, connection.player!.position)).toBe(false);
    const { position, team } = connection.player!;
    const regionIndex = choice.spawnRegions!.findIndex(region => position.x >= region.minX && position.x < region.maxX
      && position.z >= region.minZ && position.z < region.maxZ && position.y >= region.minY && position.y <= region.maxY + .011);
    expect(regionIndex).toBeGreaterThanOrEqual(0);
    if (mode === 'tdm') expect(regionIndex).toBe(team - 1);
    regionCounts[regionIndex]++;
  }
  expect(regionCounts.every(count => count > 0)).toBe(true);
  if (mode === 'tdm') expect(regionCounts).toEqual([50, 50]);
  for (let tick = 0; tick < 120; tick++) game.step();
  for (const player of game.players.values()) {
    expect(player.alive && player.grounded).toBe(true);
    expect(player.health).toBe(100);
    expect(playerCollides(game.world, player.position)).toBe(false);
  }
});

test('GPL source downloads reproduce the distributed converted maps byte for byte', () => {
  for (const entry of catalog.maps.filter((map: { license: string }) => map.license === 'GPL-3.0')) {
    const source = readFileSync(resolve(root, `.${entry.sourceDownload}`));
    expect(createHash('sha256').update(source).digest('hex')).toBe(entry.sourceSha256);
    const converted = encodeImportedMap(convertVxl(source));
    expect(createHash('sha256').update(converted).digest('hex')).toBe(entry.hash);
    expect(JSON.parse(readFileSync(resolve(root, `.${entry.metadataDownload}`), 'utf8')).author).toBe('Lancilloty');
  }
  for (const file of ['scripts/import-vxl.ts', 'src/shared/imported-map.ts']) {
    expect(readFileSync(resolve(root, 'map-credits/sources/converter', file), 'utf8'))
      .toBe(readFileSync(resolve(import.meta.dir, '..', file), 'utf8'));
  }
});

test('local HTTP serves credits, licenses and GPL sources while keeping the map catalog private', async () => {
  const host = startServer({ hostname: '127.0.0.1', port: 0, autoTick: false, clientRoot: root });
  try {
    const paths = ['/map-credits/index.html', ...catalog.maps.map((entry: { licenseUrl: string }) => entry.licenseUrl),
      ...catalog.maps.filter((entry: { license: string }) => entry.license === 'GPL-3.0')
        .flatMap((entry: { sourceDownload: string; metadataDownload: string }) => [entry.sourceDownload, entry.metadataDownload]),
      '/map-credits/sources/converter/scripts/import-vxl.ts',
      '/map-credits/sources/converter/src/shared/imported-map.ts',
      '/map-credits/sources/converter/README.txt'];
    for (const path of new Set<string>(paths)) {
      const response = await fetch(new URL(path, host.server.url));
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(readFileSync(resolve(root, `.${path}`))));
    }
    expect((await fetch(new URL('/maps/catalog.json', host.server.url))).status).toBe(404);
  } finally { host.stop(); }
});
