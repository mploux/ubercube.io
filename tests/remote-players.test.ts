import { expect, test } from 'bun:test';
import { RemotePlayers } from '../src/client/remote-players';
import type { PlayerState } from '../src/shared/protocol';

const player = (x: number, changes: Partial<PlayerState> = {}): PlayerState => ({
  id: 1, name: 'Remote', team: 1, kit: 'assault', weapon: 'ak47', alive: true, aiming: false,
  health: 100, kills: 0, deaths: 0, ammo: 30, grenades: 10, lastSeq: 0,
  position: { x, y: 0, z: 0 }, velocity: { x: 6, y: 0, z: 0 }, grounded: true, yaw: 0, pitch: 0,
  ...changes,
});

test('steady 20 Hz snapshots need 50 ms of buffering, with smooth motion at 30, 60 and 144 Hz', () => {
  for (const fps of [30, 60, 144]) {
    const remote = new RemotePlayers();
    let tick = 0;
    for (let frame = 0; frame <= fps * 2; frame++) {
      const time = frame * 1000 / fps;
      while (tick * 1000 / 60 <= time + 1e-7) {
        remote.snapshot(tick, [player(tick / 10)], 1000 + tick * 1000 / 60);
        tick += 3;
      }
      const rendered = remote.sample(1000 + time)[0];
      expect(rendered.position.x).toBeCloseTo(Math.max(0, time - 50) * .006, 5);
      expect(remote.viewTick).toBeCloseTo(Math.max(0, time - 50) * .06, 5);
      expect(remote.viewLatestTick).toBe(tick - 3);
    }
  }
});

test('server ticks preserve uniform motion despite alternating packet spacing', () => {
  const remote = new RemotePlayers();
  let packet = 0;
  for (let time = 0; time <= 2500; time += 5) {
    while (packet * 50 + (packet % 2 ? 20 : 0) <= time) {
      remote.snapshot(packet * 3, [player(packet * .3)], 1000 + packet * 50 + (packet % 2 ? 20 : 0));
      packet++;
    }
    const rendered = remote.sample(1000 + time)[0];
    if (time >= 150) expect(rendered.position.x).toBeCloseTo((time - 70) * .006, 5);
  }
});

test('growing jitter never reverses playback and stalled packets never extrapolate beyond authority', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0)], 1000);
  remote.snapshot(3, [player(.3)], 1050);
  const before = remote.sample(1075)[0].position.x;
  remote.snapshot(6, [player(.6)], 1130);
  expect(remote.sample(1130)[0].position.x).toBeGreaterThanOrEqual(before);
  expect(remote.sample(3000)[0].position.x).toBeCloseTo(.6);
  expect(remote.viewTick).toBe(6);
  expect(remote.viewLatestTick).toBe(6);
  remote.snapshot(12, [player(1.2)], 3010);
  expect(remote.sample(3010)[0].position.x).toBeGreaterThanOrEqual(.6);
  expect(remote.sample(4000)[0].position.x).toBeCloseTo(1.2);
});

test('temporary jitter leaves the delivery window instead of creating permanent extra latency', () => {
  const remote = new RemotePlayers();
  for (let packet = 0; packet <= 60; packet++) {
    remote.snapshot(packet * 3, [player(packet * .3)], 1000 + packet * 50 + (packet === 1 ? 40 : 0));
    remote.sample(1000 + packet * 50 + (packet === 1 ? 40 : 0));
  }
  expect(remote.sample(4000)[0].position.x).toBeCloseTo(17.7, 6);
});

test('position, velocity, shortest yaw and pitch share a timestamp, without future weapon, aiming or grounded state', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0, { yaw: Math.PI - .2, pitch: -.4 })], 1000);
  remote.snapshot(3, [player(.3, { yaw: -Math.PI + .2, pitch: .4, grounded: false, aiming: true, weapon: 'awp', velocity: { x: 0, y: 12, z: 0 } })], 1050);
  const middle = remote.sample(1075)[0];
  expect(middle.position.x).toBeCloseTo(.15);
  expect(middle.velocity).toEqual({ x: 3, y: 6, z: 0 });
  expect(middle.yaw).toBeCloseTo(Math.PI);
  expect(middle.pitch).toBeCloseTo(0);
  expect(middle.grounded).toBe(true);
  expect(middle.aiming).toBe(false);
  expect(middle.weapon).toBe('ak47');
  const last = remote.sample(1100)[0];
  expect(last.grounded).toBe(false);
  expect(last.aiming).toBe(true);
  expect(last.weapon).toBe('awp');
});

