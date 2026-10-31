// The vault approval API as the Cloudflare deployment serves it, in Node: the stack's gateway signs people in with
// Access tokens and checks project roles with the runtime's access, and each vault call crosses to the VaultDO's
// portable core (over `node:sqlite`) the way RPC carries it: structured-cloned, with errors as results.
import { DatabaseSync } from "node:sqlite";
import type {
	ApprovalView,
	AuditEvent,
	CallContext,
	Decision,
	Grant,
	Page,
	Proposal,
	SessionRecord,
} from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import { narrow } from "@kantel/vault";
import { APPROVAL_API_BASE, APPROVAL_API_DEPRECATION, VAULT_APPROVAL_API_BASE } from "@kantel/vault/approval-api";
import { describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { seedDevVault } from "../src/dev-vault-seed.ts";
import { createGateway } from "../src/gateway.ts";
import { createStack, DEFAULT_AGENT_ID } from "../src/stack.ts";
import { answerApprovalCall, approvalVaultOver, createVaultCore } from "../src/vault.ts";
import { objectStorage } from "./object-storage.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const VIEWER = "riley@harbour.test";
const OUTSIDER = "sam@harbour.test";
const BASE = "https://harbour.test";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

/**
 * The API's routes (`/v1/connection-approvals/requests/...`) and the deprecated ones a client written before #324 calls
 * (`/v1/vault/proposals/...`). Each test names its path the old way; on the current routes `/proposals` becomes
 * `/requests`.
 */
const ROUTES = [
	{ name: "its routes", base: APPROVAL_API_BASE, deprecated: false },
	{ name: "the deprecated /v1/vault routes", base: VAULT_APPROVAL_API_BASE, deprecated: true },
] as const;
type Routes = (typeof ROUTES)[number];

async function setupWith(routes: Routes) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
	});
	// The VaultDO's core; its audit events go to the stack's store, as the deployed object's go to D1.
	let core: ReturnType<typeof createVaultCore> | undefined;
	const calls: string[] = [];
	const vault = approvalVaultOver(async (method, ctx, args) => {
		calls.push(method);
		// What RPC does to the call and its result: a structured clone each way.
		return structuredClone(
			await answerApprovalCall(() => core!.vault, method, structuredClone(ctx), structuredClone(args)),
		);
	});
	const stack = await createStack({ config, accessFetch: mock.fetch, vault });
	const storage = objectStorage(new DatabaseSync(":memory:"));
	core = createVaultCore({ ...storage, audit: stack.audit, vars: { KANTEL_VAULT_KEY: KEY } });
	const gateway = createGateway(stack);

	// A viewer on the default project, to open a forwarded link, and an operator on another project only.
	const viewer = await stack.identity.createUser(stack.admin, { name: "Riley", email: VIEWER });
	await stack.identity.grantRole(stack.admin, {
		principal: { kind: "user", userId: viewer.id },
		role: "viewer",
		projectId: stack.project.id,
	});
	const other = await stack.identity.createProject(stack.admin, { name: "Other" });
	const outsider = await stack.identity.createUser(stack.admin, { name: "Sam", email: OUTSIDER });
	await stack.identity.grantRole(stack.admin, {
		principal: { kind: "user", userId: outsider.id },
		role: "operator",
		projectId: other.id,
	});

	// Three sessions of the default agent ask the VaultDO for access, as `POST /__dev/vault-seed` does on wrangler dev.
	const session = (title: string) =>
		stack.runtime.runtime.create(stack.admin, { projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, title });
	const agentIn = (record: SessionRecord): CallContext => ({
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: stack.organisation.id,
		projectId: stack.project.id,
	});
	const release = await session("Ship the 0.4 release");
	const seeded = await seedDevVault(core.vault, {
		admin: stack.admin,
		agents: {
			release: agentIn(release),
			linear: agentIn(await session("Keep the triage queue moving")),
			billing: agentIn(await session("Check the month's payouts")),
		},
	});
	calls.length = 0;

	const as = async (email: string) => ({
		"cf-access-jwt-assertion": await mock.sign({ sub: `access-${email}`, email }),
	});
	const call = async <T>(email: string | undefined, path: string, body?: unknown) => {
		const headers: Record<string, string> = email === undefined ? {} : await as(email);
		if (body !== undefined) headers["content-type"] = "application/json";
		const routed = routes.deprecated ? path : path.replace(/^\/proposals(?=\/|\?|$)/, "/requests");
		const response = await gateway.fetch(
			new Request(`${BASE}${routes.base}${routed}`, {
				headers,
				...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
			}),
		);
		// An alias's every signed-in answer says it is deprecated; the current routes' never do.
		if (response.status !== 401) {
			expect(response.headers.get("deprecation"), path).toBe(routes.deprecated ? APPROVAL_API_DEPRECATION : null);
		}
		return { status: response.status, body: (await response.json()) as T };
	};
	return { stack, core, gateway, call, calls, seeded, release };
}

