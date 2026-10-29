// Copied from tvdavies/brwsr@0d22bf8 (container/agent/logs.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Session logs, in Browserbase's SessionLog shape:
//   { method, pageId, sessionId, frameId?, loaderId?, timestamp,
//     request?: { params, rawBody, timestamp }, response?: { result, rawBody, timestamp } }
//
// Two sources:
// - the agent's own CDP connection, attached to every page: page lifecycle,
//   console, exceptions, Log entries and network request/response metadata
//   (events: `request.params` holds the event's params);
// - the CDP commands clients send through the proxy, paired with their
//   responses (`request.params` and `response.result`).
// plus brwsr's own records: `brwsr.fill` (audit of a server-side fill, never
// the value) and `brwsr.logsTruncated`.
//
// What's never stored: request and response bodies, cookie and authorization
// headers, text typed with Input.* and values passed to Runtime.callFunctionOn.
// Every URL-valued field (request and response URLs, documentURL, redirects,
// Page.frameNavigated's frame, Location and Referer headers, navigate
// commands and their results) is scrubbed by url-scrub.mjs: sensitive query
// and fragment values, tokens and userinfo become [redacted].
// Every record also goes through the session's scrubber, so a filled secret
// is masked wherever it turns up. `pageId` is the page's index in the order
// brwsr first saw it (0, 1, ...); -1 is the browser itself. `rawBody` is
// always "": the parsed params and result are the record.
//
// Records are gzipped into NDJSON chunks in `dir` ({seq}.ndjson.gz); the
// session's Durable Object pulls and deletes them. Once the chunks written
// reach maxBytes, one last brwsr.logsTruncated record is written and the rest
// of the session isn't logged.
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CDP } from "./cdp.mjs";
import { scrubUrlFields } from "./url-scrub.mjs";

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const STRING_MAX = 4096;
const RESULT_STRING_MAX = 1024;
const RECORD_MAX = 32 * 1024;
/** Responses bigger than this aren't parsed (screenshots, DOM snapshots); only their size is logged. */
const PARSE_MAX = 256 * 1024;
const REDACTED = "[redacted]";
const SECRET_HEADERS = new Set(["cookie", "set-cookie", "authorization", "proxy-authorization", "x-bb-api-key", "x-api-key"]);

/** Events captured from each page. */
export const PAGE_EVENTS = new Set([
  "Page.frameNavigated",
  "Page.domContentEventFired",
  "Page.loadEventFired",
  "Page.javascriptDialogOpening",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
  "Network.loadingFinished",
]);

// ---------- shaping (pure) ----------

