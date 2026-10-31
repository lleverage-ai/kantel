import {
	type CallContext,
	KantelError,
	isKantelError,
	type PasskeyAssertion,
	type PasskeyBinding,
	type PasskeyChallenge,
	type Proposal,
	type ProposalTerms,
	systemContext,
	type VaultItem,
} from "@kantel/contracts";
import { actors, contextFor, createDeps } from "@kantel/testing/harness";
import { narrow } from "@kantel/vault";
import {
	APPROVAL_API_BASE,
	APPROVAL_API_DEPRECATION,
	approvalClientAsVault,
	createVaultApprovalApi,
	createVaultApprovalClient,
	isApprovalApiPath,
	VAULT_APPROVAL_API_BASE,
	type VaultApprovalApiOptions,
	type VaultApprovalClient,
} from "@kantel/vault/approval-api";
import type { KantelVault } from "@kantel/vault/engine";
import { createMemoryVault } from "@kantel/vault/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";
const HOST = "api.github.com";
const ORIGIN = "https://harbour.test";
const systemContextFor = () => systemContext("egress-gateway");
const SECRET = "approval-api-test-value-6f1d";

/** Each caller the API takes, by the test header that stands in for a sign-in. */
const callers = {
	admin: contextFor(actors.human("admin-1"), ORG),
	approver: contextFor(actors.human("approver-1"), ORG),
	/** Opens a forwarded link: viewer on the project, so they may see the request but not decide it. */
	forwarded: contextFor(actors.human("viewer-1"), ORG),
	/** Operator on the other project only. */
	outsider: contextFor(actors.human("operator-b"), ORG),
	/** Holds no role at all. */
	stranger: contextFor(actors.human("stranger-1"), ORG),
	agent: contextFor(actors.agent("agent-1", "session-1"), ORG, PROJECT),
} satisfies Record<string, CallContext>;
type Caller = keyof typeof callers;

const routeTerms = (itemId: string): ProposalTerms => ({
	itemId,
	route: { host: HOST, methods: ["GET", "POST"], pathPrefix: "/repos" },
	lifetime: { ttlMs: 3_600_000 },
	reason: "Open pull requests on the acme repositories",
});

/**
 * The two ways a gateway serves the API: in front of a vault with no project access of its own, the API checking
 * (the Cloudflare VaultDO's shape); or in front of a vault that checks itself (the self-hosted shape).
 */
const checks = [
	{ name: "the API checks project access", apiChecks: true },
	{ name: "the vault checks project access", apiChecks: false },
] as const;

/**
 * Each check, over the API's routes (`/v1/connection-approvals/requests/...`) and over the deprecated aliases a client
 * written before #324 calls (`/v1/vault/proposals/...`), whose every answer must say it is deprecated.
 */
const shapes = checks.flatMap((check) => [
	{ ...check, routes: "current" as const },
	{ ...check, name: `${check.name}, by the deprecated /v1/vault routes`, routes: "deprecated" as const },
]);

/** A client's URL on the deprecated routes: the old base, and `proposals` for `requests`. */
function deprecatedUrl(input: string): string {
	const url = new URL(input);
	if (url.pathname.startsWith(`${APPROVAL_API_BASE}/`)) {
		url.pathname = `${VAULT_APPROVAL_API_BASE}${url.pathname.slice(APPROVAL_API_BASE.length)}`.replace(
			`${VAULT_APPROVAL_API_BASE}/requests`,
			`${VAULT_APPROVAL_API_BASE}/proposals`,
		);
	}
	return url.toString();
}

