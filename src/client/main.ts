import * as THREE from 'three';
import './styles.css';
import { DT, KITS, PROTOCOL_VERSION, WEAPONS, type ClientMessage, type GameEvent, type InputFrame, type Kit, type Mode, type MotionState, type PlayerState, type ProjectileState, type ServerMessage, type WeaponId, type WorldConfig } from '../shared/protocol';
import { aimDirection, EYE_HEIGHT, movePlayer } from '../shared/movement';
import { raycast, VoxelWorld } from '../shared/voxel';
import { decodeServerMessage } from '../shared/wire';
import { TerrainRenderer } from './terrain';
import { Effects, GameAudio, PlayerVisuals, teamColor, WeaponView } from './presentation';

const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const kitNames: Record<Kit, string> = { assault: 'ASSAUT', sniper: 'SNIPER', medic: 'MÉDECIN' };
const modeNames: Record<Mode, string> = { tdm: 'TEAM DEATHMATCH', ffa: 'CHACUN POUR SOI' };
const teamName = (team: number): string => team === 1 ? 'ÉQUIPE ROUGE' : team === 2 ? 'ÉQUIPE BLEUE' : 'CHACUN POUR SOI';
const canvas = element<HTMLCanvasElement>('viewport');
const nickname = element<HTMLInputElement>('nickname');
const joinButton = element<HTMLButtonElement>('join-button');
const deployButton = element<HTMLButtonElement>('deploy-button');
const sensitivityInput = element<HTMLInputElement>('sensitivity');
const distanceInput = element<HTMLInputElement>('view-distance');

function remember(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(`ubercube.${key}`, value);
    return localStorage.getItem(`ubercube.${key}`) ?? '';
  } catch { return value ?? ''; }
}

nickname.value = remember('name');
let sensitivity = Math.min(2.5, Math.max(0.25, Number(remember('sensitivity')) || 1));
let viewDistance = Math.min(256, Math.max(64, Number(remember('distance')) || 160));
sensitivityInput.value = String(sensitivity);
distanceInput.value = String(viewDistance);
element('sensitivity-value').textContent = sensitivity.toFixed(2);
element('distance-value').textContent = `${viewDistance} blocs`;

const renderer = (() => {
  try { return new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
  catch (error) {
    element('join-error').textContent = 'Le rendu 3D est indisponible. Activez l’accélération graphique de votre navigateur puis rechargez la page.';
    joinButton.disabled = true;
    throw error;
  }
})();
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.autoClear = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc3d3cb);
scene.fog = new THREE.Fog(0xc3d3cb, viewDistance * 0.58, viewDistance * 1.14);
scene.add(new THREE.HemisphereLight(0xf4ffe1, 0x475d45, 2.3));
const sun = new THREE.DirectionalLight(0xffe4be, 2.5);
sun.position.set(-80, 140, -50);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.05, 1100);
camera.rotation.order = 'YXZ';
const avatars = new PlayerVisuals(scene);
const effects = new Effects(scene);
const weaponView = new WeaponView();
const audio = new GameAudio();
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
let worldReady = false;
let revision = 0;
let local: PlayerState | null = null;
let predicted: MotionState | null = null;
const correctionOffset = new THREE.Vector3();
let players: PlayerState[] = [];
let projectiles: ProjectileState[] = [];
const snapshots: { time: number; players: PlayerState[] }[] = [];
let pending: InputFrame[] = [];
let unsent: InputFrame[] = [];
let sequence = 0;
let yaw = 0;
let pitch = 0;
let paused = false;
let spawning = false;
let connecting = false;
let rightMouse = false;
let leftMouse = false;
let ping: number | null = null;
let lastPing = 0;
let lastStatusPoll = 0;
let statusBusy = false;
let lastUI = 0;
let lastMap = 0;
let lastFrame = performance.now();
let accumulator = 0;
let footsteps = 0;
let renderErrorShown = false;
let toastTimer = 0;
let spawnTimer = 0;
let connectionTimer = 0;
const keys = new Set<string>();
const minimap = element<HTMLCanvasElement>('minimap');
const mapContext = minimap.getContext('2d')!;
const minimapTerrain = document.createElement('canvas');
minimapTerrain.width = 180; minimapTerrain.height = 180;
const minimapContext = minimapTerrain.getContext('2d')!;
let mapCenterX = 0;
let mapCenterZ = 0;
const mapRadius = 48;
const feed: { text: HTMLElement; expires: number }[] = [];

