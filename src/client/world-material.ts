import * as THREE from 'three';
import { SUN_DIRECTION } from './lighting';

export function createWorldMaterial(fogDistance: number, shadowSplits = new THREE.Vector4(1e6, 1e6, 1e6, 1e6)): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'UBERCUBE world',
    vertexColors: true,
    lights: true,
    toneMapped: false,
    shadowSide: THREE.FrontSide,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      { fogDistance: { value: Math.max(1, fogDistance) }, sunDirection: { value: SUN_DIRECTION } },
    ]),
    vertexShader: /* glsl */`
      #include <common>
      #include <shadowmap_pars_vertex>
      varying vec3 vRawColor;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying float vViewDepth;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vec3 transformedNormal = normalMatrix * normal;
        vWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
        vWorldPosition = worldPosition.xyz;
        vRawColor = color;
        vec4 viewPosition = viewMatrix * worldPosition;
        vViewDepth = -viewPosition.z;
        gl_Position = projectionMatrix * viewPosition;
        #include <shadowmap_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <packing>
      #include <shadowmap_pars_fragment>
      uniform bool receiveShadow;
      uniform vec4 shadowSplits;
      uniform float fogDistance;
      uniform vec3 sunDirection;
      varying vec3 vRawColor;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      varying float vViewDepth;

      float worldShadow() {
        float shadow = 1.0;
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
          if (receiveShadow) {
            // A pixel belongs to one cascade: overlapping maps must never multiply shadows.
            float previousSplit = 0.0;
            #pragma unroll_loop_start
            for (int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i++) {
              if (vViewDepth > previousSplit && vViewDepth <= shadowSplits[i]) {
                shadow = getShadow(directionalShadowMap[i], directionalLightShadows[i].shadowMapSize,
                  directionalLightShadows[i].shadowIntensity, directionalLightShadows[i].shadowBias,
                  directionalLightShadows[i].shadowRadius, vDirectionalShadowCoord[i]);
              }
              previousSplit = shadowSplits[i];
            }
            #pragma unroll_loop_end
          }
        #endif
        return shadow;
      }

      void main() {
        float fog = clamp(distance(cameraPosition.xz, vWorldPosition.xz) / fogDistance * 2.0 - 0.8, 0.0, 1.0);
        float sunlight = max(dot(normalize(vWorldNormal), sunDirection), 0.0);
        // Occlusion removes direct sunlight, never the ambient contribution a second time.
        float brightness = 0.5 + 0.5 * sunlight * worldShadow();
        vec3 rgb = vRawColor * 1.2 * brightness;
        // Preserve the raw display RGB palette without an extra sRGB or tone-mapping conversion.
        gl_FragColor = vec4(mix(rgb, vec3(221.0, 232.0, 255.0) / 255.0, fog), 1.0);
      }
    `,
  });
  // Keep the live split vector shared when the camera's projection changes.
  material.uniforms.shadowSplits = { value: shadowSplits };
  return material;
}
