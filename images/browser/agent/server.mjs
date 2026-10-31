// Copied from tvdavies/brwsr@0d22bf8 (container/agent/server.mjs) for Kantel's browser runtime
// (docs/design/browser-runtime.md). Kantel changes: dropped CAPTCHA, ad blocking, proxies/tunnels, loopback forwarding and server-side fills,
// and extensions and downloads (refused at /start; Chrome denies every download).
// brwsr in-container agent. Only the session's Durable Object can reach it
// from outside (Containers accept traffic from their DO alone); the browser
// in this container can reach it on loopback, so every call but GET /health
// needs the token the DO started the container with (auth.mjs). Port 8080:
//
//   GET  /health                 agent up? Chrome running? which image build and stealth version
//   PUT  /profile                tar.gz of /data/profile to restore (before /start)
//   POST /start                  launch Chromium {viewport, ignoreCertificateErrors}
//   GET  /status                 clients, idle time, memory and CPU
//   GET  /pages                  page targets (for /v1/sessions/:id/debug)
//   POST /reflex/run             Reflex: run a task on the page (reflex/; keys come from the Worker)
//   POST /reflex/act             Reflex: one action, by element or by instruction
//   POST /reflex/look            Reflex: the page and its elements as Reflex sees them
//   POST /conceal                {values: [...]} mask these in CDP output and session logs
//                                (a Playground run's secret variables)
//   POST /export                 close Chromium cleanly, return tar.gz of the profile
//   GET  /export/meta            cookie domains of the last export (counts and expiry, no names or values)
//   POST /stop                   stop Chromium ({fast: true}: kill it; warm-pool relaunch)
//   POST /viewport               resize the window(s) {width, height} (warm-pool sessions)
//   POST /domains                allowed domains {domains: [...]}, [] for none (after /start)
//   PUT  /uploads/:name          file for the page's <input type=file>
//   POST /logs/start             start session-log capture {maxBytes} (after /start)
//   GET  /logs/chunks            log chunks written and not yet taken, and totals
//   GET  /logs/chunks/:seq       one chunk (gzipped NDJSON of SessionLog records)
//   DELETE /logs/chunks/:seq     the Durable Object has stored it
//   POST /logs/flush             write what's buffered as a chunk; then /logs/chunks
//   POST /recording/start        capture every page's frames (after /start) {maxPages, quality, maxFps, segmentSeconds, onPressure, shareLive, shareMinScale}
//   GET  /recording              pages and their closed chunks of frames not yet taken
//   POST /recording/stop         stop capturing and close each page's last chunk
//   GET  /recording/:page/:file  a closed NNNNN.mkv chunk (JPEG frames in Matroska)
//   DELETE /recording/:page/:file  the Durable Object has stored it
//   WS   /cdp                    CDP proxy to the browser endpoint (scrubbed)
//   WS   /live                   live view: JPEG screencast out, input events in
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { CDP } from "./cdp.mjs";
import { Scrubber } from "./scrub.mjs";
import { agentAllowed } from "./auth.mjs";
import { cookieDomains } from "./cookies.mjs";
import { followUp, isOwnReply, rewriteClientMessage } from "./cdp-rewrite.mjs";
import { SessionLog, capture as captureLogs } from "./logs.mjs";
import { guardNavigations, hostAllowed } from "./domains.mjs";
import { Recorder } from "./recorder.mjs";
import { FramePacer } from "./live-pacer.mjs";
import { reflexAct, reflexLook, reflexRun, ReflexError } from "./reflex.mjs";
import { LiveAdapt, REDUCED, cpuMeter, hostCpu } from "./live-adapt.mjs";
import { emulateTouch, inputMode as parseInputMode, touchEvent } from "./touch.mjs";
import { languagesForGeo, startStealth, STEALTH_VERSION, stealthArgs, userAgentString } from "./stealth.mjs";
import { egressGeo } from "./geo.mjs";

const run = promisify(execFile);
const PORT = 8080;
// From the Durable Object, at container start; not left in the environment
// Chromium and its children inherit.
const AGENT_TOKEN = process.env.AGENT_TOKEN || "";
delete process.env.AGENT_TOKEN;
const CDP_PORT = 9222;
const DATA = "/data";
const PROFILE = `${DATA}/profile`;
const EXT_DIR = `${DATA}/extensions`;
const UPLOADS = "/tmp/.uploads";
const SESSION_COOKIES = `${PROFILE}/brwsr-session-cookies.json`;
const ENGINES = {
  chromium: process.env.CHROME_PATH || "/usr/bin/chromium",
  "headless-shell": process.env.HEADLESS_SHELL_PATH || "/opt/chrome-headless-shell-linux64/chrome-headless-shell",
};
const PROFILE_TEMPLATE = process.env.PROFILE_TEMPLATE || "/opt/profile-template";
const bootAt = Date.now();

let chrome = null;
let browserWsUrl = null;
const chromeVersions = {};
let chromeExited = null;
let engine = "chromium";
const proxyClients = new Set();
const liveClients = new Set();
let everConnected = false;
let lastClientAt = Date.now();
const scrubber = new Scrubber();
let exportMeta = { cookieDomains: [] };
const LOG_DIR = "/tmp/.logs";
/** The session log, once /logs/start has been called (null: logSession is off or not started). */
let sessionLog = null;
let stopLogCapture = null;
/** The session recording, once /recording/start has been called. */
let recorder = null;
/** Flush buffered log records every few seconds, so a crash loses little. */
setInterval(() => sessionLog?.flush(), 5000).unref();

/** The allowed-domains guard on the running browser, if the session has one. */
let guard = null;

/** The stealth connection on the running browser (stealth.mjs). */
let stealth = null;
/** Where this container's own traffic comes out (geo.mjs), asked once at boot. */
const bootGeo = egressGeo();

/**
 * A tab whose top frame was kept off a site shows Chrome's error page, but
 * its target still reports the URL it tried: say it was blocked.
 */
function describePage(url, title) {
  if (guard && /^https?:/i.test(url) && !hostAllowed(url, guard.domains)) return { title: "Blocked: not an allowed domain", blocked: true };
  return { title };
}

/** Navigations blocked by guards already dropped (the count survives a guard change). */
let blockedTotal = 0;

function dropGuard() {
  if (guard) blockedTotal += guard.blocked;
  guard?.stop();
  guard = null;
}

async function setDomains(domains) {
  if (!browserWsUrl) throw Object.assign(new Error("browser_not_running"), { status: 409 });
  dropGuard();
  if (!domains.length) return { domains: [] };
  const proc = chrome;
  const g = await guardNavigations(browserWsUrl, domains, {
    onLost: () => {
      // Never leave the browser running unguarded: stop it, and the session ends.
      if (guard !== g || chrome !== proc) return;
      console.error("allowed domains: the guard's connection dropped; stopping the browser");
      blockedTotal += g.blocked;
      guard = null;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    },
  });
  guard = g;
  return { domains, pages: g.pages };
}

