import {
	type ApprovalRequestInput,
	type CallContext,
	type ConnectionApprovalCall,
	DEFAULT_REQUEST_APPROVAL_TTL_MS,
	systemContext,
} from "@harbour/contracts";
import { freezeRequest, narrow } from "@harbour/vault";
import { createAesGcmCipher, randomCipherKey } from "@harbour/vault/cipher";
import { createVault, type HarbourVault } from "@harbour/vault/engine";
import { createMemoryVaultStore } from "@harbour/vault/store";
import { describe, expect, it } from "vitest";

const SYSTEM = systemContext("connections");
const human: CallContext = { actor: { kind: "human", userId: "alice" }, organisationId: "org-a" };
const gateway = systemContext("egress-gateway");
const scope: { organisationId: string; sessionId: string; agentId: string } = {
	organisationId: "org-a",
	sessionId: "ses-1",
	agentId: "agt-1",
};
const who = { agentId: "agt-1", sessionId: "ses-1" } as const;

const request: ApprovalRequestInput = {
	connectionId: "conn_1",
	connectionName: "Example MCP",
	connectionVersion: "v1",
	owner: { kind: "organisation", organisationId: "org-a" },
	kind: "http",
	method: "POST",
	url: "https://api.example.com/issues?b=2&a=1",
	headers: { "Content-Type": "application/json", "User-Agent": "x/1", "X-Trace": "t" },
	body: '{"title":"hello"}',
	rulesVersion: "rules:1",
};

function setup(now = { t: 1_000_000 }) {
	const audit: { type: string; data?: unknown }[] = [];
	const vault = createVault({
		store: createMemoryVaultStore(),
		cipher: createAesGcmCipher({ key: randomCipherKey() }),
		clock: { now: () => now.t },
		audit: {
			append: async (_ctx: unknown, events: { type: string; data?: unknown }[]) => {
				audit.push(...events);
				return events;
			},
		} as never,
	});
	const use = (input: ApprovalRequestInput = request, at: typeof scope = scope) =>
		vault.connectionApproval(SYSTEM, { op: "use", scope: at, request: input, reason: "Open an issue" });
	return { vault, use, audit, now };
}

async function approve(vault: HarbourVault, proposalId: string) {
	const proposal = await vault.getProposal(human, proposalId);
	return vault.decide(human, {
		proposalId,
		outcome: "approve",
		termsHash: proposal.termsHash,
		pickedCode: proposal.bindingCode,
	});
}

