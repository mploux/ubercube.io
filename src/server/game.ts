import { DT, KITS, PROTOCOL_VERSION, TICK_RATE, WEAPONS } from '../shared/protocol.ts';
import type { GameEvent, InputFrame, Kit, Mode, PlayerState, ProjectileState, ServerMessage, Vec3, VoxelEdit, WeaponId, WorldConfig } from '../shared/protocol.ts';
import { aimDirection, EYE_HEIGHT, movePlayer, PLAYER_HEIGHT, PLAYER_RADIUS } from '../shared/movement.ts';
import { damageBlock, packBlock, raycast, VoxelWorld } from '../shared/voxel.ts';
import { encodeServerMessage } from '../shared/wire.ts';

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
  rateTick: number;
  messages: number;
  frames: number;
  invalid: number;
  lastMessage: number;
  queue: InputFrame[];
  input: InputFrame | null;
  highestSeq: number;
  lastInputTick: number;
  nextAction: number;
  previousFire: boolean;
  previousAlt: boolean;
  grenadeCharge: number | null;
  magazines: { ak47: number; awp: number };
  initial: InitialWorld | null;
}
interface Projectile extends ProjectileState { damage: number; expires: number }

const INPUT_KEYS = ['seq', 'roundId', 'moveX', 'moveZ', 'yaw', 'pitch', 'jump', 'sprint', 'fire', 'alt', 'weapon'];
const WORLD_BATCH = 512;
const MAX_BUFFER = 512 * 1024;
const STREAM_BUFFER = 64 * 1024;
const MAX_INPUT_QUEUE = 12;

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
  return record(value) && keys(value, INPUT_KEYS)
    && number(value.seq, 1, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(value.seq)
    && number(value.roundId, 1, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(value.roundId)
    && number(value.moveX, -1, 1) && number(value.moveZ, -1, 1)
    && number(value.yaw, -Math.PI * 2, Math.PI * 2) && number(value.pitch, -Math.PI / 2, Math.PI / 2)
    && ['jump', 'sprint', 'fire', 'alt'].every(key => typeof value[key] === 'boolean') && weapon(value.weapon);
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
  private randomState: number;
  private edits = new Map<string, VoxelEdit>();
  private baseline: { revision: number; edits: VoxelEdit[] } | null = null;

  constructor(options: Partial<GameOptions> = {}, private readonly publish?: (data: string | Uint8Array) => void) {
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
    const connection: Connection = {
      peer, player: null, closed: false, connectedAt: this.tick, rateTick: this.tick, messages: 0, frames: 0,
      invalid: 0, lastMessage: this.tick, queue: [], input: null, highestSeq: 0, lastInputTick: this.tick,
      nextAction: 0, previousFire: false, previousAlt: false, grenadeCharge: null,
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
    if (fatal) {
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
    if (this.publish) { this.publish(encoded); return; }
    for (const connection of this.connections) {
      if (connection.player && !connection.initial) this.send(connection, encoded, message.type === 'snapshot');
    }
  }

  receive(connection: Connection, text: string): void {
    if (connection.closed) return;
    if (this.tick - connection.rateTick >= TICK_RATE) {
      connection.rateTick = this.tick;
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
    connection.lastMessage = this.tick;
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
        health: 100, alive: false, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
      };
      connection.player = player;
      this.players.set(player.id, player);
      this.flushWorld();
      this.send(connection, { type: 'welcome', id: player.id, roundId: this.roundId, mode: this.options.mode,
        maxPlayers: this.options.maxPlayers, world: this.options.world, tickRate: TICK_RATE });
      this.startInitial(connection);
      this.streamInitial(connection);
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
      connection.magazines = { ak47: 30, awp: 5 };
      player.ammo = WEAPONS[player.weapon].magazine;
      connection.queue = [];
      connection.input = null;
      connection.previousFire = false;
      connection.previousAlt = false;
      connection.grenadeCharge = null;
      connection.nextAction = this.tick;
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
    connection.peer.setBroadcast?.(false);
    if (!this.baseline || this.baseline.revision !== this.revision) {
      this.baseline = { revision: this.revision, edits: this.world.getEdits() };
    }
    connection.initial = { ...this.baseline, offset: 0, deltas: [], deltaEdits: 0 };
  }

  private streamInitial(connection: Connection): void {
    const initial = connection.initial;
    if (!initial || connection.peer.bufferedAmount() > STREAM_BUFFER) return;
    if (initial.deltaEdits > 32768) this.startInitial(connection);
    if (connection.initial !== initial) return;
    if (initial.offset < initial.edits.length) {
      const edits = initial.edits.slice(initial.offset, initial.offset + WORLD_BATCH);
      if (this.send(connection, { type: 'world', roundId: this.roundId, revision: initial.revision, initial: true, complete: false, edits })) {
        initial.offset += edits.length;
      }
      return;
    }
    const delta = initial.deltas[0];
    if (delta) {
      if (this.send(connection, { ...delta, initial: true, complete: false })) {
        initial.deltas.shift();
        initial.deltaEdits -= delta.edits.length;
        initial.revision = delta.revision;
      }
      return;
    }
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
      const y = this.world.surfaceY(Math.floor(x), Math.floor(z)) + .01;
      if (y + PLAYER_HEIGHT >= this.options.world.height) continue;
      let blocked = false;
      for (let iy = Math.floor(y); iy <= Math.floor(y + PLAYER_HEIGHT); iy++) {
        if (this.world.get(Math.floor(x), iy, Math.floor(z))) blocked = true;
      }
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
    this.broadcast({ type: 'event', roundId: this.roundId, event, position: { ...position }, ...details });
  }

  private hurt(player: PlayerState, damage: number, owner: number, headshot = false): void {
    if (!player.alive) return;
    player.health = Math.max(0, player.health - damage);
    if (player.health > 0) return;
    player.alive = false;
    player.deaths++;
    const shooter = this.players.get(owner);
    if (shooter && shooter !== player) shooter.kills++;
    if (player.team === 1) this.scores[1]++;
    if (player.team === 2) this.scores[0]++;
    for (const connection of this.connections) {
      if (connection.player === player) {
        connection.queue = [];
        connection.input = null;
        connection.grenadeCharge = null;
      }
    }
    this.event('death', player.position, { shooterId: owner, targetId: player.id, headshot });
  }

  private action(connection: Connection, frame: InputFrame, fresh: boolean): void {
    const player = connection.player!;
    const previousWeapon = player.weapon;
    player.weapon = frame.weapon;
    player.ammo = player.weapon === 'ak47' || player.weapon === 'awp' ? connection.magazines[player.weapon] : 0;
    if (previousWeapon !== player.weapon) connection.grenadeCharge = null;
    const origin = { x: player.position.x, y: player.position.y + EYE_HEIGHT, z: player.position.z };
    const direction = aimDirection(player.yaw, player.pitch);
    const justFire = fresh && frame.fire && !connection.previousFire;
    const justAlt = fresh && frame.alt && !connection.previousAlt;
    if (player.weapon === 'grenade') {
      if (frame.fire && player.grenades > 0 && this.tick >= connection.nextAction) {
        connection.grenadeCharge = (connection.grenadeCharge ?? 0) + DT;
      } else if (fresh && !frame.fire && connection.previousFire && connection.grenadeCharge !== null && player.grenades > 0) {
        if (this.projectiles.size < this.options.maxPlayers * 32) {
          const speed = 4 + 14 * (1 - Math.exp(-6 * connection.grenadeCharge));
          const id = this.nextProjectile++;
          this.projectiles.set(id, { id, owner: player.id, weapon: 'grenade', position: origin,
            velocity: { x: direction.x * speed + player.velocity.x, y: direction.y * speed + player.velocity.y, z: direction.z * speed + player.velocity.z },
            damage: 100, expires: this.tick + 2 * TICK_RATE });
          player.grenades--;
          this.event('shot', origin, { shooterId: player.id, weapon: 'grenade' });
          connection.nextAction = this.tick + Math.round(WEAPONS.grenade.interval * TICK_RATE);
        }
        connection.grenadeCharge = null;
      }
    } else if (this.tick >= connection.nextAction) {
      const definition = WEAPONS[player.weapon];
      if ((player.weapon === 'ak47' || player.weapon === 'awp') && frame.fire && this.projectiles.size < this.options.maxPlayers * 32) {
        if (connection.magazines[player.weapon] <= 0) connection.magazines[player.weapon] = definition.magazine;
        player.ammo = --connection.magazines[player.weapon];
        const id = this.nextProjectile++;
        const spread = frame.alt ? .001 : .025;
        const shotDirection = aimDirection(player.yaw + (this.random() * 2 - 1) * spread,
          Math.max(-Math.PI / 2, Math.min(Math.PI / 2, player.pitch + (this.random() * 2 - 1) * spread)));
        this.projectiles.set(id, { id, owner: player.id, weapon: player.weapon, position: origin,
          velocity: { x: shotDirection.x * definition.speed, y: shotDirection.y * definition.speed, z: shotDirection.z * definition.speed },
          damage: definition.damage, expires: this.tick + 8 * TICK_RATE });
        this.event('shot', origin, { shooterId: player.id, weapon: player.weapon });
        connection.nextAction = this.tick + Math.round(definition.interval * TICK_RATE);
      } else if ((player.weapon === 'shovel' && (justFire || justAlt)) || (player.weapon === 'medic' && justFire)) {
        const block = raycast(this.world, origin, direction, 5);
        const target = this.playerHit(origin, direction, block?.distance ?? 5, player.id);
        if (player.weapon === 'medic' && target) {
          target.player.health = Math.min(100, target.player.health + 10);
          this.event('heal', target.point, { shooterId: player.id, targetId: target.player.id, weapon: 'medic' });
        } else if (player.weapon === 'shovel' && target && justFire && target.distance < 2) {
          const headshot = target.point.y - target.player.position.y >= PLAYER_HEIGHT * .8;
          this.hurt(target.player, headshot ? 100 : definition.damage, player.id, headshot);
          this.event('impact', target.point, { shooterId: player.id, targetId: target.player.id, weapon: 'shovel', headshot });
        } else if (player.weapon === 'shovel' && block && !target) {
          if (justFire) {
            this.mutate(block.x, block.y, block.z, damageBlock(block.value, .5));
            this.event('impact', block.point, { shooterId: player.id, weapon: 'shovel' });
          } else {
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
        connection.nextAction = this.tick + Math.round(definition.interval * TICK_RATE);
      }
    }
    if (fresh) {
      connection.previousFire = frame.fire;
      connection.previousAlt = frame.alt;
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
      this.hurt(player, Math.floor((10 - distance) * 10), projectile.owner);
      const impulse = (1 - distance / 10) * 12;
      player.velocity.x += dx / Math.max(distance, .1) * impulse;
      player.velocity.y += 4;
      player.velocity.z += dz / Math.max(distance, .1) * impulse;
    }
    this.event('explosion', position, { shooterId: projectile.owner, weapon: 'grenade' });
  }

  private updateProjectiles(): void {
    for (const projectile of this.projectiles.values()) {
      if (this.tick >= projectile.expires) {
        if (projectile.weapon === 'grenade') this.explode(projectile);
        this.projectiles.delete(projectile.id);
        continue;
      }
      if (projectile.weapon === 'grenade') projectile.velocity.y -= 24 * DT;
      const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z);
      if (speed < .001) continue;
      const direction = { x: projectile.velocity.x / speed, y: projectile.velocity.y / speed, z: projectile.velocity.z / speed };
      const distance = speed * DT;
      const block = raycast(this.world, projectile.position, direction, distance);
      if (projectile.weapon !== 'grenade') {
        const target = this.playerHit(projectile.position, direction, block?.distance ?? distance, projectile.owner);
        if (target) {
          const headshot = target.point.y - target.player.position.y >= PLAYER_HEIGHT * .8;
          this.hurt(target.player, headshot ? 100 : projectile.damage, projectile.owner, headshot);
          this.event('impact', target.point, { shooterId: projectile.owner, targetId: target.player.id, weapon: projectile.weapon, headshot });
          this.projectiles.delete(projectile.id);
          continue;
        }
      }
      if (block) {
        if (projectile.weapon === 'grenade') {
          projectile.position = { x: block.point.x + block.normal.x * .02, y: block.point.y + block.normal.y * .02, z: block.point.z + block.normal.z * .02 };
          const dot = projectile.velocity.x * block.normal.x + projectile.velocity.y * block.normal.y + projectile.velocity.z * block.normal.z;
          projectile.velocity.x = (projectile.velocity.x - 1.6 * dot * block.normal.x) * .88;
          projectile.velocity.y = (projectile.velocity.y - 1.6 * dot * block.normal.y) * .88;
          projectile.velocity.z = (projectile.velocity.z - 1.6 * dot * block.normal.z) * .88;
        } else {
          this.mutate(block.x, block.y, block.z, damageBlock(block.value, projectile.damage / 200));
          this.event('impact', block.point, { shooterId: projectile.owner, weapon: projectile.weapon });
          this.projectiles.delete(projectile.id);
        }
      } else {
        projectile.position.x += projectile.velocity.x * DT;
        projectile.position.y += projectile.velocity.y * DT;
        projectile.position.z += projectile.velocity.z * DT;
      }
      const { x, y, z } = projectile.position;
      if (x < 0 || z < 0 || y < 0 || x >= this.options.world.size || z >= this.options.world.size || y > this.options.world.height + 64) {
        this.projectiles.delete(projectile.id);
      }
    }
  }

  step(): void {
    this.tick++;
    if (this.options.roundSeconds > 0 && this.tick - this.roundStart >= this.options.roundSeconds * TICK_RATE) this.resetRound();
    for (const connection of this.connections) {
      if ((!connection.player && this.tick - connection.connectedAt > 5 * TICK_RATE) || this.tick - connection.lastMessage > 30 * TICK_RATE) {
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
      if (!player?.alive) continue;
      const next = connection.queue.shift();
      if (next) {
        connection.input = next;
        connection.lastInputTick = this.tick;
        player.lastSeq = next.seq;
      }
      let frame = connection.input;
      if (!frame || this.tick - connection.lastInputTick > 15) {
        connection.grenadeCharge = null;
        connection.previousFire = false;
        connection.previousAlt = false;
        frame = { seq: player.lastSeq, roundId: this.roundId, moveX: 0, moveZ: 0, yaw: player.yaw, pitch: player.pitch,
          jump: false, sprint: false, fire: false, alt: false, weapon: player.weapon };
      }
      movePlayer(player, frame, this.world, DT);
      this.action(connection, frame, !!next);
      if (player.position.y < -10) this.hurt(player, 100, player.id);
    }
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
    this.scores = [0, 0];
    for (const connection of this.connections) {
      connection.queue = [];
      connection.input = null;
      connection.highestSeq = 0;
      connection.grenadeCharge = null;
      connection.previousFire = false;
      connection.previousAlt = false;
      if (!connection.player) continue;
      Object.assign(connection.player, { alive: false, health: 100, kills: 0, deaths: 0, lastSeq: 0, grenades: 10 });
      this.send(connection, { type: 'reset', roundId: this.roundId, world: this.options.world });
      this.startInitial(connection);
      this.streamInitial(connection);
    }
  }
}
