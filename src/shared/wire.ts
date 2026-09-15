import type { GameEvent, Kit, PlayerState, ProjectileState, ServerMessage, VoxelEdit, WeaponId } from './protocol';

const MAGIC = 0x55424331;
const VERSION = 3;
const WORLD_BATCH_LIMIT = 512;
const kits: Kit[] = ['assault', 'sniper', 'medic'];
const weapons: WeaponId[] = ['ak47', 'awp', 'shovel', 'grenade', 'medic'];
const events: GameEvent['event'][] = ['shot', 'impact', 'explosion', 'heal', 'build', 'projectile-end'];
const binaryTypes = ['snapshot', 'world', 'event', 'snapshot', 'snapshot'] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function integer(n: number, max: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error('Invalid wire integer');
  return n;
}

function varintLength(n: number, max: number) {
  integer(n, max);
  let length = 1;
  while (n >= 128) { n = Math.floor(n / 128); length++; }
  return length;
}

function eventLength(flags: number) {
  return 37 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 1 : 0)
    + (flags & 32 ? 4 : 0) + (flags & 64 ? 4 : 0) + (flags & 128 ? 24 : 0)
    + (flags & 256 ? 4 : 0) + (flags & 512 ? 8 : 0) + (flags & 1024 ? 24 : 0);
}

export function serverMessageType(data: string | ArrayBuffer | ArrayBufferView): ServerMessage['type'] {
  if (typeof data === 'string') {
    const match = /^\{"type":"(welcome|world|snapshot|reset|error|pong|event)"[,}]/.exec(data.slice(0, 32));
    if (!match) throw new Error('Invalid server message type');
    return match[1] as ServerMessage['type'];
  }
  const view = ArrayBuffer.isView(data) ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  if (view.byteLength < 6 || view.getUint32(0, true) !== MAGIC || view.getUint8(4) !== VERSION) throw new Error('Invalid wire header');
  const type = binaryTypes[view.getUint8(5) - 1];
  if (!type) throw new Error('Invalid wire message type');
  return type;
}

