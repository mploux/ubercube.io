import * as THREE from 'three';
import { Body, Box, ConeTwistConstraint, GSSolver, SAPBroadphase, Vec3 as PhysicsVector, World } from 'cannon-es';
import type { Vec3, VoxelEdit } from '../shared/protocol';
import type { VoxelWorld } from '../shared/voxel';
import { RagdollTerrain } from './ragdoll-terrain';

export interface RagdollPart {
  parent: number;
  size: readonly [number, number, number];
  // Unscaled world transform of the existing cuboid's bottom pivot.
  matrix: THREE.Matrix4;
}

interface Corpse {
  bodies: Body[];
  joints: ConeTwistConstraint[];
  heights: number[];
  expiresAt: number;
}

const STEP = 1 / 120;
const MAX_STEPS = 8;
const LIFETIME = 12;
const MASSES = [6, 1.5, 1, .65, 1, .65, 2, 1.5, 2, 1.5];

export class Ragdolls {
  private readonly corpsePoses: THREE.Matrix4[][] = [];
  private readonly physics: World;
  private readonly terrain: RagdollTerrain;
  private readonly corpses: Corpse[] = [];
  private readonly bodies: Body[] = [];
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private accumulator = 0;

  get poses(): readonly (readonly THREE.Matrix4[])[] { return this.corpsePoses; }

  constructor(world: Pick<VoxelWorld, 'get' | 'config'>, private readonly maxBodies = 16) {
    const solver = new GSSolver();
    solver.iterations = 16;
    solver.tolerance = .001;
    this.physics = new World({ gravity: new PhysicsVector(0, -28, 0), allowSleep: true, solver });
    this.physics.broadphase = new SAPBroadphase(this.physics);
    this.physics.defaultContactMaterial.friction = .65;
    this.physics.defaultContactMaterial.restitution = 0;
    this.terrain = new RagdollTerrain(this.physics, world);
  }

