import * as THREE from 'three';
import './styles.css';
import { DT, KITS, PROTOCOL_VERSION, WEAPONS, type ClientMessage, type GameEvent, type InputFrame, type Kit, type Mode, type MotionState, type PlayerState, type ServerMessage, type WeaponId, type WorldConfig } from '../shared/protocol';
import { aimDirection, EYE_HEIGHT, movePlayer } from '../shared/movement';
import { grenadeLaunch } from '../shared/grenade';
import { getWeaponMuzzle } from '../shared/weapon-pose';
import { raycast, VoxelWorld } from '../shared/voxel';
import { decodeServerMessage } from '../shared/wire';
import { TerrainRenderer } from './terrain';
import { MinimapRenderer } from './minimap';
import { Snow } from './snow';
import { WorldShadows } from './shadows';
import { SUN_DIRECTION } from './lighting';
import { InputButton } from './input-button';
import { Effects, GameAudio, PlayerVisuals } from './presentation';
import { WeaponView } from './weapon-view';
import { serverEndpoints } from './server-endpoints';

const endpoints = serverEndpoints(location.href, process.env.PUBLIC_GAME_SERVER_URL);

const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('viewport');
const nickname = element<HTMLInputElement>('nickname');
const joinButton = element<HTMLButtonElement>('join-button');
const sensitivityInput = element<HTMLInputElement>('sensitivity');
const zoomSensitivityInput = element<HTMLInputElement>('zoom-sensitivity');
const audioVolumeInput = element<HTMLInputElement>('audio-volume');

function remember(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(`ubercube.${key}`, value);
    return localStorage.getItem(`ubercube.${key}`) ?? '';
  } catch { return value ?? ''; }
}

nickname.value = remember('name');
let sensitivity = Math.min(2.5, Math.max(0.25, Number(remember('sensitivity')) || 1));
let zoomSensitivity = Math.min(2.5, Math.max(0.25, Number(remember('zoom-sensitivity')) || 1));
let audioVolume = remember('audio-volume') === '' ? 1 : Math.min(1, Math.max(0, Number(remember('audio-volume'))));
const viewDistance = Math.min(256, Math.max(64, Number(remember('distance')) || 160));
const graphics = { snow: remember('snow') === 'true', shadows: remember('shadows') !== 'false', ssaa: remember('ssaa') === 'true' };
sensitivityInput.value = String(sensitivity);
zoomSensitivityInput.value = String(zoomSensitivity);
audioVolumeInput.value = String(audioVolume);
element('sensitivity-value').textContent = sensitivity.toFixed(2);
element('zoom-sensitivity-value').textContent = zoomSensitivity.toFixed(2);
element('audio-volume-value').textContent = String(Math.round(audioVolume * 100));

const renderer = (() => {
  try { return new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' }); }
  catch (error) {
    element('join-error').textContent = 'Le rendu 3D est indisponible. Activez l’accélération graphique de votre navigateur puis rechargez la page.';
    joinButton.disabled = true;
    throw error;
  }
})();
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.autoClear = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdde8ff);
scene.fog = new THREE.Fog(0xdde8ff, viewDistance * 0.4, viewDistance * 0.9);
scene.add(new THREE.HemisphereLight(0xf4ffe1, 0x475d45, 2.3));
const sun = new THREE.DirectionalLight(0xffe4be, 2.5);
sun.position.copy(SUN_DIRECTION).multiplyScalar(320);
scene.add(sun, sun.target);
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.05, 1100);
camera.rotation.order = 'YXZ';
const shadows = new WorldShadows(renderer, scene, camera, viewDistance);
const avatars = new PlayerVisuals(scene);
const effects = new Effects(scene, viewDistance);
void effects.ready.catch(error => { console.error(error); toast('Impossible de charger le modèle de grenade. Rechargez la page.'); });
const snow = new Snow(scene, viewDistance);
const cameraForward = new THREE.Vector3();

function applyGraphics(): void {
  const pixelRatio = Math.min(devicePixelRatio || 1, 1.75) * (graphics.ssaa ? 2 : 1);
  const maxSize = renderer.capabilities.maxTextureSize;
  renderer.setPixelRatio(Math.min(pixelRatio, maxSize / innerWidth, maxSize / innerHeight));
  renderer.setSize(innerWidth, innerHeight);
  shadows.setEnabled(graphics.shadows);
  snow.setEnabled(graphics.snow);
  for (const key of ['snow', 'shadows', 'ssaa'] as const) element<HTMLInputElement>(`graphics-${key}`).checked = graphics[key];
}
applyGraphics();
const weaponView = new WeaponView();
const audio = new GameAudio();
audio.setVolume(audioVolume);
const target = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.014, 1.014, 1.014)), new THREE.LineBasicMaterial({ color: 0xffb779 }));
target.visible = false;
scene.add(target);