export function encodeServerMessage(message: ServerMessage): string | Uint8Array {
  if (message.type !== 'snapshot' && message.type !== 'world'
    && (message.type !== 'event' || message.event === 'death' || message.death !== undefined)) {
    if (!['welcome', 'reset', 'error', 'pong', 'event'].includes(message.type)) throw new Error('Unsupported logical message; snapshot deltas require encodeSnapshot');
    return JSON.stringify(message);
  }
  let length: number;
  let flags = 0;
  let names: Uint8Array[] = [];
  const playerFloats: number[][] = [], floatMasks: number[] = [];
  if (message.type === 'world') {
    if (message.edits.length > WORLD_BATCH_LIMIT) throw new Error('World batch exceeds wire limit');
    flags = (message.initial !== undefined ? 1 : 0) | (message.initial ? 2 : 0)
      | (message.complete !== undefined ? 4 : 0) | (message.complete ? 8 : 0);
    length = 17 + message.edits.length * 10;
  } else if (message.type === 'event') {
    flags = (message.shooterId !== undefined ? 1 : 0) | (message.targetId !== undefined ? 2 : 0)
      | (message.weapon !== undefined ? 4 : 0) | (message.headshot !== undefined ? 8 : 0) | (message.headshot ? 16 : 0)
      | (message.blockColor !== undefined ? 32 : 0) | (message.projectileId !== undefined ? 64 : 0)
      | (message.velocity !== undefined ? 128 : 0) | (message.tick !== undefined ? 256 : 0)
      | (message.inputSeq !== undefined ? 512 : 0) | (message.endPosition !== undefined ? 1024 : 0);
    length = eventLength(flags);
  } else {
    if (message.players.length > 1000 || message.projectiles.length > 32000) throw new Error('Snapshot exceeds wire limit');
    names = message.players.map(player => encoder.encode(player.name));
    if (names.some(name => name.length > 255)) throw new Error('Player name exceeds wire limit');
    length = 30 + message.projectiles.length * 33;
    for (const [index, player] of message.players.entries()) {
      const floats = [player.position.x, player.position.y, player.position.z,
        player.velocity.x, player.velocity.y, player.velocity.z, player.yaw, player.pitch];
      let mask = 0;
      for (const [index, value] of floats.entries()) {
        if (Object.is(Math.fround(value), 0)) mask |= 1 << index;
        else length += 4;
      }
      playerFloats.push(floats); floatMasks.push(mask);
      length += 7 + names[index].length + varintLength(player.id, 0xffffffff)
        + varintLength(player.kills, 0xffffffff) + varintLength(player.deaths, 0xffffffff)
        + varintLength(player.lastSeq, Number.MAX_SAFE_INTEGER);
    }
  }
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u8 = (n: number) => { view.setUint8(offset, integer(n, 255)); offset++; };
  const u16 = (n: number) => { view.setUint16(offset, integer(n, 65535), true); offset += 2; };
  const u32 = (n: number) => { view.setUint32(offset, integer(n, 0xffffffff), true); offset += 4; };
  const f32 = (n: number) => {
    if (!Number.isFinite(Math.fround(n))) throw new Error('Invalid wire float');
    view.setFloat32(offset, n, true); offset += 4;
  };
  const f64 = (n: number) => {
    if (!Number.isFinite(n)) throw new Error('Invalid wire float');
    view.setFloat64(offset, n, true); offset += 8;
  };
  const varint = (n: number) => {
    do { const value = n % 128; n = Math.floor(n / 128); u8(value + (n ? 128 : 0)); } while (n);
  };
  u32(MAGIC); u8(VERSION); u8(binaryTypes.indexOf(message.type) + 1);
  if (message.type === 'world') {
    u32(message.roundId); u32(message.revision); u8(flags); u16(message.edits.length);
    for (const [x, y, z, value] of message.edits) { u16(x); u16(y); u16(z); u32(value); }
    return bytes;
  }
  if (message.type === 'event') {
    u32(message.roundId); u8(events.indexOf(message.event)); u16(flags);
    f64(message.position.x); f64(message.position.y); f64(message.position.z);
    if (message.shooterId !== undefined) u32(message.shooterId);
    if (message.targetId !== undefined) u32(message.targetId);
    if (message.weapon !== undefined) u8(weapons.indexOf(message.weapon));
    if (message.blockColor !== undefined) u32(message.blockColor);
    if (message.projectileId !== undefined) u32(message.projectileId);
    if (message.velocity !== undefined) { f64(message.velocity.x); f64(message.velocity.y); f64(message.velocity.z); }
    if (message.tick !== undefined) u32(message.tick);
    if (message.inputSeq !== undefined) f64(integer(message.inputSeq, Number.MAX_SAFE_INTEGER));
    if (message.endPosition !== undefined) { f64(message.endPosition.x); f64(message.endPosition.y); f64(message.endPosition.z); }
    return bytes;
  }
  u32(message.roundId); u32(message.tick);
  u32(message.scores[0]); u32(message.scores[1]);
  f32(message.remaining ?? -1);
  u16(message.players.length); u16(message.projectiles.length);
  for (let i = 0; i < message.players.length; i++) {
    const player = message.players[i];
    const name = names[i];
    varint(player.id);
    u16(player.team | (kits.indexOf(player.kit) << 2) | (weapons.indexOf(player.weapon) << 4)
      | (player.alive ? 128 : 0) | (player.grounded ? 256 : 0) | (player.aiming ? 512 : 0));
    u8(floatMasks[i]);
    for (const [index, value] of playerFloats[i].entries()) if (!(floatMasks[i] & (1 << index))) f32(value);
    u8(player.health); u8(player.ammo); u8(player.grenades);
    varint(player.kills); varint(player.deaths); varint(player.lastSeq);
    u8(name.length); bytes.set(name, offset); offset += name.length;
  }
  for (const projectile of message.projectiles) {
    u32(projectile.id); u32(projectile.owner); u8(weapons.indexOf(projectile.weapon));
    f32(projectile.position.x); f32(projectile.position.y); f32(projectile.position.z);
    f32(projectile.velocity.x); f32(projectile.velocity.y); f32(projectile.velocity.z);
  }
  return bytes;
}