describe("freezeRequest", () => {
	it("gives one digest to the same request however its headers were ordered, and keeps the query as written", async () => {
		const a = await freezeRequest(request, who);
		const b = await freezeRequest(
			{
				...request,
				url: "https://api.example.com:443/issues?b=2&a=1",
				headers: { "x-trace": "t", "user-agent": "x/1", "content-type": "application/json", Connection: "close" },
			},
			who,
		);
		expect(b.digest).toBe(a.digest);
		expect(a.search).toBe("b=2&a=1");
		expect(a.query).toEqual([
			{ name: "b", value: "2" },
			{ name: "a", value: "1" },
		]);
		// Hop-by-hop headers never leave, so they are not part of it.
		expect(b.headers.map((h) => h.name)).toEqual(["content-type", "user-agent", "x-trace"]);
		expect(a.port).toBe(443);
	});

	it("counts the query's order and spelling, and every header that goes out", async () => {
		const base = (await freezeRequest(request, who)).digest;
		const changes: Partial<ApprovalRequestInput>[] = [
			// An upstream that takes the first of two values does something else.
			{ url: "https://api.example.com/issues?a=1&b=2" },
			{ url: "https://api.example.com/issues?b=2&a=1&" },
			{ url: "https://api.example.com/issues?b=2&a" },
			{ headers: { ...request.headers, accept: "application/vnd.v2+json" } },
			{ headers: { ...request.headers, "User-Agent": "other" } },
		];
		for (const change of changes) {
			expect((await freezeRequest({ ...request, ...change }, who)).digest).not.toBe(base);
		}
	});

	it("gives a new digest to any change that matters", async () => {
		const base = (await freezeRequest(request, who)).digest;
		const changes: Partial<ApprovalRequestInput>[] = [
			{ method: "PUT" },
			{ url: "https://api.example.com/issues?b=2&a=1&c=3" },
			{ url: "https://api.example.com/issue?b=2&a=1" },
			{ url: "https://api.example.com:8443/issues?b=2&a=1" },
			{ url: "http://api.example.com/issues?b=2&a=1" },
			{ url: "https://other.example.com/issues?b=2&a=1" },
			{ body: '{"title":"hello!"}' },
			{ headers: { "content-type": "text/plain", "x-trace": "t" } },
			{ connectionVersion: "v2" },
			{ connectionId: "conn_2" },
			{ rulesVersion: "rules:2" },
		];
		for (const change of changes) {
			expect((await freezeRequest({ ...request, ...change }, who)).digest).not.toBe(base);
		}
		expect((await freezeRequest(request, { ...who, sessionId: "ses-2" })).digest).not.toBe(base);
		expect((await freezeRequest(request, { ...who, agentId: "agt-2" })).digest).not.toBe(base);
	});

	it("keeps the query as written: a+b and a%20b are different requests", async () => {
		const plus = await freezeRequest({ ...request, url: "https://api.example.com/q?s=a+b" }, who);
		const space = await freezeRequest({ ...request, url: "https://api.example.com/q?s=a%20b" }, who);
		expect(plus.digest).not.toBe(space.digest);
		expect(plus.query).toEqual([{ name: "s", value: "a+b" }]);
	});

	it("hashes the body and refuses one too big to show", async () => {
		const frozen = await freezeRequest(request, who);
		expect(frozen.bodySha256).toMatch(/^[0-9a-f]{64}$/);
		await expect(freezeRequest({ ...request, body: "x".repeat(256 * 1024 + 1) }, who)).rejects.toMatchObject({
			code: "invalid",
		});
	});

	it("is approved as it is or denied, never narrowed", async () => {
		const frozen = await freezeRequest(request, who);
		expect(() =>
			narrow(
				{
					route: { host: frozen.host, methods: ["POST"], pathPrefix: frozen.path },
					lifetime: {},
					reason: "r",
					request: frozen,
				},
				{ maxUses: 1 },
			),
		).toThrow(/approved as it is or denied/);
	});
});