function toast(message: string): void {
  element('toast').textContent = message;
  element('toast').hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element('toast').hidden = true; }, 3800);
}

function clearInput(): void {
  keys.clear(); leftMouse = false; rightMouse = false;
  element('score-screen').hidden = true;
}

function showScreen(next: Screen): void {
  screen = next;
  document.body.classList.toggle('playing', next === 'game');
  element('entry-screen').hidden = next !== 'entry';
  element('lobby-screen').hidden = next !== 'lobby';
  element('game-hud').hidden = next !== 'game';
  element('disconnect-screen').hidden = next !== 'disconnected';
  element('pause-screen').hidden = true;
  paused = false;
  clearInput();
  if (next !== 'game' && document.pointerLockElement === canvas) document.exitPointerLock();
  audio.setEnabled(next === 'game' && document.hasFocus());
  if (next === 'lobby') weaponView.setWeapon(KITS[selectedKit][0]);
}

function setPaused(value: boolean): void {
  if (screen !== 'game') return;
  paused = value;
  element('pause-screen').hidden = !value;
  clearInput();
  audio.setEnabled(!value && document.hasFocus());
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
  sequence = 0; accumulator = 0;
  clearInput();
}

function setWorld(config: WorldConfig): void {
  world = new VoxelWorld(config);
  if (terrain) terrain.reset(world);
  else terrain = new TerrainRenderer(scene, world, viewDistance);
  renderErrorShown = false;
  camera.position.set(config.size * 0.56, Math.min(config.height - 2, 47), config.size * 0.58);
  camera.lookAt(config.size * 0.43, 18, config.size * 0.35);
  terrain.update(camera.position);
  element('world-label').textContent = `SECTEUR ${config.seed.toString(16).toUpperCase()} / ${config.size} × ${config.size}`;
  lastMap = 0;
}

function disconnect(reason: string): void {
  const previous = socket; socket = null;
  previous?.close();
  window.clearTimeout(connectionTimer); window.clearTimeout(spawnTimer);
  connecting = false; spawning = false; worldReady = false;
  joinButton.disabled = false;
  joinButton.querySelector('span')!.textContent = 'REJOINDRE LE LOBBY';
  resetPrediction();
  avatars.clear(); effects.clear(); players = []; projectiles = []; local = null;
  element('disconnect-reason').textContent = reason;
  element('connection-dot').classList.remove('online');
  element('server-state').textContent = 'SIGNAL INTERROMPU';
  showScreen('disconnected');
}

