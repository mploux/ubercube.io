import { expect, test } from 'bun:test';
import { serverEndpoints } from '../src/client/server-endpoints';

test('an unconfigured static deployment has no game endpoints', () => {
  expect(serverEndpoints('https://ubercube.vercel.app/', null)).toBeNull();
});

test('local and same-origin production clients keep their original server addresses', () => {
  expect(serverEndpoints('http://localhost:3000/?debug=1')).toEqual({ status: 'http://localhost:3000/api/status', websocket: 'ws://localhost:3000/ws' });
  expect(serverEndpoints('https://ubercube.example/')).toEqual({ status: 'https://ubercube.example/api/status', websocket: 'wss://ubercube.example/ws' });
});

test('a static client connects directly to its configured game server', () => {
  expect(serverEndpoints('https://ubercube.vercel.app/', 'https://game.example:8443/')).toEqual({
    status: 'https://game.example:8443/api/status', websocket: 'wss://game.example:8443/ws',
  });
});

test('invalid server addresses and mixed-content production endpoints fail explicitly', () => {
  for (const origin of ['not-a-url', '/ws', 'wss://game.example', 'https://user:password@game.example',
    'https://game.example/path', 'https://game.example/?token=secret', 'https://game.example/#hash', 'http://game.example']) {
    expect(() => serverEndpoints('https://ubercube.example/', origin)).toThrow();
  }
});
