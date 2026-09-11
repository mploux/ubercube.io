import { mkdir } from 'node:fs/promises';
import { KITS, PROTOCOL_VERSION, type InputFrame, type Kit, type PlayerState, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';

const args = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/, '').split('=')));
const url = args.url ?? 'ws://127.0.0.1:3000/ws';
const count = Math.min(1000, Math.max(1, Number(args.players ?? 100)));
const seconds = Math.min(3600, Math.max(5, Number(args.seconds ?? 30)));
if (!Number.isFinite(count) || !Number.isFinite(seconds)) throw new Error('players et seconds doivent être des nombres');
const bots: { socket: WebSocket; id: number; roundId: number; seq: number; state?: PlayerState; ready: boolean; lastSpawn: number; kit: Kit; index: number }[] = [];
let bytesReceived = 0;
let snapshots = 0;
let worldEdits = 0;
let deaths = 0;
let shots = 0;
let inputs = 0;
let stopping = false;
const errors: Record<string, number> = {};
const startedAt = performance.now();

for (let index = 0; index < count; index++) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const bot = { socket, id: 0, roundId: 0, seq: 0, ready: false, lastSpawn: 0, kit: (index % 4 === 0 ? 'sniper' : 'assault') as Kit, index, state: undefined as PlayerState | undefined };
  bots.push(bot);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: `Load-${index + 1}` }));
  socket.onmessage = event => {
    bytesReceived += typeof event.data === 'string' ? event.data.length : event.data.byteLength;
    const message = decodeServerMessage(event.data);
    if (message.type === 'welcome') { bot.id = message.id; bot.roundId = message.roundId; }
    else if (message.type === 'world') {
      worldEdits += message.edits.length;
      if (message.complete) bot.ready = true;
    } else if (message.type === 'snapshot') {
      snapshots++;
      bot.state = message.players.find(player => player.id === bot.id);
    } else if (message.type === 'reset') {
      bot.roundId = message.roundId; bot.seq = 0; bot.ready = false; bot.state = undefined;
    } else if (message.type === 'event') {
      if (message.event === 'death') deaths++;
      if (message.event === 'shot') shots++;
    } else if (message.type === 'error') errors[message.message] = (errors[message.message] ?? 0) + 1;
  };
  socket.onerror = () => { errors.socket = (errors.socket ?? 0) + 1; };
  socket.onclose = () => { if (!stopping) errors.closed = (errors.closed ?? 0) + 1; };
  await Bun.sleep(5);
}

const timer = setInterval(() => {
  const now = performance.now();
  for (const bot of bots) {
    if (!bot.ready || bot.socket.readyState !== WebSocket.OPEN) continue;
    if (!bot.state?.alive) {
      if (now - bot.lastSpawn > 1000) {
        bot.socket.send(JSON.stringify({ type: 'spawn', roundId: bot.roundId, kit: bot.kit }));
        bot.lastSpawn = now;
      }
      continue;
    }
    const frames: InputFrame[] = [];
    for (let step = 0; step < 3; step++) {
      const seq = ++bot.seq;
      const phase = Math.floor(seq / 180) % 5;
      const weapon = phase === 3 ? 'shovel' : phase === 4 ? 'grenade' : KITS[bot.kit][0];
      frames.push({
        roundId: bot.roundId, seq,
        moveX: Math.sin(seq / 120 + bot.index) > 0 ? 0.5 : -0.5,
        moveZ: 1,
        yaw: (bot.index % 2 ? Math.PI : 0) + Math.sin(seq / 240) * 0.8,
        pitch: phase === 3 ? -0.8 : -0.12,
        jump: seq % 100 === 0, sprint: true,
        fire: phase === 3 ? seq % 30 < 15 : phase === 4 ? seq % 90 < 60 : true,
        alt: phase === 3 && seq % 90 > 70,
        weapon,
      });
    }
    inputs += frames.length;
    bot.socket.send(JSON.stringify({ type: 'input', frames }));
  }
}, 50);
console.log(`Charge : ${count} clients actifs, ${seconds}s, ${url}`);
await Bun.sleep(seconds * 1000);
clearInterval(timer);
const connected = bots.filter(bot => bot.id && bot.socket.readyState === WebSocket.OPEN).length;
const alive = bots.filter(bot => bot.state?.alive).length;
const statusUrl = new URL('/api/status', url.replace(/^ws/, 'http'));
const status = await fetch(statusUrl).then(response => response.json()).catch(() => null);
const report = {
  date: new Date().toISOString(), url, requested: count, connected, alive,
  elapsedSeconds: (performance.now() - startedAt) / 1000,
  inputs, snapshots, receivedBytes: bytesReceived, worldEditDeliveries: worldEdits,
  shotEventDeliveries: shots, deathEventDeliveries: deaths, errors, server: status,
  limitation: 'Générateur de charge et serveur peuvent partager la même machine. Ce test ne mesure pas le rendu de 100 navigateurs ni les conditions Internet.',
};
await mkdir('.runtime', { recursive: true });
await Bun.write('.runtime/loadtest-latest.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
stopping = true;
for (const bot of bots) bot.socket.close();
if (connected !== count || inputs === 0 || snapshots === 0 || errors.socket || errors.closed) process.exitCode = 1;
