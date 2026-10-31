// Copied from tvdavies/brwsr@0d22bf8 (container/agent/recorder.mjs) for Kantel's browser runtime
// (docs/design/browser-runtime.md). Kantel changes: each page's listing keeps its navigations (url and title by page
// time, from Target.targetInfoChanged), for the replay's address bar.
// Session recording, the browser container's half: capture frames, nothing
// else. Nothing resembling video encoding runs here (Browserbase's rule: "the
// browser does one thing: render pages"). Encoding to H.264 happens later, in
// the encoder containers (encoder/), when someone plays or downloads the
// recording, and eagerly for each tab's first 30 s (src/recording-encoder.ts).
//
// On its own CDP connection, every page target is screencast as JPEG. Chrome
// sends a frame only when the page draws something new, so a still page costs
// nothing; each frame is acknowledged at once (or, with maxFps, no sooner
// than the cap allows, which stops Chrome drawing the frames in between).
// A frame identical to the previous one is dropped.
//
// Frames are appended, with their real timestamps, to one chunk file per
// `segmentSeconds` of the page's timeline (Matroska holding MJPEG, mkv.mjs).
// Chunk k covers [k * segment, (k + 1) * segment): it starts with the picture
// on screen at its start and ends with that at its end, so each chunk encodes
// on its own into one HLS segment with no gap at either side, and segments
// can be encoded in parallel and in any order. A page that sits still for a
// whole segment still gets a chunk: its one picture, twice.
//
// Recording runs on every session by default, on ¼ and ½ vCPU, and with no
// encoder here the screencast itself is the remaining cost (merely having it
// on costs Chromium a share of its frame rate). So it must never be what
// slows the agent:
// - While the agent is acting (its CDP commands in flight, server.mjs calls
//   clientBusy) and the CPU is short (cgroup throttling, VM steal or CPU
//   pressure), acks are paced to a frame rate that halves under pressure
//   down to minFps and climbs back when the CPU is free or the agent goes
//   quiet (FpsGovernor): onPressure "pace", the default. "pause" turns the
//   screencast off until the agent is quiet instead (yieldCapture).
// - Frames are dropped, not written, when the disk is nearly full.
//
// One screencast per page while someone watches (shareLive, on by default;
// RECORDING_SHARE_LIVE=0 turns it off). Two screencasts of one page cost
// Chrome two captures and two JPEG encodes of every frame, which held the
// live view of a recorded session on a 1 vCPU instance well below an
// unrecorded one. So while the live view (server.mjs) screencasts a page, it
// hands the recorder each frame it gets (share()), and the recorder's own
// screencast of that page stops. When the viewer leaves, switches tab or its
// frames get too small, the recorder's own screencast starts again first and
// takes over; the live view's frames are still taken until its first frame
// arrives, so the recording has no gap. While shared, the recording gets the
// frames the viewer gets: the live view's JPEG quality (60, or 40 while
// live-adapt.mjs has stepped it down) and size (the viewer's canvas, so
// usually the whole viewport; half of it while stepped down). The tab's size
// stays that of its own first frame; the encoder scales smaller frames up to
// it. Frames smaller than shareMinScale (default 0.5,
// RECORDING_SHARE_MIN_SCALE) of that size, such as a thumbnail's, aren't
// taken: the recorder screencasts the page itself instead. The listing's
// `shared` fields say how many frames came from the live view and how many
// of those were smaller than the recording.
//
// The Durable Object moves closed chunks to R2 (list, fetch, delete), as it
// does with logs.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CDP } from "./cdp.mjs";
import { mkvHeader, mkvFrame, jpegSize } from "./mkv.mjs";

export const chunkName = (index) => `${String(index).padStart(5, "0")}.mkv`;

// A page's navigations kept for the replay's address bar: how many, and how long a URL or title.
const MAX_NAVIGATIONS = 200;
const MAX_URL = 2048;
const MAX_TITLE = 300;

class Chunk {
  constructor(page, index) {
    this.index = index;
    this.name = chunkName(index);
    this.file = path.join(page.dir, this.name);
    this.startMs = index * page.rec.segmentMs;
    this.endMs = null; // set on close
    this.frames = 0;
    this.bytes = 0;
    this.fd = fs.openSync(this.file, "w");
    this.page = page;
    this.headed = false;
  }

