import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { randomInt } from 'node:crypto';
import type { ServerWebSocket } from 'bun';
import { DT, PROTOCOL_VERSION } from '../shared/protocol.ts';
import { serverMessageType } from '../shared/wire.ts';
import { GameServer } from './game.ts';
import type { Connection, GameOptions } from './game.ts';
import { AdmissionGuard, type AdmissionOptions } from './admission.ts';

export interface StartOptions extends Partial<GameOptions> {
  port?: number;
  hostname?: string;
  autoTick?: boolean;
  clientRoot?: string;
  allowedOrigins?: string[];
  admission?: Partial<AdmissionOptions>;
  trustProxy?: 'none' | 'loopback';
  now?: () => number;
}
interface SocketData {
  connection: Connection | null;
  release: () => void;
  pending: (string | Uint8Array)[];
  pendingBytes: number;
}

function normalizeAddress(address: string): string | null {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return null;
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
    if (!mapped) return normalized;
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  } catch { return null; }
}

export function clientAddress(peer: string, forwarded: string | null, trustProxy: StartOptions['trustProxy']): string | null {
  const address = normalizeAddress(peer);
  if (!address) return null;
  if (trustProxy !== 'loopback' || (address !== '::1' && !address.startsWith('127.')) || forwarded === null) return address;
  if (forwarded.length > 256) return null;
  // A single trusted local proxy appends its actual peer after any untrusted prefix.
  return normalizeAddress(forwarded.split(',').at(-1)!.trim());
}

function parseOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:\/\/[^\s/?#*,@\\]+\/?$/i.test(value) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ALLOWED_ORIGINS must contain HTTP(S) origins without credentials, paths, queries or fragments');
  }
  return url.origin;
}

