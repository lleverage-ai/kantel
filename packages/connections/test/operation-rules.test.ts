// Rules by what a request does, by repository, and for scheduled runs (#466), through the service: GitHub's defaults
// by operation, "Always allow…" scoped to an operation, a repository and a project, and the dry run's class.

import { type CallContext, type ConnectionSessionScope, KantelError, systemContext } from "@kantel/contracts";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { createMemoryVaultStore } from "@kantel/vault/store";
import { describe, expect, it } from "vitest";
import { memoryCredentials } from "../src/memory.ts";
import { createMemoryConnectionsRepository } from "../src/repository.ts";
import { createConnections } from "../src/service.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";

const SYSTEM = systemContext("test");
const admin = human("admin");
const approver: CallContext = { actor: { kind: "human", userId: "admin" }, organisationId: ORG };
const TOKEN = "ghu_operation-rules-canary";
const attended: ConnectionSessionScope = {
	organisationId: ORG,
	projectId: "prj_1",
	sessionId: "ses_1",
	agentId: "agt_1",
	actingUserId: "admin" as never,
	audience: { kind: "shared" },
};
const scheduled: ConnectionSessionScope = { ...attended, sessionId: "ses_2", unattended: true };

async function setup() {
	const sent: { method: string; url: string }[] = [];
	const vault = createVault({
		store: createMemoryVaultStore(),
		cipher: createAesGcmCipher({ key: randomCipherKey() }),
	});
	const repository = createMemoryConnectionsRepository();
	const connections = createConnections({
		repository,
		credentials: memoryCredentials(),
		access: fakeAccess(["admin"]),
		approvals: vault,
		deployment: {
			origin: "https://kantel.test",
			clientMetadataPublic: false,
			platformClients: [{ templateId: "github", clientId: "Iv23-ops", clientSecret: "ops-secret" }],
		},
		fetch: async (input, init) => {
			const url = new URL(input);
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
			if (url.href === "https://github.com/login/oauth/access_token")
				return json({ access_token: TOKEN, token_type: "bearer", scope: "" });
			if (url.href === "https://api.github.com/user") return json({ id: 7, login: "alice" });
			sent.push({ method: init?.method ?? "GET", url: url.href });
			return json({ ok: true });
		},
	});
	const attempt = await connections.startConnect(admin, {
		owner: { kind: "organisation", organisationId: ORG },
		templateId: "github",
	});
	const { url } = await connections.authorize(admin, attempt.id);
	const done = await connections.completeConnect(admin, {
		state: new URL(url).searchParams.get("state")!,
		code: "code-1",
	});
	const connectionId = done.connectionId!;
	// The organisation's: scheduled runs may use it by default (#487).
	return { vault, connections, connectionId, sent, repository };
}

const graphql = (query: string) => ({
	method: "POST" as const,
	url: "https://api.github.com/graphql",
	body: JSON.stringify({ query }),
	kind: "http" as const,
});
const issue = (repo: string) => ({
	method: "POST" as const,
	url: `https://api.github.com/repos/${repo}/issues`,
	body: '{"title":"hi"}',
	kind: "http" as const,
});

async function pendingOf(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	expect(error).toBeInstanceOf(KantelError);
	const details = (error as KantelError).details as { error: string; approvalId: string };
	expect(details.error).toBe("approval_pending");
	return details.approvalId;
}

describe("GitHub's rules by operation", () => {
	it("let a GraphQL query through as a read and hold a mutation as a write", async () => {
		const env = await setup();
		await env.connections.send(SYSTEM, attended, env.connectionId, graphql("query { viewer { login } }"));
		expect(env.sent).toHaveLength(1);
		await pendingOf(
			env.connections.send(
				SYSTEM,
				attended,
				env.connectionId,
				graphql('mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }'),
			),
		);
		expect(env.sent).toHaveLength(1);
		const rules = await env.connections.getRules(admin, env.connectionId);
		expect(rules.rules.filter((rule) => rule.what.kind === "operation").map((rule) => rule.action)).toEqual([
			"allow",
			"ask",
			"deny",
			"ask",
		]);
	});

	it("tell the dry run which class and which rule decided, for a person's session and a scheduled run", async () => {
		const env = await setup();
		await env.connections.createRule(admin, env.connectionId, {
			who: { kind: "unattended" },
			what: { kind: "operation", access: "write" },
			action: "deny",
		});
		const request = {
			method: "POST" as const,
			url: "https://api.github.com/graphql",
			body: '{"query":"mutation { a }"}',
		};
		const present = await env.connections.dryRun(admin, env.connectionId, request);
		expect(present).toMatchObject({ action: "ask", operation: { access: "write" } });
		expect(present.rule?.what).toMatchObject({ kind: "operation", access: "write" });
		const absent = await env.connections.dryRun(admin, env.connectionId, { ...request, unattended: true });
		expect(absent).toMatchObject({ action: "deny", rule: { who: { kind: "unattended" } } });
	});
});