async function setUpWith(
	apiChecks: boolean,
	extra: Pick<VaultApprovalApiOptions, "passkeys"> = {},
	routes: "current" | "deprecated" = "current",
) {
	const deps = createDeps();
	const { tenancy } = deps;
	tenancy.bind(callers.admin.actor, ORG, "admin");
	tenancy.bind(callers.approver.actor, ORG, "operator", PROJECT);
	tenancy.bind(callers.forwarded.actor, ORG, "viewer", PROJECT);
	tenancy.bind(callers.outsider.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });

	const vault: KantelVault = createMemoryVault({
		clock: deps.clock,
		audit: deps.audit,
		...(apiChecks ? {} : { access: deps.access }),
	});
	const item: VaultItem = await vault.putItem(callers.admin, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		name: "GitHub token",
		hosts: [HOST],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: SECRET,
	});
	// Without project access the vault takes the proposal's project from the call, as the agent's session would give it.
	const proposal = await vault.propose(callers.agent, routeTerms(item.id));

	const handler = createVaultApprovalApi({
		vault,
		...(apiChecks ? { access: deps.access } : {}),
		async authenticate(request) {
			const who = request.headers.get("x-test-caller") as Caller | null;
			if (who === null || !(who in callers)) throw new KantelError("forbidden", "Sign in first");
			return callers[who];
		},
		viewerName: async (ctx) => (ctx.actor.kind === "human" ? `Person ${ctx.actor.userId}` : undefined),
		describeRequester: async (_ctx, found) => ({
			organisation: "Acme",
			project: "Default",
			agent: found.requester.agentId ?? "",
		}),
		...(extra.passkeys === undefined ? {} : { passkeys: extra.passkeys, audit: deps.audit, clock: deps.clock }),
	});
	const fetchVia: typeof fetch = async (input, init) => {
		if (routes === "current") {
			const response = await handler(new Request(input, init));
			expect(response.headers.get("deprecation")).toBeNull();
			return response;
		}
		const response = await handler(new Request(deprecatedUrl(String(input)), init));
		expect(response.headers.get("deprecation")).toBe(APPROVAL_API_DEPRECATION);
		expect(response.headers.get("link")).toContain(`<${APPROVAL_API_BASE}/`);
		return response;
	};
	const client = (who: Caller): VaultApprovalClient =>
		createVaultApprovalClient({
			baseUrl: `${ORIGIN}${APPROVAL_API_BASE}`,
			headers: () => ({ "x-test-caller": who }),
			fetch: fetchVia,
		});
	return { deps, vault, item, proposal, handler, client };
}

const setUp = (apiChecks: boolean, extra: Pick<VaultApprovalApiOptions, "passkeys"> = {}) =>
	setUpWith(apiChecks, extra);

async function rejection(promise: Promise<unknown>): Promise<KantelError> {
	try {
		await promise;
	} catch (error) {
		if (isKantelError(error)) return error;
		throw error;
	}
	throw new Error("it resolved");
}

const wrongCodeOf = (choices: readonly string[], proposal: Proposal) =>
	choices.find((choice) => choice !== proposal.bindingCode)!;

