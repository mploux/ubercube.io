import { describe, expect, test } from 'bun:test';
import { AdmissionGuard, type AdmissionOptions } from '../src/server/admission.ts';

function fixture(options: Partial<AdmissionOptions> = {}) {
  let now = 0;
  const guard = new AdmissionGuard(options, () => now);
  return { guard, at: (milliseconds: number) => { now = milliseconds; } };
}

describe('WebSocket admission budgets', () => {
  test('admits 100 players sharing a NAT when explicitly configured and releases leases only once', () => {
    const { guard } = fixture({ maxConnectionsPerIp: 100, ipBurst: 100 });
    const releases = Array.from({ length: 100 }, () => guard.tryAcquire('203.0.113.1'));
    expect(releases.every(release => release !== null)).toBe(true);
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    expect(guard.tryAcquire('203.0.113.2')).not.toBeNull();
    for (const release of releases) { release!(); release!(); }
    expect(guard.stats()).toMatchObject({ activeConnections: 1, trackedIps: 2, accepted: 101, rejected: 1,
      rejectedByReason: { ipConnections: 1 } });
  });

  test('defaults prevent one IP from occupying every slot, including loopback', () => {
    for (const ip of ['127.0.0.1', '::1', '203.0.113.1']) {
      const { guard } = fixture();
      for (let index = 0; index < 24; index++) expect(guard.tryAcquire(ip)).not.toBeNull();
      expect(guard.tryAcquire(ip)).toBeNull();
      expect(guard.tryAcquire('203.0.113.2')).not.toBeNull();
      expect(guard.stats().rejectedByReason.ipConnections).toBe(1);
    }
  });

  test('bounds simultaneous connections globally and separately per IP', () => {
    const { guard } = fixture({ maxConnections: 3, maxConnectionsPerIp: 2 });
    const first = guard.tryAcquire('203.0.113.1')!;
    expect(guard.tryAcquire('203.0.113.1')).not.toBeNull();
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    expect(guard.tryAcquire('203.0.113.2')).not.toBeNull();
    expect(guard.tryAcquire('203.0.113.3')).toBeNull();
    first(); first();
    expect(guard.tryAcquire('203.0.113.3')).not.toBeNull();
    expect(guard.stats().activeConnections).toBe(3);
  });

  test('closing a connection does not refund the IP reconnect budget', () => {
    const { guard, at } = fixture({ ipBurst: 2, ipPerSecond: 2 });
    guard.tryAcquire('203.0.113.1')!();
    guard.tryAcquire('203.0.113.1')!();
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    at(499);
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    at(500);
    expect(guard.tryAcquire('203.0.113.1')).not.toBeNull();
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    expect(guard.tryAcquire('203.0.113.2')).not.toBeNull();
  });

  test('rotating IPs does not bypass the global opening rate', () => {
    const { guard, at } = fixture({ globalBurst: 2, globalPerSecond: 1 });
    guard.tryAcquire('203.0.113.1')!();
    guard.tryAcquire('203.0.113.2')!();
    for (let index = 3; index < 1000; index++) expect(guard.tryAcquire(`2001:db8::${index.toString(16)}`)).toBeNull();
    expect(guard.stats().trackedIps).toBe(2);
    at(999);
    expect(guard.tryAcquire('203.0.113.3')).toBeNull();
    at(1000);
    expect(guard.tryAcquire('203.0.113.3')).not.toBeNull();
  });

  test('an exhausted IP does not consume the remaining global opening budget', () => {
    const { guard } = fixture({ ipBurst: 1, globalBurst: 2 });
    guard.tryAcquire('203.0.113.1')!();
    for (let index = 0; index < 100; index++) expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    expect(guard.tryAcquire('203.0.113.2')).not.toBeNull();
  });

  test('a full tracking map rejects new IPs but preserves established budgets', () => {
    const { guard, at } = fixture({ maxTrackedIps: 2, idleTtlMs: 1000 });
    const first = guard.tryAcquire('203.0.113.1')!;
    guard.tryAcquire('2001:db8::2')!();
    expect(guard.tryAcquire('203.0.113.3')).toBeNull();
    expect(guard.tryAcquire('203.0.113.1')).not.toBeNull();
    at(1000);
    expect(guard.tryAcquire('203.0.113.3')).not.toBeNull();
    expect(guard.stats().trackedIps).toBe(2);
    first(); first();
    expect(guard.stats().activeConnections).toBe(2);
  });

  test('active leases cannot expire and idle tracking expires after release', () => {
    const { guard, at } = fixture({ idleTtlMs: 1000 });
    const release = guard.tryAcquire('203.0.113.1')!;
    at(500_000);
    expect(guard.stats().trackedIps).toBe(1);
    release();
    at(500_999);
    expect(guard.stats().trackedIps).toBe(1);
    at(501_000);
    expect(guard.stats()).toMatchObject({ activeConnections: 0, trackedIps: 0, accepted: 1, rejected: 0 });
    release();
    expect(guard.stats().activeConnections).toBe(0);
  });

  test('short idle expiry cannot reset exhausted rate budgets', () => {
    const { guard, at } = fixture({ ipBurst: 2, ipPerSecond: 1, idleTtlMs: 100 });
    guard.tryAcquire('203.0.113.1')!();
    guard.tryAcquire('203.0.113.1')!();
    at(100);
    expect(guard.stats().trackedIps).toBe(1);
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    at(2000);
    expect(guard.stats().trackedIps).toBe(0);
    expect(guard.tryAcquire('203.0.113.1')).not.toBeNull();
    expect(guard.tryAcquire('203.0.113.1')).not.toBeNull();
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
  });

  test('clock rollback does not create refill time or erase the rate debt', () => {
    const { guard, at } = fixture({ ipBurst: 1, ipPerSecond: 1 });
    at(10_000);
    guard.tryAcquire('203.0.113.1')!();
    at(9000);
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    at(10_000);
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    at(10_999);
    expect(guard.tryAcquire('203.0.113.1')).toBeNull();
    at(11_000);
    expect(guard.tryAcquire('203.0.113.1')).not.toBeNull();
  });

  test('a long idle period refills only the configured burst', () => {
    const { guard, at } = fixture({ globalBurst: 2, globalPerSecond: 1 });
    at(1_000_000_000);
    guard.tryAcquire('203.0.113.1')!();
    guard.tryAcquire('203.0.113.2')!();
    expect(guard.tryAcquire('203.0.113.3')).toBeNull();
  });

  test('refuses empty or oversized keys without retaining them', () => {
    const { guard } = fixture();
    expect(guard.tryAcquire('')).toBeNull();
    expect(guard.tryAcquire('a'.repeat(65))).toBeNull();
    expect(guard.stats().trackedIps).toBe(0);
  });

  test.each([0, -1, NaN, Infinity, 1.5])('rejects invalid resource budgets: %s', value => {
    expect(() => new AdmissionGuard({ maxConnections: value })).toThrow();
    expect(() => new AdmissionGuard({ ipPerSecond: value })).toThrow();
    expect(() => new AdmissionGuard({ idleTtlMs: value })).toThrow();
  });
});
