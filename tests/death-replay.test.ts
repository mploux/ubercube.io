import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { DeathReplay, DEATH_REPLAY_SECONDS } from '../src/client/death-replay';
import { GrenadeVisuals } from '../src/client/grenade-visuals';
import { RocketVisuals } from '../src/client/rocket-visuals';
import { createParticleMaterial } from '../src/client/particle-material';
import type { GameEvent, PlayerState, ProjectileState, ServerMessage } from '../src/shared/protocol';

const player = (id: number, x = 0, changes: Partial<PlayerState> = {}): PlayerState => ({
  id, name: `Player ${id}`, team: 1, kit: 'assault', weapon: 'ak47', alive: true, aiming: false,
  health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
  position: { x, y: 0, z: 0 }, velocity: { x: 2, y: 0, z: 0 }, grounded: true, yaw: 0, pitch: 0, ...changes,
});
const snapshot = (tick: number, players: PlayerState[], projectiles: ProjectileState[] = [], roundId = 1): Extract<ServerMessage, { type: 'snapshot' }> => ({
  type: 'snapshot', roundId, tick, players, projectiles, scores: [0, 0], remaining: null,
});
const death = (tick = 180, changes: Partial<GameEvent> = {}): GameEvent => ({
  type: 'event', roundId: 1, tick, event: 'death', shooterId: 2, targetId: 1, weapon: 'ak47', position: { x: 4, y: 0, z: 0 },
  death: { player: player(1, 4, { alive: false, health: 0, deaths: 1 }), hitPoint: { x: 4, y: 1, z: 0 }, impulse: { x: 1, y: 0, z: 0 } }, ...changes,
});
const shot = (tick: number, changes: Partial<GameEvent> = {}): GameEvent => ({
  type: 'event', roundId: 1, tick, event: 'shot', shooterId: 2, weapon: 'ak47', projectileId: tick,
  position: { x: 0, y: 1, z: 0 }, endPosition: { x: 4, y: 1, z: 0 }, ...changes,
});
function recordHistory(replay: DeathReplay): void {
  for (let tick = 0; tick < 180; tick += 3) replay.recordSnapshot(snapshot(tick, [player(1, tick / 45), player(2, tick / 30)]));
}

test('replays server time at normal speed, includes the fatal shot once, and holds death for the final 300 ms', () => {
  const replay = new DeathReplay();
  recordHistory(replay);
  replay.recordEvent(shot(90));
  replay.recordEvent(shot(180));
  const fatal = death();
  replay.recordEvent(fatal);
  expect(replay.start(fatal, 1)).toBe(true);
  expect(replay.sample(0)!.tick).toBe(18);
  const middle = replay.sample(1.2)!;
  expect(middle.tick).toBe(90);
  expect(middle.killer.position.x).toBe(3);
  expect(middle.events.map(event => event.event)).toEqual(['shot']);
  expect(replay.sample(1.2)!.events).toEqual([]);
  expect(replay.sample(2.699)!.players.find(player => player.id === 1)!.alive).toBe(true);
  const last = replay.sample(2.7)!;
  expect(last.events.map(event => event.event)).toEqual(['shot', 'death']);
  expect(last.players.find(player => player.id === 1)).toMatchObject({ alive: false, health: 0, deaths: 1 });
  expect(replay.sample(2.99)!.events).toEqual([]);
  expect(replay.sample(DEATH_REPLAY_SECONDS)).toBeNull();
});

test('interpolates shortest yaw, position and velocity without borrowing future discrete state', () => {
  const replay = new DeathReplay();
  replay.recordSnapshot(snapshot(18, [player(1), player(2, 0, { yaw: Math.PI - .2, pitch: -.4 })]));
  replay.recordSnapshot(snapshot(24, [player(1), player(2, 4, { yaw: -Math.PI + .2, pitch: .4, aiming: true, weapon: 'awp', velocity: { x: 0, y: 2, z: 0 } })]));
  expect(replay.start(death(), 1)).toBe(true);
  const frame = replay.sample(.05)!;
  expect(frame.killer.position.x).toBe(2);
  expect(frame.killer.velocity).toEqual({ x: 1, y: 1, z: 0 });
  expect(frame.killer.yaw).toBeCloseTo(Math.PI);
  expect(frame.killer.pitch).toBeCloseTo(0);
  expect(frame.killer.weapon).toBe('ak47');
  expect(frame.killer.aiming).toBe(false);
  expect(replay.sample(.1)!.killer.weapon).toBe('awp');
});

