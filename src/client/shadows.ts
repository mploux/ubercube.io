import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { SUN_DIRECTION } from './lighting';

export class WorldShadows {
  readonly splits = new THREE.Vector4();
  private readonly csm: CSM;
  private readonly projection = new THREE.Matrix4();
  private enabled = true;

  constructor(private readonly renderer: THREE.WebGLRenderer, scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera, viewDistance: number) {
    this.csm = new CSM({
      camera, parent: scene, cascades: 4, maxFar: viewDistance * 0.9,
      mode: 'custom', shadowMapSize: Math.min(4096, renderer.capabilities.maxTextureSize),
      lightDirection: SUN_DIRECTION.clone().negate(),
      lightNear: 0.1, lightMargin: 384,
      customSplitsCallback: (_count, near, far, breaks) => {
        for (const end of [Math.min(10, far / 8), Math.min(30, far / 3), far / 2, far]) {
          breaks.push((end - near) / (far - near));
        }
      },
    });
    // These lights supply depth maps; the existing sun still owns avatar lighting.
    for (const [index, light] of this.csm.lights.entries()) {
      light.name = `World shadow ${index + 1}`;
      light.intensity = 0;
    }
    renderer.shadowMap.type = THREE.BasicShadowMap;
    this.updateProjection();
    this.setEnabled(true);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.renderer.shadowMap.enabled = enabled;
    this.renderer.shadowMap.needsUpdate = enabled;
    for (const light of this.csm.lights) {
      light.castShadow = enabled;
      if (!enabled && light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
    }
  }

  private updateProjection(): void {
    this.csm.updateFrustums();
    this.projection.copy(this.camera.projectionMatrix);
    for (const [index, light] of this.csm.lights.entries()) {
      const shadow = light.shadow;
      const width = shadow.camera.right - shadow.camera.left;
      const texel = width / this.csm.shadowMapSize;
      shadow.camera.far = this.csm.lightMargin + width * 2;
      shadow.camera.updateProjectionMatrix();
      shadow.bias = -texel / (shadow.camera.far - shadow.camera.near);
      shadow.normalBias = texel * 0.5;
      this.splits.setComponent(index, -this.csm.frustums[index].vertices.far[0].z);
    }
  }

  update(): void {
    if (!this.enabled) return;
    if (!this.projection.equals(this.camera.projectionMatrix)) this.updateProjection();
    this.camera.updateMatrixWorld();
    this.csm.update();
  }

  dispose(): void {
    this.setEnabled(false);
    this.csm.remove();
    this.csm.dispose();
  }
}
