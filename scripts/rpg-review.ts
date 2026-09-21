import { extname, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';

const output = resolve('.runtime/rpg-review');
const assets = resolve('public/assets');
await mkdir(output, { recursive: true });
const build = await Bun.build({ entrypoints: ['tests/browser/rpg-review.ts'], outdir: output, target: 'browser', naming: 'review.js' });
if (!build.success) { console.error(build.logs); process.exit(1); }
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>UBERCUBE — revue du RPG</title>
<style>*{box-sizing:border-box}body{margin:0;background:#14212d;color:#edf3f8;font:15px Arial,sans-serif;padding:20px}h1{font-size:22px;margin:0 0 8px}p{margin:8px 0 14px;color:#c2d3de}nav{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}button{background:#29445a;border:1px solid #57768e;border-radius:5px;color:white;font:inherit;padding:9px 12px;cursor:pointer}button:hover{background:#395e7a}button:disabled{opacity:.4;cursor:wait}#capture{width:min(1280px,100%);height:auto;display:block;border:1px solid #496477}#render{position:fixed;width:1280px;height:720px;left:-2000px;top:0}#status{white-space:pre-wrap;max-width:1280px}#gallery{display:flex;flex-wrap:wrap;gap:12px}#gallery img{width:300px;max-width:100%;border:1px solid #496477}</style>
<h1>RPG · montage, visée et départ de la roquette</h1>
<p>Modèles, poses et shaders du jeu. Scène locale fixe pour vérifier les quatre vues et le projectile détaché.</p>
<nav aria-label="Vues"><button data-view="fps-idle">Première personne · repos</button><button data-view="fps-aim">Première personne · visée</button><button data-view="awp-aim">Comparaison AWP · visée</button><button data-view="third-idle">Troisième personne · repos</button><button data-view="third-aim">Troisième personne · visée</button><button data-view="shot">Départ de la roquette · FPS</button><button data-view="third-shot20">Départ de la roquette · profil 20 ms</button><button data-view="third-shot45">Départ de la roquette · profil 45 ms</button></nav>
<nav aria-label="Angles du personnage"><button data-angle="quarter">Trois-quarts</button><button data-angle="profile">Profil droit</button><button data-angle="left">Profil gauche</button><button data-angle="front">Face</button></nav>
<nav aria-label="Captures"><button id="save">Enregistrer cette vue</button><button id="sheet">Enregistrer les quatre vues et la roquette</button></nav>
<canvas id="capture" width="1280" height="720" aria-label="Aperçu du RPG"></canvas><canvas id="render"></canvas>
<p id="status" role="status">Chargement des modèles du jeu…</p><div id="gallery"></div><script type="module" src="/review.js"></script></html>`;
const server = Bun.serve({
  hostname: '127.0.0.1', port: 3015,
  async fetch(request) {
    let path: string;
    try { path = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('Invalid path', { status: 400 }); }
    if (path === '/') return new Response(html, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
    if (path === '/review.js') return new Response(Bun.file(resolve(output, 'review.js')), { headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'POST' && /^\/capture\/[a-z0-9-]+\.png$/.test(path)) {
      const image = new Uint8Array(await request.arrayBuffer());
      if (image.length > 12_000_000 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => image[index] === byte)) {
        return new Response('Invalid PNG', { status: 400 });
      }
      const name = path.slice('/capture/'.length);
      await Bun.write(resolve(output, name), image);
      return Response.json({ name });
    }
    if (path.startsWith('/assets/')) {
      const filePath = resolve(assets, path.slice('/assets/'.length));
      if (filePath.startsWith(assets + sep) && ['.obj', '.mtl', '.png'].includes(extname(filePath))) {
        const file = Bun.file(filePath);
        if (await file.exists()) return new Response(file, { headers: { 'Cache-Control': 'no-store' } });
      }
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Revue RPG : http://127.0.0.1:${server.port}/ — captures dans ${output}`);
process.on('SIGINT', () => { server.stop(true); process.exit(); });
