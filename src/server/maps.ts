import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeImportedMap, type ImportedMap } from '../shared/imported-map.ts';
import type { MapChoice, WorldConfig } from '../shared/protocol.ts';
import { validSpawnRegions } from '../shared/protocol.ts';

const MAX_MAP_BYTES = 16 + (512 * 512 + 1 + 512 * 512 * 64 * 2) * 4;

export function readMapCatalog(mapsRoot: string, nativeWorld: WorldConfig): MapChoice[] {
  const maps: MapChoice[] = [{ id: 'ubercube', name: 'Ubercube', world: nativeWorld }];
  const catalogPath = resolve(mapsRoot, 'catalog.json');
  if (!existsSync(catalogPath)) return maps;
  if (statSync(catalogPath).size > 512 * 1024) throw new Error('Map catalog is too large');
  const catalog: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (typeof catalog !== 'object' || catalog === null || !('version' in catalog) || catalog.version !== 1
    || !('maps' in catalog) || !Array.isArray(catalog.maps) || catalog.maps.length > 255) throw new Error('Invalid map catalog');
  const ids = new Set(['ubercube']);
  const hashes = new Set<string>();
  for (const entry of catalog.maps) {
    if (typeof entry !== 'object' || entry === null
      || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(entry.id) || ids.has(entry.id)
      || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100
      || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || hashes.has(entry.hash)
      || typeof entry.source !== 'string' || !entry.source.trim() || entry.source.length > 2048
      || typeof entry.license !== 'string' || !entry.license.trim() || entry.license.length > 2048) throw new Error('Invalid map catalog entry');
    const file = statSync(resolve(mapsRoot, `${entry.hash}.ucmap`));
    if (!file.isFile() || file.size < 16 || file.size > MAX_MAP_BYTES) throw new Error(`Invalid map asset: ${entry.id}`);
    ids.add(entry.id);
    hashes.add(entry.hash);
    const world = { seed: 0, size: 512, height: 64, map: { id: entry.id, hash: entry.hash } };
    if (entry.spawnRegions !== undefined && !validSpawnRegions(entry.spawnRegions, world)) throw new Error('Invalid map spawn regions');
    maps.push({ id: entry.id, name: entry.name, world, ...(entry.spawnRegions ? { spawnRegions: entry.spawnRegions } : {}) });
  }
  return maps;
}

export function loadMap(mapsRoot: string, choice: MapChoice): ImportedMap | undefined {
  if (!choice.world.map) return undefined;
  const { id, hash } = choice.world.map;
  if (id !== choice.id || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid imported map identity');
  const path = resolve(mapsRoot, `${hash}.ucmap`);
  const file = statSync(path);
  if (!file.isFile() || file.size < 16 || file.size > MAX_MAP_BYTES) throw new Error(`Invalid map asset: ${id}`);
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Map hash mismatch: ${id}`);
  const map = decodeImportedMap(bytes);
  if (map.size !== 512 || map.height !== 64 || choice.world.size !== map.size || choice.world.height !== map.height) {
    throw new Error(`Invalid imported map dimensions: ${id}`);
  }
  return map;
}