function returnHome(): void {
  const previous = socket; socket = null; previous?.close();
  window.clearTimeout(connectionTimer); window.clearTimeout(spawnTimer);
  connecting = false; spawning = false; worldReady = false; localId = -1; local = null;
  resetPrediction(); avatars.clear(); effects.clear(); players = []; projectiles = [];
  joinButton.disabled = false; joinButton.querySelector('span')!.textContent = 'REJOINDRE LE LOBBY';
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
  players = []; projectiles = []; resetPrediction(); avatars.clear(); effects.clear();
  joinButton.disabled = true;
  joinButton.querySelector('span')!.textContent = 'CONNEXION EN COURS';
  showScreen('entry');
  const connection = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
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

function refreshDeploy(): void {
  const renderingFailed = !!terrain?.stats.error;
  deployButton.disabled = !worldReady || spawning || renderingFailed;
  deployButton.querySelector('span')!.textContent = renderingFailed ? 'TERRAIN INDISPONIBLE' : spawning ? 'DÉPLOIEMENT EN COURS' : worldReady ? (local?.deaths ? 'RETOURNER AU COMBAT' : 'ENTRER EN JEU') : 'CHARGEMENT DU TERRAIN';
}

function receive(message: ServerMessage): void {
  if (message.type === 'welcome') {
    localId = message.id; roundId = message.roundId; mode = message.mode; maxPlayers = message.maxPlayers;
    worldReady = false; revision = 0; connecting = false;
    setWorld(message.world);
    element('player-name').textContent = nickname.value;
    element('connection-dot').classList.add('online');
    element('server-state').textContent = 'SERVEUR EN LIGNE';
    element('server-mode').textContent = modeNames[mode];
    element('lobby-mode').textContent = modeNames[mode];
    element('match-mode').textContent = mode.toUpperCase();
    element('score-mode-label').textContent = `/ ${modeNames[mode]}`;
    element('tdm-scores').hidden = mode !== 'tdm'; element('ffa-score').hidden = mode !== 'ffa';
    element('lobby-eyebrow').textContent = 'ÉQUIPEMENT DE DÉPART';
    element('lobby-description').textContent = 'Le terrain est ouvert. À vous de choisir comment y entrer.';
    showScreen('lobby'); refreshDeploy();
    return;
  }
  if (message.type === 'error') {
    if (spawning && screen === 'lobby' && document.pointerLockElement === canvas) document.exitPointerLock();
    spawning = false; window.clearTimeout(spawnTimer); refreshDeploy();
    if (message.fatal) disconnect(message.message);
    else { toast(message.message); if (screen === 'entry') element('join-error').textContent = message.message; }
    return;
  }
  if (message.type === 'pong') { ping = Math.max(0, Math.round(performance.now() - message.time)); return; }
  if (message.type === 'reset') {
    roundId = message.roundId; revision = 0; worldReady = false; spawning = false;
    window.clearTimeout(spawnTimer);
    resetPrediction(); local = null; players = []; projectiles = []; avatars.clear(); effects.clear();
    setWorld(message.world);
    element('lobby-eyebrow').textContent = 'NOUVELLE MANCHE';
    element('lobby-description').textContent = 'Le terrain est réinitialisé. Un nouveau départ pour tout le monde.';
    showScreen('lobby'); refreshDeploy();
    toast('Nouvelle manche. Choisissez votre équipement.');
    return;
  }
  if (message.roundId !== roundId) return;
  if (message.type === 'world') {
    if (!world || !terrain) return;
    if (!message.initial && message.revision <= revision) return;
    if (!message.initial && message.revision !== revision + 1) { disconnect('Une mise à jour du terrain manque. Reconnectez-vous pour synchroniser la carte.'); return; }
    terrain.applyEdits(message.edits);
    revision = message.revision;
    if (message.complete) {
      worldReady = true; window.clearTimeout(connectionTimer);
      refreshDeploy();
    }
    return;
  }
  if (message.type === 'snapshot') {
    players = message.players;
    projectiles = message.projectiles;
    const now = performance.now();
    snapshots.push({ time: now, players: message.players });
    while (snapshots.length > 15) snapshots.shift();
    const authoritative = players.find((player) => player.id === localId);
    if (authoritative) applyLocalState(authoritative);
    element('red-score').textContent = String(message.scores[0]);
    element('blue-score').textContent = String(message.scores[1]);
    element('personal-kills').textContent = String(local?.kills ?? 0);
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
    element('damage-overlay').style.opacity = String(Math.min(1, (oldHealth - state.health) / 35));
    window.setTimeout(() => { element('damage-overlay').style.opacity = '0'; }, 220);
  }
  if (state.alive && !wasAlive) {
    spawning = false; window.clearTimeout(spawnTimer); clearInput();
    selectedKit = state.kit; selectedWeapon = state.weapon;
    yaw = state.yaw; pitch = state.pitch;
    pending = []; unsent = []; accumulator = 0;
    showScreen('game'); weaponView.setWeapon(selectedWeapon);
    updateUI();
    if (document.pointerLockElement !== canvas) setPaused(true);
    else audio.setEnabled(true);
  } else if (!state.alive && wasAlive) {
    pending = []; unsent = []; accumulator = 0;
    element('lobby-eyebrow').textContent = 'RETOUR AU COMBAT';
    element('lobby-description').textContent = `${state.kills} élimination${state.kills === 1 ? '' : 's'} · ${state.deaths} mort${state.deaths === 1 ? '' : 's'}. Changez d’approche ou repartez avec votre kit.`;
    showScreen('lobby'); refreshDeploy();
  }
  element('player-team').textContent = teamName(state.team);
  element('team-dot').style.background = teamColor(state.team);
  element('hud-team').textContent = teamName(state.team);
  element('hud-team').style.color = teamColor(state.team);
}

function handleEvent(event: GameEvent): void {
  effects.event(event);
  const listener = predicted ? { ...predicted.position, y: predicted.position.y + EYE_HEIGHT } : camera.position;
  const own = event.shooterId === localId;
  if (event.event === 'shot') {
    if (own) weaponView.kick();
    const file = event.weapon === 'awp' ? 'AWPShoot' : event.weapon === 'ak47' ? 'AK47Shoot' : event.weapon === 'shovel' ? 'dig' : '';
    if (file) audio.play(file, own ? undefined : event.position, listener, yaw, event.weapon === 'awp' ? 0.44 : 0.25);
  }
  if (event.event === 'explosion') audio.play('waterexplode', event.position, listener, yaw, 0.55);
  if (event.event === 'build') audio.play('place', event.position, listener, yaw, 0.4);
  if (event.event === 'impact' && event.weapon === 'shovel') audio.play('dig', event.position, listener, yaw, 0.3);
  if ((event.event === 'impact' || event.event === 'death') && own && event.targetId !== undefined) {
    audio.play('playerhit', undefined, undefined, 0, 0.4);
    element('hitmarker').hidden = false;
    window.setTimeout(() => { element('hitmarker').hidden = true; }, 130);
  }
  if (event.event === 'heal' && (event.targetId === localId || own)) toast(event.targetId === localId ? 'Soins reçus' : 'Soins appliqués');
  if (event.event === 'death') {
    const shooter = players.find((player) => player.id === event.shooterId);
    const victim = players.find((player) => player.id === event.targetId);
    const row = document.createElement('div');
    const source = document.createElement('b'); source.textContent = shooter?.name ?? 'Le terrain'; source.style.color = teamColor(shooter?.team ?? 0);
    const tool = document.createElement('span'); tool.textContent = event.headshot ? '⌖' : event.weapon ? WEAPONS[event.weapon].name : '→';
    const destination = document.createElement('b'); destination.textContent = victim?.name ?? 'Joueur'; destination.style.color = teamColor(victim?.team ?? 0);
    row.append(source, tool, destination); element('kill-feed').append(row);
    feed.push({ text: row, expires: performance.now() + 6500 });
    if (feed.length > 5) feed.shift()?.text.remove();
  }
}

async function pollStatus(): Promise<void> {
  if (socket || connecting || statusBusy) return;
  lastStatusPoll = performance.now(); statusBusy = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unavailable');
    const status = await response.json() as { mode: Mode; maxPlayers: number; players: number; world: WorldConfig; roundId: number };
    if (socket || connecting) return;
    mode = status.mode; maxPlayers = status.maxPlayers;
    if (!world || JSON.stringify(world.config) !== JSON.stringify(status.world)) setWorld(status.world);
    element('server-mode').textContent = modeNames[mode];
    element('entry-mode').textContent = mode.toUpperCase();
    element('population').textContent = `${status.players} / ${maxPlayers} joueurs en ligne`;
    element('server-state').textContent = 'SERVEUR EN LIGNE';
    element('connection-dot').classList.add('online');
    element('join-form').querySelector('p')!.innerHTML = mode === 'tdm' ? 'Pas de compte. Pas d’attente.<br />Votre équipe vous attend sur le terrain.' : 'Pas de compte. Pas d’attente.<br />Un terrain. Chacun pour soi.';
  } catch {
    if (socket || connecting) return;
    element('server-state').textContent = 'SERVEUR INJOIGNABLE';
    element('population').textContent = 'Serveur indisponible pour le moment';
    element('connection-dot').classList.remove('online');
  } finally { statusBusy = false; }
}

