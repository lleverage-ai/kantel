import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type ConnectionCallDetails,
	type ConnectionSessionScope,
	systemContext,
} from "@kantel/contracts";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import { createVault } from "@kantel/vault/engine";
import { createMemoryVaultStore } from "@kantel/vault/store";
import { describe, expect, it } from "vitest";
import { createMemoryConnections, memoryCredentials } from "../src/memory.ts";
import { createMemoryConnectionsRepository } from "../src/repository.ts";
import { createConnections } from "../src/service.ts";
import { fakeAccess, human, ORG, whole } from "../src/testing.ts";
import { callUseOfError, connectionTools } from "../src/tools.ts";

// #464: every connection call's result says which connection it used, as whose account, what it did, what decided it
// and how the service answered (`details.connection`), and a script's result lists its own; never a credential.

const SYSTEM = systemContext("test");
const admin = human("admin");
const approver: CallContext = { actor: { kind: "human", userId: "admin" }, organisationId: ORG };
const KEY = "sk-live-canary-abcdefghijklmnop";
const record = { id: "ses_1", organisationId: ORG, agentId: "agt_1" } as never;

function setup() {
	const sent: { url: string; method: string }[] = [];
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
	const connections = createConnections({
		repository: createMemoryConnectionsRepository(),
		credentials: memoryCredentials(),
		audit,
		access: fakeAccess(["admin"]),
		deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
		approvals: vault,
		fetch: async (url, init) => {
			sent.push({ url, method: init?.method ?? "GET" });
			return new Response(JSON.stringify({ ok: true, echo: KEY.slice(0, 4) }), {
				headers: { "content-type": "application/json" },
			});
		},
	});
	const connect = () =>
		connections.connectKey(admin, {
			owner: { kind: "organisation", organisationId: ORG },
			custom: { hosts: ["api.example.com"], injection: { kind: "query", param: "api_key" }, kind: "http" },
			value: KEY,
			usage: { unattended: true, visibility: "shared" },
		});
	const factory = connectionTools({ connections, approvalPollMs: 10 });
	const tool = (name: string) => factory(record).find((registration) => registration.name === name)!;
	return { connections, vault, sent, events, connect, factory, tool };
}

type Details = { connection?: ConnectionCallDetails; connectionApproval?: { proposalId: string; status: string } };

async function request(
	env: ReturnType<typeof setup>,
	callId: string,
	args: Record<string, unknown>,
	onDetails: (details: Details) => Promise<void> = async () => {},
) {
	const shown: Details[] = [];
	const result = (await env.tool("connection_request").execute(
		args as never,
		{
			callId,
			details: async (value: Details) => {
				shown.push(value);
				await onDetails(value);
			},
		} as never,
		{} as never,
	)) as { isError?: boolean; details?: Details; output: unknown };
	return { result, shown };
}

