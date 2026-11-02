import { type CallContext, REACH_REPOSITORY_LIMIT, systemContext } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import { GITHUB_INSTALLATIONS_PAGE, readGitHubReach } from "../src/github-reach.ts";
import { createMemoryConnections, memoryCredentials } from "../src/memory.ts";
import { fakeAccess, human, ORG } from "../src/testing.ts";

const alice = human("alice");
const bob = human("bob");
const admin = human("admin");
const ORIGIN = "https://harbour.test";
const ACCESS_TOKEN = "ghu_reach-access-token-secret";
const CLIENT_SECRET = "reach-client-secret-value";

interface FakeInstallation {
	readonly id: number;
	readonly login: string;
	readonly type: "User" | "Organization";
	readonly selection: "all" | "selected";
	readonly repositories: number;
}

/** GitHub as `reach` sees it: a token endpoint, `/user`, and the person's installations with their repositories. */
function fakeGitHub(installations: FakeInstallation[]) {
	const requests: { url: URL; headers: Headers }[] = [];
	const state = { status: 200 };
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input);
		requests.push({ url, headers: new Headers(init?.headers) });
		if (url.href === "https://github.com/login/oauth/access_token") {
			return json({ access_token: ACCESS_TOKEN, token_type: "bearer", scope: "" });
		}
		if (url.href === "https://api.github.com/user") return json({ id: 7, login: "alice" });
		if (url.hostname !== "api.github.com" || !url.pathname.startsWith("/user/installations")) {
			return new Response("not found", { status: 404 });
		}
		if (state.status !== 200) return json({ message: `Bad credentials ${ACCESS_TOKEN}` }, state.status);
		if (url.pathname === "/user/installations") {
			return json({
				total_count: installations.length,
				installations: installations.map((item) => ({
					id: item.id,
					account: { login: item.login, type: item.type },
					repository_selection: item.selection,
				})),
			});
		}
		const id = Number(url.pathname.split("/")[3]);
		const found = installations.find((item) => item.id === id);
		if (found === undefined) return new Response("not found", { status: 404 });
		const perPage = Number(url.searchParams.get("per_page") ?? 30);
		const page = Number(url.searchParams.get("page") ?? 1);
		const all = Array.from({ length: found.repositories }, (_, index) => ({
			full_name: `${found.login}/repo-${index + 1}`,
			private: index % 2 === 0,
			owner: { login: found.login },
		}));
		return json({ total_count: all.length, repositories: all.slice((page - 1) * perPage, page * perPage) });
	};
	return { fetch, requests, state };
}

function setup(installations: FakeInstallation[]) {
	const github = fakeGitHub(installations);
	const credentials = memoryCredentials();
	const connections = createMemoryConnections({
		credentials,
		fetch: github.fetch,
		access: fakeAccess(["admin"]),
		deployment: {
			origin: ORIGIN,
			clientMetadataPublic: false,
			clientName: "Lleverage",
			platformClients: [{ templateId: "github", clientId: "Iv23-reach", clientSecret: CLIENT_SECRET }],
		},
		clock: { now: () => 1_000_000 },
	});
	return { github, credentials, connections };
}

/** Alice connects her own GitHub account through the deployment's confidential client. */
async function connectGitHub(env: ReturnType<typeof setup>): Promise<string> {
	const attempt = await env.connections.startConnect(alice, {
		owner: { kind: "user", organisationId: ORG, userId: "alice" },
		templateId: "github",
	});
	const { url } = await env.connections.authorize(alice, attempt.id);
	const done = await env.connections.completeConnect(alice, {
		state: new URL(url).searchParams.get("state")!,
		code: "code-1",
	});
	if (done.connectionId === undefined) throw new Error("GitHub didn't connect");
	return done.connectionId;
}

const reachRequests = (env: ReturnType<typeof setup>) =>
	env.github.requests.filter((request) => request.url.pathname.startsWith("/user/installations"));

