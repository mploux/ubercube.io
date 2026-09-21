import * as THREE from 'three';
import { WeaponView, type WeaponViewInput } from '../../src/client/weapon-view';
import { PlayerVisuals } from '../../src/client/player-visuals';
import { RocketVisuals } from '../../src/client/rocket-visuals';
import { EYE_HEIGHT } from '../../src/shared/movement';
import { getWeaponMuzzle } from '../../src/shared/weapon-pose';
import type { GameEvent, PlayerState } from '../../src/shared/protocol';

type View = 'fps-idle' | 'fps-aim' | 'awp-aim' | 'third-idle' | 'third-aim' | 'shot' | 'third-shot20' | 'third-shot45';
type Angle = 'quarter' | 'profile' | 'left' | 'front';
const labels: Record<View, string> = { 'fps-idle': 'PREMIÈRE PERSONNE · REPOS', 'fps-aim': 'PREMIÈRE PERSONNE · VISÉE',
  'third-idle': 'TROISIÈME PERSONNE · REPOS', 'third-aim': 'TROISIÈME PERSONNE · VISÉE', shot: 'ROQUETTE DÉTACHÉE · DÉPART DU TIR',
  'awp-aim': 'COMPARAISON AWP · VISÉE', 'third-shot20': 'ROQUETTE DÉTACHÉE · PROFIL À 20 ms', 'third-shot45': 'ROQUETTE DÉTACHÉE · PROFIL À 45 ms' };
const angleLabels: Record<Angle, string> = { quarter: 'TROIS-QUARTS', profile: 'PROFIL DROIT', left: 'PROFIL GAUCHE', front: 'FACE' };
const output = document.getElementById('capture') as HTMLCanvasElement;
const context = output.getContext('2d')!;
const status = document.getElementById('status')!;
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('render') as HTMLCanvasElement, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(1280, 720, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xabc1ce);
const camera = new THREE.PerspectiveCamera(70, 1280 / 720, .05, 1000);
const portrait = new THREE.OrthographicCamera(-3.35, 3.35, 1.884375, -1.884375, .05, 1000);
const weapon = new WeaponView();
const players = new PlayerVisuals(scene, 160);
const rockets = new RocketVisuals(scene, 160, 8, 1024);
const player: PlayerState = { id: 1, name: '', team: 1, kit: 'assault', weapon: 'rpg', aiming: false,
  position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
  grounded: true, alive: true, health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0 };
const input: WeaponViewInput = { moveX: 0, moveZ: 0, sprint: false, fire: false, alt: false, lookDeltaYaw: 0, lookDeltaPitch: 0, grenades: 10 };
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0x788b86 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -.04; scene.add(floor);
const grid = new THREE.GridHelper(40, 40, 0x59736f, 0x8fa39b); grid.position.y = -.02; scene.add(grid);
const boardCanvas = document.createElement('canvas'); boardCanvas.width = boardCanvas.height = 512;
const boardContext = boardCanvas.getContext('2d')!;
boardContext.fillStyle = '#eee6cb'; boardContext.fillRect(0, 0, 512, 512);
boardContext.strokeStyle = '#ad3333'; boardContext.lineWidth = 14;
for (const radius of [180, 120, 60]) { boardContext.beginPath(); boardContext.arc(256, 256, radius, 0, Math.PI * 2); boardContext.stroke(); }
boardContext.fillStyle = '#ad3333'; boardContext.fillRect(248, 248, 16, 16);
boardContext.fillStyle = '#343d45'; boardContext.font = 'bold 28px Arial'; boardContext.textAlign = 'center'; boardContext.fillText('CIBLE · 16 m', 256, 40);
const target = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(boardCanvas), side: THREE.DoubleSide }));
target.position.set(0, EYE_HEIGHT, -16); scene.add(target);
const scope = new Image(); scope.src = '/assets/ui/awp_crosshair.png';
let view: View = 'fps-idle', angle: Angle = 'quarter';

