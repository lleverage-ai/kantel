import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type ConnectionSessionScope,
	KantelError,
	systemContext,
} from "@kantel/contracts";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { createMemoryVaultStore } from "@kantel/vault/store";
import { describe, expect, it } from "vitest";
import { memoryCredentials } from "../src/memory.ts";
import { createMemoryConnectionsRepository } from "../src/repository.ts";
import { createConnections, notConnected, stableJson, withoutQueryParam, withQueryParam } from "../src/service.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";
import { connectionTools } from "../src/tools.ts";

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

function setup(options: { fail?: () => Error | undefined } = {}) {
	const sent: { url: string; method: string; body?: string; headers: Headers }[] = [];
	// One log for the connections' events and the vault's, in the order they were written.
	const events: AuditEventInput[] = [];
	const audit: AuditSink = {
		append: async (_ctx, batch) => {
			events.push(...batch);
		},
	};
	const vault = createVault({
		store: createMemoryVaultStore(),
		cipher: createAesGcmCipher({ key: randomCipherKey() }),
		audit,
	});
	const repository = createMemoryConnectionsRepository();
	const connections = createConnections({
		repository,
		credentials: memoryCredentials(),
		audit,
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
		approvals: vault,
		fetch: async (url, init) => {
			const failure = options.fail?.();
			if (failure !== undefined) throw failure;
			sent.push({
				url,
				method: init?.method ?? "GET",
				...(typeof init?.body === "string" ? { body: init.body } : {}),
				headers: new Headers(init?.headers),
			});
			return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
		},
	});
	// Rules (#332): reads allowed, anything else asked about.
	const connect = async () => {
		const connection = await connections.connectKey(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "header", header: "X-Api-Key" }, kind: "http" },
			value: KEY,
			usage: { unattended: true, visibility: "shared" },
		});
		await connections.updateRules(admin, connection.id, { unmatched: "ask" });
		await connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "GET", path: "/**" },
			action: "allow",
		});
		return connection;
	};
	return { vault, connections, sent, connect, events, repository };
}

const post = {
	method: "POST",
	url: "https://api.example.com/v1/issues",
	body: '{"title":"hi"}',
	kind: "http",
} as const;

async function pendingOf(promise: Promise<unknown>): Promise<{ approvalId: string; digest: string; link: string }> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(KantelError);
	const details = (error as KantelError).details as {
		approvalId: string;
		digest: string;
		link: string;
		error: string;
	};
	expect(details.error).toBe("approval_pending");
	return details;
}