  /**
   * The track's size is the chunk's first frame's, not the tab's: ffmpeg
   * loses every other frame of a chunk whose first frame differs in size
   * from its header (as when the live view's frames are half size, or the
   * viewport changed). Frames of another size later in a chunk are fine; the
   * encoder scales them all to the tab's size.
   */
  head(jpeg) {
    if (this.headed) return;
    const size = jpeg && jpegSize(jpeg);
    this.write(size ? mkvHeader(size.width, size.height) : mkvHeader(this.page.width, this.page.height));
    this.headed = true;
  }

  write(buf) {
    // Positional: a frame that fails part-way (disk full) is overwritten by the next.
    if (fs.writeSync(this.fd, buf, 0, buf.length, this.bytes) !== buf.length) throw new Error("short write (disk full?)");
    this.bytes += buf.length;
  }

  add(ms, jpeg) {
    this.head(jpeg);
    this.write(mkvFrame(ms, jpeg));
    this.frames++;
  }

  close(endMs, lastJpeg, lastMs) {
    // The picture on screen holds until the chunk's end; 1 ms before it, so
    // the next segment starts exactly at endMs.
    if (lastJpeg && endMs - 1 > lastMs) this.add(endMs - 1, lastJpeg);
    this.head(null);
    fs.closeSync(this.fd);
    this.endMs = endMs;
  }
}

class PageRecording {
  constructor(rec, pageId, targetId) {
    this.rec = rec;
    this.pageId = pageId;
    this.targetId = targetId;
    this.dir = path.join(rec.dir, String(pageId));
    this.sessionId = null;
    this.startedAt = null; // epoch ms of the first frame
    this.endedAt = null;
    this.t0 = null; // screencast timestamp (s) of the first frame
    this.lastMs = -1;
    this.lastFrame = null;
    this.frames = 0;
    this.identical = 0;
    this.dropped = 0; // frames not kept: disk nearly full, or a write failed
    this.writeError = null;
    this.width = 0;
    this.height = 0;
    this.chunk = null; // the open chunk
    this.closed = []; // closed chunks the Durable Object hasn't taken yet
    this.taken = 0; // closed chunks it has
    this.ended = false;
    this.lastAckAt = 0;
    // The recorder's own screencast: "starting" (asked for, no frame yet), "on", or "off" (the live view's frames stand in).
    this.own = "starting";
    this.ownWaiters = []; // called on the own screencast's first frame after it (re)starts
    this.lastTs = null; // timestamp (s) and source of the last frame kept
    this.lastSource = null;
    this.shared = { frames: 0, smaller: 0, minWidth: 0, minHeight: 0 };
    // Where the page went, by page time (ms, 0 before its first frame), for a replay's address bar: from the target's
    // url and title as Chrome reports them (Target.targetInfoChanged), at most MAX_NAVIGATIONS, oldest first.
    this.navigations = [];
  }

  /** The page's target says it is at `url`, titled `title`: kept when either changed. */
  navigated(url, title) {
    if (this.ended || typeof url !== "string" || url === "" || url.startsWith("devtools://")) return;
    const last = this.navigations.at(-1);
    const name = typeof title === "string" && title !== "" && title !== url ? title.slice(0, MAX_TITLE) : undefined;
    if (last && last.url === url.slice(0, MAX_URL) && last.title === name) return;
    const atMs = Math.max(0, this.nowMs(), last?.atMs ?? 0);
    const entry = { atMs, url: url.slice(0, MAX_URL), ...(name === undefined ? {} : { title: name }) };
    // The same address, its title now known (or changed): the newest says it.
    if (last && last.url === entry.url) this.navigations[this.navigations.length - 1] = { ...entry, atMs: last.atMs };
    else if (this.navigations.length < MAX_NAVIGATIONS) this.navigations.push(entry);
  }

  /** Page time now (ms), from the wall clock: for rolling chunks over while no frames arrive. */
  nowMs() {
    return this.startedAt === null ? -1 : Date.now() - this.startedAt;
  }