describe("the vault's exact-request approvals", () => {
	it("proposes a request once, however often it is sent, and refuses it until decided", async () => {
		const { use, vault, audit } = setup();
		const first = await use();
		expect(first.outcome).toBe("pending");
		if (first.outcome !== "pending") return;
		expect(first.proposal.kind).toBe("request");
		expect(first.proposal.terms.request?.digest).toBe(first.digest);
		expect(first.proposal.link).toContain(first.proposal.id);
		const again = await use();
		expect(again).toMatchObject({ outcome: "pending", proposal: { id: first.proposal.id } });
		expect((await vault.listProposals(human, {})).items).toHaveLength(1);
		// The audit names the digest, never the body.
		const created = audit.find((event) => event.type === "connections.request.created");
		expect(created?.data).toMatchObject({ digest: first.digest, connectionId: "conn_1" });
		expect(JSON.stringify(audit)).not.toContain("hello");
	});

	it("lets the identical request out once after approval, and nothing else", async () => {
		const { use, vault, audit } = setup();
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		const decision = await approve(vault, pending.proposal.id);
		expect(decision.grantId).toBeDefined();
		const grant = await vault.getGrant(human, decision.grantId!);
		expect(grant).toMatchObject({ maxUses: 1, requestDigest: pending.digest, connectionId: "conn_1" });

		// A changed body is a new request: a new approval, not this one.
		const changed = await use({ ...request, body: '{"title":"bye"}' });
		expect(changed.outcome).toBe("pending");
		if (changed.outcome === "pending") expect(changed.proposal.id).not.toBe(pending.proposal.id);
		// Another session's identical request does not get it either.
		expect((await use(request, { ...scope, sessionId: "ses-2" })).outcome).toBe("pending");

		const used = await use();
		expect(used).toMatchObject({ outcome: "approved", proposalId: pending.proposal.id, digest: pending.digest });
		// Single use: the same request again needs a new approval.
		const after = await use();
		expect(after.outcome).toBe("pending");
		if (after.outcome === "pending") expect(after.proposal.id).not.toBe(pending.proposal.id);
		expect(audit.some((event) => event.type === "connections.approval.used")).toBe(true);
	});

	it("gives one of two identical sends at once the approval", async () => {
		const { use, vault } = setup();
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		await approve(vault, pending.proposal.id);
		const results = await Promise.all([use(), use(), use()]);
		expect(results.filter((result) => result.outcome === "approved")).toHaveLength(1);
	});

	it("needs the binding code the session shows to approve", async () => {
		const { use, vault } = setup();
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		await expect(
			vault.decide(human, {
				proposalId: pending.proposal.id,
				outcome: "approve",
				termsHash: pending.proposal.termsHash,
			}),
		).rejects.toBeDefined();
	});

	it("refuses a denied request and asks again on the next send", async () => {
		const { use, vault } = setup();
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		await vault.decide(human, { proposalId: pending.proposal.id, outcome: "deny" });
		const status = await vault.connectionApproval(SYSTEM, {
			op: "status",
			organisationId: "org-a",
			proposalId: pending.proposal.id,
		});
		expect(status).toMatchObject({ outcome: "status", proposal: { status: "denied" } });
		const next = await use();
		expect(next.outcome).toBe("pending");
	});

	it("lets an approval expire unused", async () => {
		const { use, vault, now } = setup();
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		await approve(vault, pending.proposal.id);
		now.t += DEFAULT_REQUEST_APPROVAL_TTL_MS + 1;
		expect((await use()).outcome).toBe("pending");
	});

	it("gives an approval back once when the request never left", async () => {
		const { use, vault, audit } = setup();
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		await approve(vault, pending.proposal.id);
		const used = await use();
		if (used.outcome !== "approved") throw new Error("expected approved");
		const release: ConnectionApprovalCall = {
			op: "release",
			organisationId: "org-a",
			grantId: used.grantId,
			digest: used.digest,
		};
		await vault.connectionApproval(SYSTEM, release);
		// A second release gives back nothing more.
		await vault.connectionApproval(SYSTEM, release);
		expect((await use()).outcome).toBe("approved");
		expect((await use()).outcome).toBe("pending");
		expect(audit.filter((event) => event.type === "connections.approval.released")).toHaveLength(1);
		await expect(vault.connectionApproval(SYSTEM, { ...release, digest: "0".repeat(64) })).rejects.toMatchObject({
			code: "not_found",
		});
	});

	it("never lets an exact-request approval out through the egress proxy", async () => {
		const { use, vault } = setup();
		await vault.putItem(human, {
			owner: { kind: "organisation", organisationId: "org-a" },
			name: "api-key",
			hosts: ["api.example.com"],
			injection: { header: "Authorization", template: "Bearer {key}" },
			value: "secret-value-1",
		});
		const pending = await use();
		if (pending.outcome !== "pending") throw new Error("expected pending");
		await approve(vault, pending.proposal.id);
		const egress = await vault.decideEgress(gateway, {
			organisationId: "org-a",
			agentId: "agt-1",
			sessionId: "ses-1",
			method: "POST",
			url: "https://api.example.com/issues?a=1&b=2",
		});
		expect(egress.allow).toBe(false);
	});

	it("is a worker call, and refuses an exact request proposed by hand", async () => {
		const { vault } = setup();
		await expect(
			vault.connectionApproval(human as never, { op: "use", scope, request, reason: "r" }),
		).rejects.toBeDefined();
		const frozen = await freezeRequest(request, who);
		await expect(
			vault.propose({ actor: { kind: "agent", agentId: "agt-1", sessionId: "ses-1" }, organisationId: "org-a" }, {
				route: { host: frozen.host, methods: ["POST"], pathPrefix: frozen.path },
				lifetime: { maxUses: 1 },
				reason: "r",
				request: frozen,
			} as never),
		).rejects.toMatchObject({ code: "invalid" });
	});
});
