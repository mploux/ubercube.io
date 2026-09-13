import { expect, test } from 'bun:test';
import { startServer } from '../src/server/index';
import { smoke } from '../scripts/smoke';

for (const mode of ['tdm', 'ffa'] as const) test(`deployment smoke exercises ${mode} and closes its sessions`, async () => {
  const server = startServer({ hostname: '127.0.0.1', port: 0, mode, allowedOrigins: ['https://client.example'], world: { seed: 12345, size: 256, height: 64 } });
  try {
    const report = await smoke(`http://127.0.0.1:${server.server.port}`, 'https://client.example');
    expect(report.ok).toBe(true);
    expect(report.mode).toBe(mode);
    const status = await fetch(`http://127.0.0.1:${server.server.port}/health`).then(response => response.json()) as { players: number };
    expect(status.players).toBe(0);
  } finally { server.stop(); }
});

test('deployment smoke refuses remote HTTP and credentials before connecting', async () => {
  await expect(smoke('http://remote.example', 'https://client.example')).rejects.toThrow('HTTPS');
  await expect(smoke('https://user:secret@game.example', 'https://client.example')).rejects.toThrow('credentials');
});