  frame(jpeg, timestamp, source = "own", size = null) {
    if (this.ended) return;
    // Where both screencasts overlap, while one takes over from the other, a
    // frame older than the last one kept from the other is stale.
    if (this.lastTs !== null && source !== this.lastSource && timestamp < this.lastTs) return;
    if (this.t0 === null) {
      const size = jpegSize(jpeg);
      if (!size) return;
      this.t0 = timestamp;
      this.startedAt = Date.now();
      // Even dimensions for yuv420p; the encoder scales any later size to this.
      this.width = size.width & ~1;
      this.height = size.height & ~1;
      fs.mkdirSync(this.dir, { recursive: true });
    } else if (this.lastFrame && jpeg.equals(this.lastFrame)) {
      this.identical++;
      return;
    }
    if (this.rec.diskLow && this.lastFrame) {
      this.dropped++;
      return;
    }
    let ms = Math.round((timestamp - this.t0) * 1000);
    if (ms <= this.lastMs) ms = this.lastMs + 1;
    try {
      this.rollTo(ms);
      this.chunk.add(ms, jpeg);
    } catch (e) {
      if (!this.writeError) console.log(`recorder: writing page ${this.pageId} failed: ${e.message}`);
      this.writeError = e.message;
      this.dropped++;
      return;
    }
    this.lastMs = ms;
    this.lastFrame = jpeg;
    this.lastTs = timestamp;
    this.lastSource = source;
    this.frames++;
    if (source === "live") {
      const s = this.shared;
      s.frames++;
      if (size && (size.width < this.width || size.height < this.height)) s.smaller++;
      if (size && (!s.minWidth || size.width * size.height < s.minWidth * s.minHeight)) {
        s.minWidth = size.width;
        s.minHeight = size.height;
      }
    }
  }

  /**
   * Close every chunk that ends at or before `ms` and open the one `ms` falls
   * in. A chunk opened here starts with the picture on screen, unless the
   * frame about to be added is exactly at its start (`still`: no frame is).
   */
  rollTo(ms, still = false) {
    const seg = this.rec.segmentMs;
    const want = Math.floor(ms / seg);
    if (this.chunk && this.chunk.index === want) return;
    while (this.chunk && this.chunk.index < want) {
      const c = this.chunk;
      c.close(c.startMs + seg, this.lastFrame, this.lastMs);
      this.closed.push(c);
      // A still stretch: the next chunk starts with the picture on screen.
      this.chunk = c.index + 1 <= want ? new Chunk(this, c.index + 1) : null;
      if (this.chunk && this.lastFrame && (this.chunk.index < want || still || ms > this.chunk.startMs)) {
        this.chunk.add(this.chunk.startMs, this.lastFrame);
        this.lastMs = Math.max(this.lastMs, this.chunk.startMs);
      }
    }
    if (!this.chunk) this.chunk = new Chunk(this, want);
  }

  /** Called every second: roll chunks over on a still page. */
  tick() {
    if (this.ended || !this.chunk || !this.lastFrame) return;
    const ms = this.nowMs();
    try {
      if (ms >= this.chunk.startMs + this.rec.segmentMs) this.rollTo(ms, true);
    } catch (e) {
      this.writeError ??= e.message;
    }
  }