type Screen = 'entry' | 'lobby' | 'game' | 'disconnected';
let screen: Screen = 'entry';
let socket: WebSocket | null = null;
let localId = -1;
let roundId = -1;
let mode: Mode = 'tdm';
let maxPlayers = 100;
let selectedKit: Kit = 'assault';
let selectedWeapon: WeaponId = 'ak47';
let world: VoxelWorld | null = null;
let terrain: TerrainRenderer | null = null;
let minimapRenderer: MinimapRenderer | null = null;
let worldReady = false;
let revision = 0;
let local: PlayerState | null = null;
let predicted: MotionState | null = null;
const correctionOffset = new THREE.Vector3();
let players: PlayerState[] = [];
const snapshots: { time: number; players: PlayerState[] }[] = [];
let pending: InputFrame[] = [];
let unsent: InputFrame[] = [];
let sequence = 0;
let yaw = 0;
let pitch = 0;
let weaponLookYaw = 0;
let weaponLookPitch = 0;
let weaponMouseDX = 0;
let weaponMouseDY = 0;
let paused = false;
let spawning = false;
let connecting = false;
let rightMouse = false;
const fireButton = new InputButton();
const altButton = new InputButton();
let ping: number | null = null;
let lastPing = 0;
let lastStatusPoll = 0;
let statusBusy = false;
let lastUI = 0;
let lastFrame = performance.now();
let accumulator = 0;
let footsteps = 0;
let muted = false;
let fpsFrames = 0;
let fpsSampleTime = performance.now();
let displayedFps = 0;
let damageOpacity = 0;
let headshotUntil = 0;
let renderErrorShown = false;
let toastTimer = 0;
let spawnTimer = 0;
let connectionTimer = 0;
const keys = new Set<string>();
const minimap = element<HTMLCanvasElement>('minimap');
const lobbyMap = element<HTMLCanvasElement>('lobby-map');
const feed: { text: HTMLElement; expires: number }[] = [];

function toast(message: string): void {
  element('toast').textContent = message;
  element('toast').hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element('toast').hidden = true; }, 3800);
}

function clearInput(): void {
  keys.clear(); rightMouse = false;
  fireButton.clear(); altButton.clear();
  weaponMouseDX = 0; weaponMouseDY = 0;
  weaponLookYaw = yaw; weaponLookPitch = pitch;
  element('score-screen').hidden = true;
}

function showScreen(next: Screen): void {
  screen = next;
  document.body.dataset.screen = next;
  document.body.classList.toggle('playing', next === 'game');
  element('entry-screen').hidden = next !== 'entry';
  element('lobby-screen').hidden = next !== 'lobby';
  element('lobby-background').hidden = next !== 'lobby';
  element('lobby-map').hidden = next !== 'lobby';
  element('game-hud').hidden = next !== 'game';
  element('disconnect-screen').hidden = next !== 'disconnected';
  element('pause-screen').hidden = true;
  element('options-panel').hidden = true;
  element('graphics-panel').hidden = true;
  paused = false;
  clearInput();
  if (next !== 'game' && document.pointerLockElement === canvas) document.exitPointerLock();
  audio.setEnabled(next === 'game' && document.hasFocus() && !muted);
  if (next === 'lobby') weaponView.setWeapon(KITS[selectedKit][0]);
}

function setPaused(value: boolean): void {
  if (screen !== 'game') return;
  paused = value;
  element('pause-screen').hidden = !value;
  element('options-panel').hidden = true;
  element('graphics-panel').hidden = true;
  clearInput();
  audio.setEnabled(!value && document.hasFocus() && !muted);
}

function lockPointer(): void {
  if (terrain?.stats.error) { toast(terrain.stats.error); return; }
  audio.activate();
  if (document.pointerLockElement === canvas) { setPaused(false); return; }
  try {
    const result = canvas.requestPointerLock();
    if (result) void result.catch(() => { setPaused(true); toast('Ce navigateur a refusé la capture de la souris. Ouvrez le jeu dans Chrome, Firefox ou Edge.'); });
  } catch { setPaused(true); toast('Ce navigateur a refusé la capture de la souris. Ouvrez le jeu dans Chrome, Firefox ou Edge.'); }
}

function send(message: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > 262144) { disconnect('La connexion ne suit plus le rythme de la partie. Reconnectez-vous.'); return false; }
  socket.send(JSON.stringify(message));
  return true;
}