describe("what a GitHub connection reaches (#461)", () => {
	it("lists the installations the person can reach and their repositories, as the person", async () => {
		const env = setup([
			{ id: 11, login: "acme", type: "Organization", selection: "selected", repositories: 3 },
			{ id: 12, login: "alice", type: "User", selection: "all", repositories: 2 },
		]);
		const connectionId = await connectGitHub(env);
		const reach = await env.connections.reach(alice, connectionId);
		expect(reach).toEqual({
			connectionId,
			installations: [
				{
					id: 11,
					account: { login: "acme", type: "Organization" },
					repositorySelection: "selected",
					manageUrl: "https://github.com/organizations/acme/settings/installations/11",
				},
				{
					id: 12,
					account: { login: "alice", type: "User" },
					repositorySelection: "all",
					manageUrl: "https://github.com/settings/installations/12",
				},
			],
			repositories: [
				{ fullName: "acme/repo-1", owner: "acme", private: true },
				{ fullName: "acme/repo-2", owner: "acme", private: false },
				{ fullName: "acme/repo-3", owner: "acme", private: true },
				{ fullName: "alice/repo-1", owner: "alice", private: true },
				{ fullName: "alice/repo-2", owner: "alice", private: false },
			],
			total: 5,
			truncated: false,
			manageUrl: GITHUB_INSTALLATIONS_PAGE,
			checkedAt: 1_000_000,
		});
		const sent = reachRequests(env);
		expect(sent.map((request) => `${request.url.pathname}${request.url.search}`)).toEqual([
			"/user/installations?per_page=100",
			"/user/installations/11/repositories?per_page=100&page=1",
			"/user/installations/12/repositories?per_page=100&page=1",
		]);
		for (const request of sent) {
			expect(request.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
			expect(request.headers.get("accept")).toBe("application/vnd.github+json");
			expect(request.headers.get("user-agent")).toBe("Kantel");
		}
		// Each request opened the token for its own path, and the vault recorded it.
		const opens = env.credentials.opened.filter((open) => open.purpose.includes(": reach "));
		expect(opens.map((open) => open.request)).toEqual([
			{ method: "GET", path: "/user/installations" },
			{ method: "GET", path: "/user/installations/11/repositories" },
			{ method: "GET", path: "/user/installations/12/repositories" },
		]);
		expect(opens.every((open) => open.host === "api.github.com")).toBe(true);
	});

	it("points at the one installation's page, and stops at the limit with truncated set", async () => {
		const env = setup([{ id: 21, login: "acme", type: "Organization", selection: "all", repositories: 340 }]);
		const connectionId = await connectGitHub(env);
		const reach = await env.connections.reach(alice, connectionId);
		expect(reach.repositories).toHaveLength(REACH_REPOSITORY_LIMIT);
		expect(reach).toMatchObject({
			total: 340,
			truncated: true,
			manageUrl: "https://github.com/organizations/acme/settings/installations/21",
		});
		expect(reachRequests(env).map((request) => request.url.searchParams.get("page"))).toEqual([null, "1", "2", "3"]);
	});

	it("answers nothing reached when the app isn't installed anywhere the person can see", async () => {
		const env = setup([]);
		const connectionId = await connectGitHub(env);
		expect(await env.connections.reach(alice, connectionId)).toMatchObject({
			installations: [],
			repositories: [],
			total: 0,
			truncated: false,
			manageUrl: GITHUB_INSTALLATIONS_PAGE,
		});
	});

	it("is only for someone who manages the connection, never another person or an agent", async () => {
		const env = setup([{ id: 11, login: "acme", type: "Organization", selection: "all", repositories: 1 }]);
		const connectionId = await connectGitHub(env);
		const agent: CallContext = {
			actor: { kind: "agent", agentId: "agt_1", sessionId: "ses_1" } as CallContext["actor"],
			organisationId: ORG,
		};
		await expect(env.connections.reach(bob, connectionId)).rejects.toMatchObject({
			code: expect.stringMatching(/^(forbidden|not_found)$/),
		});
		await expect(env.connections.reach(agent, connectionId)).rejects.toMatchObject({
			code: expect.stringMatching(/^(forbidden|not_found)$/),
		});
		// An organisation admin sees a person's connection, but it isn't theirs to read through.
		await expect(env.connections.reach(admin, connectionId)).rejects.toMatchObject({ code: "forbidden" });
		expect(reachRequests(env)).toHaveLength(0);
	});

	it("says not_supported for a connection Kantel can't ask", async () => {
		const env = setup([]);
		const connection = await env.connections.connectKey(alice, {
			owner: { kind: "user", organisationId: ORG, userId: "alice" },
			templateId: "openai",
			value: "sk-reach-test-key-value-0000",
		});
		await expect(env.connections.reach(alice, connection.id)).rejects.toMatchObject({ code: "not_supported" });
	});

	it("never answers the token, even when GitHub echoes it in an error", async () => {
		const env = setup([{ id: 11, login: "acme", type: "Organization", selection: "all", repositories: 1 }]);
		const connectionId = await connectGitHub(env);
		const reach = await env.connections.reach(alice, connectionId);
		expect(JSON.stringify(reach)).not.toContain(ACCESS_TOKEN);
		expect(JSON.stringify(reach)).not.toContain(CLIENT_SECRET);

		env.github.state.status = 401;
		const refused = await env.connections.reach(alice, connectionId).catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "refused" });
		expect(String((refused as Error).message)).not.toContain(ACCESS_TOKEN);

		env.github.state.status = 502;
		const failed = await env.connections.reach(alice, connectionId).catch((error: unknown) => error);
		expect(failed).toMatchObject({ code: "unavailable", message: expect.stringContaining("502") });
		expect(String((failed as Error).message)).not.toContain(ACCESS_TOKEN);
	});
});