  /** No more frames: the last picture holds until now, then the open chunk closes. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.endedAt = Date.now();
    if (this.t0 === null) return;
    // The page ends now (or just after its last frame), in the chunk holding
    // its last millisecond.
    const end = Math.max(this.lastMs + 1, this.nowMs());
    const last = Math.floor((end - 1) / this.rec.segmentMs);
    try {
      if (last > this.chunk.index) this.rollTo(last * this.rec.segmentMs, true);
      this.chunk.close(end, this.lastFrame, this.lastMs);
    } catch (e) {
      this.writeError ??= e.message;
      try {
        fs.closeSync(this.chunk.fd);
      } catch {}
      this.chunk.endMs = Math.max(this.chunk.startMs + 1, this.lastMs + 1);
    }
    this.lastMs = Math.max(this.lastMs, end - 1);
    this.closed.push(this.chunk);
    this.chunk = null;
    this.lastFrame = null;
  }

  listing() {
    return {
      pageId: String(this.pageId),
      targetId: this.targetId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.lastMs >= 0 ? this.lastMs + 1 : 0,
      frames: this.frames,
      identical: this.identical,
      dropped: this.dropped,
      error: this.writeError ? `spool: ${this.writeError}` : undefined,
      width: this.width,
      height: this.height,
      chunks: this.closed.map((c) => ({ name: c.name, index: c.index, startMs: c.startMs, durationMs: c.endMs - c.startMs, frames: c.frames, bytes: c.bytes })),
      done: this.ended,
      // Frames taken from the live view's screencast while someone watched, how many of them were smaller than the recording, and the smallest.
      shared: { ...this.shared },
      navigations: this.navigations.map((n) => ({ ...n })),
    };
  }
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * How short of CPU the container is, 0 to 1, from whichever signals it has:
 * the fraction of time its cgroup was throttled (a CPU quota, as under
 * Docker), CPU pressure (time something was waiting for a CPU; the cgroup's
 * own, else the machine's), and steal time (a VM whose host caps its vCPU).
 * Each sample() compares with the last.
 */
export class CpuPressure {
  constructor(read = readText, now = () => performance.now()) {
    this.read = read;
    this.now = now;
    this.last = null;
  }

  counters() {
    const stat = this.read("/sys/fs/cgroup/cpu.stat");
    const psi = this.read("/sys/fs/cgroup/cpu.pressure") ?? this.read("/proc/pressure/cpu");
    const cpu = this.read("/proc/stat")?.match(/^cpu\s+(.*)$/m)?.[1].trim().split(/\s+/).map(Number);
    return {
      t: this.now() * 1000,
      throttled: Number(stat?.match(/^throttled_usec (\d+)/m)?.[1] ?? NaN),
      some: Number(psi?.match(/^some .*total=(\d+)/m)?.[1] ?? NaN),
      steal: cpu ? (cpu[7] ?? 0) : NaN,
      jiffies: cpu ? cpu.slice(0, 8).reduce((n, x) => n + x, 0) : NaN,
    };
  }

  sample() {
    const c = this.counters();
    const l = this.last;
    this.last = c;
    if (!l) return 0;
    const dt = c.t - l.t;
    if (!(dt > 0)) return 0;
    const parts = [(c.throttled - l.throttled) / dt, (c.some - l.some) / dt, (c.steal - l.steal) / (c.jiffies - l.jiffies)];
    return Math.min(1, Math.max(0, ...parts.filter((x) => Number.isFinite(x))));
  }
}

/**
 * The capture frame rate: maxFps while the CPU is free or the agent is quiet;
 * while the agent is acting and the CPU is short, it halves each tick down
 * to minFps, and doubles back once the shortage passes.
 */
export class FpsGovernor {
  constructor({ maxFps = 60, minFps = 5, high = 0.25, low = 0.1 } = {}) {
    Object.assign(this, { maxFps, minFps, high, low });
    this.fps = maxFps;
    this.lowest = maxFps;
  }

  tick(pressure, agentBusy) {
    if (!agentBusy) this.fps = this.maxFps;
    else if (pressure >= this.high) this.fps = Math.max(this.minFps, Math.floor(this.fps / 2));
    else if (pressure < this.low) this.fps = Math.min(this.maxFps, this.fps * 2);
    this.lowest = Math.min(this.lowest, this.fps);
    return this.fps;
  }
}

/** A live viewer's screencast of one page, standing in for the recorder's own (Recorder.share). */
class LiveShare {
  constructor(rec, targetId) {
    this.rec = rec;
    this.targetId = targetId;
    this.leaving = false;
  }

  /** Its frames are the ones being recorded (or will be, once they're big enough). */
  get current() {
    return this.rec.currentShare(this.targetId) === this;
  }

  /** A frame the viewer's screencast produced: JPEG bytes and Chrome's timestamp (s). */
  frame(jpeg, timestamp) {
    this.rec.sharedFrame(this, jpeg, timestamp);
  }

