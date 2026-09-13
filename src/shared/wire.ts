import type { Kit, PlayerState, ProjectileState, ServerMessage, WeaponId } from './protocol';

const MAGIC = 0x55424331;
const kits: Kit[] = ['assault', 'sniper', 'medic'];
const weapons: WeaponId[] = ['ak47', 'awp', 'shovel', 'grenade', 'medic'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeServerMessage(message: ServerMessage): string | Uint8Array {
  if (message.type !== 'snapshot') return JSON.stringify(message);
  const names = message.players.map(player => encoder.encode(player.name));
  const bytes = new Uint8Array(30 + names.reduce((sum, name) => sum + 60 + name.length, 0) + message.projectiles.length * 33);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u8 = (n: number) => { view.setUint8(offset, n); offset++; };
  const u16 = (n: number) => { view.setUint16(offset, n, true); offset += 2; };
  const u32 = (n: number) => { view.setUint32(offset, n, true); offset += 4; };
  const f32 = (n: number) => { view.setFloat32(offset, n, true); offset += 4; };
  const f64 = (n: number) => { view.setFloat64(offset, n, true); offset += 8; };
  u32(MAGIC); u8(1); u8(1);
  u32(message.roundId); u32(message.tick);
  u32(message.scores[0]); u32(message.scores[1]);
  f32(message.remaining ?? -1);
  u16(message.players.length); u16(message.projectiles.length);
  for (let i = 0; i < message.players.length; i++) {
    const player = message.players[i];
    const name = names[i];
    if (name.length > 255) throw new Error('Player name exceeds wire limit');
    u32(player.id); u8(player.team); u8(kits.indexOf(player.kit)); u8(weapons.indexOf(player.weapon));
    u8((player.alive ? 1 : 0) | (player.grounded ? 2 : 0) | (player.aiming ? 4 : 0));
    f32(player.position.x); f32(player.position.y); f32(player.position.z);
    f32(player.velocity.x); f32(player.velocity.y); f32(player.velocity.z);
    f32(player.yaw); f32(player.pitch);
    u8(player.health); u8(player.ammo); u8(player.grenades);
    u32(player.kills); u32(player.deaths); f64(player.lastSeq);
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
  if (typeof data === 'string') return JSON.parse(data) as ServerMessage;
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const u8 = () => view.getUint8(offset++);
  const u16 = () => { const n = view.getUint16(offset, true); offset += 2; return n; };
  const u32 = () => { const n = view.getUint32(offset, true); offset += 4; return n; };
  const f32 = () => { const n = view.getFloat32(offset, true); offset += 4; return n; };
  const f64 = () => { const n = view.getFloat64(offset, true); offset += 8; return n; };
  if (bytes.length < 30 || u32() !== MAGIC || u8() !== 1 || u8() !== 1) throw new Error('Invalid snapshot header');
  const roundId = u32(), tick = u32();
  const scores: [number, number] = [u32(), u32()];
  const remaining = f32();
  const playerCount = u16(), projectileCount = u16();
  if (playerCount > 1000 || projectileCount > 32000 || bytes.length < 30 + playerCount * 60 + projectileCount * 33) throw new Error('Invalid snapshot length');
  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    const id = u32(), team = u8(), kit = kits[u8()], weapon = weapons[u8()], flags = u8();
    const position = { x: f32(), y: f32(), z: f32() };
    const velocity = { x: f32(), y: f32(), z: f32() };
    const yaw = f32(), pitch = f32();
    const health = u8(), ammo = u8(), grenades = u8();
    const kills = u32(), deaths = u32(), lastSeq = f64();
    const nameLength = u8();
    if (!kit || !weapon || team > 2 || offset + nameLength > bytes.length) throw new Error('Invalid player record');
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    players.push({ id, team: team as 0 | 1 | 2, kit, weapon, alive: !!(flags & 1), grounded: !!(flags & 2), aiming: !!(flags & 4), position, velocity, yaw, pitch, health, ammo, grenades, kills, deaths, lastSeq, name });
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
