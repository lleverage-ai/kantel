// Copied from tvdavies/brwsr@0d22bf8 (container/agent/domains.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Allowed domains (browserSettings.allowedDomains), as Browserbase does them:
// only top-frame navigations are checked, a domain allows its subdomains, and
// only http(s) URLs are checked (about:blank, data:, chrome:// pass).
//
// The agent holds its own browser-level CDP connection. It auto-attaches to
// every page (new tabs and popups included; they wait until it's ready) and
// intercepts Document requests at the request stage. A main-frame request to
// another domain fails with net::ERR_BLOCKED_BY_CLIENT. Redirects are new
// requests, so they're checked too. Subframes, scripts and XHR pass.
import { CDP } from "./cdp.mjs";

/** Does this URL's host fall under one of the domains? Non-http(s) URLs always do. */
export function hostAllowed(url, domains) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "an invalid URL";
  }
}

/**
 * Guard one browser. Resolves once every page open now is guarded; later
 * pages are guarded before they run. If the guard's own connection drops
 * while the browser lives, onLost is called (the agent stops the browser
 * rather than let it run unguarded). stop() ends the guard on purpose.
 */
export async function guardNavigations(browserWsUrl, domains, { log = console.log, onLost = () => {}, connect = (u) => CDP.connect(u) } = {}) {
  const cdp = await connect(browserWsUrl);
  let blocked = 0;
  let stopping = false;
  /** sessionId -> targetId of each guarded page: a page's main frame has its target's ID. */
  const pages = new Map();
  const pending = [];

  async function arm(sessionId, waiting) {
    try {
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, sessionId);
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
      pages.set(sessionId, targetInfo.targetId);
      pending.push(arm(sessionId, waitingForDebugger).catch((e) => log(`allowed domains: couldn't guard a page: ${e.message}`)));
    } else if (m.method === "Target.detachedFromTarget") {
      pages.delete(m.params.sessionId);
    } else if (m.method === "Fetch.requestPaused") {
      const { requestId, request, frameId } = m.params;
      const topFrame = !!frameId && pages.get(m.sessionId) === frameId;
      if (!topFrame || hostAllowed(request.url, domains)) {
        cdp.send("Fetch.continueRequest", { requestId }, m.sessionId).catch(() => {});
      } else {
        blocked++;
        log(`allowed domains: blocked a navigation to ${safeHost(request.url)}`);
        cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, m.sessionId).catch(() => {});
      }
    } else if (m.method === "brwsr.closed" && !stopping) {
      onLost();
    }
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Pages already open attach during setAutoAttach; let their events land, then wait until they're armed.
  await new Promise((r) => setTimeout(r, 0));
  await Promise.all(pending);
  return {
    domains,
    get pages() {
      return pages.size;
    },
    get blocked() {
      return blocked;
    },
    stop() {
      stopping = true;
      cdp.close();
    },
  };
}
