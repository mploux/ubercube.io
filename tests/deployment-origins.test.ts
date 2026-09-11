import { afterEach, describe, expect, test } from 'bun:test';
import { readConfig, startServer } from '../src/server/index.ts';

const running: ReturnType<typeof startServer>[] = [];
afterEach(() => { for (const instance of running.splice(0)) instance.stop(); });

function start(allowedOrigins: string[] = []) {
  const instance = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false, allowedOrigins,
    world: { seed: 1, size: 64, height: 32 } });
  running.push(instance);
  return { instance, base: `http://127.0.0.1:${instance.server.port}` };
}

function connects(base: string, origin?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // The shared DOM typings omit Bun's constructor overload for request headers.
    const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const socket = new BunWebSocket(`${base.replace('http:', 'ws:')}/ws`, { headers: origin === undefined ? {} : { Origin: origin } });
    let opened = false;
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket origin check timed out')); }, 2000);
    socket.onopen = () => { opened = true; socket.close(); };
    socket.onerror = () => {};
    socket.onclose = () => { clearTimeout(timer); resolve(opened); };
  });
}

describe('deployment origin configuration', () => {
  test('defaults to no external origins and normalizes explicit comma-separated origins', () => {
    expect(readConfig([], {}).allowedOrigins).toEqual([]);
    expect(readConfig([], { ALLOWED_ORIGINS: '  ' }).allowedOrigins).toEqual([]);
    expect(readConfig([], { ALLOWED_ORIGINS: ' https://UBERCUBE.IO:443/, https://ubercube.vercel.app, http://localhost:3000 ' }).allowedOrigins)
      .toEqual(['https://ubercube.io', 'https://ubercube.vercel.app', 'http://localhost:3000']);
  });

  test.each([
    '*', 'https://*.vercel.app', 'vercel.app', 'ws://ubercube.io', 'ftp://ubercube.io', 'null',
    'https://user:password@ubercube.io', 'https://@ubercube.io', 'https://ubercube.io\\', 'https://ubercube.io/path', 'https://ubercube.io/path/..',
    'https://ubercube.io?value=1', 'https://ubercube.io?', 'https://ubercube.io#',
    'https://uber\ncube.io', 'https://ubercube.io,', ',https://ubercube.io',
  ])('rejects invalid ALLOWED_ORIGINS value %s', value => {
    expect(() => readConfig([], { ALLOWED_ORIGINS: value })).toThrow();
    expect(() => startServer({ port: 0, allowedOrigins: [value] })).toThrow();
  });
});

describe('HTTP and WebSocket origin boundaries', () => {
  test('allows configured browser origins on status, health and a real WebSocket', async () => {
    const allowed = ['https://ubercube.io', 'https://ubercube.vercel.app'];
    const { base, instance } = start(allowed);
    for (const origin of allowed) {
      for (const path of ['/health', '/api/status']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(base + path, { method, headers: { Origin: origin } });
          expect(response.status).toBe(200);
          expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
          expect(response.headers.get('Vary')).toBe('Origin');
          expect(response.headers.get('Cache-Control')).toBe('no-store');
          expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
          if (method === 'HEAD') expect(await response.text()).toBe('');
          else expect((await response.json()).ok).toBe(true);
        }
      }
      expect(await connects(base, origin)).toBe(true);
    }
    expect(instance.game.players.size).toBe(0);
  });

  test('rejects lookalike, malformed, wrong-scheme and unlisted origins for HTTP and WebSocket', async () => {
    const { base, instance } = start(['https://ubercube.io']);
    const denied = ['https://evil.example', 'https://ubercube.io.evil.example', 'https://evilubercube.io',
      'http://ubercube.io', 'https://ubercube.io:444', 'https://ubercube.io@evil.example',
      'https://ubercube.io/path', 'https://ubercube.io#', 'null'];
    for (const origin of denied) {
      for (const path of ['/api/status', '/health', '/ws']) {
        const response = await fetch(base + path, { headers: { Origin: origin } });
        expect(response.status).toBe(403);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
        expect(response.headers.get('Vary')).toBe('Origin');
      }
      expect(await connects(base, origin)).toBe(false);
    }
    expect(instance.game.connections.size).toBe(0);
  });

  test('preserves same-host and origin-free clients by default, including TLS termination', async () => {
    const { base } = start();
    for (const origin of [undefined, base, base.replace('http:', 'https:')]) {
      const response = await fetch(`${base}/api/status`, { headers: origin === undefined ? {} : { Origin: origin } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin ?? null);
      expect(response.headers.get('Vary')).toBe('Origin');
      expect(await connects(base, origin)).toBe(true);
    }
    const proxied = await fetch(`${base}/health`, { headers: { Host: 'game.ubercube.io', Origin: 'https://game.ubercube.io' } });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get('Access-Control-Allow-Origin')).toBe('https://game.ubercube.io');
    expect(await connects(base, 'https://ubercube.vercel.app')).toBe(false);
    const forgedProxy = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' } });
    expect(forgedProxy.status).toBe(403);
  });

  test('keeps unsupported methods and non-upgrade websocket requests closed', async () => {
    const { base } = start(['https://ubercube.io']);
    const headers = { Origin: 'https://ubercube.io' };
    expect((await fetch(`${base}/api/status`, { method: 'POST', headers })).status).toBe(405);
    expect((await fetch(`${base}/health`, { method: 'OPTIONS', headers })).status).toBe(405);
    expect((await fetch(`${base}/ws`, { headers })).status).toBe(426);
    expect((await fetch(`${base}/ws`, { method: 'HEAD', headers })).status).toBe(426);
  });
});