export function decodeServerMessage(data: string | ArrayBuffer | ArrayBufferView): ServerMessage {
  if (typeof data === 'string') {
    const message = JSON.parse(data) as ServerMessage;
    if (!message || !['welcome', 'world', 'snapshot', 'reset', 'error', 'pong', 'event'].includes(message.type)) {
      throw new Error('Unsupported logical message; snapshot deltas require createServerMessageDecoder');
    }
    return message;
  }
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const u8 = () => view.getUint8(offset++);
  const u16 = () => { const n = view.getUint16(offset, true); offset += 2; return n; };
  const u32 = () => { const n = view.getUint32(offset, true); offset += 4; return n; };
  const finite = (n: number) => { if (!Number.isFinite(n)) throw new Error('Invalid wire float'); return n; };
  const f32 = () => { const n = finite(view.getFloat32(offset, true)); offset += 4; return n; };
  const f64 = () => { const n = finite(view.getFloat64(offset, true)); offset += 8; return n; };
  const varint = (max: number) => {
    let result = 0, multiplier = 1;
    for (let index = 0; index < (max <= 0xffffffff ? 5 : 8); index++) {
      const byte = u8(), value = byte % 128;
      if (value > Math.floor((max - result) / multiplier)) throw new Error('Wire integer overflow');
      result += value * multiplier;
      if (byte < 128) {
        if (index && value === 0) throw new Error('Noncanonical wire integer');
        return result;
      }
      multiplier *= 128;
    }
    throw new Error('Wire integer exceeds byte limit');
  };
  if (bytes.length < 6 || u32() !== MAGIC || u8() !== VERSION) throw new Error('Invalid wire header');
  const kind = u8();
  if (kind === 2) {
    if (bytes.length < 17) throw new Error('Invalid world length');
    const roundId = u32(), revision = u32(), flags = u8(), count = u16();
    if (flags & ~15 || ((flags & 2) && !(flags & 1)) || ((flags & 8) && !(flags & 4))) throw new Error('Invalid world flags');
    if (count > WORLD_BATCH_LIMIT || bytes.length !== 17 + count * 10) throw new Error('Invalid world length');
    const edits: VoxelEdit[] = [];
    for (let index = 0; index < count; index++) edits.push([u16(), u16(), u16(), u32()]);
    return { type: 'world', roundId, revision, edits,
      ...(flags & 1 ? { initial: !!(flags & 2) } : {}), ...(flags & 4 ? { complete: !!(flags & 8) } : {}) };
  }
  if (kind === 3) {
    if (bytes.length < 37) throw new Error('Invalid event length');
    const roundId = u32(), event = events[u8()], flags = u16();
    if (!event) throw new Error('Invalid event kind');
    if (flags & ~2047 || ((flags & 16) && !(flags & 8))) throw new Error('Invalid event flags');
    if (bytes.length !== eventLength(flags)) throw new Error('Invalid event length');
    const message: GameEvent = { type: 'event', roundId, event, position: { x: f64(), y: f64(), z: f64() } };
    if (flags & 1) message.shooterId = u32();
    if (flags & 2) message.targetId = u32();
    if (flags & 4) {
      const weapon = weapons[u8()];
      if (!weapon) throw new Error('Invalid event weapon');
      message.weapon = weapon;
    }
    if (flags & 8) message.headshot = !!(flags & 16);
    if (flags & 32) message.blockColor = u32();
    if (flags & 64) message.projectileId = u32();
    if (flags & 128) message.velocity = { x: f64(), y: f64(), z: f64() };
    if (flags & 256) message.tick = u32();
    if (flags & 512) {
      message.inputSeq = f64();
      if (!Number.isSafeInteger(message.inputSeq) || message.inputSeq < 0) throw new Error('Invalid event sequence');
    }
    if (flags & 1024) message.endPosition = { x: f64(), y: f64(), z: f64() };
    return message;
  }
  if (kind === 5) throw new Error('Snapshot delta requires createServerMessageDecoder');
  const headerLength = kind === 4 ? 34 : 30;
  if ((kind !== 1 && kind !== 4) || bytes.length < headerLength) throw new Error('Invalid snapshot header');
  if (kind === 4 && u32() === 0) throw new Error('Invalid snapshot id');
  const roundId = u32(), tick = u32();
  const scores: [number, number] = [u32(), u32()];
  const remaining = f32();
  const playerCount = u16(), projectileCount = u16();
  if (playerCount > 1000 || projectileCount > 32000 || bytes.length < headerLength + playerCount * 11 + projectileCount * 33
    || bytes.length > headerLength + playerCount * 317 + projectileCount * 33) throw new Error('Invalid snapshot length');
  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    const id = varint(0xffffffff), packed = u16(), mask = u8();
    const team = packed & 3, kit = kits[(packed >> 2) & 3], weapon = weapons[(packed >> 4) & 7];
    if (packed & ~1023 || !kit || !weapon || team > 2) throw new Error('Invalid player flags');
    const maskedFloat = (bit: number) => mask & bit ? 0 : f32();
    const position = { x: maskedFloat(1), y: maskedFloat(2), z: maskedFloat(4) };
    const velocity = { x: maskedFloat(8), y: maskedFloat(16), z: maskedFloat(32) };
    const yaw = maskedFloat(64), pitch = maskedFloat(128);
    const health = u8(), ammo = u8(), grenades = u8();
    const kills = varint(0xffffffff), deaths = varint(0xffffffff), lastSeq = varint(Number.MAX_SAFE_INTEGER);
    const nameLength = u8();
    if (offset + nameLength > bytes.length) throw new Error('Invalid player record');
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    players.push({ id, team: team as 0 | 1 | 2, kit, weapon, alive: !!(packed & 128), grounded: !!(packed & 256), aiming: !!(packed & 512), position, velocity, yaw, pitch, health, ammo, grenades, kills, deaths, lastSeq, name });
  }
  const projectiles: ProjectileState[] = [];
  for (let i = 0; i < projectileCount; i++) {
    const id = u32(), owner = u32(), weapon = weapons[u8()];
    if (!weapon) throw new Error('Invalid projectile record');
    projectiles.push({ id, owner, weapon, position: { x: f32(), y: f32(), z: f32() }, velocity: { x: f32(), y: f32(), z: f32() } });
  }
  if (offset !== bytes.length) throw new Error('Unexpected snapshot data');
  return { type: 'snapshot', roundId, tick, scores, remaining: remaining < 0 ? null : remaining, players, projectiles };
}

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type Fields = readonly (number | string)[];
type FieldKind = 'name' | 'byte' | 'uint' | 'seq' | 'float';
const playerKinds: readonly FieldKind[] = ['name', 'byte', 'byte', 'byte', 'byte', 'byte', 'byte', 'byte', 'byte', 'byte',
  'uint', 'uint', 'seq', 'float', 'float', 'float', 'float', 'float', 'float', 'float', 'float'];