/**
 * The live view's input mode, for the whole session (touch.mjs): "mouse", or
 * "touch" with every page emulating a touchscreen. `chosen` once a viewer
 * has picked one, so a phone that takes control later doesn't override it.
 */
let inputMode = { mode: "mouse", chosen: false };
let touchEmulation = null;
/** Mode changes, one at a time. */
let inputModeChange = Promise.resolve();

function sendInputMode() {
  const m = JSON.stringify({ type: "inputMode", ...inputMode });
  for (const c of liveClients) if (c.readyState === WebSocket.OPEN) c.send(m);
}

function setInputMode(mode) {
  const run = async () => {
    if (mode === "touch" && !touchEmulation) {
      if (!browserWsUrl) throw new Error("browser not running");
      const proc = chrome;
      const t = await emulateTouch(browserWsUrl);
      // The browser went while it was being set up.
      if (chrome !== proc) return void t.stop();
      touchEmulation = t;
    } else if (mode === "mouse" && touchEmulation) {
      const t = touchEmulation;
      touchEmulation = null;
      await t.stop();
    }
    inputMode = { mode, chosen: true };
    sendInputMode();
  };
  inputModeChange = inputModeChange.then(run, run);
  return inputModeChange;
}

/** A new browser starts with a mouse. */
function dropInputMode() {
  touchEmulation?.stop().catch(() => {});
  touchEmulation = null;
  inputMode = { mode: "mouse", chosen: false };
}

// ---------- helpers ----------

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const b = await readBody(req);
  return b.length ? JSON.parse(b.toString("utf8")) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectVersion(name = "chromium") {
  if (chromeVersions[name]) return chromeVersions[name];
  try {
    // Written at image build time; running `--version` costs ~0.3 s at 1/4 vCPU.
    const file = `/opt/${name}.version`;
    const stdout = (await fileExists(file))
      ? await fs.readFile(file, "utf8")
      : (await run(ENGINES[name], ["--version"])).stdout;
    chromeVersions[name] = stdout.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null;
  } catch {}
  return chromeVersions[name];
}

/** Name of the first entry in a tar.gz, without listing the rest. */
function firstTarEntry(file) {
  return new Promise((resolve) => {
    const p = spawn("tar", ["-tzf", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString();
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        p.kill();
        resolve(out.slice(0, nl));
      }
    });
    p.on("exit", () => resolve(out.split("\n")[0]));
  });
}

// ---------- metrics ----------

async function readNum(p) {
  try {
    return Number((await fs.readFile(p, "utf8")).trim().split(/\s+/)[0]);
  } catch {
    return null;
  }
}

async function chromePids() {
  const out = [];
  for (const d of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = await fs.readFile(`/proc/${d}/cmdline`, "utf8");
      if (cmd.includes("chromium") || cmd.includes("chrome-headless-shell")) out.push(d);
    } catch {}
  }
  return out;
}

async function memoryStats() {
  const meminfo = {};
  try {
    for (const line of (await fs.readFile("/proc/meminfo", "utf8")).split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) meminfo[m[1]] = Number(m[2]) * 1024;
    }
  } catch {}
  let chromePss = 0;
  let chromeProcs = 0;
  for (const pid of await chromePids()) {
    try {
      const r = await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const m = r.match(/^Pss:\s+(\d+)/m);
      if (m) {
        chromePss += Number(m[1]) * 1024;
        chromeProcs++;
      }
    } catch {}
  }
  return {
    totalBytes: meminfo.MemTotal ?? null,
    usedBytes: meminfo.MemTotal && meminfo.MemAvailable ? meminfo.MemTotal - meminfo.MemAvailable : null,
    cgroupCurrentBytes: await readNum("/sys/fs/cgroup/memory.current"),
    cgroupPeakBytes: await readNum("/sys/fs/cgroup/memory.peak"),
    chromePssBytes: chromePss,
    chromeProcesses: chromeProcs,
  };
}

let cpuModelName;
async function cpuModel() {
  if (cpuModelName === undefined) {
    const info = await fs.readFile("/proc/cpuinfo", "utf8").catch(() => "");
    const f = (k) => info.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "m"))?.[1].trim();
    // A VM's model name can be as vague as "AMD EPYC"; family and model tell generations apart.
    cpuModelName = f("model name") ? `${f("model name")} (family ${f("cpu family")} model ${f("model")}, ${f("cpu MHz")} MHz)` : null;
  }
  return cpuModelName;
}

async function cpuStats() {
  try {
    const line = (await fs.readFile("/proc/stat", "utf8")).split("\n")[0].split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = line;
    return { busySeconds: (user + nice + system + irq + softirq) / 100, idleSeconds: (idle + iowait) / 100, stealSeconds: (steal || 0) / 100 };
  } catch {
    return null;
  }
}

// ---------- chromium ----------

function chromeArgs({ viewport, ignoreCertificateErrors, extensions, userAgent, engine, extraArgs = [] }) {
  const w = viewport?.width || 1280;
  const h = viewport?.height || 720;
  const args = [
    ...(engine === "chromium" ? ["--headless=new"] : []),
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    // The Firecracker VM is the isolation boundary; Chromium's own sandbox
    // needs privileges the container doesn't have.
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-breakpad",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--metrics-recording-only",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions,PrivacySandboxSettings4",
    `--window-size=${w},${h}`,
  ];
  if (userAgent) args.push(`--user-agent=${userAgent}`);
  args.push(...extraArgs);
  if (ignoreCertificateErrors) args.push("--ignore-certificate-errors");
  if (extensions?.length) {
    const dirs = extensions.join(",");
    args.push(`--load-extension=${dirs}`, `--disable-extensions-except=${dirs}`, "--enable-unsafe-extension-debugging");
  }
  args.push("about:blank");
  return args;
}

async function extensionDir(id) {
  const base = path.join(EXT_DIR, id);
  if (await fileExists(path.join(base, "manifest.json"))) return base;
  for (const d of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && (await fileExists(path.join(base, d.name, "manifest.json")))) return path.join(base, d.name);
  }
  return null;
}

