export interface AdmissionOptions {
  maxConnections: number;
  maxConnectionsPerIp: number;
  globalBurst: number;
  globalPerSecond: number;
  ipBurst: number;
  ipPerSecond: number;
  maxTrackedIps: number;
  idleTtlMs: number;
}

interface Bucket { tokens: number; updatedAt: number }
interface IpBudget extends Bucket { active: number; lastSeen: number }

const defaults: AdmissionOptions = {
  maxConnections: 200,
  maxConnectionsPerIp: 24,
  globalBurst: 200,
  globalPerSecond: 20,
  ipBurst: 24,
  ipPerSecond: 2,
  maxTrackedIps: 4096,
  idleTtlMs: 300_000,
};

function refill(bucket: Bucket, burst: number, perSecond: number, now: number) {
  bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.updatedAt) * perSecond / 1000);
  bucket.updatedAt = now;
}

export class AdmissionGuard {
  private readonly options: AdmissionOptions;
  private readonly ips = new Map<string, IpBudget>();
  private readonly global: Bucket;
  private active = 0;
  private accepted = 0;
  private rejected = 0;
  private readonly rejectedByReason = { invalidIp: 0, connections: 0, globalRate: 0, trackedIps: 0, ipConnections: 0, ipRate: 0 };
  private previousTime = -Infinity;
  private nextSweepAt = -Infinity;

  constructor(options: Partial<AdmissionOptions> = {}, private readonly now = () => performance.now()) {
    this.options = { ...defaults, ...options };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid admission option ${name}`);
    }
    this.global = { tokens: this.options.globalBurst, updatedAt: this.time() };
  }

  // The transport supplies a canonical IP from the peer or its explicitly trusted proxy.
  tryAcquire(ip: string): (() => void) | null {
    const now = this.time();
    this.prune(now);
    refill(this.global, this.options.globalBurst, this.options.globalPerSecond, now);
    if (!ip || ip.length > 64) return this.reject('invalidIp');
    if (this.active >= this.options.maxConnections) return this.reject('connections');
    if (this.global.tokens < 1) return this.reject('globalRate');
    let budget = this.ips.get(ip);
    if (!budget) {
      if (this.ips.size >= this.options.maxTrackedIps) return this.reject('trackedIps');
      budget = { active: 0, tokens: this.options.ipBurst, updatedAt: now, lastSeen: now };
      this.ips.set(ip, budget);
    }
    refill(budget, this.options.ipBurst, this.options.ipPerSecond, now);
    budget.lastSeen = now;
    if (budget.active >= this.options.maxConnectionsPerIp) return this.reject('ipConnections');
    if (budget.tokens < 1) return this.reject('ipRate');
    this.global.tokens--;
    budget.tokens--;
    budget.active++;
    this.active++;
    this.accepted++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      budget.active--;
      budget.lastSeen = this.time();
      this.active--;
    };
  }

  stats() {
    this.prune(this.time());
    return {
      activeConnections: this.active, trackedIps: this.ips.size, accepted: this.accepted, rejected: this.rejected,
      rejectedByReason: { ...this.rejectedByReason },
    };
  }

  private reject(reason: keyof typeof this.rejectedByReason): null {
    this.rejected++;
    this.rejectedByReason[reason]++;
    return null;
  }

  private time() {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('Invalid admission clock');
    this.previousTime = Math.max(this.previousTime, now);
    return this.previousTime;
  }

  private prune(now: number) {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + Math.min(1000, this.options.idleTtlMs);
    for (const [ip, budget] of this.ips) {
      // Expiry must not erase rate debt, including when the configured TTL is short.
      const replenished = budget.tokens + (now - budget.updatedAt) * this.options.ipPerSecond / 1000 >= this.options.ipBurst;
      if (budget.active === 0 && now - budget.lastSeen >= this.options.idleTtlMs && replenished) this.ips.delete(ip);
    }
  }
}
