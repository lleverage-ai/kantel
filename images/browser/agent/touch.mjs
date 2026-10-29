// Copied from tvdavies/brwsr@0d22bf8 (container/agent/touch.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Touch input for the live view (its mouse/touch toggle, as Browserbase's).
//
// In touch mode the browser is a touchscreen: every page has touch emulation
// on (navigator.maxTouchPoints, ontouchstart, (pointer: coarse)), and the
// live view's taps and drags arrive as Input.dispatchTouchEvent. The mode is
// the session's, not a viewer's.
//
// Emulation lasts only as long as the CDP session that set it, so the agent
// holds its own browser-level connection while touch mode is on. It
// auto-attaches to every page (new tabs and popups wait until they're set,
// so their first script already sees a touchscreen). Turning touch off turns
// emulation off on each page and drops the connection.
import { CDP } from "./cdp.mjs";

/** Fingers at once: what pages are told (navigator.maxTouchPoints) and the most one event may carry. */
export const MAX_TOUCH_POINTS = 5;
const TOUCH_EVENTS = new Set(["touchStart", "touchMove", "touchEnd", "touchCancel"]);
/** Far beyond any viewport: a bound on what a viewer may send, not a check that it's on screen. */
const MAX_COORD = 100000;

/**
 * A live view's {type:"touch", event, points:[{x, y, id?}]} as the params of
 * Input.dispatchTouchEvent, or null if it isn't one. touchStart and
 * touchMove carry every finger down (CDP presses, moves and releases points
 * by comparing with the last event); touchEnd and touchCancel lift them all.
 */
export function touchEvent(msg, modifiers = 0) {
  if (!msg || !TOUCH_EVENTS.has(msg.event)) return null;
  const points = msg.points ?? [];
  if (!Array.isArray(points) || points.length > MAX_TOUCH_POINTS) return null;
  const touchPoints = [];
  for (const [i, p] of points.entries()) {
    const ok = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
    if (!p || !ok(p.x) || !ok(p.y)) return null;
    const id = Number.isInteger(p.id) && p.id >= 0 && p.id <= 0xffff ? p.id : i;
    if (touchPoints.some((t) => t.id === id)) return null;
    touchPoints.push({ x: p.x, y: p.y, id });
  }
  const lift = msg.event === "touchEnd" || msg.event === "touchCancel";
  if (!lift && !touchPoints.length) return null;
  return { type: msg.event, touchPoints: lift ? [] : touchPoints, modifiers };
}

/** "touch" or "mouse" from {type:"inputMode", mode}; null otherwise. */
export function inputMode(msg) {
  return msg?.mode === "touch" || msg?.mode === "mouse" ? msg.mode : null;
}

/**
 * Turn touch emulation on in every page of one browser, now and later.
 * Resolves once the pages open now have it. stop() turns it off again.
 */
export async function emulateTouch(browserWsUrl, { log = console.log, connect = (u) => CDP.connect(u) } = {}) {
  const cdp = await connect(browserWsUrl);
  const pages = new Set();
  const pending = [];
  const on = { enabled: true, maxTouchPoints: MAX_TOUCH_POINTS };

  async function arm(sessionId, waiting) {
    try {
      await cdp.send("Emulation.setTouchEmulationEnabled", on, sessionId);
    } finally {
      if (waiting) await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
  }

  cdp.on((m) => {
    if (m.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = m.params;
      if (targetInfo.type !== "page") {
        if (waitingForDebugger) cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        return;
      }
      pages.add(sessionId);
      pending.push(arm(sessionId, waitingForDebugger).catch((e) => log(`touch input: couldn't set a page up: ${e.message}`)));
    } else if (m.method === "Target.detachedFromTarget") {
      pages.delete(m.params.sessionId);
    }
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Pages already open attach during setAutoAttach; let their events land, then wait until they're set.
  await new Promise((r) => setTimeout(r, 0));
  await Promise.all(pending);
  return {
    get pages() {
      return pages.size;
    },
    async stop() {
      // Closing the connection ends emulation too; saying so first doesn't wait on Chrome noticing.
      await Promise.all([...pages].map((s) => cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, s).catch(() => {})));
      cdp.close();
    },
  };
}
