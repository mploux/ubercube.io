import { expect, test } from 'bun:test';
import { createConnection, createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startImpairmentProxy } from '../scripts/impairment-proxy';

async function nodeProxy(targetPort: number, latencyMs: number, jitterMs = 0) {
  const node = Bun.which('node');
  if (!node) throw new Error('Node.js 22.19 or newer is required for the TCP impairment proxy');
  const child = Bun.spawn([node, '--experimental-strip-types',
    fileURLToPath(new URL('../scripts/impairment-proxy.ts', import.meta.url)),
    `--target-port=${targetPort}`, `--latency-ms=${latencyMs}`, `--jitter-ms=${jitterMs}`],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  let output = '';
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    while (!output.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Node proxy did not start: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(chunk.value);
    }
  } catch (error) { child.kill(); await child.exited; throw error; }
  finally { clearTimeout(deadline); reader.releaseLock(); }
  const { port } = JSON.parse(output.trim()) as { port: number };
  let stopped: Promise<ReturnType<Awaited<ReturnType<typeof startImpairmentProxy>>['stats']>> | undefined;
  return {
    port,
    stop() {
      return stopped ??= (async () => {
        child.stdin.write('stop\n'); child.stdin.end();
        const deadline = setTimeout(() => child.kill(), 5000);
        try {
          expect(await child.exited).toBe(0);
          const lines = (await new Response(child.stderr).text()).trim().split('\n');
          const summary = JSON.parse(lines.at(-1)!) as { impairmentProxy: ReturnType<Awaited<ReturnType<typeof startImpairmentProxy>>['stats']> };
          return summary.impairmentProxy;
        } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); }
      })();
    },
  };
}

async function target(onConnection: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    onConnection(socket);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('Missing target port');
  return {
    port: address.port,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function wait(condition: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for proxy');
    await Bun.sleep(5);
  }
}

test('rejects invalid ports and delay ranges before opening a listener', async () => {
  for (const port of [0, -1, 65536, 1.5, NaN]) {
    await expect(startImpairmentProxy(port, { latencyMs: 50, jitterMs: 20 })).rejects.toThrow('port');
  }
  for (const options of [{ latencyMs: -1, jitterMs: 0 }, { latencyMs: 2001, jitterMs: 0 },
    { latencyMs: 1.5, jitterMs: 0 }, { latencyMs: 50, jitterMs: 51 }, { latencyMs: 50, jitterMs: NaN }]) {
    await expect(startImpairmentProxy(1, options)).rejects.toThrow();
  }
});

test('preserves fragmented byte order through both delayed directions and a graceful half close', async () => {
  const script = `
    import { createConnection, createServer } from 'node:net';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { startImpairmentProxy } from ${JSON.stringify(new URL('../scripts/impairment-proxy.ts', import.meta.url).href)};
    const echo = createServer(socket => socket.pipe(socket));
    await new Promise(resolve => echo.listen(0, '127.0.0.1', resolve));
    const proxy = await startImpairmentProxy(echo.address().port, { latencyMs: 50, jitterMs: 20 });
    const socket = createConnection({ host: '127.0.0.1', port: proxy.port, allowHalfOpen: true });
    const received = [];
    let firstDataAt = 0;
    socket.on('data', data => { firstDataAt ||= performance.now(); received.push(data); });
    try {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      const payload = Buffer.alloc(65536);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const startedAt = performance.now();
      for (let offset = 0; offset < payload.length; offset += 4093) {
        socket.write(payload.subarray(offset, offset + 4093)); await sleep(2);
      }
      const ended = new Promise((resolve, reject) => { socket.once('end', resolve); socket.once('error', reject); });
      socket.end(); await ended;
      console.log(JSON.stringify({ equal: Buffer.concat(received).equals(payload), received: Buffer.concat(received).length,
        firstDataMs: firstDataAt - startedAt, elapsedMs: performance.now() - startedAt, stats: proxy.stats() }));
    } finally { socket.destroy(); await proxy.stop(); await new Promise(resolve => echo.close(resolve)); }
  `;
  const child = Bun.spawn([Bun.which('node')!, '--experimental-strip-types', '--input-type=module', '-e', script],
    { stdout: 'pipe', stderr: 'pipe' });
  const deadline = setTimeout(() => child.kill(), 5000);
  try {
    expect(await child.exited).toBe(0);
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(result.equal).toBe(true);
    expect(result.received).toBe(65536);
    expect(result.firstDataMs).toBeGreaterThanOrEqual(55);
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(result.stats.queuedBytes).toBe(0);
    expect(result.stats.overflowClosures).toBe(0);
  } finally { clearTimeout(deadline); if (child.exitCode === null) child.kill(); }
}, 10000);

test('bounds delayed data and closes an overflowing paused transfer instead of growing memory', async () => {
  const sink = await target(socket => socket.pause());
  const proxy = await nodeProxy(sink.port, 2000);
  const socket = createConnection({ host: '127.0.0.1', port: proxy.port });
  let closed = false;
  socket.on('error', () => {}); socket.on('close', () => { closed = true; });
  try {
    await wait(() => !socket.connecting);
    socket.write(Buffer.alloc(8 * 1024 * 1024));
    await wait(() => closed);
    const stats = await proxy.stop();
    expect(stats.overflowClosures).toBeGreaterThan(0);
    expect(stats.peakDirectionBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(stats.peakQueuedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(stats.connections).toBe(0);
    expect(stats.queuedBytes).toBe(0);
  } finally { socket.destroy(); await proxy.stop(); await sink.stop(); }
}, 10000);

test('stopping cancels delayed traffic, closes sockets and releases the listener', async () => {
  const echo = await target(socket => socket.pipe(socket));
  const proxy = await nodeProxy(echo.port, 1000);
  const socket = createConnection({ host: '127.0.0.1', port: proxy.port });
  let received = 0, closed = false;
  socket.on('data', data => { received += data.length; });
  socket.on('error', () => {}); socket.on('close', () => { closed = true; });
  try {
    await wait(() => !socket.connecting);
    socket.write('pending');
    await Bun.sleep(100);
    const stats = await proxy.stop(); await proxy.stop();
    await wait(() => closed);
    expect(stats.connections).toBe(0);
    expect(stats.queuedBytes).toBe(0);
    expect(stats.peakQueuedBytes).toBeGreaterThan(0);
    expect(received).toBe(0);
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject); listener.listen(proxy.port, '127.0.0.1', resolve);
    });
    await new Promise<void>(resolve => listener.close(() => resolve()));
  } finally { socket.destroy(); await proxy.stop(); await echo.stop(); }
}, 10000);

test('an unreachable upstream closes the client and releases its queued bytes', async () => {
  const closedTarget = await target(socket => socket.destroy());
  await closedTarget.stop();
  const proxy = await nodeProxy(closedTarget.port, 50);
  const socket = createConnection({ host: '127.0.0.1', port: proxy.port });
  let closed = false;
  socket.on('error', () => {}); socket.on('close', () => { closed = true; });
  try {
    await wait(() => closed);
    const stats = await proxy.stop();
    expect(stats.connections).toBe(0);
    expect(stats.queuedBytes).toBe(0);
  } finally { socket.destroy(); await proxy.stop(); }
}, 10000);
