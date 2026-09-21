import { DT, type InputFrame, type MotionState, type Vec3 } from './protocol';
import type { VoxelWorld } from './voxel';

export const PLAYER_HEIGHT = 2.8;
export const PLAYER_RADIUS = 0.3;
export const EYE_HEIGHT = 2.4;
const EPSILON = 0.0001;

export function aimDirection(yaw: number, pitch: number): Vec3 {
  const horizontal = Math.cos(pitch);
  return { x: -Math.sin(yaw) * horizontal, y: Math.sin(pitch), z: -Math.cos(yaw) * horizontal };
}

export function playerCollides(world: Pick<VoxelWorld, 'get'>, position: Vec3): boolean {
  const x0 = Math.floor(position.x - PLAYER_RADIUS + EPSILON);
  const x1 = Math.floor(position.x + PLAYER_RADIUS - EPSILON);
  const y0 = Math.floor(position.y + EPSILON);
  const y1 = Math.floor(position.y + PLAYER_HEIGHT - EPSILON);
  const z0 = Math.floor(position.z - PLAYER_RADIUS + EPSILON);
  const z1 = Math.floor(position.z + PLAYER_RADIUS - EPSILON);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (world.get(x, y, z) !== 0) return true;
      }
    }
  }
  return false;
}

export function movePlayer(state: MotionState, input: InputFrame, world: Pick<VoxelWorld, 'get' | 'config'>, dt = DT): void {
  state.yaw = input.yaw;
  state.pitch = Math.max(-1.54, Math.min(1.54, input.pitch));
  const length = Math.max(1, Math.hypot(input.moveX, input.moveZ));
  const speed = input.sneak ? 3 : input.sprint ? 9 : 6;
  const x = input.moveX / length;
  const z = input.moveZ / length;
  const targetX = (Math.cos(state.yaw) * x - Math.sin(state.yaw) * z) * speed;
  const targetZ = (-Math.sin(state.yaw) * x - Math.cos(state.yaw) * z) * speed;
  const acceleration = state.grounded ? 18 : 8;
  state.velocity.x += (targetX - state.velocity.x) * Math.min(1, acceleration * dt);
  state.velocity.z += (targetZ - state.velocity.z) * Math.min(1, acceleration * dt);
  const wasGrounded = state.grounded;
  if (input.jump && state.grounded) {
    state.velocity.y = 12;
    state.grounded = false;
  }
  state.velocity.y = Math.max(-45, state.velocity.y - 28 * dt);

  for (const axis of ['x', 'z'] as const) {
    const distance = state.velocity[axis] * dt;
    const steps = Math.max(1, Math.ceil(Math.abs(distance) / 0.2));
    const step = distance / steps;
    for (let i = 0; i < steps; i++) {
      const previous = state.position[axis];
      state.position[axis] = Math.max(PLAYER_RADIUS, Math.min(world.config.size - PLAYER_RADIUS, previous + step));
      if (playerCollides(world, state.position)) {
        // A voxel stair can be stepped up, but never through a low ceiling.
        if (wasGrounded && !input.jump) {
          const oldY = state.position.y;
          state.position.y = Math.floor(oldY + EPSILON) + 1;
          if (state.position.y - oldY <= 1.001 && !playerCollides(world, state.position)) continue;
          state.position.y = oldY;
        }
        state.position[axis] = previous;
        state.velocity[axis] = 0;
        break;
      }
      if (input.sneak && wasGrounded && !input.jump) {
        const oldY = state.position.y;
        state.position.y -= .05;
        const supported = playerCollides(world, state.position);
        state.position.y = oldY;
        if (!supported) {
          state.position[axis] = previous;
          state.velocity[axis] = 0;
          break;
        }
      }
    }
  }

  state.grounded = false;
  const vertical = state.velocity.y * dt;
  const steps = Math.max(1, Math.ceil(Math.abs(vertical) / 0.2));
  for (let i = 0; i < steps; i++) {
    const oldY = state.position.y;
    state.position.y += vertical / steps;
    if (playerCollides(world, state.position)) {
      // Solve the contact rather than retaining a varying substep-sized gap.
      let clear = oldY;
      let blocked = state.position.y;
      for (let attempt = 0; attempt < 12; attempt++) {
        state.position.y = (clear + blocked) / 2;
        if (playerCollides(world, state.position)) blocked = state.position.y;
        else clear = state.position.y;
      }
      state.position.y = clear;
      state.grounded = vertical < 0;
      state.velocity.y = 0;
      break;
    }
  }
}