const projectileKinds: readonly FieldKind[] = ['uint', 'byte', 'float', 'float', 'float', 'float', 'float', 'float'];

export interface SnapshotFrame {
  readonly id: number;
  readonly roundId: number;
  readonly tick: number;
  readonly scores: readonly [number, number];
  readonly remaining: number;
  readonly players: ReadonlyMap<number, Fields>;
  readonly projectiles: ReadonlyMap<number, Fields>;
  readonly full: Uint8Array;
}

function playerFields(player: PlayerState): (number | string)[] {
  return [player.name, player.team, kits.indexOf(player.kit), weapons.indexOf(player.weapon), +player.alive, +player.grounded,
    +player.aiming, player.health, player.ammo, player.grenades, player.kills, player.deaths, player.lastSeq,
    Math.fround(player.position.x), Math.fround(player.position.y), Math.fround(player.position.z),
    Math.fround(player.velocity.x), Math.fround(player.velocity.y), Math.fround(player.velocity.z),
    Math.fround(player.yaw), Math.fround(player.pitch)];
}

function projectileFields(projectile: ProjectileState): (number | string)[] {
  return [projectile.owner, weapons.indexOf(projectile.weapon),
    Math.fround(projectile.position.x), Math.fround(projectile.position.y), Math.fround(projectile.position.z),
    Math.fround(projectile.velocity.x), Math.fround(projectile.velocity.y), Math.fround(projectile.velocity.z)];
}