  spawn(parts: readonly RagdollPart[], velocity: Vec3, hitPoint: Vec3, impulse: Vec3, now: number): void {
    if (!parts.length || this.maxBodies <= 0) return;
    if (![now, ...Object.values(velocity), ...Object.values(hitPoint), ...Object.values(impulse)].every(Number.isFinite)
      || parts.some(part => !part.matrix.elements.every(Number.isFinite) || part.size.some(size => !Number.isFinite(size) || size <= 0))) return;
    while (this.corpses.length >= this.maxBodies) this.remove(0);
    const bodies = parts.map((part, index) => {
      part.matrix.decompose(this.position, this.rotation, this.scale);
      this.position.set(0, part.size[1] / 2, 0).applyMatrix4(part.matrix);
      const body = new Body({
        mass: MASSES[index] ?? 1,
        shape: new Box(new PhysicsVector(part.size[0] / 2, part.size[1] / 2, part.size[2] / 2)),
        position: new PhysicsVector(this.position.x, this.position.y, this.position.z),
        velocity: new PhysicsVector(velocity.x, velocity.y, velocity.z),
        collisionFilterGroup: 2, collisionFilterMask: 1,
        linearDamping: .05, angularDamping: .4,
        sleepSpeedLimit: .18, sleepTimeLimit: .75,
      });
      body.quaternion.set(this.rotation.x, this.rotation.y, this.rotation.z, this.rotation.w);
      body.previousQuaternion.copy(body.quaternion);
      body.updateInertiaWorld(true);
      this.physics.addBody(body);
      return body;
    });
    this.scale.set(1, 1, 1);
    const joints: ConeTwistConstraint[] = [];
    for (let i = 0; i < parts.length; i++) {
      const parent = bodies[parts[i].parent];
      if (!parent) continue;
      const child = bodies[i];
      const pivot = new PhysicsVector().copy(child.position);
      child.pointToWorldFrame(new PhysicsVector(0, -parts[i].size[1] / 2, 0), pivot);
      const axis = child.vectorToWorldFrame(new PhysicsVector(0, 1, 0));
      const distal = i === 3 || i === 5 || i === 7 || i === 9;
      const joint = new ConeTwistConstraint(parent, child, {
        pivotA: parent.pointToLocalFrame(pivot), pivotB: child.pointToLocalFrame(pivot),
        axisA: parent.vectorToLocalFrame(axis), axisB: child.vectorToLocalFrame(axis),
        angle: i === 1 ? .55 : distal ? 1.6 : 1.9,
        twistAngle: i === 1 ? .5 : distal ? .15 : .8,
        maxForce: 1e5, collideConnected: false,
      });
      const transverse = child.vectorToWorldFrame(new PhysicsVector(1, 0, 0));
      const twistA = parent.vectorToLocalFrame(transverse), twistB = child.vectorToLocalFrame(transverse);
      // Cannon's independent local tangents would torque an already rotated limb on its first step.
      joint.update = () => {
        ConeTwistConstraint.prototype.update.call(joint);
        parent.vectorToWorldFrame(twistA, joint.twistEquation.axisA);
        child.vectorToWorldFrame(twistB, joint.twistEquation.axisB);
      };
      this.physics.addConstraint(joint);
      joints.push(joint);
    }

    const hit = new PhysicsVector(hitPoint.x, hitPoint.y, hitPoint.z);
    let closest = Infinity, struck = bodies[0];
    const contact = new PhysicsVector(), closestPoint = new PhysicsVector();
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i], half = parts[i].size.map(size => size / 2);
      body.pointToLocalFrame(hit, contact);
      contact.set(Math.max(-half[0], Math.min(half[0], contact.x)), Math.max(-half[1], Math.min(half[1], contact.y)), Math.max(-half[2], Math.min(half[2], contact.z)));
      body.pointToWorldFrame(contact, contact);
      const distance = contact.distanceSquared(hit);
      if (distance >= closest) continue;
      closest = distance;
      struck = body;
      closestPoint.copy(contact);
    }
    struck.applyImpulse(new PhysicsVector(impulse.x, impulse.y, impulse.z), closestPoint.vsub(struck.position));
    this.corpses.push({ bodies, joints, heights: parts.map(part => part.size[1]), expiresAt: now + LIFETIME });
    this.bodies.push(...bodies);
    this.corpsePoses.push(parts.map(part => part.matrix.clone()));
    this.terrain.update(this.bodies);
  }

  update(dt: number, now: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i];
      if (now >= corpse.expiresAt || corpse.bodies.some(body => !Number.isFinite(body.position.lengthSquared())
        || !Number.isFinite(body.velocity.lengthSquared()) || !Number.isFinite(body.angularVelocity.lengthSquared())
        || !Number.isFinite(body.quaternion.x + body.quaternion.y + body.quaternion.z + body.quaternion.w))) this.remove(i);
    }
    if (!this.corpses.length) {
      this.accumulator = 0;
      this.terrain.clear();
      return;
    }
    if (!Number.isFinite(dt) || dt < 0) return;
    this.accumulator += Math.min(dt, STEP * MAX_STEPS);
    let steps = 0;
    while (this.accumulator >= STEP && steps++ < MAX_STEPS) {
      this.terrain.update(this.bodies);
      this.physics.step(STEP);
      this.accumulator -= STEP;
    }
    const alpha = this.accumulator / STEP;
    for (let c = 0; c < this.corpses.length; c++) {
      const corpse = this.corpses[c];
      for (let i = 0; i < corpse.bodies.length; i++) {
        const body = corpse.bodies[i];
        body.previousPosition.lerp(body.position, alpha, body.interpolatedPosition);
        body.previousQuaternion.slerp(body.quaternion, alpha, body.interpolatedQuaternion);
        const p = body.interpolatedPosition, q = body.interpolatedQuaternion;
        this.rotation.set(q.x, q.y, q.z, q.w);
        this.position.set(0, -corpse.heights[i] / 2, 0).applyQuaternion(this.rotation);
        this.position.x += p.x; this.position.y += p.y; this.position.z += p.z;
        this.corpsePoses[c][i].compose(this.position, this.rotation, this.scale);
      }
    }
  }

  applyEdits(edits: readonly VoxelEdit[]): void { this.terrain.applyEdits(edits); }

  private remove(index: number): void {
    const corpse = this.corpses[index];
    for (const joint of corpse.joints) this.physics.removeConstraint(joint);
    for (const body of corpse.bodies) {
      this.physics.removeBody(body);
      this.bodies.splice(this.bodies.indexOf(body), 1);
    }
    this.corpses.splice(index, 1);
    this.corpsePoses.splice(index, 1);
  }

  clear(): void {
    while (this.corpses.length) this.remove(this.corpses.length - 1);
    this.terrain.clear();
    this.accumulator = 0;
  }
}