async function startChrome(opts) {
  if (chrome) throw Object.assign(new Error("already started"), { status: 409 });
  const t0 = Date.now();
  engine = opts.engine === "headless-shell" ? "headless-shell" : "chromium";
  if (opts.extensions?.length) {
    throw Object.assign(new Error("Kantel's browsers load no extensions"), { status: 400 });
  }
  const version = await detectVersion(engine);
  const major = version?.split(".")[0];
  // New headless reports "HeadlessChrome" in its UA; report a normal Chrome UA.
  const userAgent = major ? userAgentString(major) : undefined;
  const extDirs = [];
  // No restored context: start from the first-run template baked into the image.
  if (!(await fileExists(PROFILE)) && (await fileExists(PROFILE_TEMPLATE))) {
    await run("cp", ["-a", PROFILE_TEMPLATE, PROFILE]);
  }
  await fs.rm(path.join(PROFILE, "SingletonLock"), { force: true });
  await fs.rm(path.join(PROFILE, "DevToolsActivePort"), { force: true });
  // Stealth (stealth.mjs): the screen and languages are flags, the time zone
  // the process's TZ, so every page, frame and worker agrees on them.
  const st = opts.stealth || null;
  let place = null;
  const extraArgs = [];
  const env = { ...process.env };
  if (st) {
    const tGeo = Date.now();
    // The boot-time answer is usually in by now; a launch waits at most 1.5 s for it.
    const geo = st.geo?.timezone ? null : await Promise.race([bootGeo, sleep(1500).then(() => null)]);
    // A context's kept place gives its languages as stored; otherwise they follow the locale.
    const languages = languagesForGeo(st.geo);
    const timezone = st.geo?.timezone || geo?.timezone || null;
    place = { timezone, languages, country: geo?.country ?? null, colo: geo?.colo ?? null, from: st.geo?.timezone ? "session" : geo ? "egress" : "none", geoMs: Date.now() - tGeo };
    if (timezone) env.TZ = timezone;
    console.log(`stealth: tz=${timezone ?? "UTC"} (${place.from}${geo ? ` ${geo.country}/${geo.colo}` : ""}, ${place.geoMs} ms)`);
    extraArgs.push(...stealthArgs(st.profile, { window: opts.viewport, languages }));
  }
  // Own process group, so a fast stop can kill the renderers and zygotes too.
  const proc = spawn(ENGINES[engine], chromeArgs({ ...opts, engine, extensions: extDirs, userAgent, extraArgs }), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
    env,
  });
  chrome = proc;
  chromeExited = new Promise((resolve) => proc.once("exit", resolve));
  let stderrTail = "";
  proc.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000);
  });
  proc.once("exit", (code, signal) => {
    if (chrome === proc) {
      stealth?.stop();
      stealth = null;
      dropGuard();
      dropInputMode();
      chrome = null;
      browserWsUrl = null;
      for (const c of [...proxyClients, ...liveClients]) c.close(1001, "browser exited");
    }
    console.log(`chromium exited code=${code} signal=${signal}`);
  });

  // Wait for the DevTools endpoint.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!chrome) throw new Error(`chromium exited during launch: ${stderrTail.slice(-500)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) {
        browserWsUrl = (await r.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(25);
  }
  if (!browserWsUrl) throw new Error("chromium did not open its DevTools endpoint in 30s");
  const launchMs = Date.now() - t0;

  // Downloads (denied: nothing a page offers is saved) and session cookies over a short-lived private connection.
  const cdp = await CDP.connect(browserWsUrl);
  try {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    if (await fileExists(SESSION_COOKIES)) {
      const cookies = JSON.parse(await fs.readFile(SESSION_COOKIES, "utf8"));
      await cdp.send("Storage.setCookies", { cookies }).catch((e) => console.log("restore session cookies:", e.message));
      await fs.rm(SESSION_COOKIES, { force: true });
    }
  } finally {
    cdp.close();
  }
  if (st) {
    stealth = await startStealth(browserWsUrl, {
      fullVersion: version,
      profile: st.profile,
      languages: place.languages,
      locale: st.geo?.locale ?? null,
      shell: engine === "headless-shell",
      log: (m) => console.log(m),
    }).catch(async (e) => {
      // A browser without its stealth set up would give the session away: stop it.
      await stopChrome({ fast: true }).catch(() => {});
      throw new Error(`stealth didn't start: ${e.message}`);
    });
  }
  return { launchMs: Date.now() - t0, chromeMs: launchMs, version, engine, extensions: extDirs.length, stealth: place };
}

async function stopChrome({ saveSessionCookies, fast = false }) {
  if (!chrome || !browserWsUrl) return;
  const proc = chrome;
  stealth?.stop();
  stealth = null;
  dropGuard();
  dropInputMode();
  if (fast) {
    // A warm-pool browser restarting for its session: nothing in it to keep.
    // Kill the whole group, and drop the profile: a profile left unclean by
    // SIGKILL makes the next Chrome run crash recovery, which on a quarter
    // vCPU cost several seconds. The next start copies the template again.
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
    await chromeExited;
    await fs.rm(PROFILE, { recursive: true, force: true });
    return;
  }
  try {
    const cdp = await CDP.connect(browserWsUrl);
    if (saveSessionCookies) {
      // Session cookies die with the browser; keep them so a context resumes logged in.
      const { cookies } = await cdp.send("Storage.getCookies", {});
      exportMeta = { cookieDomains: cookieDomains(cookies) };
      const session = cookies
        .filter((c) => c.session)
        .map(({ name, value, domain, path, secure, httpOnly, sameSite, priority, sourceScheme, partitionKey }) => ({
          name,
          value,
          domain,
          path,
          secure,
          httpOnly,
          ...(sameSite ? { sameSite } : {}),
          ...(priority ? { priority } : {}),
          ...(sourceScheme ? { sourceScheme } : {}),
          ...(partitionKey ? { partitionKey } : {}),
        }));
      await fs.writeFile(SESSION_COOKIES, JSON.stringify(session));
    }
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
  } catch (e) {
    console.log("graceful close failed:", e.message);
  }
  const exited = await Promise.race([chromeExited.then(() => true), sleep(10000).then(() => false)]);
  if (!exited) {
    proc.kill("SIGKILL");
    await chromeExited;
  }
}

// ---------- pages ----------

async function pageTargets(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
}

// ---------- thumbnail ----------

/**
 * A JPEG of the most recently active page, `width` px wide, on its own CDP
 * connection. /json/list puts the most recently active target first. Gives
 * up after 6 s (a page that never paints shouldn't hold up a release).
 */
async function thumbnail(width) {
  const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === "page");
  const target = list.find((t) => !t.url.startsWith("devtools://")) ?? list[0];
  if (!target) return null;
  const cdp = await CDP.connect(browserWsUrl);
  try {
    const work = (async () => {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.id, flatten: true });
      const m = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
      const vw = m.cssLayoutViewport?.clientWidth || 1280;
      const vh = m.cssLayoutViewport?.clientHeight || 720;
      const { data } = await cdp.send(
        "Page.captureScreenshot",
        { format: "jpeg", quality: 70, clip: { x: 0, y: 0, width: vw, height: vh, scale: width / vw }, captureBeyondViewport: false },
        sessionId,
      );
      return Buffer.from(data, "base64");
    })();
    return await Promise.race([work, sleep(6000).then(() => null)]);
  } finally {
    cdp.close();
  }
}

