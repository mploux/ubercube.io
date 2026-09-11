import type { SoloWorkerRequest, SoloWorkerResponse } from './solo.worker';

export class SoloConnection {
  readyState = 0;
  readonly bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly worker: Worker;
  private readonly visibility = () => {
    if (this.readyState !== 3) this.worker.postMessage({ type: 'pause', paused: document.hidden } satisfies SoloWorkerRequest);
  };

  constructor() {
    this.worker = new Worker('/solo.worker.js', { type: 'module' });
    this.worker.onmessage = ({ data }: MessageEvent<SoloWorkerResponse>) => {
      if (this.readyState === 3) return;
      if (data.type === 'ready' && this.readyState === 0) { this.readyState = 1; this.onopen?.(); }
      else if (data.type === 'message' && this.readyState === 1) this.onmessage?.({ data: data.data });
      else if (data.type === 'close') this.close();
    };
    const fail = (event: Event) => {
      if (this.readyState === 3) return;
      event.preventDefault();
      try { this.onerror?.(); } finally { this.close(); }
    };
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
    document.addEventListener('visibilitychange', this.visibility);
    this.visibility();
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('Solo connection is not open');
    this.worker.postMessage({ type: 'message', data } satisfies SoloWorkerRequest);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    document.removeEventListener('visibilitychange', this.visibility);
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    queueMicrotask(() => this.onclose?.());
  }
}
