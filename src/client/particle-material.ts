import * as THREE from 'three';
import type { GameEvent } from '../shared/protocol';

export function particleColor(event: GameEvent, random: number): THREE.Color | null {
  let r: number, g: number, b: number;
  const rgb = event.blockColor;
  if (event.event === 'death' || (event.event === 'impact' && event.targetId !== undefined)) {
    r = .8; g = 0; b = 0;
  } else if (event.event === 'explosion') {
    r = g = b = .5;
  } else if (event.event === 'impact' && typeof rgb === 'number' && Number.isInteger(rgb) && rgb >= 0 && rgb <= 0xffffff) {
    r = ((rgb >>> 16) & 255) / 255;
    g = ((rgb >>> 8) & 255) / 255;
    b = (rgb & 255) / 255;
  } else return null;
  // Particle.java adds the same variation to all channels, before framebuffer clamping.
  const variation = random * .1 - .05;
  return new THREE.Color(r + variation, g + variation, b + variation);
}

export function createParticleMaterial(fogDistance: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'UBERCUBE legacy particles',
    toneMapped: false,
    depthFunc: THREE.LessDepth,
    uniforms: { fogDistance: { value: fogDistance } },
    vertexShader: `
      varying vec3 particleColor;
      varying vec3 particleWorld;
      void main() {
        particleColor = instanceColor;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        particleWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform float fogDistance;
      varying vec3 particleColor;
      varying vec3 particleWorld;
      void main() {
        float fog = clamp(distance(cameraPosition, particleWorld) / fogDistance * 2.0 - 0.8, 0.0, 1.0);
        gl_FragColor = vec4(mix(particleColor * 1.3, vec3(221.0, 232.0, 255.0) / 255.0, fog), 1.0);
      }
    `,
  });
}