describe("readGitHubReach", () => {
	it("skips installations and repositories it can't read", async () => {
		const fetch = async (input: string) => {
			const url = new URL(input);
			if (url.pathname === "/user/installations") {
				return Response.json({ installations: [{ id: 1, account: { login: "acme", type: "Bot" } }, { id: "x" }] });
			}
			return Response.json({ total_count: 2, repositories: [{ full_name: "acme/a", owner: { login: "acme" } }, {}] });
		};
		const reach = await readGitHubReach({ fetch, token: async () => "token" });
		expect(reach.installations).toEqual([
			{
				id: 1,
				account: { login: "acme", type: "User" },
				repositorySelection: "all",
				manageUrl: "https://github.com/settings/installations/1",
			},
		]);
		expect(reach.repositories).toEqual([{ fullName: "acme/a", owner: "acme", private: false }]);
		expect(reach).toMatchObject({ total: 2, truncated: true });
	});
});

describe("GitHub's default headers (#465)", () => {
	const scope = {
		organisationId: ORG,
		sessionId: "ses_1",
		agentId: "agt_1",
		actingUserId: "alice",
		audience: { kind: "private", userId: "alice" },
	} as const;
	const system = systemContext("test");

	it("sends GitHub's User-Agent and Accept unless the agent set its own", async () => {
		const env = setup([]);
		const connectionId = await connectGitHub(env);
		await env.connections.send(system, scope, connectionId, {
			kind: "http",
			method: "GET",
			url: "https://api.github.com/user",
		});
		await env.connections.send(system, scope, connectionId, {
			kind: "http",
			method: "GET",
			url: "https://api.github.com/user",
			headers: { "User-Agent": "my-script" },
		});
		const sent = env.github.requests.filter((request) => request.url.href === "https://api.github.com/user").slice(-2);
		expect(sent.map((request) => request.headers.get("user-agent"))).toEqual(["Kantel", "my-script"]);
		expect(sent[0]?.headers.get("accept")).toBe("application/vnd.github+json");
	});
});