const auditOf = async (stack: Awaited<ReturnType<typeof setupWith>>["stack"], type: string): Promise<AuditEvent[]> =>
	(await stack.audit.query(stack.admin, { type }, { limit: 500 })).items as AuditEvent[];

describe.each(ROUTES)("the connection approval API on Cloudflare, by $name", (routes) => {
	const setup = () => setupWith(routes);
	it("asks for sign-in first: 401 with a challenge, and nothing reaches the vault", async () => {
		const { call, calls } = await setup();
		for (const path of ["/proposals", "/grants", "/viewer"]) {
			expect((await call(undefined, path)).status, path).toBe(401);
		}
		expect(calls).toEqual([]);
	});

	it("lists and reads requests for the admin, with the requester in names", async () => {
		const { call, seeded, release } = await setup();
		const pending = await call<Page<Proposal>>(ADMIN, "/proposals?status=pending");
		expect(pending.status).toBe(200);
		expect(pending.body.items.map((proposal) => proposal.id).sort()).toEqual(
			[seeded.proposals.route, seeded.proposals.write, seeded.proposals.read].sort(),
		);
		const route = await call<Proposal>(ADMIN, `/proposals/${seeded.proposals.route}`);
		expect(route.body).toMatchObject({ kind: "route", status: "pending", requester: { sessionId: release.id } });
		// The vault's link is the console's vault page for it.
		expect(route.body.link).toBe(`/connections/requests/${seeded.proposals.route}`);
		expect((await call(ADMIN, `/proposals/${seeded.proposals.route}/requester`)).body).toEqual({
			organisation: "Kantel",
			project: "Default",
			agent: "Assistant",
			session: "Ship the 0.4 release",
		});
		expect((await call(ADMIN, "/viewer")).body).toMatchObject({ actor: { kind: "human" }, name: ADMIN });
		const active = await call<Page<Grant>>(ADMIN, "/grants?status=active");
		expect(active.body.items).toHaveLength(2);
	});

	it("approves a narrowed route grant into a grant with the terms the approver saw", async () => {
		const { call, seeded } = await setup();
		const id = seeded.proposals.route;
		const view = await call<ApprovalView>(ADMIN, `/proposals/${id}/approval`);
		expect(view.status).toBe(200);
		expect(view.body.codeRequired).toBe(true);
		const narrowing = { methods: ["GET" as const], pathPrefix: "/repos/acme/harbour", ttlMs: 30 * 60_000, maxUses: 3 };
		const shown = narrow(view.body.proposal.terms, narrowing);
		const decided = await call<Decision>(ADMIN, `/proposals/${id}/decision`, {
			outcome: "approve",
			termsHash: view.body.proposal.termsHash,
			pickedCode: view.body.proposal.bindingCode,
			narrowing,
		});
		expect(decided.status).toBe(200);
		expect(decided.body.effectiveTerms?.route).toEqual(shown.route);
		const grant = await call<Grant>(ADMIN, `/grants/${decided.body.grantId}`);
		expect(grant.body).toMatchObject({ status: "active", route: shown.route, maxUses: 3, proposalId: id });
		expect(grant.body.expiresAt! - decided.body.decidedAt).toBe(30 * 60_000);
		expect((await call<Proposal>(ADMIN, `/proposals/${id}`)).body.status).toBe("approved");
	});

	it("refuses a wrong binding code and audits it as vault.binding_code.mismatch", async () => {
		const { call, seeded, stack } = await setup();
		const id = seeded.proposals.write;
		const view = await call<ApprovalView>(ADMIN, `/proposals/${id}/approval`);
		const wrong = view.body.codeChoices.find((code) => code !== view.body.proposal.bindingCode)!;
		const refused = await call<{ error: { code: string } }>(ADMIN, `/proposals/${id}/decision`, {
			outcome: "approve",
			termsHash: view.body.proposal.termsHash,
			pickedCode: wrong,
		});
		expect(refused.status).toBe(403);
		expect(refused.body.error.code).toBe("refused");
		const mismatches = await auditOf(stack, "connections.binding_code.mismatch");
		expect(mismatches).toHaveLength(1);
		// The old type still finds the row, for one release (#324).
		expect(await auditOf(stack, "vault.binding_code.mismatch")).toEqual(mismatches);
		expect(mismatches[0]).toMatchObject({ subject: { id }, data: { pickedCode: wrong } });
		expect((await call<Proposal>(ADMIN, `/proposals/${id}`)).body.status).toBe("pending");
	});

	it("shows a forwarded request to a project viewer read-only and refuses their approval", async () => {
		const { call, calls, seeded, stack } = await setup();
		const id = seeded.proposals.route;
		const proposal = await call<Proposal>(VIEWER, `/proposals/${id}`);
		expect(proposal.status).toBe(200);
		expect((await call(VIEWER, `/proposals/${id}/approval`)).status).toBe(403);
		calls.length = 0;
		const refused = await call<{ error: { code: string } }>(VIEWER, `/proposals/${id}/decision`, {
			outcome: "approve",
			termsHash: proposal.body.termsHash,
			pickedCode: proposal.body.bindingCode,
		});
		expect(refused.status).toBe(403);
		expect(refused.body.error.code).toBe("forbidden");
		// The project check comes before the decision reaches the VaultDO: it only read the proposal.
		expect(calls).toEqual(["getProposal"]);
		const denied = (await auditOf(stack, "access.denied")).filter((event) => event.data?.operation === "vault.decide");
		expect(denied).toHaveLength(1);
		expect((await call<Proposal>(ADMIN, `/proposals/${id}`)).body.status).toBe("pending");
	});

	it("keeps another project's operator out of the default project's requests and grants", async () => {
		const { call, seeded } = await setup();
		expect((await call<Page<Proposal>>(OUTSIDER, "/proposals")).body.items).toEqual([]);
		expect((await call<Page<Grant>>(OUTSIDER, "/grants")).body.items).toEqual([]);
		expect((await call(OUTSIDER, `/proposals/${seeded.proposals.route}`)).status).toBe(403);
	});

	it("denies a request and stops a grant", async () => {
		const { call, seeded } = await setup();
		const denied = await call<Decision>(ADMIN, `/proposals/${seeded.proposals.read}/decision`, { outcome: "deny" });
		expect(denied.body.outcome).toBe("denied");
		const active = await call<Page<Grant>>(ADMIN, "/grants?status=active");
		const grant = active.body.items[0]!;
		expect((await call(VIEWER, `/grants/${grant.id}/revoke`, {})).status).toBe(403);
		const stopped = await call<Grant>(ADMIN, `/grants/${grant.id}/revoke`, { reason: "Stopped on the vault page" });
		expect(stopped.body.status).toBe("revoked");
		expect((await call<Page<Grant>>(ADMIN, "/grants?status=active")).body.items).toHaveLength(1);
	});
});

