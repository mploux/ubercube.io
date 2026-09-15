import { strict as assert } from 'node:assert';
import { createConnection, createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform, type TransformCallback } from 'node:stream';
import { fileURLToPath } from 'node:url';

const STREAM_BYTES = 64 * 1024;
const DIRECTION_BYTES = 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CONNECTIONS = 256;

export async function startImpairmentProxy(targetPort: number, options: { latencyMs: number; jitterMs: number }) {
  assert(Number.isInteger(targetPort) && targetPort > 0 && targetPort <= 65535, 'Invalid loopback target port');
  assert(Number.isInteger(options.latencyMs) && options.latencyMs >= 0 && options.latencyMs <= 2000,
    'latencyMs must be an integer from 0 to 2000');
  assert(Number.isInteger(options.jitterMs) && options.jitterMs >= 0 && options.jitterMs <= options.latencyMs,
    'jitterMs must be an integer from 0 to latencyMs');
  assert(!process.versions.bun, 'Run this TCP proxy with Node.js; Bun 1.3.11 truncates delayed data on TCP half-close');
  const { latencyMs, jitterMs } = options;
  const connections = new Set<() => void>();
  let queuedBytes = 0, peakQueuedBytes = 0, peakDirectionBytes = 0, overflowClosures = 0, refusedConnections = 0;
  let stopped = false;
  let stopping: Promise<void> | undefined;

  class DelayedStream extends Transform {
    private pending: { bytes: Buffer; due: number }[] = [];
    private bytes = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private blocked = false;
    private pumping = false;
    private complete: TransformCallback | null = null;

    constructor() { super({ highWaterMark: STREAM_BYTES }); }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      if (this.bytes + chunk.length > DIRECTION_BYTES || queuedBytes + chunk.length > TOTAL_BYTES || this.pending.length >= 1024) {
        overflowClosures++;
        callback(new Error('Impairment proxy queue limit reached'));
        return;
      }
      // Deadlines overlap to retain throughput; TCP order prevents later fragments overtaking earlier ones.
      const due = Math.max(this.pending.at(-1)?.due ?? 0, performance.now() + latencyMs + (Math.random() * 2 - 1) * jitterMs);
      this.pending.push({ bytes: chunk, due });
      this.bytes += chunk.length; queuedBytes += chunk.length;
      peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes); peakDirectionBytes = Math.max(peakDirectionBytes, this.bytes);
      callback(); this.pump();
    }

    override _read(size: number): void { this.blocked = false; this.pump(); super._read(size); }
    override _flush(callback: TransformCallback): void { this.complete = callback; this.pump(); }

    private pump(): void {
      if (this.destroyed || this.pumping) return;
      this.pumping = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      while (!this.blocked && this.pending[0] && this.pending[0].due <= performance.now()) {
        const item = this.pending.shift()!;
        this.bytes -= item.bytes.length; queuedBytes -= item.bytes.length;
        this.blocked = !this.push(item.bytes);
      }
      if (!this.blocked && this.pending.length) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, this.pending[0].due - performance.now()));
      }
      this.pumping = false;
      if (!this.pending.length && this.complete) {
        const complete = this.complete; this.complete = null; complete();
      }
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null; this.complete = null;
      queuedBytes -= this.bytes; this.bytes = 0; this.pending = [];
      callback(error);
    }
  }

  const server = createServer({ allowHalfOpen: true }, client => {
    if (stopped || connections.size >= MAX_CONNECTIONS) { refusedConnections++; client.destroy(); return; }
    const upstream = createConnection({ host: '127.0.0.1', port: targetPort, allowHalfOpen: true });
    const outbound = new DelayedStream(), inbound = new DelayedStream();
    const close = () => {
      connections.delete(close);
      client.destroy(); upstream.destroy(); outbound.destroy(); inbound.destroy();
    };
    connections.add(close);
    const closed = (socket: Socket, hadError: boolean) => {
      if (hadError || !socket.readableEnded || !socket.writableFinished || (client.destroyed && upstream.destroyed)) close();
    };
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true); socket.setTimeout(30000, close);
      socket.on('error', close); socket.on('close', hadError => closed(socket, hadError));
    }
    outbound.on('error', close); inbound.on('error', close);
    client.pipe(outbound).pipe(upstream);
    upstream.pipe(inbound).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Local impairment proxy did not receive a port');
  return {
    port: address.port,
    stats: () => ({ connections: connections.size, queuedBytes, peakQueuedBytes, peakDirectionBytes, overflowClosures, refusedConnections }),
    stop() {
      return stopping ??= new Promise<void>((resolve, reject) => {
        stopped = true;
        for (const close of connections) close();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = new Map<string, number>();
    for (const argument of process.argv.slice(2)) {
      const match = /^--(target-port|latency-ms|jitter-ms)=(\d+)$/.exec(argument);
      assert(match && !args.has(match[1]), `Unknown or duplicate argument: ${argument}`);
      args.set(match[1], Number(match[2]));
    }
    assert(args.has('target-port'), '--target-port is required');
    const proxy = await startImpairmentProxy(args.get('target-port')!, {
      latencyMs: args.get('latency-ms') ?? 50, jitterMs: args.get('jitter-ms') ?? 20,
    });
    const control = createInterface({ input: process.stdin });
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      try { await proxy.stop(); console.error(JSON.stringify({ impairmentProxy: proxy.stats() })); }
      catch (error) { console.error(String(error)); process.exitCode = 1; }
      finally {
        control.close(); process.stdin.pause();
        process.off('SIGTERM', stop); process.off('SIGINT', stop);
      }
    };
    control.on('line', line => {
      if (line.trim() !== 'stop') { console.error('Unknown proxy command'); process.exitCode = 1; }
      void stop();
    });
    control.on('close', () => { void stop(); });
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    console.log(JSON.stringify({ port: proxy.port }));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
