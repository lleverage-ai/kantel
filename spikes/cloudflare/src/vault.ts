import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
	type AuditEventInput,
	type AuditSink,
	type EgressDecision,
	type HttpMethod,
	type SandboxTier,
	type SystemContext,
	systemContext,
	type Vault,
} from "@harbour/contracts";
import { createMemoryVault } from "@harbour/vault/memory";
import { SPIKE_ORGANISATION, SPIKE_OWNER, serviceContext } from "./identity.ts";
import { containsSecret, injectHeader, REDACTED, redactText } from "./redact.ts";

export { REDACTED };

/**
 * The spike's vault: M0-BE1's `Vault` (the in-memory target from @harbour/vault), hosted in one Durable Object and
 * seeded with one item (a canary secret held as a Worker secret) and static policies. Every outbound request from both
 * tiers reaches VaultGateway: the isolate through `globalOutbound`, the container through `enableInternet: false` plus
 * outbound interception. The gateway asks `decideEgress`, injects the header it returns, forwards, and redacts the
 * value from the response. Nothing else can leave.
 */
export const VAULT_ROUTES: readonly { readonly host: string; readonly methods: readonly HttpMethod[] }[] = [
	// The research page the scripted task fetches. The header is injected on the way out; example.com ignores it.
	{ host: "example.com", methods: ["GET", "HEAD"] },
	// An echo service: proves the header was injected (it echoes it back) and that the vault redacts the value on the
	// way in, so the canary never reaches the sandbox.
	{ host: "postman-echo.com", methods: ["GET"] },
	{ host: "httpbin.org", methods: ["GET"] },
];
const ITEM = { name: "research-canary", header: "X-Harbour-Vault" } as const;
const HTTP_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export type VaultCaller = { readonly sessionId: string; readonly tier: SandboxTier };

/** One decided request as the spike records it: the contract's use plus tier, status and redactions. */
export interface SpikeVaultUse {
	readonly at: number;
	readonly useId: string;
	readonly sessionId: string;
	readonly tier: SandboxTier;
	readonly method: string;
	readonly host: string;
	readonly path: string;
	readonly decision: "allowed" | "denied";
	readonly reason: string;
	readonly policyId?: string;
	/** The injected header's name and item, never its value. */
	readonly injected?: { readonly header: string; readonly item: string };
	readonly status?: number;
	/** Times the item's value was found in the response and redacted before it reached the sandbox. */
	readonly redactions?: number;
}

/** The isolate's globalOutbound: every fetch() the Dynamic Worker makes arrives here. */
export class VaultGateway extends WorkerEntrypoint<Env, VaultCaller> {
	override async fetch(request: Request): Promise<Response> {
		return vaultFetch(this.env, request, this.ctx.props);
	}
}

/** One egress decision: ask the vault, inject, forward, redact, record. Shared by both tiers. */
export async function vaultFetch(env: Env, request: Request, caller: VaultCaller): Promise<Response> {
	const { sessionId, tier } = caller;
	const url = new URL(request.url);
	// The container's plain-HTTP requests arrive as http://; the vault always goes out over HTTPS.
	if (url.protocol === "http:") url.protocol = "https:";
	const vault = env.VAULT.getByName("spike");
	const method = HTTP_METHODS.includes(request.method) ? (request.method as HttpMethod) : undefined;
	const decision: EgressDecision =
		method === undefined
			? { allow: false, reason: `method ${request.method} is not supported`, useId: "" }
			: await vault.decide({ sessionId, method, url: url.toString() });
	const base = {
		at: Date.now(),
		useId: decision.useId,
		sessionId,
		tier,
		method: request.method,
		host: url.hostname,
		path: url.pathname,
		reason: decision.reason,
		...(decision.policyId === undefined ? {} : { policyId: decision.policyId }),
	};

	if (!decision.allow || decision.inject === undefined) {
		await vault.record({ ...base, decision: "denied", status: 403 });
		const fix = decision.fix === undefined ? "" : ` ${decision.fix.message}`;
		return new Response(`harbour vault: ${decision.reason}.${fix}\n`, {
			status: 403,
			headers: { "content-type": "text/plain", "x-harbour-vault": "denied" },
		});
	}

	const headers = new Headers(request.headers);
	const secret = decision.inject.value;
	// Redaction looks for the value as stored: refuse one the headers would change. Fail closed; never echo the value.
	if (!injectHeader(headers, decision.inject.header, secret)) {
		await vault.record({ ...base, decision: "denied", status: 500, reason: "vault item is not a valid header value" });
		return new Response("harbour vault: the vault item is not a valid header value.\n", {
			status: 500,
			headers: { "content-type": "text/plain", "x-harbour-vault": "denied" },
		});
	}
	// Manual redirects: a redirect to another host comes back through the vault and its policy, never with the header.
	const upstream = await fetch(url.toString(), {
		method: request.method,
		headers,
		body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		redirect: "manual",
	});

	const { response, redactions } = await redact(upstream, secret);
	await vault.record({
		...base,
		decision: "allowed",
		status: upstream.status,
		redactions,
		injected: { header: decision.inject.header, item: ITEM.name },
	});
	return response;
}