function resetPrediction(): void {
  predicted = null; pending = []; unsent = []; snapshots.length = 0;
  correctionOffset.set(0, 0, 0);
  damageOpacity = 0; headshotUntil = 0;
  sequence = 0; accumulator = 0;
  clearInput();
}

function setWorld(config: WorldConfig): void {
  snow.reset();
  world = new VoxelWorld(config);
  if (terrain) terrain.reset(world);
  else terrain = new TerrainRenderer(scene, world, viewDistance, shadows.splits);
  if (minimapRenderer) minimapRenderer.reset(world);
  else minimapRenderer = new MinimapRenderer(world);
  renderErrorShown = false;
  camera.position.set(config.size * 0.56, Math.min(config.height - 2, 47), config.size * 0.58);
  camera.lookAt(config.size * 0.43, 18, config.size * 0.35);
  terrain.update(camera.position);
}

function disconnect(reason: string): void {
  const previous = socket; socket = null;
  previous?.close();
  window.clearTimeout(connectionTimer); window.clearTimeout(spawnTimer);
  connecting = false; spawning = false; worldReady = false;
  joinButton.disabled = false;
  joinButton.querySelector('span')!.textContent = 'Join game';
  resetPrediction();
  avatars.clear(); effects.clear(); players = []; local = null;
  element('disconnect-reason').textContent = reason;
  showScreen('disconnected');
}

function returnHome(): void {
  const previous = socket; socket = null; previous?.close();
  window.clearTimeout(connectionTimer); window.clearTimeout(spawnTimer);
  connecting = false; spawning = false; worldReady = false; localId = -1; local = null;
  resetPrediction(); avatars.clear(); effects.clear(); players = [];
  joinButton.disabled = false; joinButton.querySelector('span')!.textContent = 'Join game';
  element('join-error').textContent = '';
  showScreen('entry');
  lastStatusPoll = 0;
  void pollStatus();
}

function connect(): void {
  const name = nickname.value.trim().replace(/\s+/g, ' ').slice(0, 24);
  if (name.length < 2) { element('join-error').textContent = 'Choisissez un pseudo de 2 à 24 caractères.'; nickname.focus(); return; }
  if (connecting) return;
  const old = socket; socket = null; old?.close();
  remember('name', name); nickname.value = name;
  element('join-error').textContent = '';
  connecting = true; localId = -1; roundId = -1; worldReady = false; local = null; ping = null;
  players = []; resetPrediction(); avatars.clear(); effects.clear();
  joinButton.disabled = true;
  joinButton.querySelector('span')!.textContent = 'Connecting...';
  showScreen('entry');
  const connection = new WebSocket(endpoints.websocket);
  connection.binaryType = 'arraybuffer';
  socket = connection;
  connection.onopen = () => {
    if (socket !== connection) return;
    send({ type: 'hello', version: PROTOCOL_VERSION, name });
  };
  connection.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    if (socket !== connection) return;
    try { receive(decodeServerMessage(event.data)); }
    catch (error) { console.error('Message serveur non traité', error); disconnect('Le serveur a envoyé un état incompatible. Rechargez la page.'); }
  };
  connection.onclose = () => { if (socket === connection) disconnect('La connexion au serveur a été interrompue. Votre pseudo est conservé.'); };
  connection.onerror = () => { if (socket === connection) disconnect('Le serveur est inaccessible pour le moment.'); };
  window.clearTimeout(connectionTimer);
  connectionTimer = window.setTimeout(() => { if (!worldReady && socket === connection) disconnect('Le chargement du serveur a pris trop de temps. Réessayez.'); }, 45000);
}

function refreshKitButtons(): void {
  const disabled = !worldReady || spawning || !!terrain?.stats.error;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-kit]')) button.disabled = disabled;
}

