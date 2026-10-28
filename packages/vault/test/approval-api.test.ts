import {
	type CallContext,
	HarbourError,
	isHarbourError,
	type Proposal,
	type ProposalTerms,
	type VaultItem,
} from "@harbour/contracts";
import { actors, contextFor, createDeps } from "@harbour/testing/harness";
import { narrow } from "@harbour/vault";
import {
	APPROVAL_API_BASE,
	approvalClientAsVault,
	createVaultApprovalApi,
	createVaultApprovalClient,
	type VaultApprovalClient,
} from "@harbour/vault/approval-api";
import type { HarbourVault } from "@harbour/vault/engine";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it } from "vitest";

const ORG = "org-a";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";
const HOST = "api.github.com";
const ORIGIN = "https://harbour.test";
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
const shapes = [
	{ name: "the API checks project access", apiChecks: true },
	{ name: "the vault checks project access", apiChecks: false },
] as const;

async function setUp(apiChecks: boolean) {
	const deps = createDeps();
	const { tenancy } = deps;
	tenancy.bind(callers.admin.actor, ORG, "admin");
	tenancy.bind(callers.approver.actor, ORG, "operator", PROJECT);
	tenancy.bind(callers.forwarded.actor, ORG, "viewer", PROJECT);
	tenancy.bind(callers.outsider.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });

	const vault: HarbourVault = createMemoryVault({
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
			if (who === null || !(who in callers)) throw new HarbourError("forbidden", "Sign in first");
			return callers[who];
		},
		viewerName: async (ctx) => (ctx.actor.kind === "human" ? `Person ${ctx.actor.userId}` : undefined),
		describeRequester: async (_ctx, found) => ({
			organisation: "Acme",
			project: "Default",
			agent: found.requester.agentId ?? "",
		}),
	});
	const fetchVia: typeof fetch = async (input, init) => handler(new Request(input, init));
	const client = (who: Caller): VaultApprovalClient =>
		createVaultApprovalClient({
			baseUrl: `${ORIGIN}${APPROVAL_API_BASE}`,
			headers: () => ({ "x-test-caller": who }),
			fetch: fetchVia,
		});
	return { deps, vault, item, proposal, handler, client };
}

async function rejection(promise: Promise<unknown>): Promise<HarbourError> {
	try {
		await promise;
	} catch (error) {
		if (isHarbourError(error)) return error;
		throw error;
	}
	throw new Error("it resolved");
}

const wrongCodeOf = (choices: readonly string[], proposal: Proposal) =>
	choices.find((choice) => choice !== proposal.bindingCode)!;

describe.each(shapes)("createVaultApprovalApi: $name", ({ apiChecks }) => {
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

	it("refuses a wrong binding code, audits it as vault.binding_code.mismatch and leaves the request pending", async () => {
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
		const mismatches = deps.audit.ofType("vault.binding_code.mismatch");
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
		expect(deps.audit.ofType("vault.decision.approved")).toEqual([]);
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

	it("runs @harbour/ui-style contract code over HTTP through approvalClientAsVault", async () => {
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
		const wrongMethod = await handler(request(`${APPROVAL_API_BASE}/proposals/${proposal.id}`, { method: "POST" }));
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("GET");
		const getDecision = await handler(request(`${APPROVAL_API_BASE}/proposals/${proposal.id}/decision`));
		expect(getDecision.status).toBe(405);
		const ok = await handler(request(`${APPROVAL_API_BASE}/proposals`, { caller: "approver" }));
		expect(ok.status).toBe(200);
		for (const response of [missing, wrongMethod, ok]) expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("refuses a caller the authenticator refuses before touching the vault", async () => {
		const { handler, proposal } = await setUp(true);
		const response = await handler(request(`${APPROVAL_API_BASE}/proposals/${proposal.id}`));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: { code: "forbidden", message: "Sign in first" } });
	});

	it("answers a refused binding code 403 refused, a missing proposal 404 and a malformed decision 400", async () => {
		const { handler, proposal } = await setUp(true);
		const decide = (id: string, body: unknown) =>
			handler(
				request(`${APPROVAL_API_BASE}/proposals/${encodeURIComponent(id)}/decision`, {
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

	it("checks list parameters", async () => {
		const { handler } = await setUp(true);
		for (const query of ["status=open", "limit=0", "limit=501", "limit=ten", "colour=blue"]) {
			const response = await handler(request(`${APPROVAL_API_BASE}/proposals?${query}`, { caller: "approver" }));
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