export function readConfig(args: string[] = Bun.argv.slice(2), env: Record<string, string | undefined> = Bun.env): StartOptions {
  const argumentsMap = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(mode|port|max-players|seed|size|height|round-seconds|hostname|max-connections-per-ip|trust-proxy)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    argumentsMap.set(match[1], match[2]);
  }
  const value = (arg: string, environment: string, fallback: string) => argumentsMap.get(arg) ?? env[environment] ?? fallback;
  const integer = (arg: string, environment: string, fallback: number, min: number, max: number) => {
    const raw = value(arg, environment, String(fallback));
    const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${environment}: ${raw}`);
    return parsed;
  };
  const mode = value('mode', 'MODE', 'tdm');
  if (mode !== 'tdm' && mode !== 'ffa') throw new Error('MODE must be tdm or ffa');
  const trustProxy = value('trust-proxy', 'TRUST_PROXY', 'none');
  if (trustProxy !== 'none' && trustProxy !== 'loopback') throw new Error('TRUST_PROXY must be none or loopback');
  const maxConnectionsPerIp = integer('max-connections-per-ip', 'MAX_CONNECTIONS_PER_IP', 24, 1, 1016);
  return {
    mode,
    port: integer('port', 'PORT', 3000, 1, 65535),
    hostname: value('hostname', 'HOST', '0.0.0.0'),
    allowedOrigins: env.ALLOWED_ORIGINS?.trim() ? env.ALLOWED_ORIGINS.split(',').map(origin => parseOrigin(origin.trim())) : [],
    maxPlayers: integer('max-players', 'MAX_PLAYERS', 100, 1, 1000),
    roundSeconds: integer('round-seconds', 'ROUND_SECONDS', 0, 0, 86400),
    trustProxy,
    admission: { maxConnectionsPerIp, ipBurst: maxConnectionsPerIp },
    world: {
      seed: integer('seed', 'WORLD_SEED', 12345, 0, 0xffffffff),
      size: integer('size', 'WORLD_SIZE', 256, 64, 2048),
      height: integer('height', 'WORLD_HEIGHT', 64, 32, 256),
    },
  };
}

export function startServer(options: StartOptions = {}) {
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(parseOrigin));
  if (options.trustProxy !== undefined && !['none', 'loopback'].includes(options.trustProxy)) throw new Error('Invalid trusted proxy');
  const now = options.now ?? (() => performance.now());
  const game = new GameServer(options, undefined, options.now ?? (options.autoTick === false ? undefined : now),
    () => randomInt(0x100000000) / 0x100000000);
  const admission = new AdmissionGuard({ maxConnections: game.options.maxPlayers + 16, ...options.admission }, now);
  const clientRoot = resolve(options.clientRoot ?? fileURLToPath(new URL('../../dist/client', import.meta.url)));
  const tickWork: number[] = [];
  const loopDelay: number[] = [];
  let maxTickWork = 0;
  let lateTicks = 0;
  let abandonedMs = 0;
  let maxLoopDelay = 0;
  const network = { receivedMessages: 0, receivedBytes: 0, sentMessages: 0, sentBytes: 0,
    receiveWorkMs: 0, maxReceiveWorkMs: 0,
    sentBytesByType: { welcome: 0, roster: 0, world: 0, snapshot: 0, reset: 0, error: 0, pong: 0, event: 0 } };
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let batching = false;
  const sendNow = (ws: ServerWebSocket<SocketData>, data: string | Uint8Array) => {
    const result = ws.send(data);
    if (result !== 0) {
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      network.sentMessages++; network.sentBytes += bytes;
      network.sentBytesByType[serverMessageType(data)] += bytes;
    }
    return result;
  };
  const flush = (ws: ServerWebSocket<SocketData>) => {
    if (!ws.data.pending.length) return;
    try {
      ws.cork(() => {
        for (const data of ws.data.pending) {
          if (sendNow(ws, data) === 0) throw new Error('WebSocket send failed');
        }
      });
    } catch {
      if (ws.data.connection) game.disconnect(ws.data.connection);
      ws.close(1013, 'Connection too slow');
    } finally { ws.data.pending = []; ws.data.pendingBytes = 0; }
  };
  const metrics = () => {
    const sorted = [...tickWork].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
    const delays = [...loopDelay].sort((a, b) => a - b);
    let pendingInput = 0, bufferedBytes = 0, maxBufferedBytes = 0, initialConnections = 0, initialDeltaEdits = 0;
    let pendingSendBytes = 0, pendingSendMessages = 0;
    const memory = process.memoryUsage();
    for (const connection of game.connections) {
      pendingInput += connection.queue.length;
      const buffered = connection.peer.bufferedAmount();
      bufferedBytes += buffered; maxBufferedBytes = Math.max(maxBufferedBytes, buffered);
      if (connection.initial) { initialConnections++; initialDeltaEdits += connection.initial.deltaEdits; }
    }
    for (const ws of sockets) {
      pendingSendBytes += ws.data.pendingBytes;
      pendingSendMessages += ws.data.pending.length;
    }
    return {
      tick: game.tick, tickWork: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: maxTickWork, samples: sorted.length },
      loopDelay: { p95: delays[Math.min(delays.length - 1, Math.floor(delays.length * .95))] ?? 0,
        p99: delays[Math.min(delays.length - 1, Math.floor(delays.length * .99))] ?? 0, max: maxLoopDelay, samples: delays.length },
      pendingInput, lateTicks, abandonedMs, droppedInputs: game.droppedInputs, rss: memory.rss,
      heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, external: memory.external, arrayBuffers: memory.arrayBuffers ?? null,
      projectiles: game.projectiles.size, worldEdits: game.world.editCount,
      bufferedBytes, maxBufferedBytes, initialConnections, initialDeltaEdits,
      transportSockets: sockets.size, pendingSendBytes, pendingSendMessages,
      network: { ...network, sentBytesByType: { ...network.sentBytesByType } }, admission: admission.stats(),
    };
  };
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? '0.0.0.0',
    port: options.port ?? 3000,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      const isStatus = url.pathname === '/health' || url.pathname === '/api/status';
      const origin = request.headers.get('origin');
      if ((isStatus || url.pathname === '/ws') && origin !== null) {
        try {
          const parsed = parseOrigin(origin);
          if (parsed !== origin || (!allowedOrigins.has(parsed) && new URL(parsed).host !== url.host)) throw new Error('Origin denied');
        } catch { return new Response('Origin denied', { status: 403, headers: { Vary: 'Origin' } }); }
      }
      if (isStatus) {
        const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
        if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
        return Response.json({
          ok: true, protocolVersion: PROTOCOL_VERSION, mode: game.options.mode, maxPlayers: game.options.maxPlayers, players: game.players.size,
          world: game.options.world, roundId: game.roundId, roundSeconds: game.options.roundSeconds, ...metrics(),
        }, { headers });
      }
      if (url.pathname === '/ws') {
        if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('WebSocket upgrade required', { status: 426 });
        }
        const peer = server.requestIP(request)?.address;
        const address = peer ? clientAddress(peer, request.headers.get('x-forwarded-for'), options.trustProxy) : null;
        if (!address) return new Response('Invalid peer address', { status: 400 });
        const release = admission.tryAcquire(address);
        if (!release) return new Response('Connection limit reached', { status: 429, headers: { 'Retry-After': '5' } });
        try {
          if (server.upgrade(request, { data: { connection: null, release, pending: [], pendingBytes: 0 } })) return;
        } catch { release(); return new Response('WebSocket upgrade failed', { status: 400 }); }
        release();
        return new Response('WebSocket upgrade required', { status: 426 });
      }
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
      if (pathname.includes('\0') || pathname.includes('\\')) return new Response('Invalid path', { status: 400 });
      const path = resolve(clientRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(clientRoot + sep)) return new Response('Forbidden', { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response('Not found. Run bun run build first.', { status: 404 });
      const headers = {
        'Content-Type': path.endsWith('.html') ? 'text/html; charset=utf-8' : file.type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      };
      return new Response(request.method === 'HEAD' ? null : file, { headers });
    },
    websocket: {
      maxPayloadLength: 8192,
      backpressureLimit: 512 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 30,
      perMessageDeflate: false,
      open(ws: ServerWebSocket<SocketData>) {
        sockets.add(ws);
        ws.data.connection = game.connect({
          send: data => {
            if (!batching) return sendNow(ws, data);
            const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
            if (ws.data.pending.length >= 1024 || ws.data.pendingBytes + ws.getBufferedAmount() + bytes > 512 * 1024) return 0;
            ws.data.pending.push(data); ws.data.pendingBytes += bytes;
            return bytes;
          },
          close: (code, reason) => { flush(ws); ws.close(code, reason); },
          bufferedAmount: () => ws.getBufferedAmount() + ws.data.pendingBytes,
        });
      },
      message(ws: ServerWebSocket<SocketData>, message) {
        if (!ws.data.connection) return;
        network.receivedMessages++;
        network.receivedBytes += typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
        if (typeof message !== 'string') {
          game.disconnect(ws.data.connection);
          ws.close(1003, 'JSON text required');
          return;
        }
        const started = performance.now();
        game.receive(ws.data.connection, message);
        const elapsed = performance.now() - started;
        network.receiveWorkMs += elapsed; network.maxReceiveWorkMs = Math.max(network.maxReceiveWorkMs, elapsed);
      },
      close(ws: ServerWebSocket<SocketData>) {
        sockets.delete(ws);
        ws.data.pending = []; ws.data.pendingBytes = 0;
        if (ws.data.connection) game.disconnect(ws.data.connection);
        ws.data.release();
      },
    },
  });
  let accumulator = 0;
  let previous = now();
  const timer = options.autoTick === false ? null : setInterval(() => {
    const time = now();
    const delay = Math.max(0, time - previous);
    previous = Math.max(previous, time);
    const late = Math.max(0, delay - 4);
    loopDelay.push(late);
    if (loopDelay.length > 1024) loopDelay.shift();
    maxLoopDelay = Math.max(maxLoopDelay, late);
    accumulator += delay;
    let count = 0;
    while (accumulator >= DT * 1000 && count++ < 4) {
      const started = performance.now();
      batching = true;
      try { game.step(); }
      finally {
        batching = false;
        // Flush once per recipient so native writes coalesce without sharing backpressure decisions.
        for (const ws of sockets) flush(ws);
      }
      const elapsed = performance.now() - started;
      tickWork.push(elapsed);
      if (tickWork.length > 1024) tickWork.shift();
      maxTickWork = Math.max(maxTickWork, elapsed);
      accumulator -= DT * 1000;
    }
    if (accumulator >= DT * 1000) {
      const abandoned = Math.floor(accumulator / (DT * 1000));
      lateTicks += abandoned;
      abandonedMs += abandoned * DT * 1000;
      accumulator %= DT * 1000;
    }
  }, 4);
  return {
    server,
    game,
    stop() {
      if (timer) clearInterval(timer);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  try {
    const running = startServer(readConfig());
    console.log(`UBERCUBE ${running.game.options.mode.toUpperCase()} — http://localhost:${running.server.port} (${running.game.options.maxPlayers} places, bind ${running.server.hostname})`);
    if (running.game.options.roundSeconds === 0) console.log('Automatic round reset disabled: ROUND_SECONDS=0 (product rule pending).');
    process.on('SIGINT', () => { running.stop(); process.exit(0); });
    process.on('SIGTERM', () => { running.stop(); process.exit(0); });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
