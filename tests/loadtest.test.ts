import { describe, expect, test } from 'bun:test';
import { parseLoadtestArgs, runLoadtest, terrainDigest, TerrainReplica } from '../scripts/loadtest';
import { startServer } from '../src/server/index';
import { TICK_RATE, type ServerMessage } from '../src/shared/protocol';
import { packBlock } from '../src/shared/voxel';

const world = { seed: 12, size: 64, height: 48 };
const welcome: ServerMessage = { type: 'welcome', id: 1, roundId: 1, world, maxPlayers: 100, mode: 'ffa', tickRate: TICK_RATE };
const baseline: ServerMessage = { type: 'world', roundId: 1, revision: 0, edits: [], initial: true, complete: true };
const options = (port: number, name: string, seconds = 2) => parseLoadtestArgs([
  `--url=ws://127.0.0.1:${port}/ws`, '--players=2', `--seconds=${seconds}`, '--ramp-ms=0',
  '--warmup-seconds=2', '--sample-seconds=1', `--output=.runtime/loadtest-tests/${name}.json`,
]);

describe('loadtest qualification', () => {
  test('CLI rejects silent clamps, duplicates, credentials and unknown options, and accepts eight hours', () => {
    for (const args of [['--players=NaN'], ['--players=100.5'], ['--players=0'], ['--seconds=28801'],
      ['--seconds=-1'], ['--players=2', '--players=3'], ['--unused=1'], ['--seconds'], ['--seconds='],
      ['--url=ws://user:secret@example.com/ws'], ['--url=https://example.com/ws'], ['--output=outside.json']]) {
      expect(() => parseLoadtestArgs(args)).toThrow();
    }
    expect(parseLoadtestArgs(['--seconds=28800']).seconds).toBe(28800);
  });

  test('rejects missing deltas, stale rounds and an initial restart on a live world', () => {
    const replica = new TerrainReplica(false);
    replica.receive(welcome); replica.receive(baseline);
    expect(() => replica.receive({ type: 'world', roundId: 1, revision: 2, edits: [] })).toThrow('revision gap');
    expect(() => replica.receive({ ...baseline, roundId: 2 })).toThrow('unknown round');
    expect(() => replica.receive(baseline)).toThrow('restarted');
    expect(() => replica.receive(welcome)).toThrow('welcome');
    replica.receive({ type: 'reset', roundId: 2, world });
    expect(replica.ready).toBe(false);
    expect(() => replica.receive({ ...baseline, roundId: 1 })).toThrow('unknown round');
    replica.receive({ ...baseline, roundId: 2 });
    expect(replica.ready).toBe(true);
  });

  test('compares real voxel overrides, catches a ghost block, and clears overrides on reset', () => {
    const a = new TerrainReplica(true), b = new TerrainReplica(true);
    for (const replica of [a, b]) { replica.receive(welcome); replica.receive(baseline); }
    expect(a.compare(b)).toBe(0);
    const build: ServerMessage = { type: 'world', roundId: 1, revision: 1, edits: [[3, 47, 4, packBlock(200, 100, 80)]] };
    a.receive(build); b.receive(build);
    expect(a.compare(b)).toBe(1);
    expect(terrainDigest(a.world!, 1, 1)).toEqual(terrainDigest(b.world!, 1, 1));
    a.receive({ type: 'world', roundId: 1, revision: 2, edits: [[3, 47, 4, 0]] });
    expect(a.compare(b)).toBeNull();
    b.receive({ type: 'world', roundId: 1, revision: 2, edits: [] });
    expect(() => a.compare(b)).toThrow('override count differs');
    for (const replica of [a, b]) {
      replica.receive({ type: 'reset', roundId: 2, world });
      replica.receive({ ...baseline, roundId: 2 });
    }
    expect(a.compare(b)).toBe(0);
  });

  test('starts after all peers spawn, checks round resets, writes final evidence and closes sockets', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', mode: 'ffa', world });
    const reset = setTimeout(() => host.game.resetRound(), 600);
    try {
      const configured = options(host.server.port!, 'reset');
      const result = await runLoadtest(configured);
      expect(result.failure).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.finished).toBe(true);
      expect(result.connected).toBe(2);
      expect(result.serverBefore!.players).toBe(2);
      expect(result.measuredSeconds).toBeGreaterThanOrEqual(2);
      expect(result.resetDeliveries).toBe(2);
      expect(result.terrain.lastComparisonRound).toBe(2);
      expect(result.terrain.final).toEqual(terrainDigest(host.game.world, host.game.roundId, host.game.revision));
      expect(result.terrain.finalConverged).toBe(true);
      expect(result.server!.pendingInput).toBe(0);
      expect(result.server!.projectiles).toBe(0);
      expect(result.rttMs.windowSamples).toBeGreaterThan(0);
      expect(result.categories.snapshot!.bytes).toBeGreaterThan(0);
      expect(result.cleanupComplete).toBe(true);
      expect(host.game.connections.size).toBe(0);
      const saved = await Bun.file(configured.output).json();
      expect(saved.finished).toBe(true);
      const journal = (await Bun.file(result.journal).text()).trim().split('\n').map(line => JSON.parse(line));
      expect(journal[0].finished).toBe(false);
      expect(journal.at(-1).finished).toBe(true);
      expect(journal.some(sample => sample.phase === 'running' && sample.serverBefore.players === 2)).toBe(true);
    } finally { clearTimeout(reset); host.stop(); }
  }, 10000);

  test('nonfatal application errors fail qualification and still release every connection', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', world });
    const invalid = setInterval(() => {
      for (const connection of host.game.connections) {
        if (connection.player) connection.peer.send(JSON.stringify({ type: 'error', message: 'Injected application failure', fatal: false }));
      }
    }, 30);
    try {
      const result = await runLoadtest(options(host.server.port!, 'application-error'));
      expect(result.ok).toBe(false);
      expect(result.failure).toContain('Injected application failure');
      expect(result.finished).toBe(true);
      expect(result.cleanupComplete).toBe(true);
      expect(host.game.connections.size).toBe(0);
    } finally { clearInterval(invalid); host.stop(); }
  }, 10000);

  test('an incomplete initial world never starts the measurement', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false, world });
    for (let i = 0; i < 513; i++) host.game.world.set(i % 64, 47, Math.floor(i / 64), packBlock(200, 100, 80));
    try {
      const result = await runLoadtest({ ...options(host.server.port!, 'incomplete-world'), warmupSeconds: 1 });
      expect(result.ok).toBe(false);
      expect(result.measuredSeconds).toBe(0);
      expect(result.inputs).toBe(0);
      expect(result.cleanupComplete).toBe(true);
      expect(host.game.connections.size).toBe(0);
    } finally { host.stop(); }
  }, 10000);

  test('an interrupted endurance run writes failure and releases all clients', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', world });
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(new Error('Test interruption')), 150);
    try {
      const result = await runLoadtest(options(host.server.port!, 'interrupted'), controller.signal);
      expect(result.ok).toBe(false);
      expect(result.finished).toBe(true);
      expect(result.failure).toContain('Test interruption');
      expect(result.cleanupComplete).toBe(true);
      expect(host.game.connections.size).toBe(0);
    } finally { clearTimeout(abort); host.stop(); }
  }, 10000);

  test('unexpected server termination fails instead of producing a success report', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', world });
    const stop = setTimeout(() => host.stop(), 150);
    try {
      const result = await runLoadtest(options(host.server.port!, 'server-stop'));
      expect(result.ok).toBe(false);
      expect(result.failure).not.toBeNull();
      expect(result.finished).toBe(true);
      expect(result.cleanupComplete).toBe(true);
    } finally { clearTimeout(stop); host.stop(); }
  }, 10000);

  test('planned late joins retain two terrain witnesses and clean up their old sockets', async () => {
    const host = startServer({ port: 0, hostname: '127.0.0.1', mode: 'ffa', world });
    try {
      const configured = { ...options(host.server.port!, 'reconnect', 4), warmupSeconds: 1, reconnectSeconds: 1 };
      const result = await runLoadtest(configured);
      expect(result.failure).toBeNull();
      expect(result.reconnects).toBeGreaterThan(0);
      expect(result.terrain.comparedReconnect).toBe(result.reconnects);
      expect(result.cleanupComplete).toBe(true);
      expect(host.game.connections.size).toBe(0);
    } finally { host.stop(); }
  }, 10000);
});