// Capture once before sending: authoritative objects keep changing after this call.
export function captureSnapshot(snapshot: Snapshot, id: number): SnapshotFrame {
  integer(id, 0xffffffff);
  if (!id) throw new Error('Invalid snapshot id');
  const encoded = encodeServerMessage(snapshot) as Uint8Array;
  const full = new Uint8Array(encoded.length + 4);
  full.set(encoded.subarray(0, 6)); full[5] = 4;
  new DataView(full.buffer).setUint32(6, id, true);
  full.set(encoded.subarray(6), 10);
  const players = new Map(snapshot.players.map(player => [player.id, playerFields(player)]));
  const projectiles = new Map(snapshot.projectiles.map(projectile => [projectile.id, projectileFields(projectile)]));
  if (players.size !== snapshot.players.length || projectiles.size !== snapshot.projectiles.length) throw new Error('Duplicate snapshot id');
  return { id, roundId: snapshot.roundId, tick: snapshot.tick, scores: [...snapshot.scores],
    remaining: Math.fround(snapshot.remaining ?? -1), players, projectiles, full };
}

function preservesOrder(current: ReadonlyMap<number, Fields>, previous: ReadonlyMap<number, Fields>): boolean {
  const order = current.keys();
  for (const id of previous.keys()) if (current.has(id) && order.next().value !== id) return false;
  for (const id of current.keys()) if (!previous.has(id) && order.next().value !== id) return false;
  return true;
}

