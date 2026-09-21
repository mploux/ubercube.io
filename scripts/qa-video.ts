import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, '.runtime/qa-video/client');
await mkdir(output, { recursive: true });
const localSources = process.argv.includes('--local-sources');
const manifest = await Bun.file(resolve(root, 'ops/deployed-client.json')).json() as { file: string; sha: string }[];
for (const entry of localSources ? [] : manifest) {
  const bytes = await Bun.file(resolve(root, entry.file)).bytes();
  if (createHash('sha1').update(bytes).digest('hex') !== entry.sha) throw new Error(`Published source differs: ${entry.file}`);
}
const replacements = new Map([
  ["const active = !paused && !document.hidden && !cancelActions && (touchMode || (document.pointerLockElement === canvas && document.hasFocus()));", "const active = !paused && !document.hidden && !cancelActions && (qaVideoDriving || touchMode || (document.pointerLockElement === canvas && document.hasFocus()));"],
  ['  camera.updateProjectionMatrix();\n  if (world &&', '  if (qaVideoCamera) { camera.position.set(...qaVideoCamera.position); camera.lookAt(...qaVideoCamera.target); camera.fov = 55; }\n  camera.updateProjectionMatrix();\n  if (world &&'],
  ["  } else if ((screen === 'game' && local?.alive) || replayFrame) {\n    weaponView.render", "  } else if (((screen === 'game' && local?.alive) || replayFrame) && !qaVideoCamera) {\n    weaponView.render"],
  ['avatars.update(replayFrame?.players ?? remotePlayers.sample(now), replayFrame?.killer.id ?? localId, now / 1000, camera);', 'avatars.update(replayFrame?.players ?? remotePlayers.sample(now), qaVideoCamera?.showLocal ? -1 : replayFrame?.killer.id ?? localId, now / 1000, camera);'],
  ['function handleEvent(event: GameEvent): void {', 'function handleEvent(event: GameEvent): void {\n  qaVideoEvents.push({ ...event, receivedAt: performance.now() });'],
]);
const build = await Bun.build({
  entrypoints: ['src/client/main.ts', 'src/client/terrain.worker.ts', 'src/client/solo.worker.ts'].map(p => resolve(root, p)),
  outdir: output, target: 'browser', splitting: true, sourcemap: 'none', minify: false, external: ['/assets/*'],
  define: { 'process.env.PUBLIC_GAME_SERVER_URL': JSON.stringify('http://127.0.0.1:3014') },
  naming: { entry: '[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]', asset: 'assets/[name]-[hash].[ext]' },
  plugins: [{ name: 'local-video-controls', setup(build) {
    build.onLoad({ filter: /src[\\/]client[\\/]main\.ts$/ }, async args => {
      let contents = (await Bun.file(args.path).text()).replaceAll('\r\n', '\n');
      for (const [before, after] of replacements) {
        if (!contents.includes(before)) throw new Error(`QA adapter no longer matches main.ts: ${before}`);
        contents = contents.replace(before, after);
      }
      contents = `import { installVideoReview } from '../../tests/browser/qa-video';\nlet qaVideoDriving = false;\nlet qaVideoCamera: { position: [number,number,number]; target: [number,number,number]; showLocal?: boolean } | null = null;\nconst qaVideoEvents: (GameEvent & { receivedAt: number })[] = [];\n` + contents;
      contents += `\ninstallVideoReview({
        canvas, audio,
        ready: () => worldReady && !!local?.alive && !terrain?.stats.error,
        state: () => ({ localId, roundId, local, players, events: qaVideoEvents, screen, worldReady, terrain: terrain?.stats }),
        connect: () => { nickname.value = 'Review'; audio.activate(); connect(); },
        spawn: kit => { selectedKit = kit; selectedWeapon = KITS[kit][0]; send({ type: 'spawn', roundId, kit }); },
        prepare: values => { qaVideoDriving = true; clearInput(); selectedKit = values.kit; selectedWeapon = values.weapon; weaponView.reset(values.weapon); avatars.clear(); effects.clear(); qaVideoEvents.length = 0; qaVideoCamera = null; yaw = values.yaw; pitch = values.pitch; weaponLookYaw = yaw; weaponLookPitch = pitch; showScreen('game'); setPaused(false); audio.setEnabled(true); },
        drive: values => { qaVideoDriving = true; if (paused) setPaused(false); audio.setEnabled(true); if (values.yaw !== undefined) yaw = values.yaw; if (values.pitch !== undefined) pitch = values.pitch; if (values.fire !== undefined) fireButton.set(values.fire); if (values.aim !== undefined) { rightMouse = values.aim; altButton.set(values.aim); } },
        camera: value => { qaVideoCamera = value; },
        pose: () => ({ position: predicted?.position, yaw, pitch }),
        leave: () => { qaVideoDriving = false; qaVideoCamera = null; returnHome(); },
      });\n`;
      return { contents, loader: 'ts', resolveDir: resolve(root, 'src/client') };
    });
    build.onLoad({ filter: /src[\\/]client[\\/]presentation\.ts$/ }, async args => {
      const source = await Bun.file(args.path).text();
      const connection = 'source.connect(gain).connect(pan).connect(this.context.destination);';
      if (!source.includes(connection)) throw new Error('Audio capture adapter no longer matches');
      return { contents: source.replace(connection, connection + '\n    if ((this.context as any).__qaVideoAudio) pan.connect((this.context as any).__qaVideoAudio);'), loader: 'ts' };
    });
  } }],
});
if (!build.success) { console.error(build.logs); process.exit(1); }
await Bun.write(resolve(output, 'index.html'), (await Bun.file(resolve(root, 'public/index.html')).text()).replace('<title>UBERCUBE — Free Multiplayer Voxel FPS</title>', '<title>UBERCUBE — revue vidéo locale</title>'));
const sourceFiles = [...new Bun.Glob('src/**/*.ts').scanSync(root), ...new Bun.Glob('public/assets/weapons/rpg/*').scanSync(root)].sort();
const sources = await Promise.all(sourceFiles.map(async file => ({ file, sha256: createHash('sha256').update(await Bun.file(resolve(root, file)).bytes()).digest('hex') })));
await Bun.write(resolve(output, 'qa-source.json'), JSON.stringify({ mode: localSources ? 'local working sources' : 'verified published sources', createdAt: new Date().toISOString(), sources }, null, 2));
console.log(`QA client built from ${localSources ? 'local working sources (not published)' : 'verified published sources'}; only input, camera and capture adapters added.`);
const { startQaVideoServer } = await import('./qa-video-server');
const running = await startQaVideoServer();
console.log(`Vidéo QA locale : http://127.0.0.1:${running.server.port}/`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { running.stop(); process.exit(0); });
