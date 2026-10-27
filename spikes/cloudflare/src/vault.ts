import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { SandboxTier, Vault, VaultPolicy, VaultUse } from "./contracts.ts";

/**
 * Stub vault for the spike. Static policies, one item (a canary secret held as a Worker secret), one injected header.
 * Every outbound request from both tiers reaches VaultGateway: the isolate through `globalOutbound`, the container
 * through `enableInternet: false` plus outbound interception. Nothing else can leave.
 */
export const VAULT_POLICIES: readonly VaultPolicy[] = [
  // The research page the scripted task fetches. The header is injected on the way out; example.com ignores it.
  { host: "example.com", methods: ["GET", "HEAD"], inject: { header: "X-Harbour-Vault", item: "research-canary" } },
  // An echo service: proves the header was injected (it echoes it back) and that the vault redacts the value on the
  // way in, so the canary never reaches the sandbox.
  { host: "postman-echo.com", methods: ["GET"], inject: { header: "X-Harbour-Vault", item: "research-canary" } },
  { host: "httpbin.org", methods: ["GET"], inject: { header: "X-Harbour-Vault", item: "research-canary" } },
];

export const REDACTED = "[vault:redacted]";

export type VaultCaller = { readonly sessionId: string; readonly tier: SandboxTier };

/** The isolate's globalOutbound: every fetch() the Dynamic Worker makes arrives here. */
export class VaultGateway extends WorkerEntrypoint<Env, VaultCaller> {
  override async fetch(request: Request): Promise<Response> {
    return vaultFetch(this.env, request, this.ctx.props);
  }
}

/** One egress decision: match a policy, inject, forward, redact, audit. Shared by both tiers. */
export async function vaultFetch(env: Env, request: Request, caller: VaultCaller): Promise<Response> {
  {
    const { sessionId, tier } = caller;
    const url = new URL(request.url);
    // The container's plain-HTTP requests arrive as http://; the vault always goes out over HTTPS.
    if (url.protocol === "http:") url.protocol = "https:";
    const policy = VAULT_POLICIES.find((candidate) => candidate.host === url.hostname);
    const base = { at: Date.now(), sessionId, tier, method: request.method, host: url.hostname, path: url.pathname };

    if (policy === undefined || !policy.methods.includes(request.method)) {
      await record(env, { ...base, decision: "denied", status: 403 });
      return new Response(`harbour vault: no policy allows ${request.method} ${url.hostname}\n`, {
        status: 403,
        headers: { "content-type": "text/plain", "x-harbour-vault": "denied" },
      });
    }

    const headers = new Headers(request.headers);
    const secret = policy.inject === undefined ? undefined : item(env, policy.inject.item);
    if (policy.inject !== undefined && secret !== undefined) headers.set(policy.inject.header, secret);
    // Manual redirects: a redirect to another host comes back through the vault and its policy, never with the header.
    const upstream = await fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    const { response, redactions } = await redact(upstream, secret);
    await record(env, {
      ...base,
      decision: "allowed",
      status: upstream.status,
      redactions,
      ...(policy.inject === undefined ? {} : { injected: policy.inject }),
    });
    return response;
  }
}

function item(env: Env, name: string): string | undefined {
  if (name === "research-canary") return env.VAULT_CANARY;
  return undefined;
}

async function record(env: Env, use: VaultUse): Promise<void> {
  // Logged without the value: header name and item only.
  console.log(JSON.stringify({ message: "vault.use", ...use }));
  await env.VAULT.getByName("spike").record(use);
}

async function redact(upstream: Response, secret: string | undefined): Promise<{ response: Response; redactions: number }> {
  const type = upstream.headers.get("content-type") ?? "";
  const textual = /^(text\/|application\/(json|xml|javascript)|.*\+json)/.test(type);
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("x-harbour-vault", "allowed");
  if (secret === undefined || !textual || upstream.body === null) {
    return { response: new Response(upstream.body, { status: upstream.status, headers }), redactions: 0 };
  }
  const text = await upstream.text();
  const parts = text.split(secret);
  return {
    response: new Response(parts.join(REDACTED), { status: upstream.status, headers }),
    redactions: parts.length - 1,
  };
}

/** Audit store for vault uses: one object for the spike. */
export class VaultDO extends DurableObject<Env> implements Pick<Vault, "uses"> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS uses (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, body TEXT NOT NULL)",
    );
  }

  record(use: VaultUse): void {
    this.ctx.storage.sql.exec("INSERT INTO uses (session, body) VALUES (?, ?)", use.sessionId, JSON.stringify(use));
  }

  async uses(sessionId: string): Promise<readonly VaultUse[]> {
    return this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM uses WHERE session = ? ORDER BY id", sessionId)
      .toArray()
      .map((row) => JSON.parse(row.body) as VaultUse);
  }
}