function render(next: View): void {
  view = next;
  const sideShot = view.startsWith('third-shot');
  const first = view.startsWith('fps') || view === 'shot' || view === 'awp-aim', aiming = view.endsWith('aim') || sideShot;
  weapon.reset(view === 'awp-aim' ? 'awp' : 'rpg');
  for (let index = 0; index < 90; index++) weapon.tick({ ...input, alt: aiming }, () => .5);
  rockets.clear(); players.clear();
  player.aiming = aiming;
  camera.position.set(0, EYE_HEIGHT, 0); camera.quaternion.identity();
  camera.fov = weapon.fov; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const locations: Record<Angle, [number, number, number]> = { quarter: [6, 3.1, 4.5], profile: [8, 2.1, -.3], left: [-8, 2.1, -.3], front: [2.3, 2.7, -8] };
  portrait.position.set(...locations[angle]); portrait.lookAt(0, 1.6, -.5); portrait.updateMatrixWorld();
  if (sideShot) { portrait.position.set(8, 2.1, -1.35); portrait.lookAt(0, 1.6, -1.35); portrait.updateMatrixWorld(); }
  players.update([player], first ? 1 : -1, 0, first ? camera : portrait);
  if (view === 'shot') {
    const action = weapon.tick({ ...input, fire: true }, () => .5);
    if (!action.fired) throw new Error('Le vrai contrôleur de vue n’a pas produit de tir RPG');
    const muzzle = getWeaponMuzzle(weapon.pose);
    rockets.event({ type: 'event', roundId: 1, event: 'shot', projectileId: 1, tick: 1, weapon: 'rpg', shooterId: 1,
      position: { x: muzzle.position.x, y: EYE_HEIGHT + muzzle.position.y, z: -muzzle.position.z },
      velocity: { x: muzzle.direction.x * 60, y: muzzle.direction.y * 60, z: -muzzle.direction.z * 60 } }, 0);
    rockets.update(0, camera); rockets.update(.045, camera);
    for (let index = 0; index < 3; index++) weapon.tick(input, () => .5);
  }
  if (sideShot) {
    const position = players.getRpgMuzzle(player.id);
    if (!position) throw new Error('Point de départ de la roquette du personnage indisponible');
    const event: GameEvent = { type: 'event', roundId: 1, event: 'shot', projectileId: 1, tick: 1, weapon: 'rpg', shooterId: player.id,
      position, velocity: { x: 0, y: 0, z: -60 } };
    players.shot(event, 0); players.update([player], -1, 0, portrait);
    rockets.event(event, 0); rockets.update(0, portrait); rockets.update(view === 'third-shot20' ? .020 : .045, portrait);
  }
  renderer.render(scene, first ? camera : portrait);
  const gl = renderer.getContext(), targetPixel = new Uint8Array(4), lensPixel = new Uint8Array(4);
  if (first && aiming) gl.readPixels(640, 360, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, targetPixel);
  if (first) weapon.render(renderer, camera);
  if (first && aiming) gl.readPixels(640, 360, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, lensPixel);
  context.drawImage(renderer.domElement, 0, 0);
  if (first && aiming && scope.complete) context.drawImage(scope, 590, 310, 100, 100);
  context.fillStyle = '#132433ed'; context.fillRect(0, 0, 1280, 66);
  context.fillStyle = '#e6c17a'; context.font = 'bold 14px Arial'; context.fillText(`UBERCUBE / ${view === 'awp-aim' ? 'AWP' : 'RPG'} · MODÈLE DU JEU`, 28, 25);
  context.fillStyle = '#fff'; context.font = 'bold 21px Arial'; context.fillText(labels[view] + (first || sideShot ? '' : ` · ${angleLabels[angle]}`), 28, 53);
  status.textContent = `${labels[view]}${first || sideShot ? '' : ` · ${angleLabels[angle]}`}\nVue fixe, orientation horizontale. ${view.includes('shot') ? 'Banc de pose sans serveur : projectile à 60 blocs/s, sous-mesh de la roquette portée retiré par le rendu du jeu.' : 'Les boutons d’angle permettent de vérifier le port de l’arme autour du personnage.'}`
    + (first && aiming ? `\nPixel central cible / après arme (avant réticule) : ${Array.from(targetPixel.slice(0, 3))} / ${Array.from(lensPixel.slice(0, 3))}.` : '');
}

async function save(canvas: HTMLCanvasElement, name: string): Promise<void> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG indisponible')), 'image/png'));
  const response = await fetch(`/capture/${name}.png`, { method: 'POST', body: blob });
  if (!response.ok) throw new Error(`Enregistrement ${name} : ${response.status}`);
}

async function ready(): Promise<void> {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  await Promise.all([weapon.ready, players.ready, rockets.ready, scope.decode()]);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]')) button.onclick = () => render(button.dataset.view as View);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-angle]')) button.onclick = () => { angle = button.dataset.angle as Angle; render(view.startsWith('third') ? view : 'third-idle'); };
  document.getElementById('save')!.onclick = async () => {
    const name = `${view}${view === 'third-idle' || view === 'third-aim' ? `-${angle}` : ''}`;
    await save(output, name); status.textContent = `Capture enregistrée : .runtime/rpg-review/${name}.png`;
  };
  document.getElementById('sheet')!.onclick = async () => {
    buttons.forEach(button => { button.disabled = true; });
    try {
      const sheet = document.createElement('canvas'); sheet.width = 1920; sheet.height = 1080;
      const sheetContext = sheet.getContext('2d')!;
      const saved: string[] = [];
      const gallery = document.getElementById('gallery')!; gallery.replaceChildren();
      for (const [index, next] of (['fps-idle', 'fps-aim', 'third-idle', 'third-aim', 'shot', 'third-shot20', 'third-shot45', 'awp-aim'] as View[]).entries()) {
        render(next);
        const name = `${next}${next === 'third-idle' || next === 'third-aim' ? `-${angle}` : ''}`;
        await save(output, name); saved.push(name);
        if (index < 4) sheetContext.drawImage(output, index % 2 * 960, Math.floor(index / 2) * 540, 960, 540);
        const image = new Image(); image.src = output.toDataURL('image/png'); image.alt = labels[next]; gallery.append(image);
      }
      await save(sheet, `quatre-vues-${angle}`);
      render('fps-aim');
      status.textContent = `Captures enregistrées dans .runtime/rpg-review/ :\n${saved.map(name => `${name}.png`).join('\n')}\nquatre-vues-${angle}.png`;
    } finally { buttons.forEach(button => { button.disabled = false; }); }
  };
  buttons.forEach(button => { button.disabled = false; }); render('fps-idle');
}

void ready().catch(error => { status.textContent = `Échec : ${String(error)}`; console.error(error); });
