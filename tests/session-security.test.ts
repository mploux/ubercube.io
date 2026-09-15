import { describe, expect, test } from 'bun:test';
import { GameServer, type Peer } from '../src/shared/game';
import { PROTOCOL_VERSION, type GameEvent, type InputFrame, type ServerMessage } from '../src/shared/protocol';
import { decodeServerMessage } from '../src/shared/wire';

class TestPeer implements Peer {
  messages: ServerMessage[] = [];
  closed = false;
  send(data: string | Uint8Array) { this.messages.push(decodeServerMessage(data)); return 1; }
  close() { this.closed = true; }
  bufferedAmount() { return 0; }
}

function join(game: GameServer) {
  const peer = new TestPeer(), connection = game.connect(peer)!;
  game.receive(connection, JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: 'Security' }));
  return { peer, connection };
}

describe('session and combat security', () => {
  test('pings cannot retain an unused player slot forever', () => {
    let now = 0;
    const game = new GameServer({}, undefined, () => now);
    const { peer, connection } = join(game);
    for (now = 20000; now <= 120000; now += 20000) {
      game.receive(connection, JSON.stringify({ type: 'ping', time: now })); game.step();
      expect(peer.closed).toBe(false);
    }
    game.receive(connection, JSON.stringify({ type: 'ping', time: now })); game.step();
    expect(peer.closed).toBe(true);
    expect(game.players.size).toBe(0);
  });

  test('a reset starts a fresh kit selection deadline', () => {
    let now = 0;
    const game = new GameServer({}, undefined, () => now);
    const { peer, connection } = join(game);
    now = 119000; game.resetRound();
    now = 121000;
    game.receive(connection, JSON.stringify({ type: 'ping', time: now })); game.step();
    expect(peer.closed).toBe(false);
    game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
    for (now = 140000; now < 280000; now += 20000) {
      game.receive(connection, JSON.stringify({ type: 'ping', time: now })); game.step();
      expect(peer.closed).toBe(false);
    }
    expect(connection.player!.alive).toBe(true);
  });

  test('combat spread can use a server secret source independently of the public world seed', () => {
    const shoot = (random: number) => {
      let calls = 0;
      const game = new GameServer({}, undefined, undefined, () => { calls++; return random; });
      const { peer, connection } = join(game);
      game.receive(connection, JSON.stringify({ type: 'spawn', roundId: game.roundId, kit: 'assault' }));
      const spawn = { ...connection.player!.position };
      for (let seq = 1; seq <= 90; seq++) {
        const frame: InputFrame = { roundId: game.roundId, seq, moveX: 0, moveZ: 0, yaw: 0, pitch: .5,
          jump: false, sprint: false, fire: true, alt: false, weapon: 'ak47' };
        game.receive(connection, JSON.stringify({ type: 'input', frames: [frame] })); game.step();
      }
      const shots = peer.messages.filter((message): message is GameEvent => message.type === 'event' && message.event === 'shot');
      expect(calls).toBeGreaterThan(0); expect(shots.length).toBeGreaterThan(1);
      return { spawn, first: shots[0].endPosition };
    };
    const first = shoot(.1), second = shoot(.9);
    expect(first.spawn).toEqual(second.spawn);
    expect(first.first).not.toEqual(second.first);
  });
});
