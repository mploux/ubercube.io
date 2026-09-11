export function serverEndpoints(pageUrl: string, configuredOrigin: string | null = ''): { status: string; websocket: string } | null {
  if (configuredOrigin === null) return null;
  const page = new URL(pageUrl);
  const server = configuredOrigin ? new URL(configuredOrigin) : new URL(page.origin);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password
    || server.pathname !== '/' || server.search || server.hash) {
    throw new Error('PUBLIC_GAME_SERVER_URL must be an HTTP(S) origin without a path, query or credentials');
  }
  if (page.protocol === 'https:' && server.protocol !== 'https:') {
    throw new Error('PUBLIC_GAME_SERVER_URL must use HTTPS for an HTTPS site');
  }
  return { status: `${server.origin}/api/status`, websocket: `${server.protocol === 'https:' ? 'wss:' : 'ws:'}//${server.host}/ws` };
}
