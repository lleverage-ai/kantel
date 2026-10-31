// Copied from tvdavies/brwsr@0d22bf8 (container/agent/live-pacer.mjs) for Kantel's browser runtime
// (docs/design/browser-runtime.md). Kantel changes: none.
// Frame pacing for the live view (protocol v2, see liveSession in server.mjs).
//
// Chrome's screencast sends a frame only while fewer than maxFramesInFlight
// frames await a Page.screencastFrameAck. Acking a frame as soon as it leaves
// the agent (as the first live view did) lets Chrome produce frames as fast as
// its CPU allows, and they pile up wherever the path to the viewer is slowest.
// Here Chrome's ack waits for the viewer's: a frame is acked to Chrome only once
// the viewer has received one, and no sooner than the fps cap allows. So frames
// in flight end to end never exceed maxFramesInFlight, and Chrome never encodes
// a frame the link can't carry. (Acking on receipt rather than after drawing
// keeps decoding off the critical path; the viewer drops frames that arrive
// while it decodes, so a slow viewer still never falls behind.)
//
// Waiting for the viewer costs a round trip per maxFramesInFlight frames, which
// on a fast link with a long round trip caps the frame rate below what Chrome
// and the link could do. So while the viewer's acks come back quickly, up to
// `window` more frames may run ahead of them: Chrome is acked as soon as a
// frame leaves, as before v2. A frame counts as quick while the oldest one the
// viewer hasn't acked is no older than the quickest recent round trip plus
// `slackMs`; once frames start queueing on the way (a slow link), that fails
// and Chrome's ack waits for the viewer's again. So the queue a slow link can
// build is about slackMs deep, and frames in flight end to end never exceed
// window + maxFramesInFlight.
//
// While the session's recording takes its frames from this screencast
// (recorder.mjs share()), a viewer that falls behind mustn't stall the
// recording too. So with `floorMs`, Chrome is still acked at least every
// floorMs while the viewer's acks hold it back. The frames that come of it
// go to the recording; the viewer gets the newest one it couldn't take as
// soon as it has room (sent(frame, false), then lateSend), so it never
// queues more than before.
export class FramePacer {
  /**
   * @param {object} o
   * @param {number} o.fps                 most frames a second to let through
   * @param {(frame: number) => void} o.ack  acks one frame to Chrome
   * @param {number} [o.window]            frames that may run ahead of the viewer's acks while they come back quickly (default 0)
   * @param {number} [o.slackMs]           how much later than the quickest recent ack still counts as quick (default 50)
   * @param {number | (() => number)} [o.floorMs]  ack Chrome at least this often however far behind the viewer is (0, the default: never)
   * @param {() => number} [o.now]
   * @param {(fn: () => void, ms: number) => unknown} [o.setTimer]
   * @param {(t: unknown) => void} [o.clearTimer]
   */
  constructor({ fps, ack, window = 0, slackMs = 50, floorMs = 0, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.interval = 1000 / fps;
    this.floor = typeof floorMs === "function" ? floorMs : () => floorMs;
    this.window = Math.max(0, window);
    this.slackMs = slackMs;
    /** Recent round trips to the viewer, [when, ms], for the quickest of the last few seconds. */
    this.rtts = [];
    this.ackChrome = ack;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.reset();
  }

  /** The screencast (re)started: forget its frames. */
  reset() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    /** Whether the timer waits for floorMs (a viewer's ack may cut it short), not the fps cap. */
    this.timerFloor = false;
    /** Chrome frame numbers not acked to Chrome, oldest first. */
    this.unacked = [];
    /** Those of them the viewer didn't get (sent(frame, false)). */
    this.unsent = new Set();
    /** When each frame the viewer hasn't acked yet was sent, oldest first. */
    this.sentAt = [];
    this.nextAt = 0;
    this.lastAckAt = -Infinity;
  }

  /** Frames sent to the viewer that it hasn't acked yet. */
  get outstanding() {
    return this.sentAt.length;
  }

  /** A frame from Chrome went to the viewer (or, with toViewer false, only to the recording). */
  sent(frame, toViewer = true) {
    this.unacked.push(frame);
    if (toViewer) this.sentAt.push(this.now());
    else this.unsent.add(frame);
    this.pump();
  }

  /** A frame the viewer didn't get at first went to it now. */
  lateSend(frame) {
    if (this.unsent.delete(frame)) this.sentAt.push(this.now());
    else this.extra(); // already acked to Chrome
  }

  /** A frame that isn't Chrome's (no screencast ack) went to the viewer: its ack must not release one. */
  extra() {
    this.sentAt.push(this.now());
  }

  /** The quickest round trip to the viewer in the last 3 s. */
  baseRtt() {
    const t = this.now();
    while (this.rtts.length && this.rtts[0][0] < t - 3000) this.rtts.shift();
    let min = Infinity;
    for (const [, ms] of this.rtts) min = Math.min(min, ms);
    return min;
  }

  /** May another frame run ahead of the viewer's acks? */
  quick(ahead) {
    if (ahead >= this.window) return false;
    if (!this.sentAt.length) return true;
    return this.now() - this.sentAt[0] <= this.baseRtt() + this.slackMs;
  }

  /** Frames Chrome has sent that it hasn't had an ack for: at maxFramesInFlight, it drops frames. */
  get held() {
    return this.unacked.length;
  }

  /** The viewer received a frame. */
  clientAck() {
    // An ack for a frame from before a reset has nothing to release.
    if (this.outstanding === 0) return;
    const t = this.now();
    this.rtts.push([t, t - this.sentAt.shift()]);
    if (this.rtts.length > 256) this.rtts.shift();
    this.pump();
  }

  wait(ms, floor) {
    this.timerFloor = floor;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pump();
    }, ms);
  }

  pump() {
    if (this.timer) {
      // Waiting out floorMs: the viewer's ack may have freed a frame sooner.
      if (!this.timerFloor) return;
      this.clearTimer(this.timer);
      this.timer = null;
    }
    for (;;) {
      if (!this.unacked.length) return;
      // Frames acked to Chrome that the viewer hasn't acked: those running ahead.
      const ahead = this.outstanding - (this.unacked.length - this.unsent.size);
      // ahead < 0: the viewer has acked frames Chrome hasn't had an ack for yet.
      if (ahead >= 0 && !this.quick(ahead)) {
        const floor = this.floor();
        if (!(floor > 0)) return;
        const due = this.lastAckAt + floor - this.now();
        if (due > 0.5) return this.wait(due, true);
      }
      const wait = this.nextAt - this.now();
      if (wait > 0.5) return this.wait(wait, false);
      this.nextAt = this.now() + this.interval;
      this.lastAckAt = this.now();
      const frame = this.unacked.shift();
      this.unsent.delete(frame);
      this.ackChrome(frame);
    }
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}