function chooseKit(kit: Kit): void {
  selectedKit = kit;
  selectedWeapon = KITS[kit][0];
  for (const card of document.querySelectorAll<HTMLButtonElement>('[data-kit]')) {
    const chosen = card.dataset.kit === kit;
    card.classList.toggle('selected', chosen); card.setAttribute('aria-pressed', String(chosen));
  }
  element('preview-kit-name').textContent = kitNames[kit];
  element('preview-weapon-name').textContent = WEAPONS[KITS[kit][0]].name.toUpperCase();
  weaponView.setWeapon(selectedWeapon);
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
    fire: active && leftMouse, alt: active && rightMouse, weapon: selectedWeapon,
  };
  const groundedBefore = predicted.grounded;
  movePlayer(predicted, frame, world);
  if (groundedBefore && !predicted.grounded && frame.jump) audio.play('jump', undefined, undefined, 0, 0.13);
  if (!groundedBefore && predicted.grounded) audio.play('land', undefined, undefined, 0, 0.13);
  pending.push(frame); unsent.push(frame);
  if (unsent.length >= 3) {
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
  element('lobby-population').textContent = `${players.length} / ${maxPlayers}`;
  if (local) {
    element('health-value').textContent = String(Math.max(0, local.health));
    element('health-fill').style.width = `${Math.max(0, local.health)}%`;
    element('health-fill').style.background = local.health < 30 ? '#ff7864' : '#f3f0e6';
    element('hud-kit').textContent = kitNames[selectedKit];
    element('hud-weapon').textContent = WEAPONS[selectedWeapon].name.toUpperCase();
    element('ammo-value').textContent = selectedWeapon === 'grenade' ? String(local.grenades) : selectedWeapon === 'medic' ? '+' : selectedWeapon === 'shovel' ? '∞' : local.weapon === selectedWeapon ? String(local.ammo) : '—';
    element('ammo-max').textContent = selectedWeapon === 'grenade' ? '/ 10' : selectedWeapon === 'medic' ? 'SOINS' : selectedWeapon === 'shovel' ? 'BLOCS' : `/ ${WEAPONS[selectedWeapon].magazine}`;
    element('weapon-help').textContent = selectedWeapon === 'shovel' ? 'GAUCHE  CREUSER  ·  DROITE  POSER' : selectedWeapon === 'grenade' ? 'MAINTENIR  CHARGER  ·  RELÂCHER  LANCER' : selectedWeapon === 'medic' ? 'CLIC GAUCHE  SOIGNER UN JOUEUR' : 'CLIC DROIT  VISER  ·  MOLETTE  CHANGER';
  }
  element('hud-network').textContent = `${players.length} JOUEURS  ·  ${ping === null ? '—' : ping} MS`;
  if (!element('score-screen').hidden) {
    const rows = players.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map((player) => {
      const row = document.createElement('tr');
      if (player.id === localId) row.className = 'self';
      const name = document.createElement('td'); name.textContent = player.name; name.style.color = teamColor(player.team);
      const team = document.createElement('td'); team.textContent = mode === 'ffa' ? '—' : player.team === 1 ? 'ROUGE' : 'BLEUE';
      const kills = document.createElement('td'); kills.textContent = String(player.kills);
      const deaths = document.createElement('td'); deaths.textContent = String(player.deaths);
      row.append(name, team, kills, deaths); return row;
    });
    element('score-rows').replaceChildren(...rows);
  }
  refreshDeploy();
}