function receive(message: ServerMessage): void {
  if (message.type === 'welcome') {
    localId = message.id; roundId = message.roundId; mode = message.mode; maxPlayers = message.maxPlayers;
    worldReady = false; revision = 0; connecting = false;
    setWorld(message.world);
    element('tdm-scores').hidden = mode !== 'tdm';
    showScreen('lobby'); refreshKitButtons();
    return;
  }
  if (message.type === 'error') {
    if (spawning && screen === 'lobby' && document.pointerLockElement === canvas) document.exitPointerLock();
    spawning = false; window.clearTimeout(spawnTimer); refreshKitButtons();
    if (message.fatal) disconnect(message.message);
    else { toast(message.message); if (screen === 'entry') element('join-error').textContent = message.message; }
    return;
  }
  if (message.type === 'pong') { ping = Math.max(0, Math.round(performance.now() - message.time)); return; }
  if (message.type === 'reset') {
    roundId = message.roundId; revision = 0; worldReady = false; spawning = false;
    window.clearTimeout(spawnTimer);
    resetPrediction(); local = null; players = []; avatars.clear(); effects.clear();
    setWorld(message.world);
    showScreen('lobby'); refreshKitButtons();
    toast('Nouvelle manche. Choisissez votre équipement.');
    return;
  }
  if (message.roundId !== roundId) return;
  if (message.type === 'world') {
    if (!world || !terrain) return;
    if (!message.initial && message.revision <= revision) return;
    if (!message.initial && message.revision !== revision + 1) { disconnect('Une mise à jour du terrain manque. Reconnectez-vous pour synchroniser la carte.'); return; }
    terrain.applyEdits(message.edits);
    minimapRenderer?.applyEdits(message.edits);
    revision = message.revision;
    if (message.complete) {
      worldReady = true; window.clearTimeout(connectionTimer);
      refreshKitButtons();
    }
    return;
  }
  if (message.type === 'snapshot') {
    players = message.players;
    const now = performance.now();
    effects.snapshot(message.projectiles, message.tick, now / 1000);
    snapshots.push({ time: now, players: message.players });
    while (snapshots.length > 15) snapshots.shift();
    const authoritative = players.find((player) => player.id === localId);
    if (authoritative) applyLocalState(authoritative);
    element('red-score').textContent = `Red : ${message.scores[0]}`;
    element('blue-score').textContent = `Blue : ${message.scores[1]}`;
    element('match-time').textContent = message.remaining === null ? 'EN COURS' : `${Math.floor(Math.max(0, message.remaining) / 60)}:${Math.floor(Math.max(0, message.remaining) % 60).toString().padStart(2, '0')}`;
    return;
  }
  if (message.type === 'event') handleEvent(message);
}

function applyLocalState(state: PlayerState): void {
  const wasAlive = local?.alive ?? false;
  const oldHealth = local?.health ?? 100;
  const previousPrediction = predicted;
  local = state;
  effects.acknowledgeInputs(state);
  pending = pending.filter((frame) => frame.seq > state.lastSeq);
  sequence = Math.max(sequence, state.lastSeq);
  predicted = { position: { ...state.position }, velocity: { ...state.velocity }, grounded: state.grounded, yaw: state.yaw, pitch: state.pitch };
  if (world) for (const frame of pending) movePlayer(predicted, frame, world);
  if (wasAlive && state.alive && previousPrediction) {
    const dx = previousPrediction.position.x - predicted.position.x;
    const dy = previousPrediction.position.y - predicted.position.y;
    const dz = previousPrediction.position.z - predicted.position.z;
    if (Math.hypot(dx, dy, dz) > 2) correctionOffset.set(0, 0, 0);
    else {
      correctionOffset.x += dx; correctionOffset.y += dy; correctionOffset.z += dz;
      correctionOffset.clampLength(0, 1.5);
    }
  } else correctionOffset.set(0, 0, 0);
  if (state.health < oldHealth && state.alive) {
    damageOpacity = Math.min(0.75, damageOpacity + 0.25);
  }
  if (state.alive && !wasAlive) {
    spawning = false; window.clearTimeout(spawnTimer); clearInput();
    selectedKit = state.kit; selectedWeapon = state.weapon;
    yaw = state.yaw; pitch = state.pitch;
    pending = []; unsent = []; accumulator = 0;
    showScreen('game'); weaponView.reset(selectedWeapon);
    updateUI();
    if (document.pointerLockElement !== canvas) setPaused(true);
    else audio.setEnabled(!muted);
  } else if (!state.alive && wasAlive) {
    pending = []; unsent = []; accumulator = 0;
    showScreen('lobby'); refreshKitButtons();
  }
}

