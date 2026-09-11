import { expect, test } from 'bun:test';
import { SoloConnection } from '../src/client/solo-connection';
import type { SoloWorkerRequest, SoloWorkerResponse } from '../src/client/solo.worker';
import { PROTOCOL_VERSION, type ClientMessage, type InputFrame, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';

function soloWorker() {
  const worker = new Worker(new URL('../src/client/solo.worker.ts', import.meta.url).href, { type: 'module' });
  const messages: ServerMessage[] = [];
  let ready = false;
  let closed = false;
  let failure: string | undefined;
  worker.onmessage = ({ data }: MessageEvent<SoloWorkerResponse>) => {
    if (data.type === 'ready') ready = true;
    else if (data.type === 'close') closed = true;
    else messages.push(decodeServerMessage(data.data));
  };
  worker.onerror = event => { failure = event.message; };
  const send = (message: ClientMessage) => worker.postMessage({ type: 'message', data: JSON.stringify(message) } satisfies SoloWorkerRequest);
  const wait = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (failure || closed) throw new Error(failure ?? 'Solo worker closed unexpectedly');
      if (performance.now() > deadline) throw new Error('Solo worker response timed out');
      await Bun.sleep(5);
    }
  };
  return { worker, messages, send, wait, ready: () => ready,
    snapshot: () => messages.slice().reverse().find(message => message.type === 'snapshot') as Extract<ServerMessage, { type: 'snapshot' }> | undefined };
}

test('the solo worker uses the real lobby, movement, bullets and terrain destruction with a fresh world per session', async () => {
  const solo = soloWorker();
  let inputTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await solo.wait(solo.ready);
    solo.send({ type: 'hello', version: PROTOCOL_VERSION, name: 'Solo test' });
    await solo.wait(() => solo.messages.some(message => message.type === 'world' && !!message.complete));
    const welcome = solo.messages.find(message => message.type === 'welcome');
    expect(welcome).toMatchObject({ mode: 'ffa', maxPlayers: 1, roundId: 1, world: { seed: 12345, size: 256, height: 64 } });
    await solo.wait(() => !!solo.snapshot());
    expect(solo.snapshot()!.players).toHaveLength(1);
    expect(solo.snapshot()!.players[0]).toMatchObject({ alive: false, team: 0, name: 'Solo test' });
    solo.send({ type: 'spawn', roundId: 1, kit: 'assault' });
    await solo.wait(() => !!solo.snapshot()?.players[0].alive);
    const start = { ...solo.snapshot()!.players[0].position };
    let seq = 0;
    const frame = (overrides: Partial<InputFrame> = {}): InputFrame => ({
      seq: ++seq, roundId: 1, moveX: 0, moveZ: 0, yaw: 0, pitch: -1.35,
      jump: false, sprint: false, fire: false, alt: false, weapon: 'ak47', ...overrides,
    });
    solo.send({ type: 'input', frames: [frame({ moveX: 1 })] });
    await solo.wait(() => Math.abs((solo.snapshot()?.players[0].position.x ?? start.x) - start.x) > .1);
    inputTimer = setInterval(() => solo.send({ type: 'input', frames: [frame({ fire: true })] }), 30);
    await solo.wait(() => solo.messages.some(message => message.type === 'world' && !message.initial && message.edits.some(edit => edit[3] === 0)));
    expect(solo.messages.some(message => message.type === 'event' && message.event === 'shot' && message.weapon === 'ak47')).toBe(true);
    expect(solo.messages.some(message => message.type === 'event' && message.event === 'impact')).toBe(true);
    expect(solo.messages.filter(message => message.type === 'error')).toHaveLength(0);
  } finally {
    clearInterval(inputTimer);
    solo.worker.terminate();
  }
  const fresh = soloWorker();
  try {
    await fresh.wait(fresh.ready);
    fresh.send({ type: 'hello', version: PROTOCOL_VERSION, name: 'Fresh solo' });
    await fresh.wait(() => fresh.messages.some(message => message.type === 'world' && !!message.complete));
    expect(fresh.messages.filter(message => message.type === 'world')).toEqual([
      { type: 'world', roundId: 1, revision: 0, edits: [], initial: true, complete: true },
    ]);
  } finally { fresh.worker.terminate(); }
}, 15000);

