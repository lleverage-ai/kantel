// Copied from tvdavies/brwsr@0d22bf8 (container/agent/cdp-rewrite.mjs) for Kantel's browser runtime
// (packages/browser/CONTRACT.md). Kantel changes: downloads aren't part of Kantel's browsers, so every
// download behaviour a client sets becomes "deny" (brwsr pointed "allow" at its downloads directory).
// Rewrites of CDP commands clients send through the proxy.

const DOWNLOAD_METHODS = new Set(["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]);

// Stealth: once a client enables Runtime (Puppeteer and Playwright do on every
// page), V8 captures a stack trace on every console call. Pages time console
// calls, and that cost is what deviceandbrowserinfo.com flags as
// hasInconsistentTimingResolution. Right after the client's Runtime.enable the
// proxy sends Runtime.setMaxCallStackSizeToCapture { size: 0 } on the same
// session (enable resets it, and the limit is per client session), with a
// negative id no client uses, and drops the reply. Clients still get console
// events and exceptions, only without the inspector's stack trace.

/** Ids of the proxy's own commands are negative; clients count up from 1. */
export const OWN_ID = -1;

/**
 * The proxy's own command to send after `text`, or null: a capture limit of
 * zero after any Runtime.enable.
 */
export function followUp(text) {
  if (typeof text !== "string" || !text.includes('"Runtime.enable"')) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (msg?.method !== "Runtime.enable") return null;
  return JSON.stringify({ id: OWN_ID, method: "Runtime.setMaxCallStackSizeToCapture", params: { size: 0 }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
}

/** Whether an upstream message is the reply to one of the proxy's own commands. */
export const isOwnReply = (text) => text.startsWith(`{"id":${OWN_ID},`);

/**
 * The CDP message text to forward upstream: `text` unchanged, or a download
 * behaviour turned to "deny". Non-JSON and other methods are returned as they are.
 */
export function rewriteClientMessage(text) {
  if (typeof text !== "string" || !text.includes("setDownloadBehavior")) return text;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return text;
  }
  if (!msg || !DOWNLOAD_METHODS.has(msg.method)) return text;
  const params = msg.params ?? {};
  if (params.behavior === "deny") return text;
  const { downloadPath: _path, ...rest } = params;
  msg.params = { ...rest, behavior: "deny" };
  return JSON.stringify(msg);
}