function handleEvent(event: GameEvent): void {
  effects.event(event, performance.now() / 1000);
  const listener = predicted ? { ...predicted.position, y: predicted.position.y + EYE_HEIGHT } : camera.position;
  const own = event.shooterId === localId;
  if (event.event === 'shot') {
    const file = event.weapon === 'awp' ? 'AWPShoot' : event.weapon === 'ak47' ? 'AK47Shoot' : event.weapon === 'shovel' ? 'dig' : '';
    // The local weapon already responded to the trigger; confirmation must not play it twice.
    if (file && !own) audio.play(file, event.position, listener, yaw, 0.5);
  }
  if (event.event === 'explosion') audio.play('waterexplode', event.position, listener, yaw, 0.55);
  if (event.event === 'build') audio.play('place', event.position, listener, yaw, 0.4);
  if (event.event === 'impact' && event.weapon === 'shovel') audio.play('dig', event.position, listener, yaw, 0.3);
  if ((event.event === 'impact' || event.event === 'death') && own && event.targetId !== undefined) {
    audio.play('playerhit', undefined, undefined, 0, 0.4);
    if (event.headshot) headshotUntil = performance.now() + 3000;
  }
  if (event.event === 'death') {
    const shooter = players.find((player) => player.id === event.shooterId);
    const victim = players.find((player) => player.id === event.targetId);
    const row = document.createElement('div');
    row.textContent = event.targetId === localId
      ? `${event.headshot ? 'Headshooted by' : 'You died by'} ${shooter?.name ?? 'World'} !`
      : `${victim?.name ?? 'Player'} has been ${event.headshot ? 'headshooted' : 'killed'} by ${shooter?.name ?? 'World'} !`;
    element('kill-feed').append(row);
    feed.push({ text: row, expires: performance.now() + 20000 });
    if (feed.length > 5) feed.shift()?.text.remove();
  }
}

async function pollStatus(): Promise<void> {
  if (socket || connecting || statusBusy) return;
  lastStatusPoll = performance.now(); statusBusy = true;
  try {
    const response = await fetch(endpoints.status, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unavailable');
    const status = await response.json() as { mode: Mode; maxPlayers: number; players: number; world: WorldConfig; roundId: number };
    if (socket || connecting) return;
    mode = status.mode; maxPlayers = status.maxPlayers;
    if (!world || JSON.stringify(world.config) !== JSON.stringify(status.world)) setWorld(status.world);
    element('population').textContent = `${status.players} / ${maxPlayers} joueurs en ligne`;
  } catch {
    if (socket || connecting) return;
    element('population').textContent = 'Serveur indisponible pour le moment';
  } finally { statusBusy = false; }
}

function spawnKit(kit: Kit): void {
  if (!worldReady || spawning || terrain?.stats.error) return;
  selectedKit = kit;
  selectedWeapon = KITS[kit][0];
  for (const card of document.querySelectorAll<HTMLButtonElement>('[data-kit]')) {
    const chosen = card.dataset.kit === kit;
    card.classList.toggle('selected', chosen); card.setAttribute('aria-pressed', String(chosen));
  }
  weaponView.setWeapon(selectedWeapon);
  spawning = true; refreshKitButtons(); audio.activate();
  lockPointer();
  if (!send({ type: 'spawn', roundId, kit })) { spawning = false; refreshKitButtons(); return; }
  window.clearTimeout(spawnTimer);
  spawnTimer = window.setTimeout(() => { if (spawning) { spawning = false; document.exitPointerLock(); refreshKitButtons(); toast('Le déploiement n’a pas été confirmé. Réessayez.'); } }, 6000);
}

function simulate(): void {
  if (screen !== 'game' || !local?.alive || !predicted || !world || !worldReady) return;
  if (pending.length > 240) { disconnect('La simulation du serveur ne répond plus. Reconnectez-vous.'); return; }
  const active = !paused && document.pointerLockElement === canvas && document.hasFocus();
  const frame: InputFrame = {
    seq: ++sequence, roundId,
    moveX: active ? Number(keys.has('KeyD')) - Number(keys.has('KeyA')) : 0,
    moveZ: active ? Number(keys.has('KeyW')) - Number(keys.has('KeyS')) : 0,
    yaw, pitch, jump: active && keys.has('Space'), sprint: active && (keys.has('ShiftLeft') || keys.has('ShiftRight')),
    fire: active && fireButton.sample(), alt: active && altButton.sample(), weapon: selectedWeapon,
    cancelActions: !active,
  };
  const groundedBefore = predicted.grounded;
  const throwMuzzle = selectedWeapon === 'grenade' ? getWeaponMuzzle(weaponView.pose) : null;
  const actions = weaponView.tick({
    moveX: frame.moveX, moveZ: frame.moveZ, sprint: frame.sprint, fire: frame.fire, alt: frame.alt,
    lookDeltaYaw: Math.atan2(Math.sin(yaw - weaponLookYaw), Math.cos(yaw - weaponLookYaw)),
    lookDeltaPitch: pitch - weaponLookPitch,
    mouseDX: weaponMouseDX, mouseDY: weaponMouseDY, grenades: effects.availableGrenades(local), cancelActions: !active,
  });
  weaponLookYaw = yaw; weaponLookPitch = pitch; weaponMouseDX = 0; weaponMouseDY = 0;
  if (actions.fired) audio.play(selectedWeapon === 'awp' ? 'AWPShoot' : 'AK47Shoot', undefined, undefined, 0, 0.5);
  movePlayer(predicted, frame, world);
  if (actions.thrown) effects.predictGrenade(localId, frame.seq, grenadeLaunch(world, predicted, throwMuzzle!, actions.force), world, performance.now() / 1000);
  if (groundedBefore && !predicted.grounded && frame.jump) audio.play('jump', undefined, undefined, 0, 0.13);
  if (!groundedBefore && predicted.grounded) audio.play('land', undefined, undefined, 0, 0.13);
  pending.push(frame); unsent.push(frame);
  if (unsent.length >= 3 || actions.thrown) {
    const batch = unsent.splice(0, 3);
    send({ type: 'input', frames: batch });
  }
}

function interpolatePlayers(now: number): PlayerState[] {
  if (!snapshots.length) return players;
  const targetTime = now - 100;
  let before = snapshots[0]; let after = snapshots[snapshots.length - 1];
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].time <= targetTime) before = snapshots[i];
    if (snapshots[i].time >= targetTime) { after = snapshots[i]; break; }
  }
  const fraction = before === after ? 1 : Math.max(0, Math.min(1, (targetTime - before.time) / (after.time - before.time)));
  const earlier = new Map(before.players.map((player) => [player.id, player]));
  return after.players.map((player) => {
    const previous = earlier.get(player.id);
    if (!previous || previous.alive !== player.alive || Math.hypot(previous.position.x - player.position.x, previous.position.z - player.position.z) > 15) return player;
    const turn = Math.atan2(Math.sin(player.yaw - previous.yaw), Math.cos(player.yaw - previous.yaw));
    return { ...player, position: { x: THREE.MathUtils.lerp(previous.position.x, player.position.x, fraction), y: THREE.MathUtils.lerp(previous.position.y, player.position.y, fraction), z: THREE.MathUtils.lerp(previous.position.z, player.position.z, fraction) }, yaw: previous.yaw + turn * fraction };
  });
}

