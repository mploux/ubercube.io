import { mkdir } from 'node:fs/promises';
import { DT, KITS, PROTOCOL_VERSION, type InputFrame, type Kit, type PlayerState } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';

const args = Object.fromEntries(process.argv.slice(2).map(argument => argument.replace(/^--/, '').split('=')));
const url = args.url ?? 'ws://127.0.0.1:3000/ws';
const count = Math.min(1000, Math.max(1, Number(args.players ?? 100)));
const seconds = Math.min(3600, Math.max(5, Number(args.seconds ?? 30)));
if (!Number.isFinite(count) || !Number.isFinite(seconds)) throw new Error('players et seconds doivent être des nombres');
const bots: {
  socket: WebSocket; id: number; roundId: number; seq: number; state?: PlayerState; ready: boolean;
  lastSpawn: number; kit: Kit; index: number; lastInputAt: number; accumulator: number;
  activeSeconds: number; inputs: number;
}[] = [];
let bytesReceived = 0;
let snapshots = 0;
let worldEdits = 0;
let deaths = 0;
let shots = 0;
let inputs = 0;
let inputMessages = 0;
let inputBytes = 0;
let cappedClientMilliseconds = 0;
let maxFramesPerMessage = 0;
let stopping = false;
const errors: Record<string, number> = {};
const startedAt = performance.now();
type ServerStatus = { pendingInput: number; lateTicks: number; droppedInputs: number; [key: string]: unknown };
const statusUrl = new URL('/api/status', url.replace(/^ws/, 'http'));
const readStatus = async (): Promise<ServerStatus | null> => {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() as ServerStatus : null;
  } catch { return null; }
};
const serverBefore = await readStatus();

for (let index = 0; index < count; index++) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const bot = {
    socket, id: 0, roundId: 0, seq: 0, ready: false, lastSpawn: 0,
    kit: (index % 4 === 0 ? 'sniper' : 'assault') as Kit, index, state: undefined as PlayerState | undefined,
    lastInputAt: 0, accumulator: 0, activeSeconds: 0, inputs: 0,
  };
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
      const state = message.players.find(player => player.id === bot.id);
      if (state?.alive !== bot.state?.alive) { bot.accumulator = 0; bot.lastInputAt = performance.now(); }
      bot.state = state;
    } else if (message.type === 'reset') {
      bot.roundId = message.roundId; bot.seq = 0; bot.ready = false; bot.state = undefined;
      bot.accumulator = 0; bot.lastInputAt = performance.now();
    } else if (message.type === 'event') {
      if (message.event === 'death') deaths++;
      if (message.event === 'shot') shots++;
    } else if (message.type === 'error') errors[message.message] = (errors[message.message] ?? 0) + 1;
  };
  socket.onerror = () => { errors.socket = (errors.socket ?? 0) + 1; };
  socket.onclose = () => { if (!stopping) errors.closed = (errors.closed ?? 0) + 1; };
  await Bun.sleep(5);
}

