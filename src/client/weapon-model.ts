import * as THREE from 'three';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { WeaponId } from '../shared/protocol';

export const WEAPON_MODEL_FILES: Record<WeaponId, string> = {
  ak47: 'ak47/AK47', awp: 'awp/AWP', shovel: 'shovel/SHOVEL',
  grenade: 'grenade/GRENADE', medic: 'medicbag/MEDICBAG',
};

export const WEAPON_PREVIEWS = {
  ak47: { scale: [0.03, -0.03, 0.03], center: [0, 2.5, -50], rotation: 0 },
  awp: { scale: [0.06, -0.06, 0.06], center: [0, 0, -32], rotation: 0 },
  medic: { scale: [0.3, 0.3, 0.3], center: [0, 0.5, 0], rotation: -90 },
} as const;

export function parseWeaponModel(obj: string, mtl: string): THREE.Group {
  const palette = new MTLLoader().parse(mtl, '').materialsInfo;
  const model = new OBJLoader().parse(obj);
  const material = new THREE.ShaderMaterial({
    name: 'UBERCUBE legacy weapon colors',
    vertexColors: true,
    side: THREE.DoubleSide,
    // Original OBJ faces overlap with different palettes; Java's GL_LESS keeps the first face.
    depthFunc: THREE.LessDepth,
    toneMapped: false,
    uniforms: { preview: { value: false }, fogDistance: { value: 0 } },
    vertexShader: `
      uniform bool preview;
      varying vec3 legacyColor;
      varying vec3 legacyNormal;
      varying vec3 legacyWorld;
      void main() {
        legacyColor = color;
        legacyNormal = preview ? vec3(0.0) : mat3(viewMatrix) * normal;
        vec4 local = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
        #endif
        vec4 world = modelMatrix * local;
        legacyWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    // weapon.frag uses raw Kd, 2x intensity and the same light factor twice; its cubemap is separate.
    fragmentShader: `
      varying vec3 legacyColor;
      varying vec3 legacyNormal;
      varying vec3 legacyWorld;
      uniform float fogDistance;
      void main() {
        float lightDot = clamp(dot(legacyNormal, normalize(vec3(1.0))) + 0.8, 0.8, 1.0);
        gl_FragColor = vec4(legacyColor * 0.98 * 2.0 * lightDot * lightDot, 1.0);
        if (fogDistance > 0.0) {
          float fog = clamp(distance(cameraPosition, legacyWorld) / fogDistance * 2.0 - 0.8, 0.0, 1.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(221.0, 232.0, 255.0) / 255.0, fog);
        }
      }
    `,
  });
  const discarded = new Set<THREE.Material>();
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    const originals = Array.isArray(object.material) ? object.material : [object.material];
    const count = geometry.getAttribute('position').count;
    const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    const colors = new Float32Array(count * 3);
    for (const group of groups) {
      const name = originals[group.materialIndex ?? 0].name;
      const diffuse = palette[name]?.kd;
      if (!diffuse || diffuse.length !== 3 || diffuse.some(value => !Number.isFinite(value))) {
        throw new Error(`Missing diffuse palette for weapon material ${name}`);
      }
      for (let vertex = group.start; vertex < group.start + group.count; vertex++) colors.set(diffuse, vertex * 3);
    }
    // OBJModel.parseModel assigns the current usemtl Kd to every emitted vertex.
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.clearGroups();
    for (const original of originals) discarded.add(original);
    object.material = material;
  });
  for (const original of discarded) original.dispose();
  return model;
}

export async function loadWeaponModel(weapon: WeaponId): Promise<THREE.Group> {
  const path = `/assets/weapons/${WEAPON_MODEL_FILES[weapon]}`;
  const responses = await Promise.all([fetch(`${path}.obj`), fetch(`${path}.mtl`)]);
  if (responses.some(response => !response.ok)) throw new Error(`Cannot load ${weapon} model and palette`);
  const [obj, mtl] = await Promise.all(responses.map(response => response.text()));
  return parseWeaponModel(obj, mtl);
}
