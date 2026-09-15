import type { GameEvent, Kit, PlayerState, RemotePlayerState, Vec3, WeaponId } from '../../src/shared/protocol';
import type { GameAudio } from '../../src/client/presentation';

interface SceneSetup {
  scene: string; label: string; kit: Kit; weapon: WeaponId; shooterId: number; targetId: number;
  yaw: number; pitch: number; targetPosition: Vec3; distance: number;
  impulseScale?: number; impulseMagnitude?: number;
}
interface ReviewClient {
  canvas: HTMLCanvasElement; audio: GameAudio;
  ready(): boolean;
  state(): { localId: number; roundId: number; local: PlayerState | null; players: RemotePlayerState[];
    events: (GameEvent & { receivedAt: number })[]; screen: string; worldReady: boolean; terrain?: { chunks: number; queued: number; error: string | null } };
  connect(): void; spawn(kit: Kit): void; prepare(setup: SceneSetup): void;
  drive(input: { yaw?: number; pitch?: number; fire?: boolean; aim?: boolean }): void;
  camera(value: { position: [number, number, number]; target: [number, number, number] } | null): void;
  pose(): { position?: Vec3; yaw: number; pitch: number }; leave(): void;
}

export function installVideoReview(client: ReviewClient): void {
  const impulseReview = new URLSearchParams(location.search).get('review') === 'impulse';
  const trials = impulseReview
    ? ['ak-body', 'ak-head', 'awp-body'].flatMap(scene => [1, 2, 4, 8].map(impulseScale => ({ scene, impulseScale })))
    : ['ak-body', 'ak-head', 'awp-body', 'wall', 'moving'].map(scene => ({ scene, impulseScale: undefined }));
  const start = document.createElement('button');
  start.textContent = impulseReview ? 'Comparer les forces du ragdoll' : 'Enregistrer la revue vidéo'; start.id = 'qa-record';
  start.style.cssText = 'position:fixed;z-index:999;top:20px;right:20px;padding:16px 22px;background:#f4cd67;color:#18212e;border:0;border-radius:8px;font:bold 18px sans-serif;cursor:pointer';
  const status = document.createElement('output'); status.id = 'qa-status';
  status.style.cssText = 'position:fixed;z-index:998;top:82px;right:20px;background:#18212ed9;color:white;padding:10px;font:15px sans-serif';
  status.textContent = 'Prêt · scènes locales, commandes automatisées';
  document.body.append(start, status);
  let setup: SceneSetup | null = null;
  let title = 'UBERCUBE / REVIEW COMBAT';
  let subtitle = 'AK-47 · AWP · impacts · ragdolls';
  let angle = 'VUE JOUEUR';
  let chapter = 0;
  let started = 0;
  let recording = false;
  let frameId = 0;
  const recorded = document.createElement('canvas'); recorded.width = 1280; recorded.height = 720;
  const ctx = recorded.getContext('2d')!;
  const scope = new Image(); scope.src = '/assets/ui/awp_crosshair.png';
  const vignette = new Image(); vignette.src = '/assets/ui/vignette.png';
  const report: { scene: string; label: string; timestampSeconds: number; durationSeconds?: number; impulseScale?: number; impulseMagnitude?: number; observed: unknown; events: GameEvent[]; server: unknown }[] = [];
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (condition: () => boolean, timeout = 20000) => {
    const deadline = performance.now() + timeout;
    while (!condition()) { if (performance.now() >= deadline) throw new Error('Délai de préparation dépassé'); await sleep(40); }
  };
  const text = (value: string, x: number, y: number, size: number, color = '#fff', weight = '600') => {
    ctx.fillStyle = color; ctx.font = `${weight} ${size}px Arial, sans-serif`; ctx.fillText(value, x, y);
  };
  const draw = () => {
    ctx.fillStyle = '#151d28'; ctx.fillRect(0, 0, 1280, 720);
    ctx.drawImage(client.canvas, 0, 0, 1280, 720);
    if (angle === 'VUE JOUEUR') {
      if (vignette.complete) ctx.drawImage(vignette, 0, 0, 1280, 720);
      const sight = document.getElementById('scope')!;
      if (!sight.hidden && scope.complete) {
        const rect = sight.getBoundingClientRect();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scope, rect.x * 1280 / innerWidth, rect.y * 720 / innerHeight, rect.width * 1280 / innerWidth, rect.height * 720 / innerHeight);
        ctx.imageSmoothingEnabled = true;
      }
      const headshot = document.getElementById('headshot-label')!;
      if (!headshot.hidden) {
        const rect = headshot.getBoundingClientRect();
        text('HEADSHOT', rect.x * 1280 / innerWidth, (rect.y + rect.height * .8) * 720 / innerHeight, 25);
      }
    }
    const top = ctx.createLinearGradient(0, 0, 0, 154); top.addColorStop(0, '#0b1529f5'); top.addColorStop(1, '#0b152900');
    ctx.fillStyle = top; ctx.fillRect(0, 0, 1280, 155);
    text(`UBERCUBE   /   ${impulseReview ? 'FORCE DU RAGDOLL' : 'REVIEW COMBAT'}   /   ${String(chapter).padStart(2, '0')} / ${trials.length}`, 34, 32, 14, '#e9c36f');
    text(title, 34, 70, 30); text(subtitle, 35, 102, 17, '#d8e5ed', '400');
    if (impulseReview && setup) {
      ctx.fillStyle = setup.impulseScale === 1 ? '#284150ee' : '#70541aee'; ctx.fillRect(1000, 24, 248, 106);
      text(`×${setup.impulseScale}  ·  ${setup.impulseMagnitude}`, 1020, 69, 34, '#ffe5a6');
      text(setup.impulseScale === 1 ? 'RÉFÉRENCE INITIALE' : setup.impulseScale === 4 ? 'CHOIX VALIDÉ' : 'VARIANTE', 1020, 104, 14, '#fff');
    }
    ctx.fillStyle = '#101b2ddd'; ctx.fillRect(0, 628, 1280, 92);
    const state = client.state();
    const victim = state.players.find(p => p.id === setup?.targetId);
    const deaths = state.events.filter(event => event.event === 'death' && event.targetId === setup?.targetId);
    const hits = state.events.filter(event => event.event === 'impact' && event.targetId === setup?.targetId);
    const shots = state.events.filter(event => event.event === 'shot' && event.shooterId === state.localId);
    const eliminated = deaths.length > 0 || victim?.alive === false;
    text(angle, 34, 656, 13, '#e9c36f');
    text(eliminated ? 'Cible éliminée' : victim?.alive ? 'Cible vivante' : 'Cible absente', 34, 692, 25, eliminated ? '#ff9c82' : '#f3f7fa');
    text(`Tirs ${shots.length}   /   Touches ${hits.length}   /   Morts ${deaths.length}`, 240, 690, 21, '#d9e4ee');
    const currentAmmo = document.getElementById('ammo-value')?.textContent ?? '—';
    text(`${setup?.weapon === 'awp' ? 'AWP' : 'AK-47'}   ${currentAmmo}`, 792, 690, 21);
    ctx.textAlign = 'right'; text('VITESSE RÉELLE · PRISE AUTOMATISÉE', 1246, 654, 12, '#b8c9d6');
    text('Validation visuelle : Marc', 1246, 691, 17, '#e9c36f'); ctx.textAlign = 'left';
    frameId = requestAnimationFrame(draw);
  };

  start.onclick = async () => {
    if (recording) return;
    recording = true; start.disabled = true; chapter = 0; report.length = 0;
    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    try {
      status.textContent = 'Connexion et chargement du terrain…';
      await Promise.all([scope.decode(), vignette.decode()]);
      client.connect();
      await until(() => client.state().localId > 0 && client.state().screen === 'lobby' && client.state().worldReady);
      client.spawn('assault');
      await until(() => client.ready());
      await until(() => (client.state().terrain?.queued ?? 1) === 0);
      const context = (client.audio as unknown as { context: AudioContext }).context;
      await context.resume();
      const destination = context.createMediaStreamDestination();
      (context as AudioContext & { __qaVideoAudio: MediaStreamAudioDestinationNode }).__qaVideoAudio = destination;
      stream = recorded.captureStream(30);
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Enregistrement WebM indisponible');
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 7_000_000, audioBitsPerSecond: 128_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      draw();
      let totalSeconds = 0;
      for (const { scene, impulseScale } of trials) {
        if (recorder.state === 'recording') recorder.pause();
        status.textContent = `Préparation : ${scene}`;
        client.drive({ fire: false, aim: false }); client.camera(null);
        const response = await fetch('/qa/scene', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene, shooterId: client.state().localId, impulseScale }) });
        if (!response.ok) throw new Error(`Fixture ${scene} : HTTP ${response.status}`);
        setup = await response.json() as SceneSetup;
        client.prepare(setup);
        await sleep(150);
        client.drive({ yaw: setup.yaw, pitch: setup.pitch, aim: true, fire: false });
        await sleep(1500);
        await until(() => (client.state().terrain?.queued ?? 0) === 0);
        chapter++;
        if (impulseReview) {
          title = scene === 'ak-head' ? 'AK-47 · impact à la tête' : scene === 'awp-body' ? 'AWP · impact au torse' : 'AK-47 · impact au torse';
          subtitle = 'Même cible immobile, même visée, même caméra. Seule l’impulsion change.';
          angle = 'CAMÉRA FIXE · UN IMPACT MORTEL';
          const p = setup.targetPosition;
          client.camera({ position: [p.x + 6.5, p.y + 3.8, p.z + 6.5], target: [p.x, p.y + 1, p.z - 1.8] });
          await sleep(200);
          if (recorder.state === 'inactive') { recorder.start(1000); started = performance.now(); }
          else recorder.resume();
          const begin = performance.now();
          status.textContent = `Comparaison ${chapter}/${trials.length} : ${title} ×${impulseScale}`;
          await sleep(900);
          client.drive({ fire: true }); await sleep(65); client.drive({ fire: false });
          await until(() => client.state().events.some(e => e.event === 'death' && e.targetId === setup!.targetId), 2000);
          await sleep(Math.max(0, 5700 - (performance.now() - begin)));
          const events = [...client.state().events];
          const deaths = events.filter(e => e.event === 'death' && e.targetId === setup!.targetId);
          const impulse = deaths[0]?.death?.impulse;
          if (deaths.length !== 1 || !impulse || Math.abs(Math.hypot(impulse.x, impulse.y, impulse.z) - setup.impulseMagnitude!) > .001) {
            throw new Error('Impulsion reçue différente de la valeur affichée');
          }
          const server = await (await fetch('/qa/state')).json();
          const durationSeconds = (performance.now() - begin) / 1000;
          report.push({ scene, label: title, timestampSeconds: totalSeconds, durationSeconds, impulseScale,
            impulseMagnitude: setup.impulseMagnitude, observed: { health: 0, alive: false, deaths: deaths.length,
              shots: events.filter(e => e.event === 'shot').length, hitPoint: deaths[0].death?.hitPoint, impulse }, events, server });
          totalSeconds += durationSeconds;
          continue;
        }
        title = setup.label;
        subtitle = scene === 'wall' ? 'Le mur intercepte les tirs. Observer la santé de la cible.'
          : scene === 'moving' ? 'La cible se déplace. La visée est pilotée automatiquement.'
          : 'Observer le départ du tir, le point touché et la réaction du corps.';
        angle = 'VUE JOUEUR';
        if (scene === 'ak-head') {
          const p = setup.targetPosition;
          client.camera({ position: [p.x + 5.5, p.y + 3.7, p.z + 6], target: [p.x, p.y + 1.25, p.z - .5] });
          angle = 'CAMÉRA DE REVUE · IMPACT ET CHUTE';
        }
        if (recorder.state === 'inactive') { recorder.start(1000); started = performance.now(); }
        else recorder.resume();
        const begin = performance.now();
        const follow = scene === 'moving' ? setInterval(() => {
          const current = client.state().players.find(p => p.id === setup!.targetId);
          if (!current?.alive) return;
          const position = client.pose().position;
          if (position) client.drive({ yaw: -Math.atan2(current.position.x - position.x, position.z - current.position.z) + setup!.yaw });
        }, 30) : null;
        await sleep(1000);
        status.textContent = `Enregistrement ${chapter}/5 : ${setup.label}`;
        if (scene === 'ak-head') {
          client.drive({ fire: true }); await sleep(65); client.drive({ fire: false });
        } else if (scene === 'awp-body') {
          client.drive({ fire: true }); await sleep(65); client.drive({ fire: false });
          await sleep(1250); client.drive({ fire: true }); await sleep(65); client.drive({ fire: false });
        } else {
          client.drive({ fire: true }); await sleep(scene === 'wall' ? 430 : scene === 'moving' ? 1300 : 740); client.drive({ fire: false });
        }
        await sleep(1500);
        if (follow) clearInterval(follow);
        const target = client.state().players.find(p => p.id === setup!.targetId);
        const p = target?.position ?? setup.targetPosition;
        client.drive({ aim: false });
        client.camera({ position: [p.x + 5.5, p.y + 3.7, p.z + 6], target: [p.x, p.y + .85, p.z - .5] });
        angle = 'CAMÉRA DE REVUE · MÊME SCÈNE';
        await sleep(3600);
        const events = [...client.state().events];
        const server = await (await fetch('/qa/state')).json();
        report.push({ scene, label: setup.label, timestampSeconds: totalSeconds,
          observed: { alive: target?.alive, deaths: events.filter(e => e.event === 'death').length,
            shots: events.filter(e => e.event === 'shot').length, hits: events.filter(e => e.event === 'impact' && e.targetId === setup!.targetId).length },
          events, server });
        totalSeconds += (performance.now() - begin) / 1000;
      }
      subtitle = impulseReview ? 'Choix validé par Marc : ×4 pour AK et AWP. ×1 conserve la référence initiale.'
        : 'À toi de juger les impacts et les chutes. Repères : chapitre ou minute:seconde.';
      await sleep(1700);
      const stopped = new Promise<void>(resolve => { recorder!.onstop = () => resolve(); });
      recorder.stop(); await stopped;
      const video = new Blob(chunks, { type: 'video/webm' });
      status.textContent = 'Sauvegarde de la vidéo…';
      const suffix = impulseReview ? '?review=impulse' : '';
      const upload = await fetch('/qa/video' + suffix, { method: 'POST', headers: { 'Content-Type': 'video/webm' }, body: video });
      if (!upload.ok) throw new Error(`Sauvegarde vidéo : HTTP ${upload.status}`);
      const saved = await fetch('/qa/report' + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        date: new Date().toISOString(), durationIncludingSetupSeconds: (performance.now() - started) / 1000,
        width: 1280, height: 720, fps: 30, mimeType, bytes: video.size,
        scope: 'Real main.ts client, WebSocket commands and server combat; fixture arena, automated inputs, review camera, capture overlay.'
          + (impulseReview ? ' Local-only death impulse normalization to historical AK 12 / AWP 20 times each factor; target starts at 1 HP for a single fatal impact. Production unchanged by the fixture.' : ''),
        review: 'Pending Marc visual review', scenes: report,
      }) });
      if (!saved.ok) throw new Error(`Sauvegarde rapport : HTTP ${saved.status}`);
      status.textContent = `Vidéo sauvegardée · ${(video.size / 1048576).toFixed(1)} Mo · ${trials.length} scènes · review en attente`;
      document.body.dataset.qaVideo = 'complete';
    } catch (error) {
      status.textContent = `Échec : ${String(error)}`; document.body.dataset.qaVideo = 'failed'; console.error(error);
      if (recorder?.state !== 'inactive') recorder?.stop();
    } finally {
      cancelAnimationFrame(frameId); stream?.getTracks().forEach(track => track.stop());
      client.drive({ fire: false, aim: false }); client.leave();
      recording = false; start.disabled = false; start.textContent = 'Réenregistrer la revue vidéo';
    }
  };
}
