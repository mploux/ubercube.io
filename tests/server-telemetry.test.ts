import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/index';
import { PROTOCOL_VERSION } from '../src/shared/protocol';

type Telemetry = {
  rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number | null;
  transportSockets: number; pendingSendBytes: number; pendingSendMessages: number; players: number;
};

async function wait(condition: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = performance.now() + timeout;
  while (!(await condition())) {
    if (performance.now() >= end) throw new Error('Timed out waiting for telemetry');
    await Bun.sleep(20);
  }
}

test('health and status expose finite memory counters without detailed heap data', async () => {
  const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false });
  try {
    for (const path of ['/health', '/api/status']) {
      const response = await fetch(`http://127.0.0.1:${host.server.port}${path}`);
      const metrics = await response.json() as Telemetry;
      expect(response.status).toBe(200);
      for (const name of ['rss', 'heapUsed', 'heapTotal', 'external'] as const) {
        expect(Number.isFinite(metrics[name])).toBe(true);
        expect(metrics[name]).toBeGreaterThanOrEqual(0);
      }
      expect(metrics.arrayBuffers === null || (Number.isFinite(metrics.arrayBuffers) && metrics.arrayBuffers >= 0)).toBe(true);
      expect(metrics.transportSockets).toBe(0);
      expect(metrics.pendingSendBytes).toBe(0);
      expect(metrics.pendingSendMessages).toBe(0);
      expect('objectTypeCounts' in metrics).toBe(false);
      expect('heapSnapshot' in metrics).toBe(false);
    }
  } finally { host.stop(); }
});

test('transport population includes unidentified peers and returns to zero after each close', async () => {
  const host = startServer({ port: 0, hostname: '127.0.0.1', maxPlayers: 2,
    world: { seed: 12, size: 64, height: 48 } });
  const sockets: WebSocket[] = [];
  const status = async () => (await fetch(`http://127.0.0.1:${host.server.port}/health`)).json() as Promise<Telemetry>;
  try {
    for (let iteration = 0; iteration < 3; iteration++) {
      const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/ws`);
      sockets.push(socket);
      await wait(() => socket.readyState === WebSocket.OPEN);
      const anonymous = await status();
      expect(anonymous.transportSockets).toBe(1);
      expect(anonymous.players).toBe(0);
      socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Telemetry' }));
      await wait(async () => (await status()).players === 1);
      socket.close(1000, 'Telemetry cleanup');
      await wait(async () => (await status()).transportSockets === 0);
      const cleaned = await status();
      expect(cleaned.players).toBe(0);
      expect(cleaned.pendingSendBytes).toBe(0);
      expect(cleaned.pendingSendMessages).toBe(0);
    }
  } finally { for (const socket of sockets) socket.close(); host.stop(); }
});

test('a stop file preserves failure, cleanup evidence and start/end memory samples', async () => {
  const output = `.runtime/server-telemetry-tests/stop-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../scripts/qualify-local.ts', import.meta.url)),
    '--players=2', '--seconds=30', '--ramp-ms=0', '--sample-seconds=1', '--memory-profile', `--output=${output}`],
  { stdout: 'pipe', stderr: 'pipe' });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  try {
    await wait(async () => {
      if (child.exitCode !== null) throw new Error(`Qualification ended before stop: ${await stderr}`);
      return await Bun.file(output).exists() && (await Bun.file(output).json()).phase === 'running';
    }, 10000);
    await Bun.write(output + '.stop', '');
    await wait(() => child.exitCode !== null, 10000);
    expect(await child.exited).toBe(1);
    const report = await Bun.file(output).json();
    expect(report.finished).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.failure).toContain('.stop');
    expect(report.cleanupComplete).toBe(true);
    const evidence = await Bun.file(output.replace(/\.json$/, '.qualification.json')).json();
    expect(evidence.clean).toBe(true);
    expect(evidence.diagnostic).toBe(true);
    const samples = (await Bun.file(output.replace(/\.json$/, '.memory.jsonl')).text()).trim().split('\n').map(line => JSON.parse(line));
    expect(samples.map(sample => sample.stage)).toEqual(['start', 'end']);
    expect(samples.every(sample => Number.isFinite(sample.memory.heapUsed) && Number.isFinite(sample.heap.objectCount))).toBe(true);
    expect(samples.at(-1).connections).toBe(0);
    await stdout;
  } finally {
    if (child.exitCode === null) {
      await Bun.write(output + '.stop', '');
      await Promise.race([child.exited, Bun.sleep(3000)]);
      if (child.exitCode === null) child.kill();
    }
    await child.exited;
  }
}, 25000);