describe("a connection request a rule asks about", () => {
	it("is refused as approval_pending, nothing sent, until a person approves it", async () => {
		const env = setup();
		const connection = await env.connect();
		// A read is allowed by its rule.
		await env.connections.send(SYSTEM, scope, connection.id, {
			method: "GET",
			url: "https://api.example.com/v1/me",
			kind: "http",
		});
		expect(env.sent).toHaveLength(1);

		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		expect(pending.link).toMatch(/^https:\/\/harbour\.test\/.*requests\//);
		expect(pending.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(env.sent).toHaveLength(1);
		// Sending it again before a decision waits on the same approval.
		expect((await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post))).approvalId).toBe(
			pending.approvalId,
		);
		const status = await env.connections.approvalStatus(SYSTEM, scope, pending.approvalId);
		expect(status.status).toBe("pending");
		expect(status.terms.request).toMatchObject({ method: "POST", host: "api.example.com", path: "/v1/issues" });
		// Another session can't read it.
		await expect(
			env.connections.approvalStatus(SYSTEM, { ...scope, sessionId: "ses_2" }, pending.approvalId),
		).rejects.toMatchObject({ code: "not_found" });

		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		// A different request is not covered.
		await pendingOf(env.connections.send(SYSTEM, scope, connection.id, { ...post, body: '{"title":"other"}' }));
		expect(env.sent).toHaveLength(1);
		// The identical request goes out once, with the key added.
		const response = await env.connections.send(SYSTEM, scope, connection.id, post);
		expect(response.status).toBe(200);
		expect(env.sent).toHaveLength(2);
		expect(env.sent[1]!.headers.get("x-api-key")).toBe(KEY);
		expect(env.sent[1]!.body).toBe(post.body);
		// Single use.
		await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		expect(env.sent).toHaveLength(2);

		const uses = await env.connections.listUses(admin, { connectionId: connection.id });
		expect(uses.items.some((use) => use.approval?.state === "used" && use.outcome === "allowed")).toBe(true);
		// Waiting for a person is held, not denied (#333); nothing about it was refused.
		expect(uses.items.some((use) => use.approval?.state === "pending" && use.outcome === "held")).toBe(true);
		expect(uses.items.some((use) => use.outcome === "denied")).toBe(false);
		const types = env.events.map((event) => event.type);
		expect(types).toContain("connections.use.held");
		expect(types).toContain("connections.use.allowed");
		expect(types).not.toContain("connections.use.denied");
		// The key never reaches the approval or the uses.
		expect(JSON.stringify([uses, status])).not.toContain(KEY);
	});

	it("is refused outright by a deny rule, with no approval made", async () => {
		const env = setup();
		const connection = await env.connect();
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "POST", path: "/v1/**" },
			action: "deny",
		});
		const refusal = await env.connections.send(SYSTEM, scope, connection.id, post).catch((error: unknown) => error);
		expect(refusal).toMatchObject({ code: "refused" });
		expect((refusal as KantelError).details).toBeUndefined();
		expect(env.sent).toHaveLength(0);
		expect(await env.vault.listProposals(approver, { status: "pending" })).toMatchObject({ items: [] });
	});

	it("shows the request as it goes out: not the agent's copy of the credential header, which is overwritten", async () => {
		const env = setup();
		const connection = await env.connect();
		const pending = await pendingOf(
			env.connections.send(SYSTEM, scope, connection.id, {
				...post,
				url: "https://api.example.com/v1/issues?b=2&a=1",
				headers: { "X-Api-Key": "agent-made", Accept: "application/vnd.v2+json" },
			}),
		);
		const status = await env.connections.approvalStatus(SYSTEM, scope, pending.approvalId);
		const frozen = status.terms.request;
		expect(frozen?.search).toBe("b=2&a=1");
		expect(frozen?.headers).toEqual([{ name: "accept", value: "application/vnd.v2+json" }]);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		// Another Accept is another request: it asks again.
		await pendingOf(
			env.connections.send(SYSTEM, scope, connection.id, {
				...post,
				url: "https://api.example.com/v1/issues?b=2&a=1",
				headers: { Accept: "*/*" },
			}),
		);
		await env.connections.send(SYSTEM, scope, connection.id, {
			...post,
			url: "https://api.example.com/v1/issues?b=2&a=1",
			headers: { "X-Api-Key": "agent-made", Accept: "application/vnd.v2+json" },
		});
		expect(env.sent).toHaveLength(1);
		expect(env.sent[0]?.url).toBe("https://api.example.com/v1/issues?b=2&a=1");
		expect(env.sent[0]?.headers.get("x-api-key")).toBe(KEY);
	});

	it("saves 'always allow requests like this' only as an allow rule covering the approved request", async () => {
		const env = setup();
		const connection = await env.connect();
		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		const status = await env.connections.approvalStatus(SYSTEM, scope, pending.approvalId);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		const like = {
			who: { kind: "agent", agentId: "agt_1" },
			what: { kind: "endpoint", method: "POST", path: "/v1/issues", host: "api.example.com" },
			action: "allow",
		} as const;
		// Not an allow, not covering it, or for another connection: refused.
		await expect(
			env.connections.createRuleFromApproval(admin, connection.id, { ...like, action: "deny" }, status.id),
		).rejects.toMatchObject({ code: "invalid" });
		await expect(
			env.connections.createRuleFromApproval(
				admin,
				connection.id,
				{ ...like, what: { kind: "endpoint", method: "DELETE", path: "/v1/issues" } },
				status.id,
			),
		).rejects.toMatchObject({ code: "refused" });
		await expect(
			env.connections.createRuleFromApproval(
				admin,
				connection.id,
				{ ...like, who: { kind: "agent", agentId: "other" } },
				status.id,
			),
		).rejects.toMatchObject({ code: "refused" });
		const other = await env.connections.connectKey(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "header", header: "X-Api-Key" }, kind: "http" },
			value: KEY,
			usage: { unattended: true, visibility: "shared" },
		});
		await expect(env.connections.createRuleFromApproval(admin, other.id, like, status.id)).rejects.toMatchObject({
			code: "refused",
		});

		const rule = await env.connections.createRuleFromApproval(admin, connection.id, like, status.id);
		expect(rule).toMatchObject({ source: "approval", approvalId: status.id, action: "allow" });
		// Requests like it now go out without asking, whatever their body.
		await env.connections.send(SYSTEM, scope, connection.id, { ...post, body: '{"title":"another"}' });
		expect(env.sent).toHaveLength(1);
	});

	it("asks again after the rules change, and records the rule that asked", async () => {
		const env = setup();
		const connection = await env.connect();
		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		const status = await env.connections.approvalStatus(SYSTEM, scope, pending.approvalId);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		// An unrelated rule changes the rules' version: the approval was made under the old ones.
		await env.connections.createRule(admin, connection.id, {
			who: { kind: "any" },
			what: { kind: "endpoint", method: "DELETE", path: "/v1/**" },
			action: "deny",
		});
		const again = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		expect(again.approvalId).not.toBe(pending.approvalId);
		expect(again.digest).not.toBe(pending.digest);
		expect(env.sent).toHaveLength(0);
		const uses = await env.connections.listUses(admin, { connectionId: connection.id });
		expect(uses.items[0]).toMatchObject({ decision: "ask", decidedBy: "unmatched", approval: { state: "pending" } });
	});

	it("gives the approval back when the request never reached the upstream", async () => {
		let failNext = false;
		const env = setup({
			fail: () => {
				if (!failNext) return undefined;
				failNext = false;
				return Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
			},
		});
		const connection = await env.connect();
		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		const status = await env.connections.approvalStatus(SYSTEM, scope, pending.approvalId);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		failNext = true;
		await expect(env.connections.send(SYSTEM, scope, connection.id, post)).rejects.toMatchObject({
			code: "unavailable",
		});
		// The retry is still covered by the same approval.
		expect((await env.connections.send(SYSTEM, scope, connection.id, post)).status).toBe(200);
	});

	it("keeps the approval used when the failure may have sent bytes", async () => {
		let failNext = false;
		const env = setup({
			fail: () => {
				if (!failNext) return undefined;
				failNext = false;
				return Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
			},
		});
		const connection = await env.connect();
		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		const status = await env.connections.approvalStatus(SYSTEM, scope, pending.approvalId);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		failNext = true;
		await expect(env.connections.send(SYSTEM, scope, connection.id, post)).rejects.toMatchObject({
			code: "unavailable",
		});
		await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
	});
});

