import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { WorldShadows } from '../src/client/shadows';

function fixture(fov = 76, aspect = 16 / 9, maxTextureSize = 4096) {
  const renderer = {
    shadowMap: { enabled: false, needsUpdate: false, type: THREE.PCFShadowMap },
    capabilities: { maxTextureSize },
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, aspect, .05, 1100);
  camera.position.set(70, 45, 85);
  camera.rotation.set(-.22, .66, 0);
  const shadows = new WorldShadows(renderer, scene, camera, 192);
  const lights = scene.children.filter((object): object is THREE.DirectionalLight => object instanceof THREE.DirectionalLight);
  return { renderer, scene, camera, shadows, lights };
}

function updateMatrices(scene: THREE.Scene, shadows: WorldShadows, lights: THREE.DirectionalLight[]): void {
  shadows.update();
  scene.updateMatrixWorld(true);
  for (const light of lights) light.shadow.updateMatrices(light);
}

test.each([[40, 1], [76, 16 / 9], [100, 32 / 9]] as const)('four cascades cover every slice corner at FOV %s and aspect %s', (fov, aspect) => {
  const { scene, camera, shadows, lights } = fixture();
  try {
    camera.fov = fov;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    updateMatrices(scene, shadows, lights);
    expect(lights).toHaveLength(4);
    expect(shadows.splits.toArray()).toEqual(expect.arrayContaining([
      expect.closeTo(10, 5), expect.closeTo(30, 5), expect.closeTo(86.4, 5), expect.closeTo(172.8, 5),
    ]));
    let near = camera.near;
    for (const [index, light] of lights.entries()) {
      const far = shadows.splits.getComponent(index);
      expect(far).toBeGreaterThan(near);
      const texelTolerance = 1 / light.shadow.mapSize.x + 1e-6;
      for (const depth of [near, far]) for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * depth;
        const corner = new THREE.Vector3(x * halfHeight * camera.aspect, y * halfHeight, -depth)
          .applyMatrix4(camera.matrixWorld).applyMatrix4(light.shadow.matrix);
        expect(corner.x).toBeGreaterThanOrEqual(-texelTolerance);
        expect(corner.x).toBeLessThanOrEqual(1 + texelTolerance);
        expect(corner.y).toBeGreaterThanOrEqual(-texelTolerance);
        expect(corner.y).toBeLessThanOrEqual(1 + texelTolerance);
        expect(corner.z).toBeGreaterThanOrEqual(0);
        expect(corner.z).toBeLessThanOrEqual(1);
      }
      near = far;
    }
  } finally { shadows.dispose(); }
});

test('every cascade doubles linear precision at the same coverage and respects hardware map limits', () => {
  for (const textureLimit of [8192, 4096, 2048, 1024]) {
    const { shadows, lights, renderer } = fixture(76, 16 / 9, textureLimit);
    try {
      for (const light of lights) {
        const shadow = light.shadow;
        expect(shadow.mapSize.x).toBe(Math.min(4096, textureLimit));
        expect(shadow.mapSize.y).toBe(shadow.mapSize.x);
        const width = shadow.camera.right - shadow.camera.left;
        const texel = width / shadow.mapSize.x;
        const previousTexel = width / 2048;
        expect(previousTexel / texel).toBe(Math.min(4096, textureLimit) / 2048);
      }
      expect(renderer.shadowMap.type).toBe(THREE.BasicShadowMap);
      expect(lights.every(light => light.intensity === 0 && light.castShadow)).toBe(true);
    } finally { shadows.dispose(); }
  }
});

test('sub-texel movement along the light plane stays still until a complete texel step', () => {
  const { scene, camera, shadows, lights } = fixture();
  try {
    updateMatrices(scene, shadows, lights);
    const light = lights[0];
    const texel = (light.shadow.camera.right - light.shadow.camera.left) / light.shadow.mapSize.x;
    const orientation = new THREE.Matrix4().extractRotation(light.shadow.camera.matrixWorld);
    const inverse = orientation.clone().invert();
    const lateral = new THREE.Vector3(1, 0, 0).transformDirection(orientation);
    let previous = light.position.clone().applyMatrix4(inverse);
    let stationary = 0, steps = 0;
    for (let i = 0; i < 12; i++) {
      camera.position.addScaledVector(lateral, texel * .1);
      updateMatrices(scene, shadows, lights);
      const current = light.position.clone().applyMatrix4(inverse);
      const movedTexels = (current.x - previous.x) / texel;
      expect(movedTexels).toBeCloseTo(Math.round(movedTexels), 6);
      expect(Math.abs(movedTexels)).toBeLessThanOrEqual(1.000001);
      expect(current.y).toBeCloseTo(previous.y, 9);
      if (Math.abs(movedTexels) < .5) stationary++;
      else steps++;
      previous = current;
    }
    expect(stationary).toBeGreaterThanOrEqual(10);
    expect(steps).toBeGreaterThanOrEqual(1);
  } finally { shadows.dispose(); }
});

test('disable releases maps and stops updates; re-enable resumes and dispose removes only shadow-owned objects', () => {
  const { renderer, scene, camera, shadows, lights } = fixture();
  const existingSun = new THREE.DirectionalLight(0xffffff, 2);
  scene.add(existingSun);
  let disposedMaps = 0;
  const allocateMaps = () => {
    for (const light of lights) {
      const target = new THREE.WebGLRenderTarget(4, 4);
      target.addEventListener('dispose', () => disposedMaps++);
      light.shadow.map = target;
    }
  };
  updateMatrices(scene, shadows, lights);
  const positions = lights.map(light => light.position.clone());
  allocateMaps();
  shadows.setEnabled(false);
  expect(renderer.shadowMap.enabled).toBe(false);
  expect(disposedMaps).toBe(4);
  expect(lights.every(light => !light.castShadow && light.shadow.map === null)).toBe(true);
  camera.position.x += 30;
  shadows.update();
  expect(lights.every((light, i) => light.position.equals(positions[i]))).toBe(true);

  shadows.setEnabled(true);
  updateMatrices(scene, shadows, lights);
  expect(renderer.shadowMap.enabled).toBe(true);
  expect(renderer.shadowMap.needsUpdate).toBe(true);
  expect(lights.every(light => light.castShadow)).toBe(true);
  expect(lights.some((light, i) => !light.position.equals(positions[i]))).toBe(true);
  allocateMaps();
  shadows.dispose();
  expect(disposedMaps).toBe(8);
  expect(renderer.shadowMap.enabled).toBe(false);
  expect(scene.children).toEqual([existingSun]);
});
