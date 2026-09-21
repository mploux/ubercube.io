import { afterEach, expect, test } from 'bun:test';
import { startServer } from '../src/server/index';
import { PROTOCOL_VERSION, type InputFrame, type Kit, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';
import { packBlock, VoxelWorld } from '../src/shared/voxel';

const hosts: ReturnType<typeof startServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(socket => new Promise<void>(resolve => {
    if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
    socket.addEventListener('close', () => resolve(), { once: true });
    socket.close();
  })));
  for (const host of hosts.splice(0)) {
    const deadline = performance.now() + 1000;
    while (host.game.connections.size && performance.now() < deadline) await Bun.sleep(1);
    const remaining = host.game.connections.size;
    host.stop();
    expect(remaining).toBe(0);
  }
});

function fixture(largeTransfer = false) {
  const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false,
    world: { seed: 12345, size: 128, height: 128 } });
  hosts.push(host);
  const stone = packBlock(90, 90, 90);
  for (let x = 58; x <= 64; x++) for (let z = 98; z <= 103; z++) host.game.world.set(x, 89, z, stone);
  if (largeTransfer) {
    // Keep the late join's baseline in flight while the rocket modifies a different region.
    for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
      for (let y = 115; y <= 117; y++) host.game.world.set(x, y, z, stone);
    }
    for (let x = 58; x <= 62; x++) for (let y = 90; y <= 94; y++) host.game.world.set(x, y, 94, stone);
  }
  return host;
}