const measurementStartedAt = performance.now();
const receivedBeforeMeasurement = bytesReceived;
for (const bot of bots) bot.lastInputAt = measurementStartedAt;
const timer = setInterval(() => {
  const now = performance.now();
  for (const bot of bots) {
    const elapsed = now - bot.lastInputAt;
    bot.lastInputAt = now;
    if (!bot.ready || bot.socket.readyState !== WebSocket.OPEN) { bot.accumulator = 0; continue; }
    if (!bot.state?.alive) {
      bot.accumulator = 0;
      if (now - bot.lastSpawn > 1000) {
        bot.socket.send(JSON.stringify({ type: 'spawn', roundId: bot.roundId, kit: bot.kit }));
        bot.lastSpawn = now;
      }
      continue;
    }
    bot.activeSeconds += elapsed / 1000;
    cappedClientMilliseconds += Math.max(0, elapsed - 100);
    bot.accumulator += Math.min(elapsed, 100) / 1000;
    const frames: InputFrame[] = [];
    while (bot.accumulator >= DT) {
      bot.accumulator -= DT;
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
    if (!frames.length) continue;
    inputs += frames.length;
    inputMessages++;
    bot.inputs += frames.length;
    maxFramesPerMessage = Math.max(maxFramesPerMessage, frames.length);
    const message = JSON.stringify({ type: 'input', frames });
    inputBytes += message.length;
    bot.socket.send(message);
  }
}, 1);
const samples: { seconds: number; alive: number; pendingInput: number | null; lateTicks: number | null; droppedInputs: number | null }[] = [];
let sampling = false;
const samplingTimer = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  const status = await readStatus();
  samples.push({ seconds: (performance.now() - measurementStartedAt) / 1000,
    alive: bots.filter(bot => bot.state?.alive).length,
    pendingInput: status?.pendingInput ?? null, lateTicks: status?.lateTicks ?? null, droppedInputs: status?.droppedInputs ?? null });
  sampling = false;
}, 1000);
console.log(`Charge : ${count} clients actifs, ${seconds}s, ${url}`);
await Bun.sleep(seconds * 1000);
clearInterval(timer);
clearInterval(samplingTimer);
const measuredSeconds = (performance.now() - measurementStartedAt) / 1000;
const measuredReceivedBytes = bytesReceived - receivedBeforeMeasurement;
const connected = bots.filter(bot => bot.id && bot.socket.readyState === WebSocket.OPEN).length;
const alive = bots.filter(bot => bot.state?.alive).length;
const status = await readStatus();
const activePlayerSeconds = bots.reduce((sum, bot) => sum + bot.activeSeconds, 0);
const report = {
  date: new Date().toISOString(), url, requested: count, connected, alive,
  elapsedSeconds: (performance.now() - startedAt) / 1000,
  measuredSeconds, activeClients: bots.filter(bot => bot.inputs > 0).length,
  peakAlive: Math.max(alive, ...samples.map(sample => sample.alive)),
  activePlayerSeconds, framesPerActivePlayerSecond: inputs / activePlayerSeconds,
  inputMessages, inputMessagesPerSecond: inputMessages / measuredSeconds,
  inputMessagesPerActivePlayerSecond: inputMessages / activePlayerSeconds,
  framesPerSecond: inputs / measuredSeconds, maxFramesPerMessage, cappedClientMilliseconds,
  inputMbitPerSecond: inputBytes * 8 / measuredSeconds / 1e6,
  receivedMbitPerSecond: measuredReceivedBytes * 8 / measuredSeconds / 1e6,
  maxSampledPendingInput: Math.max(0, ...samples.map(sample => sample.pendingInput ?? 0)),
  droppedInputsDuringRun: status && serverBefore ? status.droppedInputs - serverBefore.droppedInputs : null,
  lateTicksDuringRun: status && serverBefore ? status.lateTicks - serverBefore.lateTicks : null,
  inputs, snapshots, receivedBytes: bytesReceived, worldEditDeliveries: worldEdits,
  shotEventDeliveries: shots, deathEventDeliveries: deaths, errors, server: status, serverBefore, samples,
  limitation: 'Les intentions sont générées à 60 Hz selon le temps écoulé et envoyées aussitôt, sans lot imposé. Comme le client, les pauses de plus de 100 ms sont plafonnées et le temps mort est exclu ; la cadence active et le temps plafonné sont mesurés. Les timers Windows peuvent regrouper plusieurs frames par callback. Générateur et serveur peuvent partager la même machine ; ce test ne mesure ni le rendu de 100 navigateurs ni Internet. Le débit reçu cumule les 100 connexions ; les files sont échantillonnées chaque seconde.',
};
await mkdir('.runtime', { recursive: true });
await Bun.write(args.output ?? '.runtime/loadtest-latest.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
stopping = true;
for (const bot of bots) bot.socket.close();
if (connected !== count || inputs === 0 || snapshots === 0 || errors.socket || errors.closed) process.exitCode = 1;
