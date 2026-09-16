import { expect, test } from 'bun:test';
import { RemotePlayers } from '../src/client/remote-players';
import type { RemotePlayerState } from '../src/shared/protocol';

const player = (sampleTick: number, x: number, changes: Partial<RemotePlayerState> = {}): RemotePlayerState => ({
  sampleTick, sampleInterval: 3,
  id: 1, name: 'Remote', team: 1, weapon: 'ak47', alive: true, aiming: false,
  kills: 0, deaths: 0, hasGrenades: true,
  position: { x, y: 0, z: 0 }, velocity: { x: 6, z: 0 }, yaw: 0, pitch: 0,
  ...changes,
});

test('steady 20 Hz snapshots need 50 ms of buffering, with smooth motion at 30, 60 and 144 Hz', () => {
  for (const fps of [30, 60, 144]) {
    const remote = new RemotePlayers();
    let tick = 0;
    for (let frame = 0; frame <= fps * 2; frame++) {
      const time = frame * 1000 / fps;
      while (tick * 1000 / 60 <= time + 1e-7) {
        remote.snapshot(tick, [player(tick, tick / 10)], 1000 + tick * 1000 / 60);
        tick += 3;
      }
      const rendered = remote.sample(1000 + time)[0];
      expect(rendered.position.x).toBeCloseTo(Math.max(0, time - 50) * .006, 5);
    }
  }
});

test('server ticks preserve uniform motion despite alternating packet spacing', () => {
  const remote = new RemotePlayers();
  let packet = 0;
  for (let time = 0; time <= 2500; time += 5) {
    while (packet * 50 + (packet % 2 ? 20 : 0) <= time) {
      remote.snapshot(packet * 3, [player(packet * 3, packet * .3)], 1000 + packet * 50 + (packet % 2 ? 20 : 0));
      packet++;
    }
    const rendered = remote.sample(1000 + time)[0];
    if (time >= 150) expect(rendered.position.x).toBeCloseTo((time - 70) * .006, 5);
  }
});

test('growing jitter never reverses playback and stalled packets never extrapolate beyond authority', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0, 0)], 1000);
  remote.snapshot(3, [player(3, .3)], 1050);
  const before = remote.sample(1075)[0].position.x;
  remote.snapshot(6, [player(6, .6)], 1130);
  expect(remote.sample(1130)[0].position.x).toBeGreaterThanOrEqual(before);
  expect(remote.sample(3000)[0].position.x).toBeCloseTo(.6);
  remote.snapshot(12, [player(12, 1.2)], 3010);
  expect(remote.sample(3010)[0].position.x).toBeGreaterThanOrEqual(.6);
  expect(remote.sample(4000)[0].position.x).toBeCloseTo(1.2);
});

test('temporary jitter leaves the delivery window instead of creating permanent extra latency', () => {
  const remote = new RemotePlayers();
  for (let packet = 0; packet <= 60; packet++) {
    remote.snapshot(packet * 3, [player(packet * 3, packet * .3)], 1000 + packet * 50 + (packet === 1 ? 40 : 0));
    remote.sample(1000 + packet * 50 + (packet === 1 ? 40 : 0));
  }
  expect(remote.sample(4000)[0].position.x).toBeCloseTo(17.7, 6);
});

test('position, horizontal velocity, yaw and pitch share a timestamp without future equipment or aiming state', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0, 0, { yaw: Math.PI - .2, pitch: -.4 })], 1000);
  remote.snapshot(3, [player(3, .3, { yaw: -Math.PI + .2, pitch: .4, hasGrenades: false, aiming: true, weapon: 'awp', velocity: { x: 0, z: 0 } })], 1050);
  const middle = remote.sample(1075)[0];
  expect(middle.position.x).toBeCloseTo(.15);
  expect(middle.velocity).toEqual({ x: 3, z: 0 });
  expect(middle.yaw).toBeCloseTo(Math.PI);
  expect(middle.pitch).toBeCloseTo(0);
  expect(middle.hasGrenades).toBe(true);
  expect(middle.aiming).toBe(false);
  expect(middle.weapon).toBe('ak47');
  const last = remote.sample(1100)[0];
  expect(last.hasGrenades).toBe(false);
  expect(last.aiming).toBe(true);
  expect(last.weapon).toBe('awp');
});

