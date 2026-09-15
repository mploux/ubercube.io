import { DT, KITS, PROTOCOL_VERSION, TICK_RATE, WEAPONS } from './protocol.ts';
import type { GameEvent, InputFrame, Kit, Mode, PlayerState, ProjectileState, ServerMessage, Vec3, VoxelEdit, WeaponId, WorldConfig } from './protocol.ts';
import { aimDirection, EYE_HEIGHT, movePlayer, playerCollides, PLAYER_HEIGHT, PLAYER_RADIUS } from './movement.ts';
import { damageBlock, packBlock, raycast, VoxelWorld } from './voxel.ts';
import { encodeServerMessage } from './wire.ts';
import { createWeaponPose, getWeaponMuzzle, hideWeaponPose, stepWeaponMotion, stepWeaponPose, type WeaponPoseState } from './weapon-pose.ts';
import { grenadeLaunch, stepGrenade, type GrenadeFlight } from './grenade.ts';

export interface Peer {
  send(data: string | Uint8Array): number;
  close(code: number, reason: string): void;
  bufferedAmount(): number;
  setBroadcast?(enabled: boolean): void;
}

export interface GameOptions {
  mode: Mode;
  maxPlayers: number;
  world: WorldConfig;
  roundSeconds: number;
}

type WorldMessage = Extract<ServerMessage, { type: 'world' }>;
interface InitialWorld {
  startedAt: number;
  edits: VoxelEdit[];
  offset: number;
  revision: number;
  deltas: WorldMessage[];
  deltaEdits: number;
}
export interface Connection {
  readonly peer: Peer;
  player: PlayerState | null;
  closed: boolean;
  connectedAt: number;
  rateStartedAt: number;
  messages: number;
  frames: number;
  invalid: number;
  lastMessage: number;
  lobbySince: number;
  queue: InputFrame[];
  input: InputFrame | null;
  highestSeq: number;
  lastInputTick: number;
  previousFire: boolean;
  previousAlt: boolean;
  weaponPoses: Map<WeaponId, WeaponPoseState>;
  weaponMotion: Vec3;
  magazines: { ak47: number; awp: number };
  initial: InitialWorld | null;
}
interface Projectile extends ProjectileState, GrenadeFlight { damage: number; expires: number }
interface Shot {
  id: number; owner: number; weapon: 'ak47' | 'awp'; inputSeq: number;
  eye: Vec3; origin: Vec3; direction: Vec3;
}