function updateUI(): void {
  if (local) {
    element('health-value').textContent = String(Math.max(0, local.health));
    element('health-fill').style.width = `${Math.max(0, local.health)}%`;
    element('ammo-value').textContent = selectedWeapon === 'grenade' ? String(local.grenades) : selectedWeapon === 'medic' ? '+' : selectedWeapon === 'shovel' ? '∞' : local.weapon === selectedWeapon ? String(local.ammo) : '—';
    element('ammo-max').textContent = selectedWeapon === 'grenade' ? '/10' : `/${WEAPONS[selectedWeapon].magazine}`;
    element('ammo-line').hidden = selectedWeapon === 'shovel' || selectedWeapon === 'medic';
  }
  element('hud-fps').textContent = `${displayedFps} Fps`;
  const position = predicted?.position ?? local?.position;
  element('hud-position').textContent = position ? `${Math.trunc(position.x)} - ${Math.trunc(position.y)} - ${Math.trunc(position.z)}` : '';
  element('audio-status').hidden = !muted;
  if (!element('score-screen').hidden) {
    const redRows: HTMLElement[] = [], blueRows: HTMLElement[] = [], ffaRows: HTMLElement[] = [];
    for (const player of players) {
      const row = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = player.name; name.style.color = player.team === 1 ? '#ff0000' : player.team === 2 ? '#0000ff' : '#ffffff';
      const kills = document.createElement('td'); kills.textContent = String(player.kills);
      const deaths = document.createElement('td'); deaths.textContent = String(player.deaths);
      const latency = document.createElement('td'); latency.textContent = player.id === localId && ping !== null ? `${ping} ms` : '—';
      row.append(name, kills, deaths, latency);
      if (mode === 'ffa') ffaRows.push(row);
      else (player.team === 1 ? redRows : blueRows).push(row);
    }
    element('score-red-rows').replaceChildren(...redRows);
    element('score-blue-rows').replaceChildren(...blueRows);
    element('score-rows').replaceChildren(...ffaRows);
    element('score-screen').dataset.mode = mode;
    element('score-ffa').hidden = mode !== 'ffa';
    element('score-tdm').hidden = mode === 'ffa';
  }
  refreshKitButtons();
}