test('captures incoming data and freezes playback independently of later snapshots, events and output mutations', () => {
  const replay = new DeathReplay();
  const source = snapshot(18, [player(1), player(2, 2)]);
  const event = shot(24);
  replay.recordSnapshot(source);
  replay.recordEvent(event);
  source.players[1].position.x = 100;
  event.position.x = 100;
  const fatal = death();
  fatal.death!.killer = player(2, 4);
  expect(replay.start(fatal, 1)).toBe(true);
  fatal.death!.killer.position.x = 100;
  const first = replay.sample(0)!;
  expect(first.killer.position.x).toBe(2);
  first.killer.position.x = 100;
  for (let tick = 181; tick < 500; tick++) replay.recordSnapshot(snapshot(tick, [player(1, 100, { deaths: 1 }), player(2, 100)]));
  replay.recordEvent(shot(180, { projectileId: 999 }));
  expect(replay.sample(0)!.killer.position.x).toBe(2);
  const late = replay.sample(2.7)!;
  expect(late.killer.position.x).toBe(4);
  expect(late.events.find(event => event.projectileId === 24)!.position.x).toBe(0);
  expect(late.events.some(event => event.projectileId === 999)).toBe(false);
});

test('pads short history with its first pose and accepts the exact killer pose without a prior snapshot', () => {
  const replay = new DeathReplay();
  const fatal = death();
  fatal.death!.killer = player(2, 9, { yaw: .7, pitch: -.2, weapon: 'awp' });
  expect(replay.start(fatal, 1)).toBe(true);
  const early = replay.sample(0)!;
  expect(early.killer.position.x).toBe(9);
  expect(early.players.find(player => player.id === 1)!.alive).toBe(true);
  replay.recordSnapshot(snapshot(183, [player(1, 100), player(2, 100)]));
  expect(replay.sample(2.7)!.killer).toEqual(fatal.death!.killer);
  replay.clear();
  replay.recordSnapshot(snapshot(180, [player(1), player(2, 7)]));
  expect(replay.start(death(), 1)).toBe(true);
  expect(replay.sample(0)!.killer.position.x).toBe(7);
});

test('uses a disconnected or dead shooter history for projectiles but skips missing, self and world killers', () => {
  const replay = new DeathReplay();
  replay.recordSnapshot(snapshot(18, [player(1), player(2, 2)]));
  replay.recordSnapshot(snapshot(90, [player(1), player(2, 2, { alive: false, deaths: 1 })]));
  replay.recordSnapshot(snapshot(120, [player(1)]));
  expect(replay.start(death(180, { weapon: 'grenade' }), 1)).toBe(true);
  expect(replay.sample(2)!.killer.position.x).toBe(2);
  expect(replay.start(death(180, { shooterId: 1 }), 1)).toBe(false);
  expect(replay.sample(0)).toBeNull();
  expect(replay.start(death(180, { shooterId: undefined }), 1)).toBe(false);
  expect(replay.start(death(180, { shooterId: 999 }), 1)).toBe(false);
  expect(replay.start(death(), 999)).toBe(false);
});

test('does not interpolate between lives or across teleports and applies death before the next snapshot', () => {
  const replay = new DeathReplay();
  replay.recordSnapshot(snapshot(18, [player(1), player(2), player(3, 2)]));
  replay.recordSnapshot(snapshot(24, [player(1), player(2, 50), player(3, 6, { deaths: 1 })]));
  const remoteDeath = death(20, { targetId: 3 });
  remoteDeath.death!.player = player(3, 2, { alive: false, health: 0, deaths: 1 });
  replay.recordEvent(remoteDeath);
  expect(replay.start(death(), 1)).toBe(true);
  const frame = replay.sample(.05)!;
  expect(frame.killer.position.x).toBe(0);
  expect(frame.players.find(player => player.id === 3)).toMatchObject({ alive: false, deaths: 1, position: { x: 2 } });
  expect(replay.sample(.1)!.players.find(player => player.id === 3)).toMatchObject({ alive: true, deaths: 1, position: { x: 6 } });
});

