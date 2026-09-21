import * as THREE from 'three';
import type { GameEvent } from '../shared/protocol';

export type ParticleEvent = Pick<GameEvent, 'blockColor' | 'targetId'> & { event: GameEvent['event'] | 'blood' };

export function particleColor(event: ParticleEvent, random: number): THREE.Color | null {
  let r: number, g: number, b: number;
  const rgb = event.blockColor;
  if (event.event === 'blood' || event.event === 'death' || (event.event === 'impact' && event.targetId !== undefined)) {
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

export function createParticleSorter(mesh: THREE.InstancedMesh): (camera: THREE.Camera) => void {
  const order: number[] = [];
  const depths = new Float32Array(mesh.instanceMatrix.count);
  const matrices = new Float32Array(mesh.instanceMatrix.array.length);
  const colors = new Float32Array(mesh.instanceColor!.array.length);
  const opacity = mesh.geometry.getAttribute('instanceOpacity') as THREE.InstancedBufferAttribute;
  const opacities = new Float32Array(opacity.array.length);
  const view = new THREE.Matrix4();

  // Run before renderer.render: Three uploads instance buffers before onBeforeRender.
  return camera => {
    if (mesh.count < 2) return;
    camera.updateWorldMatrix(true, false);
    mesh.updateWorldMatrix(true, false);
    view.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
    const e = view.elements;
    matrices.set(mesh.instanceMatrix.array.subarray(0, mesh.count * 16));
    colors.set(mesh.instanceColor!.array.subarray(0, mesh.count * 3));
    opacities.set(opacity.array.subarray(0, mesh.count));
    order.length = mesh.count;
    for (let index = 0; index < mesh.count; index++) {
      order[index] = index;
      const offset = index * 16;
      depths[index] = e[2] * matrices[offset + 12] + e[6] * matrices[offset + 13] + e[10] * matrices[offset + 14] + e[14];
    }
    // Three sorts transparent meshes, but instances need their own camera-space order.
    order.sort((a, b) => depths[a] - depths[b]);
    for (let index = 0; index < mesh.count; index++) {
      const source = order[index];
      for (let component = 0; component < 16; component++) mesh.instanceMatrix.array[index * 16 + component] = matrices[source * 16 + component];
      for (let component = 0; component < 3; component++) mesh.instanceColor!.array[index * 3 + component] = colors[source * 3 + component];
      opacity.setX(index, opacities[source]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
    opacity.needsUpdate = true;
  };
}

export function createParticleMaterial(fogDistance: number, transparent = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'UBERCUBE legacy particles',
    toneMapped: false,
    transparent,
    depthWrite: !transparent,
    depthFunc: THREE.LessDepth,
    uniforms: { fogDistance: { value: fogDistance } },
    vertexShader: `
      varying vec3 particleColor;
      varying vec3 particleWorld;
      ${transparent ? 'attribute float instanceOpacity; varying float particleOpacity;' : ''}
      void main() {
        ${transparent ? 'particleOpacity = instanceOpacity;' : ''}
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
      ${transparent ? 'varying float particleOpacity;' : ''}
      void main() {
        float fog = clamp(distance(cameraPosition, particleWorld) / fogDistance * 2.0 - 0.8, 0.0, 1.0);
        gl_FragColor = vec4(mix(particleColor * 1.3, vec3(221.0, 232.0, 255.0) / 255.0, fog), ${transparent ? 'mix(particleOpacity, 1.0, fog)' : '1.0'});
      }
    `,
  });
}
