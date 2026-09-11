import { Vector3 } from 'three';

// World-space direction from a surface towards the sun, shared by lighting and shadow projection.
export const SUN_DIRECTION = new Vector3(-2, 3, -2).normalize();