async function redact(upstream: Response, secret: string): Promise<{ response: Response; redactions: number }> {
	const type = upstream.headers.get("content-type") ?? "";
	const textual = /^(text\/|application\/(json|xml|javascript)|.*\+json)/.test(type);
	const headers = new Headers();
	let redactions = 0;
	for (const [name, value] of upstream.headers) {
		if (name === "content-length" || name === "content-encoding") continue;
		const clean = redactText(value, secret);
		redactions += clean.redactions;
		headers.append(name, clean.text);
	}
	headers.set("x-harbour-vault", "allowed");
	if (upstream.body === null) {
		return { response: new Response(null, { status: upstream.status, headers }), redactions };
	}
	if (!textual) {
		// A binary body cannot be rewritten safely; withhold it if the secret is in it.
		const bytes = new Uint8Array(await upstream.arrayBuffer());
		if (containsSecret(bytes, secret)) {
			return {
				response: new Response("harbour vault: response withheld, it contains a vault secret\n", {
					status: 502,
					headers,
				}),
				redactions: redactions + 1,
			};
		}
		return { response: new Response(bytes, { status: upstream.status, headers }), redactions };
	}
	const clean = redactText(await upstream.text(), secret);
	return {
		response: new Response(clean.text, { status: upstream.status, headers }),
		redactions: redactions + clean.redactions,
	};
}

/**
 * Hosts the vault (in memory, seeded at start: the item, its value and one policy per route) and the spike's record
 * of uses in SQLite. Contract audit events from the vault land in SQLite too, idempotent by event ID. The canary
 * value is only ever in the vault's memory and in the gateway's outgoing request.
 */
export class VaultDO extends DurableObject<Env> {
	#vault: Vault | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS uses (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, body TEXT NOT NULL)",
		);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
		void ctx.blockConcurrencyWhile(async () => {
			this.#vault = await seed(this.env, {
				append: async (_ctx: SystemContext, events: readonly AuditEventInput[]) => {
					for (const event of events) {
						this.ctx.storage.sql.exec(
							"INSERT OR IGNORE INTO audit (id, body) VALUES (?, ?)",
							event.id,
							JSON.stringify(event),
						);
					}
				},
			});
		});
	}

	async decide(input: { sessionId: string; method: HttpMethod; url: string }): Promise<EgressDecision> {
		if (this.#vault === undefined) throw new Error("vault not seeded");
		return this.#vault.decideEgress(systemContext("egress"), { organisationId: SPIKE_ORGANISATION, ...input });
	}

	record(use: SpikeVaultUse): void {
		// Logged without the value: header name and item only.
		console.log(JSON.stringify({ message: "vault.use", ...use }));
		this.ctx.storage.sql.exec("INSERT INTO uses (session, body) VALUES (?, ?)", use.sessionId, JSON.stringify(use));
	}

	async uses(sessionId: string): Promise<readonly SpikeVaultUse[]> {
		return this.ctx.storage.sql
			.exec<{ body: string }>("SELECT body FROM uses WHERE session = ? ORDER BY id", sessionId)
			.toArray()
			.map((row) => JSON.parse(row.body) as SpikeVaultUse);
	}
}

async function seed(env: Env, audit: AuditSink): Promise<Vault> {
	const vault = createMemoryVault({ audit });
	const ctx = serviceContext();
	const item = await vault.putItem(ctx, {
		owner: SPIKE_OWNER,
		name: ITEM.name,
		description: "M0-CF1 canary: must never reach a sandbox, transcript or log",
		hosts: VAULT_ROUTES.map((route) => route.host),
		injection: { header: ITEM.header, template: "{key}" },
		...(env.VAULT_CANARY ? { value: env.VAULT_CANARY } : {}),
	});
	for (const route of VAULT_ROUTES) {
		await vault.putPolicy(ctx, {
			itemId: item.id,
			selector: { organisationId: SPIKE_ORGANISATION },
			route: { host: route.host, methods: route.methods, pathPrefix: "/" },
		});
	}
	return vault;
}
