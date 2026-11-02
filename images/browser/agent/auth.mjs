// Copied from tvdavies/brwsr@0d22bf8 (container/agent/auth.mjs) for Kantel's browser runtime
// (packages/browser/CONTRACT.md). Kantel changes: token header renamed to x-kantel-agent-token.
// Who may call the agent on :8080. Cloudflare routes outside traffic to the
// container from its Durable Object alone, but the browser runs in the same
// container: a page it loads can reach 127.0.0.1:8080 too. Chrome's Local
// Network Access refuses a public page's fetch and WebSocket to loopback, but
// not a top-level navigation, so a page's <form method=POST enctype=text/plain>
// could start or stop the recorder, stop Chromium or change the session's
// domains. So every call but GET /health must carry the token the
// Durable Object gave the container when it started it (AGENT_TOKEN, a fresh
// random one each start), in this header. A page can't send a custom header
// to another origin without a CORS preflight, which the agent never answers,
// and can't set one on a WebSocket at all; and it can't know the token.
import { timingSafeEqual } from "node:crypto";

export const AGENT_TOKEN_HEADER = "x-kantel-agent-token";
/** Its name before the rename, which a Durable Object built before it sends. */
export const LEGACY_AGENT_TOKEN_HEADER = "x-harbour-agent-token"; // before the rename

/**
 * Whether a request may use the agent. `token` is the container's
 * AGENT_TOKEN; without one, nothing but GET /health is allowed (an agent
 * started without a token can't tell its Durable Object from a page).
 */
export function agentAllowed(method, pathname, headers, token) {
  if (method === "GET" && pathname === "/health") return true;
  if (!token) return false;
  const got = headers[AGENT_TOKEN_HEADER] ?? headers[LEGACY_AGENT_TOKEN_HEADER];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