test('hiding the solo tab freezes server ticks and resumes without replaying paused time', async () => {
  const solo = soloWorker();
  try {
    await solo.wait(solo.ready);
    solo.send({ type: 'hello', version: PROTOCOL_VERSION, name: 'Pause test' });
    await solo.wait(() => !!solo.snapshot());
    solo.worker.postMessage({ type: 'pause', paused: true } satisfies SoloWorkerRequest);
    solo.send({ type: 'ping', time: 123 });
    await solo.wait(() => solo.messages.some(message => message.type === 'pong' && message.time === 123));
    const tick = solo.snapshot()!.tick;
    await Bun.sleep(300);
    expect(solo.snapshot()!.tick).toBe(tick);
    solo.worker.postMessage({ type: 'pause', paused: false } satisfies SoloWorkerRequest);
    await solo.wait(() => solo.snapshot()!.tick > tick);
    expect(solo.snapshot()!.tick - tick).toBeLessThanOrEqual(6);
    expect(solo.messages.filter(message => message.type === 'error')).toHaveLength(0);
  } finally { solo.worker.terminate(); }
});

test('solo connection opens only after worker readiness, forwards wire data and cleans up visibility and late callbacks', async () => {
  const NativeWorker = globalThis.Worker;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class TestWorker {
    onmessage: ((event: { data: SoloWorkerResponse }) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessageerror: ((event: Event) => void) | null = null;
    messages: SoloWorkerRequest[] = [];
    terminated = false;
    postMessage(data: SoloWorkerRequest) { this.messages.push(data); }
    terminate() { this.terminated = true; }
  }
  const worker = new TestWorker();
  const page = Object.assign(new EventTarget(), { hidden: false });
  globalThis.Worker = class { constructor() { return worker; } } as unknown as typeof Worker;
  Object.defineProperty(globalThis, 'document', { value: page, configurable: true });
  try {
    const connection = new SoloConnection();
    let opens = 0, closes = 0, errors = 0;
    const received: (string | ArrayBuffer)[] = [];
    connection.onopen = () => opens++;
    connection.onclose = () => closes++;
    connection.onerror = () => errors++;
    connection.onmessage = event => received.push(event.data);
    expect(connection.readyState).toBe(0);
    expect(() => connection.send('early')).toThrow();
    expect(opens).toBe(0);
    worker.onmessage!({ data: { type: 'ready' } });
    worker.onmessage!({ data: { type: 'ready' } });
    expect(opens).toBe(1);
    expect(connection.readyState).toBe(1);
    connection.send('hello');
    expect(worker.messages.at(-1)).toEqual({ type: 'message', data: 'hello' });
    const binary = new ArrayBuffer(8);
    worker.onmessage!({ data: { type: 'message', data: binary } });
    expect(received).toEqual([binary]);
    page.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: true });
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(worker.messages.at(-1)).toEqual({ type: 'pause', paused: false });
    const lateMessage = worker.onmessage!;
    const lateError = worker.onerror!;
    const error = new Event('error', { cancelable: true });
    worker.onerror!(error);
    expect(error.defaultPrevented).toBe(true);
    expect(errors).toBe(1);
    expect(connection.readyState).toBe(3);
    expect(worker.terminated).toBe(true);
    const sent = worker.messages.length;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(worker.messages).toHaveLength(sent);
    lateMessage({ data: { type: 'message', data: 'late' } });
    lateError(new Event('error'));
    connection.close();
    await Promise.resolve();
    expect(closes).toBe(1);
    expect(errors).toBe(1);
    expect(received).toEqual([binary]);
    expect(() => connection.send('closed')).toThrow();
  } finally {
    globalThis.Worker = NativeWorker;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