test('death and disconnect remove stale visible players immediately, even before playback catches up', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0, 0)], 1000);
  remote.snapshot(3, [player(3, .3, { alive: false, deaths: 1 })], 1050);
  expect(remote.sample(1050)[0].alive).toBe(false);
  remote.snapshot(6, [], 1100);
  expect(remote.sample(1100)).toEqual([]);
});

test('new arrivals and a respawn with a missed dead snapshot never blend with old lives', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [], 1000);
  remote.snapshot(3, [player(3, 10)], 1050);
  expect(remote.sample(1050)[0].position.x).toBe(10);
  remote.snapshot(6, [player(6, 2, { deaths: 1 })], 1100);
  expect(remote.sample(1100)[0].position.x).toBe(2);
  remote.snapshot(9, [player(9, 2.3, { deaths: 1 })], 1150);
  expect(remote.sample(1175)[0].position.x).toBeCloseTo(2.15);
});

test('teleports are detected in all three axes instead of interpolating through the terrain', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    const remote = new RemotePlayers();
    remote.snapshot(0, [player(0, 0)], 1000);
    const destination = { x: 0, y: 0, z: 0, [axis]: 40 };
    remote.snapshot(3, [player(3, 0, { position: destination })], 1050);
    expect(remote.sample(1050)[0].position).toEqual(destination);
  }
});

test('old snapshots cannot resurrect players, same-tick spawn snapshots update membership', () => {
  const remote = new RemotePlayers();
  remote.snapshot(3, [], 1000);
  remote.snapshot(3, [player(3, 2)], 1001);
  expect(remote.sample(1001)[0].position.x).toBe(2);
  remote.snapshot(6, [], 1050);
  remote.snapshot(3, [player(3, 2)], 1060);
  expect(remote.sample(1060)).toEqual([]);
});

test('clearing the world or connection discards its clock and history even if the next tick is lower', () => {
  const remote = new RemotePlayers();
  remote.snapshot(600, [player(600, 6)], 11000);
  remote.sample(11500);
  remote.clear();
  expect(remote.sample(11500)).toEqual([]);
  remote.snapshot(0, [player(0, 0)], 12000);
  remote.snapshot(3, [player(3, .3)], 12050);
  expect(remote.sample(12075)[0].position.x).toBeCloseTo(.15);
});

test('interpolation preserves retained decoder baselines and exposes only horizontal velocity', () => {
  const remote = new RemotePlayers();
  const previous = player(0, 0), next = player(3, .3, { velocity: { x: 0, z: 6 } });
  for (const state of [previous, next]) {
    Object.freeze(state.position); Object.freeze(state.velocity); Object.freeze(state);
  }
  remote.snapshot(0, [previous], 1000);
  remote.snapshot(3, [next], 1050);
  const rendered = remote.sample(1075)[0];
  expect(rendered.position.x).toBeCloseTo(.15);
  expect(rendered.velocity).toEqual({ x: 3, z: 3 });
  rendered.position.x = 50; rendered.velocity.x = 99;
  expect(previous.position.x).toBe(0);
  expect(previous.velocity.x).toBe(6);
  expect(next.position.x).toBe(.3);
  expect(next.velocity.x).toBe(0);
});

