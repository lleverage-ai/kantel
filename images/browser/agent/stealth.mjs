// Copied from tvdavies/brwsr@0d22bf8 (container/agent/stealth.mjs) for Kantel's browser runtime
// (packages/browser/CONTRACT.md). Kantel changes: none.
// Stealth: what every page and worker sees of the browser, made to look like
// one ordinary desktop Chrome on Linux (browserSettings.advancedStealth makes
// it the strongest version of that; see README "Stealth").
//
// The session's fingerprint profile (src/stealth.ts: screen, CPU cores,
// memory, GPU) and its place (time zone, languages) are applied in three
// layers, as natively as the engine allows:
//
//   1. Launch flags and environment: --user-agent (no "HeadlessChrome"),
//      --screen-info (a real screen, bigger than the window), --accept-lang
//      and TZ. These cover every page, frame and worker.
//   2. CDP overrides from the agent's own connection, attached to every page,
//      frame and worker before it runs (waitForDebuggerOnStart): client hints
//      and navigator.userAgentData say Google Chrome (headless-shell says
//      HeadlessChrome), CPU cores, locale. Overrides last as long as the
//      connection that set them, so the agent holds it while Chrome runs.
//   3. A small script in each new document and worker, for what no flag or
//      CDP command covers: the WebGL GPU strings (SwiftShader is a giveaway),
//      device memory, worker CPU cores, the Runtime.enable console leak, and on
//      headless-shell the parts it lacks (window.chrome, PDF plugins,
//      Notification permission, window chrome around the page). Patched
//      functions keep their native toString.
//
// The connection never enables the Runtime domain: a page can tell when
// something has (console.log(error) runs Error.prepareStackTrace), and
// clients such as Puppeteer and Playwright always do, so layer 3 stops that
// leak in the page too.
import os from "node:os";
import { CDP } from "./cdp.mjs";

/**
 * This image's stealth version, reported in the agent's /health. Add 1 when a
 * change here (or anywhere else that changes what a page can tell about the
 * browser) lands. A cold launch accepts only an image at or above the
 * Worker's MIN_STEALTH_VERSION (src/config.ts), so raise that too when
 * sessions must not run on the older stealth any more.
 */
export const STEALTH_VERSION = 1;