describe("disconnecting a connection with approvals (#329)", () => {
	it("withdraws its pending approvals, stops its approved ones not yet used, and removes its rules", async () => {
		const env = setup();
		const connection = await env.connect();
		const approved = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		const status = await env.connections.approvalStatus(SYSTEM, scope, approved.approvalId);
		await env.vault.decide(approver, {
			proposalId: status.id,
			outcome: "approve",
			termsHash: status.termsHash,
			pickedCode: status.bindingCode,
		});
		const other = { ...post, body: '{"title":"other"}' };
		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, other));

		const removal = await env.connections.remove(admin, connection.id);
		expect(removal).toMatchObject({
			revocation: { outcome: "unsupported" },
			rulesRemoved: 1,
			approvalsWithdrawn: 2,
		});
		expect(await env.vault.listProposals(approver, { status: "pending" })).toMatchObject({ items: [] });
		expect((await env.vault.getProposal(approver, pending.approvalId)).status).toBe("withdrawn");
		const types = env.events.map((event) => event.type);
		expect(types).toContain("connections.request.withdrawn");
		expect(types).toContain("connections.grant.revoked");
		const stopped = env.events.find((event) => event.type === "connections.grant.revoked");
		expect(stopped?.data).toMatchObject({ reason: "connection_removed", connectionId: connection.id });
		// The removal is the last word, after the approvals it ended.
		expect(types.at(-1)).toBe("connections.connection.removed");
		expect(env.events.at(-1)?.data).toMatchObject({
			revocation: "unsupported",
			rulesRemoved: 1,
			approvalsWithdrawn: 2,
		});
		// Nothing is sent for the approval made before the disconnect.
		await expect(env.connections.send(SYSTEM, scope, connection.id, post)).rejects.toMatchObject({
			code: "not_found",
		});
		expect(env.sent).toHaveLength(0);
		// Disconnecting is idempotent only in that the connection is gone.
		await expect(env.connections.remove(admin, connection.id)).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("connection_request waiting on an approval", () => {
	const record = {
		id: "ses_1",
		organisationId: ORG,
		agentId: "agt_1",
	} as never;

	async function run(
		env: ReturnType<typeof setup>,
		decide: (proposalId: string) => Promise<unknown>,
		context: { abortSignal?: AbortSignal } = {},
		connectionId?: string,
	) {
		const connection = connectionId === undefined ? await env.connect() : { id: connectionId };
		const tool = connectionTools({ connections: env.connections, approvalPollMs: 10 })(record).find(
			(registration) => registration.name === "connection_request",
		)!;
		const shown: { status: string; proposalId: string }[] = [];
		let decided = false;
		const api = {
			callId: "call_1",
			details: async (value: { connectionApproval: { status: string; proposalId: string } }) => {
				shown.push(value.connectionApproval);
				if (!decided) {
					decided = true;
					await decide(value.connectionApproval.proposalId);
				}
			},
		};
		const result = await tool.execute(
			{ connectionId: connection.id, method: "POST", url: post.url, body: post.body } as never,
			api as never,
			context as never,
		);
		return { result, shown, connectionId: connection.id };
	}

	it("leaves the approval open when the wait is interrupted, for the same call again", async () => {
		const env = setup();
		const stop = new AbortController();
		const first = await run(
			env,
			async () => {
				stop.abort();
			},
			{ abortSignal: stop.signal },
		);
		expect(first.result.isError).toBe(true);
		expect(JSON.stringify(first.result.output)).toContain("approval_pending");
		expect(env.sent).toHaveLength(0);
		const approvalId = first.shown[0]!.proposalId;
		const again = await run(
			env,
			async (proposalId) => {
				expect(proposalId).toBe(approvalId);
				const proposal = await env.vault.getProposal(approver, proposalId);
				await env.vault.decide(approver, {
					proposalId,
					outcome: "approve",
					termsHash: proposal.termsHash,
					pickedCode: proposal.bindingCode,
				});
			},
			{},
			first.connectionId,
		);
		expect(again.result.isError).toBe(false);
		expect(env.sent).toHaveLength(1);
	});

	it("shows the card, waits for the decision and sends the identical request once", async () => {
		const env = setup();
		const { result, shown } = await run(env, async (proposalId) => {
			const proposal = await env.vault.getProposal(approver, proposalId);
			await env.vault.decide(approver, {
				proposalId,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			});
		});
		expect(result.isError).toBe(false);
		expect(env.sent).toHaveLength(1);
		expect(shown.map((card) => card.status)).toEqual(["pending", "approved"]);
		expect((result.details as { connectionApproval: { status: string } }).connectionApproval.status).toBe("approved");
	});

	it("comes back refused, nothing sent, when the request is denied", async () => {
		const env = setup();
		const { result, shown } = await run(env, (proposalId) =>
			env.vault.decide(approver, { proposalId, outcome: "deny" }),
		);
		expect(result.isError).toBe(true);
		expect(env.sent).toHaveLength(0);
		expect(shown.at(-1)?.status).toBe("denied");
		expect(JSON.stringify(result.output)).toContain("approval_denied");
		// The log reads held, then the person's denial: never a use that went out.
		const types = env.events.map((event) => event.type).filter((type) => /^connections\.(use|decision)\./.test(type));
		expect(types).toEqual(["connections.use.held", "connections.decision.denied"]);
		const held = env.events.find((event) => event.type === "connections.use.held");
		expect(held?.data).toMatchObject({ decision: "ask", approval: "pending" });
	});

	it("reads a held use stored before held existed (denied, approval pending) as held", async () => {
		const env = setup();
		const connection = await env.connect();
		const pending = await pendingOf(env.connections.send(SYSTEM, scope, connection.id, post));
		const [written] = (await env.connections.listUses(admin, { connectionId: connection.id })).items;
		expect(written).toMatchObject({ outcome: "held", approval: { id: pending.approvalId, state: "pending" } });
		// As #433 stored it, and a plain refusal beside it, which stays denied.
		const legacy = { ...written!, id: "cu_legacy", outcome: "denied" as const };
		const refused = { ...written!, id: "cu_refused", outcome: "denied" as const, approval: undefined };
		for (const value of [legacy, refused]) {
			await env.repository.insert("use", {
				id: value.id,
				organisationId: ORG,
				key: connection.id,
				ref: scope.sessionId,
				value,
				createdAt: value.at,
			});
		}
		const uses = (await env.connections.listUses(admin, { connectionId: connection.id })).items;
		expect(uses.find((use) => use.id === "cu_legacy")?.outcome).toBe("held");
		expect(uses.find((use) => use.id === "cu_refused")?.outcome).toBe("denied");
	});
});

describe("helpers", () => {
	it("writes the same JSON for the same tool call however its arguments were ordered", () => {
		expect(stableJson({ b: [1, { d: 1, c: 2 }], a: "x" })).toBe(stableJson({ a: "x", b: [1, { c: 2, d: 1 }] }));
		expect(stableJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	it("sets a key in the query without re-encoding the rest", () => {
		const url = new URL("https://api.example.com/q?s=a%20b&t=a+b&api_key=fake&api%5Fkey=x");
		expect(withQueryParam(url, "api_key", "k/1").search).toBe("?s=a%20b&t=a+b&api_key=k%2F1");
		expect(withoutQueryParam(new URL("https://a.test/?api_key=1"), "api_key").href).toBe("https://a.test/");
	});

	it("knows a failure that never reached the upstream from one that may have", () => {
		expect(notConnected(Object.assign(new TypeError("x"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
		expect(notConnected(Object.assign(new TypeError("x"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }))).toBe(
			true,
		);
		expect(notConnected(Object.assign(new TypeError("x"), { cause: { code: "UND_ERR_SOCKET" } }))).toBe(false);
		expect(notConnected(new TypeError("Network connection lost."))).toBe(false);
	});
});
