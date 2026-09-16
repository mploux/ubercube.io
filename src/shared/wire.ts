import type { DeathPlayerState, GameEvent, Kit, PlayerState, RemotePlayerState, RemoteProjectileState, ServerMessage, Vec3, VoxelEdit, WeaponId } from './protocol';

const MAGIC = 0x55424331;
const VERSION = 5;
const WORLD_BATCH_LIMIT = 512;
const kits: Kit[] = ['assault', 'sniper', 'medic'];
const weapons: WeaponId[] = ['ak47', 'awp', 'shovel', 'grenade', 'medic'];
const events: GameEvent['event'][] = ['shot', 'impact', 'explosion', 'heal', 'build', 'projectile-end'];
const binaryTypes = [undefined, 'world', 'event', 'snapshot', 'snapshot'] as const;
const encoder = new TextEncoder();

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
    const match = /^\{"type":"(welcome|world|roster|snapshot|reset|error|pong|event)"[,}]/.exec(data.slice(0, 32));
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
  if (message.type === 'snapshot') throw new Error('Snapshots require captureSnapshot and encodeRecipientSnapshot');
  if (message.type !== 'world'
    && (message.type !== 'event' || message.event === 'death' || message.death !== undefined)) {
    if (!['welcome', 'roster', 'reset', 'error', 'pong', 'event'].includes(message.type)) throw new Error('Unsupported logical message; snapshot deltas require encodeSnapshot');
    if (message.type === 'roster') return JSON.stringify(validateRoster(message));
    if (message.type === 'event' && message.death) return JSON.stringify({ ...message, death: { ...message.death, player: publicDeath(message.death.player) } });
    return JSON.stringify(message);
  }
  let length: number;
  let flags = 0;
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
  } else throw new Error('Unsupported binary message');
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u8 = (n: number) => { view.setUint8(offset, integer(n, 255)); offset++; };
  const u16 = (n: number) => { view.setUint16(offset, integer(n, 65535), true); offset += 2; };
  const u32 = (n: number) => { view.setUint32(offset, integer(n, 0xffffffff), true); offset += 4; };
  const f64 = (n: number) => {
    if (!Number.isFinite(n)) throw new Error('Invalid wire float');
    view.setFloat64(offset, n, true); offset += 8;
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
  throw new Error('Unsupported binary message');
}

export function decodeServerMessage(data: string | ArrayBuffer | ArrayBufferView): ServerMessage {
  if (typeof data === 'string') {
    const message = JSON.parse(data) as ServerMessage;
    if (!message || !['welcome', 'world', 'roster', 'reset', 'error', 'pong', 'event'].includes(message.type)) {
      throw new Error('Unsupported logical message; snapshot deltas require createServerMessageDecoder');
    }
    if (message.type === 'roster') return validateRoster(message);
    if (message.type === 'event' && message.death) return { ...message, death: { ...message.death, player: publicDeath(message.death.player) } };
    return message;
  }
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const u8 = () => view.getUint8(offset++);
  const u16 = () => { const n = view.getUint16(offset, true); offset += 2; return n; };
  const u32 = () => { const n = view.getUint32(offset, true); offset += 4; return n; };
  const finite = (n: number) => { if (!Number.isFinite(n)) throw new Error('Invalid wire float'); return n; };
  const f64 = () => { const n = finite(view.getFloat64(offset, true)); offset += 8; return n; };
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
  if (kind === 4 || kind === 5) throw new Error('Snapshots require createServerMessageDecoder');
  throw new Error('Invalid wire message type');
}

type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;
type Roster = Extract<ServerMessage, { type: 'roster' }>;
type Fields = readonly number[];
type FieldKind = 'byte' | 'bool' | 'uint' | 'seq' | 'float';
const playerKinds: readonly FieldKind[] = ['byte', 'bool', 'bool', 'bool', 'uint', 'uint',
  'float', 'float', 'float', 'float', 'float', 'float', 'float', 'uint', 'byte'];
const projectileKinds: readonly FieldKind[] = ['uint', 'byte', 'float', 'float', 'float'];
const ownerKinds: readonly FieldKind[] = ['byte', 'byte', 'byte', 'byte', 'bool', 'seq', 'float'];
const velocityKinds: readonly FieldKind[] = ['float', 'float', 'float'];
const EMPTY_FIELDS: ReadonlyMap<number, Fields> = new Map();
const EMPTY_PLAYER_FIELDS: Fields = [];
// Weak keys let shared encodings expire with their samples instead of retaining old baselines.
const projectileChanges = new WeakMap<ReadonlyMap<number, Fields>, WeakMap<ReadonlyMap<number, Fields>, Uint8Array>>();
const cadenceVariants = new WeakMap<Fields, Map<number, Fields>>();
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function positiveId(value: number): number {
  integer(value, 0xffffffff);
  if (!value) throw new Error('Invalid player id');
  return value;
}

