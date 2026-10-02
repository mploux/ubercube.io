import { afterEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { loadImportedMap } from '../src/client/map-loader';
import { startServer } from '../src/server/index';
import { readMapCatalog } from '../src/server/maps';
import { playerCollides } from '../src/shared/movement';
import { PROTOCOL_VERSION, type ClientMessage, type InputFrame, type ServerMessage } from '../src/shared/protocol';
import { damageBlock, packBlock, VoxelWorld } from '../src/shared/voxel';
import { decodeServerMessage } from '../src/shared/wire';

const choices = readMapCatalog(resolve(import.meta.dir, '../public/maps'), { seed: 12345, size: 64, height: 64 })
  .filter(choice => choice.world.map);
const hosts: ReturnType<typeof startServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of hosts.splice(0)) {
    const deadline = performance.now() + 2000;
    while (host.game.connections.size && performance.now() < deadline) await Bun.sleep(1);
    const remaining = host.game.connections.size;
    host.stop();
    expect(remaining).toBe(0);
    expect(host.game.players.size).toBe(0);
  }
});

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
      const found = messages.find((message): message is Extract<ServerMessage, { type: T }> =>
        message.type === type && matches(message as Extract<ServerMessage, { type: T }>));
      if (found) return found;
      if (advance) host.game.step();
      await Bun.sleep(1);
    }
    throw new Error(`${name}: missing ${type}; errors: ${JSON.stringify(messages.filter(message => message.type === 'error'))}`);
  };
  const send = async (message: ClientMessage) => {
    socket.send(JSON.stringify(message));
    const time = ++ping;
    socket.send(JSON.stringify({ type: 'ping', time }));
    await wait('pong', message => message.time === time);
  };
  return {
    socket, messages, wait, send,
    async input(roundId: number, values: Partial<InputFrame> = {}) {
      const frame: InputFrame = { seq: ++seq, roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
        jump: false, sprint: false, fire: false, alt: false, weapon: 'shovel', ...values };
      await send({ type: 'input', frames: [frame] });
      return frame.seq;
    },
  };
}

