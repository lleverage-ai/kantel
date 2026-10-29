// Copied from tvdavies/brwsr@0d22bf8 (container/agent/url-scrub.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Redacts what a URL can carry that shouldn't be kept: OAuth codes and
// tokens, magic-link, reset and SSO tokens, signatures, API keys and
// passwords. Used on every URL the session logs store (logs.mjs) and on the
// page URL a session keeps for the dashboard and the API (the Worker imports
// this file too, so it must stay plain JS with no Node APIs).
//
// - Query and fragment parameters with a sensitive name keep the name and
//   lose the value: `?code=abc&lang=en` becomes `?code=[redacted]&lang=en`.
// - Anywhere in the URL (path segments, parameter values, a fragment), a
//   JWT-looking value or an opaque run of 32 or more token characters with a
//   letter and a digit in it becomes [redacted].
// - `user:pass@` userinfo becomes `[redacted]@`.
// Everything else is left byte for byte as it was: no re-encoding, so the
// URL still reads as the page's.

export const REDACTED = "[redacted]";

const NAMES = new Set([
  "code",
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "state",
  "session",
  "sig",
  "signature",
  "key",
  "apikey",
  "api_key",
  "password",
  "auth",
  "ticket",
  "otp",
]);
const NAME_PATTERN = /token|secret|sig|auth|key|pass|code/i;

/** Whether a query or fragment parameter's value is redacted for its name alone. */
export function sensitiveName(name) {
  let n = name;
  try {
    n = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {}
  n = n.trim().toLowerCase();
  // Array forms: token[]=…, auth[token]=…
  const base = n.replace(/\[.*$/, "");
  return NAMES.has(n) || NAMES.has(base) || NAME_PATTERN.test(n);
}

// header.payload.signature, each base64url; the header starts {" -> eyJ.
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// Runs of token characters; percent escapes count, so an encoded base64 value is one run.
const RUN = /(?:[A-Za-z0-9_\-~+/=]|%[0-9A-Fa-f]{2})+/g;

function opaque(run) {
  return run.length >= 32 && /[A-Za-z]/.test(run) && /[0-9]/.test(run);
}

/** Redact JWTs and opaque token runs anywhere in `s`. */
function scrubTokens(s, path) {
  let out = s.replace(JWT, REDACTED);
  // In a path, `/` separates segments; elsewhere it can be part of base64.
  const run = path ? /(?:[A-Za-z0-9_\-~+=]|%[0-9A-Fa-f]{2})+/g : RUN;
  out = out.replace(run, (m) => (opaque(m) ? REDACTED : m));
  return out;
}

/** a=1&b=2 with sensitive values redacted. */
function scrubParams(s) {
  return s
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return scrubTokens(pair, false);
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value && sensitiveName(name)) return `${name}=${REDACTED}`;
      return `${scrubTokens(name, false)}=${scrubTokens(value, false)}`;
    })
    .join("&");
}

/** A fragment: parameters if it has any (OAuth's implicit flow, #access_token=…), else a path-like string. */
function scrubFragment(f) {
  const q = f.indexOf("?");
  if (q >= 0) return scrubTokens(f.slice(0, q), true) + "?" + scrubParams(f.slice(q + 1));
  if (f.includes("=")) return scrubParams(f);
  return scrubTokens(f, true);
}

/**
 * `url` with its sensitive parts redacted. Takes anything: absolute or
 * relative URLs, a bare fragment ("#…", as Page.frameNavigated's
 * urlFragment), or junk. data: URLs are left alone (they carry content, not
 * credentials, and are clipped elsewhere); non-strings are returned as they are.
 */
export function scrubUrl(url) {
  if (typeof url !== "string" || url === "") return url;
  if (/^(data|about|javascript|chrome|devtools):/i.test(url)) return url;
  let rest = url;
  let fragment = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query = null;
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  // scheme://userinfo@host… or scheme-relative //userinfo@host…; blob: wraps an origin (blob:https://…).
  let prefix = "";
  const m = /^((?:(?:blob:)?[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)([^/]*)(.*)$/.exec(rest);
  if (m) {
    let authority = m[2];
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = `${REDACTED}@${authority.slice(at + 1)}`;
    prefix = m[1] + authority;
    rest = m[3];
  }
  let out = prefix + scrubTokens(rest, true);
  if (query !== null) out += "?" + scrubParams(query);
  if (fragment !== null) out += "#" + scrubFragment(fragment);
  return out;
}

// Keys whose string values are URLs, in CDP events and commands and the
// agent's own records: request.url, response.url, documentURL, redirect
// targets, frame.url, frame.urlFragment, initiator.url, targetInfo.url,
// Page.navigate's url, a Location or Referer header.
const URL_KEYS = /^(url|urlFragment|documentURL|unreachableUrl|referrer|referer|location|href|origin|openerUrl|sourceURL|sourceMapURL|initiatorUrl|navigationUrl|baseURL)$/i;

// Headers given as CDP HeaderEntry arrays ([{name, value}], as Fetch.continueRequest
// and Fetch.fulfillRequest take them) whose value is a URL.
const URL_HEADERS = /^(referer|location|content-location|origin|refresh|link)$/i;

/**
 * A copy of `node` with every URL-valued field (by key, at any depth)
 * scrubbed. Arrays and plain objects are walked; anything else is kept.
 */
export function scrubUrlFields(node, depth = 0) {
  if (depth > 16 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => scrubUrlFields(n, depth + 1));
  const o = {};
  const header = typeof node.name === "string" && typeof node.value === "string" && URL_HEADERS.test(node.name);
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string" && (URL_KEYS.test(k) || (header && k === "value"))) o[k] = scrubUrl(v);
    else if (v && typeof v === "object") o[k] = scrubUrlFields(v, depth + 1);
    else o[k] = v;
  }
  return o;
}