export function encodeSnapshot(current: SnapshotFrame, previous?: SnapshotFrame | null): Uint8Array {
  if (!previous || current.roundId !== previous.roundId
    || !preservesOrder(current.players, previous.players) || !preservesOrder(current.projectiles, previous.projectiles)) return current.full;
  if (current.id === previous.id) throw new Error('Snapshot id must advance');
  const flags = (current.scores[0] !== previous.scores[0] ? 1 : 0) | (current.scores[1] !== previous.scores[1] ? 2 : 0)
    | (!Object.is(current.remaining, previous.remaining) ? 4 : 0);
  let length = 31 + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 4 : 0);
  const groups = [];
  for (const [values, old, kinds] of [[current.players, previous.players, playerKinds],
    [current.projectiles, previous.projectiles, projectileKinds]] as const) {
    const removed: number[] = [];
    const changed: { id: number; mask: number; fields: Fields }[] = [];
    for (const id of old.keys()) if (!values.has(id)) { removed.push(id); length += varintLength(id, 0xffffffff); }
    for (const [id, fields] of values) {
      const before = old.get(id);
      let mask = 0;
      for (let index = 0; index < fields.length; index++) if (!before || !Object.is(fields[index], before[index])) mask |= 1 << index;
      if (!mask) continue;
      changed.push({ id, mask, fields });
      length += varintLength(id, 0xffffffff) + varintLength(mask, 0xffffffff);
      for (let index = 0; index < kinds.length; index++) {
        if (!(mask & (1 << index))) continue;
        const value = fields[index], kind = kinds[index];
        length += kind === 'name' ? 1 + encoder.encode(value as string).length : kind === 'byte' ? 1 : kind === 'float' ? 4
          : varintLength(value as number, kind === 'seq' ? Number.MAX_SAFE_INTEGER : 0xffffffff);
      }
      if (length >= current.full.length) return current.full;
    }
    groups.push({ removed, changed, kinds });
  }
  if (length >= current.full.length) return current.full;
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  let offset = 0;
  const u8 = (value: number) => { view.setUint8(offset++, value); };
  const u16 = (value: number) => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const f32 = (value: number) => { view.setFloat32(offset, value, true); offset += 4; };
  const varint = (value: number) => {
    do { const byte = value % 128; value = Math.floor(value / 128); u8(byte + (value ? 128 : 0)); } while (value);
  };
  u32(MAGIC); u8(VERSION); u8(5);
  u32(current.roundId); u32(current.tick); u32(current.id); u32(previous.id); u8(flags);
  if (flags & 1) u32(current.scores[0]);
  if (flags & 2) u32(current.scores[1]);
  if (flags & 4) f32(current.remaining);
  for (const { removed, changed, kinds } of groups) {
    u16(removed.length); for (const id of removed) varint(id);
    u16(changed.length);
    for (const { id, mask, fields } of changed) {
      varint(id); varint(mask);
      for (let index = 0; index < kinds.length; index++) {
        if (!(mask & (1 << index))) continue;
        const value = fields[index], kind = kinds[index];
        if (kind === 'name') {
          const name = encoder.encode(value as string);
          u8(name.length); bytes.set(name, offset); offset += name.length;
        } else if (kind === 'byte') u8(value as number);
        else if (kind === 'float') f32(value as number);
        else varint(value as number);
      }
    }
  }
  return bytes;
}

function playerFromFields(id: number, fields: Fields): PlayerState {
  const [name, team, kit, weapon, alive, grounded, aiming, health, ammo, grenades, kills, deaths, lastSeq,
    x, y, z, vx, vy, vz, yaw, pitch] = fields as readonly [string, ...number[]];
  if (team > 2 || !kits[kit] || !weapons[weapon] || alive > 1 || grounded > 1 || aiming > 1) throw new Error('Invalid player flags');
  return { id, name, team: team as 0 | 1 | 2, kit: kits[kit], weapon: weapons[weapon], alive: !!alive, grounded: !!grounded,
    aiming: !!aiming, health, ammo, grenades, kills, deaths, lastSeq, position: { x, y, z }, velocity: { x: vx, y: vy, z: vz }, yaw, pitch };
}

function projectileFromFields(id: number, fields: Fields): ProjectileState {
  const [owner, weapon, x, y, z, vx, vy, vz] = fields as readonly number[];
  if (!weapons[weapon]) throw new Error('Invalid projectile record');
  return { id, owner, weapon: weapons[weapon], position: { x, y, z }, velocity: { x: vx, y: vy, z: vz } };
}