test('20, 10 and 5 Hz players each move smoothly with their own delay at every rendering rate', () => {
  for (const fps of [30, 60, 144]) {
    const remote = new RemotePlayers();
    let tick = 0;
    for (let frame = 0; frame <= fps * 3; frame++) {
      const time = frame * 1000 / fps;
      while (tick * 1000 / 60 <= time + 1e-7) {
        remote.snapshot(tick, ([3, 6, 12] as const).map(interval => {
          const sampled = Math.floor(tick / interval) * interval;
          return player(sampled, sampled / 10, { id: interval, sampleInterval: interval });
        }), 1000 + tick * 1000 / 60);
        tick += 3;
      }
      for (const rendered of remote.sample(1000 + time)) {
        expect(rendered.position.x).toBeCloseTo(Math.max(0, time - rendered.id * 1000 / 60) * .006, 5);
      }
    }
  }
});

test('retained player ticks are not new motion samples and cannot inflate the common jitter buffer', () => {
  const remote = new RemotePlayers();
  for (let tick = 0; tick <= 24; tick += 3) {
    const sampled = Math.floor(tick / 12) * 12;
    remote.snapshot(tick, [player(tick, tick / 10), player(sampled, sampled / 10, { id: 2, sampleInterval: 12 })], 1000 + tick * 1000 / 60);
    remote.sample(1000 + tick * 1000 / 60);
  }
  const rendered = remote.sample(1425);
  expect(rendered[0].position.x).toBeCloseTo(2.25);
  expect(rendered[1].position.x).toBeCloseTo(1.35);
});

test('a 5 to 20 Hz promotion catches up within 150 ms without rewinding or a single-frame position jump', () => {
  const remote = new RemotePlayers();
  let tick = 0, previous = 0;
  for (let time = 0; time <= 1000; time += 5) {
    while (tick * 1000 / 60 <= time + 1e-7) {
      const interval = tick < 36 ? 12 : 3;
      const sampled = Math.floor(tick / interval) * interval;
      remote.snapshot(tick, [player(sampled, sampled / 10, { sampleInterval: interval }), player(tick, tick / 10, { id: 2 })], 1000 + tick * 1000 / 60);
      tick += 3;
    }
    const [promoted, priority] = remote.sample(1000 + time);
    expect(promoted.position.x).toBeGreaterThanOrEqual(previous - 1e-8);
    expect(promoted.position.x - previous).toBeLessThanOrEqual(.06000001);
    expect(priority.position.x).toBeCloseTo(Math.max(0, time - 50) * .006, 5);
    if (time >= 750) expect(promoted.position.x).toBeCloseTo((time - 50) * .006, 5);
    previous = promoted.position.x;
  }
});

test('sparse motion stops at authority and resumes smoothly after a transport stall', () => {
  const remote = new RemotePlayers();
  for (let tick = 0; tick <= 24; tick += 3) {
    const sampled = Math.floor(tick / 12) * 12;
    remote.snapshot(tick, [player(sampled, sampled / 10, { sampleInterval: 12, velocity: { x: sampled === 24 ? 0 : 6, z: 0 } })], 1000 + tick * 1000 / 60);
    remote.sample(1000 + tick * 1000 / 60);
  }
  expect(remote.sample(2500)[0].position.x).toBeCloseTo(2.4);
  expect(remote.sample(2500)[0].velocity.x).toBe(0);
  remote.snapshot(90, [player(84, 3.6, { sampleInterval: 12 })], 2500);
  let previous = remote.sample(2500)[0].position.x;
  for (let time = 2505; time <= 3500; time += 5) {
    const rendered = remote.sample(time)[0];
    expect(rendered.position.x).toBeGreaterThanOrEqual(previous - 1e-8);
    expect(rendered.position.x).toBeLessThanOrEqual(3.6);
    previous = rendered.position.x;
  }
  expect(previous).toBeCloseTo(3.6);
});

