// Placeholder-gated injection (#331) at the service: approvals for a sandbox's own request, a connection that needs
// reconnecting, placeholders for connections made before them, and the pure helpers. The shared cases both targets run
// through their shells are in src/egress-conformance.ts.

import { vaultCredentials } from "@kantel/connections/vault-store";
import {
	type CallContext,
	type ConnectionSessionScope,
	type SandboxEgressRequest,
	type SandboxEgressVerdict,
	systemContext,
} from "@kantel/contracts";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { createMemoryVaultStore } from "@kantel/vault/store";
import { describe, expect, it } from "vitest";
import { findPlaceholders, newConnectionPlaceholder, replacePlaceholder, secretHaystack } from "../src/placeholders.ts";
import { createMemoryConnectionsRepository } from "../src/repository.ts";
import { createConnections, redactBytes } from "../src/service.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const admin = human("admin");
const approver: CallContext = { actor: { kind: "human", userId: "admin" }, organisationId: ORG };
const scope: ConnectionSessionScope = {
	organisationId: ORG,
	sessionId: "ses_1",
	agentId: "agt_1",
	audience: { kind: "shared" },
};
const KEY = "sk-live-abcdefghijklmnop";

function setup() {
	const sent: { url: string; method: string; headers: Headers; body?: string }[] = [];
	const vault = createVault({
		store: createMemoryVaultStore(),
		cipher: createAesGcmCipher({ key: randomCipherKey() }),
	});
	const repository = createMemoryConnectionsRepository();
	const connections = createConnections({
		repository,
		// The vault's own store, so the raw-secret check is the vault's `find`.
		credentials: vaultCredentials(vault),
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
		approvals: vault,
		fetch: async (url, init) => {
			sent.push({
				url,
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				...(init?.body === undefined ? {} : { body: new TextDecoder().decode(init.body as Uint8Array) }),
			});
			return new Response(`{"echo":"${new Headers(init?.headers).get("x-api-key")}"}`, {
				headers: { "content-type": "application/json" },
			});
		},
	});
	const connect = () =>
		connections.connectKey(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "header", header: "X-Api-Key" }, kind: "http" },
			value: KEY,
			usage: { unattended: true, visibility: "shared" },
		});
	const placeholderOf = async (id: string) => {
		const usable = await connections.usable(SYSTEM, scope);
		return usable.find((each) => each.id === id)?.placeholder ?? "";
	};
	const egress = (request: SandboxEgressRequest): Promise<SandboxEgressVerdict> =>
		connections.sandboxEgress(SYSTEM, scope, request);
	return { vault, connections, repository, sent, connect, placeholderOf, egress };
}

const refusalOf = (verdict: SandboxEgressVerdict) => (verdict.outcome === "refuse" ? verdict.refusal : undefined);

describe("the sandbox egress gate", () => {
	it("holds a request a rule asks about, and sends the identical one once a person approves it", async () => {
		const env = setup();
		const connection = await env.connect();
		await env.connections.updateRules(admin, connection.id, { unmatched: "ask" });
		const ph = await env.placeholderOf(connection.id);
		const request: SandboxEgressRequest = {
			method: "POST",
			url: "https://api.example.com/v1/issues",
			headers: { "x-api-key": ph, "content-type": "application/json" },
			body: new TextEncoder().encode('{"title":"hi"}'),
		};
		const held = refusalOf(await env.egress(request));
		expect(held).toMatchObject({ error: "approval_pending", connectionId: connection.id });
		expect(held?.fix).toMatchObject({ action: "wait_for_approval" });
		expect(env.sent).toHaveLength(0);
		const status = await env.connections.approvalStatus(SYSTEM, scope, held!.approval!.id);
		expect(JSON.stringify(status)).not.toContain(KEY);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		const verdict = await env.egress(request);
		expect(verdict.outcome).toBe("respond");
		expect(env.sent).toHaveLength(1);
		expect(env.sent[0]?.headers.get("x-api-key")).toBe(KEY);
		expect(env.sent[0]?.body).toBe('{"title":"hi"}');
		// Single use: the same request waits again.
		expect(refusalOf(await env.egress(request))?.error).toBe("approval_pending");
		const uses = await env.connections.listUses(admin, { connectionId: connection.id });
		expect(uses.items.every((use) => use.via === "sandbox")).toBe(true);
		expect(uses.items.map((use) => use.outcome).sort()).toEqual(["allowed", "held", "held"]);
	});

	it("refuses a connection that needs reconnecting, and a raw secret before anything else", async () => {
		const env = setup();
		const connection = await env.connect();
		const ph = await env.placeholderOf(connection.id);
		const raw = refusalOf(
			await env.egress({ method: "GET", url: `https://elsewhere.example/?a=${KEY}&b=${ph}`, headers: {} }),
		);
		expect(raw?.error).toBe("raw_secret");
		const stored = await env.repository.get<{ connection: { status: string } }>("connection", connection.id);
		await env.repository.update("connection", connection.id, stored!.revision, {
			...stored!.value,
			connection: { ...stored!.value.connection, status: "needs_reauth" },
		});
		const verdict = await env.egress({
			method: "GET",
			url: "https://api.example.com/v1/me",
			headers: { "x-api-key": ph },
		});
		expect(refusalOf(verdict)).toMatchObject({ error: "needs_reauth", fix: { action: "reconnect" } });
		expect(env.sent).toHaveLength(0);
	});

	it("passes what carries nothing of a connection's, and gives a connection made before placeholders one, once", async () => {
		const env = setup();
		const connection = await env.connect();
		// As if it were connected before #331.
		const stored = await env.repository.get<{ placeholder?: string }>("connection", connection.id);
		const { placeholder: _dropped, ...before } = stored!.value;
		await env.repository.update("connection", connection.id, stored!.revision, before);
		const first = await env.placeholderOf(connection.id);
		expect(first).toMatch(/^kantel-conn-ph-[0-9a-f]{32}$/);
		expect(await env.placeholderOf(connection.id)).toBe(first);
		expect((await env.egress({ method: "GET", url: "https://example.org/", headers: { a: "b" } })).outcome).toBe(
			"pass",
		);
	});
});

