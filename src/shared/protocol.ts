export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export type Mode = 'tdm' | 'ffa';
export type Team = 0 | 1 | 2;
export type Kit = 'assault' | 'sniper' | 'medic';
export type WeaponId = 'ak47' | 'awp' | 'shovel' | 'grenade' | 'medic';
export interface Vec3 { x: number; y: number; z: number }
export interface WorldConfig { seed: number; size: number; height: number }
export type VoxelEdit = [x: number, y: number, z: number, value: number];
export interface MotionState {
  position: Vec3; velocity: Vec3; grounded: boolean; yaw: number; pitch: number;
}
export interface PlayerState extends MotionState {
  id: number; name: string; team: Team; kit: Kit; weapon: WeaponId;
  health: number; alive: boolean; kills: number; deaths: number;
  ammo: number; grenades: number; lastSeq: number;
}
export interface InputFrame {
  seq: number; roundId: number; moveX: number; moveZ: number;
  yaw: number; pitch: number; jump: boolean; sprint: boolean;
  fire: boolean; alt: boolean; weapon: WeaponId;
}
export type ClientMessage =
  | { type: 'hello'; version: number; name: string }
  | { type: 'spawn'; roundId: number; kit: Kit }
  | { type: 'input'; frames: InputFrame[] }
  | { type: 'ping'; time: number };
export interface ProjectileState { id: number; position: Vec3; velocity: Vec3; weapon: WeaponId; owner: number }
export type GameEvent = {
  type: 'event'; roundId: number;
  event: 'shot' | 'impact' | 'explosion' | 'death' | 'heal' | 'build';
  position: Vec3; shooterId?: number; targetId?: number;
  weapon?: WeaponId; headshot?: boolean;
};
export type ServerMessage =
  | { type: 'welcome'; id: number; roundId: number; mode: Mode; maxPlayers: number; world: WorldConfig; tickRate: number }
  | { type: 'world'; roundId: number; revision: number; edits: VoxelEdit[]; initial?: boolean; complete?: boolean }
  | { type: 'snapshot'; roundId: number; tick: number; players: PlayerState[]; projectiles: ProjectileState[]; scores: [number, number]; remaining: number | null }
  | { type: 'reset'; roundId: number; world: WorldConfig }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'pong'; time: number }
  | GameEvent;
export const KITS: Record<Kit, readonly WeaponId[]> = {
  assault: ['ak47', 'grenade', 'shovel'],
  sniper: ['awp', 'grenade', 'shovel'],
  medic: ['medic', 'ak47', 'grenade', 'shovel'],
};
export const WEAPONS: Record<WeaponId, { name: string; damage: number; interval: number; speed: number; magazine: number }> = {
  ak47: { name: 'AK-47', damage: 20, interval: 0.117, speed: 300, magazine: 30 },
  awp: { name: 'AWP', damage: 70, interval: 1.017, speed: 600, magazine: 5 },
  shovel: { name: 'Pelle', damage: 50, interval: 0.25, speed: 0, magazine: 0 },
  grenade: { name: 'Grenade', damage: 100, interval: 0.4, speed: 18, magazine: 10 },
  medic: { name: 'Soins', damage: -10, interval: 0.25, speed: 0, magazine: 0 },
};
