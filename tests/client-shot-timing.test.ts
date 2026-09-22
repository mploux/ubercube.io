import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { InputButton } from '../src/client/input-button';
import { RemotePlayers } from '../src/client/remote-players';
import type { InputFrame, PlayerState } from '../src/shared/protocol';

// Execute the production input loop without initializing its Three.js/WebGL scene.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const simulate = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'simulate')!;
const simulateCode = ts.transpileModule(simulate.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  class WebSocket {}
  const canvas = {};
  const remotePlayers = new RemotePlayers();
  const state = {
    remotePlayers, WebSocket, socket: new WebSocket() as object | null,
    screen: 'game', paused: false, cancelActions: false, touchMode: false,
    local: { alive: true }, localId: 1, predicted: { grounded: true }, world: {}, worldReady: true,
    canvas, document: { hidden: false, pointerLockElement: canvas, hasFocus: () => true },
    pending: [] as InputFrame[], unsent: [] as InputFrame[], sequence: 0, roundId: 4, revision: 12,
    yaw: .3, pitch: -.1, selectedWeapon: 'ak47', keys: new Set<string>(),
    touchControls: { moveX: 0, moveZ: 0, jump: false, sneak: false, sprint: false },
    fireButton: new InputButton(), altButton: new InputButton(),
    weaponLookYaw: 0, weaponLookPitch: 0, weaponMouseDX: 0, weaponMouseDY: 0,
    weaponView: { tick: () => ({ fired: false, thrown: false }) },
    effects: { availableGrenades: () => 10 }, audio: { play: () => {} }, movePlayer: () => {},
    disconnect: () => { throw new Error('Unexpected disconnect'); },
  };
  return { state, simulate: runInNewContext(`${simulateCode}\nsimulate`, state) as () => void };
}

function snapshot(remote: RemotePlayers, tick: number, received: number) {
  const player: PlayerState = {
    id: 2, name: 'Target', team: 1, kit: 'assault', weapon: 'ak47', alive: true, aiming: false,
    health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
    position: { x: tick * .15, y: 1, z: 20 }, velocity: { x: 9, y: 0, z: 0 }, grounded: true, yaw: 0, pitch: 0,
  };
  remote.snapshot(tick, [player], received);
}

test('inputs retain the displayed image timestamp through newer snapshots and catch-up simulation steps', () => {
  const { state, simulate } = fixture();
  snapshot(state.remotePlayers, 0, 1000);
  snapshot(state.remotePlayers, 3, 1050);
  const displayed = state.remotePlayers.sample(1075)[0];
  expect(displayed.position.x).toBeCloseTo(.225);
  snapshot(state.remotePlayers, 6, 1100);
  state.fireButton.set(true);
  simulate(); simulate();
  expect(state.unsent).toHaveLength(2);
  for (const input of state.unsent) {
    expect(input.viewTick).toBeCloseTo(1.5);
    expect(input.viewLatestTick).toBe(3);
    expect(input.worldRevision).toBe(12);
    expect(input.fire).toBe(true);
  }
  expect(state.pending).toEqual(state.unsent);
  expect(state.remotePlayers.viewTick).toBeCloseTo(1.5);
  expect(state.remotePlayers.viewLatestTick).toBe(3);
  state.remotePlayers.sample(1125);
  state.revision = 13;
  simulate();
  expect(state.unsent[2].viewTick).toBeCloseTo(4.5);
  expect(state.unsent[2].viewLatestTick).toBe(6);
  expect(state.unsent[2].worldRevision).toBe(13);
});

test('inputs omit all view metadata before the first displayed snapshot and after a reset', () => {
  const { state, simulate } = fixture();
  simulate();
  snapshot(state.remotePlayers, 30, 1000);
  simulate();
  state.remotePlayers.sample(1000);
  simulate();
  expect(state.unsent[2].viewTick).toBe(30);
  expect(state.unsent[2].viewLatestTick).toBe(30);
  state.remotePlayers.clear();
  state.roundId++;
  state.revision = 0;
  simulate();
  for (const index of [0, 1, 3]) {
    expect(state.unsent[index]).not.toHaveProperty('viewTick');
    expect(state.unsent[index]).not.toHaveProperty('viewLatestTick');
    expect(state.unsent[index]).not.toHaveProperty('worldRevision');
  }
});

test('solo inputs retain the uncompensated shared simulation contract', () => {
  const { state, simulate } = fixture();
  state.socket = {};
  snapshot(state.remotePlayers, 30, 1000);
  state.remotePlayers.sample(1000);
  state.fireButton.set(true);
  simulate();
  expect(state.unsent[0].fire).toBe(true);
  expect(state.unsent[0]).not.toHaveProperty('viewTick');
  expect(state.unsent[0]).not.toHaveProperty('viewLatestTick');
  expect(state.unsent[0]).not.toHaveProperty('worldRevision');
});