describe("placeholder helpers", () => {
	it("makes random placeholders", () => {
		const made = new Set(Array.from({ length: 50 }, () => newConnectionPlaceholder()));
		expect(made.size).toBe(50);
	});

	it("finds placeholders in headers, the path, the query (encoded too) and a short body", () => {
		const ph = newConnectionPlaceholder();
		const encoded = encodeURIComponent(ph).replace("-", "%2D");
		expect(findPlaceholders({ method: "GET", url: `https://a.test/x?k=${encoded}`, headers: {} }).all.has(ph)).toBe(
			true,
		);
		const found = findPlaceholders({
			method: "POST",
			url: "https://a.test/",
			headers: {},
			body: new TextEncoder().encode(`{"k":"${ph}"}`),
		});
		expect([...found.inBody]).toEqual([ph]);
	});

	it("replaces a bare standard header with its standard form, and escapes for JSON and forms", () => {
		const ph = newConnectionPlaceholder();
		const value = 'a"b&c=d e';
		const request = {
			method: "POST",
			url: `https://a.test/${ph}?k=${ph}`,
			headers: { authorization: ph, "x-other": `pre ${ph}` },
			body: new TextEncoder().encode(`{"k":"${ph}"}`),
		};
		const json = replacePlaceholder(request, ph, value, {
			standard: { header: "Authorization", value: `Bearer ${value}` },
			body: "json",
		});
		expect(json.headers.authorization).toBe(`Bearer ${value}`);
		expect(json.headers["x-other"]).toBe(`pre ${value}`);
		expect(json.url).toBe(`https://a.test/${encodeURIComponent(value)}?k=${encodeURIComponent(value)}`);
		expect(JSON.parse(new TextDecoder().decode(json.body))).toEqual({ k: value });
		const form = replacePlaceholder({ ...request, body: new TextEncoder().encode(`k=${ph}`) }, ph, value, {
			body: "form",
		});
		expect(new URLSearchParams(new TextDecoder().decode(form.body)).get("k")).toBe(value);
	});

	it("looks for a raw secret inside a Basic credential too", () => {
		const texts = secretHaystack({
			method: "GET",
			url: "https://a.test/",
			headers: { authorization: `Basic ${btoa("user:sk-live-123456789")}` },
		});
		expect(texts.some((text) => text.includes("sk-live-123456789"))).toBe(true);
	});

	it("cuts a secret out of any body, byte for byte", () => {
		const secret = "sk-live-abcdefghijklmnop";
		const binary = new Uint8Array([0xff, 0x00, ...new TextEncoder().encode(secret), 0xfe]);
		const out = redactBytes(binary, [secret]);
		expect(out[0]).toBe(0xff);
		expect(out.at(-1)).toBe(0xfe);
		expect(new TextDecoder("latin1").decode(out)).toContain("[redacted]");
		const untouched = new Uint8Array([1, 2, 3]);
		expect(redactBytes(untouched, [secret])).toBe(untouched);
	});
});