function drawMap(now: number): void {
  if (!world || !predicted || screen !== 'game') return;
  if (now - lastMap > 700) {
    lastMap = now; mapCenterX = predicted.position.x; mapCenterZ = predicted.position.z;
    for (let y = 0; y < 180; y += 6) for (let x = 0; x < 180; x += 6) {
      const wx = Math.floor(mapCenterX + (x / 180 - 0.5) * mapRadius * 2);
      const wz = Math.floor(mapCenterZ + (y / 180 - 0.5) * mapRadius * 2);
      const top = world.surfaceY(wx, wz);
      const value = world.get(wx, top - 1, wz);
      const shade = 0.6 + top / 70;
      minimapContext.fillStyle = value ? `rgb(${Math.min(255, ((value >>> 16) & 255) * shade)},${Math.min(255, ((value >>> 8) & 255) * shade)},${Math.min(255, (value & 255) * shade)})` : '#263b31';
      minimapContext.fillRect(x, y, 6, 6);
    }
  }
  mapContext.drawImage(minimapTerrain, 0, 0);
  mapContext.strokeStyle = '#dce7c220'; mapContext.lineWidth = 1;
  for (let i = 30; i < 180; i += 30) { mapContext.beginPath(); mapContext.moveTo(i, 0); mapContext.lineTo(i, 180); mapContext.moveTo(0, i); mapContext.lineTo(180, i); mapContext.stroke(); }
  for (const player of players) {
    if (!player.alive || player.id === localId) continue;
    const x = 90 + (player.position.x - mapCenterX) * 90 / mapRadius;
    const y = 90 + (player.position.z - mapCenterZ) * 90 / mapRadius;
    if (x < 3 || y < 3 || x > 177 || y > 177) continue;
    mapContext.fillStyle = teamColor(player.team); mapContext.fillRect(x - 2, y - 2, 4, 4);
  }
  mapContext.save();
  mapContext.translate(90 + (predicted.position.x - mapCenterX) * 90 / mapRadius, 90 + (predicted.position.z - mapCenterZ) * 90 / mapRadius);
  mapContext.rotate(-yaw);
  mapContext.beginPath(); mapContext.moveTo(0, -7); mapContext.lineTo(5, 5); mapContext.lineTo(0, 3); mapContext.lineTo(-5, 5); mapContext.closePath();
  mapContext.fillStyle = '#fff5de'; mapContext.fill(); mapContext.strokeStyle = '#1b2a1b'; mapContext.stroke(); mapContext.restore();
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  accumulator += dt;
  while (accumulator >= DT) { simulate(); accumulator -= DT; }
  correctionOffset.multiplyScalar(Math.exp(-25 * dt));
  if (screen === 'game' && predicted) {
    camera.position.set(predicted.position.x, predicted.position.y + EYE_HEIGHT, predicted.position.z).add(correctionOffset);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const zoom = rightMouse && !paused && (selectedWeapon === 'awp' || selectedWeapon === 'ak47');
    camera.fov = THREE.MathUtils.damp(camera.fov, zoom ? selectedWeapon === 'awp' ? 24 : 55 : 76, 15, dt);
    element('scope').hidden = !(zoom && selectedWeapon === 'awp');
    element('crosshair').hidden = zoom && selectedWeapon === 'awp';
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
  } else if (world) {
    const size = world.config.size;
    const angle = now * 0.000012;
    camera.position.set(size * 0.51 + Math.sin(angle) * 15, Math.min(world.config.height - 3, 48), size * 0.59 + Math.cos(angle) * 11);
    camera.lookAt(size * 0.44, 19, size * 0.36);
    camera.fov = THREE.MathUtils.damp(camera.fov, 69, 5, dt); target.visible = false;
  }
  camera.updateProjectionMatrix();
  terrain?.update(camera.position);
  if (terrain?.stats.error && !renderErrorShown) { renderErrorShown = true; toast(terrain.stats.error); refreshDeploy(); if (screen === 'game') { document.exitPointerLock(); setPaused(true); } }
  avatars.update(interpolatePlayers(now), localId, now / 1000, camera);
  effects.update(dt, projectiles, now / 1000);
  renderer.clear(); renderer.render(scene, camera);
  if (screen === 'lobby' || screen === 'game' && local?.alive && !(selectedWeapon === 'awp' && rightMouse && !paused)) {
    weaponView.render(renderer, now / 1000, dt, screen === 'lobby', predicted ? Math.hypot(predicted.velocity.x, predicted.velocity.z) : 0, rightMouse && !paused);
  }
  if (now - lastUI > 160) { lastUI = now; updateUI(); }
  drawMap(now);
  while (feed.length && feed[0].expires < now) feed.shift()?.text.remove();
  if (socket?.readyState === WebSocket.OPEN && now - lastPing > 2000) { lastPing = now; send({ type: 'ping', time: now }); }
  if (!socket && now - lastStatusPoll > 6000) void pollStatus();
}