test('sparse histories discard old lives, teleports, departures and a reset immediately', () => {
  const remote = new RemotePlayers();
  remote.snapshot(0, [player(0, 0, { sampleInterval: 12 })], 1000);
  remote.snapshot(12, [player(12, 1.2, { sampleInterval: 12 })], 1200);
  expect(remote.sample(1200)[0].position.x).toBe(0);
  remote.snapshot(15, [player(15, 1.4, { sampleInterval: 12, alive: false, deaths: 1 })], 1250);
  expect(remote.sample(1250)[0].alive).toBe(false);
  expect(remote.sample(1250)[0].position.x).toBe(1.4);
  remote.snapshot(18, [player(18, 8, { sampleInterval: 12, deaths: 1 })], 1300);
  expect(remote.sample(1300)[0].position.x).toBe(8);
  remote.snapshot(21, [player(21, 48, { sampleInterval: 12, deaths: 1 })], 1350);
  expect(remote.sample(1350)[0].position.x).toBe(48);
  remote.snapshot(24, [], 1400);
  remote.snapshot(21, [player(21, 48, { sampleInterval: 12, deaths: 1 })], 1450);
  expect(remote.sample(1450)).toEqual([]);
  remote.clear();
  remote.snapshot(0, [player(0, 0, { sampleInterval: 12 })], 1500);
  expect(remote.sample(1500)[0].position.x).toBe(0);
});

test('same-tick roster updates stay immediate while stale player samples cannot rewind retained history', () => {
  const remote = new RemotePlayers();
  const initial = player(12, 1.2, { sampleInterval: 12 });
  Object.freeze(initial.position); Object.freeze(initial.velocity); Object.freeze(initial);
  remote.snapshot(12, [initial], 1200);
  remote.snapshot(15, [{ ...initial, name: 'Renamed', team: 2 }], 1250);
  const renamed = remote.sample(1250)[0];
  expect(renamed.name).toBe('Renamed');
  expect(renamed.team).toBe(2);
  expect(renamed.sampleTick).toBe(12);
  renamed.position.x = 100; renamed.velocity.x = 100;
  remote.snapshot(18, [player(6, .6)], 1300);
  const retained = remote.sample(1300)[0];
  expect(retained.position.x).toBe(1.2);
  expect(retained.velocity.x).toBe(6);
  expect(retained.name).toBe('Renamed');
  expect(initial.position.x).toBe(1.2);
});

test('20 to 5 to 20 Hz changes with jitter stay bounded, catch up and stop without extrapolation', () => {
  const remote = new RemotePlayers();
  let packet = 0, previous = 0, retained = player(0, 0);
  for (let time = 0; time <= 2800; time += 5) {
    while (packet * 50 + [0, 15, 5, 25][packet % 4] <= time) {
      const tick = packet * 3, interval = tick >= 36 && tick < 96 ? 12 : 3;
      if (tick % interval === 0) retained = player(tick, Math.min(tick / 10, 12), {
        sampleInterval: interval, velocity: { x: tick < 120 ? 6 : 0, z: 0 },
      });
      remote.snapshot(tick, [retained, player(tick, Math.min(tick / 10, 12), { id: 2 })], 1000 + packet * 50 + [0, 15, 5, 25][packet % 4]);
      packet++;
    }
    const [changing, priority] = remote.sample(1000 + time);
    expect(changing.position.x).toBeGreaterThanOrEqual(previous - 1e-8);
    expect(changing.position.x - previous).toBeLessThanOrEqual(.06000001);
    expect(changing.position.x).toBeLessThanOrEqual(retained.position.x);
    if (time >= 900 && time <= 1400) expect(changing.position.x).toBeCloseTo((time - 225) * .006, 5);
    if (time >= 1800 && time <= 2000) expect(changing.position.x).toBeCloseTo((time - 75) * .006, 5);
    if (time >= 300 && time <= 2000) expect(priority.position.x).toBeCloseTo((time - 75) * .006, 5);
    if (time >= 2300) expect(changing.position.x).toBe(12);
    previous = changing.position.x;
  }
  expect(remote.sample(5000)[0].position.x).toBe(12);
  expect(remote.sample(5000)[0].velocity.x).toBe(0);
});
