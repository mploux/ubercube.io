import { afterEach, expect, test } from 'bun:test';
import { startServer } from '../src/server/index';
import { PROTOCOL_VERSION, type InputFrame, type Kit, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';
import { packBlock } from '../src/shared/voxel';

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

function fixture() {
  const host = startServer({ port: 0, hostname: '127.0.0.1', autoTick: false,
    world: { seed: 12345, size: 128, height: 128 } });
  hosts.push(host);
  host.game.world.set(60, 89, 100, packBlock(90, 90, 90));
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
    async spawn(roundId: number, id: number, kit: Kit = 'medic') {
      socket.send(JSON.stringify({ type: 'spawn', roundId, kit }));
      return wait('snapshot', message => message.roundId === roundId && message.players.some(player => player.id === id && player.alive));
    },
    async input(roundId: number, values: Partial<InputFrame> = {}) {
      const frame: InputFrame = { seq: ++seq, roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
        jump: false, sprint: false, fire: false, alt: false, weapon: 'medic', ...values };
      socket.send(JSON.stringify({ type: 'input', frames: [frame] }));
      const time = ++ping;
      socket.send(JSON.stringify({ type: 'ping', time }));
      await wait('pong', message => message.time === time);
      return frame.seq;
    },
  };
}

test('real sockets confirm medic self healing, input acknowledgement and one action per right-button press', async () => {
  const host = fixture();
  const medic = connect(host, 'Self heal'), observer = connect(host, 'Observer');
  const welcome = await medic.ready();
  await observer.ready();
  await medic.spawn(welcome.roundId, welcome.id);
  const player = host.game.players.get(welcome.id)!;
  player.position = { x: 60.5, y: 90, z: 100.5 };
  player.health = 40;
  const first = await medic.input(welcome.roundId, { alt: true });
  host.game.step(); host.game.sendSnapshot();
  const heal = await medic.wait('event', message => message.event === 'heal' && message.targetId === welcome.id);
  expect(heal.shooterId).toBe(welcome.id);
  expect(await observer.wait('event', message => message.event === 'heal')).toEqual(heal);
  for (const peer of [medic, observer]) {
    const snapshot = await peer.wait('snapshot', message => message.players.some(state => state.id === welcome.id && state.lastSeq === first));
    expect(snapshot.players.find(state => state.id === welcome.id)).toMatchObject({ health: 50, alive: true, weapon: 'medic' });
  }
  const held = await medic.input(welcome.roundId, { alt: true });
  for (let tick = 0; tick < 10; tick++) host.game.step();
  host.game.sendSnapshot();
  const holding = await medic.wait('snapshot', message => message.tick === host.game.tick);
  expect(holding.players.find(state => state.id === welcome.id)).toMatchObject({ health: 50, lastSeq: held });
  expect(medic.messages.filter(message => message.type === 'event' && message.event === 'heal')).toHaveLength(1);
  await medic.input(welcome.roundId); host.game.step();
  const second = await medic.input(welcome.roundId, { alt: true });
  host.game.step(); host.game.sendSnapshot();
  const repeated = await observer.wait('snapshot', message => message.players.some(state => state.id === welcome.id && state.lastSeq === second));
  expect(repeated.players.find(state => state.id === welcome.id)!.health).toBe(60);
  expect(medic.messages.filter(message => message.type === 'error')).toHaveLength(0);
});

test('real sockets accept sneak and retain the ledge until the acknowledged release', async () => {
  const host = fixture();
  const peer = connect(host, 'Sneak');
  const welcome = await peer.ready();
  await peer.spawn(welcome.roundId, welcome.id);
  const player = host.game.players.get(welcome.id)!;
  player.position = { x: 60.5, y: 90, z: 100.5 };
  player.velocity = { x: 0, y: 0, z: 0 };
  player.grounded = true;
  let seq = 0;
  for (let batch = 0; batch < 12; batch++) {
    seq = await peer.input(welcome.roundId, { moveX: 1, sneak: true, sprint: true });
    for (let tick = 0; tick < 10; tick++) host.game.step();
  }
  host.game.sendSnapshot();
  const edge = await peer.wait('snapshot', message => message.tick === host.game.tick);
  const held = edge.players.find(state => state.id === welcome.id)!;
  expect(held.lastSeq).toBe(seq);
  expect(held.grounded).toBe(true);
  expect(held.position.y).toBeCloseTo(90, 3);
  expect(held.position.x).toBeGreaterThan(60.8);
  expect(held.position.x).toBeLessThan(61.3);
  seq = await peer.input(welcome.roundId, { moveX: 1, sneak: false });
  for (let tick = 0; tick < 15; tick++) host.game.step();
  host.game.sendSnapshot();
  const released = await peer.wait('snapshot', message => message.tick === host.game.tick);
  const falling = released.players.find(state => state.id === welcome.id)!;
  expect(falling.lastSeq).toBe(seq);
  expect(falling.grounded).toBe(false);
  expect(falling.position.y).toBeLessThan(90);
  expect(falling.position.x).toBeGreaterThan(held.position.x);
  expect(peer.messages.filter(message => message.type === 'error')).toHaveLength(0);
});