describe("a connection call's details (#464)", () => {
	it("names the connection, the request, the rule that allowed it and the answer, joined to its use by call ID", async () => {
		const env = setup();
		const connection = await env.connect();
		const { result } = await request(env, "call_1", {
			connectionId: connection.id,
			method: "GET",
			url: "https://api.example.com/v1/issues?state=open",
		});
		expect(result.isError).toBeFalsy();
		const details = result.details!.connection!;
		expect(details).toMatchObject({
			callId: "call_1",
			connection: { id: connection.id, name: connection.name, owner: { kind: "organisation" } },
			request: { kind: "http", method: "GET", host: "api.example.com", path: "/v1/issues", query: "state=open" },
			decision: { action: "allow", decidedBy: expect.stringMatching(/^(rule|unmatched)$/) },
			outcome: "allowed",
			response: { status: 200, contentType: "application/json", bytes: expect.any(Number), ms: expect.any(Number) },
		});
		// The request went out with the key in its query; the details never name it.
		expect(env.sent[0]!.url).toContain("api_key=");
		expect(details.request.query).toBe("state=open");
		const [use] = whole(await env.connections.listUses(admin, { connectionId: connection.id }));
		expect(use!.toolCallId).toBe(details.callId);
		if (details.decision?.ruleId !== undefined) expect(use!.ruleId).toBe(details.decision.ruleId);
	});

	it("says what refused a request, nothing sent", async () => {
		const env = setup();
		const connection = await env.connect();
		// The default rules block deletes.
		const { result } = await request(env, "call_del", {
			connectionId: connection.id,
			method: "DELETE",
			url: "https://api.example.com/v1/issues/1",
		});
		expect(result.isError).toBe(true);
		expect(env.sent).toHaveLength(0);
		expect(result.details!.connection).toMatchObject({
			callId: "call_del",
			outcome: "denied",
			decision: { action: "deny", decidedBy: "rule", ruleId: expect.any(String) },
			reason: expect.any(String),
		});
		expect(result.details!.connection!.response).toBeUndefined();
	});

	it("carries the approval while it waits, and the person's approval once it is sent", async () => {
		const env = setup();
		const connection = await env.connect();
		const { result, shown } = await request(
			env,
			"call_post",
			{ connectionId: connection.id, method: "POST", url: "https://api.example.com/v1/issues", body: "{}" },
			async (value) => {
				const card = value.connectionApproval!;
				if (card.status !== "pending") return;
				const status = await env.connections.approvalStatus(
					SYSTEM,
					{ organisationId: ORG, sessionId: "ses_1", agentId: "agt_1", audience: { kind: "shared" } },
					card.proposalId,
				);
				await env.vault.decide(approver, {
					proposalId: status.id,
					outcome: "approve",
					termsHash: status.termsHash,
					pickedCode: status.bindingCode,
				});
			},
		);
		const waiting = shown[0]!.connection!;
		expect(waiting).toMatchObject({
			callId: "call_post",
			outcome: "held",
			decision: { action: "ask" },
			approval: { proposalId: shown[0]!.connectionApproval!.proposalId, status: "pending" },
		});
		expect(result.isError).toBeFalsy();
		expect(result.details!.connection).toMatchObject({
			outcome: "allowed",
			decision: { action: "ask", decidedBy: "approval", approvalId: shown[0]!.connectionApproval!.proposalId },
			response: { status: 200 },
		});
		expect(result.details!.connection!.approval).toBeUndefined();
	});

	it("lists a script's connection calls under the script, by their inner call IDs, once", async () => {
		const env = setup();
		const connection = await env.connect();
		for (const key of ["c1", "c2"]) {
			await request(env, `script_1/${key}`, {
				connectionId: connection.id,
				method: key === "c1" ? "GET" : "DELETE",
				url: "https://api.example.com/v1/issues/1",
			});
		}
		await request(env, "call_direct", { connectionId: connection.id, method: "GET", url: "https://api.example.com/x" });
		const calls = env.factory.takeScriptCalls("script_1");
		expect(calls.map((call) => [call.callId, call.outcome])).toEqual([
			["script_1/c1", "allowed"],
			["script_1/c2", "denied"],
		]);
		expect(env.factory.takeScriptCalls("script_1")).toEqual([]);
		expect(env.factory.takeScriptCalls("call_direct")).toEqual([]);
	});

	it("puts the call's details on the service's refusal", async () => {
		const env = setup();
		const connection = await env.connect();
		const scope: ConnectionSessionScope = {
			organisationId: ORG,
			sessionId: "ses_1",
			agentId: "agt_1",
			audience: { kind: "shared" },
		};
		const error = await env.connections
			.send(SYSTEM, scope, connection.id, { method: "DELETE", url: "https://api.example.com/v1/x", kind: "http" })
			.catch((caught: unknown) => caught);
		expect(callUseOfError(error)).toMatchObject({ outcome: "denied", connection: { id: connection.id } });
	});

	it("never carries the credential: not in details, uses or audit events (canary)", async () => {
		const env = setup();
		const connection = await env.connect();
		const results = [
			await request(env, "call_a", {
				connectionId: connection.id,
				method: "GET",
				url: "https://api.example.com/v1/me",
			}),
			await request(env, "call_b", {
				connectionId: connection.id,
				method: "DELETE",
				url: "https://api.example.com/v1/me",
			}),
		];
		const uses = await env.connections.listUses(admin, { connectionId: connection.id });
		const everything = JSON.stringify([results.map(({ result, shown }) => [result.details, shown]), uses, env.events]);
		expect(everything).not.toContain(KEY);
		expect(everything).not.toContain("api_key=");
	});
});

describe("whose account a GitHub call acted as, and what it did (#464, #465)", () => {
	const ACCESS_TOKEN = "ghu_details-access-token-canary";
	function github() {
		const fetch = async (input: string): Promise<Response> => {
			const url = new URL(input);
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
			if (url.href === "https://github.com/login/oauth/access_token")
				return json({ access_token: ACCESS_TOKEN, token_type: "bearer", scope: "" });
			if (url.href === "https://api.github.com/user") return json({ id: 7, login: "alice" });
			return json([{ number: 1 }]);
		};
		return createMemoryConnections({
			credentials: memoryCredentials(),
			fetch,
			access: fakeAccess(["admin"]),
			deployment: {
				origin: "https://harbour.test",
				clientMetadataPublic: false,
				platformClients: [{ templateId: "github", clientId: "Iv23-details", clientSecret: "details-secret" }],
			},
		});
	}

	it("records the account and the operation on the use, its audit event and the call's details", async () => {
		const connections = github();
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
		const scope: ConnectionSessionScope = {
			organisationId: ORG,
			sessionId: "ses_gh",
			agentId: "agt_1",
			audience: { kind: "shared" },
		};
		const response = await connections.send(SYSTEM, scope, connectionId, {
			method: "GET",
			url: "https://api.github.com/repos/tvdavies/harbour/pulls?state=open",
			kind: "http",
			toolCallId: "call_gh",
		});
		expect(response.call).toMatchObject({
			connection: { id: connectionId, templateId: "github", account: "alice" },
			request: {
				operation: { group: "repo", access: "read", resource: "tvdavies/harbour", label: expect.any(String) },
			},
		});
		const [use] = whole(await connections.listUses(admin, { connectionId }));
		expect(use).toMatchObject({ account: "alice", operation: { access: "read", resource: "tvdavies/harbour" } });
		expect(JSON.stringify([response.call, use])).not.toContain(ACCESS_TOKEN);
	});
});