function vector(value: Vec3): Vec3 {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) throw new Error('Invalid wire vector');
  return { x: value.x, y: value.y, z: value.z };
}

function publicDeath(player: DeathPlayerState): DeathPlayerState {
  if (!player || !weapons.includes(player.weapon) || typeof player.alive !== 'boolean' || typeof player.aiming !== 'boolean'
    || !Number.isFinite(player.yaw) || !Number.isFinite(player.pitch)) throw new Error('Invalid death player');
  return { id: positiveId(player.id), weapon: player.weapon, alive: player.alive, aiming: player.aiming,
    deaths: integer(player.deaths, 0xffffffff), position: vector(player.position), velocity: vector(player.velocity),
    yaw: player.yaw, pitch: player.pitch };
}

function validateRoster(message: Roster): Roster {
  if (!Array.isArray(message.upserts) || !Array.isArray(message.removed)
    || message.upserts.length > 1000 || message.removed.length > 1000) throw new Error('Invalid roster length');
  const touched = new Set<number>();
  const removed = message.removed.map(id => {
    positiveId(id);
    if (touched.has(id)) throw new Error('Duplicate roster id');
    touched.add(id); return id;
  });
  const upserts = message.upserts.map(player => {
    if (!player || typeof player.name !== 'string' || encoder.encode(player.name).length > 255) throw new Error('Invalid roster name');
    positiveId(player.id); integer(player.team, 2);
    if (touched.has(player.id)) throw new Error('Duplicate roster id');
    touched.add(player.id);
    return { id: player.id, name: player.name, team: player.team };
  });
  return { type: 'roster', upserts, removed };
}

class SnapshotWriter {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset = 0;
  constructor(length: number) { this.bytes = new Uint8Array(length); this.view = new DataView(this.bytes.buffer); }
  u8(value: number) { this.view.setUint8(this.offset++, integer(value, 255)); }
  u16(value: number) { this.view.setUint16(this.offset, integer(value, 65535), true); this.offset += 2; }
  u32(value: number) { this.view.setUint32(this.offset, integer(value, 0xffffffff), true); this.offset += 4; }
  f32(value: number) {
    if (!Number.isFinite(Math.fround(value))) throw new Error('Invalid wire float');
    this.view.setFloat32(this.offset, value, true); this.offset += 4;
  }
  varint(value: number) {
    integer(value, Number.MAX_SAFE_INTEGER);
    do { const byte = value % 128; value = Math.floor(value / 128); this.u8(byte + (value ? 128 : 0)); } while (value);
  }
}