function drawMap(): void {
  if (!world || !minimapRenderer || (screen !== 'game' && screen !== 'lobby')) return;
  const overview = screen === 'lobby';
  const position = overview && !local?.deaths
    ? { x: world.config.size / 2, y: 0, z: world.config.size / 2 }
    : predicted?.position ?? local?.position;
  if (!position) return;
  minimapRenderer.draw(overview ? lobbyMap : minimap, {
    position, yaw, team: local?.team ?? 0, players, mode, overview,
  });
}
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  fpsFrames++;
  if (now - fpsSampleTime >= 1000) {
    displayedFps = Math.round(fpsFrames * 1000 / (now - fpsSampleTime));
    fpsFrames = 0; fpsSampleTime = now;
  }
  damageOpacity = Math.max(0, damageOpacity - dt * 0.3);
  element('damage-overlay').style.opacity = String(damageOpacity);
  element('headshot-label').hidden = now >= headshotUntil;
  accumulator += dt;
  while (accumulator >= DT) { simulate(); accumulator -= DT; }
  correctionOffset.multiplyScalar(Math.exp(-25 * dt));
  if (screen === 'game' && predicted) {
    camera.position.set(predicted.position.x, predicted.position.y + EYE_HEIGHT, predicted.position.z).add(correctionOffset);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const zoom = weaponView.pose.altHeld && (selectedWeapon === 'awp' || selectedWeapon === 'ak47');
    camera.fov = weaponView.fov;
    element('scope').hidden = !(zoom && selectedWeapon === 'awp');
    element('crosshair').hidden = selectedWeapon === 'ak47' || selectedWeapon === 'awp';
    if (selectedWeapon === 'shovel' && world && !paused) {
      const hit = raycast(world, { ...predicted.position, y: predicted.position.y + EYE_HEIGHT }, aimDirection(yaw, pitch), 5);
      target.visible = !!hit;
      if (hit) target.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else target.visible = false;
    const speed = Math.hypot(predicted.velocity.x, predicted.velocity.z);
    if (predicted.grounded && speed > 1 && !paused) {
      footsteps += dt * speed;
      if (footsteps > 2.2) { footsteps = 0; audio.play(Math.random() > 0.5 ? 'footstep1' : 'footstep2', undefined, undefined, 0, 0.11); }
    } else footsteps = 0;
  } else if (world && screen === 'entry') {
    const size = world.config.size;
    const angle = now * 0.000012;
    camera.position.set(size * 0.51 + Math.sin(angle) * 15, Math.min(world.config.height - 3, 48), size * 0.59 + Math.cos(angle) * 11);
    camera.lookAt(size * 0.44, 19, size * 0.36);
    camera.fov = THREE.MathUtils.damp(camera.fov, 69, 5, dt); target.visible = false;
  }
  camera.updateProjectionMatrix();
  if (world && (screen === 'entry' || screen === 'game')) {
    snow.update(dt, camera.position, world, camera.getWorldDirection(cameraForward));
    shadows.update();
  }
  if (screen !== 'lobby') terrain?.update(camera.position);
  if (terrain?.stats.error && !renderErrorShown) { renderErrorShown = true; toast(terrain.stats.error); refreshKitButtons(); if (screen === 'game') { document.exitPointerLock(); setPaused(true); } }
  avatars.update(interpolatePlayers(now), localId, now / 1000, camera);
  effects.update(dt, now / 1000);
  renderer.setClearAlpha(screen === 'lobby' ? 0 : 1);
  renderer.clear();
  if (screen !== 'lobby') renderer.render(scene, camera);
  if (screen === 'lobby') {
    for (const preview of document.querySelectorAll<HTMLElement>('[data-preview]')) {
      weaponView.renderKitPreview(renderer, now / 1000, KITS[preview.dataset.preview as Kit][0], preview.getBoundingClientRect());
    }
  } else if (screen === 'game' && local?.alive) {
    weaponView.render(renderer, camera);
  }
  if (now - lastUI > 160) { lastUI = now; updateUI(); }
  drawMap();
  while (feed.length && feed[0].expires < now) feed.shift()?.text.remove();
  if (socket?.readyState === WebSocket.OPEN && now - lastPing > 2000) { lastPing = now; send({ type: 'ping', time: now }); }
  if (!socket && now - lastStatusPoll > 6000) void pollStatus();
}