function connect(host: ReturnType<typeof startServer>, name: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/ws`);
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  let seq = 0, ping = 0;
  socket.addEventListener('message', event => messages.push(decodeServerMessage(event.data)));
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name })));
  const wait = async <T extends ServerMessage['type']>(type: T,
    matches: (message: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    advance = false): Promise<Extract<ServerMessage, { type: T }>> => {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      const found = messages.find((message): message is Extract<ServerMessage, { type: T }> => message.type === type && matches(message as Extract<ServerMessage, { type: T }>));
      if (found) return found;
      if (advance) host.game.step();
      await Bun.sleep(1);
    }
    throw new Error(`${name}: no matching ${type}; errors: ${JSON.stringify(messages.filter(message => message.type === 'error'))}`);
  };
  return {
    socket, messages, wait,
    async ready() {
      const welcome = await wait('welcome');
      await wait('world', message => message.complete === true, true);
      return welcome;
    },
    async spawn(roundId: number, id: number, kit: Kit) {
      socket.send(JSON.stringify({ type: 'spawn', roundId, kit }));
      return wait('snapshot', message => message.roundId === roundId && message.players.some(player => player.id === id && player.alive));
    },
    async input(roundId: number, values: Partial<InputFrame> = {}) {
      const frame: InputFrame = { seq: ++seq, roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
        jump: false, sprint: false, fire: false, alt: true, weapon: 'rpg', ...values };
      socket.send(JSON.stringify({ type: 'input', frames: [frame] }));
      const time = ++ping;
      socket.send(JSON.stringify({ type: 'ping', time }));
      await wait('pong', message => message.time === time);
      return frame.seq;
    },
  };
}

async function aim(host: ReturnType<typeof startServer>, peer: ReturnType<typeof connect>, roundId: number, id: number) {
  host.game.players.get(id)!.position = { x: 60.5, y: 90, z: 100.5 };
  for (let batch = 0; batch < 8; batch++) {
    await peer.input(roundId);
    for (let tick = 0; tick < 10; tick++) host.game.step();
  }
}

function receivedWorld(peer: ReturnType<typeof connect>, world: VoxelWorld, roundId: number): VoxelWorld {
  const copy = new VoxelWorld(world.config);
  for (const message of peer.messages) {
    if (message.type === 'world' && message.roundId === roundId) {
      for (const [x, y, z, value] of message.edits) copy.set(x, y, z, value);
    }
  }
  return copy;
}

test('real sockets confirm the same RPG, ammo and explosion, including terrain changes during a late join', async () => {
  const host = fixture(true);
  const shooter = connect(host, 'RPG shooter'), observer = connect(host, 'RPG observer');
  const welcome = await shooter.ready();
  await observer.ready();
  await shooter.spawn(welcome.roundId, welcome.id, 'assault');
  await aim(host, shooter, welcome.roundId, welcome.id);
  const seq = await shooter.input(welcome.roundId, { fire: true });
  host.game.step(); host.game.sendSnapshot();
  const shot = await shooter.wait('event', message => message.event === 'shot' && message.weapon === 'rpg');
  const seenShot = await observer.wait('event', message => message.event === 'shot' && message.weapon === 'rpg');
  expect(seenShot).toEqual(shot);
  expect(shot.inputSeq).toBe(seq);
  expect(shot.shooterId).toBe(welcome.id);
  expect(Math.hypot(shot.velocity!.x, shot.velocity!.y, shot.velocity!.z)).toBeCloseTo(60, 5);
  const confirmed = await shooter.wait('snapshot', message => message.tick === shot.tick);
  const seen = await observer.wait('snapshot', message => message.tick === shot.tick);
  const player = confirmed.players.find(candidate => candidate.id === welcome.id)!;
  expect([player.weapon, player.ammo, player.lastSeq]).toEqual(['rpg', 29, seq]);
  expect(confirmed.projectiles).toHaveLength(1);
  expect(confirmed.projectiles[0]).toMatchObject({ id: shot.projectileId, owner: welcome.id, weapon: 'rpg' });
  expect(seen.projectiles).toEqual(confirmed.projectiles);
  expect(host.game.world.get(60, 92, 94)).not.toBe(0);
  await shooter.input(welcome.roundId);

  const late = connect(host, 'During explosion');
  await late.wait('welcome');
  await late.wait('world', message => message.initial === true && message.complete === false);
  expect(late.messages.some(message => message.type === 'world' && message.complete)).toBe(false);
  for (let tick = 0; tick < 16; tick++) host.game.step();
  const explosion = await shooter.wait('event', message => message.event === 'explosion' && message.projectileId === shot.projectileId);
  expect(await observer.wait('event', message => message.event === 'explosion' && message.projectileId === shot.projectileId)).toEqual(explosion);
  expect(host.game.world.get(60, 92, 94)).toBe(0);
  expect(host.game.projectiles.size).toBe(0);
  expect(late.messages.some(message => message.type === 'world' && message.complete)).toBe(false);
  await late.wait('world', message => message.complete === true, true);
  await observer.wait('world', message => !message.initial && message.edits.some(([x, y, z, value]) => x === 60 && y === 92 && z === 94 && value === 0));
  for (const peer of [shooter, observer, late]) {
    const copy = receivedWorld(peer, host.game.world, welcome.roundId);
    expect(copy.get(60, 92, 94)).toBe(0);
    expect(copy.getEdits().sort()).toEqual(host.game.world.getEdits().sort());
  }
  const final = await late.wait('snapshot', message => message.tick >= explosion.tick!);
  expect(final.projectiles).toHaveLength(0);
  expect(final.players.find(player => player.id === welcome.id)!.health).toBeLessThan(100);
  expect(shooter.messages.filter(message => message.type === 'event' && message.event === 'explosion' && message.projectileId === shot.projectileId)).toHaveLength(1);
}, 15000);

test('real sockets confirm one direct 80-damage explosion and splash on another player', async () => {
  const host = fixture();
  const shooter = connect(host, 'Shooter'), target = connect(host, 'Direct target'), nearby = connect(host, 'Splash target');
  const first = await shooter.ready(), second = await target.ready(), third = await nearby.ready();
  for (const [peer, welcome] of [[shooter, first], [target, second], [nearby, third]] as const) {
    await peer.spawn(welcome.roundId, welcome.id, 'assault');
  }
  await aim(host, shooter, first.roundId, first.id);
  host.game.players.get(second.id)!.position = { x: 60.5, y: 90, z: 93.5 };
  host.game.players.get(third.id)!.position = { x: 63.5, y: 90, z: 93.5 };
  for (const id of [second.id, third.id]) {
    const player = host.game.players.get(id)!;
    player.velocity = { x: 0, y: 0, z: 0 };
    host.game.world.set(Math.floor(player.position.x), 89, 93, packBlock(90, 90, 90));
  }
  await shooter.input(first.roundId, { fire: true });
  host.game.step();
  await shooter.input(first.roundId);
  for (let tick = 0; tick < 8; tick++) host.game.step();
  host.game.sendSnapshot();
  const impact = await shooter.wait('event', message => message.event === 'impact' && message.targetId === second.id);
  const explosion = await shooter.wait('event', message => message.event === 'explosion' && message.projectileId === impact.projectileId);
  for (const peer of [shooter, target, nearby]) {
    expect(await peer.wait('event', message => message.event === 'explosion' && message.projectileId === impact.projectileId)).toEqual(explosion);
    const snapshot = await peer.wait('snapshot', message => message.tick === host.game.tick);
    expect(snapshot.players.find(player => player.id === second.id)!.health).toBe(20);
    const splashHealth = snapshot.players.find(player => player.id === third.id)!.health;
    expect(splashHealth).toBeGreaterThan(20);
    expect(splashHealth).toBeLessThan(100);
    expect(snapshot.projectiles).toHaveLength(0);
    expect(peer.messages.filter(message => message.type === 'event' && message.event === 'explosion' && message.projectileId === impact.projectileId)).toHaveLength(1);
  }
});

test('real sockets reject a medic RPG command and still confirm healing to both players', async () => {
  const host = fixture();
  const patient = connect(host, 'Patient'), medic = connect(host, 'Medic');
  const first = await patient.ready(), second = await medic.ready();
  await patient.spawn(first.roundId, first.id, 'assault');
  await medic.spawn(second.roundId, second.id, 'medic');
  host.game.players.get(first.id)!.position = { x: 60.5, y: 90, z: 99.5 };
  host.game.players.get(first.id)!.health = 70;
  host.game.players.get(second.id)!.position = { x: 60.5, y: 90, z: 101.5 };
  await medic.input(second.roundId, { fire: true });
  expect((await medic.wait('error')).fatal).not.toBe(true);
  const seq = await medic.input(second.roundId, { weapon: 'medic', fire: true, alt: false });
  host.game.step(); host.game.sendSnapshot();
  const heal = await patient.wait('event', message => message.event === 'heal' && message.targetId === first.id);
  expect(await medic.wait('event', message => message.event === 'heal' && message.targetId === first.id)).toEqual(heal);
  const snapshot = await medic.wait('snapshot', message => message.players.some(player => player.id === second.id && player.lastSeq === seq));
  expect(snapshot.players.find(player => player.id === first.id)!.health).toBe(80);
  expect(snapshot.players.find(player => player.id === second.id)!.weapon).toBe('medic');
  expect(snapshot.projectiles).toHaveLength(0);
  expect(medic.messages.some(message => message.type === 'event' && message.weapon === 'rpg')).toBe(false);
});

test('real sockets clear an airborne RPG at reset and reject commands from the previous round', async () => {
  const host = fixture();
  const peer = connect(host, 'Reset rocket');
  const welcome = await peer.ready();
  await peer.spawn(welcome.roundId, welcome.id, 'assault');
  await aim(host, peer, welcome.roundId, welcome.id);
  await peer.input(welcome.roundId, { fire: true });
  host.game.step(); host.game.sendSnapshot();
  await peer.wait('snapshot', message => message.projectiles.some(projectile => projectile.weapon === 'rpg'));
  host.game.resetRound();
  const reset = await peer.wait('reset');
  await peer.wait('world', message => message.roundId === reset.roundId && message.complete === true, true);
  await peer.spawn(reset.roundId, welcome.id, 'assault');
  await peer.input(welcome.roundId, { seq: 1, fire: true });
  for (let tick = 0; tick < 3; tick++) host.game.step();
  host.game.sendSnapshot();
  const ignored = await peer.wait('snapshot', message => message.roundId === reset.roundId && message.tick === host.game.tick);
  expect(ignored.projectiles).toHaveLength(0);
  expect(ignored.players.find(player => player.id === welcome.id)).toMatchObject({ weapon: 'ak47', ammo: 30, lastSeq: 0 });
  await peer.input(reset.roundId, { seq: 1 });
  host.game.step(); host.game.sendSnapshot();
  const current = await peer.wait('snapshot', message => message.roundId === reset.roundId && message.players.some(player => player.lastSeq === 1));
  expect(current.players.find(player => player.id === welcome.id)).toMatchObject({ weapon: 'rpg', ammo: 30, lastSeq: 1 });
  expect(current.projectiles).toHaveLength(0);
  expect(peer.messages.some(message => message.type === 'event' && message.roundId === reset.roundId && message.weapon === 'rpg')).toBe(false);
  expect(peer.socket.readyState).toBe(WebSocket.OPEN);
});
