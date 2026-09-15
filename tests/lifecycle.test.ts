import { expect, test } from 'bun:test';
import { GameServer, type Connection, type Peer } from '../src/server/game';
import { PROTOCOL_VERSION, type ClientMessage, type InputFrame, type ServerMessage } from '../src/shared/protocol';
import { createServerMessageDecoder } from '../src/shared/wire';

test('input sequence survives death with unconsumed commands, then resets only for a new round or connection', () => {
  const game = new GameServer({ world: { seed: 12, size: 64, height: 48 } });
  const messages: ServerMessage[] = [];
  const decode = createServerMessageDecoder();
  const peer: Peer = {
    send(data) { messages.push(decode(data)); return typeof data === 'string' ? data.length : data.byteLength; },
    close() {}, bufferedAmount() { return 0; },
  };
  let connection: Connection = game.connect(peer)!;
  const send = (message: ClientMessage) => game.receive(connection, JSON.stringify(message));
  const frame = (seq: number): InputFrame => ({
    seq, roundId: game.roundId, moveX: 0, moveZ: 0, yaw: 0, pitch: 0,
    jump: false, sprint: false, fire: false, alt: false, weapon: connection.player!.weapon,
  });
  send({ type: 'hello', version: PROTOCOL_VERSION, name: 'Lifecycle' });
  send({ type: 'spawn', roundId: game.roundId, kit: 'assault' });
  const player = connection.player!;
  send({ type: 'input', frames: [frame(1), frame(2), frame(3)] });
  player.position.y = -20;
  game.step();

  expect(player.alive).toBe(false);
  expect(player.lastSeq).toBe(1);
  expect(connection.highestSeq).toBe(3);
  expect(connection.queue).toHaveLength(0);

  send({ type: 'spawn', roundId: game.roundId, kit: 'sniper' });
  expect(player.alive).toBe(true);
  expect(player.lastSeq).toBe(1);
  expect(connection.highestSeq).toBe(3);
  // The client keeps its emitted counter, including commands discarded at death.
  send({ type: 'input', frames: [frame(6), frame(7), frame(8)] });
  game.step();
  expect(player.lastSeq).toBe(6);
  expect(connection.highestSeq).toBe(8);
  expect(connection.queue).toHaveLength(2);

  const stale = frame(9);
  game.resetRound();
  expect(player.lastSeq).toBe(0);
  expect(connection.highestSeq).toBe(0);
  send({ type: 'input', frames: [stale] });
  expect(connection.queue).toHaveLength(0);
  send({ type: 'spawn', roundId: game.roundId, kit: 'assault' });
  send({ type: 'input', frames: [frame(1)] });
  game.step();
  expect(player.lastSeq).toBe(1);

  const oldId = player.id;
  game.disconnect(connection);
  connection = game.connect(peer)!;
  send({ type: 'hello', version: PROTOCOL_VERSION, name: 'Lifecycle' });
  expect(connection.player!.id).not.toBe(oldId);
  expect(connection.highestSeq).toBe(0);
  send({ type: 'spawn', roundId: game.roundId, kit: 'assault' });
  send({ type: 'input', frames: [frame(1)] });
  game.step();
  expect(connection.player!.lastSeq).toBe(1);
  expect(messages.filter(message => message.type === 'error')).toHaveLength(0);
});