/** Long strings cut to `max`, with how much was cut; deep or wide structures bounded. */
export function clip(v, max = STRING_MAX, depth = 0) {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…[+${v.length - max} chars]` : v;
  if (Array.isArray(v)) {
    const out = v.slice(0, 200).map((x) => clip(x, max, depth + 1));
    if (v.length > 200) out.push(`…[+${v.length - 200} items]`);
    return out;
  }
  if (v && typeof v === "object") {
    if (depth > 12) return "[too deep]";
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = clip(x, max, depth + 1);
    return o;
  }
  return v;
}

export function redactHeaders(h) {
  if (!h || typeof h !== "object") return h;
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k] = SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  return o;
}

function netRequest(r) {
  if (!r || typeof r !== "object") return r;
  const { postData, postDataEntries, headers, ...rest } = r;
  return { ...rest, headers: redactHeaders(headers) };
}

function netResponse(r) {
  if (!r || typeof r !== "object") return r;
  const { securityDetails, headers, requestHeaders, headersText, requestHeadersText, timing, ...rest } = r;
  return { ...rest, headers: redactHeaders(headers) };
}

const frames = (st, n) => (st && Array.isArray(st.callFrames) ? { callFrames: st.callFrames.slice(0, n) } : undefined);

function remoteObject(o) {
  if (!o || typeof o !== "object") return o;
  const { objectId, preview, customPreview, ...rest } = o;
  return rest;
}

/** A page event's params as stored: no bodies, credential headers or deep stacks. */
export function eventParams(method, params = {}) {
  switch (method) {
    case "Network.requestWillBeSent": {
      const { initiator, redirectResponse, request, ...rest } = params;
      return {
        ...rest,
        request: netRequest(request),
        ...(initiator ? { initiator: { type: initiator.type, url: initiator.url, lineNumber: initiator.lineNumber } } : {}),
        ...(redirectResponse ? { redirectResponse: netResponse(redirectResponse) } : {}),
      };
    }
    case "Network.responseReceived":
      return { ...params, response: netResponse(params.response) };
    case "Runtime.consoleAPICalled":
      return {
        type: params.type,
        args: (params.args ?? []).slice(0, 20).map(remoteObject),
        executionContextId: params.executionContextId,
        timestamp: params.timestamp,
        stackTrace: frames(params.stackTrace, 3),
      };
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails ?? {};
      return {
        timestamp: params.timestamp,
        exceptionDetails: {
          text: d.text,
          url: d.url,
          lineNumber: d.lineNumber,
          columnNumber: d.columnNumber,
          exception: remoteObject(d.exception),
          stackTrace: frames(d.stackTrace, 5),
        },
      };
    }
    case "Log.entryAdded": {
      const { stackTrace, args, ...entry } = params.entry ?? {};
      return { entry: { ...entry, stackTrace: frames(stackTrace, 3) } };
    }
    default:
      return params;
  }
}

/** A client command's params as stored: typed text and function arguments are left out. */
export function commandParams(method, params = {}) {
  switch (method) {
    case "Input.insertText":
    case "Input.imeSetComposition":
      return { ...params, text: `[${String(params.text ?? "").length} chars]` };
    case "Input.dispatchKeyEvent": {
      // Named keys (Enter, Tab, ArrowDown) are kept; a typed character isn't.
      if (typeof params.key === "string" && params.key.length > 1 && !params.text) return params;
      const { text, unmodifiedText, key, code, keyIdentifier, nativeVirtualKeyCode, windowsVirtualKeyCode, ...rest } = params;
      if (text === undefined && key === undefined) return params;
      return { ...rest, key: key === undefined ? undefined : "[char]" };
    }
    case "Runtime.callFunctionOn":
      return {
        ...params,
        functionDeclaration: clip(params.functionDeclaration, 300),
        arguments: (params.arguments ?? []).map((a) => (a && "value" in a ? { type: typeof a.value } : a)),
      };
    case "Runtime.evaluate":
      return { ...params, expression: clip(params.expression, 1000) };
    case "Page.addScriptToEvaluateOnNewDocument":
      return { ...params, source: clip(params.source, 300) };
    default:
      return params;
  }
}

/** frameId and loaderId of an event, where it has them. */
function frameOf(method, params) {
  if (method === "Page.frameNavigated") return { frameId: params.frame?.id, loaderId: params.frame?.loaderId };
  return { frameId: params.frameId, loaderId: params.loaderId };
}

/** One record; its strings are bounded, and `serialise` bounds its total size. */
export function makeRecord({ method, pageId, sessionId = "", timestamp, params, result, resultTimestamp, frameId, loaderId, extra }) {
  const rec = { method, pageId, sessionId: sessionId ?? "", timestamp };
  if (frameId) rec.frameId = frameId;
  if (loaderId) rec.loaderId = loaderId;
  rec.request = { params: clip(scrubUrlFields(params ?? {})), rawBody: "", timestamp };
  if (result !== undefined) rec.response = { result: clip(scrubUrlFields(result), RESULT_STRING_MAX), rawBody: "", timestamp: resultTimestamp ?? timestamp };
  if (extra) rec.brwsr = extra;
  return rec;
}

/** A record's NDJSON line; params and result are replaced by their sizes if it's over RECORD_MAX. */
export function serialise(rec) {
  let line = JSON.stringify(rec);
  if (line.length <= RECORD_MAX) return line;
  rec.request.params = { brwsrTruncated: JSON.stringify(rec.request.params).length };
  if (rec.response) rec.response.result = { brwsrTruncated: JSON.stringify(rec.response.result).length };
  line = JSON.stringify(rec);
  return line.length <= RECORD_MAX ? line : null;
}

// ---------- the log ----------

export class SessionLog {
  constructor({ dir, scrubber, maxBytes = DEFAULT_MAX_BYTES, flushBytes = 256 * 1024, now = Date.now }) {
    this.dir = dir;
    this.scrubber = scrubber;
    this.maxBytes = maxBytes;
    this.flushBytes = flushBytes;
    this.now = now;
    this.pages = new Map(); // targetId -> pageId
    this.sessions = new Map(); // CDP sessionId (ours or a client's) -> targetId
    this.lines = [];
    this.bufBytes = 0;
    this.seq = 0;
    this.records = 0;
    this.writtenBytes = 0;
    this.truncated = false;
    this.dropped = 0;
    this.writing = Promise.resolve();
  }

  pageIdFor(targetId) {
    if (!targetId) return -1;
    let id = this.pages.get(targetId);
    if (id === undefined) this.pages.set(targetId, (id = this.pages.size));
    return id;
  }

  pageForSession(sessionId) {
    return sessionId ? this.pageIdFor(this.sessions.get(sessionId)) : -1;
  }

  add(rec) {
    if (!rec) return;
    if (this.truncated) return void this.dropped++;
    const raw = serialise(rec);
    if (raw === null) return void this.dropped++;
    const line = this.scrubber ? this.scrubber.scrubText(raw) : raw;
    this.lines.push(line);
    this.bufBytes += line.length + 1;
    this.records++;
    if (this.bufBytes >= this.flushBytes) this.flush();
  }

  /** A page event from the agent's own connection. */
  event(sessionId, method, params, timestamp = this.now()) {
    this.add(
      makeRecord({
        method,
        pageId: this.pageForSession(sessionId),
        sessionId,
        timestamp,
        params: eventParams(method, params),
        ...frameOf(method, params ?? {}),
      }),
    );
  }

  /** A browser-level record (target created or destroyed). */
  browserEvent(method, params, targetId, timestamp = this.now()) {
    this.add(makeRecord({ method, pageId: this.pageIdFor(targetId), sessionId: "", timestamp, params }));
  }

  /** Audit entry for a server-side fill: item, field, page; never the value. */
  fill({ targetId, item, field, url, selector, submitted, ok, error }, timestamp = this.now()) {
    this.add(
      makeRecord({
        method: "brwsr.fill",
        pageId: this.pageIdFor(targetId),
        sessionId: "",
        timestamp,
        params: { item, field, url, selector, submitted: !!submitted },
        result: ok ? { ok: true } : { ok: false, error },
      }),
    );
  }

  /** Pairs a client connection's commands with their responses. */
  client() {
    const pending = new Map();
    return {
      command: (text) => {
        if (this.truncated || typeof text !== "string") return;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof msg?.id !== "number" || typeof msg.method !== "string") return;
        if (pending.size > 2000) pending.delete(pending.keys().next().value);
        pending.set(msg.id, { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId ?? "", ts: this.now() });
      },
      response: (text) => {
        if (typeof text !== "string") return;
        // Learn which page a client's CDP session is on.
        if (text.includes('"Target.attachedToTarget"')) {
          try {
            const m = JSON.parse(text);
            if (m.method === "Target.attachedToTarget" && m.params?.targetInfo?.type === "page") {
              this.sessions.set(m.params.sessionId, m.params.targetInfo.targetId);
            }
          } catch {}
          return;
        }
        const head = /^\{"id":(\d+)/.exec(text);
        if (!head) return;
        const p = pending.get(Number(head[1]));
        if (!p) return;
        pending.delete(Number(head[1]));
        let result;
        if (text.length > PARSE_MAX) result = { brwsrTruncated: text.length };
        else {
          try {
            const m = JSON.parse(text);
            result = m.error ? { error: m.error } : (m.result ?? {});
          } catch {
            result = {};
          }
        }
        if (p.method === "Target.attachToTarget" && result.sessionId && p.params.targetId) this.sessions.set(result.sessionId, p.params.targetId);
        if (this.truncated) return;
        const targetId = p.params.targetId && p.method.startsWith("Target.") ? p.params.targetId : this.sessions.get(p.sessionId);
        this.add(
          makeRecord({
            method: p.method,
            pageId: this.pageIdFor(targetId),
            sessionId: p.sessionId,
            timestamp: p.ts,
            params: commandParams(p.method, p.params),
            result,
            resultTimestamp: this.now(),
          }),
        );
      },
    };
  }

  /** Write buffered records as the next chunk (or the truncation record, once over the cap). */
  flush() {
    if (!this.lines.length) return this.writing;
    let body = gzipSync(this.lines.join("\n") + "\n");
    this.lines = [];
    this.bufBytes = 0;
    if (this.writtenBytes + body.length > this.maxBytes) {
      this.truncated = true;
      const rec = makeRecord({
        method: "brwsr.logsTruncated",
        pageId: -1,
        sessionId: "",
        timestamp: this.now(),
        params: { maxBytes: this.maxBytes, writtenBytes: this.writtenBytes },
      });
      body = gzipSync(JSON.stringify(rec) + "\n");
    }
    const seq = this.seq++;
    this.writtenBytes += body.length;
    const file = path.join(this.dir, `${seq}.ndjson.gz`);
    this.writing = this.writing
      .then(() => fs.mkdir(this.dir, { recursive: true }))
      .then(() => fs.writeFile(`${file}.tmp`, body))
      .then(() => fs.rename(`${file}.tmp`, file))
      .catch((e) => console.log("log chunk write failed:", e.message));
    return this.writing;
  }

  /** Chunks written and not yet taken, oldest first. */
  async chunks() {
    await this.writing;
    const names = await fs.readdir(this.dir).catch(() => []);
    const out = [];
    for (const n of names) {
      const m = /^(\d+)\.ndjson\.gz$/.exec(n);
      if (m) out.push({ seq: Number(m[1]), bytes: (await fs.stat(path.join(this.dir, n))).size });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  summary() {
    return { records: this.records, writtenBytes: this.writtenBytes, truncated: this.truncated, dropped: this.dropped, pages: this.pages.size };
  }
}

// ---------- capture from Chromium ----------

/**
 * Attach the agent's own CDP connection to every page and feed `log`.
 * Returns a function that stops capturing.
 *
 * `console: false` leaves the Runtime domain off (advanced stealth): a page
 * can tell when a CDP client has it on, so the session's console messages
 * and uncaught exceptions aren't logged. `stacks: false` (stealth) logs them
 * without stack traces: V8 captures one on every console call for the
 * deepest limit any CDP client set, and pages can time that.
 */
export async function capture(log, browserWsUrl, { console: withConsole = true, stacks = true } = {}) {
  // Chromium sends every Network event to every session with Network enabled;
  // these are most of them and aren't logged, so they're dropped unparsed.
  const cdp = await CDP.connect(browserWsUrl, {
    skipEvents: [
      "Network.dataReceived",
      "Network.requestWillBeSentExtraInfo",
      "Network.responseReceivedExtraInfo",
      "Network.resourceChangedPriority",
      "Network.requestServedFromCache",
      "Network.policyUpdated",
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Page.lifecycleEvent",
      "Page.frameStartedLoading",
      "Page.frameStoppedLoading",
    ],
  });
  const attaching = new Set();

  async function attach(info) {
    if (info.type !== "page" || attaching.has(info.targetId)) return;
    attaching.add(info.targetId);
    log.pageIdFor(info.targetId);
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      log.sessions.set(sessionId, info.targetId);
      await Promise.all([
        cdp.send("Page.enable", {}, sessionId),
        // No post bodies, and no response bodies buffered for this connection.
        cdp.send("Network.enable", { maxPostDataSize: 0, maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId),
        ...(withConsole
          ? [
              cdp
                .send("Runtime.enable", {}, sessionId)
                .then(() => (stacks ? null : cdp.send("Runtime.setMaxCallStackSizeToCapture", { size: 0 }, sessionId))),
            ]
          : []),
        cdp.send("Log.enable", {}, sessionId),
      ]);
    } catch (e) {
      // The page closed while attaching; nothing to log.
      if (!cdp.closed) console.log("log attach failed:", e.message);
    }
  }

  cdp.on((msg) => {
    const { method, params, sessionId } = msg;
    if (!method) return;
    if (sessionId) {
      if (!PAGE_EVENTS.has(method)) return;
      // Main-frame navigations only; subframes come through Network.
      if (method === "Page.frameNavigated" && params?.frame?.parentId) return;
      log.event(sessionId, method, params);
      return;
    }
    if (method === "Target.targetCreated" && params.targetInfo?.type === "page") {
      log.browserEvent(method, { targetInfo: { targetId: params.targetInfo.targetId, url: params.targetInfo.url, openerId: params.targetInfo.openerId } }, params.targetInfo.targetId);
      void attach(params.targetInfo);
    } else if (method === "Target.targetDestroyed" && log.pages.has(params.targetId)) {
      log.browserEvent(method, { targetId: params.targetId }, params.targetId);
    }
  });

  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await cdp.send("Target.getTargets");
  await Promise.all(targetInfos.map(attach));
  return () => cdp.close();
}
