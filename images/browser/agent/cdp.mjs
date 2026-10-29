// Copied from tvdavies/brwsr@0d22bf8 (container/agent/cdp.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Minimal CDP client over a WebSocket, for the agent's own private connection
// to Chromium (live view, fills, profile export). Client CDP traffic doesn't
// go through here: it's proxied byte-for-byte (after scrubbing) in server.mjs.
import WebSocket from "ws";

export class CDP {
  /**
   * `skipEvents`: event names to drop unparsed (Chromium puts "method" first
   * in an event, so a prefix check is enough). For a connection that gets
   * floods of events it doesn't want, such as Network.dataReceived.
   */
  static async connect(url, { skipEvents = [] } = {}) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new CDP(ws, skipEvents);
  }

  constructor(ws, skipEvents = []) {
    this.ws = ws;
    this.skip = skipEvents.map((m) => `{"method":"${m}"`);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.on("message", (data) => {
      const text = data.toString();
      if (this.skip.length && text.charCodeAt(1) === 34 && this.skip.some((s) => text.startsWith(s))) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) {
        try {
          fn(msg);
        } catch {}
      }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const { reject, method } of this.pending.values()) reject(new Error(`${method}: connection closed`));
      this.pending.clear();
      for (const fn of this.listeners) {
        try {
          fn({ method: "brwsr.closed" });
        } catch {}
      }
    });
    ws.on("error", () => {});
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`${method}: connection closed`));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