describe("approval calls over RPC", () => {
	it("takes only the approval API's calls, and carries a refusal's code across", async () => {
		const storage = objectStorage(new DatabaseSync(":memory:"));
		const core = createVaultCore({ ...storage, vars: { KANTEL_VAULT_KEY: KEY } });
		const human: CallContext = { actor: { kind: "human", userId: "u-1" }, organisationId: "org-a" };
		const putItem = await answerApprovalCall(() => core.vault, "putItem", human, [{}]);
		expect(putItem).toMatchObject({ ok: false, code: "not_supported" });
		const missing = await answerApprovalCall(() => core.vault, "getProposal", human, ["proposal_missing"]);
		expect(missing).toMatchObject({ ok: false, code: "not_found" });
		// A VaultDO with no key answers every call unavailable, as its fetch does.
		const noKey = await answerApprovalCall(
			() => createVaultCore({ ...storage, vars: {} }).vault,
			"listGrants",
			human,
			[],
		);
		expect(noKey).toMatchObject({ ok: false, code: "unavailable" });

		const vault = approvalVaultOver(async (method, ctx, args) => {
			expect(ctx).not.toHaveProperty("signal");
			expect(args).not.toContain(undefined);
			return answerApprovalCall(() => core.vault, method, ctx, args);
		});
		await expect(vault.getProposal(human, "proposal_missing")).rejects.toMatchObject({
			name: "KantelError",
			code: "not_found",
		});
		expect(await vault.listGrants({ ...human, signal: new AbortController().signal }, undefined, undefined)).toEqual({
			items: [],
		});
	});
});