test('interpolates projectiles and removes them at the recorded end event', () => {
  const replay = new DeathReplay();
  const projectile: ProjectileState = { id: 7, owner: 2, weapon: 'rpg', position: { x: 0, y: 1, z: 0 }, velocity: { x: 60, y: 0, z: 0 } };
  replay.recordSnapshot(snapshot(18, [player(1), player(2)], [projectile]));
  replay.recordSnapshot(snapshot(24, [player(1), player(2)], [{ ...projectile, position: { x: 6, y: 1, z: 0 } }]));
  replay.recordEvent(shot(25, { event: 'projectile-end', projectileId: 7 }));
  expect(replay.start(death(), 1)).toBe(true);
  expect(replay.sample(.05)!.projectiles[0].position.x).toBe(3);
  expect(replay.sample(.12)!.projectiles).toEqual([]);
});

test('keeps fatal same-tick impacts and explosions received after death, with RPG removal on impact', () => {
  const replay = new DeathReplay();
  const projectile: ProjectileState = { id: 7, owner: 2, weapon: 'rpg', position: { x: 0, y: 1, z: 0 }, velocity: { x: 60, y: 0, z: 0 } };
  replay.recordSnapshot(snapshot(177, [player(1), player(2)], [projectile]));
  replay.recordEvent(shot(180, { event: 'impact', weapon: 'rpg', projectileId: 7 }));
  expect(replay.start(death(), 1)).toBe(true);
  replay.recordEvent(shot(180, { event: 'explosion', weapon: 'rpg', projectileId: 7 }));
  replay.recordEvent(shot(181));
  const frame = replay.sample(2.7)!;
  expect(frame.events.map(event => event.event)).toEqual(['impact', 'death', 'explosion']);
  expect(frame.projectiles).toEqual([]);
  replay.clear();
  replay.recordSnapshot(snapshot(177, [player(1), player(2)], [projectile]));
  replay.recordEvent(shot(179, { event: 'impact', weapon: 'rpg', projectileId: 7 }));
  expect(replay.start(death(), 1)).toBe(true);
  expect(replay.sample(2.69)!.projectiles).toEqual([]);
  expect(replay.sample(2.7)!.projectiles).toEqual([]);
});

test.each(['rpg', 'grenade'] as const)('%s launched between snapshots stays visible through replay snapshots until its explosion', async weapon => {
  const scene = new THREE.Scene();
  const loader = async () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), createParticleMaterial(160));
    mesh.name = 'RPG_rocket'; group.add(mesh);
    return group;
  };
  const visuals = weapon === 'rpg' ? new RocketVisuals(scene, 160, 8, 64, loader) : new GrenadeVisuals(scene, 160, 8, loader);
  await visuals.ready;
  const mesh = scene.getObjectByName(weapon === 'rpg' ? 'UBERCUBE rockets' : 'UBERCUBE thrown grenades') as THREE.InstancedMesh;
  const replay = new DeathReplay();
  for (let tick = 177; tick <= 192; tick += 3) {
    const projectiles: ProjectileState[] = tick > 177 && tick < 190
      ? [{ id: 7, owner: 2, weapon, position: { x: tick - 177, y: 1, z: 0 }, velocity: { x: 60, y: 0, z: 0 } }] : [];
    replay.recordSnapshot(snapshot(tick, [player(1), player(2)], projectiles));
  }
  replay.recordEvent(shot(178, { projectileId: 7, weapon, velocity: { x: 60, y: 0, z: 0 } }));
  replay.recordEvent(shot(190, { event: 'explosion', projectileId: 7, weapon }));
  expect(replay.start(death(240), 1)).toBe(true);
  try {
    for (let tick = 177; tick <= 192; tick++) {
      const frame = replay.sample((tick - 78) / 60)!;
      const time = 100 + tick / 60;
      for (const event of frame.events) visuals.event(event, time);
      visuals.snapshot(frame.projectiles, Math.floor(frame.tick), time);
      if (visuals instanceof GrenadeVisuals) visuals.update(time, false);
      else visuals.update(time);
      expect(frame.projectiles.length).toBe(tick >= 178 && tick < 190 ? 1 : 0);
      if (tick >= 178 && tick < 190) expect(frame.projectiles[0].position.x).toBeCloseTo(tick - 177);
      if (tick >= 178 && tick < 190) {
        expect(mesh.count).toBe(1);
        const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix);
        expect(matrix.elements[12]).toBeCloseTo(tick - 177, 4);
      }
      if (tick >= 190) expect(mesh.count).toBe(0);
    }
  } finally { visuals.dispose(); }
});