// ---------- live view ----------

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
function modifiers(m = {}) {
  return (m.alt ? MOD.alt : 0) | (m.ctrl ? MOD.ctrl : 0) | (m.meta ? MOD.meta : 0) | (m.shift ? MOD.shift : 0);
}

const clamp = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};

/**
 * Live view. Two protocols on one socket:
 *
 *   v=2 (live.js): each binary frame is an 8-byte big-endian float64 (the
 *   frame's capture time, ms since the epoch) followed by the JPEG. The client
 *   sends {type:"ack"} for each frame as it arrives, and only then does
 *   Chrome get its screencastFrameAck (live-pacer.mjs).
 *   So at most `inflight` frames are on their way end to end: frames never
 *   queue up in the agent, the Durable Object or the network, whatever the
 *   connection. `fps` caps the frame rate, leaving CPU for the page and input;
 *   `w`/`h` are the viewer's canvas size in device pixels, so a small view
 *   gets small frames. {type:"size", w, h} changes it later. `window` (or
 *   LIVE_WINDOW, default 4) lets that many more frames run ahead of the
 *   viewer's acks while they come back quickly (live-pacer.mjs). When Chrome was held at `inflight` and the page then goes
 *   still, settle() sends one screenshot so the view doesn't stop on a stale
 *   frame (`last=1` has Chrome do that itself, at a CPU cost on every frame).
 *
 *   no v (older live views and embeds): bare JPEG frames, acked to Chrome as
 *   they arrive, as before. Frames can pile up in buffers on a slow link.
 *
 *   Adaptive picture (v2, live-adapt.mjs): while the browser is out of CPU
 *   and frames come slowly, frames drop to half size at JPEG quality 40, and
 *   go back once it has CPU to spare. A viewer's own `scale` or `quality`
 *   wins over it (whichever it gives isn't adapted; both, and nothing is).
 *   On by default; `adapt=0` on the socket (or the live page) or LIVE_ADAPT=0
 *   in the agent's environment turns it off. {type:"adapt", level, ...} tells
 *   the viewer what it's getting, once at the start (with off:true when it's
 *   off) and on every change, with the host's CPU model for diagnosis.
 *
 * Mouse moves and wheel turns are coalesced while one is still being
 * dispatched (the newest move wins, wheel deltas add up), so a slow browser
 * never works through a backlog of stale input; presses and releases go at
 * once.
 *
 * One screencast, not two (recorder.mjs share()): while the session is
 * recorded, every frame of the page on view goes to the recording too, and
 * the recorder stops its own screencast of that page. So that a viewer that
 * falls behind doesn't hold up the recording, Chrome is acked at least
 * RECORDING_SHARE_MIN_FPS times a second (default 10) whatever the viewer's
 * acks; frames the viewer has no room for go only to the recording, and the
 * viewer gets the newest of them once it has. Leaving a page (closing, or
 * switching tab), the screencast carries on until the recorder's own has
 * taken over (1 s at most), so the recording has no gap.
 */
const LIVE_FPS = Number(process.env.LIVE_FPS) || 60;
const LIVE_ADAPT = process.env.LIVE_ADAPT ?? "1";
const LIVE_INFLIGHT = Number(process.env.LIVE_INFLIGHT) || 3;
const LIVE_WINDOW = process.env.LIVE_WINDOW ?? "4";
/** How long after Chrome's ack to wait for a frame before settle() takes a screenshot. */
const SETTLE_MS = 400;
/** While the recording takes the live view's frames, Chrome gets an ack at least this often (ms), however far behind the viewer is. */
const SHARE_FLOOR_MS = 1000 / (Number(process.env.RECORDING_SHARE_MIN_FPS) || 10);
/** A whole number from lo to hi, 0 included; def otherwise. */
const count = (v, lo, hi, def) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
};