const INPUT_KEYS = ['seq', 'roundId', 'moveX', 'moveZ', 'yaw', 'pitch', 'jump', 'sprint', 'fire', 'alt', 'weapon'];
const WORLD_BATCH = 512;
const MAX_BUFFER = 512 * 1024;
const STREAM_BUFFER = 64 * 1024;
const MAX_INPUT_QUEUE = 12;
const MAX_INITIAL_EDITS = 524288;
const MAX_RETAINED_BASELINE_EDITS = 1048576;
const MAX_INITIAL_DELTA_EDITS = 32768;
const MAX_INITIAL_DELTA_MESSAGES = 256;
const INITIAL_TIMEOUT_MS = 30000;
const MAX_INITIAL_TRANSFERS = 16;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function number(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function weapon(value: unknown): value is WeaponId {
  return typeof value === 'string' && Object.hasOwn(WEAPONS, value);
}
function kit(value: unknown): value is Kit {
  return typeof value === 'string' && Object.hasOwn(KITS, value);
}
function inputFrame(value: unknown): value is InputFrame {
  return record(value) && keys(value, Object.hasOwn(value, 'cancelActions') ? [...INPUT_KEYS, 'cancelActions'] : INPUT_KEYS)
    && (!Object.hasOwn(value, 'cancelActions') || typeof value.cancelActions === 'boolean')
    && number(value.seq, 1, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(value.seq)
    && number(value.roundId, 1, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(value.roundId)
    && number(value.moveX, -1, 1) && number(value.moveZ, -1, 1)
    && number(value.yaw, -Math.PI * 2, Math.PI * 2) && number(value.pitch, -Math.PI / 2, Math.PI / 2)
    && ['jump', 'sprint', 'fire', 'alt'].every(key => typeof value[key] === 'boolean') && weapon(value.weapon);
}

function sameActionState(a: InputFrame, b: InputFrame): boolean {
  return a.weapon === b.weapon && a.fire === b.fire && a.alt === b.alt && a.jump === b.jump
    && !!a.cancelActions === !!b.cancelActions;
}

export class GameServer {
  readonly players = new Map<number, PlayerState>();
  readonly connections = new Set<Connection>();
  readonly projectiles = new Map<number, Projectile>();
  readonly options: GameOptions;
  world: VoxelWorld;
  roundId = 1;
  tick = 0;
  revision = 0;
  scores: [number, number] = [0, 0];
  droppedInputs = 0;
  private roundStart = 0;
  private nextPlayer = 1;
  private nextProjectile = 1;
  private readonly shots: Shot[] = [];
  private randomState: number;
  private edits = new Map<string, VoxelEdit>();
  private baseline: { revision: number; edits: VoxelEdit[] } | null = null;

  // Hosts inject monotonic milliseconds; the default keeps solo and deterministic tests tick-driven.
  constructor(options: Partial<GameOptions> = {}, private readonly publish?: (data: string | Uint8Array) => void,
    private readonly now: () => number = () => this.tick * 1000 / TICK_RATE,
    private readonly combatRandom: () => number = () => this.random()) {
    this.options = { mode: 'tdm', maxPlayers: 100, world: { seed: 12345, size: 256, height: 64 }, roundSeconds: 0, ...options };
    const { mode, maxPlayers, world, roundSeconds } = this.options;
    if (!['tdm', 'ffa'].includes(mode) || !Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000
      || !Number.isInteger(world.seed) || world.seed < 0 || world.seed > 0xffffffff
      || !Number.isInteger(world.size) || world.size < 64 || world.size > 2048 || world.size % 16 !== 0
      || !Number.isInteger(world.height) || world.height < 32 || world.height > 256 || world.height % 16 !== 0
      || !Number.isInteger(roundSeconds) || roundSeconds < 0 || roundSeconds > 86400) {
      throw new Error('Invalid server configuration');
    }
    this.world = new VoxelWorld(world);
    this.randomState = world.seed || 1;
  }

  connect(peer: Peer): Connection | null {
    if (this.connections.size >= this.options.maxPlayers + 16) {
      peer.send(JSON.stringify({ type: 'error', message: 'Serveur complet.', fatal: true }));
      peer.close(1013, 'Server full');
      return null;
    }
    const now = this.now();
    const connection: Connection = {
      peer, player: null, closed: false, connectedAt: now, rateStartedAt: now, messages: 0, frames: 0,
      invalid: 0, lastMessage: now, lobbySince: now, queue: [], input: null, highestSeq: 0, lastInputTick: this.tick,
      previousFire: false, previousAlt: false, weaponPoses: new Map(), weaponMotion: { x: 0, y: 0, z: 0 },
      magazines: { ak47: 30, awp: 5 }, initial: null,
    };
    this.connections.add(connection);
    return connection;
  }

  disconnect(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.peer.setBroadcast?.(false);
    this.connections.delete(connection);
    if (connection.player) this.players.delete(connection.player.id);
    connection.queue = [];
    connection.initial = null;
    connection.input = null;
  }

  private fail(connection: Connection, message: string, fatal = false): void {
    if (connection.closed) return;
    connection.invalid++;
    fatal ||= connection.invalid >= 8;
    this.send(connection, { type: 'error', message, fatal });
    if (fatal && !connection.closed) {
      this.disconnect(connection);
      connection.peer.close(1008, message);
    }
  }

  private send(connection: Connection, message: ServerMessage | string | Uint8Array, replaceable = false): boolean {
    if (connection.closed) return false;
    const buffered = connection.peer.bufferedAmount();
    if (buffered > MAX_BUFFER) {
      this.disconnect(connection);
      connection.peer.close(1013, 'Connection too slow');
      return false;
    }
    if (replaceable && buffered > STREAM_BUFFER) return false;
    try {
      const result = connection.peer.send(typeof message === 'string' || message instanceof Uint8Array ? message : encodeServerMessage(message));
      if (result === 0) {
        this.disconnect(connection);
        connection.peer.close(1011, 'Send failed');
        return false;
      }
      return true;
    } catch {
      this.disconnect(connection);
      connection.peer.close(1011, 'Send failed');
      return false;
    }
  }

  private broadcast(message: ServerMessage): void {
    const encoded = encodeServerMessage(message);
    if (this.publish && message.type !== 'snapshot') { this.publish(encoded); return; }
    for (const connection of this.connections) {
      if (connection.player && !connection.initial) this.send(connection, encoded, message.type === 'snapshot');
    }
  }

  receive(connection: Connection, text: string): void {
    if (connection.closed) return;
    const now = this.now();
    if (now - connection.rateStartedAt >= 1000) {
      connection.rateStartedAt = now;
      connection.messages = 0;
      connection.frames = 0;
    }
    if (++connection.messages > 120 || text.length > 8192) {
      this.fail(connection, 'Trop de messages ou message trop volumineux.', true);
      return;
    }
    let message: unknown;
    try { message = JSON.parse(text); } catch { this.fail(connection, 'Message invalide.'); return; }
    if (!record(message)) { this.fail(connection, 'Message invalide.'); return; }
    connection.lastMessage = now;
    if (message.type === 'hello') {
      if (connection.player || !keys(message, ['type', 'version', 'name']) || message.version !== PROTOCOL_VERSION
        || typeof message.name !== 'string' || message.name.trim().length < 1 || message.name.trim().length > 24
        || /[\p{Cc}\p{Cf}]/u.test(message.name)) {
        this.fail(connection, 'Pseudo ou version invalide.', true);
        return;
      }
      if (this.players.size >= this.options.maxPlayers) { this.fail(connection, 'Serveur complet.', true); return; }
      let team: 0 | 1 | 2 = 0;
      if (this.options.mode === 'tdm') {
        let red = 0, blue = 0;
        for (const player of this.players.values()) player.team === 1 ? red++ : blue++;
        team = red < blue ? 1 : 2;
      }
      const player: PlayerState = {
        id: this.nextPlayer++, name: message.name.trim(), team, kit: 'assault', weapon: 'ak47',
        position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, grounded: false, yaw: 0, pitch: 0,
        health: 100, alive: false, aiming: false, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
      };
      connection.player = player;
      connection.lobbySince = now;
      this.players.set(player.id, player);
      this.flushWorld();
      this.send(connection, { type: 'welcome', id: player.id, roundId: this.roundId, mode: this.options.mode,
        maxPlayers: this.options.maxPlayers, world: this.options.world, tickRate: TICK_RATE });
      this.startInitial(connection);
      this.streamInitial(connection, 1);
      return;
    }
    if (message.type === 'ping' && keys(message, ['type', 'time']) && number(message.time, 0, Number.MAX_SAFE_INTEGER)) {
      this.send(connection, { type: 'pong', time: message.time });
      return;
    }
    const player = connection.player;
    if (!player) { this.fail(connection, 'Connexion requise.', true); return; }
    if (message.type === 'spawn') {
      if (!keys(message, ['type', 'roundId', 'kit']) || !kit(message.kit)
        || !number(message.roundId, 1, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(message.roundId)) {
        this.fail(connection, 'Équipement ou manche invalide.'); return;
      }
      if (message.roundId !== this.roundId) return;
      if (player.alive || connection.initial) { this.fail(connection, 'Apparition indisponible.'); return; }
      const position = this.spawnPosition(player);
      if (!position) { this.fail(connection, 'Aucun emplacement libre pour apparaître.'); return; }
      player.position = position;
      player.velocity = { x: 0, y: 0, z: 0 };
      player.grounded = false;
      player.yaw = player.team === 2 ? -Math.PI / 4 : Math.PI * 3 / 4;
      player.pitch = 0;
      player.kit = message.kit;
      player.weapon = KITS[message.kit][0];
      player.health = 100;
      player.grenades = 10;
      player.alive = true;
      player.aiming = false;
      connection.magazines = { ak47: 30, awp: 5 };
      player.ammo = WEAPONS[player.weapon].magazine;
      connection.queue = [];
      connection.input = null;
      connection.previousFire = false;
      connection.previousAlt = false;
      connection.weaponPoses.clear();
      const pose = createWeaponPose(player.weapon);
      hideWeaponPose(pose);
      connection.weaponPoses.set(player.weapon, pose);
      connection.weaponMotion = { x: 0, y: 0, z: 0 };
      this.sendSnapshot(connection);
      return;
    }
    if (message.type !== 'input' || !keys(message, ['type', 'frames']) || !Array.isArray(message.frames)
      || message.frames.length < 1 || message.frames.length > 8 || !message.frames.every(inputFrame)) {
      this.fail(connection, 'Commande invalide.');
      return;
    }
    const frames = message.frames as InputFrame[];
    if (frames.some(frame => frame.roundId !== this.roundId)) return;
    let seq = connection.highestSeq;
    for (const frame of frames) {
      if (frame.seq <= seq || !KITS[player.kit].includes(frame.weapon)) { this.fail(connection, 'Séquence ou arme invalide.'); return; }
      seq = frame.seq;
    }
    connection.frames += frames.length;
    if (connection.frames > 90) { this.fail(connection, 'Fréquence de commandes excessive.', true); return; }
    if (!player.alive || connection.initial) return;
    if (connection.queue.length + frames.length > MAX_INPUT_QUEUE) {
      this.droppedInputs += frames.length;
      this.send(connection, { type: 'error', message: 'Commandes retardées ignorées.' });
      return;
    }
    connection.highestSeq = seq;
    connection.queue.push(...frames);
  }

  private startInitial(connection: Connection): void {
    if (connection.closed) return;
    connection.peer.setBroadcast?.(false);
    let transfers = 0;
    for (const active of this.connections) if (active !== connection && active.initial) transfers++;
    if (this.world.editCount && transfers >= MAX_INITIAL_TRANSFERS) {
      this.fail(connection, 'Synchronisation occupée. Réessayez dans quelques instants.', true);
      return;
    }
    if (!this.baseline || this.baseline.revision !== this.revision) {
      if (this.world.editCount > MAX_INITIAL_EDITS) {
        this.fail(connection, 'Terrain trop volumineux pour la synchronisation.', true);
        return;
      }
      const retained = new Set<VoxelEdit[]>();
      for (const active of this.connections) if (active.initial) retained.add(active.initial.edits);
      let retainedEdits = this.world.editCount;
      for (const edits of retained) retainedEdits += edits.length;
      if (retainedEdits > MAX_RETAINED_BASELINE_EDITS) {
        this.fail(connection, 'Synchronisation occupée. Réessayez dans quelques instants.', true);
        return;
      }
      this.baseline = { revision: this.revision, edits: this.world.getEdits() };
    }
    connection.initial = { ...this.baseline, startedAt: this.now(), offset: 0, deltas: [], deltaEdits: 0 };
  }

  private streamInitial(connection: Connection, baselineBatches = 8): void {
    const initial = connection.initial;
    if (!initial) return;
    if (this.now() - initial.startedAt >= INITIAL_TIMEOUT_MS) {
      this.fail(connection, 'Synchronisation trop lente. Reconnectez-vous.', true);
      return;
    }
    if (connection.peer.bufferedAmount() > STREAM_BUFFER) return;
    if (initial.offset < initial.edits.length) {
      // Drain the largest baseline before continuous terrain changes fill its bounded delta queue.
      for (let batches = 0; batches < baselineBatches && initial.offset < initial.edits.length; batches++) {
        if (connection.peer.bufferedAmount() > STREAM_BUFFER) return;
        const edits = initial.edits.slice(initial.offset, initial.offset + WORLD_BATCH);
        if (!this.send(connection, { type: 'world', roundId: this.roundId, revision: initial.revision, initial: true, complete: false, edits })) return;
        initial.offset += edits.length;
      }
      return;
    }
    // Catch up faster than the normal one-delta-per-tick stream, with bounded work per connection.
    for (let batches = 0; batches < 4; batches++) {
      const delta = initial.deltas[0];
      if (!delta) break;
      if (connection.peer.bufferedAmount() > STREAM_BUFFER) return;
      if (!this.send(connection, { ...delta, initial: true, complete: false })) return;
      initial.deltas.shift();
      initial.deltaEdits -= delta.edits.length;
      initial.revision = delta.revision;
    }
    if (initial.deltas.length || connection.peer.bufferedAmount() > STREAM_BUFFER) return;
    if (!this.send(connection, { type: 'world', roundId: this.roundId, revision: initial.revision, initial: true, complete: true, edits: [] })) return;
    connection.initial = null;
    connection.peer.setBroadcast?.(true);
    this.sendSnapshot(connection);
  }

  private mutate(x: number, y: number, z: number, value: number): void {
    if (y <= 0 || x < 0 || z < 0 || x >= this.options.world.size || z >= this.options.world.size || y >= this.options.world.height) return;
    if (this.world.get(x, y, z) === value) return;
    this.world.set(x, y, z, value);
    this.edits.set(`${x},${y},${z}`, [x, y, z, value]);
  }

  private flushWorld(): void {
    if (!this.edits.size) return;
    const edits = [...this.edits.values()];
    this.edits.clear();
    for (let offset = 0; offset < edits.length; offset += WORLD_BATCH) {
      const message: WorldMessage = { type: 'world', roundId: this.roundId, revision: ++this.revision, edits: edits.slice(offset, offset + WORLD_BATCH) };
      const encoded = encodeServerMessage(message);
      for (const connection of this.connections) {
        if (!connection.player) continue;
        if (connection.initial) {
          if (connection.initial.deltaEdits + message.edits.length > MAX_INITIAL_DELTA_EDITS
            || connection.initial.deltas.length >= MAX_INITIAL_DELTA_MESSAGES) {
            this.fail(connection, 'Synchronisation dépassée. Reconnectez-vous.', true);
            continue;
          }
          connection.initial.deltas.push(message);
          connection.initial.deltaEdits += message.edits.length;
        } else if (!this.publish) this.send(connection, encoded);
      }
      this.publish?.(encoded);
    }
  }

  private spawnPosition(player: PlayerState): Vec3 | null {
    const size = this.options.world.size;
    for (let attempt = 0; attempt < 128; attempt++) {
      const a = this.random(), b = this.random();
      const base = player.team === 1 ? size * .2 : size * .8;
      const x = Math.floor(player.team ? base + (a - .5) * 32 : 4 + a * (size - 8)) + .5;
      const z = Math.floor(player.team ? base + (b - .5) * 32 : 4 + b * (size - 8)) + .5;
      if (x < 1 || z < 1 || x >= size - 1 || z >= size - 1) continue;
      // Start at the natural ground, so generated canopies and roofs are never spawn platforms.
      let y = Math.min(this.world.groundY(x, z) + 1, this.options.world.height - Math.ceil(PLAYER_HEIGHT));
      while (y > 0 && (!this.world.get(Math.floor(x), y - 1, Math.floor(z))
        || playerCollides(this.world, { x, y: y + .01, z }))) y--;
      if (!y) continue;
      y += .01;
      let blocked = false;
      for (const other of this.players.values()) {
        if (other.alive && Math.abs(other.position.x - x) < 1 && Math.abs(other.position.z - z) < 1
          && Math.abs(other.position.y - y) < PLAYER_HEIGHT) blocked = true;
      }
      if (!blocked) return { x, y, z };
    }
    return null;
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }

  private playerHit(origin: Vec3, direction: Vec3, distance: number, owner: number): { player: PlayerState; distance: number; point: Vec3 } | null {
    let closest: { player: PlayerState; distance: number; point: Vec3 } | null = null;
    for (const player of this.players.values()) {
      if (!player.alive || player.id === owner) continue;
      let near = 0, far = closest?.distance ?? distance;
      for (const axis of ['x', 'y', 'z'] as const) {
        const min = player.position[axis] - (axis === 'y' ? 0 : PLAYER_RADIUS);
        const max = player.position[axis] + (axis === 'y' ? PLAYER_HEIGHT : PLAYER_RADIUS);
        if (Math.abs(direction[axis]) < 1e-8) {
          if (origin[axis] < min || origin[axis] > max) { far = -1; break; }
        } else {
          const a = (min - origin[axis]) / direction[axis], b = (max - origin[axis]) / direction[axis];
          near = Math.max(near, Math.min(a, b));
          far = Math.min(far, Math.max(a, b));
        }
        if (far < near) break;
      }
      if (far >= near && near <= distance) {
        closest = { player, distance: near, point: { x: origin.x + direction.x * near, y: origin.y + direction.y * near, z: origin.z + direction.z * near } };
      }
    }
    return closest;
  }

  private event(event: GameEvent['event'], position: Vec3, details: Partial<GameEvent> = {}): void {
    this.broadcast({ type: 'event', roundId: this.roundId, tick: this.tick, event, position: { ...position }, ...details });
  }

  private hurt(player: PlayerState, damage: number, owner: number, headshot = false,
    hit?: { weapon: WeaponId; point: Vec3; impulse: Vec3 }): void {
    if (!player.alive) return;
    player.health = Math.max(0, player.health - damage);
    if (player.health > 0) return;
    player.alive = false;
    player.deaths++;
    const death = { player: { ...player, position: { ...player.position }, velocity: { ...player.velocity } },
      hitPoint: { ...(hit?.point ?? player.position) }, impulse: { ...(hit?.impulse ?? { x: 0, y: 0, z: 0 }) } };
    player.aiming = false;
    const shooter = this.players.get(owner);
    if (shooter && shooter !== player) shooter.kills++;
    if (player.team === 1) this.scores[1]++;
    if (player.team === 2) this.scores[0]++;
    for (const connection of this.connections) {
      if (connection.player === player) {
        connection.lobbySince = this.now();
        connection.queue = [];
        connection.input = null;
        for (const pose of connection.weaponPoses.values()) { pose.charge = 0; pose.fireHeld = false; pose.altHeld = false; }
      }
    }
    this.event('death', player.position, { shooterId: owner, targetId: player.id, weapon: hit?.weapon, headshot, death });
  }

  private action(connection: Connection, frame: InputFrame, previousYaw: number, previousPitch: number): void {
    const player = connection.player!;
    const previousWeapon = player.weapon;
    player.weapon = frame.weapon;
    let pose = connection.weaponPoses.get(player.weapon);
    if (!pose) { pose = createWeaponPose(player.weapon); connection.weaponPoses.set(player.weapon, pose); }
    if (previousWeapon !== player.weapon) {
      const previousPose = connection.weaponPoses.get(previousWeapon);
      if (previousPose) { hideWeaponPose(previousPose); previousPose.charge = 0; previousPose.fireHeld = false; previousPose.altHeld = false; }
      pose.fireHeld = connection.previousFire && frame.fire;
      pose.altHeld = connection.previousAlt && frame.alt;
    }
    const throwMuzzle = player.weapon === 'grenade' ? getWeaponMuzzle(pose) : null;
    stepWeaponMotion(connection.weaponMotion, frame.cancelActions ? { moveX: 0, moveZ: 0, sprint: false } : frame);
    const actions = stepWeaponPose(pose, { fire: frame.fire, alt: frame.alt, sprint: frame.sprint,
      localVelocity: connection.weaponMotion, lookDeltaYaw: Math.atan2(Math.sin(player.yaw - previousYaw), Math.cos(player.yaw - previousYaw)),
      lookDeltaPitch: player.pitch - previousPitch, grenades: player.grenades, cancelActions: frame.cancelActions }, this.combatRandom);
    connection.previousFire = frame.fire && !frame.cancelActions;
    connection.previousAlt = frame.alt && !frame.cancelActions;
    player.aiming = pose.altHeld && (player.weapon === 'ak47' || player.weapon === 'awp');
    player.ammo = player.weapon === 'ak47' || player.weapon === 'awp' ? connection.magazines[player.weapon] : 0;
    const eye = { x: player.position.x, y: player.position.y + EYE_HEIGHT, z: player.position.z };
    const aim = aimDirection(player.yaw, player.pitch);

    if (actions.thrown && this.projectiles.size < this.options.maxPlayers * 32) {
      const { position, velocity } = grenadeLaunch(this.world, player, throwMuzzle!, actions.force);
      player.grenades--;
      const id = this.nextProjectile++;
      this.projectiles.set(id, { id, owner: player.id, weapon: 'grenade', position, velocity,
        damage: WEAPONS.grenade.damage, expires: this.tick + 2 * TICK_RATE, gravity: 0 });
      this.event('shot', position, { shooterId: player.id, weapon: 'grenade', projectileId: id, velocity: { ...velocity }, inputSeq: player.lastSeq });
    }
    if (actions.fired && (player.weapon === 'ak47' || player.weapon === 'awp')) {
      const muzzle = getWeaponMuzzle(pose);
      const sy = Math.sin(player.yaw), cy = Math.cos(player.yaw), sp = Math.sin(player.pitch), cp = Math.cos(player.pitch);
      const toWorld = (v: Vec3): Vec3 => ({ x: cy * v.x + sy * sp * v.y + aim.x * v.z,
        y: cp * v.y + aim.y * v.z, z: -sy * v.x + cy * sp * v.y + aim.z * v.z });
      const offset = toWorld(muzzle.position), direction = toWorld(muzzle.direction);
      const length = Math.hypot(direction.x, direction.y, direction.z);
      this.shots.push({ id: this.nextProjectile++, owner: player.id, weapon: player.weapon, inputSeq: player.lastSeq, eye,
        origin: { x: eye.x + offset.x, y: eye.y + offset.y, z: eye.z + offset.z },
        direction: { x: direction.x / length, y: direction.y / length, z: direction.z / length } });
      connection.magazines[player.weapon]--;
      if (connection.magazines[player.weapon] < 0) connection.magazines[player.weapon] = WEAPONS[player.weapon].magazine;
      player.ammo = connection.magazines[player.weapon];
    }
    if (!actions.melee && !actions.heal && !actions.build) return;
    const block = raycast(this.world, eye, aim, 5);
    const target = this.playerHit(eye, aim, block?.distance ?? 5, player.id);
    if (actions.heal && target) {
      target.player.health = Math.min(100, target.player.health + 10);
      this.event('heal', target.point, { shooterId: player.id, targetId: target.player.id, weapon: 'medic' });
    } else if (actions.melee && target && target.distance < 2) {
      const headshot = target.point.y - target.player.position.y >= PLAYER_HEIGHT / 2 + .813;
      this.hurt(target.player, headshot ? 100 : WEAPONS.shovel.damage, player.id, headshot,
        { weapon: 'shovel', point: target.point, impulse: { x: aim.x * 8, y: aim.y * 8, z: aim.z * 8 } });
      this.event('impact', target.point, { shooterId: player.id, targetId: target.player.id, weapon: 'shovel', headshot });
    } else if (player.weapon === 'shovel' && block && !target) {
      if (actions.melee) {
        const blockColor = block.value & 0xffffff;
        this.mutate(block.x, block.y, block.z, damageBlock(block.value, .5));
        this.event('impact', block.point, { shooterId: player.id, weapon: 'shovel', blockColor });
      } else if (actions.build) {
        const x = block.x + block.normal.x, y = block.y + block.normal.y, z = block.z + block.normal.z;
        let occupied = !!this.world.get(x, y, z);
        for (const other of this.players.values()) {
          if (other.alive && other.position.x + PLAYER_RADIUS > x && other.position.x - PLAYER_RADIUS < x + 1
            && other.position.z + PLAYER_RADIUS > z && other.position.z - PLAYER_RADIUS < z + 1
            && other.position.y + PLAYER_HEIGHT > y && other.position.y < y + 1) occupied = true;
        }
        if (!occupied && y > 0 && y < this.options.world.height && x >= 0 && z >= 0 && x < this.options.world.size && z < this.options.world.size) {
          this.mutate(x, y, z, packBlock(85, 85, 85));
          this.event('build', { x: x + .5, y: y + .5, z: z + .5 }, { shooterId: player.id, weapon: 'shovel' });
        }
      }
    }
  }
  private explode(projectile: Projectile): void {
    const position = projectile.position;
    for (let x = Math.floor(position.x) - 4; x <= Math.floor(position.x) + 4; x++) {
      for (let y = Math.floor(position.y) - 4; y <= Math.floor(position.y) + 4; y++) {
        for (let z = Math.floor(position.z) - 4; z <= Math.floor(position.z) + 4; z++) {
          const distance = Math.hypot(x + .5 - position.x, y + .5 - position.y, z + .5 - position.z);
          const value = this.world.get(x, y, z);
          if (value && distance < 4) this.mutate(x, y, z, damageBlock(value, Math.min(1, (1 - distance / 4) * 3)));
        }
      }
    }
    for (const player of this.players.values()) {
      if (!player.alive) continue;
      const dx = player.position.x - position.x, dy = player.position.y - position.y, dz = player.position.z - position.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= 10) continue;
      const hitPoint = { x: player.position.x, y: player.position.y + PLAYER_HEIGHT * .65, z: player.position.z };
      const torsoDy = hitPoint.y - position.y;
      const torsoDistance = Math.hypot(dx, torsoDy, dz);
      // Cosmetic impulse acts at the torso; capture the corpse before the existing gameplay knockback.
      const corpseImpulse = (1 - distance / 10) * 20;
      this.hurt(player, Math.floor((10 - distance) * 10), projectile.owner, false, { weapon: 'grenade', point: hitPoint,
        impulse: torsoDistance > 1e-8 ? { x: dx / torsoDistance * corpseImpulse, y: torsoDy / torsoDistance * corpseImpulse,
          z: dz / torsoDistance * corpseImpulse } : { x: 0, y: corpseImpulse, z: 0 } });
      const impulse = (1 - distance / 10) * 12;
      player.velocity.x += dx / Math.max(distance, .1) * impulse;
      player.velocity.y += 4;
      player.velocity.z += dz / Math.max(distance, .1) * impulse;
    }
    this.event('explosion', position, { shooterId: projectile.owner, weapon: 'grenade', projectileId: projectile.id });
  }

  private resolveShots(): void {
    for (const shot of this.shots) {
      const { direction, weapon, owner, id } = shot;
      const offset = { x: shot.origin.x - shot.eye.x, y: shot.origin.y - shot.eye.y, z: shot.origin.z - shot.eye.z };
      const muzzleDistance = Math.hypot(offset.x, offset.y, offset.z);
      let block = raycast(this.world, shot.eye, offset, muzzleDistance);
      let target = muzzleDistance > 0 ? this.playerHit(shot.eye,
        { x: offset.x / muzzleDistance, y: offset.y / muzzleDistance, z: offset.z / muzzleDistance },
        block?.distance ?? muzzleDistance, owner) : null;
      // Resolve an overlapping barrel's first contact before tracing beyond its muzzle.
      const origin = target ? target.point : block ? {
        x: block.point.x + block.normal.x * .001, y: block.point.y + block.normal.y * .001,
        z: block.point.z + block.normal.z * .001,
      } : shot.origin;
      let distance = WEAPONS[weapon].range;
      if (!target && !block) {
        const bounds = { x: this.world.config.size, y: this.world.config.height + 64, z: this.world.config.size };
        for (const axis of ['x', 'y', 'z'] as const) {
          if (origin[axis] < 0 || origin[axis] > bounds[axis]) { distance = 0; break; }
          if (direction[axis] !== 0) distance = Math.min(distance,
            Math.max(0, ((direction[axis] > 0 ? bounds[axis] : 0) - origin[axis]) / direction[axis]));
        }
        block = raycast(this.world, origin, direction, distance);
        target = this.playerHit(origin, direction, block?.distance ?? distance, owner);
      }
      const endPosition = target?.point ?? block?.point ?? {
        x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance,
      };
      this.event('shot', origin, { shooterId: owner, weapon, projectileId: id, inputSeq: shot.inputSeq, endPosition });
      if (target) {
        const headshot = target.point.y - target.player.position.y >= PLAYER_HEIGHT / 2 + .813;
        const corpseImpulse = weapon === 'awp' ? 80 : 48;
        this.hurt(target.player, headshot ? 100 : WEAPONS[weapon].damage, owner, headshot,
          { weapon, point: target.point,
            impulse: { x: direction.x * corpseImpulse, y: direction.y * corpseImpulse, z: direction.z * corpseImpulse } });
        this.event('impact', target.point, { shooterId: owner, targetId: target.player.id, weapon, headshot, projectileId: id });
      } else if (block) {
        const blockColor = block.value & 0xffffff;
        this.mutate(block.x, block.y, block.z, damageBlock(block.value, WEAPONS[weapon].damage / 200));
        this.event('impact', block.point, { shooterId: owner, weapon, blockColor, projectileId: id });
      }
    }
    this.shots.length = 0;
  }

  private updateProjectiles(): void {
    for (const projectile of this.projectiles.values()) {
      if (this.tick >= projectile.expires) {
        this.explode(projectile);
        this.projectiles.delete(projectile.id);
        continue;
      }
      stepGrenade(projectile, this.world);
      const { x, y, z } = projectile.position;
      if (x < 0 || z < 0 || y < 0 || x >= this.options.world.size || z >= this.options.world.size || y > this.options.world.height + 64) {
        this.event('projectile-end', projectile.position, { shooterId: projectile.owner, weapon: projectile.weapon, projectileId: projectile.id });
        this.projectiles.delete(projectile.id);
      }
    }
  }
  step(): void {
    this.tick++;
    const now = this.now();
    if (this.options.roundSeconds > 0 && this.tick - this.roundStart >= this.options.roundSeconds * TICK_RATE) this.resetRound();
    for (const connection of this.connections) {
      if ((!connection.player && now - connection.connectedAt > 5000) || now - connection.lastMessage > 30000) {
        this.fail(connection, 'Connexion expirée.', true);
        continue;
      }
      if (connection.peer.bufferedAmount() > MAX_BUFFER) {
        this.disconnect(connection);
        connection.peer.close(1013, 'Connection too slow');
        continue;
      }
      if (connection.initial) { this.streamInitial(connection); continue; }
      const player = connection.player;
      if (player && !player.alive && now - connection.lobbySince > 120000) {
        this.fail(connection, 'Équipement inactif : reconnectez-vous pour jouer.', true);
        continue;
      }
      if (!player?.alive) continue;
      // Recover from delivery jitter without consuming button edges or extra simulation ticks.
      if (connection.input && this.tick - connection.lastInputTick <= 15) {
        while (connection.queue.length > 1 && sameActionState(connection.input, connection.queue[0])
          && sameActionState(connection.queue[0], connection.queue[1])) connection.queue.shift();
      }
      const next = connection.queue.shift();
      if (next) {
        connection.input = next;
        connection.lastInputTick = this.tick;
        player.lastSeq = next.seq;
      }
      let frame = connection.input;
      if (!frame || this.tick - connection.lastInputTick > 15) {
        connection.previousFire = false;
        connection.previousAlt = false;
        frame = { seq: player.lastSeq, roundId: this.roundId, moveX: 0, moveZ: 0, yaw: player.yaw, pitch: player.pitch,
          jump: false, sprint: false, fire: false, alt: false, weapon: player.weapon, cancelActions: true };
      }
      const previousYaw = player.yaw, previousPitch = player.pitch;
      movePlayer(player, frame, this.world, DT);
      this.action(connection, frame, previousYaw, previousPitch);
      if (player.position.y < -10) this.hurt(player, 100, player.id);
    }
    // Every accepted shot uses this tick's completed movement, including a shooter's fatal return shot.
    this.resolveShots();
    this.updateProjectiles();
    this.flushWorld();
    if (this.tick % 3 === 0) this.sendSnapshot();
  }

  sendSnapshot(only?: Connection): void {
    const snapshot: ServerMessage = {
      type: 'snapshot', roundId: this.roundId, tick: this.tick, players: [...this.players.values()],
      projectiles: [...this.projectiles.values()].map(({ id, position, velocity, weapon, owner }) => ({ id, position, velocity, weapon, owner })),
      scores: this.scores,
      remaining: this.options.roundSeconds ? Math.max(0, this.options.roundSeconds - (this.tick - this.roundStart) * DT) : null,
    };
    if (only) this.send(only, snapshot, true); else this.broadcast(snapshot);
  }

  resetRound(): void {
    this.roundId++;
    this.roundStart = this.tick;
    this.world = new VoxelWorld(this.options.world);
    this.revision = 0;
    this.edits.clear();
    this.baseline = null;
    this.projectiles.clear();
    this.shots.length = 0;
    this.scores = [0, 0];
    for (const connection of this.connections) {
      connection.queue = [];
      connection.input = null;
      connection.highestSeq = 0;
      connection.weaponPoses.clear();
      connection.previousFire = false;
      connection.previousAlt = false;
      if (!connection.player) continue;
      connection.lobbySince = this.now();
      Object.assign(connection.player, { alive: false, aiming: false, health: 100, kills: 0, deaths: 0, lastSeq: 0, grenades: 10 });
      this.send(connection, { type: 'reset', roundId: this.roundId, world: this.options.world });
      this.startInitial(connection);
      this.streamInitial(connection);
    }
  }
}
