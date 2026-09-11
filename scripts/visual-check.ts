import { extname, resolve, sep } from 'node:path';

const output = resolve('.runtime/visual-check');
const weaponAssets = resolve('public/assets/weapons');
const build = await Bun.build({ entrypoints: ['tests/browser/render-check.ts'], outdir: output, target: 'browser', naming: 'render-check.js' });
if (!build.success) { console.error(build.logs); process.exit(1); }
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>UBERCUBE — contrôle GPU</title>
<style>body{background:#17212a;color:white;font:16px monospace;padding:24px}canvas{width:384px;height:384px}pre{white-space:pre-wrap}</style>
<h1>Contrôle GPU UBERCUBE</h1><p>Shaders du jeu et pixels lus dans le framebuffer WebGL.</p><pre id="results">En cours…</pre><canvas id="render"></canvas><script type="module" src="/render-check.js"></script></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1', port: 3011,
  async fetch(request) {
    let path: string;
    try { path = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('Invalid path', { status: 400 }); }
    if (path === '/') return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    if (path === '/render-check.js') return new Response(Bun.file(resolve(output, 'render-check.js')), { headers: { 'Cache-Control': 'no-store' } });
    if (path.startsWith('/assets/weapons/')) {
      const assetPath = resolve(weaponAssets, path.slice('/assets/weapons/'.length));
      if (!assetPath.startsWith(weaponAssets + sep) || !['.obj', '.mtl'].includes(extname(assetPath))) {
        return new Response('Not found', { status: 404 });
      }
      const file = Bun.file(assetPath);
      if (await file.exists()) return new Response(file, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Contrôles GPU : http://127.0.0.1:${server.port}/`);
process.on('SIGINT', () => { server.stop(true); process.exit(); });