  release(timeoutMs) {
    return this.rec.unshare(this, timeoutMs);
  }
}

export class Recorder {
  constructor({
    dir = "/tmp/.recording",
    maxPages = 10,
    quality = 80,
    maxWidth = 1920,
    maxHeight = 1080,
    segmentSeconds = 10,
    // A hard cap on frames a second per page (0: none, beyond the governor's 60).
    maxFps = 0,
    minFps = 5,
    adaptive = true,
    // Under CPU shortage while the agent acts: "pace" the screencast's acks
    // (FpsGovernor), or "pause" the screencast (yieldCapture).
    onPressure = "pace",
    // A client command older than this no longer counts as the agent acting
    // (a long awaitPromise, or a reply that never came).
    clientStuckMs = 30_000,
    // The agent counts as acting this long after its last CDP message.
    busyHoldMs = 1000,
    // While the live view screencasts a page, take its frames instead of
    // screencasting the page a second time (share()), as long as they're at
    // least shareMinScale of the recording's size.
    shareLive = true,
    shareMinScale = 0.5,
    minFreeDiskBytes = 512 * 1024 * 1024,
    pressure = new CpuPressure(),
  } = {}) {
    Object.assign(this, { dir, maxPages, quality, maxWidth, maxHeight, maxFps, adaptive, onPressure, clientStuckMs, busyHoldMs, shareLive, shareMinScale, minFreeDiskBytes, pressure });
    this.segmentMs = Math.round(segmentSeconds * 1000);
    this.governor = new FpsGovernor({ maxFps: maxFps > 0 ? maxFps : 60, minFps: Math.min(minFps, maxFps > 0 ? maxFps : 60) });
    this.lastPressure = 0;
    this.inflight = 0; // client CDP commands awaiting their reply
    this.lastClientAt = 0;
    this.diskLow = false;
    this.yielding = false;
    this.yields = 0;
    this.yieldedMs = 0;
    this.pages = new Map(); // targetId -> PageRecording
    this.bySession = new Map(); // CDP sessionId -> PageRecording
    this.cdp = null;
    this.startedAt = null;
    this.stopped = false;
    this.skipped = 0;
    this.shares = new Map(); // targetId -> LiveShare[], oldest first
    this.timer = null;
    this.tick = null;
  }

  /**
   * The live view is screencasting this page: it hands each frame it gets to
   * the returned share's frame(), and calls release() when it stops. Null
   * when sharing is off. With several viewers on one page, the first one's
   * frames are taken, and the next one's once it leaves.
   */
  share(targetId) {
    if (!this.shareLive || this.stopped) return null;
    const s = new LiveShare(this, targetId);
    const list = this.shares.get(targetId) ?? [];
    list.push(s);
    this.shares.set(targetId, list);
    return s;
  }

  /** The viewer whose frames the page's recording takes: the first that isn't leaving. */
  currentShare(targetId) {
    return this.shares.get(targetId)?.find((s) => !s.leaving) ?? null;
  }

  sharedFrame(share, jpeg, timestamp) {
    if (this.stopped) return;
    const page = this.pages.get(share.targetId);
    // The recording's size comes from its own first frame.
    if (!page || page.ended || page.t0 === null) return;
    const size = jpegSize(jpeg);
    if (!size) return;
    if (share.leaving) {
      // Handing back: its frames still count until the recorder's own screencast has sent one.
      if (page.own === "starting" && !this.currentShare(share.targetId)) page.frame(jpeg, timestamp, "live", size);
      return;
    }
    if (this.currentShare(share.targetId) !== share) return;
    const k = this.shareMinScale;
    if (size.width >= page.width * k - 2 && size.height >= page.height * k - 2) {
      this.setOwn(page, false);
      page.frame(jpeg, timestamp, "live", size);
    } else {
      // Too small (a thumbnail): the recorder screencasts the page itself,
      // and takes these until its own first frame comes.
      this.setOwn(page, true);
      if (page.own === "starting") page.frame(jpeg, timestamp, "live", size);
    }
  }

