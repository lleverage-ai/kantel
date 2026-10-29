// Copied from tvdavies/brwsr@0d22bf8 (container/agent/live-adapt.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Adaptive picture for the live view (protocol v2, see liveSession in server.mjs).
//
// Cloudflare runs the same instance type on hosts of different speeds: on a
// slow one (Zen 3 "Milan" at 2.0 GHz) a 1 vCPU session spends its whole CPU
// drawing the page and encoding full-size JPEGs, and an animation reaches the
// viewer at about half the frame rate, with clicks twice as slow, as on a fast
// one. Half-size frames at a lower JPEG quality cost Chrome much less to
// encode. So while the browser is out of CPU *and* frames are coming slowly,
// the live view steps down to that cheaper picture, and once the browser
// has CPU to spare again it steps back up.
//
// The decision is on what's measured, not on the CPU model: the VM's CPU
// (busy plus steal, so a starved VM counts as busy) and the screencast frames
// Chrome actually delivers. A page that is still sends no frames, so it never
// steps down however busy its scripts are; a fast host drawing 47 fps at 0.8
// of its vCPU never steps down either.
//
// Hysteresis: stepping down takes `downAfter` struggling samples in a row;
// stepping up takes `upAfter` calm ones in a row, and no sooner than `holdMs`
// after the step down. Each step down within `flapMs` of the last step up
// doubles the hold (up to `maxHoldMs`), so a page that keeps flipping between
// busy and still settles on the cheaper picture instead of flapping.
import fs from "node:fs/promises";

export const REDUCED = { scale: 0.5, quality: 40 };

export class LiveAdapt {
  /**
   * @param {object} [o]
   * @param {number} [o.busyHigh]   CPU fraction (0..1 of all vCPUs) that counts as out of CPU (default 0.9)
   * @param {number} [o.busyLow]    CPU fraction below which the browser has CPU to spare (default 0.6)
   * @param {number} [o.fpsLow]     screencast fps below which frames are coming slowly (default 40)
   * @param {number} [o.fpsMin]     below this many fps the page is (nearly) still: no step down (default 3)
   * @param {number} [o.downAfter]  struggling samples in a row before stepping down (default 3)
   * @param {number} [o.upAfter]    calm samples in a row before stepping up (default 5)
   * @param {number} [o.holdMs]     least time on the cheaper picture (default 30 s)
   * @param {number} [o.maxHoldMs]  most the hold grows to (default 4 min)
   * @param {number} [o.flapMs]     a step down this soon after a step up doubles the hold (default 2 min)
   * @param {() => number} [o.now]
   */
  constructor({
    busyHigh = 0.9,
    busyLow = 0.6,
    fpsLow = 40,
    fpsMin = 3,
    downAfter = 3,
    upAfter = 5,
    holdMs = 30_000,
    maxHoldMs = 240_000,
    flapMs = 120_000,
    now = () => performance.now(),
  } = {}) {
    Object.assign(this, { busyHigh, busyLow, fpsLow, fpsMin, downAfter, upAfter, maxHoldMs, flapMs, now });
    this.baseHoldMs = holdMs;
    this.holdMs = holdMs;
    /** 0: the viewer's own picture; 1: the cheaper one (REDUCED). */
    this.level = 0;
    this.struggling = 0;
    this.calm = 0;
    this.downAt = -Infinity;
    this.upAt = -Infinity;
  }

  /**
   * One sample, about a second's worth.
   * @param {{busy: number | null, fps: number}} s
   * @returns {{level: number, reason: string} | null} the new level, when it changes
   */
  sample({ busy, fps }) {
    const t = this.now();
    if (busy == null || !Number.isFinite(busy)) return null;
    if (this.level === 0) {
      const struggling = busy >= this.busyHigh && fps >= this.fpsMin && fps < this.fpsLow;
      this.struggling = struggling ? this.struggling + 1 : 0;
      if (this.struggling < this.downAfter) return null;
      this.holdMs = t - this.upAt < this.flapMs ? Math.min(this.maxHoldMs, this.holdMs * 2) : this.baseHoldMs;
      this.level = 1;
      this.downAt = t;
      this.struggling = 0;
      this.calm = 0;
      return { level: 1, reason: `CPU ${pct(busy)} busy at ${Math.round(fps)} fps for ${this.downAfter} s` };
    }
    this.calm = busy < this.busyLow ? this.calm + 1 : 0;
    if (this.calm < this.upAfter || t - this.downAt < this.holdMs) return null;
    this.level = 0;
    this.upAt = t;
    this.calm = 0;
    return { level: 0, reason: `CPU under ${pct(this.busyLow)} for ${this.upAfter} s` };
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** /proc/stat's first line: [unavailable, total] in ticks (busy and steal count as unavailable). */
async function procStat() {
  const f = (await fs.readFile("/proc/stat", "utf8")).split("\n")[0].split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal = 0] = f;
  const busy = user + nice + system + irq + softirq + steal;
  return [busy, busy + idle + iowait];
}

/** A cgroup CPU limit (docker --cpus), as vCPUs; null when there's none. */
async function cgroupQuota() {
  const m = (await fs.readFile("/sys/fs/cgroup/cpu.max", "utf8").catch(() => "max")).trim().split(/\s+/);
  return m[0] === "max" ? null : Number(m[0]) / Number(m[1]);
}
async function cgroupUsageUsec() {
  const s = await fs.readFile("/sys/fs/cgroup/cpu.stat", "utf8");
  return Number(s.match(/^usage_usec (\d+)/m)?.[1]);
}

/**
 * How much of the CPU the browser can have is in use, 0..1, since the last
 * call. On Cloudflare the container is its own VM and /proc/stat is its own;
 * in a local docker container with --cpus it's the cgroup's use against its
 * quota instead (/proc/stat there is the host's).
 */
export async function cpuMeter() {
  const quota = await cgroupQuota().catch(() => null);
  if (quota) {
    let last = [await cgroupUsageUsec(), performance.now()];
    return async () => {
      const cur = [await cgroupUsageUsec(), performance.now()];
      const busy = (cur[0] - last[0]) / 1000 / (cur[1] - last[1]) / quota;
      last = cur;
      return Math.min(1, Math.max(0, busy));
    };
  }
  let last = await procStat().catch(() => null);
  return async () => {
    const cur = await procStat().catch(() => null);
    if (!cur || !last || cur[1] <= last[1]) return (last = cur), null;
    const busy = (cur[0] - last[0]) / (cur[1] - last[1]);
    last = cur;
    return busy;
  };
}

let hostCpuName;
/** The host's CPU, for the logs: a VM's model name can be as vague as "AMD EPYC", so family and model too. */
export async function hostCpu() {
  if (hostCpuName === undefined) {
    const info = await fs.readFile("/proc/cpuinfo", "utf8").catch(() => "");
    const f = (k) => info.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "m"))?.[1].trim();
    hostCpuName = f("model name") ? `${f("model name")} (family ${f("cpu family")} model ${f("model")}, ${f("cpu MHz")} MHz)` : null;
  }
  return hostCpuName;
}