describe.each(shapes)("createVaultApprovalApi: $name", ({ apiChecks, routes }) => {
	const setUp = (checks: boolean, extra: Pick<VaultApprovalApiOptions, "passkeys"> = {}) =>
		setUpWith(checks, extra, routes);
	it("gets and lists proposals, and opens the approval view with the codes to pick from", async () => {
		const { client, proposal } = await setUp(apiChecks);
		const approver = client("approver");
		expect(await approver.getProposal(proposal.id)).toEqual(proposal);
		const pending = await approver.listProposals({ status: "pending" });
		expect(pending.items.map((found) => found.id)).toEqual([proposal.id]);
		expect((await approver.listProposals({ status: "approved" })).items).toEqual([]);
		const view = await approver.approvalView(proposal.id);
		expect(view.codeRequired).toBe(true);
		expect(view.codeChoices).toContain(proposal.bindingCode);
		expect(view.codeChoices.length).toBeGreaterThanOrEqual(4);
		expect(await approver.viewer()).toEqual({
			actor: callers.approver.actor,
			organisationId: ORG,
			name: "Person approver-1",
		});
		expect(await approver.requester(proposal.id)).toEqual({
			organisation: "Acme",
			project: "Default",
			agent: "agent-1",
		});
	});

	it("approves a narrowed request into a grant whose terms are the ones the approver saw", async () => {
		const { client, proposal, deps } = await setUp(apiChecks);
		const approver = client("approver");
		const view = await approver.approvalView(proposal.id);
		const narrowing = { methods: ["GET" as const], pathPrefix: "/repos/acme", ttlMs: 600_000, maxUses: 5 };
		// What the page shows the approver before they approve: the vault's own narrowing of the proposed terms.
		const shown = narrow(view.proposal.terms, narrowing);
		const decidedAt = deps.clock.now();
		const decision = await approver.decide({
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: view.proposal.termsHash,
			pickedCode: proposal.bindingCode,
			narrowing,
		});
		expect(decision).toMatchObject({ outcome: "approved", decidedBy: callers.approver.actor });
		expect(decision.effectiveTerms).toEqual({
			itemId: proposal.terms.itemId,
			route: shown.route,
			expiresAt: decidedAt + shown.lifetime.ttlMs!,
			maxUses: shown.lifetime.maxUses,
		});
		const grants = await approver.listGrants({ status: "active" });
		expect(grants.items).toHaveLength(1);
		const grant = grants.items[0]!;
		expect(grant.id).toBe(decision.grantId);
		expect(grant.route).toEqual(shown.route);
		expect(grant.route).toEqual({ host: HOST, methods: ["GET"], pathPrefix: "/repos/acme" });
		expect(grant.expiresAt).toBe(decidedAt + 600_000);
		expect(grant.maxUses).toBe(5);
		expect(await approver.getGrant(grant.id)).toEqual(grant);
		expect((await approver.getProposal(proposal.id)).status).toBe("approved");
	});

	it("refuses a wrong binding code, audits it as connections.binding_code.mismatch and leaves the request pending", async () => {
		const { client, proposal, deps } = await setUp(apiChecks);
		const approver = client("approver");
		const view = await approver.approvalView(proposal.id);
		const picked = wrongCodeOf(view.codeChoices, proposal);
		const refused = await rejection(
			approver.decide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: picked,
			}),
		);
		expect(refused.code).toBe("refused");
		const mismatches = deps.audit.ofType("connections.binding_code.mismatch");
		expect(mismatches).toHaveLength(1);
		expect(mismatches[0]).toMatchObject({ actor: callers.approver.actor, subject: { id: proposal.id } });
		expect(mismatches[0]!.data).toMatchObject({ pickedCode: picked });
		expect((await approver.getProposal(proposal.id)).status).toBe("pending");
		expect((await approver.listGrants()).items).toEqual([]);
	});

	it("shows a forwarded request to a project viewer but refuses their approval, audited as access.denied", async () => {
		const { client, proposal, deps } = await setUp(apiChecks);
		const forwarded = client("forwarded");
		expect((await forwarded.getProposal(proposal.id)).id).toBe(proposal.id);
		const before = deps.audit.ofType("access.denied").length;
		expect((await rejection(forwarded.approvalView(proposal.id))).code).toBe("forbidden");
		const refused = await rejection(
			forwarded.decide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			}),
		);
		expect(refused.code).toBe("forbidden");
		expect((await rejection(forwarded.decide({ proposalId: proposal.id, outcome: "deny" }))).code).toBe("forbidden");
		const denied = deps.audit.ofType("access.denied").slice(before);
		expect(denied.map((event) => event.data?.operation)).toEqual([
			"vault.approvalView",
			"vault.decide",
			"vault.decide",
		]);
		expect((await client("approver").getProposal(proposal.id)).status).toBe("pending");
		expect(deps.audit.ofType("connections.decision.approved")).toEqual([]);
	});

	it("refuses an agent the approval view and the decision, even in its own session", async () => {
		const { client, proposal } = await setUp(apiChecks);
		const agent = client("agent");
		expect((await rejection(agent.approvalView(proposal.id))).code).toBe("forbidden");
		const refused = await rejection(
			agent.decide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			}),
		);
		expect(refused.code).toBe("forbidden");
	});

	it("hides another project's requests and grants from lists and refuses reading them", async () => {
		const { client, proposal } = await setUp(apiChecks);
		await client("approver").decide({
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		for (const who of ["outsider", "stranger"] as const) {
			const caller = client(who);
			expect((await caller.listProposals()).items).toEqual([]);
			expect((await caller.listGrants()).items).toEqual([]);
			expect((await rejection(caller.getProposal(proposal.id))).code).toBe("forbidden");
			expect((await rejection(caller.listGrants({ sessionId: "session-1" }))).code).toBe("forbidden");
		}
		expect((await client("admin").listProposals()).items).toHaveLength(1);
	});

	it("denies a request, and stops a grant for an operator but not a viewer", async () => {
		const { client, vault, item, proposal } = await setUp(apiChecks);
		const approver = client("approver");
		const denied = await approver.decide({ proposalId: proposal.id, outcome: "deny", note: "Not this week" });
		expect(denied).toMatchObject({ outcome: "denied", note: "Not this week" });
		expect((await approver.getProposal(proposal.id)).status).toBe("denied");

		const second = await vault.propose(callers.agent, routeTerms(item.id));
		const approved = await approver.decide({
			proposalId: second.id,
			outcome: "approve",
			termsHash: second.termsHash,
			pickedCode: second.bindingCode,
		});
		const grantId = approved.grantId!;
		expect((await rejection(client("forwarded").revokeGrant(grantId))).code).toBe("forbidden");
		expect((await approver.getGrant(grantId)).status).toBe("active");
		const stopped = await approver.revokeGrant(grantId, "Stopped on the vault page");
		expect(stopped).toMatchObject({ id: grantId, status: "revoked", endReason: "revoked" });
		expect((await approver.listGrants({ status: "active" })).items).toEqual([]);
		expect((await approver.listGrants({ status: "revoked" })).items.map((grant) => grant.id)).toEqual([grantId]);
	});

	it("blocks and unblocks a session over the API, for an operator only, and reads its egress usage", async () => {
		const { client, vault, item, handler } = await setUp(apiChecks);
		await vault.putPolicy(callers.admin, {
			itemId: item.id,
			selector: { organisationId: ORG, projectId: PROJECT },
			route: { host: HOST, methods: ["GET"], pathPrefix: "/user" },
		});
		const worker = systemContextFor();
		const egress = {
			organisationId: ORG,
			projectId: PROJECT,
			agentId: "agent-1",
			sessionId: "session-1",
			method: "GET" as const,
			url: `https://${HOST}/user`,
		};
		expect((await vault.decideEgress(worker, egress)).allow).toBe(true);

		const approver = client("approver");
		expect(await approver.getSessionAccess("session-1")).toEqual({
			sessionId: "session-1",
			blocked: false,
			generation: 0,
		});
		expect((await rejection(client("forwarded").setSessionAccess("session-1", { blocked: true }))).code).toBe(
			"forbidden",
		);
		expect((await rejection(client("agent").setSessionAccess("session-1", { blocked: true }))).code).toBe("forbidden");
		expect((await rejection(client("outsider").getSessionUsage("session-1"))).code).toBe("forbidden");
		const bad = await handler(
			new Request(`${ORIGIN}${APPROVAL_API_BASE}/sessions/session-1/access`, {
				method: "POST",
				headers: { "x-test-caller": "approver", "content-type": "application/json" },
				body: JSON.stringify({ blocked: "yes" }),
			}),
		);
		expect(bad.status).toBe(400);

		const blocked = await approver.setSessionAccess("session-1", { blocked: true, reason: "Runaway loop" });
		expect(blocked).toMatchObject({ sessionId: "session-1", blocked: true, reason: "Runaway loop" });
		expect((await vault.decideEgress(worker, egress)).allow).toBe(false);
		expect(await client("forwarded").getSessionAccess("session-1")).toMatchObject({ blocked: true });
		const usage = await client("forwarded").getSessionUsage("session-1");
		expect(usage).toMatchObject({ sessionId: "session-1", requests: 2, injected: 1, denied: 1 });
		expect(usage.hosts).toEqual([{ host: HOST, injected: 1, denied: 1 }]);
		expect(JSON.stringify(usage)).not.toContain(SECRET);

		expect(await approver.setSessionAccess("session-1", { blocked: false })).toMatchObject({ blocked: false });
		expect((await vault.decideEgress(worker, egress)).allow).toBe(true);
	});

	it("reads an item's name and injection, never its value", async () => {
		const { client, handler, item } = await setUp(apiChecks);
		const read = await client("approver").getItem(item.id);
		expect(read).toMatchObject({ id: item.id, name: "GitHub token", hasValue: true });
		const raw = await handler(
			new Request(`${ORIGIN}${APPROVAL_API_BASE}/items/${item.id}`, { headers: { "x-test-caller": "approver" } }),
		);
		expect(await raw.text()).not.toContain(SECRET);
		expect((await rejection(client("stranger").getItem(item.id))).code).toBe("forbidden");
	});

	it("runs @kantel/ui-style contract code over HTTP through approvalClientAsVault", async () => {
		const { client, proposal } = await setUp(apiChecks);
		const vault = approvalClientAsVault(client("approver"));
		const ctx = callers.approver;
		const view = await vault.approvalView(ctx, proposal.id);
		const decision = await vault.decide(ctx, {
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: view.proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		expect((await vault.getGrant(ctx, decision.grantId!)).status).toBe("active");
	});
});

/**
 * Passkeys as the approval API sees them: a stand-in for `@kantel/identity/passkey` that issues single-use challenges
 * bound to the person and the binding, and "verifies" an assertion whose signature is "ok". Identity's own tests prove
 * the WebAuthn; the Cloudflare gateway's prove the two together.
 */
function fakePasskeys(options: { required?: boolean } = {}) {
	const challenges = new Map<string, { userId: string; binding: PasskeyBinding }>();
	const canonical = (binding: PasskeyBinding) =>
		JSON.stringify({
			...binding,
			narrowing: binding.narrowing === undefined ? null : { ...binding.narrowing },
		});
	const refuse = (passkey: string) => new KantelError("refused", `Passkey refused: ${passkey}`, { passkey });
	const userOf = (ctx: CallContext) => (ctx.actor.kind === "human" ? ctx.actor.userId : "");
	const issued: PasskeyBinding[] = [];
	const passkeys = {
		issued,
		required: async (ctx: CallContext) => options.required ?? ctx.actor.kind === "human",
		async approvalChallenge(ctx: CallContext, rp: { id: string }, binding: PasskeyBinding): Promise<PasskeyChallenge> {
			const challenge = `challenge-${challenges.size + 1}`;
			challenges.set(challenge, { userId: userOf(ctx), binding });
			issued.push(binding);
			return {
				challenge,
				rpId: rp.id,
				allowCredentials: [],
				userVerification: "required",
				timeout: 120_000,
				expiresAt: 0,
			};
		},
		async verifyApproval(ctx: CallContext, binding: PasskeyBinding, assertion: PasskeyAssertion) {
			const record = challenges.get(assertion.response.clientDataJSON);
			challenges.delete(assertion.response.clientDataJSON);
			if (record === undefined || record.userId !== userOf(ctx)) throw refuse("challenge");
			if (canonical(record.binding) !== canonical(binding)) throw refuse("binding");
			if (assertion.response.signature !== "ok") throw refuse("signature");
			return {};
		},
	};
	return passkeys;
}

const assertionFor = (challenge: PasskeyChallenge, signature = "ok"): PasskeyAssertion => ({
	id: "cred",
	rawId: "cred",
	type: "public-key",
	response: { clientDataJSON: challenge.challenge, authenticatorData: "AA", signature },
});

describe.each(shapes)("createVaultApprovalApi with passkeys: $name", ({ apiChecks, routes }) => {
	const setUp = (checks: boolean, extra: Pick<VaultApprovalApiOptions, "passkeys"> = {}) =>
		setUpWith(checks, extra, routes);
	async function withPasskeys(options: { required?: boolean } = {}) {
		const passkeys = fakePasskeys(options);
		const world = await setUp(apiChecks, { passkeys });
		return { ...world, passkeys, audit: world.deps.audit };
	}
	const approval = (proposal: Proposal, extra: Record<string, unknown> = {}) => ({
		proposalId: proposal.id,
		outcome: "approve" as const,
		termsHash: proposal.termsHash,
		pickedCode: proposal.bindingCode,
		...extra,
	});

	it("says the viewer needs a passkey, and approves with an assertion over the terms and narrowing shown", async () => {
		const { client, proposal, passkeys, audit } = await withPasskeys();
		const approver = client("approver");
		expect(await approver.viewer()).toMatchObject({ passkeyRequired: true });
		const narrowing = { methods: ["GET" as const], ttlMs: 600_000 };
		const challenge = await approver.passkeyChallenge(proposal.id, { termsHash: proposal.termsHash, narrowing });
		expect(challenge.rpId).toBe("harbour.test");
		// The action comes from the proposal's kind, never the caller.
		expect(passkeys.issued).toEqual([
			{ proposalId: proposal.id, termsHash: proposal.termsHash, action: "approve", narrowing },
		]);
		const decision = await approver.decide(
			approval(proposal, { narrowing, passkeyAssertion: assertionFor(challenge) }),
		);
		expect(decision.outcome).toBe("approved");
		expect(audit.ofType("connections.passkey.refused")).toEqual([]);
	});

	it("refuses an approval without a passkey, audits it as connections.passkey.refused and leaves the request pending", async () => {
		const { client, proposal, audit } = await withPasskeys();
		const approver = client("approver");
		const refused = await rejection(approver.decide(approval(proposal)));
		expect(refused.code).toBe("refused");
		expect(refused.details).toEqual({ passkey: "missing" });
		const events = audit.ofType("connections.passkey.refused");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			source: "vault",
			actor: callers.approver.actor,
			organisationId: ORG,
			projectId: PROJECT,
			sessionId: "session-1",
			agentId: "agent-1",
			subject: { kind: "vault.proposal", id: proposal.id },
			data: { kind: "route", reason: "missing" },
		});
		expect((await approver.getProposal(proposal.id)).status).toBe("pending");
		// Nothing reached the vault: no binding-code check was made.
		expect(audit.ofType("connections.binding_code.mismatch")).toEqual([]);
	});

	it.each([
		["a bad signature", "signature", { signature: "forged" }],
		["another narrowing", "binding", { narrowing: { methods: ["GET", "POST"] } }],
		["no narrowing", "binding", { narrowing: undefined }],
		["other terms", "binding", { termsHash: "stale" }],
	] as const)("refuses and audits an assertion with %s", async (_, reason, change) => {
		const { client, proposal, audit } = await withPasskeys();
		const approver = client("approver");
		const narrowing = { methods: ["GET" as const] };
		const challenge = await approver.passkeyChallenge(proposal.id, { termsHash: proposal.termsHash, narrowing });
		const { signature, ...decided } = { signature: "ok", narrowing, ...change } as Record<string, unknown>;
		const refused = await rejection(
			approver.decide(
				approval(proposal, { ...decided, passkeyAssertion: assertionFor(challenge, signature as string) }),
			),
		);
		expect(refused.details).toEqual({ passkey: reason });
		expect(audit.ofType("connections.passkey.refused").map((event) => event.data?.reason)).toEqual([reason]);
		expect((await approver.getProposal(proposal.id)).status).toBe("pending");
	});

	it("takes an assertion once: a replayed one is refused", async () => {
		const { client, proposal, audit } = await withPasskeys();
		const approver = client("approver");
		const challenge = await approver.passkeyChallenge(proposal.id, { termsHash: proposal.termsHash });
		// A wrong code after a good passkey: the vault refuses the code, and the challenge is spent.
		const wrong = await rejection(
			approver.decide(approval(proposal, { pickedCode: "AAA-AAA", passkeyAssertion: assertionFor(challenge) })),
		);
		expect(wrong.details).toBeUndefined();
		expect(audit.ofType("connections.binding_code.mismatch")).toHaveLength(1);
		const replay = await rejection(approver.decide(approval(proposal, { passkeyAssertion: assertionFor(challenge) })));
		expect(replay.details).toEqual({ passkey: "challenge" });
	});

	it("refuses a challenge to someone who may not decide the request, and an agent", async () => {
		const { client, proposal, passkeys } = await withPasskeys();
		for (const who of ["forwarded", "outsider", "agent"] as const) {
			const refused = await rejection(client(who).passkeyChallenge(proposal.id, { termsHash: proposal.termsHash }));
			expect(refused.code, who).toMatch(/forbidden|not_found/);
		}
		expect(passkeys.issued).toEqual([]);
	});

	it("lets a denial through without a passkey, and an approval when the person needs none yet", async () => {
		const denied = await withPasskeys();
		const decision = await denied.client("approver").decide({ proposalId: denied.proposal.id, outcome: "deny" });
		expect(decision.outcome).toBe("denied");
		const optional = await withPasskeys({ required: false });
		expect(await optional.client("approver").viewer()).toMatchObject({ passkeyRequired: false });
		const approved = await optional.client("approver").decide(approval(optional.proposal));
		expect(approved.outcome).toBe("approved");
	});
});