test('real sockets receive proportional fall health and the same fatal landing event', async () => {
  const host = fixture();
  const falling = connect(host, 'Falling'), observer = connect(host, 'Fall observer');
  const welcome = await falling.ready();
  await observer.ready();
  await falling.spawn(welcome.roundId, welcome.id);
  const player = host.game.players.get(welcome.id)!;
  player.position = { x: 60.5, y: 103, z: 100.5 };
  player.grounded = false;
  const first = await falling.input(welcome.roundId);
  for (let tick = 0; tick < 100; tick++) host.game.step();
  host.game.sendSnapshot();
  for (const peer of [falling, observer]) {
    const snapshot = await peer.wait('snapshot', message => message.tick === host.game.tick);
    expect(snapshot.players.find(state => state.id === welcome.id)).toMatchObject({ health: 50, alive: true, lastSeq: first });
  }
  player.position.y = 110;
  player.velocity = { x: 0, y: 0, z: 0 };
  player.grounded = false;
  player.health = 100;
  const second = await falling.input(welcome.roundId);
  for (let tick = 0; tick < 100; tick++) host.game.step();
  host.game.sendSnapshot();
  const death = await falling.wait('event', message => message.event === 'death' && message.targetId === welcome.id);
  expect(death.shooterId).toBe(welcome.id);
  expect(death.weapon).toBeUndefined();
  expect(death.death!.killer).toBeUndefined();
  expect(death.death!.player.health).toBe(0);
  expect(death.death!.impulse).toEqual({ x: 0, y: 0, z: 0 });
  expect(await observer.wait('event', message => message.event === 'death')).toEqual(death);
  for (const peer of [falling, observer]) {
    const snapshot = await peer.wait('snapshot', message => message.tick === host.game.tick);
    expect(snapshot.players.find(state => state.id === welcome.id)).toMatchObject({ health: 0, alive: false, deaths: 1, kills: 0, lastSeq: second });
    expect(peer.messages.filter(message => message.type === 'event' && message.event === 'death')).toHaveLength(1);
    expect(peer.messages.filter(message => message.type === 'error')).toHaveLength(0);
  }
});

test('real sockets reject stale round healing and sneak, then acknowledge the current round', async () => {
  const host = fixture();
  const peer = connect(host, 'Round reset');
  const welcome = await peer.ready();
  await peer.spawn(welcome.roundId, welcome.id);
  const player = host.game.players.get(welcome.id)!;
  player.position = { x: 60.5, y: 110, z: 100.5 };
  await peer.input(welcome.roundId, { sneak: true }); host.game.step();
  host.game.resetRound();
  const reset = await peer.wait('reset');
  await peer.wait('world', message => message.roundId === reset.roundId && message.complete === true, true);
  await peer.spawn(reset.roundId, welcome.id);
  player.health = 50;
  const start = { ...player.position };
  await peer.input(welcome.roundId, { seq: 1, moveX: 1, sneak: true, alt: true });
  for (let tick = 0; tick < 30; tick++) host.game.step();
  host.game.sendSnapshot();
  const ignored = await peer.wait('snapshot', message => message.roundId === reset.roundId && message.tick === host.game.tick);
  const unchanged = ignored.players.find(state => state.id === welcome.id)!;
  expect(unchanged).toMatchObject({ health: 50, alive: true, lastSeq: 0 });
  expect(unchanged.position.x).toBeCloseTo(start.x, 4);
  expect(unchanged.position.z).toBeCloseTo(start.z, 4);
  expect(peer.messages.some(message => message.type === 'event' && message.roundId === reset.roundId)).toBe(false);
  await peer.input(reset.roundId, { seq: 1, sneak: true, alt: true });
  host.game.step(); host.game.sendSnapshot();
  const current = await peer.wait('snapshot', message => message.roundId === reset.roundId && message.players.some(state => state.lastSeq === 1));
  expect(current.players.find(state => state.id === welcome.id)).toMatchObject({ health: 60, alive: true, lastSeq: 1 });
  expect(await peer.wait('event', message => message.roundId === reset.roundId && message.event === 'heal')).toMatchObject({ targetId: welcome.id, shooterId: welcome.id });
  expect(peer.messages.filter(message => message.type === 'error')).toHaveLength(0);
});
