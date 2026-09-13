import * as THREE from 'three';
import { createWorldMaterial } from '../../src/client/world-material';
import { createParticleMaterial } from '../../src/client/particle-material';
import { Snow } from '../../src/client/snow';
import { checkWorldShadows } from './shadow-check';
import { checkBulletVisuals } from './bullets-check';
import { checkWeaponView } from './weapon-check';
import { checkMuzzleAlignment } from './muzzle-check';
import { checkGrenadeVisuals } from './grenade-check';
import { checkPlayers } from './player-check';

const results = document.getElementById('results')!;
const messages: string[] = [];
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('render') as HTMLCanvasElement, antialias: false });
renderer.setSize(128, 128);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.type = THREE.BasicShadowMap;
const target = new THREE.WebGLRenderTarget(128, 128);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 1000);
camera.position.set(0, 0, 3);
camera.lookAt(0, 0, 0);

function read(scene: THREE.Scene): Uint8Array {
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const pixels = new Uint8Array(128 * 128 * 4);
  renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  return pixels;
}

function rgb(pixels: Uint8Array): number[] { return Array.from(pixels.slice((64 + 64 * 128) * 4, (64 + 64 * 128) * 4 + 3)); }
function check(name: string, actual: number[], expected: number[]): void {
  if (actual.some((v, i) => Math.abs(v - expected[i]) > 2)) throw new Error(`${name}: reçu ${actual}, attendu ${expected}`);
  messages.push(`OK ${name}: RGB ${actual}`);
}

function colored(geometry: THREE.BufferGeometry, color: number[]): THREE.BufferGeometry {
  const colors = new Float32Array(geometry.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set(color, i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

try {
  const scene = new THREE.Scene();
  const terrain = new THREE.Mesh(colored(new THREE.PlaneGeometry(2, 2), [.1, .5, .1]), createWorldMaterial(160));
  terrain.material.uniforms.sunDirection.value = new THREE.Vector3(0, 0, 1);
  scene.add(terrain);
  check('Terrain : RGB brut ×1.2, sans ACES', rgb(read(scene)), [31, 153, 31]);
  scene.add(new THREE.HemisphereLight(0xff0000, 0x0000ff, 10));
  check('Terrain : indépendant des lampes teintées', rgb(read(scene)), [31, 153, 31]);
  camera.position.z = 160; camera.updateMatrixWorld();
  check('Terrain : brouillard Java', rgb(read(scene)), [221, 232, 255]);
  scene.remove(terrain);
  terrain.geometry.dispose(); (terrain.material as THREE.Material).dispose();

  const lightingScene = new THREE.Scene();
  const litPlane = new THREE.Mesh(colored(new THREE.PlaneGeometry(2, 2), [.4, .4, .4]), createWorldMaterial(160));
  litPlane.receiveShadow = true;
  lightingScene.add(litPlane);
  const normal = new THREE.Vector3(0, 0, 1);
  const sun = new THREE.Vector3(-2, 3, -2).normalize();
  function face(direction: THREE.Vector3, label: string, expected: number): void {
    litPlane.quaternion.setFromUnitVectors(normal, direction);
    camera.position.copy(direction).multiplyScalar(3);
    camera.up.set(0, Math.abs(direction.y) > .9 ? 0 : 1, Math.abs(direction.y) > .9 ? 1 : 0);
    camera.lookAt(0, 0, 0);
    check(label, rgb(read(lightingScene)), [expected, expected, expected]);
  }
  renderer.shadowMap.enabled = false;
  face(sun, 'Soleil sans caster : face directement éclairée', 122);
  camera.position.add(new THREE.Vector3(1, 0, -1)); camera.lookAt(0, 0, 0);
  check('Normale monde : caméra oblique, même lumière', rgb(read(lightingScene)), [122, 122, 122]);
  face(sun.clone().negate(), 'Soleil sans caster : face dos au soleil', 61);
  face(new THREE.Vector3(1, 0, -1).normalize(), 'Soleil sans caster : lumière rasante', 61);
  face(new THREE.Vector3(0, 1, 0), 'Normale monde : dessus incliné vers le soleil', 106);
  face(new THREE.Vector3(0, 0, -1), 'Normale monde : face latérale vers le soleil', 91);
  face(normal, 'Normale monde : face latérale dos au soleil', 61);
  litPlane.material.uniforms.sunDirection.value = sun.clone().negate();
  face(normal, 'Soleil inversé : ancienne face sombre éclairée', 91);
  face(new THREE.Vector3(0, 0, -1), 'Soleil inversé : ancienne face éclairée sombre', 61);
  lightingScene.remove(litPlane);
  litPlane.geometry.dispose(); litPlane.material.dispose();

  camera.up.set(0, 1, 0);
  camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), createParticleMaterial(160), 1);
  particles.setMatrixAt(0, new THREE.Matrix4());
  particles.setColorAt(0, new THREE.Color(.25, .5, .75));
  scene.add(particles);
  check('Particules : couleur ×1.3, sans Lambert/ACES', rgb(read(scene)), [83, 166, 249]);
  camera.position.z = 160; camera.updateMatrixWorld();
  check('Particules : brouillard Java', rgb(read(scene)), [221, 232, 255]);
  scene.remove(particles);
  particles.geometry.dispose(); (particles.material as THREE.Material).dispose();

  messages.push(...checkWorldShadows(renderer));
  messages.push(...checkBulletVisuals(renderer));
  messages.push(...await checkWeaponView(renderer));
  messages.push(...await checkMuzzleAlignment(renderer));
  messages.push(...await checkGrenadeVisuals(renderer));
  messages.push(...await checkPlayers(renderer));

  const snowScene = new THREE.Scene();
  const snow = new Snow(snowScene, 160);
  snow.setEnabled(true);
  snow.update(.1, { x: 0, y: 0, z: 0 }, { get: () => 0 }, { x: 0, y: 0, z: -1 });
  const flakes = snowScene.getObjectByName('snow') as THREE.InstancedMesh;
  if (!snow.stats.activeCount) throw new Error('Neige activée sans flocons');
  // Isolate one actual snow instance to verify its compiled shader and instance palette.
  flakes.count = 1;
  flakes.setMatrixAt(0, new THREE.Matrix4());
  flakes.setColorAt(0, new THREE.Color(.8, .8, .9));
  flakes.instanceMatrix.needsUpdate = true; flakes.instanceColor!.needsUpdate = true;
  Object.assign(camera, { left: -1, right: 1, top: 1, bottom: -1 });
  camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
  check('Neige : shader et teinte Java', rgb(read(snowScene)), [255, 255, 255]);
  snow.setEnabled(false);
  if (snow.stats.activeCount || flakes.visible) throw new Error('Neige encore visible après désactivation');
  messages.push('OK Neige : activation et désactivation effectives');
  snow.dispose();
  results.textContent = `${messages.join('\n')}\n\nRÉSULTAT : SUCCÈS`;
  results.dataset.status = 'passed';
} catch (error) {
  results.textContent = `${messages.join('\n')}\n\nÉCHEC : ${error}`;
  results.dataset.status = 'failed';
  console.error(error);
} finally {
  target.dispose();
}