  /**
   * The viewer is leaving the page (closed, or switched tab). If its frames
   * stood in for the recorder's own, that screencast starts again; the promise
   * resolves once it has sent its first frame (or after timeoutMs, as on a
   * still page Chrome may send none), and until then the viewer should keep
   * its screencast running and its frames coming, so the recording has no gap.
   */
  unshare(share, timeoutMs = 1000) {
    const list = this.shares.get(share.targetId) ?? [];
    const remove = () => {
      const i = list.indexOf(share);
      if (i >= 0) list.splice(i, 1);
      if (!list.length && this.shares.get(share.targetId) === list) this.shares.delete(share.targetId);
    };
    const page = this.pages.get(share.targetId);
    const wasCurrent = this.currentShare(share.targetId) === share;
    share.leaving = true;
    // Another viewer's frames carry on, or the recorder's own screencast already runs.
    if (!wasCurrent || !page || page.ended || this.stopped || page.own !== "off" || this.currentShare(share.targetId)) {
      remove();
      return Promise.resolve();
    }
    this.setOwn(page, true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        page.ownWaiters = page.ownWaiters.filter((f) => f !== done);
        remove();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      page.ownWaiters = [...page.ownWaiters, done];
    });
  }

  /** Start ("starting" until its first frame) or stop the recorder's own screencast of a page. */
  setOwn(page, on) {
    if (on ? page.own !== "off" : page.own === "off") return;
    page.own = on ? "starting" : "off";
    if (!this.yielding) this.setScreencast(page, on).catch(() => {});
  }

  async start(browserWsUrl) {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.startedAt = Date.now();
    this.cdp = await CDP.connect(browserWsUrl);
    this.cdp.on((m) => this.onMessage(m));
    this.timer = setInterval(() => {
      for (const p of this.pages.values()) p.tick();
    }, 1000);
    this.timer.unref();
    this.pressure?.sample();
    this.tick = setInterval(() => this.housekeeping(), 500);
    this.tick.unref();
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    for (const t of targetInfos) if (this.wanted(t)) await this.attach(t.targetId, t).catch(() => {});
  }

  wanted(t) {
    return t.type === "page" && !t.url.startsWith("devtools://");
  }

  async attach(targetId, info) {
    if (this.stopped || this.pages.has(targetId)) return;
    if (this.pages.size >= this.maxPages) {
      this.skipped++;
      return;
    }
    const page = new PageRecording(this, this.pages.size, targetId);
    this.pages.set(targetId, page);
    if (info) page.navigated(info.url, info.title);
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    page.sessionId = sessionId;
    this.bySession.set(sessionId, page);
    if (!this.yielding) await this.setScreencast(page, true);
  }

  /** Start or stop a page's screencast. */
  setScreencast(page, on) {
    if (!page.sessionId || page.ended) return Promise.resolve();
    return on
      ? this.cdp.send(
          "Page.startScreencast",
          { format: "jpeg", quality: this.quality, maxWidth: this.maxWidth, maxHeight: this.maxHeight, everyNthFrame: 1 },
          page.sessionId,
        )
      : this.cdp.send("Page.stopScreencast", {}, page.sessionId);
  }

  /**
   * onPressure "pause": while the agent acts and the CPU is short, turn the
   * screencast off altogether, and back on once the agent is quiet. Chrome
   * sends the page as it is then, so the video jumps over what it missed.
   */
  yieldCapture(busy) {
    const want = busy && this.lastPressure >= this.governor.high;
    if (want && !this.yielding) {
      this.yielding = true;
      this.yieldedSince = Date.now();
      this.yields++;
    } else if (this.yielding && !busy) {
      this.yielding = false;
      this.yieldedMs += Date.now() - this.yieldedSince;
    } else return;
    // Pages whose frames come from the live view have no screencast of their own to pause.
    for (const p of this.pages.values()) if (p.own !== "off") this.setScreencast(p, !this.yielding).catch(() => {});
  }

  /** The agent is acting: a command in flight, or a CDP message in the last busyHoldMs. */
  agentBusy(now = Date.now()) {
    return (this.inflight > 0 && now - this.lastClientAt <= this.clientStuckMs) || now - this.lastClientAt < this.busyHoldMs;
  }

  /**
   * The client's CDP traffic, from server.mjs's proxy: +1 for a command, -1
   * for its reply (and -n for the replies a closed connection will never get);
   * 0 for other input, such as the live view's.
   */
  clientBusy(delta = 1) {
    this.inflight = Math.max(0, this.inflight + delta);
    this.lastClientAt = Date.now();
  }