element('join-form').addEventListener('submit', (event) => { event.preventDefault(); audio.activate(); connect(); });
element('reconnect-button').addEventListener('click', connect);
element('back-button').addEventListener('click', returnHome);
element('leave-button').addEventListener('click', returnHome);
element('resume-button').addEventListener('click', lockPointer);
for (const card of document.querySelectorAll<HTMLButtonElement>('[data-kit]')) card.addEventListener('click', () => chooseKit(card.dataset.kit as Kit));
deployButton.addEventListener('click', () => {
  if (!worldReady || spawning || terrain?.stats.error) return;
  spawning = true; refreshDeploy(); audio.activate();
  lockPointer();
  if (!send({ type: 'spawn', roundId, kit: selectedKit })) { spawning = false; refreshDeploy(); return; }
  window.clearTimeout(spawnTimer);
  spawnTimer = window.setTimeout(() => { if (spawning) { spawning = false; document.exitPointerLock(); refreshDeploy(); toast('Le déploiement n’a pas été confirmé. Réessayez.'); } }, 6000);
});
sensitivityInput.addEventListener('input', () => {
  sensitivity = Number(sensitivityInput.value); remember('sensitivity', String(sensitivity));
  element('sensitivity-value').textContent = sensitivity.toFixed(2);
});
distanceInput.addEventListener('input', () => { element('distance-value').textContent = `${distanceInput.value} blocs`; });
distanceInput.addEventListener('change', () => {
  viewDistance = Number(distanceInput.value); remember('distance', String(viewDistance));
  scene.fog = new THREE.Fog(0xc3d3cb, viewDistance * 0.58, viewDistance * 1.14);
  if (world) { terrain?.dispose(); terrain = new TerrainRenderer(scene, world, viewDistance); terrain.update(camera.position); renderErrorShown = false; }
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
  const multiplier = rightMouse && selectedWeapon === 'awp' ? 0.3 : rightMouse && selectedWeapon === 'ak47' ? 0.85 : 1;
  yaw -= event.movementX * sensitivity * 0.002 * multiplier;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  pitch = Math.max(-1.54, Math.min(1.54, pitch - event.movementY * sensitivity * 0.002 * multiplier));
});
document.addEventListener('keydown', (event) => {
  if (screen !== 'game' || event.target instanceof HTMLInputElement) return;
  if (event.code === 'Tab') { event.preventDefault(); if (!paused) element('score-screen').hidden = false; return; }
  if (event.code === 'Escape') { clearInput(); if (document.pointerLockElement !== canvas) setPaused(true); return; }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) { event.preventDefault(); if (!paused) keys.add(event.code); }
});
document.addEventListener('keyup', (event) => { keys.delete(event.code); if (event.code === 'Tab') { event.preventDefault(); element('score-screen').hidden = true; } });
document.addEventListener('mousedown', (event) => {
  if (document.pointerLockElement !== canvas || screen !== 'game' || paused) return;
  if (event.button === 0) leftMouse = true;
  if (event.button === 2) rightMouse = true;
});
document.addEventListener('mouseup', (event) => { if (event.button === 0) leftMouse = false; if (event.button === 2) rightMouse = false; });
document.addEventListener('contextmenu', (event) => { if (screen === 'game') event.preventDefault(); });
document.addEventListener('wheel', (event) => {
  if (screen !== 'game' || paused || document.pointerLockElement !== canvas) return;
  event.preventDefault();
  const kit = KITS[selectedKit];
  selectedWeapon = kit[(kit.indexOf(selectedWeapon) + (event.deltaY > 0 ? 1 : -1) + kit.length) % kit.length];
  leftMouse = false; rightMouse = false; weaponView.setWeapon(selectedWeapon); updateUI();
}, { passive: false });
window.addEventListener('blur', () => { clearInput(); audio.setEnabled(false); if (screen === 'game') { document.exitPointerLock(); setPaused(true); } });
document.addEventListener('visibilitychange', () => { clearInput(); lastFrame = performance.now(); accumulator = 0; if (document.hidden) audio.setEnabled(false); });
window.addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); disconnect('Le contexte graphique a été perdu. Rechargez la page pour retrouver le terrain.'); });

void pollStatus();
requestAnimationFrame(frame);