class SnapshotReader {
  readonly view: DataView;
  offset = 0;
  constructor(bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  u8() { return this.view.getUint8(this.offset++); }
  u16() { const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  u32() { const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  f32() {
    const value = this.view.getFloat32(this.offset, true); this.offset += 4;
    if (!Number.isFinite(value)) throw new Error('Invalid wire float');
    return value;
  }
  varint(max: number) {
    let result = 0, multiplier = 1;
    for (let index = 0; index < (max <= 0xffffffff ? 5 : 8); index++) {
      const byte = this.u8(), value = byte % 128;
      if (value > Math.floor((max - result) / multiplier)) throw new Error('Wire integer overflow');
      result += value * multiplier;
      if (byte < 128) {
        if (index && !value) throw new Error('Noncanonical wire integer');
        return result;
      }
      multiplier *= 128;
    }
    throw new Error('Wire integer exceeds byte limit');
  }
  finish() { if (this.offset !== this.view.byteLength) throw new Error('Unexpected snapshot data'); }
}

function fieldLength(value: number, kind: FieldKind): number {
  if (kind === 'float') {
    if (!Number.isFinite(Math.fround(value))) throw new Error('Invalid wire float');
    return 4;
  }
  const max = kind === 'bool' ? 1 : kind === 'byte' ? 255 : kind === 'seq' ? Number.MAX_SAFE_INTEGER : 0xffffffff;
  integer(value, max);
  return kind === 'bool' || kind === 'byte' ? 1 : varintLength(value, max);
}

function changedFields(current: Fields, previous?: Fields): number {
  if (current === previous) return 0;
  let mask = 0;
  for (let index = 0; index < current.length; index++) if (!previous || !Object.is(current[index], previous[index])) mask |= 1 << index;
  return mask;
}

function fieldsLength(fields: Fields, kinds: readonly FieldKind[], mask: number): number {
  let length = 0;
  for (let index = 0; index < kinds.length; index++) if (mask & (1 << index)) length += fieldLength(fields[index], kinds[index]);
  return length;
}

function writeFields(writer: SnapshotWriter, fields: Fields, kinds: readonly FieldKind[], mask: number): void {
  for (let index = 0; index < kinds.length; index++) {
    if (!(mask & (1 << index))) continue;
    const value = fields[index], kind = kinds[index];
    if (kind === 'float') writer.f32(value);
    else if (kind === 'byte' || kind === 'bool') writer.u8(value);
    else writer.varint(value);
  }
}

function readFields(reader: SnapshotReader, kinds: readonly FieldKind[], mask: number, previous?: Fields): Fields {
  const fields = previous ? [...previous] : [];
  for (let index = 0; index < kinds.length; index++) {
    if (!(mask & (1 << index))) continue;
    const kind = kinds[index];
    fields[index] = kind === 'float' ? reader.f32() : kind === 'byte' || kind === 'bool' ? reader.u8()
      : reader.varint(kind === 'seq' ? Number.MAX_SAFE_INTEGER : 0xffffffff);
    if (kind === 'bool' && fields[index] > 1) throw new Error('Invalid wire boolean');
  }
  return fields;
}

function encodedPlayerChange(columns: PlayerColumns, index: number, current: Fields, previous: Fields = EMPTY_PLAYER_FIELDS) {
  const versions = columns.playerCache[index] ??= [];
  for (let index = 0; index < versions.length; index++) {
    const result = versions[index];
    if (result.fields === current && result.previous === previous) return result;
  }
  const mask = changedFields(current, previous);
  const id = columns.ids[index];
  const writer = new SnapshotWriter(mask ? varintLength(id, 0xffffffff) + varintLength(mask, 0xffffffff) + fieldsLength(current, playerKinds, mask) : 0);
  if (mask) { writer.varint(id); writer.varint(mask); writeFields(writer, current, playerKinds, mask); }
  const result = { fields: current, previous, mask, bytes: writer.bytes };
  // Keep memoization bounded even if a caller reuses one capture against many different histories.
  if (versions.length < 100) versions.push(result);
  return result;
}

function changes(current: ReadonlyMap<number, Fields>, previous: ReadonlyMap<number, Fields>, kinds: readonly FieldKind[]) {
  const removed: number[] = [], changed: { id: number; mask: number; fields: Fields }[] = [];
  let length = 4;
  for (const id of previous.keys()) if (!current.has(id)) { removed.push(id); length += varintLength(id, 0xffffffff); }
  for (const [id, fields] of current) {
    const before = previous.get(id);
    if (fields === before) continue;
    const mask = changedFields(fields, before);
    if (!mask) continue;
    changed.push({ id, mask, fields });
    length += varintLength(id, 0xffffffff) + varintLength(mask, 0xffffffff) + fieldsLength(fields, kinds, mask);
  }
  return { removed, changed, kinds, length };
}

function writeChanges(writer: SnapshotWriter, group: ReturnType<typeof changes>): void {
  writer.u16(group.removed.length); for (const id of group.removed) writer.varint(id);
  writer.u16(group.changed.length);
  for (const { id, mask, fields } of group.changed) {
    writer.varint(id); writer.varint(mask); writeFields(writer, fields, group.kinds, mask);
  }
}

function encodedProjectileChanges(current: ReadonlyMap<number, Fields>, previous: ReadonlyMap<number, Fields>) {
  let versions = projectileChanges.get(current);
  if (!versions) { versions = new WeakMap(); projectileChanges.set(current, versions); }
  let bytes = versions.get(previous);
  if (!bytes) {
    const group = changes(current, previous, projectileKinds), writer = new SnapshotWriter(group.length);
    writeChanges(writer, group); bytes = writer.bytes; versions.set(previous, bytes);
  }
  return bytes;
}

function readChanges(reader: SnapshotReader, previous: ReadonlyMap<number, Fields>, kinds: readonly FieldKind[], limit: number): ReadonlyMap<number, Fields> {
  const values = new Map(previous), touched = new Set<number>();
  const removed = reader.u16();
  if (removed > limit) throw new Error('Invalid snapshot removal count');
  for (let index = 0; index < removed; index++) {
    const id = reader.varint(0xffffffff);
    if (!values.delete(id)) throw new Error('Unknown snapshot removal');
    touched.add(id);
  }
  const changed = reader.u16(), fullMask = (1 << kinds.length) - 1;
  if (changed > limit) throw new Error('Invalid snapshot change count');
  for (let index = 0; index < changed; index++) {
    const id = reader.varint(0xffffffff), mask = reader.varint(fullMask), before = values.get(id);
    if (!mask || touched.has(id) || (!before && mask !== fullMask)) throw new Error('Invalid snapshot change');
    touched.add(id); values.set(id, readFields(reader, kinds, mask, before));
  }
  if (values.size > limit) throw new Error('Snapshot exceeds wire limit');
  return values;
}

export interface SnapshotFrame {
  readonly id: number;
  readonly roundId: number;
  readonly tick: number;
  readonly scores: readonly [number, number];
  readonly roundEndTick: number | null;
  readonly players: ReadonlyMap<number, Fields>;
  readonly projectiles: ReadonlyMap<number, Fields>;
  readonly fullLength: number;
  readonly full: Uint8Array;
}

interface CachedPlayerChange { fields: Fields; previous: Fields; mask: number; bytes: Uint8Array }
interface PlayerColumns {
  readonly ids: readonly number[];
  readonly index: ReadonlyMap<number, number>;
  readonly fields: readonly Fields[];
  readonly playerCache: CachedPlayerChange[][];
}
const snapshotPlayers = new WeakMap<SnapshotFrame, PlayerColumns>();

function playerColumns(frame: SnapshotFrame): PlayerColumns {
  let columns = snapshotPlayers.get(frame);
  if (!columns) {
    const ids: number[] = [], fields: Fields[] = [], index = new Map<number, number>();
    for (const [id, values] of frame.players) { index.set(id, ids.length); ids.push(id); fields.push(values); }
    columns = { ids, fields, index, playerCache: [] }; snapshotPlayers.set(frame, columns);
  }
  return columns;
}

function changesInPlayers(current: PlayerColumns, previous?: PlayerColumns) {
  const removed: number[] = [], bytes: Uint8Array[] = [];
  let length = 4;
  if (previous) for (let index = 0; index < previous.ids.length; index++) {
    const id = previous.ids[index];
    if (current.ids[index] !== id && !current.index.has(id)) { removed.push(id); length += varintLength(id, 0xffffffff); }
  }
  for (let index = 0; index < current.ids.length; index++) {
    const id = current.ids[index], fields = current.fields[index];
    const before = previous?.fields[previous.ids[index] === id ? index : previous.index.get(id) ?? -1];
    if (fields === before) continue;
    const encoded = encodedPlayerChange(current, index, fields, before);
    if (!encoded.mask) continue;
    bytes.push(encoded.bytes); length += encoded.bytes.length;
  }
  return { removed, bytes, length };
}

function preservesPlayerOrder(current: PlayerColumns, previous: PlayerColumns): boolean {
  let identical = current.ids.length === previous.ids.length;
  if (identical) for (let index = 0; index < current.ids.length; index++) {
    if (current.ids[index] !== previous.ids[index]) { identical = false; break; }
  }
  if (identical) return true;
  let next = 0;
  for (const id of previous.ids) if (current.index.has(id) && current.ids[next++] !== id) return false;
  for (const id of current.ids) if (!previous.index.has(id) && current.ids[next++] !== id) return false;
  return true;
}

export interface OwnerState {
  readonly snapshotId: number;
  readonly roundId: number;
  readonly ownerId: number;
  readonly fields: Fields | null;
  readonly projectileVelocities: ReadonlyMap<number, Fields>;
}

// Private fields never enter the shared frame, even if callers pass wider objects.
export function captureSnapshot(snapshot: Pick<Snapshot, 'roundId' | 'tick' | 'players' | 'projectiles' | 'scores' | 'roundEndTick'>, id: number): SnapshotFrame {
  positiveId(id); integer(snapshot.roundId, 0xffffffff); integer(snapshot.tick, 0xffffffff);
  integer(snapshot.scores[0], 0xffffffff); integer(snapshot.scores[1], 0xffffffff);
  if (snapshot.roundEndTick !== null) integer(snapshot.roundEndTick, 0xffffffff);
  if (snapshot.players.length > 1000 || snapshot.projectiles.length > 32000) throw new Error('Snapshot exceeds wire limit');
  // Header, both groups' removal/change counts, scores and round end.
  let fullLength = 27 + 2 * (2 + 2) + 2 * 4 + (snapshot.roundEndTick === null ? 1 : 5);
  const ids: number[] = [], playerFields: Fields[] = [], index = new Map<number, number>(), projectiles = new Map<number, Fields>();
  for (const player of snapshot.players) {
    positiveId(player.id);
    if (index.has(player.id) || !weapons.includes(player.weapon)
      || [player.alive, player.aiming, player.hasGrenades].some(value => typeof value !== 'boolean')) throw new Error('Invalid public player');
    if (player.sampleTick > snapshot.tick || ![3, 6, 12].includes(player.sampleInterval)) throw new Error('Invalid player sample');
    const fields = [weapons.indexOf(player.weapon), +player.alive, +player.aiming, +player.hasGrenades, player.kills, player.deaths,
      Math.fround(player.position.x), Math.fround(player.position.y), Math.fround(player.position.z),
      Math.fround(player.velocity.x), Math.fround(player.velocity.z), Math.fround(player.yaw), Math.fround(player.pitch),
      player.sampleTick, player.sampleInterval];
    fullLength += varintLength(player.id, 0xffffffff) + varintLength(32767, 0xffffffff) + fieldsLength(fields, playerKinds, 32767);
    index.set(player.id, ids.length); ids.push(player.id); playerFields.push(fields);
  }
  for (const projectile of snapshot.projectiles) {
    integer(projectile.id, 0xffffffff); positiveId(projectile.owner);
    if (projectiles.has(projectile.id) || !weapons.includes(projectile.weapon)) throw new Error('Invalid public projectile');
    const fields = [projectile.owner, weapons.indexOf(projectile.weapon), Math.fround(projectile.position.x),
      Math.fround(projectile.position.y), Math.fround(projectile.position.z)];
    fullLength += varintLength(projectile.id, 0xffffffff) + varintLength(31, 0xffffffff) + fieldsLength(fields, projectileKinds, 31);
    projectiles.set(projectile.id, fields);
  }
  const columns: PlayerColumns = { ids, fields: playerFields, index, playerCache: [] };
  let full: Uint8Array | undefined, players: ReadonlyMap<number, Fields> | undefined;
  const frame: SnapshotFrame = { id, roundId: snapshot.roundId, tick: snapshot.tick, scores: [...snapshot.scores] as [number, number],
    roundEndTick: snapshot.roundEndTick, projectiles, fullLength,
    get players() { return players ??= new Map<number, Fields>(ids.map((id, index) => [id, playerFields[index]])); },
    get full() { return full ??= encodePublicSnapshot(frame); } };
  snapshotPlayers.set(frame, columns);
  return frame;
}

export function selectSnapshotPlayers(current: SnapshotFrame, previous: SnapshotFrame | null,
  cadenceFor: (id: number, index: number) => RemotePlayerState['sampleInterval'] | undefined): SnapshotFrame {
  const source = playerColumns(current), before = previous?.roundId === current.roundId ? playerColumns(previous) : undefined;
  let selectedFields: Fields[] | undefined, fullLength = current.fullLength;
  for (let index = 0; index < source.ids.length; index++) {
    const id = source.ids[index], fields = source.fields[index];
    const old = before?.fields[before.ids[index] === id ? index : before.index.get(id) ?? -1], interval = cadenceFor(id, index);
    if (interval !== undefined && interval !== 3 && interval !== 6 && interval !== 12) throw new Error('Invalid player sample interval');
    let selected = fields;
    if (old && interval === undefined && fields[0] === old[0] && fields[1] === old[1] && fields[2] === old[2]
      && fields[3] === old[3] && fields[4] === old[4] && fields[5] === old[5]) selected = old;
    else {
      const cadence = interval ?? old?.[14] ?? fields[14];
      if (cadence !== fields[14]) {
        let variants = cadenceVariants.get(fields);
        if (!variants) { variants = new Map([[fields[14], fields]]); cadenceVariants.set(fields, variants); }
        let variant = variants.get(cadence);
        if (!variant) {
          variant = [...fields.slice(0, 14), cadence]; variants.set(cadence, variant);
          cadenceVariants.set(variant, variants);
        }
        selected = variant;
      }
    }
    if (selected !== fields) {
      selectedFields ??= source.fields.slice();
      selectedFields[index] = selected;
    }
    // Selection only changes fixed-size motion/cadence fields and the variable-size sample tick.
    if (selected[13] !== fields[13]) fullLength += varintLength(selected[13], 0xffffffff) - varintLength(fields[13], 0xffffffff);
  }
  if (!selectedFields) return current;
  const columns: PlayerColumns = { ids: source.ids, index: source.index, fields: selectedFields, playerCache: source.playerCache };
  let full: Uint8Array | undefined, players: ReadonlyMap<number, Fields> | undefined;
  const frame: SnapshotFrame = { id: current.id, roundId: current.roundId, tick: current.tick, scores: current.scores,
    roundEndTick: current.roundEndTick, projectiles: current.projectiles, fullLength,
    get players() { return players ??= new Map<number, Fields>(columns.ids.map((id, index) => [id, columns.fields[index]])); },
    get full() { return full ??= encodePublicSnapshot(frame); } };
  snapshotPlayers.set(frame, columns);
  return frame;
}

function preservesOrder(current: ReadonlyMap<number, Fields>, previous: ReadonlyMap<number, Fields>): boolean {
  const order = current.keys();
  for (const id of previous.keys()) if (current.has(id) && order.next().value !== id) return false;
  for (const id of current.keys()) if (!previous.has(id) && order.next().value !== id) return false;
  return true;
}

function encodePublicSnapshot(current: SnapshotFrame, previous?: SnapshotFrame, owner?: OwnerState, previousOwner?: OwnerState | null): Uint8Array {
  const players = changesInPlayers(playerColumns(current), previous ? playerColumns(previous) : undefined);
  const projectiles = encodedProjectileChanges(current.projectiles, previous?.projectiles ?? EMPTY_FIELDS);
  const flags = (current.scores[0] !== previous?.scores[0] ? 1 : 0) | (current.scores[1] !== previous?.scores[1] ? 2 : 0)
    | (current.roundEndTick !== previous?.roundEndTick ? 4 : 0);
  const length = 27 + players.length + projectiles.length + (flags & 1 ? 4 : 0) + (flags & 2 ? 4 : 0)
    + (flags & 4 ? current.roundEndTick === null ? 1 : 5 : 0);
  if (previous && length >= current.fullLength) return owner ? encodePublicSnapshot(current, undefined, owner) : current.full;
  if (owner && previous && (!previousOwner || previousOwner.snapshotId !== previous.id || previousOwner.roundId !== current.roundId)) {
    throw new Error('Private snapshot baseline mismatch');
  }
  const privatePlan = owner ? planOwner(owner, previous ? previousOwner : null, length) : undefined;
  const writer = new SnapshotWriter(privatePlan?.length ?? length);
  writer.u32(MAGIC); writer.u8(VERSION); writer.u8(previous ? 5 : 4); writer.u32(length);
  writer.u32(current.roundId); writer.u32(current.tick); writer.u32(current.id); writer.u32(previous?.id ?? 0); writer.u8(flags);
  if (flags & 1) writer.u32(current.scores[0]);
  if (flags & 2) writer.u32(current.scores[1]);
  if (flags & 4) { writer.u8(current.roundEndTick === null ? 0 : 1); if (current.roundEndTick !== null) writer.u32(current.roundEndTick); }
  writer.u16(players.removed.length); for (const id of players.removed) writer.varint(id);
  writer.u16(players.bytes.length);
  for (const bytes of players.bytes) { writer.bytes.set(bytes, writer.offset); writer.offset += bytes.length; }
  writer.bytes.set(projectiles, writer.offset); writer.offset += projectiles.length;
  if (owner && privatePlan) writeOwner(writer, owner, privatePlan);
  return writer.bytes;
}

function snapshotBaseline(current: SnapshotFrame, previous?: SnapshotFrame | null): SnapshotFrame | undefined {
  if (!previous || current.roundId !== previous.roundId || !preservesPlayerOrder(playerColumns(current), playerColumns(previous))
    || !preservesOrder(current.projectiles, previous.projectiles)) return undefined;
  if (current.id === previous.id) throw new Error('Snapshot id must advance');
  return previous;
}

export function encodeSnapshot(current: SnapshotFrame, previous?: SnapshotFrame | null): Uint8Array {
  const baseline = snapshotBaseline(current, previous);
  return baseline ? encodePublicSnapshot(current, baseline) : current.full;
}

export function captureOwnerState(owner: PlayerState | null, velocities: Snapshot['projectileVelocities'], frame: SnapshotFrame): OwnerState {
  if (velocities.length > 32000) throw new Error('Snapshot exceeds wire limit');
  const ownerId = owner ? positiveId(owner.id) : 0;
  if (owner && (!playerColumns(frame).index.has(ownerId) || !kits.includes(owner.kit) || typeof owner.grounded !== 'boolean')) throw new Error('Invalid snapshot owner');
  const fields = owner ? [kits.indexOf(owner.kit), owner.health, owner.ammo, owner.grenades, +owner.grounded,
    owner.lastSeq, Math.fround(owner.velocity.y)] : null;
  if (fields) fieldsLength(fields, ownerKinds, 127);
  const projectileVelocities = new Map<number, Fields>();
  for (const projectile of velocities) {
    if (!ownerId || frame.projectiles.get(projectile.id)?.[0] !== ownerId || projectileVelocities.has(projectile.id)) throw new Error('Invalid private projectile');
    const velocity = [Math.fround(projectile.velocity.x), Math.fround(projectile.velocity.y), Math.fround(projectile.velocity.z)];
    fieldsLength(velocity, velocityKinds, 7); projectileVelocities.set(projectile.id, velocity);
  }
  return { snapshotId: frame.id, roundId: frame.roundId, ownerId, fields, projectileVelocities };
}

function planOwner(current: OwnerState, previous: OwnerState | null | undefined, prefixLength: number) {
  const mask = current.fields ? changedFields(current.fields, previous?.ownerId === current.ownerId ? previous.fields ?? undefined : undefined) : 0;
  const group = changes(current.projectileVelocities, previous?.projectileVelocities ?? EMPTY_FIELDS, velocityKinds);
  const length = prefixLength + varintLength(current.ownerId, 0xffffffff) + (current.fields ? 1 + fieldsLength(current.fields, ownerKinds, mask) : 0) + group.length;
  if (length > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds wire limit');
  return { mask, group, length };
}

function writeOwner(writer: SnapshotWriter, current: OwnerState, plan: ReturnType<typeof planOwner>): void {
  writer.varint(current.ownerId);
  if (current.fields) { writer.u8(plan.mask); writeFields(writer, current.fields, ownerKinds, plan.mask); }
  writeChanges(writer, plan.group);
}

export function encodeCombinedSnapshot(current: SnapshotFrame, owner: OwnerState,
  previous?: SnapshotFrame | null, previousOwner?: OwnerState | null): Uint8Array {
  if (owner.snapshotId !== current.id || owner.roundId !== current.roundId) throw new Error('Invalid common snapshot');
  return encodePublicSnapshot(current, snapshotBaseline(current, previous), owner, previousOwner);
}

export function encodeRecipientSnapshot(common: Uint8Array, current: OwnerState, previous?: OwnerState | null): Uint8Array {
  const view = new DataView(common.buffer, common.byteOffset, common.byteLength);
  if (serverMessageType(common) !== 'snapshot' || common.length < 35 || view.getUint32(6, true) !== common.length
    || view.getUint32(18, true) !== current.snapshotId || view.getUint32(10, true) !== current.roundId) throw new Error('Invalid common snapshot');
  if (common[5] === 4) previous = null;
  else if (!previous || previous.snapshotId !== view.getUint32(22, true) || previous.roundId !== current.roundId) throw new Error('Private snapshot baseline mismatch');
  const plan = planOwner(current, previous, common.length), writer = new SnapshotWriter(plan.length);
  writer.bytes.set(common); writer.offset = common.length; writeOwner(writer, current, plan);
  return writer.bytes;
}

export function createServerMessageDecoder(): (data: string | ArrayBuffer | ArrayBufferView) => ServerMessage {
  let roster = new Map<number, Roster['upserts'][number]>();
  let baseline: Omit<SnapshotFrame, 'full' | 'fullLength'> | null = null, ownerBaseline: OwnerState | null = null;
  let localId: number | null = null, expectedRound: number | null = null;
  return data => {
    const bytes = typeof data === 'string' ? null : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (!bytes || bytes.length < 6 || (bytes[5] !== 4 && bytes[5] !== 5)) {
      const message = decodeServerMessage(data);
      if (message.type === 'welcome' || message.type === 'reset') {
        const round = integer(message.roundId, 0xffffffff);
        if (message.type === 'welcome') { localId = positiveId(message.id); roster = new Map(); }
        expectedRound = round; baseline = null; ownerBaseline = null;
      }
      if (message.type === 'roster') {
        const next = new Map(roster);
        for (const id of message.removed) if (!next.delete(id)) throw new Error('Unknown roster removal');
        for (const player of message.upserts) next.set(player.id, { ...player });
        if (next.size > 1000) throw new Error('Roster exceeds player limit');
        roster = next;
      }
      return message;
    }
    serverMessageType(bytes);
    if (bytes.length < 40 || bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('Invalid snapshot length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(6, true);
    if (length < 35 || length > bytes.length - 5) throw new Error('Invalid common snapshot length');
    const reader = new SnapshotReader(bytes.subarray(0, length)); reader.offset = 10;
    const roundId = reader.u32(), tick = reader.u32(), id = positiveId(reader.u32()), previousId = reader.u32(), flags = reader.u8();
    const full = bytes[5] === 4;
    if (expectedRound !== null && roundId !== expectedRound) throw new Error('Snapshot round mismatch');
    if (full ? previousId !== 0 || flags !== 7 : !baseline || previousId !== baseline.id || roundId !== baseline.roundId) {
      throw new Error('Snapshot baseline mismatch');
    }
    if (id === previousId || flags & ~7) throw new Error('Invalid snapshot flags');
    const old = full ? null : baseline;
    const scores: [number, number] = [flags & 1 ? reader.u32() : old!.scores[0], flags & 2 ? reader.u32() : old!.scores[1]];
    let roundEndTick = old?.roundEndTick ?? null;
    if (flags & 4) {
      const present = reader.u8();
      if (present > 1) throw new Error('Invalid round end flag');
      roundEndTick = present ? reader.u32() : null;
    }
    const playerFields = readChanges(reader, old?.players ?? EMPTY_FIELDS, playerKinds, 1000);
    const projectileFields = readChanges(reader, old?.projectiles ?? EMPTY_FIELDS, projectileKinds, 32000);
    reader.finish();
    const players: RemotePlayerState[] = [];
    for (const [id, fields] of playerFields) {
      const metadata = roster.get(id), [weapon, alive, aiming, hasGrenades, kills, deaths, x, y, z, vx, vz, yaw, pitch, sampleTick, sampleInterval] = fields;
      if (!metadata || !weapons[weapon]) throw new Error('Unknown snapshot player or weapon');
      if (sampleTick > tick || (sampleInterval !== 3 && sampleInterval !== 6 && sampleInterval !== 12)) throw new Error('Invalid player sample');
      players.push({ id, name: metadata.name, team: metadata.team, weapon: weapons[weapon], alive: !!alive, aiming: !!aiming,
        hasGrenades: !!hasGrenades, kills, deaths, position: { x, y, z }, velocity: { x: vx, z: vz }, yaw, pitch, sampleTick, sampleInterval });
    }
    const projectiles: RemoteProjectileState[] = [];
    for (const [id, [owner, weapon, x, y, z]] of projectileFields) {
      positiveId(owner);
      if (!weapons[weapon]) throw new Error('Invalid projectile weapon');
      projectiles.push({ id, owner, weapon: weapons[weapon], position: { x, y, z } });
    }
    const privateReader = new SnapshotReader(bytes.subarray(length)), ownerId = privateReader.varint(0xffffffff);
    if (ownerId && localId !== null && ownerId !== localId) throw new Error('Snapshot owner mismatch');
    const oldOwner = full ? null : ownerBaseline;
    let ownerFields: Fields | null = null, owner: PlayerState | null = null;
    if (ownerId) {
      const mask = privateReader.u8(), before = oldOwner?.ownerId === ownerId ? oldOwner.fields : null;
      if (mask & ~127 || (!before && mask !== 127)) throw new Error('Invalid owner fields');
      ownerFields = readFields(privateReader, ownerKinds, mask, before ?? undefined);
      const [kit, health, ammo, grenades, grounded, lastSeq, vy] = ownerFields;
      const player = players.find(player => player.id === ownerId);
      if (!player || !kits[kit]) throw new Error('Unknown snapshot owner or kit');
      const { hasGrenades: _hasGrenades, sampleTick: _sampleTick, sampleInterval: _sampleInterval, ...publicPlayer } = player;
      owner = { ...publicPlayer, kit: kits[kit], health, ammo, grenades, grounded: !!grounded, lastSeq,
        position: { ...player.position }, velocity: { x: player.velocity.x, y: vy, z: player.velocity.z } };
    }
    const velocityFields = readChanges(privateReader, oldOwner?.projectileVelocities ?? EMPTY_FIELDS, velocityKinds, 32000);
    privateReader.finish();
    const projectileVelocities: Snapshot['projectileVelocities'] = [];
    for (const [id, [x, y, z]] of velocityFields) {
      if (!ownerId || projectileFields.get(id)?.[0] !== ownerId) throw new Error('Invalid private projectile');
      projectileVelocities.push({ id, velocity: { x, y, z } });
    }
    baseline = { id, roundId, tick, scores, roundEndTick, players: playerFields, projectiles: projectileFields };
    ownerBaseline = { snapshotId: id, roundId, ownerId, fields: ownerFields, projectileVelocities: velocityFields };
    return { type: 'snapshot', roundId, tick, scores, roundEndTick, players, owner, projectiles, projectileVelocities };
  };
}