describe("Always allow scoped by operation, repository and project", () => {
	it("saves a rule for writes in one repository for the project, and asks again in any other", async () => {
		const env = await setup();
		const approvalId = await pendingOf(
			env.connections.send(SYSTEM, attended, env.connectionId, issue("tvdavies/harbour")),
		);
		const rule = await env.connections.createRuleFromApproval(
			admin,
			env.connectionId,
			{
				who: { kind: "project", projectId: "prj_1" as never },
				what: { kind: "operation", group: "repo", access: "write", resource: "tvdavies/harbour" },
				action: "allow",
			},
			approvalId,
		);
		expect(rule).toMatchObject({ source: "approval", approvalId });
		const proposal = await env.vault.getProposal(approver, approvalId);
		await env.vault.decide(approver, {
			proposalId: approvalId,
			outcome: "approve",
			termsHash: proposal.termsHash,
			pickedCode: proposal.bindingCode,
		});
		// Another agent in the project, another write in the repository: no question.
		await env.connections.send(SYSTEM, { ...attended, agentId: "agt_2" }, env.connectionId, {
			...issue("tvdavies/harbour"),
			url: "https://api.github.com/repos/tvdavies/harbour/issues/1/comments",
		});
		expect(env.sent).toHaveLength(1);
		// Another repository still asks.
		await pendingOf(env.connections.send(SYSTEM, attended, env.connectionId, issue("tvdavies/brwsr")));
	});

	it("refuses a scope that doesn't cover the request it came from", async () => {
		const env = await setup();
		const approvalId = await pendingOf(
			env.connections.send(SYSTEM, attended, env.connectionId, issue("tvdavies/harbour")),
		);
		const save = (what: object, who: object = { kind: "agent", agentId: "agt_1" }) =>
			env.connections.createRuleFromApproval(
				admin,
				env.connectionId,
				{ who, what, action: "allow" } as never,
				approvalId,
			);
		await expect(save({ kind: "operation", access: "write", resource: "tvdavies/brwsr" })).rejects.toMatchObject({
			code: "refused",
		});
		await expect(save({ kind: "operation", access: "delete" })).rejects.toMatchObject({ code: "refused" });
		await expect(save({ kind: "operation", group: "workflow" })).rejects.toMatchObject({ code: "refused" });
		await expect(
			save({ kind: "operation", access: "write" }, { kind: "project", projectId: "prj_other" }),
		).rejects.toMatchObject({ code: "refused" });
		// A person was in the session, so a rule for scheduled runs wouldn't cover it.
		await expect(save({ kind: "operation", access: "write" }, { kind: "unattended" })).rejects.toMatchObject({
			code: "refused",
		});
		await expect(save({ kind: "operation", access: "write" }, { kind: "attended" })).resolves.toMatchObject({
			source: "approval",
		});
	});

	it("knows a scheduled run's approval for one, even when the run acted for a person", async () => {
		const env = await setup();
		const approvalId = await pendingOf(
			env.connections.send(SYSTEM, scheduled, env.connectionId, issue("tvdavies/harbour")),
		);
		const save = (who: object) =>
			env.connections.createRuleFromApproval(
				admin,
				env.connectionId,
				{ who, what: { kind: "operation", access: "write" }, action: "allow" } as never,
				approvalId,
			);
		await expect(save({ kind: "attended" })).rejects.toMatchObject({ code: "refused" });
		await expect(save({ kind: "unattended" })).resolves.toMatchObject({ source: "approval" });
	});

	it("won't guess whether a person was there when the held use is gone", async () => {
		const env = await setup();
		const approvalId = await pendingOf(
			env.connections.send(SYSTEM, scheduled, env.connectionId, issue("tvdavies/harbour")),
		);
		for (const use of (await env.connections.listUses(admin, { connectionId: env.connectionId })).items)
			await env.repository.remove("use", use.id);
		const save = (who: object) =>
			env.connections.createRuleFromApproval(
				admin,
				env.connectionId,
				{ who, what: { kind: "operation", access: "write" }, action: "allow" } as never,
				approvalId,
			);
		await expect(save({ kind: "attended" })).rejects.toMatchObject({ code: "refused" });
		await expect(save({ kind: "unattended" })).rejects.toMatchObject({ code: "refused" });
		await expect(save({ kind: "agent", agentId: "agt_1" })).resolves.toMatchObject({ source: "approval" });
	});
});
