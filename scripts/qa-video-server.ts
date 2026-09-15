import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { GameServer, type Connection } from '../src/server/game.ts';
import { DT, PROTOCOL_VERSION, WEAPONS, type GameEvent, type InputFrame, type Kit, type ServerMessage, type Vec3, type VoxelEdit } from '../src/shared/protocol.ts';
import { EYE_HEIGHT } from '../src/shared/movement.ts';
import { packBlock } from '../src/shared/voxel.ts';
import { createWeaponPose, getWeaponMuzzle, stepWeaponPose } from '../src/shared/weapon-pose.ts';
import { createServerMessageDecoder, decodeServerMessage, encodeServerMessage } from '../src/shared/wire.ts';

export const VIDEO_SCENES = ['ak-body', 'ak-head', 'awp-body', 'wall', 'moving'] as const;
type VideoScene = typeof VIDEO_SCENES[number];
interface SocketData { connection: Connection | null }

export async function startQaVideoServer(port = 3014) {
  const output = resolve('.runtime/qa-video');
  const clientRoot = resolve(output, 'client');
  const assets = resolve('public/assets');
  await mkdir(output, { recursive: true });
  let scene: VideoScene | null = null;
  let impulseScale: number | null = null;
  let shooterId: number | null = null;
  let targetId: number | null = null;
  let botSeq = 0;
  let botDirection = 1;
  const events: (GameEvent & { receivedAt: number })[] = [];
  const inputs: { tick: number; playerId: number; frame: InputFrame }[] = [];
  const game = new GameServer({ mode: 'ffa', maxPlayers: 4, world: { seed: 121, size: 64, height: 64 } }, data => {
    let message = decodeServerMessage(data);
    if (impulseScale !== null && message.type === 'event' && message.event === 'death' &&
      message.death && (message.weapon === 'ak47' || message.weapon === 'awp')) {
      const impulse = message.death.impulse;
      const scale = (message.weapon === 'awp' ? 20 : 12) * impulseScale / Math.hypot(impulse.x, impulse.y, impulse.z);
      message = { ...message, death: { ...message.death, impulse: {
        x: impulse.x * scale, y: impulse.y * scale, z: impulse.z * scale,
      } } };
      data = encodeServerMessage(message);
    }
    if (message.type === 'event') {
      events.push({ ...message, receivedAt: performance.now() });
      if (events.length > 2048) events.shift();
    }
    server.publish('game', data);
  });

  // These edits are fixture setup; the real initial-world stream distributes them to both clients.
  for (let x = 8; x < 56; x++) for (let z = 6; z < 60; z++) {
    game.world.set(x, 47, z, packBlock(205 + ((x + z) % 2) * 8, 212, 220));
    for (let y = 48; y < 64; y++) game.world.set(x, y, z, 0);
  }
  for (let x = 8; x < 56; x++) for (let y = 48; y < 52; y++) {
    game.world.set(x, y, 6, packBlock(93, 111, 124));
  }
  for (let x = 8; x < 56; x++) for (const z of [20, 35, 50]) {
    game.world.set(x, 47, z, packBlock(163, 186, 204));
  }

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1', port, maxRequestBodySize: 256 * 1024 * 1024,
    async fetch(request, host) {
      const url = new URL(request.url);
      const origin = request.headers.get('origin');
      if (url.hostname !== '127.0.0.1' || (origin !== null && origin !== url.origin)) {
        return new Response('Local same-origin requests only', { status: 403 });
      }
      if (url.pathname === '/ws') {
        if (request.method === 'GET' && host.upgrade(request, { data: { connection: null } })) return;
        return new Response('WebSocket upgrade required', { status: 426 });
      }
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/status')) {
        return Response.json({ ok: true, mode: game.options.mode, players: game.players.size,
          maxPlayers: game.options.maxPlayers, world: game.options.world, roundId: game.roundId, tick: game.tick });
      }
      if (request.method === 'GET' && url.pathname === '/qa/state') {
        return Response.json({ scene, impulseScale, shooterId, targetId, tick: game.tick, roundId: game.roundId,
          players: [...game.players.values()], projectiles: [...game.projectiles.values()], events, inputs },
        { headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method === 'POST' && url.pathname === '/qa/scene') {
        if (Number(request.headers.get('content-length')) > 2048) return new Response('Too large', { status: 413 });
        let payload: { scene?: unknown; shooterId?: unknown; impulseScale?: unknown };
        try { payload = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        if (!VIDEO_SCENES.includes(payload?.scene as VideoScene) || !Number.isInteger(payload?.shooterId)) {
          return new Response('Invalid scene or shooter', { status: 400 });
        }
        if (payload.impulseScale !== undefined && ![1, 2, 4, 8].includes(payload.impulseScale as number)) {
          return new Response('Invalid impulse scale', { status: 400 });
        }
        const shooter = game.players.get(payload.shooterId as number);
        const target = targetId === null ? undefined : game.players.get(targetId);
        if (!shooter || !target || shooter === target || [...game.connections].some(connection => connection.initial)) {
          return new Response('Both clients must finish joining', { status: 409 });
        }
        scene = payload.scene as VideoScene;
        impulseScale = payload.impulseScale as number | undefined ?? null;
        shooterId = shooter.id;
        const weapon = scene === 'awp-body' ? 'awp' : 'ak47';
        const kit: Kit = weapon === 'awp' ? 'sniper' : 'assault';
        const changes: VoxelEdit[] = [];
        for (let x = 30; x <= 34; x++) for (let y = 48; y < 52; y++) for (let z = 41; z <= 42; z++) {
          const value = scene === 'wall' ? packBlock(117, 103, 88) : 0;
          if (game.world.set(x, y, z, value)) changes.push([x, y, z, value]);
        }
        if (changes.length) {
          const message: ServerMessage = { type: 'world', roundId: game.roundId, revision: ++game.revision, edits: changes };
          server.publish('game', encodeServerMessage(message));
        }
        Object.assign(shooter, { position: { x: 32, y: 48, z: 52 }, velocity: { x: 0, y: 0, z: 0 },
          health: 100, alive: true, grounded: true, yaw: 0, pitch: 0, kit, weapon, ammo: WEAPONS[weapon].magazine,
          aiming: false, kills: 0, deaths: 0, grenades: 10 });
        Object.assign(target, { position: { x: 32, y: 48, z: 35 }, velocity: { x: 0, y: 0, z: 0 },
          health: impulseScale === null ? 100 : 1, alive: true, grounded: true, yaw: Math.PI, pitch: 0,
          kit: 'assault', weapon: 'ak47', ammo: 30, aiming: false, kills: 0, deaths: 0, grenades: 10 });
        for (const connection of game.connections) {
          if (connection.player !== shooter && connection.player !== target) continue;
          connection.queue = []; connection.input = null;
          connection.previousFire = false; connection.previousAlt = false;
          connection.weaponPoses.clear(); connection.weaponMotion = { x: 0, y: 0, z: 0 };
          connection.magazines = { ak47: 30, awp: 5 };
        }
        game.projectiles.clear();
        events.length = 0; inputs.length = 0; botDirection = 1;
        const aimPoint: Vec3 = { ...target.position, y: target.position.y + (scene === 'ak-head' ? 2.55 : 1.45) };
        const pose = createWeaponPose(weapon);
        for (let i = 0; i < 90; i++) stepWeaponPose(pose, { fire: false, alt: true, sprint: false,
          localVelocity: { x: 0, y: 0, z: 0 }, lookDeltaYaw: 0, lookDeltaPitch: 0, grenades: 10 });
        const muzzle = getWeaponMuzzle(pose);
        const dy = aimPoint.y - shooter.position.y - EYE_HEIGHT;
        const distance = shooter.position.z - aimPoint.z;
        const yaw = Math.asin(muzzle.position.x / distance);
        const pitch = Math.atan2(dy, distance) - Math.asin(muzzle.position.y / Math.hypot(dy, distance));
        shooter.yaw = yaw; shooter.pitch = pitch;
        const label = { 'ak-body': 'AK-47 · impacts au torse et chute', 'ak-head': 'AK-47 · impact à la tête',
          'awp-body': 'AWP · impacts au torse', wall: 'Obstacle · cible protégée', moving: 'Cible en déplacement' }[scene];
        game.sendSnapshot();
        return Response.json({ scene, label, kit, weapon, impulseScale,
          impulseMagnitude: (weapon === 'awp' ? 20 : 12) * (impulseScale ?? 4),
          shooterId, targetId, yaw, pitch, aiming: true,
          targetPosition: target.position, aimPoint, tick: game.tick, distance });
      }
      if (request.method === 'POST' && (url.pathname === '/qa/video' || url.pathname === '/qa/report')) {
        const review = url.searchParams.get('review');
        if (review !== null && review !== 'impulse') return new Response('Invalid review', { status: 400 });
        const prefix = review === 'impulse' ? 'impulse-' : '';
        if (url.pathname === '/qa/video') {
          const contentType = request.headers.get('content-type') ?? '';
          if (!contentType.startsWith('video/webm')) return new Response('WebM required', { status: 415 });
          const bytes = await request.arrayBuffer();
          if (bytes.byteLength < 4 || new DataView(bytes).getUint32(0) !== 0x1a45dfa3) return new Response('Invalid WebM', { status: 400 });
          await Bun.write(resolve(output, `${prefix}review.webm`), bytes);
          return Response.json({ ok: true, file: `${prefix}review.webm`, bytes: bytes.byteLength });
        }
        if (Number(request.headers.get('content-length')) > 2 * 1024 * 1024) return new Response('Too large', { status: 413 });
        let report: unknown;
        try { report = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        await Bun.write(resolve(output, `${prefix}report.json`), JSON.stringify(report, null, 2) + '\n');
        return Response.json({ ok: true, file: `${prefix}report.json` });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
      if (pathname.includes('\\') || pathname.includes('\0')) return new Response('Invalid path', { status: 400 });
      const asset = pathname.startsWith('/assets/');
      const root = asset ? assets : clientRoot;
      const path = resolve(root, asset ? pathname.slice('/assets/'.length) : `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
      const file = Bun.file(path);
      if (!(await file.exists())) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : file, { headers: { 'Content-Type': file.type,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    },
    websocket: {
      maxPayloadLength: 8192, backpressureLimit: 512 * 1024, closeOnBackpressureLimit: true,
      idleTimeout: 30, perMessageDeflate: false,
      open(ws: ServerWebSocket<SocketData>) {
        ws.data.connection = game.connect({ send: data => ws.send(data), close: (code, reason) => ws.close(code, reason),
          bufferedAmount: () => ws.getBufferedAmount(),
          setBroadcast: enabled => { if (enabled) ws.subscribe('game'); else ws.unsubscribe('game'); } });
      },
      message(ws: ServerWebSocket<SocketData>, data) {
        const connection = ws.data.connection;
        if (!connection) return;
        if (typeof data !== 'string') { game.disconnect(connection); ws.close(1003, 'JSON text required'); return; }
        game.receive(connection, data);
        if (connection.player?.id === shooterId && !connection.closed) {
          const frame = connection.queue.at(-1);
          if (frame?.fire || frame?.weapon === 'grenade') {
            inputs.push({ tick: game.tick, playerId: connection.player.id, frame: { ...frame } });
            if (inputs.length > 4096) inputs.shift();
          }
        }
      },
      close(ws: ServerWebSocket<SocketData>) { if (ws.data.connection) game.disconnect(ws.data.connection); },
    },
  });
  const bot = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const decodeBot = createServerMessageDecoder();
  bot.binaryType = 'arraybuffer';
  bot.addEventListener('open', () => bot.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Cible QA' })));
  bot.addEventListener('message', message => {
    const data = decodeBot(message.data);
    if (data.type === 'welcome') targetId = data.id;
    if (data.type === 'world' && data.complete) bot.send(JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
  });
  let accumulator = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(now - previous, 250); previous = now;
    let count = 0;
    while (accumulator >= DT * 1000 && count++ < 4) {
      if (bot.readyState === WebSocket.OPEN && targetId !== null) {
        const target = game.players.get(targetId);
        if (target?.alive) {
          if (target.position.x > 36) botDirection = -1;
          else if (target.position.x < 28) botDirection = 1;
          const frame: InputFrame = { seq: ++botSeq, roundId: game.roundId, moveX: scene === 'moving' && impulseScale === null ? -botDirection : 0,
            moveZ: 0, yaw: Math.PI, pitch: 0, jump: false, sprint: false, fire: false, alt: false, weapon: 'ak47' };
          bot.send(JSON.stringify({ type: 'input', frames: [frame] }));
        } else if (game.tick % 60 === 0) bot.send(JSON.stringify({ type: 'ping', time: Date.now() }));
      }
      game.step(); accumulator -= DT * 1000;
    }
    if (accumulator >= DT * 1000) accumulator %= DT * 1000;
  }, 4);
  return { server, game, stop() { clearInterval(timer); bot.close(); server.stop(true); } };
}

if (import.meta.main) {
  const running = await startQaVideoServer();
  console.log(`Vidéo QA locale : http://127.0.0.1:${running.server.port}/`);
  process.on('SIGINT', () => { running.stop(); process.exit(0); });
  process.on('SIGTERM', () => { running.stop(); process.exit(0); });
}
