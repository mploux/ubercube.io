import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { createParticleMaterial, createParticleSorter } from '../src/client/particle-material';

function fixture() {
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(new Float32Array([.2, .4, .6]), 1));
  const mesh = new THREE.InstancedMesh(geometry, createParticleMaterial(160, true), 3);
  const positions = [new THREE.Vector3(100, 0, -1), new THREE.Vector3(0, 0, -10), new THREE.Vector3(0, 0, -5)];
  const colors = [new THREE.Color(1, 0, 0), new THREE.Color(0, 1, 0), new THREE.Color(0, 0, 1)];
  positions.forEach((position, index) => {
    mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(position));
    mesh.setColorAt(index, colors[index]);
  });
  const read = () => Array.from({ length: mesh.count }, (_, index) => {
    const matrix = new THREE.Matrix4(), color = new THREE.Color();
    mesh.getMatrixAt(index, matrix); mesh.getColorAt(index, color);
    return { position: new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), color: color.toArray(),
      opacity: geometry.getAttribute('instanceOpacity').getX(index) };
  });
  return { mesh, read, sort: createParticleSorter(mesh), camera: new THREE.PerspectiveCamera() };
}

test('transparent instances use view depth, not distance or emission order, with matrix/color/opacity kept together', () => {
  const { mesh, read, sort, camera } = fixture();
  try {
    const original = read();
    sort(camera);
    expect(read()).toEqual([original[1], original[2], original[0]]);
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.material.depthTest).toBe(true);

    camera.rotation.y = Math.PI;
    sort(camera);
    expect(read()).toEqual([original[0], original[2], original[1]]);

    camera.position.z = 30;
    camera.rotation.y = 0;
    sort(camera);
    expect(read()).toEqual([original[1], original[2], original[0]]);
  } finally { mesh.geometry.dispose(); mesh.material.dispose(); }
});

test('sort uses current camera and mesh parent transforms without a previous renderer frame', () => {
  const { mesh, read, sort, camera } = fixture();
  try {
    const original = read();
    const cameraRig = new THREE.Group(), emitter = new THREE.Group();
    cameraRig.add(camera); emitter.add(mesh);
    cameraRig.rotation.y = Math.PI;
    emitter.rotation.y = Math.PI;
    emitter.position.z = 8;
    sort(camera);
    expect(read()).toEqual([original[1], original[2], original[0]]);
    cameraRig.rotation.y = 0;
    sort(camera);
    expect(read()).toEqual([original[0], original[2], original[1]]);
    mesh.count = 0;
    sort(camera);
    expect(read()).toEqual([]);
  } finally { mesh.geometry.dispose(); mesh.material.dispose(); }
});
