import { strict as assert } from 'node:assert';
import { appendFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { startServer, readConfig } from '../src/server/index';
import { parseLoadtestArgs, runLoadtest, terrainDigest } from './loadtest';

// The private IPC channel keeps authoritative inspection outside the public game API.
const serverArgs = Bun.argv.slice(2).filter(arg => /^--(mode|size|height|seed|round-seconds)=/.test(arg));
const delayArgs = Bun.argv.slice(2).filter(arg => /^--(latency-ms|jitter-ms)=/.test(arg));
const delays = new Map<string, number>();
for (const arg of delayArgs) {
  const match = /^--(latency-ms|jitter-ms)=(\d+)$/.exec(arg);
  assert(match && !delays.has(match[1]), `Invalid or duplicate latency option: ${arg}`);
  delays.set(match[1], Number(match[2]));
}
const latencyMs = delays.get('latency-ms') ?? 0, jitterMs = delays.get('jitter-ms') ?? 0;
assert(latencyMs <= 2000 && jitterMs <= latencyMs, 'Latency must be 0..2000 ms and jitter 0..latency');
const loadArgs = Bun.argv.slice(2).filter(arg => !serverArgs.includes(arg) && !delayArgs.includes(arg)
  && arg !== '--server-child' && arg !== '--cpu-profile' && arg !== '--memory-profile');
const options = parseLoadtestArgs(loadArgs);
const memoryProfile = Bun.argv.includes('--memory-profile');
const memoryProfilePath = options.output.replace(/\.json$/, '.memory.jsonl');
const stopFile = options.output + '.stop';
assert(!loadArgs.some(arg => arg.startsWith('--url=')), 'This runner only creates its own local test server');

if (Bun.argv.includes('--server-child')) {
  assert(process.send, 'The server child requires its parent IPC channel');
  const heapStats = memoryProfile ? (await import('bun:jsc')).heapStats : undefined;
  const host = startServer({ ...readConfig(serverArgs, {}), port: 0, hostname: '127.0.0.1', maxPlayers: options.players,
    admission: { maxConnectionsPerIp: options.players + 16, ipBurst: options.players + 16 } });
  let pendingMemoryWrite = Promise.resolve();
  let writingMemory = false;
  const sampleMemory = async (stage: 'start' | 'interval' | 'end') => {
    if (!heapStats) return;
    writingMemory = true;
    try {
      const entry = JSON.stringify({ date: new Date().toISOString(), stage, pid: process.pid, uptimeSeconds: process.uptime(),
        roundId: host.game.roundId, revision: host.game.revision, players: host.game.players.size,
        connections: host.game.connections.size, worldEdits: host.game.world.editCount,
        memory: process.memoryUsage(), heap: heapStats(),
        limitation: 'Diagnostic only: no explicit GC request, but heapStats may collect an empty heap and rebuild allocator free lists. Some counters describe the last collection.' });
      pendingMemoryWrite = appendFile(memoryProfilePath, entry + '\n');
      await pendingMemoryWrite;
    } finally { writingMemory = false; }
  };
  if (memoryProfile) {
    try {
      await mkdir(dirname(memoryProfilePath), { recursive: true });
      await Bun.write(memoryProfilePath, '');
      await sampleMemory('start');
    } catch (error) { host.stop(); process.disconnect?.(); throw error; }
  }
  const memoryTimer = memoryProfile ? setInterval(() => {
    if (writingMemory) return;
    void sampleMemory('interval').catch(error => process.send?.({ type: 'diagnostic-error', message: String(error) }));
  }, 60000) : undefined;
  process.send({ type: 'ready', port: host.server.port });
  process.on('message', async message => {
    if (message !== 'inspect') return;
    const deadline = performance.now() + 5000;
    while (host.game.connections.size && performance.now() < deadline) await Bun.sleep(20);
    const status = await (await fetch(`http://127.0.0.1:${host.server.port}/health`)).json();
    if (memoryTimer) clearInterval(memoryTimer);
    host.stop();
    try { await pendingMemoryWrite; await sampleMemory('end'); }
    catch (error) { process.send?.({ type: 'diagnostic-error', message: String(error) }); }
    process.send!({ type: 'result', status, connections: host.game.connections.size,
      terrain: terrainDigest(host.game.world, host.game.roundId, host.game.revision) });
    process.disconnect?.();
  });
  process.on('disconnect', () => { if (memoryTimer) clearInterval(memoryTimer); host.stop(); process.exit(0); });
} else {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Local qualification interrupted'));
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  let port = 0;
  let proxy: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>> | undefined;
  let proxyStderr: Promise<string> | undefined;
  let stopTimer: ReturnType<typeof setInterval> | undefined;
  let authoritative: { status: { players: number }; connections: number; terrain: ReturnType<typeof terrainDigest> } | undefined;
  const profileArgs = Bun.argv.includes('--cpu-profile')
    ? ['--cpu-prof-md', '--cpu-prof-dir=.runtime/stable-100', '--cpu-prof-name=server-profile.md'] : [];
  const child = Bun.spawn([process.execPath, ...profileArgs, import.meta.path, ...Bun.argv.slice(2), '--server-child'], {
    stdout: 'inherit', stderr: 'inherit',
    ipc(message: { type: string; port: number; message?: string } & NonNullable<typeof authoritative>) {
      if (message.type === 'ready') port = message.port;
      if (message.type === 'result') authoritative = message;
      if (message.type === 'diagnostic-error') controller.abort(new Error(message.message));
    },
  });
  const wait = async (ready: () => boolean, interruptible = true) => {
    const deadline = performance.now() + 10000;
    while (!ready()) {
      if (interruptible) controller.signal.throwIfAborted();
      assert(child.exitCode === null && performance.now() < deadline, 'Local test server did not respond');
      await Bun.sleep(20);
    }
  };
  try {
    await wait(() => port > 0);
    if (latencyMs) {
      const node = Bun.which('node');
      assert(node, 'Node.js >=22.18 is required for the optional TCP latency proxy');
      proxy = Bun.spawn([node, '--experimental-strip-types', `${import.meta.dir}/impairment-proxy.ts`,
        `--target-port=${port}`, `--latency-ms=${latencyMs}`, `--jitter-ms=${jitterMs}`],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      proxyStderr = new Response(proxy.stderr).text();
      const reader = proxy.stdout.getReader();
      let line = '';
      while (!line.includes('\n')) {
        const part = await reader.read();
        assert(!part.done && line.length < 1024, 'The local latency proxy failed to start');
        line += new TextDecoder().decode(part.value);
      }
      port = JSON.parse(line.trim()).port;
      assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid local proxy port');
      reader.releaseLock();
    }
    console.log(`Local qualification: ${options.players} active clients, ${options.seconds}s, separate server PID ${child.pid}`);
    let checkingStop = false;
    const checkStop = async () => {
      if (checkingStop || controller.signal.aborted) return;
      checkingStop = true;
      try {
        if (await Bun.file(stopFile).exists()) controller.abort(new Error(`Local qualification stopped by ${stopFile}`));
      } catch (error) { controller.abort(error); }
      finally { checkingStop = false; }
    };
    await checkStop();
    stopTimer = setInterval(() => { void checkStop(); }, 1000);
    const result = await runLoadtest({ ...options, url: `ws://127.0.0.1:${port}/ws` }, controller.signal);
    child.send('inspect');
    await wait(() => authoritative !== undefined, false);
    const terrainMatches = JSON.stringify(result.terrain.final) === JSON.stringify(authoritative!.terrain);
    const clean = authoritative!.status.players === 0 && authoritative!.connections === 0 && result.cleanupComplete;
    const evidence = { ok: result.ok && terrainMatches && clean && !controller.signal.aborted, report: options.output,
      authoritative, terrainMatches, clean, bun: Bun.version, os: process.platform,
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem(), latencyMs, jitterMs,
      memoryProfile: memoryProfile ? memoryProfilePath : null, diagnostic: memoryProfile || Bun.argv.includes('--cpu-profile'), stopFile,
      limitation: 'Separate processes on one local machine. Optional TCP delay/jitter; no packet loss, bandwidth limit, Internet or browser rendering measurement. Memory profiling traverses the heap and may perturb timing; diagnostic runs do not qualify endurance.' };
    await Bun.write(options.output.replace(/\.json$/, '.qualification.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, authoritative: undefined, metrics: {
      receivedMbps: result.receivedMbitPerSecond, p99: result.maxSampledTickP99Ms,
      lateTicks: result.lateTicksDuringRun, errors: result.errors, failure: result.failure,
    } }, null, 2));
    if (!evidence.ok) process.exitCode = 1;
  } finally {
    if (stopTimer) clearInterval(stopTimer);
    if (proxy) {
      try { proxy.stdin.write('stop\n'); proxy.stdin.end(); } catch { proxy.kill(); }
      await Promise.race([proxy.exited, Bun.sleep(3000)]);
      if (proxy.exitCode === null) proxy.kill();
      await proxy.exited;
      await Bun.write(options.output.replace(/\.json$/, '.proxy.log'), await proxyStderr!);
    }
    if (authoritative) await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill();
    await child.exited;
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
  }
}