export function createServerMessageDecoder(): (data: string | ArrayBuffer | ArrayBufferView) => ServerMessage {
  let baseline: Snapshot | null = null;
  let baselineId = 0;
  return data => {
    const bytes = typeof data === 'string' ? null : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (!bytes || bytes.length < 6 || bytes[5] !== 5) {
      const message = decodeServerMessage(data);
      if (message.type === 'welcome' || message.type === 'reset' || message.type === 'snapshot') {
        baseline = null; baselineId = 0;
      }
      if (message.type === 'snapshot' && bytes?.[5] === 4) {
        if (new Set(message.players.map(player => player.id)).size !== message.players.length
          || new Set(message.projectiles.map(projectile => projectile.id)).size !== message.projectiles.length) throw new Error('Duplicate snapshot id');
        baseline = message;
        baselineId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(6, true);
      }
      return message;
    }
    serverMessageType(bytes);
    if (bytes.length < 31 || bytes.length > 34 + 1000 * 317 + 32000 * 33) throw new Error('Invalid snapshot delta length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 6;
    const u8 = () => view.getUint8(offset++);
    const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
    const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
    const f32 = () => {
      const value = view.getFloat32(offset, true); offset += 4;
      if (!Number.isFinite(value)) throw new Error('Invalid wire float');
      return value;
    };
    const varint = (max: number) => {
      let result = 0, multiplier = 1;
      for (let index = 0; index < (max <= 0xffffffff ? 5 : 8); index++) {
        const byte = u8(), value = byte % 128;
        if (value > Math.floor((max - result) / multiplier)) throw new Error('Wire integer overflow');
        result += value * multiplier;
        if (byte < 128) {
          if (index && !value) throw new Error('Noncanonical wire integer');
          return result;
        }
        multiplier *= 128;
      }
      throw new Error('Wire integer exceeds byte limit');
    };
    const roundId = u32(), tick = u32(), id = u32(), previousId = u32(), flags = u8();
    if (!baseline || previousId !== baselineId || roundId !== baseline.roundId) throw new Error('Snapshot delta baseline mismatch');
    if (!id || id === previousId || flags & ~7) throw new Error('Invalid snapshot delta flags');
    const scores: [number, number] = [flags & 1 ? u32() : baseline.scores[0], flags & 2 ? u32() : baseline.scores[1]];
    const remaining = flags & 4 ? f32() : baseline.remaining ?? -1;
    const readChanges = <T extends { id: number }>(old: T[], kinds: readonly FieldKind[], limit: number,
      fieldsOf: (value: T) => (number | string)[], fromFields: (id: number, fields: Fields) => T): T[] => {
      const values = new Map(old.map(value => [value.id, value]));
      const removed = u16();
      if (removed > limit) throw new Error('Invalid snapshot removal count');
      const touched = new Set<number>();
      for (let index = 0; index < removed; index++) {
        const id = varint(0xffffffff);
        if (!values.delete(id)) throw new Error('Unknown snapshot removal');
        touched.add(id);
      }
      const changed = u16(), fullMask = (1 << kinds.length) - 1;
      if (changed > limit) throw new Error('Invalid snapshot change count');
      for (let index = 0; index < changed; index++) {
        const id = varint(0xffffffff), mask = varint(fullMask), previous = values.get(id);
        if (!mask || touched.has(id) || (!previous && mask !== fullMask)) throw new Error('Invalid snapshot change');
        touched.add(id);
        const fields = previous ? fieldsOf(previous) : [];
        for (let field = 0; field < kinds.length; field++) {
          if (!(mask & (1 << field))) continue;
          const kind = kinds[field];
          if (kind === 'name') {
            const length = u8();
            if (offset + length > bytes.length) throw new Error('Invalid player record');
            fields[field] = decoder.decode(bytes.subarray(offset, offset + length)); offset += length;
          } else fields[field] = kind === 'byte' ? u8() : kind === 'float' ? f32()
            : varint(kind === 'seq' ? Number.MAX_SAFE_INTEGER : 0xffffffff);
        }
        values.set(id, fromFields(id, fields));
      }
      if (values.size > limit) throw new Error('Snapshot exceeds wire limit');
      return [...values.values()];
    };
    const players = readChanges(baseline.players, playerKinds, 1000, playerFields, playerFromFields);
    const projectiles = readChanges(baseline.projectiles, projectileKinds, 32000, projectileFields, projectileFromFields);
    if (offset !== bytes.length) throw new Error('Unexpected snapshot delta data');
    const message: Snapshot = { type: 'snapshot', roundId, tick, scores, remaining: remaining < 0 ? null : remaining, players, projectiles };
    baseline = message; baselineId = id;
    return message;
  };
}
