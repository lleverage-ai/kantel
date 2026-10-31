// The vault page's seam over the vault approval API, in-process: the API over an in-memory vault, the console's
// `apiVault` calling it through a fetch that hands each request straight to the handler.
import { type CallContext, KantelError } from "@kantel/contracts";
import { narrow } from "@kantel/vault";
import { createVaultApprovalApi } from "@kantel/vault/approval-api";
import { createMemoryVault } from "@kantel/vault/memory";
import { describe, expect, it } from "vitest";
import { apiVault } from "./vault-http.ts";

const ORG = "org-a";
const PROJECT = "proj-a";
const people = {
	tom: { actor: { kind: "human", userId: "user-tom" }, organisationId: ORG },
	riley: { actor: { kind: "human", userId: "user-riley" }, organisationId: ORG },
	host: { actor: { kind: "service", serviceId: "svc-host" }, organisationId: ORG },
} satisfies Record<string, CallContext>;
type Person = keyof typeof people;
const agent: CallContext = {
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: ORG,
	projectId: PROJECT,
};

async function setUp() {
	const vault = createMemoryVault();
	const item = await vault.putItem(people.tom, {
		owner: { kind: "project", organisationId: ORG, projectId: PROJECT },
		name: "GitHub token",
		hosts: ["api.github.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "vault-http-test-value",
	});
	const proposal = await vault.propose(agent, {
		itemId: item.id,
		route: { host: "api.github.com", methods: ["GET", "POST"], pathPrefix: "/repos" },
		lifetime: { ttlMs: 3_600_000 },
		reason: "Open the release pull request",
	});
	const handler = createVaultApprovalApi({
		// Riley may see the request but not decide it, as a viewer on its project would.
		vault: {
			...vault,
			approvalView: async (ctx, proposalId) => {
				if (ctx.actor.kind === "human" && ctx.actor.userId === "user-riley")
					throw new KantelError("forbidden", "Needs operator");
				return vault.approvalView(ctx, proposalId);
			},
			decide: async (ctx, input) => {
				if (ctx.actor.kind === "human" && ctx.actor.userId === "user-riley")
					throw new KantelError("forbidden", "Needs operator");
				return vault.decide(ctx, input);
			},
		},
		authenticate: async (request) => people[request.headers.get("x-test-person") as Person],
		viewerName: async (ctx) => (ctx.actor.kind === "human" ? ctx.actor.userId.replace("user-", "") : undefined),
		describeRequester: async () => ({
			organisation: "Acme",
			project: "Default",
			agent: "Assistant",
			session: "Ship it",
		}),
	});
	const as = (person: Person) =>
		apiVault({
			baseUrl: "https://harbour.test/v1/vault",
			host: "harbour.test",
			headers: () => ({ "x-test-person": person }),
			fetch: async (input, init) => handler(new Request(input, init)),
		});
	return { vault, proposal, as };
}

describe("the vault page over the approval API", () => {
	it("loads a request with the requester's names and a link to its session, and approves it narrowed", async () => {
		const { proposal, as } = await setUp();
		const tom = await as("tom");
		expect(tom.viewer).toEqual({ userId: "user-tom", name: "tom" });
		expect(tom.host).toBe("harbour.test");
		expect(tom.passkey).toBeUndefined();

		const request = await tom.request(proposal.id);
		expect(request.readOnly).toBeUndefined();
		expect(request.codeChoices).toContain(proposal.bindingCode);
		expect(request.item?.name).toBe("GitHub token");
		expect(request.requester).toMatchObject({
			organisation: "Acme",
			project: "Default",
			session: "Ship it",
			sessionHref: `/projects/${PROJECT}/sessions/session-1`,
		});

		const narrowing = { methods: ["GET" as const], pathPrefix: "/repos/acme" };
		const decision = await tom.decide({
			proposalId: proposal.id,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
			narrowing,
		});
		const settled = await tom.request(proposal.id);
		// The settled view shows the decision made on this page, its decider and the grant on the terms shown.
		expect(settled.decision?.id).toBe(decision.id);
		expect(settled.decider).toBe("tom");
		expect(settled.grant?.route).toEqual(narrow(proposal.terms, narrowing).route);

		const grants = await tom.grants();
		expect(grants.map((summary) => summary.grant.id)).toEqual([decision.grantId]);
		expect(grants[0]?.itemName).toBe("GitHub token");
		await tom.stop(decision.grantId!);
		expect(await tom.grants()).toEqual([]);
	});

	it("shows a request read-only to someone who may see it but not decide it, and passes on the refusal", async () => {
		const { proposal, as } = await setUp();
		const riley = await as("riley");
		const request = await riley.request(proposal.id);
		expect(request.readOnly).toBe("role");
		expect(request.codeChoices).toBeUndefined();
		await expect(
			riley.decide({
				proposalId: proposal.id,
				outcome: "approve",
				termsHash: proposal.termsHash,
				pickedCode: proposal.bindingCode,
			}),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	it("is no vault page for a caller who isn't a person, or on a gateway without the API", async () => {
		const { as } = await setUp();
		await expect(as("host")).rejects.toThrow(/signed-in person/);
		await expect(
			apiVault({
				fetch: async () => new Response("Not found", { status: 404 }),
				baseUrl: "https://harbour.test/v1/vault",
			}),
		).rejects.toMatchObject({ name: "KantelError" });
	});
});