  /** Every 500 ms: the capture frame rate, and the disk. */
  housekeeping() {
    if (this.stopped) return;
    if (this.adaptive) {
      this.lastPressure = this.pressure?.sample() ?? 0;
      const busy = this.agentBusy();
      this.governor.tick(this.lastPressure, busy);
      if (this.onPressure === "pause") this.yieldCapture(busy);
    }
    try {
      const s = fs.statfsSync(this.dir);
      this.diskLow = s.bavail * s.bsize < this.minFreeDiskBytes;
    } catch {}
  }

  /**
   * Acknowledge a screencast frame; Chrome draws the next only after that.
   * Acks are spaced to the governor's frame rate (maxFps at most, if set).
   */
  ack(page, m) {
    const send = () => {
      if (page) page.lastAckAt = Date.now();
      this.cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
    };
    const paced = page && (this.adaptive || this.maxFps > 0);
    const wait = paced ? page.lastAckAt + 1000 / this.governor.fps - Date.now() : 0;
    if (wait > 1) setTimeout(send, wait).unref();
    else send();
  }

  onMessage(m) {
    if (m.method === "Page.screencastFrame") {
      const page = this.bySession.get(m.sessionId);
      this.ack(page, m);
      if (!page || this.stopped) return;
      if (page.own === "starting") {
        page.own = "on";
        for (const f of page.ownWaiters) f();
      }
      page.frame(Buffer.from(m.params.data, "base64"), m.params.metadata.timestamp ?? Date.now() / 1000, "own");
    } else if (m.method === "Target.targetCreated") {
      if (this.wanted(m.params.targetInfo)) this.attach(m.params.targetInfo.targetId, m.params.targetInfo).catch(() => {});
    } else if (m.method === "Target.targetInfoChanged") {
      const info = m.params.targetInfo;
      this.pages.get(info?.targetId)?.navigated(info.url, info.title);
    } else if (m.method === "Target.targetDestroyed") {
      this.pages.get(m.params.targetId)?.end();
    } else if (m.method === "Target.detachedFromTarget") {
      this.bySession.get(m.params.sessionId)?.end();
    } else if (m.method === "brwsr.closed") {
      for (const p of this.pages.values()) p.end();
    }
  }

  /** Stop capturing and close every page's last chunk. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.tick) clearInterval(this.tick);
    if (this.yielding) this.yieldedMs += Date.now() - this.yieldedSince;
    this.yielding = false;
    for (const p of this.pages.values()) {
      if (p.sessionId && !p.ended) await this.cdp?.send("Page.stopScreencast", {}, p.sessionId).catch(() => {});
      p.end();
    }
    this.cdp?.close();
  }

  page(pageId) {
    return [...this.pages.values()].find((p) => String(p.pageId) === String(pageId)) ?? null;
  }

  async listing() {
    const pages = [...this.pages.values()].map((p) => p.listing());
    // Done: capture has stopped and every chunk has been taken.
    const done = this.stopped && pages.every((p) => p.chunks.length === 0);
    return {
      startedAt: this.startedAt,
      stopped: this.stopped,
      done,
      skippedPages: this.skipped,
      pages,
      // How recording is sparing the agent: the capture frame rate now and its lowest, CPU shortage, disk.
      capture: {
        fps: this.governor.fps,
        lowestFps: this.governor.lowest,
        pressure: +this.lastPressure.toFixed(2),
        diskLow: this.diskLow,
        paused: this.yields,
        pausedMs: this.yieldedMs + (this.yielding ? Date.now() - this.yieldedSince : 0),
        // Whether pages being watched take the live view's frames (one screencast, not two).
        shareLive: this.shareLive,
      },
    };
  }

  /** Path of a closed chunk not yet taken, or null. */
  async file(pageId, name) {
    const p = this.page(pageId);
    const c = p?.closed.find((x) => x.name === name);
    if (!c) return null;
    return (await fsp.stat(c.file).catch(() => null)) ? c.file : null;
  }

  /** The Durable Object has stored it. */
  async remove(pageId, name) {
    const p = this.page(pageId);
    const i = p ? p.closed.findIndex((x) => x.name === name) : -1;
    if (i < 0) return false;
    const [c] = p.closed.splice(i, 1);
    p.taken++;
    await fsp.rm(c.file, { force: true });
    return true;
  }
}
