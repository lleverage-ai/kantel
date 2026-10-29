// Copied from tvdavies/brwsr@0d22bf8 (container/agent/scrub.mjs) for Harbour's browser runtime
// (docs/design/browser-runtime.md). Harbour changes: none.
// Scrubs filled secrets out of everything Chromium sends to CDP clients.
//
// A server-side fill types a password into the page over the agent's private
// CDP connection, so it never appears in the client's commands. It can still
// come back in events and results: Network.requestWillBeSent carries the
// login POST body (plain and base64 in postDataEntries), Runtime results can
// return an input's value, and so on. Every message to a client passes
// through scrubText(), which masks each concealed value the session has
// filled, in its raw, JSON-escaped, URL-encoded and base64-wrapped forms.
//
// Limit: a client with raw CDP can still run code that transforms the value
// (e.g. reverses it) before reading it. Raw CDP is for trusted principals;
// the guarantee is that ordinary agent tooling never receives the value.

export const MASK = "********";

/** application/x-www-form-urlencoded, as browsers send login forms (WHATWG URL spec). */
export function formEncode(s, keep = /[A-Za-z0-9*\-._]/) {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const ch = String.fromCharCode(b);
    if (b < 0x80 && keep.test(ch)) out += ch;
    else if (b === 0x20) out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function variantsOf(secret) {
  const json = JSON.stringify(secret).slice(1, -1);
  const json2 = JSON.stringify(json).slice(1, -1);
  const uri = encodeURIComponent(secret);
  const form = formEncode(secret);
  const encoded = [uri, uri.replace(/%20/g, "+"), form, form.replace(/\+/g, "%20")];
  const lower = encoded.map((e) => e.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  const all = [secret, json, json2, ...encoded, ...lower];
  const set = new Set([...all, ...all.map((v) => JSON.stringify(v).slice(1, -1))]);
  return [...set].filter((v) => v.length > 0);
}

export class Scrubber {
  constructor() {
    this.secrets = new Set();
    this.variants = [];
  }

  get active() {
    return this.variants.length > 0;
  }

  add(secret) {
    if (typeof secret !== "string" || secret.length < 4 || this.secrets.has(secret)) return;
    this.secrets.add(secret);
    this.variants = [...new Set([...this.variants, ...variantsOf(secret)])].sort((a, b) => b.length - a.length);
  }

  scrubString(s) {
    let out = s;
    for (const v of this.variants) if (out.includes(v)) out = out.split(v).join(MASK);
    return out;
  }

  scrubBase64(b64) {
    let decoded;
    try {
      decoded = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return b64;
    }
    const scrubbed = this.scrubString(decoded);
    return scrubbed === decoded ? b64 : Buffer.from(scrubbed, "utf8").toString("base64");
  }

  /** Walk a parsed message and scrub base64-wrapped bodies. */
  scrubBase64Fields(node) {
    if (Array.isArray(node)) {
      for (const n of node) this.scrubBase64Fields(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.postDataEntries)) {
      for (const e of node.postDataEntries) if (typeof e?.bytes === "string") e.bytes = this.scrubBase64(e.bytes);
    }
    if (node.base64Encoded === true) {
      for (const k of ["body", "postData"]) if (typeof node[k] === "string") node[k] = this.scrubBase64(node[k]);
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") this.scrubBase64Fields(v);
  }

  scrubText(text) {
    if (!this.active) return text;
    let out = this.scrubString(text);
    if (out.includes('"postDataEntries"') || out.includes('"base64Encoded":true')) {
      try {
        const msg = JSON.parse(out);
        this.scrubBase64Fields(msg);
        out = JSON.stringify(msg);
      } catch {}
    }
    return out;
  }
}