element('join-form').addEventListener('submit', (event) => { event.preventDefault(); audio.activate(); connect(); });
element('reconnect-button').addEventListener('click', connect);
element('back-button').addEventListener('click', returnHome);
element('leave-button').addEventListener('click', returnHome);
element('resume-button').addEventListener('click', lockPointer);
for (const card of document.querySelectorAll<HTMLButtonElement>('[data-kit]')) card.addEventListener('click', () => spawnKit(card.dataset.kit as Kit));
sensitivityInput.addEventListener('input', () => {
  sensitivity = Number(sensitivityInput.value); remember('sensitivity', String(sensitivity));
  element('sensitivity-value').textContent = sensitivity.toFixed(2);
});
zoomSensitivityInput.addEventListener('input', () => {
  zoomSensitivity = Number(zoomSensitivityInput.value); remember('zoom-sensitivity', String(zoomSensitivity));
  element('zoom-sensitivity-value').textContent = zoomSensitivity.toFixed(2);
});
audioVolumeInput.addEventListener('input', () => {
  audioVolume = Number(audioVolumeInput.value); remember('audio-volume', String(audioVolume)); audio.setVolume(audioVolume);
  element('audio-volume-value').textContent = String(Math.round(audioVolume * 100));
});
element('options-button').addEventListener('click', () => { element('options-panel').hidden = false; element('graphics-panel').hidden = true; });
element('graphics-button').addEventListener('click', () => { element('graphics-panel').hidden = false; element('options-panel').hidden = true; });
for (const button of document.querySelectorAll('[data-close-settings]')) button.addEventListener('click', () => {
  element('options-panel').hidden = true; element('graphics-panel').hidden = true;
});
for (const key of ['snow', 'shadows', 'ssaa'] as const) element<HTMLInputElement>(`graphics-${key}`).addEventListener('change', event => {
  graphics[key] = (event.target as HTMLInputElement).checked;
  remember(key, String(graphics[key]));
  applyGraphics();
});
document.addEventListener('pointerlockchange', () => {
  if (screen === 'game') setPaused(document.pointerLockElement !== canvas);
  else clearInput();
});
document.addEventListener('pointerlockerror', () => {
  if (screen === 'game') setPaused(true);
  toast('Ce navigateur a refusé la capture de la souris. Ouvrez le jeu dans Chrome, Firefox ou Edge.');
});
document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== canvas || screen !== 'game' || paused) return;
  const zoom = rightMouse && (selectedWeapon === 'awp' || selectedWeapon === 'ak47');
  const speed = zoom ? zoomSensitivity * (selectedWeapon === 'awp' ? 0.3 : 0.9) * Math.PI / 1440 : sensitivity * Math.PI / 720;
  weaponMouseDX += event.movementX; weaponMouseDY += event.movementY;
  yaw -= event.movementX * speed;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  pitch = Math.max(-Math.PI * 89 / 180, Math.min(Math.PI * 89 / 180, pitch - event.movementY * speed));
});
document.addEventListener('keydown', (event) => {
  if (screen !== 'game' || event.target instanceof HTMLInputElement) return;
  if (event.code === 'F1') { event.preventDefault(); muted = !muted; audio.setEnabled(!muted && !paused && document.hasFocus()); updateUI(); return; }
  if (event.code === 'Tab') { event.preventDefault(); if (!paused) element('score-screen').hidden = false; return; }
  if (event.code === 'Escape') { clearInput(); if (document.pointerLockElement !== canvas) setPaused(true); return; }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) { event.preventDefault(); if (!paused) keys.add(event.code); }
});
document.addEventListener('keyup', (event) => { keys.delete(event.code); if (event.code === 'Tab') { event.preventDefault(); element('score-screen').hidden = true; } });
document.addEventListener('mousedown', (event) => {
  if (document.pointerLockElement !== canvas || screen !== 'game' || paused) return;
  if (event.button === 0) fireButton.set(true);
  if (event.button === 2) { rightMouse = true; altButton.set(true); }
});
document.addEventListener('mouseup', (event) => {
  if (event.button === 0) fireButton.set(false);
  if (event.button === 2) { rightMouse = false; altButton.set(false); }
});
document.addEventListener('contextmenu', (event) => { if (screen === 'game') event.preventDefault(); });
document.addEventListener('wheel', (event) => {
  if (screen !== 'game' || paused || document.pointerLockElement !== canvas) return;
  event.preventDefault();
  const kit = KITS[selectedKit];
  if (!event.deltaY) return;
  selectedWeapon = kit[(kit.indexOf(selectedWeapon) + (event.deltaY < 0 ? 1 : -1) + kit.length) % kit.length];
  weaponView.setWeapon(selectedWeapon); updateUI();
}, { passive: false });
window.addEventListener('blur', () => { clearInput(); audio.setEnabled(false); if (screen === 'game') { document.exitPointerLock(); setPaused(true); } });
document.addEventListener('visibilitychange', () => { clearInput(); lastFrame = performance.now(); accumulator = 0; if (document.hidden) audio.setEnabled(false); });
window.addEventListener('resize', () => { applyGraphics(); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); document.documentElement.style.setProperty('--kit-scale', String(Math.min(1, innerWidth / 1200))); });
canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); disconnect('Le contexte graphique a été perdu. Rechargez la page pour retrouver le terrain.'); });

void pollStatus();
document.body.dataset.screen = 'entry';
document.documentElement.style.setProperty('--kit-scale', String(Math.min(1, innerWidth / 1200)));
requestAnimationFrame(frame);