async function liveSession(ws, params) {
  liveClients.add(ws);
  const quality = clamp(params.get("quality"), 20, 90, 60);
  const v2 = params.get("v") === "2";
  // What the viewer chose itself stays as it chose.
  const adaptQuality = !params.get("quality");
  const adaptSize = !params.get("scale");
  const adaptive = v2 && (params.get("adapt") ?? LIVE_ADAPT) !== "0" && (adaptQuality || adaptSize);
  /** 0: the viewer's picture; 1: REDUCED (live-adapt.mjs). */
  let level = 0;
  const fps = clamp(params.get("fps"), 1, 60, LIVE_FPS);
  const inflight = clamp(params.get("inflight"), 1, 4, LIVE_INFLIGHT);
  const runAhead = count(params.get("window"), 0, 8, count(LIVE_WINDOW, 0, 8, 4));
  // Chrome stores the newest frame while acks are outstanding and sends it on
  // the next ack, so the view never ends on a stale frame.
  // Off by default: it makes Chrome capture and encode every frame it draws
  // (about a sixth of a vCPU at 60 fps), to keep the newest; settle() covers
  // the one case it's for.
  const sendLastFrame = params.get("last") === "1";
  let maxWidth = clamp(params.get("w"), 160, 3840, 1920);
  let maxHeight = clamp(params.get("h"), 120, 2400, 1200);
  let cdp;
  try {
    cdp = await CDP.connect(browserWsUrl);
  } catch {
    ws.close(1011, "browser not running");
    liveClients.delete(ws);
    return;
  }
  let sessionId = null;
  let targetId = null;
  let lastMeta = "";
  /** The recording's share of this screencast (recorder.mjs), while the session records. */
  let share = null;
  /** CDP sessions of pages left behind whose screencast the recording still needs, until its own takes over. */
  const leaving = new Map();
  /** The most frames the viewer may have unacked; past that, frames go only to the recording. */
  const viewLimit = inflight + runAhead;
  /** The newest frame the viewer had no room for: [Chrome's frame number, bytes]. */
  let pendingView = null;
  const send = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  const pacer = new FramePacer({
    fps,
    window: runAhead,
    floorMs: () => (share?.current ? SHARE_FLOOR_MS : 0),
    ack: (frame) => {
      if (!sessionId) return;
      cdp.send("Page.screencastFrameAck", { sessionId: frame }, sessionId).catch(() => {});
      if (mayHaveDropped) {
        mayHaveDropped = false;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(settle, SETTLE_MS);
      }
    },
  });

  /**
   * Chrome drops the frames it draws while maxFramesInFlight frames await an
   * ack (unless sendLastFrame, which costs it CPU on every frame). So if the
   * page went still just then, its last frame would never come. When Chrome
   * was held like that and nothing new arrives soon after its ack, send one
   * screenshot of how the page looks now instead.
   */
  const frame8 = (jpeg, ms) => {
    const f = Buffer.allocUnsafe(8 + jpeg.length);
    f.writeDoubleBE(ms, 0);
    jpeg.copy(f, 8);
    return f;
  };
  let mayHaveDropped = false;
  let settleTimer = null;
  let framesIn = 0;
  async function settle() {
    settleTimer = null;
    const sid = sessionId;
    const seen = framesIn;
    if (!sid || ws.readyState !== WebSocket.OPEN) return;
    const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality, optimizeForSpeed: true }, sid).catch(() => null);
    // A screencast frame since is as new: nothing to add.
    if (!shot || sid !== sessionId || framesIn !== seen || ws.readyState !== WebSocket.OPEN) return;
    const jpeg = Buffer.from(shot.data, "base64");
    share?.frame(jpeg, Date.now() / 1000);
    pacer.extra();
    ws.send(frame8(jpeg, Date.now()), { binary: true });
  }

  function startScreencast(sid) {
    pacer.reset();
    pendingView = null;
    const k = level && adaptSize ? REDUCED.scale : 1;
    return cdp.send(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: level && adaptQuality ? Math.min(quality, REDUCED.quality) : quality,
        maxWidth: Math.max(160, Math.round(maxWidth * k)),
        maxHeight: Math.max(120, Math.round(maxHeight * k)),
        everyNthFrame: 1,
        ...(v2 ? { maxFramesInFlight: inflight, sendLastFrame } : {}),
      },
      sid,
    );
  }

  /**
   * Mouse and touch events, in order. Moves and wheel turns are coalesced
   * while one is still being dispatched: the newest move wins, wheel deltas
   * add up, and what's waiting goes as soon as the one in flight is done.
   * Presses and releases (and touches starting or ending) never wait: they go
   * at once, after any waiting move (CDP keeps one session's commands in
   * order), so a click costs no extra round trip.
   */
  let coalescedInFlight = 0;
  let waiting = null;
  const COALESCED = new Set(["mouseMoved", "mouseWheel", "touchMove"]);
  const dispatch = ({ method, params, sid }) => cdp.send(method, params, sid).catch((e) => send({ type: "error", message: e.message }));
  function dispatchCoalesced(item) {
    coalescedInFlight++;
    dispatch(item).finally(() => {
      coalescedInFlight--;
      if (coalescedInFlight === 0 && waiting) {
        const next = waiting;
        waiting = null;
        dispatchCoalesced(next);
      }
    });
  }
  function pointer(params, sid, method = "Input.dispatchMouseEvent") {
    const item = { method, params, sid };
    if (!COALESCED.has(params.type)) {
      if (waiting) dispatchCoalesced(waiting);
      waiting = null;
      dispatch(item);
      return;
    }
    if (coalescedInFlight === 0) return dispatchCoalesced(item);
    if (waiting && waiting.sid === sid && waiting.params.type === params.type) {
      waiting.params =
        params.type === "mouseWheel" ? { ...params, deltaX: waiting.params.deltaX + params.deltaX, deltaY: waiting.params.deltaY + params.deltaY } : params;
      return;
    }
    if (waiting) dispatchCoalesced(waiting);
    waiting = item;
  }

  async function sendTargets() {
    const pages = await pageTargets(cdp).catch(() => []);
    send({ type: "targets", active: targetId, targets: pages.map((p) => ({ id: p.targetId, url: p.url, ...describePage(p.url, p.title) })) });
    return pages;
  }

  /**
   * Stop showing the page on view. Without a share, its screencast stops at
   * once. With one, it carries on (acked as frames come, and every frame
   * going to the recording) until the recorder's own screencast has taken
   * back over. Resolves with the old CDP session once its screencast stopped.
   */
  function leave() {
    const old = sessionId;
    const oldShare = share;
    sessionId = null;
    share = null;
    if (!old) return Promise.resolve(null);
    const held = pacer.unacked.slice();
    pacer.reset();
    pendingView = null;
    const stop = async () => {
      leaving.delete(old);
      await cdp.send("Page.stopScreencast", {}, old).catch(() => {});
      return old;
    };
    if (!oldShare) return stop();
    leaving.set(old, oldShare);
    // Chrome holds the screencast until these are acked.
    for (const f of held) cdp.send("Page.screencastFrameAck", { sessionId: f }, old).catch(() => {});
    return oldShare.release().then(stop);
  }

  async function attach(tid) {
    if (sessionId) {
      const handingBack = !!share;
      const left = leave().then((old) => old && cdp.send("Target.detachFromTarget", { sessionId: old }).catch(() => {}));
      // The recording's hand-back runs alongside: the new page needn't wait for it.
      if (!handingBack) await left;
    }
    const r = await cdp.send("Target.attachToTarget", { targetId: tid, flatten: true });
    sessionId = r.sessionId;
    targetId = tid;
    lastMeta = "";
    await cdp.send("Page.enable", {}, sessionId).catch(() => {});
    await cdp.send("Target.activateTarget", { targetId: tid }).catch(() => {});
    await startScreencast(sessionId);
    share = recorder?.share(tid) ?? null;
    await sendTargets();
  }

  let targetsTimer = null;
  cdp.on((m) => {
    if (m.method === "Page.screencastFrame" && leaving.has(m.sessionId)) {
      // A page left behind, until the recording's own screencast takes over: frames go to the recording only.
      leaving.get(m.sessionId).frame(Buffer.from(m.params.data, "base64"), m.params.metadata.timestamp ?? Date.now() / 1000);
      cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
    } else if (m.method === "Page.screencastFrame" && m.sessionId === sessionId) {
      const meta = JSON.stringify({ w: m.params.metadata.deviceWidth, h: m.params.metadata.deviceHeight });
      if (meta !== lastMeta) {
        lastMeta = meta;
        send({ type: "meta", ...JSON.parse(meta) });
      }
      const jpeg = Buffer.from(m.params.data, "base64");
      const ts = m.params.metadata.timestamp ?? Date.now() / 1000;
      // Recording started after this page came on view: share from now on.
      share ??= recorder?.share(targetId) ?? null;
      share?.frame(jpeg, ts);
      if (v2) {
        if (ws.readyState !== WebSocket.OPEN) return;
        framesIn++;
        clearTimeout(settleTimer);
        settleTimer = null;
        const frame = frame8(jpeg, ts * 1000);
        // A viewer that's behind while the recording paces Chrome: this one waits, newest first.
        if (pacer.outstanding >= viewLimit && share?.current) {
          pendingView = [m.params.sessionId, frame];
          pacer.sent(m.params.sessionId, false);
          mayHaveDropped = true;
          return;
        }
        pendingView = null;
        pacer.sent(m.params.sessionId);
        // Chrome can't send another until an ack: anything it draws meanwhile is dropped.
        if (pacer.held >= inflight && !sendLastFrame) mayHaveDropped = true;
        ws.send(frame, { binary: true });
        return;
      }
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) {
        ws.send(jpeg, { binary: true });
      }
      cdp.send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, sessionId).catch(() => {});
    } else if (m.method && m.method.startsWith("Target.target")) {
      clearTimeout(targetsTimer);
      targetsTimer = setTimeout(async () => {
        const pages = await sendTargets();
        if (targetId && !pages.some((p) => p.targetId === targetId) && pages[0]) attach(pages[0].targetId).catch(() => {});
      }, 150);
    } else if (m.method === "brwsr.closed") {
      send({ type: "ended" });
      ws.close(1001, "browser closed");
    }
  });

  // Listen before the first frame goes out: a lost ack would hold a frame in flight for good.
  ws.on("message", async (data, isBinary) => {
    if (isBinary || !sessionId) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const sid = sessionId;
    // Someone has taken control: the recording counts it as the agent acting (recorder.mjs clientBusy).
    if (msg.type !== "ack" && msg.type !== "size") recorder?.clientBusy(0);
    try {
      switch (msg.type) {
        case "ack":
          pacer.clientAck();
          if (pendingView && pacer.outstanding < viewLimit && ws.readyState === WebSocket.OPEN) {
            const [f, frame] = pendingView;
            pendingView = null;
            pacer.lateSend(f);
            ws.send(frame, { binary: true });
          }
          break;
        case "size": {
          const w = clamp(msg.w, 160, 3840, maxWidth);
          const h = clamp(msg.h, 120, 2400, maxHeight);
          if (w === maxWidth && h === maxHeight) break;
          maxWidth = w;
          maxHeight = h;
          await cdp.send("Page.stopScreencast", {}, sid).catch(() => {});
          await startScreencast(sid);
          break;
        }
        case "mouse":
          pointer(
            {
              type: msg.event,
              x: msg.x,
              y: msg.y,
              button: msg.button ?? "none",
              buttons: msg.buttons ?? 0,
              clickCount: msg.clickCount ?? 0,
              deltaX: msg.deltaX ?? 0,
              deltaY: msg.deltaY ?? 0,
              modifiers: modifiers(msg.modifiers),
            },
            sid,
          );
          break;
        // Anything else this switch doesn't know is ignored, so these two are checked here.
        case "touch": {
          const params = touchEvent(msg, modifiers(msg.modifiers));
          if (params) pointer(params, sid, "Input.dispatchTouchEvent");
          break;
        }
        case "inputMode": {
          const mode = parseInputMode(msg);
          if (mode) await setInputMode(mode);
          break;
        }
        case "key": {
          const printable = typeof msg.key === "string" && msg.key.length === 1;
          const text = msg.key === "Enter" ? "\r" : printable && !(msg.modifiers?.ctrl || msg.modifiers?.meta) ? msg.key : undefined;
          await cdp.send(
            "Input.dispatchKeyEvent",
            {
              type: msg.event === "keyDown" ? (text ? "keyDown" : "rawKeyDown") : "keyUp",
              key: msg.key,
              code: msg.code,
              windowsVirtualKeyCode: msg.keyCode,
              nativeVirtualKeyCode: msg.keyCode,
              modifiers: modifiers(msg.modifiers),
              ...(msg.event === "keyDown" && text ? { text, unmodifiedText: text } : {}),
            },
            sid,
          );
          break;
        }
        case "text":
          await cdp.send("Input.insertText", { text: String(msg.text ?? "") }, sid);
          break;
        case "navigate": {
          let url = String(msg.url || "").trim();
          if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
          if (url) await cdp.send("Page.navigate", { url }, sid);
          break;
        }
        case "back":
          await cdp.send("Runtime.evaluate", { expression: "history.back()" }, sid);
          break;
        case "forward":
          await cdp.send("Runtime.evaluate", { expression: "history.forward()" }, sid);
          break;
        case "reload":
          await cdp.send("Page.reload", {}, sid);
          break;
        case "switch":
          await attach(String(msg.targetId));
          break;
        case "newTab": {
          const { targetId: tid } = await cdp.send("Target.createTarget", { url: "about:blank" });
          await attach(tid);
          break;
        }
      }
    } catch (e) {
      send({ type: "error", message: e.message });
    }
  });

  let adaptTimer = null;
  let closed = false;
  ws.on("close", () => {
    closed = true;
    liveClients.delete(ws);
    clearTimeout(targetsTimer);
    clearTimeout(settleTimer);
    clearTimeout(adaptTimer);
    pacer.stop();
    // The recording may need this screencast a moment longer (leave()).
    leave().finally(() => cdp.close());
  });

  // Once a second: is the browser out of CPU while frames come slowly (or no longer)?
  async function startAdapt() {
    const adapt = new LiveAdapt();
    const host = await hostCpu();
    const meter = await cpuMeter();
    let frames = framesIn;
    let at = performance.now();
    send({ type: "adapt", level, host });
    const tick = async () => {
      const busy = await meter().catch(() => null);
      const t = performance.now();
      const fps = ((framesIn - frames) * 1000) / Math.max(1, t - at);
      frames = framesIn;
      at = t;
      const change = adapt.sample({ busy, fps });
      if (change && sessionId && !closed) {
        level = change.level;
        console.log(`live view: ${level ? "cheaper picture" : "full picture"} (${change.reason}; host ${host})`);
        send({ type: "adapt", level, reason: change.reason, busy: Math.round(busy * 100) / 100, fps: Math.round(fps), host });
        const sid = sessionId;
        await cdp.send("Page.stopScreencast", {}, sid).catch(() => {});
        if (sid === sessionId) await startScreencast(sid).catch(() => {});
      }
      if (!closed) adaptTimer = setTimeout(tick, 1000);
    };
    if (!closed) adaptTimer = setTimeout(tick, 1000);
  }

  send({ type: "inputMode", ...inputMode });
  await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  const pages = await pageTargets(cdp).catch(() => []);
  const first = pages.find((p) => p.targetId === params.get("page")) ?? pages[0];
  if (first) await attach(first.targetId).catch((e) => send({ type: "error", message: e.message }));
  if (adaptive) startAdapt().catch((e) => console.log("live view adapt:", e.message));
  else if (v2) send({ type: "adapt", level, off: true, host: await hostCpu() });
}