test('death and disconnect remove stale visible players immediately, even before playback catches up', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0)], 1000);
  remote.snapshot(3, [player(.3, { alive: false, deaths: 1 })], 1050);
  expect(remote.sample(1050)[0].alive).toBe(false);
  remote.snapshot(6, [], 1100);
  expect(remote.sample(1100)).toEqual([]);
});

test('new arrivals and a respawn with a missed dead snapshot never blend with old lives', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [], 1000);
  remote.snapshot(3, [player(10)], 1050);
  expect(remote.sample(1050)[0].position.x).toBe(10);
  remote.snapshot(6, [player(2, { deaths: 1 })], 1100);
  expect(remote.sample(1100)[0].position.x).toBe(2);
  remote.snapshot(9, [player(2.3, { deaths: 1 })], 1150);
  expect(remote.sample(1175)[0].position.x).toBeCloseTo(2.15);
});

test('teleports are detected in all three axes instead of interpolating through the terrain', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    const remote = new RemotePlayers();
    remote.snapshot(0, [player(0)], 1000);
    const destination = { x: 0, y: 0, z: 0, [axis]: 40 };
    remote.snapshot(3, [player(0, { position: destination })], 1050);
    expect(remote.sample(1050)[0].position).toEqual(destination);
  }
});

test('old snapshots cannot resurrect players, same-tick spawn snapshots update membership', () => {
  const remote = new RemotePlayers();
  remote.snapshot(3, [], 1000);
  remote.snapshot(3, [player(2)], 1001);
  expect(remote.sample(1001)[0].position.x).toBe(2);
  remote.snapshot(6, [], 1050);
  remote.snapshot(3, [player(2)], 1060);
  expect(remote.sample(1060)).toEqual([]);
});

test('clearing the world or connection discards its clock and history even if the next tick is lower', () => {
  const remote = new RemotePlayers();
  remote.snapshot(600, [player(6)], 11000);
  remote.sample(11500);
  expect(remote.viewTick).toBe(600);
  expect(remote.viewLatestTick).toBe(600);
  remote.clear();
  expect(remote.viewTick).toBeUndefined();
  expect(remote.viewLatestTick).toBeUndefined();
  expect(remote.sample(11500)).toEqual([]);
  remote.snapshot(0, [player(0)], 12000);
  remote.snapshot(3, [player(.3)], 12050);
  expect(remote.viewTick).toBeUndefined();
  expect(remote.viewLatestTick).toBeUndefined();
  expect(remote.sample(12075)[0].position.x).toBeCloseTo(.15);
  expect(remote.viewTick).toBeCloseTo(1.5);
  expect(remote.viewLatestTick).toBe(3);
});

test('the visible tick and latest snapshot change only when sampling a finite render time, never on packet arrival', () => {
  const remote = new RemotePlayers();
  expect(remote.viewTick).toBeUndefined();
  expect(remote.viewLatestTick).toBeUndefined();
  remote.snapshot(0, [player(0)], 1000);
  remote.snapshot(3, [player(.3)], 1050);
  expect(remote.viewTick).toBeUndefined();
  expect(remote.viewLatestTick).toBeUndefined();
  expect(remote.sample(NaN)).toEqual([]);
  expect(remote.viewTick).toBeUndefined();
  expect(remote.viewLatestTick).toBeUndefined();
  remote.sample(1075);
  expect(remote.viewTick).toBeCloseTo(1.5);
  expect(remote.viewLatestTick).toBe(3);
  remote.snapshot(6, [player(.6)], 1100);
  expect(remote.viewTick).toBeCloseTo(1.5);
  expect(remote.viewLatestTick).toBe(3);
  expect(remote.sample(Infinity)).toEqual([]);
  expect(remote.viewTick).toBeCloseTo(1.5);
  expect(remote.viewLatestTick).toBe(3);
  remote.sample(1125);
  expect(remote.viewTick).toBeCloseTo(4.5);
  expect(remote.viewLatestTick).toBe(6);
});
