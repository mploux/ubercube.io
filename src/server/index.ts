import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerWebSocket } from 'bun';
import { DT } from '../shared/protocol.ts';
import { GameServer } from './game.ts';
import type { Connection, GameOptions } from './game.ts';

export interface StartOptions extends Partial<GameOptions> {
  port?: number;
  hostname?: string;
  autoTick?: boolean;
  clientRoot?: string;
  allowedOrigins?: string[];
}
interface SocketData { connection: Connection | null }

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
    const match = /^--(mode|port|max-players|seed|size|height|round-seconds|hostname)=(.+)$/.exec(arg);
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
  return {
    mode,
    port: integer('port', 'PORT', 3000, 1, 65535),
    hostname: value('hostname', 'HOST', '0.0.0.0'),
    allowedOrigins: env.ALLOWED_ORIGINS?.trim() ? env.ALLOWED_ORIGINS.split(',').map(origin => parseOrigin(origin.trim())) : [],
    maxPlayers: integer('max-players', 'MAX_PLAYERS', 100, 1, 1000),
    roundSeconds: integer('round-seconds', 'ROUND_SECONDS', 0, 0, 86400),
    world: {
      seed: integer('seed', 'WORLD_SEED', 12345, 0, 0xffffffff),
      size: integer('size', 'WORLD_SIZE', 256, 64, 2048),
      height: integer('height', 'WORLD_HEIGHT', 64, 32, 256),
    },
  };
}

export function startServer(options: StartOptions = {}) {
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(parseOrigin));
  const game = new GameServer(options, data => { server.publish('game', data); });
  const clientRoot = resolve(options.clientRoot ?? fileURLToPath(new URL('../../dist/client', import.meta.url)));
  const tickWork: number[] = [];
  let maxTickWork = 0;
  let lateTicks = 0;
  const metrics = () => {
    const sorted = [...tickWork].sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0;
    let pendingInput = 0;
    for (const connection of game.connections) pendingInput += connection.queue.length;
    return {
      tick: game.tick, tickWork: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: maxTickWork, samples: sorted.length },
      pendingInput, lateTicks, droppedInputs: game.droppedInputs, rss: process.memoryUsage().rss,
      projectiles: game.projectiles.size,
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
          ok: true, mode: game.options.mode, maxPlayers: game.options.maxPlayers, players: game.players.size,
          world: game.options.world, roundId: game.roundId, roundSeconds: game.options.roundSeconds, ...metrics(),
        }, { headers });
      }
      if (url.pathname === '/ws') {
        if (request.method === 'GET' && server.upgrade(request, { data: { connection: null } })) return;
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
        ws.data.connection = game.connect({
          send: data => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          bufferedAmount: () => ws.getBufferedAmount(),
          setBroadcast: enabled => { if (enabled) ws.subscribe('game'); else ws.unsubscribe('game'); },
        });
      },
      message(ws: ServerWebSocket<SocketData>, message) {
        if (!ws.data.connection) return;
        if (typeof message !== 'string') {
          game.disconnect(ws.data.connection);
          ws.close(1003, 'JSON text required');
          return;
        }
        game.receive(ws.data.connection, message);
      },
      close(ws: ServerWebSocket<SocketData>) {
        if (ws.data.connection) game.disconnect(ws.data.connection);
      },
    },
  });
  let accumulator = 0;
  let previous = performance.now();
  const timer = options.autoTick === false ? null : setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(now - previous, 250);
    previous = now;
    let count = 0;
    while (accumulator >= DT * 1000 && count++ < 4) {
      const started = performance.now();
      game.step();
      const elapsed = performance.now() - started;
      tickWork.push(elapsed);
      if (tickWork.length > 1024) tickWork.shift();
      maxTickWork = Math.max(maxTickWork, elapsed);
      accumulator -= DT * 1000;
    }
    if (accumulator >= DT * 1000) {
      lateTicks += Math.floor(accumulator / (DT * 1000));
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
