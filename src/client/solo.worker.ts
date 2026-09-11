import { GameServer, type Connection } from '../shared/game';
import { DT } from '../shared/protocol';

export type SoloWorkerRequest = { type: 'message'; data: string } | { type: 'pause'; paused: boolean };
export type SoloWorkerResponse = { type: 'ready' } | { type: 'message'; data: string | ArrayBuffer } | { type: 'close' };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<SoloWorkerRequest>) => void) | null;
  postMessage(message: SoloWorkerResponse, transfer?: ArrayBuffer[]): void;
};
const game = new GameServer({ mode: 'ffa', maxPlayers: 1 });
let connection: Connection | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let paused = false;
let closed = false;
let previous = performance.now();
let accumulator = 0;

connection = game.connect({
  send(data) {
    if (typeof data === 'string') scope.postMessage({ type: 'message', data });
    else {
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      scope.postMessage({ type: 'message', data: buffer }, [buffer]);
    }
    return data.length;
  },
  bufferedAmount: () => 0,
  close() {
    if (closed) return;
    closed = true;
    if (timer !== null) clearInterval(timer);
    if (connection) game.disconnect(connection);
    scope.postMessage({ type: 'close' });
  },
});

function startClock(): void {
  previous = performance.now();
  accumulator = 0;
  timer = setInterval(() => {
    const now = performance.now();
    accumulator = Math.min(accumulator + (now - previous) / 1000, DT * 5);
    previous = now;
    while (accumulator >= DT && !closed) { game.step(); accumulator -= DT; }
  }, DT * 1000);
}

scope.onmessage = ({ data }) => {
  if (closed || !connection) return;
  if (data.type === 'message') game.receive(connection, data.data);
  else if (data.type === 'pause' && data.paused !== paused) {
    paused = data.paused;
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (!paused) startClock();
  }
};
startClock();
scope.postMessage({ type: 'ready' });