for (const [index, choice] of choices.entries()) {
  test(`${choice.name}: real sockets edit, catch up and rotate the shipped map`, async () => {
    const next = choices[(index + 1) % choices.length];
    const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false, roundSeconds: 1,
      maps: [choice, next], map: next.id });
    hosts.push(host);
    const first = connect(host, 'Builder');
    const welcome = await first.wait('welcome');
    await first.wait('world', message => message.complete === true);
    const observer = connect(host, 'Observer');
    const observing = await observer.wait('welcome');
    await observer.wait('world', message => message.complete === true);
    expect((await observer.wait('map-choice')).chooserId).toBe(welcome.id);

    await observer.send({ type: 'select-map', roundId: welcome.roundId, mapId: choice.id });
    await observer.send({ type: 'spawn', roundId: welcome.roundId, kit: 'assault' });
    expect(observer.messages.filter(message => message.type === 'error')).toHaveLength(2);
    expect(host.game.options.world.map?.id).toBe(next.id);
    expect(host.game.players.get(observing.id)!.alive).toBe(false);

    await first.send({ type: 'select-map', roundId: welcome.roundId, mapId: choice.id });
    const reset = await first.wait('reset');
    expect((await observer.wait('reset')).world).toEqual(choice.world);
    expect(reset.world).toEqual(choice.world);
    for (const peer of [first, observer]) {
      expect(await peer.wait('world', message => message.roundId === reset.roundId && message.complete === true))
        .toMatchObject({ revision: 0, edits: [] });
    }
    const imported = await loadImportedMap(reset.world, host.server.url.origin, new AbortController().signal);
    expect(imported).toBeDefined();
    const replica = new VoxelWorld(reset.world, imported);
    await first.send({ type: 'spawn', roundId: reset.roundId, kit: 'assault' });
    await first.wait('snapshot', message => message.players.some(player => player.id === welcome.id && player.alive));
    const player = host.game.players.get(welcome.id)!;
    expect(playerCollides(host.game.world, player.position)).toBe(false);
    expect(playerCollides(replica, player.position)).toBe(false);
    const startedAt = host.game.tick;

    // Prepare a repeatable work area and a multi-batch baseline; actions still arrive over the socket.
    for (let x = 58; x <= 62; x++) for (let z = 55; z <= 62; z++) {
      host.game.world.set(x, 49, z, packBlock(90, 90, 90));
      for (let y = 50; y <= 54; y++) host.game.world.set(x, y, z, 0);
    }
    host.game.world.set(60, 52, 57, packBlock(120, 140, 160));
    for (let i = 0; i < 1600; i++) host.game.world.set(128 + i % 32, 50, 128 + Math.floor(i / 32), packBlock(10, 20, 30));
    player.position = { x: 60.5, y: 50, z: 60.5 };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.grounded = true;
    const built = packBlock(85, 85, 85);
    const buildSeq = await first.input(reset.roundId, { alt: true });
    host.game.step(); host.game.sendSnapshot();
    expect(host.game.world.get(60, 52, 58)).toBe(built);
    for (const peer of [first, observer]) {
      const delta = await peer.wait('world', message => !message.initial && message.edits.some(edit =>
        edit[0] === 60 && edit[1] === 52 && edit[2] === 58 && edit[3] === built));
      expect(delta).toMatchObject({ roundId: reset.roundId, revision: 1 });
      expect(await peer.wait('event', message => message.event === 'build')).toMatchObject({ shooterId: welcome.id });
      const snapshot = await peer.wait('snapshot', message => message.players.some(state => state.id === welcome.id && state.lastSeq === buildSeq));
      expect(snapshot.players.find(state => state.id === welcome.id)!.weapon).toBe('shovel');
    }

    const late = connect(host, 'Late during edits');
    const arrival = await late.wait('welcome');
    expect(arrival.world).toEqual(choice.world);
    const firstBatch = await late.wait('world', message => message.initial === true);
    expect(firstBatch.complete).toBe(false);
    await late.send({ type: 'spawn', roundId: reset.roundId, kit: 'assault' });
    expect(host.game.players.get(arrival.id)!.alive).toBe(false);
    expect(late.messages.filter(message => message.type === 'error')).toHaveLength(1);

    await first.input(reset.roundId, { fire: true }); host.game.step();
    const damaged = damageBlock(built, .5);
    expect(host.game.world.get(60, 52, 58)).toBe(damaged);
    for (const peer of [first, observer]) {
      expect(await peer.wait('world', message => message.revision === 2)).toMatchObject({ edits: [[60, 52, 58, damaged]] });
    }
    await first.input(reset.roundId); host.game.step();
    const digSeq = await first.input(reset.roundId, { fire: true }); host.game.step(); host.game.sendSnapshot();
    expect(host.game.world.get(60, 52, 58)).toBe(0);
    for (const peer of [first, observer]) {
      expect(await peer.wait('world', message => message.revision === 3)).toMatchObject({ edits: [[60, 52, 58, 0]] });
      const snapshot = await peer.wait('snapshot', message => message.players.some(state => state.id === welcome.id && state.lastSeq === digSeq));
      expect(snapshot.roundId).toBe(reset.roundId);
    }
    const completed = await late.wait('world', message => message.complete === true, true);
    expect(completed.revision).toBe(3);
    const streamed = late.messages.filter((message): message is Extract<ServerMessage, { type: 'world' }> =>
      message.type === 'world' && message.roundId === reset.roundId);
    expect(streamed.filter(message => message.initial && message.revision > firstBatch.revision).length).toBeGreaterThanOrEqual(2);
    for (const message of streamed) replica.applyEdits(message.edits);
    expect(replica.getEdits()).toEqual(host.game.world.getEdits());
    await late.send({ type: 'spawn', roundId: reset.roundId, kit: 'sniper' });
    const lateSpawn = await late.wait('snapshot', message => message.players.some(state => state.id === arrival.id && state.alive));
    expect(playerCollides(replica, lateSpawn.players.find(state => state.id === arrival.id)!.position)).toBe(false);

    // Advance the production round clock; the last old input stays queued when rotation happens.
    while (host.game.tick < startedAt + 57) host.game.step();
    await first.input(reset.roundId, { weapon: 'grenade', fire: true, pitch: .7 }); host.game.step();
    await first.input(reset.roundId, { weapon: 'grenade', pitch: .7 }); host.game.step();
    await first.wait('event', message => message.event === 'shot' && message.weapon === 'grenade');
    expect(host.game.projectiles.size).toBe(1);
    player.kills = 2;
    host.game.scores = [2, 0];
    const interrupted = connect(host, 'Transfer at rotation');
    await interrupted.wait('welcome');
    expect((await interrupted.wait('world', message => message.initial === true)).complete).toBe(false);
    await first.input(reset.roundId, { moveX: 1, fire: true });
    host.game.step();
    const rotated = await first.wait('reset', message => message.roundId > reset.roundId);
    expect(rotated.world).toEqual(next.world);
    for (const peer of [first, observer, late, interrupted]) {
      await peer.wait('reset', message => message.roundId === rotated.roundId);
      expect(await peer.wait('world', message => message.roundId === rotated.roundId && message.complete === true))
        .toMatchObject({ revision: 0, edits: [] });
      const resetAt = peer.messages.findIndex(message => message.type === 'reset' && message.roundId === rotated.roundId);
      expect(peer.messages.slice(resetAt + 1).some(message => message.type === 'world' && message.roundId === reset.roundId)).toBe(false);
      expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    }
    expect(host.game.world.getEdits()).toEqual([]);
    expect(host.game.projectiles.size).toBe(0);
    expect(host.game.scores).toEqual([0, 0]);
    expect([...host.game.players.values()].every(state => !state.alive && state.kills === 0 && state.lastSeq === 0)).toBe(true);
    expect([...host.game.connections].every(connection => connection.queue.length === 0)).toBe(true);

    await first.send({ type: 'select-map', roundId: reset.roundId, mapId: choice.id });
    await first.send({ type: 'spawn', roundId: reset.roundId, kit: 'assault' });
    await first.input(reset.roundId, { seq: 1, fire: true });
    host.game.step();
    expect(player.alive).toBe(false);
    expect(host.game.revision).toBe(0);
    expect(host.game.options.world.map?.id).toBe(next.id);
    await first.send({ type: 'spawn', roundId: rotated.roundId, kit: 'assault' });
    const respawned = { ...player.position };
    await first.input(reset.roundId, { seq: 100, moveX: 1, fire: true });
    for (let tick = 0; tick < 3; tick++) host.game.step();
    expect(player.lastSeq).toBe(0);
    expect(player.position.x).toBe(respawned.x);
    expect(player.position.z).toBe(respawned.z);
    expect(host.game.revision).toBe(0);
    await first.input(rotated.roundId, { seq: 1, moveX: 1 });
    host.game.step(); host.game.sendSnapshot();
    const current = await first.wait('snapshot', message => message.roundId === rotated.roundId &&
      message.players.some(state => state.id === welcome.id && state.lastSeq === 1));
    expect(current.players.find(state => state.id === welcome.id)!.alive).toBe(true);
    expect(first.messages.filter(message => message.type === 'error')).toHaveLength(0);
    expect(interrupted.messages.filter(message => message.type === 'error')).toHaveLength(0);
  }, 15000);
}
