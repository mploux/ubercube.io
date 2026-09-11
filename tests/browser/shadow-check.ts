import * as THREE from 'three';
import { WorldShadows } from '../../src/client/shadows';
import { createWorldMaterial } from '../../src/client/world-material';

export function checkWorldShadows(renderer: THREE.WebGLRenderer): string[] {
  const messages: string[] = [];
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 200);
  const shadows = new WorldShadows(renderer, scene, camera, 160);
  const target = new THREE.WebGLRenderTarget(256, 256, { samples: 0 });
  const previousTarget = renderer.getRenderTarget();
  const material = createWorldMaterial(1000, shadows.splits);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(100, 1, 100), material);
  const caster = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  floor.position.y = -.5;
  caster.position.y = 1;
  for (const mesh of [floor, caster]) {
    const colors = new Float32Array(mesh.geometry.getAttribute('position').count * 3).fill(.4);
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  function render(): Uint8Array {
    shadows.update();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(target.width * target.height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels);
    renderer.setRenderTarget(previousTarget);
    return pixels;
  }

  function topView(depth: number): void {
    // Keep a 20-block footprint while selecting a different true view-space cascade depth.
    camera.position.set(0, depth, .001);
    camera.lookAt(0, 0, 0);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(10 / depth));
    camera.updateProjectionMatrix();
  }

  function classify(pixels: Uint8Array, label: string, onlyTop = false): number {
    let dark = 0, invalid = 0;
    const unexpected = new Set<number>();
    for (let index = 0; index < pixels.length; index += 4) {
      const lit = [0, 1, 2].every(channel => Math.abs(pixels[index + channel] - 106) <= 2);
      const shaded = [0, 1, 2].every(channel => Math.abs(pixels[index + channel] - 61) <= 2);
      if (shaded) dark++;
      // These views expose only tops and +X/+Z faces, which face away from the sun.
      if ((!lit && !shaded) || (onlyTop && !lit)) { invalid++; unexpected.add(pixels[index]); }
    }
    if (invalid) throw new Error(`${label}: ${invalid} pixels invalides, niveaux ${Array.from(unexpected).join(',')} ; attendus ${onlyTop ? '106' : '106 (dessus) ou 61 (ambiant/ombre) uniquement'}`);
    return dark;
  }

  function sample(pixels: Uint8Array, point: THREE.Vector3, expected: number, label: string): void {
    const projected = point.clone().project(camera);
    const x = Math.round((projected.x * .5 + .5) * target.width - .5);
    const y = Math.round((projected.y * .5 + .5) * target.height - .5);
    if (x < 1 || y < 1 || x >= target.width - 1 || y >= target.height - 1) throw new Error(`${label}: point témoin hors cadre`);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const index = ((y + dy) * target.width + x + dx) * 4;
      if ([0, 1, 2].some(channel => Math.abs(pixels[index + channel] - expected) > 2)) {
        throw new Error(`${label}: témoin ${point.toArray()} reçu RGB ${Array.from(pixels.slice(index, index + 3))}, attendu ${expected}`);
      }
    }
  }

  const shadowPoint = new THREE.Vector3(2, 0, 2);
  const clearPoint = new THREE.Vector3(-3, 0, -3);
  try {
    if (renderer.shadowMap.type !== THREE.BasicShadowMap) throw new Error('WorldShadows ne sélectionne pas BasicShadowMap');
    topView(20);
    shadows.setEnabled(false);
    const baseline = render();
    classify(baseline, 'Terrain sans ombre');
    sample(baseline, shadowPoint, 106, 'Soleil direct sans ombre portée');
    shadows.setEnabled(true);
    const initial = render();
    if (classify(initial, 'Ombres initiales') < 30) throw new Error('Ombres initiales absentes');
    sample(initial, shadowPoint, 61, 'Ombre portée initiale');
    sample(initial, clearPoint, 106, 'Sol éclairé initial');
    messages.push('OK Ombres GPU : BasicShadowMap, visibilité binaire, lumière directe retirée sans diminuer l’ambiant');

    const limits = shadows.splits.toArray();
    for (let cascade = 0; cascade < 4; cascade++) {
      const near = cascade === 0 ? 0 : limits[cascade - 1];
      topView((near + limits[cascade]) / 2);
      caster.visible = false;
      classify(render(), `Sol seul, cascade ${cascade + 1}`, true);
      caster.visible = true;
      const pixels = render();
      const dark = classify(pixels, `Cascade ${cascade + 1}`);
      if (dark < 30) throw new Error(`Cascade ${cascade + 1}: ombre portée absente`);
      sample(pixels, shadowPoint, 61, `Cascade ${cascade + 1}`);
      sample(pixels, clearPoint, 106, `Cascade ${cascade + 1}`);
      messages.push(`OK Cascade ${cascade + 1} à ${camera.position.y.toFixed(2)} blocs : ombre portée vérifiée, ${dark} pixels ambiants/ombragés, sol sans acné`);
    }

    for (const boundary of limits.slice(0, 3)) {
      for (const delta of [-.25, .25]) {
        topView(boundary + delta);
        const pixels = render();
        classify(pixels, `Jonction ${boundary.toFixed(2)} ${delta > 0 ? '+' : ''}${delta}`);
        sample(pixels, shadowPoint, 61, `Ombre à la jonction ${boundary.toFixed(2)} ${delta > 0 ? '+' : ''}${delta}`);
      }
      messages.push(`OK Jonction ${boundary.toFixed(2)} blocs : ombre présente des deux côtés, aucune double atténuation`);
    }
    for (const delta of [-.5, .5]) {
      topView(limits[3] + delta);
      const pixels = render();
      classify(pixels, 'Fin de portée');
      sample(pixels, shadowPoint, delta < 0 ? 61 : 106, `Fin de portée ${limits[3].toFixed(2)} ${delta}`);
    }
    messages.push('OK Dernière cascade : ombre avant la limite et rendu éclairé au-delà');

    topView(20);
    caster.position.set(-4, 1, -4);
    const moved = render();
    classify(moved, 'Caster déplacé');
    sample(moved, shadowPoint, 106, 'Ancienne ombre effacée');
    sample(moved, new THREE.Vector3(-2, 0, -2), 61, 'Nouvelle ombre déplacée');
    caster.position.set(0, 1, 0);
    messages.push('OK Déplacer le bloc efface son ancienne ombre et actualise la nouvelle');

    // Tilt the view so one continuous receiver crosses a cascade junction inside the image.
    camera.position.set(6, Math.sqrt(limits[1] ** 2 - 52), 4);
    camera.lookAt(0, 0, 0);
    camera.fov = 40;
    camera.updateProjectionMatrix();
    const tilted = render();
    classify(tilted, 'Caméra déplacée à une jonction');
    sample(tilted, shadowPoint, 61, 'Caméra déplacée à une jonction');
    sample(tilted, clearPoint, 106, 'Caméra déplacée à une jonction');
    messages.push('OK Caméra déplacée : jonction sur un même sol, ombre simple et témoin éclairé');

    target.setSize(320, 192);
    camera.aspect = target.width / target.height;
    camera.fov = 55;
    camera.updateProjectionMatrix();
    caster.visible = false;
    classify(render(), 'Sol après redimensionnement et FOV', true);
    caster.visible = true;
    const resized = render();
    classify(resized, 'Redimensionnement et FOV');
    sample(resized, shadowPoint, 61, 'Redimensionnement et FOV');
    sample(resized, clearPoint, 106, 'Redimensionnement et FOV');
    messages.push('OK Format 320×192 et FOV modifié : ombre conservée et sol sans acné');

    shadows.setEnabled(false);
    const disabled = render();
    classify(disabled, 'Ombres désactivées');
    sample(disabled, shadowPoint, 106, 'Ombre portée désactivée');
    shadows.setEnabled(true);
    const reenabled = render();
    classify(reenabled, 'Ombres réactivées');
    sample(reenabled, shadowPoint, 61, 'Ombres réactivées');
    if (reenabled.some((value, index) => value !== resized[index])) throw new Error('Réactiver les ombres ne restaure pas exactement la même image');
    messages.push('OK Désactivation puis réactivation : pixels éclairés restaurés puis ombres identiques');

    camera.position.set(6, 4, 4); camera.lookAt(0, 1, 0);
    const backFace = new THREE.Vector3(1, 1, 0);
    sample(render(), backFace, 61, 'Face dos au soleil, ombres actives');
    shadows.setEnabled(false);
    sample(render(), backFace, 61, 'Face dos au soleil, ombres désactivées');
    messages.push('OK Face dos au soleil : ambiant identique avec/sans ombres, aucun double assombrissement');
    return messages;
  } finally {
    shadows.dispose();
    renderer.setRenderTarget(previousTarget);
    target.dispose();
    floor.geometry.dispose(); caster.geometry.dispose(); material.dispose();
  }
}