test('missing projectile history extrapolates at most 50 ms and never invents hitscan bullets or revives older launches', () => {
  const replay = new DeathReplay();
  replay.recordSnapshot(snapshot(18, [player(1), player(2)]));
  const velocity = { x: 60, y: 0, z: 0 };
  replay.recordEvent(shot(17, { weapon: 'rpg', velocity }));
  replay.recordEvent(shot(20, { weapon: 'ak47', velocity }));
  replay.recordEvent(shot(20, { weapon: 'rpg', projectileId: 21 }));
  replay.recordEvent(shot(20, { weapon: 'rpg', velocity, projectileId: 22 }));
  expect(replay.start(death(), 1)).toBe(true);
  const first = replay.sample(4 / 60)!.projectiles;
  expect(first.map(projectile => projectile.id)).toEqual([22]);
  expect(first[0].position.x).toBe(3);
  expect(replay.sample(1)!.projectiles[0].position.x).toBe(3);
});

test('keeps exact fatal killer and victim even when the server exceeds the 100-player recording cap', () => {
  const replay = new DeathReplay();
  replay.recordSnapshot(snapshot(177, Array.from({ length: 1000 }, (_, index) => player(index + 1))));
  const fatal = death(180, { shooterId: 999, targetId: 1000 });
  fatal.death!.killer = player(999);
  fatal.death!.player = player(1000, 4, { alive: false, health: 0, deaths: 1 });
  expect(replay.start(fatal, 1000)).toBe(true);
  const frame = replay.sample(2.7)!;
  expect(frame.killer.id).toBe(999);
  expect(frame.players.find(player => player.id === 1000)!.alive).toBe(false);
  expect(frame.players.length).toBe(100);
});

test('bounds dense histories, players, projectiles and event bursts', () => {
  const replay = new DeathReplay();
  const players = Array.from({ length: 105 }, (_, index) => player(index + 1));
  const projectiles: ProjectileState[] = Array.from({ length: 520 }, (_, id) => ({ id, owner: 2, weapon: 'rpg', position: { x: 0, y: 1, z: 0 }, velocity: { x: 60, y: 0, z: 0 } }));
  for (let tick = 0; tick < 400; tick++) replay.recordSnapshot(snapshot(tick, players.map(player => ({ ...player, position: { ...player.position, x: tick } })), projectiles));
  for (let id = 0; id < 5000; id++) replay.recordEvent(shot(400, { projectileId: id }));
  expect(replay.start(death(400), 1)).toBe(true);
  const first = replay.sample(0)!;
  expect(first.killer.position.x).toBeGreaterThanOrEqual(300);
  expect(first.players.length).toBeLessThanOrEqual(100);
  expect(first.projectiles.length).toBeLessThanOrEqual(512);
  const last = replay.sample(2.7)!;
  expect(last.events.length).toBeLessThanOrEqual(4096);
  expect(last.events.at(-1)!.event).toBe('death');
});

test('resetPlayback keeps history while clear, round changes and old round traffic cannot leak a replay', () => {
  const replay = new DeathReplay();
  recordHistory(replay);
  expect(replay.start(death(), 1)).toBe(true);
  replay.resetPlayback();
  expect(replay.sample(0)).toBeNull();
  expect(replay.start(death(), 1)).toBe(true);
  replay.recordSnapshot(snapshot(0, [player(1), player(2, 99)], [], 2));
  expect(replay.sample(0)).toBeNull();
  replay.recordSnapshot(snapshot(180, [player(1), player(2)], [], 1));
  replay.recordEvent(shot(180));
  expect(replay.start(death(), 1)).toBe(false);
  expect(replay.start(death(0, { roundId: 2 }), 1)).toBe(true);
  expect(replay.sample(0)!.killer.position.x).toBe(99);
  replay.clear();
  expect(replay.start(death(), 1)).toBe(false);
});