describe("createVaultApprovalApi over HTTP", () => {
	const request = (path: string, init: RequestInit & { caller?: Caller } = {}) => {
		const headers = new Headers(init.headers);
		if (init.caller !== undefined) headers.set("x-test-caller", init.caller);
		return new Request(`${ORIGIN}${path}`, { ...init, headers });
	};

	it("answers unknown routes 404, other methods 405, and every response no-store", async () => {
		const { handler, proposal } = await setUp(true);
		const missing = await handler(request(`${APPROVAL_API_BASE}/nothing`, { caller: "approver" }));
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: { code: "not_found", message: "No such route" } });
		const outside = await handler(request("/v1/sessions", { caller: "approver" }));
		expect(outside.status).toBe(404);
		const wrongMethod = await handler(request(`${APPROVAL_API_BASE}/requests/${proposal.id}`, { method: "POST" }));
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("GET");
		const getDecision = await handler(request(`${APPROVAL_API_BASE}/requests/${proposal.id}/decision`));
		expect(getDecision.status).toBe(405);
		const ok = await handler(request(`${APPROVAL_API_BASE}/requests`, { caller: "approver" }));
		expect(ok.status).toBe(200);
		for (const response of [missing, wrongMethod, ok]) expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("serves the old /v1/vault routes and the proposals segment as deprecated aliases, saying so", async () => {
		const { handler, proposal } = await setUp(true);
		const current = await handler(request(`${APPROVAL_API_BASE}/requests/${proposal.id}`, { caller: "approver" }));
		expect(current.status).toBe(200);
		expect(current.headers.get("deprecation")).toBeNull();
		const body = await current.json();
		for (const [path, successor] of [
			[`/v1/vault/proposals/${proposal.id}`, `${APPROVAL_API_BASE}/requests/${proposal.id}`],
			[`/v1/vault/requests/${proposal.id}`, `${APPROVAL_API_BASE}/requests/${proposal.id}`],
			[`${APPROVAL_API_BASE}/proposals/${proposal.id}`, `${APPROVAL_API_BASE}/requests/${proposal.id}`],
			["/v1/vault/grants?status=active", `${APPROVAL_API_BASE}/grants?status=active`],
			["/v1/vault/viewer", `${APPROVAL_API_BASE}/viewer`],
		] as const) {
			const response = await handler(request(path, { caller: "approver" }));
			expect(response.status, path).toBe(200);
			expect(response.headers.get("deprecation"), path).toBe(APPROVAL_API_DEPRECATION);
			expect(response.headers.get("link"), path).toBe(`<${successor}>; rel="successor-version"`);
			if (path.includes("/proposals/") || path.includes("/requests/")) expect(await response.json()).toEqual(body);
		}
		// An alias's errors say so too; a path under neither base is not the API's.
		const missing = await handler(request("/v1/vault/proposals/proposal_missing", { caller: "approver" }));
		expect(missing.status).toBe(404);
		expect(missing.headers.get("deprecation")).toBe(APPROVAL_API_DEPRECATION);
		expect((await handler(request("/v1/vaults/proposals", { caller: "approver" }))).status).toBe(404);
		expect(isApprovalApiPath(`${APPROVAL_API_BASE}/requests`)).toBe(true);
		expect(isApprovalApiPath("/v1/vault/proposals")).toBe(true);
		expect(isApprovalApiPath("/v1/vaults")).toBe(false);
		expect(isApprovalApiPath("/v1/connections/approvals")).toBe(false);
	});

	it("refuses a caller the authenticator refuses before touching the vault", async () => {
		const { handler, proposal } = await setUp(true);
		const response = await handler(request(`${APPROVAL_API_BASE}/requests/${proposal.id}`));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: { code: "forbidden", message: "Sign in first" } });
	});

	it("answers a refused binding code 403 refused, a missing proposal 404 and a malformed decision 400", async () => {
		const { handler, proposal } = await setUp(true);
		const decide = (id: string, body: unknown) =>
			handler(
				request(`${APPROVAL_API_BASE}/requests/${encodeURIComponent(id)}/decision`, {
					method: "POST",
					caller: "approver",
					headers: { "content-type": "application/json" },
					body: typeof body === "string" ? body : JSON.stringify(body),
				}),
			);
		const wrong = await decide(proposal.id, {
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: "AAA-AAA",
		});
		expect(wrong.status).toBe(403);
		expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("refused");
		expect((await decide("proposal_missing", { outcome: "deny" })).status).toBe(404);
		for (const body of [
			"not json",
			[],
			{ outcome: "maybe" },
			{ outcome: "approve", narrowing: { methods: ["BREW"] } },
			{ outcome: "approve", narrowing: "all of it" },
			{ outcome: "approve", pickedCode: 7 },
			{ outcome: "deny", proposalId: "proposal_other" },
		]) {
			const response = await decide(proposal.id, body);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		const widened = await decide(proposal.id, {
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
			narrowing: { methods: ["DELETE"] },
		});
		expect(widened.status).toBe(400);
		const tooLarge = await decide(proposal.id, { outcome: "deny", note: "x".repeat(70 * 1024) });
		expect(tooLarge.status).toBe(400);
	});

	it("has no passkeys without them: the challenge is 501, an assertion is refused unread, the viewer says nothing", async () => {
		const { handler, proposal, client } = await setUp(true);
		const post = (path: string, body: unknown) =>
			handler(
				request(`${APPROVAL_API_BASE}/requests/${proposal.id}/${path}`, {
					method: "POST",
					caller: "approver",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		expect((await post("passkey-challenge", { termsHash: proposal.termsHash })).status).toBe(501);
		const assertion = {
			id: "c",
			rawId: "c",
			type: "public-key",
			response: { clientDataJSON: "a", authenticatorData: "b", signature: "c" },
		};
		const withAssertion = await post("decision", {
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
			passkeyAssertion: assertion,
		});
		expect(withAssertion.status).toBe(501);
		expect(await client("approver").viewer()).not.toHaveProperty("passkeyRequired");
	});

	it("answers a passkey refusal 403 with its reason, and checks the challenge's and the assertion's shape", async () => {
		const { handler, proposal } = await setUp(true, { passkeys: fakePasskeys() });
		const post = (path: string, body: unknown) =>
			handler(
				request(`${APPROVAL_API_BASE}/requests/${proposal.id}/${path}`, {
					method: "POST",
					caller: "approver",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		const missing = await post("decision", { outcome: "approve", termsHash: proposal.termsHash });
		expect(missing.status).toBe(403);
		expect(await missing.json()).toEqual({
			error: { code: "refused", message: "Approving needs your passkey", passkey: "missing" },
		});
		for (const body of [
			{},
			{ termsHash: "" },
			{ termsHash: 1 },
			{ termsHash: "h", action: "paste" },
			{ termsHash: "h", narrowing: "x" },
		]) {
			expect((await post("passkey-challenge", body)).status, JSON.stringify(body)).toBe(400);
		}
		const getChallenge = await handler(
			request(`${APPROVAL_API_BASE}/requests/${proposal.id}/passkey-challenge`, { caller: "approver" }),
		);
		expect(getChallenge.status).toBe(405);
		for (const passkeyAssertion of ["x", {}, { id: "c", rawId: "c", type: "public-key", response: {} }]) {
			const response = await post("decision", { outcome: "approve", termsHash: proposal.termsHash, passkeyAssertion });
			expect(response.status, JSON.stringify(passkeyAssertion)).toBe(400);
		}
	});

	it("checks list parameters", async () => {
		const { handler } = await setUp(true);
		for (const query of ["status=open", "limit=0", "limit=501", "limit=ten", "colour=blue"]) {
			const response = await handler(request(`${APPROVAL_API_BASE}/requests?${query}`, { caller: "approver" }));
			expect(response.status, query).toBe(400);
		}
		const paged = await handler(request(`${APPROVAL_API_BASE}/grants?status=active&limit=10`, { caller: "approver" }));
		expect(paged.status).toBe(200);
	});

	it("turns a 401 into forbidden with the authentication detail, and a network failure into unavailable", async () => {
		const unauthenticated = createVaultApprovalClient({
			baseUrl: ORIGIN,
			fetch: async () =>
				Response.json(
					{ error: { code: "unauthenticated", message: "This call needs valid credentials" } },
					{ status: 401 },
				),
		});
		const error = await rejection(unauthenticated.viewer());
		expect(error.code).toBe("forbidden");
		expect(error.details).toEqual({ authentication: "invalid" });
		const offline = createVaultApprovalClient({
			baseUrl: ORIGIN,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		expect((await rejection(offline.listGrants())).code).toBe("unavailable");
	});
});