/** Chrome's Linux UA string, reduced as Chrome reduces it, for a major version. */
export function userAgentString(major) {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Chrome's brand list for a version, in Chrome's own order and with its own
 * GREASE brand (components/embedder_support/user_agent_utils.cc,
 * GenerateBrandVersionList): seeded by the major version, so it is what a
 * real Google Chrome of that version sends.
 */
export function brandList(fullVersion, full = false) {
  const major = Number(String(fullVersion).split(".")[0]);
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const order = orders[major % 6];
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const greaseVersions = ["8", "99", "24"];
  const grease = { brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`, version: greaseVersions[major % 3] };
  const v = full ? fullVersion : String(major);
  const list = [];
  list[order[0]] = { brand: grease.brand, version: full ? `${grease.version}.0.0.0` : grease.version };
  list[order[1]] = { brand: "Chromium", version: v };
  list[order[2]] = { brand: "Google Chrome", version: v };
  return list;
}

/** The kernel version as Chrome reports it for Linux (platformVersion): major.minor.patch. */
export function linuxPlatformVersion(release = os.release()) {
  const m = String(release).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? `${m[1]}.${m[2]}.${m[3] ?? 0}` : "6.1.0";
}

/** Emulation.setUserAgentOverride's userAgentMetadata for Google Chrome on Linux x86-64. */
export function uaMetadata(fullVersion, platformVersion = linuxPlatformVersion()) {
  return {
    brands: brandList(fullVersion),
    fullVersionList: brandList(fullVersion, true),
    fullVersion,
    platform: "Linux",
    platformVersion,
    architecture: "x86",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
    formFactors: ["Desktop"],
  };
}

/** navigator.languages for a locale: the locale, its language, then English (Chrome's usual list). */
export function languagesFor(locale = "en-US") {
  const lang = locale.split("-")[0];
  const out = [locale];
  if (lang !== locale) out.push(lang);
  if (lang !== "en") out.push("en-US", "en");
  return [...new Set(out)];
}

/**
 * navigator.languages for a session's geo: the list it gives (a context's
 * kept place, so Accept-Language stays as it was), else the locale's.
 */
export function languagesForGeo(geo) {
  const given = Array.isArray(geo?.languages) ? geo.languages.filter((l) => typeof l === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)) : [];
  return given.length ? given : languagesFor(geo?.locale || "en-US");
}

/** Real screen sizes, smallest first, for a window bigger than the profile's screen. */
const BIGGER_SCREENS = [
  [1920, 1080],
  [1920, 1200],
  [2560, 1440],
  [2560, 1600],
  [3440, 1440],
  [3840, 2160],
  [5120, 2880],
  [7680, 4320],
];

/** The profile's screen, or the smallest real one the window fits in (a window can't be bigger than its screen). */
export function screenFor(s, win) {
  const top = s.workAreaTop ?? 0;
  const fits = (w, h) => (win?.width ?? 0) <= w && (win?.height ?? 0) + top <= h;
  if (fits(s.width, s.height)) return { width: s.width, height: s.height };
  const real = BIGGER_SCREENS.find(([w, h]) => fits(w, h));
  if (real) return { width: real[0], height: real[1] };
  return { width: Math.max(s.width, win.width), height: Math.max(s.height, win.height + top) };
}

/** Launch flags for a profile: the screen and languages. */
export function stealthArgs(profile, { window: win, languages }) {
  const s = profile?.screen;
  const args = [];
  if (s) {
    const { width, height } = screenFor(s, win);
    args.push(`--screen-info={${width}x${height}${s.workAreaTop ? ` workAreaTop=${s.workAreaTop}` : ""}}`);
  }
  if (languages?.length) args.push(`--lang=${languages[0]}`, `--accept-lang=${languages.join(",")}`);
  return args;
}

// ---------- the in-page script ----------

/**
 * The script run in each new document (scope "window") or worker (scope
 * "worker"). `cfg`: {gpu: {vendor, renderer}, deviceMemory, cores, shell}
 * where shell adds headless-shell's missing pieces.
 */
export function patchSource(cfg, scope = "window") {
  return `(${patch.toString()})(${JSON.stringify({ ...cfg, scope })});`;
}

// Runs in the page or worker, not in Node: no closures over module scope.
function patch(cfg) {
  const G = globalThis;
  const fnToString = Function.prototype.toString;
  const sources = new WeakMap();
  const descOf = (o, k) => Object.getOwnPropertyDescriptor(o, k);
  const getProto = Object.getPrototypeOf;
  // Our wrappers are Proxies; these keep them from behaving unlike the
  // functions they wrap where a page can look (the checks CreepJS runs).
  // An error thrown through a wrapper loses the wrapper's frame from its stack,
  // and V8 names a receiver whose prototype is a function "Function", which it
  // can't see through a Proxy.
  const OUR_FRAME = /^\s+at Object\.(apply|get|set|construct|setPrototypeOf) \(<anonymous>:\d+:\d+\)$/;
  const scrub = (e, self) => {
    try {
      if (!e || typeof e.stack !== "string") return e;
      // Our frames: the trap's, and ours called from it (deeper, so above it in the stack).
      const all = e.stack.split("\n");
      let trap = -1;
      all.forEach((l, i) => OUR_FRAME.test(l) && trap < 0 && (trap = i));
      const lines = all.filter((l, i) => !(i <= trap && /<anonymous>:\d+:\d+\)?$/.test(l)));
      if (lines[1] && self !== null && (typeof self === "object" || typeof self === "function") && sources.has(getProto(self))) {
        lines[1] = lines[1].replace(/^(\s+at )Object\./, "$1Function.");
      }
      e.stack = lines.join("\n");
    } catch {}
    return e;
  };
  /** A Proxy of fn calling apply(fn, this, args), its native source kept for toString. */
  const cloak = (fn, apply, source = fnToString.call(fn)) => {
    const p = new Proxy(fn, {
      apply(t, self, args) {
        try {
          return apply(t, self, args);
        } catch (e) {
          throw scrub(e, self);
        }
      },
      // V8 refuses a prototype cycle, but can't see one through a Proxy.
      setPrototypeOf(t, proto) {
        for (let o = proto; o; o = getProto(o)) if (o === p || o === t) return false;
        return Reflect.setPrototypeOf(t, proto);
      },
    });
    sources.set(p, source);
    return p;
  };
  try {
    const masked = cloak(fnToString, (t, self, args) =>
      typeof self === "function" && sources.has(self) ? sources.get(self) : Reflect.apply(t, self, args),
    );
    Object.defineProperty(Function.prototype, "toString", { ...descOf(Function.prototype, "toString"), value: masked });
  } catch {}
  /** obj[key] (a method) wrapped: apply(original, this, args). Keeps name, length and native source. */
  const wrapMethod = (obj, key, apply) => {
    const d = obj && descOf(obj, key);
    if (!d || typeof d.value !== "function") return;
    Object.defineProperty(obj, key, { ...d, value: cloak(d.value, apply) });
  };
  /** proto[key]'s getter returns value(original result, this) instead. */
  const wrapGetter = (proto, key, value) => {
    const d = proto && descOf(proto, key);
    if (!d || typeof d.get !== "function") return;
    Object.defineProperty(proto, key, { ...d, get: cloak(d.get, (t, self, args) => value(Reflect.apply(t, self, args), self)) });
  };
  /** A function that looks native: "function name() { [native code] }". */
  const nativeFn = (name, fn) => cloak(fn, (t, self, args) => Reflect.apply(t, self, args), `function ${name}() { [native code] }`);

  // Runtime.enable leak: with a CDP client's Runtime domain on, console.log(error)
  // makes V8 format the error's stack, which calls a page's Error.prepareStackTrace.
  // Format it first, with the page's hook set aside, so nothing the page can see happens.
  const isError = (a) => {
    try {
      return a instanceof Error || Object.prototype.toString.call(a) === "[object Error]";
    } catch {
      return false;
    }
  };
  const settle = (args) => {
    const d = descOf(Error, "prepareStackTrace");
    if (!d || typeof d.value !== "function") return;
    const errs = [];
    for (const a of args) {
      if (isError(a)) errs.push(a);
      else if (a && typeof a === "object" && (Array.isArray(a) || Object.getPrototypeOf(a) === Object.prototype)) {
        try {
          for (const v of Object.values(a).slice(0, 50)) if (isError(v)) errs.push(v);
        } catch {}
      }
    }
    if (!errs.length) return;
    try {
      Error.prepareStackTrace = undefined;
      for (const e of errs) {
        try {
          void e.stack;
        } catch {}
      }
    } finally {
      Object.defineProperty(Error, "prepareStackTrace", d);
    }
  };
  if (G.console) {
    for (const m of ["log", "debug", "info", "warn", "error", "dir", "dirxml", "table", "trace", "group", "groupCollapsed", "assert", "timeLog", "count"]) {
      wrapMethod(G.console, m, (t, self, args) => {
        settle(args);
        return Reflect.apply(t, self, args);
      });
    }
  }

  // WebGL: the GPU strings of a real machine, not SwiftShader's.
  if (cfg.gpu) {
    for (const C of [G.WebGLRenderingContext, G.WebGL2RenderingContext]) {
      wrapMethod(C?.prototype, "getParameter", (t, self, args) => {
        const r = Reflect.apply(t, self, args);
        if (typeof r !== "string") return r;
        if (args[0] === 37445) return cfg.gpu.vendor;
        if (args[0] === 37446) return cfg.gpu.renderer;
        return r;
      });
    }
  }

  const nav = cfg.scope === "worker" ? G.WorkerNavigator?.prototype : G.Navigator?.prototype;
  if (cfg.deviceMemory) wrapGetter(nav, "deviceMemory", () => cfg.deviceMemory);
  // Pages get their cores from Emulation.setHardwareConcurrencyOverride; workers can't.
  if (cfg.cores && cfg.scope === "worker") wrapGetter(nav, "hardwareConcurrency", () => cfg.cores);

  if (cfg.scope !== "window" || !cfg.shell) return;

  // ---- headless-shell: what a full Chrome has and it doesn't ----
  const W = G;
  if (!W.chrome) {
    const app = {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails: nativeFn("getDetails", () => null),
      getIsInstalled: nativeFn("getIsInstalled", () => false),
      installState: nativeFn("installState", (cb) => (typeof cb === "function" ? setTimeout(() => cb("not_installed"), 0) : undefined)),
      runningState: nativeFn("runningState", () => "cannot_run"),
    };
    const t0 = Date.now() / 1000;
    const nt = () => performance.getEntriesByType?.("navigation")?.[0];
    const chrome = {
      loadTimes: nativeFn("", () => {
        const n = nt();
        const start = t0 - performance.now() / 1000;
        return {
          requestTime: start,
          startLoadTime: start,
          commitLoadTime: start + (n?.responseStart ?? 0) / 1000,
          finishDocumentLoadTime: start + (n?.domContentLoadedEventEnd ?? 0) / 1000,
          finishLoadTime: start + (n?.loadEventEnd ?? 0) / 1000,
          firstPaintTime: start + (n?.domInteractive ?? 0) / 1000,
          firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: n?.nextHopProtocol === "h2" || n?.nextHopProtocol === "h3",
          wasNpnNegotiated: !!n?.nextHopProtocol,
          npnNegotiatedProtocol: n?.nextHopProtocol ?? "unknown",
          wasAlternateProtocolAvailable: false,
          connectionInfo: n?.nextHopProtocol ?? "http/1.1",
        };
      }),
      csi: nativeFn("", () => {
        const n = nt();
        return { onloadT: Math.round(t0 * 1000 + (n?.loadEventEnd ?? 0)), pageT: performance.now(), startE: Math.round(t0 * 1000 - performance.now()), tran: 15 };
      }),
      app,
    };
    try {
      Object.defineProperty(W, "chrome", { value: chrome, writable: true, enumerable: true, configurable: false });
      // Chrome installs window.chrome straight after the standard Window members
      // (webkitRequestAnimationFrame is the last), and the rest after it; added
      // now, it would be last. Move the rest after it, as they are.
      const names = Object.getOwnPropertyNames(W);
      const from = names.indexOf("webkitRequestAnimationFrame");
      if (from >= 0) {
        for (const k of names.slice(from + 1)) {
          const d = k === "chrome" ? null : descOf(W, k);
          if (!d || !d.configurable) continue;
          try {
            delete W[k];
            Object.defineProperty(W, k, d);
          } catch {}
        }
      }
    } catch {}
  }

  // Notifications: headless-shell says "denied" while permissions.query says "prompt".
  if (W.Notification) wrapGetter(W.Notification, "permission", (r) => (r === "denied" ? "default" : r));

  // The PDF viewer's plugins and MIME types, as every desktop Chrome lists them.
  if (W.navigator.plugins?.length === 0 && W.PluginArray && W.Plugin && W.MimeType && W.MimeTypeArray) {
    const desc = "Portable Document Format";
    const define = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, configurable: true });
    const mimes = Object.create(MimeTypeArray.prototype);
    const plugins = Object.create(PluginArray.prototype);
    const mimeList = ["application/pdf", "text/pdf"].map((type) => {
      const m = Object.create(MimeType.prototype);
      define(m, "type", type);
      define(m, "suffixes", "pdf");
      define(m, "description", desc);
      return m;
    });
    const names = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
    const pluginList = names.map((name) => {
      const p = Object.create(Plugin.prototype);
      define(p, "name", name);
      define(p, "filename", "internal-pdf-viewer");
      define(p, "description", desc);
      define(p, "length", mimeList.length);
      mimeList.forEach((m, i) => {
        Object.defineProperty(p, i, { value: m, enumerable: true, configurable: true });
        define(p, m.type, m);
      });
      define(p, "item", nativeFn("item", (i) => mimeList[i] ?? null));
      define(p, "namedItem", nativeFn("namedItem", (n) => mimeList.find((m) => m.type === n) ?? null));
      return p;
    });
    mimeList.forEach((m) => define(m, "enabledPlugin", pluginList[0]));
    const fill = (arr, list, key) => {
      list.forEach((x, i) => Object.defineProperty(arr, i, { value: x, enumerable: true, configurable: true }));
      list.forEach((x) => define(arr, x[key], x));
      define(arr, "length", list.length);
      define(arr, "item", nativeFn("item", (i) => list[i] ?? null));
      define(arr, "namedItem", nativeFn("namedItem", (n) => list.find((x) => x[key] === n) ?? null));
      define(arr, Symbol.iterator, nativeFn("values", function* () {
        yield* list;
      }));
    };
    fill(mimes, mimeList, "type");
    fill(plugins, pluginList, "name");
    define(plugins, "refresh", nativeFn("refresh", () => undefined));
    wrapGetter(Navigator.prototype, "plugins", () => plugins);
    wrapGetter(Navigator.prototype, "mimeTypes", () => mimes);
    wrapGetter(Navigator.prototype, "pdfViewerEnabled", () => true);
  }

  // Window chrome: a headed window is taller than its page by its tab strip and toolbar.
  // (outerHeight is an accessor of the window itself, as on every global.)
  wrapGetter(W, "outerHeight", (r) => (r === W.innerHeight ? r + 87 : r));
}

// ---------- applying it ----------

const WORKERS = new Set(["worker", "shared_worker", "service_worker"]);
/**
 * The longest a new target stays paused for its set-up. A service worker paused
 * on start has no context to evaluate in yet, so its Runtime.evaluate only runs
 * once it's resumed: waiting on it would keep the worker paused for good.
 */
const SETUP_MS = { service_worker: 300, other: 3000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hold the stealth connection for one browser: every target it has now or
 * gets later is set up before its first script runs. `opts`:
 *   { fullVersion, profile, languages, locale, shell, log }
 * Resolves once the targets open now are set up. setProfile() switches to
 * another profile (a warm-pool browser handed to a session); stop() ends it.
 */
export async function startStealth(browserWsUrl, opts, { connect = (u, o) => CDP.connect(u, o) } = {}) {
  const log = opts.log ?? console.log;
  // Page events this connection doesn't use, dropped unparsed.
  const cdp = await connect(browserWsUrl, {
    skipEvents: ["Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.frameNavigated", "Page.frameAttached", "Page.frameDetached", "Page.domContentEventFired", "Page.loadEventFired", "Page.frameRequestedNavigation", "Page.navigatedWithinDocument", "Page.frameResized", "Page.frameStartedNavigating", "Page.documentOpened", "Page.frameSubtreeWillBeDetached"],
  });
  let cfg = configFor(opts);
  /** sessionId -> {type, scriptId?} */
  const targets = new Map();
  const pending = [];

  function configFor(o) {
    const p = o.profile ?? {};
    return {
      ua: userAgentString(String(o.fullVersion).split(".")[0]),
      metadata: uaMetadata(o.fullVersion),
      languages: o.languages ?? ["en-US", "en"],
      locale: o.locale ?? null,
      cores: p.cores ?? null,
      page: patchSource({ gpu: p.gpu ?? null, deviceMemory: p.deviceMemory ?? null, cores: p.cores ?? null, shell: !!o.shell }, "window"),
      worker: patchSource({ gpu: p.gpu ?? null, deviceMemory: p.deviceMemory ?? null, cores: p.cores ?? null }, "worker"),
    };
  }

  // acceptLanguage is a plain list: Chrome adds the q-values (and navigator.languages is the list).
  const uaParams = () => ({ userAgent: cfg.ua, acceptLanguage: cfg.languages.join(","), platform: "Linux x86_64", userAgentMetadata: cfg.metadata });

  async function setUpPage(sessionId, t) {
    // Chrome runs a session's new-document scripts only while its Page domain is on.
    const sends = [cdp.send("Page.enable", {}, sessionId), cdp.send("Emulation.setUserAgentOverride", uaParams(), sessionId)];
    if (cfg.cores) sends.push(cdp.send("Emulation.setHardwareConcurrencyOverride", { hardwareConcurrency: cfg.cores }, sessionId).catch(() => {}));
    if (cfg.locale) sends.push(cdp.send("Emulation.setLocaleOverride", { locale: cfg.locale }, sessionId).catch(() => {}));
    if (t.scriptId) sends.push(cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: t.scriptId }, sessionId).catch(() => {}));
    sends.push(
      cdp
        .send("Page.addScriptToEvaluateOnNewDocument", { source: cfg.page, runImmediately: !t.scriptId }, sessionId)
        .then((r) => (t.scriptId = r.identifier)),
    );
    await Promise.all(sends);
  }

  async function setUpWorker(sessionId) {
    await Promise.all([
      cdp.send("Network.setUserAgentOverride", uaParams(), sessionId).catch(() => {}),
      cdp.send("Runtime.evaluate", { expression: cfg.worker, silent: true }, sessionId).catch(() => {}),
    ]);
  }

  async function arm(sessionId, targetInfo, waiting) {
    const t = { type: targetInfo.type };
    targets.set(sessionId, t);
    try {
      const page = t.type === "page" || t.type === "iframe";
      const setUp = (async () => {
        if (page) await setUpPage(sessionId, t);
        else if (WORKERS.has(t.type)) await setUpWorker(sessionId);
        // Frames in other processes and workers this target starts attach here too.
        if (page || t.type === "worker" || t.type === "shared_worker") {
          await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
        }
      })();
      // Nothing keeps a target paused for long, whatever command stalls.
      await Promise.race([setUp, sleep(SETUP_MS[t.type] ?? SETUP_MS.other)]);
    } finally {
      if (waiting) await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
  }

  cdp.on((m) => {
    if (m.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = m.params;
      const known = targetInfo.type === "page" || targetInfo.type === "iframe" || WORKERS.has(targetInfo.type);
      if (!known) {
        if (waitingForDebugger) cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        return;
      }
      pending.push(arm(sessionId, targetInfo, waitingForDebugger).catch((e) => log(`stealth: couldn't set up a ${targetInfo.type}: ${e.message}`)));
    } else if (m.method === "Target.detachedFromTarget") {
      targets.delete(m.params.sessionId);
    } else if (m.method === "brwsr.closed") {
      opts.onLost?.();
    }
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await new Promise((r) => setTimeout(r, 0));
  await Promise.all(pending);
  return {
    get targets() {
      return targets.size;
    },
    /** Switch to another profile: pages open now and everything after. */
    async setProfile(next) {
      cfg = configFor({ ...opts, ...next });
      await Promise.all(
        [...targets].map(([sid, t]) =>
          (t.type === "page" || t.type === "iframe" ? setUpPage(sid, t) : WORKERS.has(t.type) ? setUpWorker(sid) : null)?.catch(() => {}),
        ),
      );
    },
    stop() {
      cdp.close();
    },
  };
}