// ---------- CDP proxy ----------

function proxyCdp(client) {
  if (!browserWsUrl) {
    client.close(1011, "browser not running");
    return;
  }
  proxyClients.add(client);
  everConnected = true;
  lastClientAt = Date.now();
  const upstream = new WebSocket(browserWsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  const logClient = sessionLog?.client();
  const queue = [];
  // Commands awaiting their reply: while the agent waits on one, the
  // recording may pace its capture (recorder.mjs clientBusy).
  let inflight = 0;
  upstream.on("open", () => {
    for (const m of queue) upstream.send(m);
    queue.length = 0;
  });
  client.on("message", (data, isBinary) => {
    lastClientAt = Date.now();
    if (!isBinary) {
      inflight++;
      recorder?.clientBusy(1);
    }
    const payload = isBinary ? data : rewriteClientMessage(data.toString());
    if (!isBinary) logClient?.command(payload);
    const own = stealth && !isBinary ? followUp(payload) : null;
    for (const m of own ? [payload, own] : [payload]) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(m);
      else queue.push(m);
    }
  });
  upstream.on("message", (data) => {
    const text = data.toString();
    if (isOwnReply(text)) return;
    // A reply starts {"id":...; events start {"method":...
    if (inflight > 0 && text.startsWith('{"id"')) {
      inflight--;
      recorder?.clientBusy(-1);
    }
    logClient?.response(text);
    if (client.readyState === WebSocket.OPEN) client.send(scrubber.scrubText(text));
  });
  const closeBoth = () => {
    proxyClients.delete(client);
    lastClientAt = Date.now();
    if (inflight) recorder?.clientBusy(-inflight);
    inflight = 0;
    try {
      upstream.close();
    } catch {}
    try {
      client.close();
    } catch {}
  };
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
}

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://agent");
  const p = url.pathname;
  if (!agentAllowed(req.method, p, req.headers, AGENT_TOKEN)) {
    req.resume();
    return json(res, 401, { error: "unauthorized" });
  }
  try {
    // build: the image's BROWSER_IMAGE_BUILD (Dockerfile), so the warm pool hands out only browsers from the Worker's build.
    // stealthVersion: stealth.mjs's STEALTH_VERSION, so a cold launch runs only on an image with stealth at least the Worker's minimum.
    if (req.method === "GET" && p === "/health")
      return json(res, 200, { ok: true, chrome: !!browserWsUrl, uptimeMs: Date.now() - bootAt, build: process.env.BROWSER_IMAGE_BUILD || null, stealthVersion: STEALTH_VERSION });

    if (req.method === "PUT" && p === "/profile") {
      if (chrome) return json(res, 409, { error: "browser already running" });
      // Streamed to disk: a profile can be far bigger than we'd want in memory.
      await pipeline(req, createWriteStream("/tmp/profile.tgz"));
      const { size } = await fs.stat("/tmp/profile.tgz");
      await fs.rm(PROFILE, { recursive: true, force: true });
      await fs.mkdir(DATA, { recursive: true });
      // brwsr's own exports have one top-level profile/ directory; an imported
      // user-data directory may have its contents (Default/, Local State) at the top.
      if (/^(\.\/)?profile(\/|$)/.test(await firstTarEntry("/tmp/profile.tgz"))) {
        await run("tar", ["-xzf", "/tmp/profile.tgz", "-C", DATA]);
      } else {
        await fs.mkdir(PROFILE, { recursive: true });
        await run("tar", ["-xzf", "/tmp/profile.tgz", "-C", PROFILE]);
      }
      await fs.rm("/tmp/profile.tgz", { force: true });
      return json(res, 200, { ok: true, bytes: size });
    }

    if (req.method === "POST" && p === "/start") {
      const opts = await readJson(req);
      return json(res, 200, await startChrome(opts));
    }

    if (req.method === "POST" && p === "/stealth") {
      // A warm-pool browser handed to a session: that session's profile, without a restart.
      if (!stealth) return json(res, 409, { error: "stealth_not_running" });
      const { profile } = await readJson(req);
      await stealth.setProfile({ profile });
      return json(res, 200, { ok: true, targets: stealth.targets });
    }

    if (req.method === "GET" && p === "/status") {
      return json(res, 200, {
        chrome: !!browserWsUrl,
        clients: proxyClients.size,
        liveClients: liveClients.size,
        everConnected,
        idleMs: proxyClients.size ? 0 : Date.now() - lastClientAt,
        uptimeMs: Date.now() - bootAt,
        nproc: (await run("nproc").then((r) => Number(r.stdout.trim())).catch(() => null)),
        // The host's CPU: Cloudflare places the same instance type on
        // different generations, which shows up as frame rate (README, Live view).
        cpuModel: await cpuModel(),
        memory: await memoryStats(),
        cpu: await cpuStats(),
        allowedDomains: guard?.domains ?? null,
        blockedNavigations: blockedTotal + (guard?.blocked ?? 0),
      });
    }

    if (req.method === "GET" && p === "/pages") {
      if (!browserWsUrl) return json(res, 200, []);
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = (await r.json()).filter((t) => t.type === "page");
      return json(res, 200, list.map((t) => ({ id: t.id, url: scrubber.scrubText(t.url), ...describePage(t.url, t.title), faviconUrl: t.faviconUrl ?? "" })));
    }

    // A small JPEG of the front page, for the dashboard's session thumbnails.
    if (req.method === "GET" && p === "/screenshot") {
      if (!browserWsUrl) return json(res, 409, { error: "no browser" });
      const width = Math.min(1280, Math.max(80, Number(new URL(req.url, "http://x").searchParams.get("width")) || 320));
      const shot = await thumbnail(width).catch(() => null);
      if (!shot) return json(res, 404, { error: "no page to capture" });
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": shot.length });
      return res.end(shot);
    }

    if (req.method === "POST" && p === "/conceal") {
      const { values } = await readJson(req);
      if (!Array.isArray(values)) return json(res, 400, { error: "values must be an array of strings" });
      let n = 0;
      for (const v of values) if (typeof v === "string" && v.length >= 4) (scrubber.add(v), n++);
      return json(res, 200, { ok: true, concealed: n });
    }

    if (req.method === "POST" && (p === "/reflex/run" || p === "/reflex/act" || p === "/reflex/look")) {
      if (!browserWsUrl) return json(res, 409, { error: "browser_not_running" });
      const body = await readJson(req);
      // Its own CDP connection, next to Chromium: every snapshot and action is a local round trip.
      const cdp = await CDP.connect(browserWsUrl);
      try {
        const fn = p === "/reflex/run" ? reflexRun : p === "/reflex/act" ? reflexAct : reflexLook;
        return json(res, 200, await fn(cdp, body));
      } catch (e) {
        if (e instanceof ReflexError) return json(res, e.status, { error: "reflex", message: e.message });
        return json(res, 500, { error: "reflex_failed", message: String(e?.message ?? e).split("\n")[0].slice(0, 300) });
      } finally {
        cdp.close();
      }
    }

    if (req.method === "POST" && p === "/logs/start") {
      if (!browserWsUrl) return json(res, 409, { error: "browser not running" });
      const { maxBytes, console: withConsole } = await readJson(req);
      if (!sessionLog) sessionLog = new SessionLog({ dir: LOG_DIR, scrubber, maxBytes: maxBytes || undefined });
      // Attach in the background: the session's launch doesn't wait for it.
      if (!stopLogCapture) {
        stopLogCapture = () => {};
        captureLogs(sessionLog, browserWsUrl, { console: withConsole !== false, stacks: !stealth })
          .then((stop) => (stopLogCapture = stop))
          .catch((e) => console.log("log capture failed:", e.message));
      }
      return json(res, 200, { ok: true });
    }

    if (p === "/logs/chunks" || p === "/logs/flush") {
      if (!sessionLog) return json(res, 200, { chunks: [], summary: null });
      if (req.method === "POST" && p === "/logs/flush") sessionLog.flush();
      return json(res, 200, { chunks: await sessionLog.chunks(), summary: sessionLog.summary() });
    }

    const lc = p.match(/^\/logs\/chunks\/(\d+)$/);
    if (lc) {
      const file = path.join(LOG_DIR, `${Number(lc[1])}.ndjson.gz`);
      if (!(await fileExists(file))) return json(res, 404, { error: "no such chunk" });
      if (req.method === "DELETE") {
        await fs.rm(file, { force: true });
        return json(res, 200, { ok: true });
      }
      const st = await fs.stat(file);
      res.writeHead(200, { "content-type": "application/gzip", "content-length": String(st.size) });
      createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "POST" && p === "/recording/start") {
      if (!browserWsUrl) return json(res, 409, { error: "browser not running" });
      const opts = await readJson(req);
      if (!recorder) {
        const r = new Recorder({
          ...(opts.maxPages ? { maxPages: Number(opts.maxPages) } : {}),
          ...(opts.quality ? { quality: Math.min(95, Math.max(30, Number(opts.quality))) } : {}),
          ...(opts.maxFps > 0 ? { maxFps: Math.min(60, Number(opts.maxFps)) } : {}),
          ...(opts.segmentSeconds > 0 ? { segmentSeconds: Math.min(60, Math.max(2, Number(opts.segmentSeconds))) } : {}),
          ...(opts.onPressure === "pace" || opts.onPressure === "pause" ? { onPressure: opts.onPressure } : {}),
          ...(opts.onPressure === "off" ? { adaptive: false } : {}),
          // One screencast while someone watches (on unless RECORDING_SHARE_LIVE is 0, from the Worker or the container's environment).
          ...(opts.shareLive === false || /^(0|false|off)$/i.test(process.env.RECORDING_SHARE_LIVE ?? "") ? { shareLive: false } : {}),
          ...(Number(opts.shareMinScale ?? process.env.RECORDING_SHARE_MIN_SCALE) > 0
            ? { shareMinScale: Math.min(1, Number(opts.shareMinScale ?? process.env.RECORDING_SHARE_MIN_SCALE)) }
            : {}),
        });
        recorder = r;
        // Attach in the background: the session's launch doesn't wait for it.
        r.start(browserWsUrl).catch((e) => console.log("recording failed to start:", e.message));
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/recording") {
      if (!recorder) return json(res, 200, { startedAt: null, stopped: true, done: true, pages: [] });
      return json(res, 200, await recorder.listing());
    }

    if (req.method === "POST" && p === "/recording/stop") {
      if (!recorder) return json(res, 200, { startedAt: null, stopped: true, done: true, pages: [] });
      await recorder.stop();
      return json(res, 200, await recorder.listing());
    }

    const rf = p.match(/^\/recording\/(\d+)\/([\w.]+)$/);
    if (rf && recorder) {
      if (req.method === "DELETE") return json(res, (await recorder.remove(rf[1], rf[2])) ? 200 : 404, { ok: true });
      const file = await recorder.file(rf[1], rf[2]);
      if (!file) return json(res, 404, { error: "no such file" });
      const st = await fs.stat(file);
      res.writeHead(200, { "content-type": "video/x-matroska", "content-length": String(st.size) });
      createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "GET" && p === "/export/meta") return json(res, 200, exportMeta);

    if (req.method === "POST" && p === "/export") {
      exportMeta = { cookieDomains: [] };
      await stopChrome({ saveSessionCookies: true });
      if (!(await fileExists(PROFILE))) return json(res, 404, { error: "no profile" });
      // Service Worker caches (Service Worker/CacheStorage, ScriptCache) are
      // kept, as Browserbase keeps them: sites like Google Workspace load from them.
      const excludes = [
        "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache",
        "ShaderCache", "GraphiteDawnCache", "component_crx_cache", "extensions_crx_cache", "Crashpad",
        "Safe Browsing", "OptimizationGuidePredictionModels", "SingletonLock", "SingletonSocket", "SingletonCookie",
        "DevToolsActivePort", "BrowserMetrics",
      ].flatMap((e) => ["--exclude", e]);
      await run("tar", ["-czf", "/tmp/export.tgz", ...excludes, "-C", DATA, "profile"]);
      const st = await fs.stat("/tmp/export.tgz");
      res.writeHead(200, { "content-type": "application/gzip", "content-length": String(st.size) });
      createReadStream("/tmp/export.tgz").pipe(res);
      return;
    }

    if (req.method === "POST" && p === "/stop") {
      const opts = await readJson(req);
      await stopChrome({ saveSessionCookies: false, fast: !!opts.fast });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/viewport") {
      // Warm-pool browsers start at the default size; resize their window for the session.
      const { width, height } = await readJson(req);
      if (!browserWsUrl) return json(res, 409, { error: "browser_not_running" });
      const cdp = await CDP.connect(browserWsUrl);
      try {
        for (const t of await pageTargets(cdp)) {
          const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId: t.targetId });
          await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
        }
      } finally {
        cdp.close();
      }
      return json(res, 200, { ok: true, width, height });
    }

    if (req.method === "POST" && p === "/domains") {
      const { domains } = await readJson(req);
      if (!Array.isArray(domains) || domains.some((d) => typeof d !== "string" || !d)) {
        return json(res, 400, { error: "domains must be an array of hostnames" });
      }
      return json(res, 200, await setDomains(domains.map((d) => d.toLowerCase())));
    }

    const up = p.match(/^\/uploads\/([^/]+)$/);
    if (req.method === "PUT" && up) {
      const name = path.basename(decodeURIComponent(up[1]));
      await fs.mkdir(UPLOADS, { recursive: true });
      await fs.writeFile(path.join(UPLOADS, name), await readBody(req));
      return json(res, 200, { ok: true, path: path.join(UPLOADS, name) });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    console.log(`${req.method} ${p} failed: ${e.message}`);
    json(res, e.status || 500, { error: e.message });
  }
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://agent");
  if (!agentAllowed(req.method, url.pathname, req.headers, AGENT_TOKEN)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    return;
  }
  if (url.pathname === "/cdp" || url.pathname.startsWith("/devtools/")) {
    wss.handleUpgrade(req, socket, head, (ws) => proxyCdp(ws));
  } else if (url.pathname === "/live") {
    if (!browserWsUrl) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => liveSession(ws, url.searchParams));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`brwsr agent on :${PORT}`));

process.on("SIGTERM", async () => {
  try {
    chrome?.kill("SIGTERM");
  } catch {}
  setTimeout(() => process.exit(0), 500);
});
