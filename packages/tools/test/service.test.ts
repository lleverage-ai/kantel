// The registry (`createToolServers`): access on the owner, names unique in the organisation, tunnel tokens shown once
// and kept hashed, the tunnel holder's reports kept on the record and audited, and what a session may see.
import type { SessionRecord, ToolServerSnapshot } from "@kantel/contracts";
import { describe, expect, it } from "vitest";
import type { TunnelLinks } from "../src/links.ts";
import { createMemoryToolServerRepository } from "../src/repository.ts";
import { createToolServers, hashTunnelToken } from "../src/service.ts";
import { ORG, person, recordingAudit, roleAccess } from "./registry.ts";

const ada = person("ada");
const bea = person("bea");
const cal = person("cal");
const outsider = person("ada", "org-other");

function setUp() {
	const repository = createMemoryToolServerRepository();
	const audit = recordingAudit();
	const closes: { ref: unknown; code: number; reason: string; tokenId?: string }[] = [];
	const links: TunnelLinks = {
		async call() {
			throw new Error("not called");
		},
		async close(ref, code, reason, tokenId) {
			closes.push({ ref, code, reason, ...(tokenId === undefined ? {} : { tokenId }) });
		},
	};
	const changes: { organisationId: string; name: string }[] = [];
	let now = 1000;
	const service = createToolServers({
		repository,
		access: () =>
			roleAccess({
				ada: { "*": "admin" },
				bea: { "*": "viewer", "proj-1": "operator" },
				cal: { "proj-2": "admin" },
			}),
		audit,
		clock: { now: () => now },
		links: () => links,
		onChange: (organisationId, server) => changes.push({ organisationId, name: server.name }),
	});
	return { service, repository, audit, closes, changes, tick: (ms: number) => (now += ms) };
}

const snapshot = (names: string[], hash: string): ToolServerSnapshot => ({
	tools: names.map((name) => ({ name, description: name, inputSchema: { type: "object" }, replay: "unsafe" })),
	hash,
	takenAt: 5,
});

const record = (projectId?: string): SessionRecord => ({
	id: "s1",
	organisationId: ORG,
	...(projectId === undefined ? {} : { projectId }),
	agentId: "worker",
	status: "idle",
	labels: {},
	createdBy: { kind: "service", serviceId: "test" },
	createdAt: 1,
	updatedAt: 1,
});

describe("the tool servers registry", () => {
	it("registers a tunnel server with its first token, shown once and kept as a hash", async () => {
		const { service, repository, audit } = setUp();
		const created = await service.create(ada, { name: "sal", description: "Sal's tools", transport: "tunnel" });
		expect(created.server).toMatchObject({
			id: expect.stringMatching(/^ts_/),
			organisationId: ORG,
			name: "sal",
			description: "Sal's tools",
			transport: "tunnel",
			disabledTools: [],
			connection: { status: "offline" },
			createdBy: ada.actor,
		});
		const secret = created.token?.secret ?? "";
		expect(secret).toMatch(/^hbt_[A-Za-z0-9_-]{43}$/);
		expect(created.token?.token).toMatchObject({ id: expect.stringMatching(/^tst_/), prefix: secret.slice(0, 8) });

		const [stored] = await repository.tokens(created.server.id);
		expect(stored?.hash).toBe(await hashTunnelToken(secret));
		expect(JSON.stringify(stored)).not.toContain(secret);
		expect(JSON.stringify(await service.listTokens(ada, created.server.id))).not.toContain(secret);
		expect(JSON.stringify(await service.get(ada, created.server.id))).not.toContain(secret);
		expect(JSON.stringify(audit.events)).not.toContain(secret);
		expect(audit.events.map((event) => event.type)).toEqual(["tool_server.created", "tool_server.token.created"]);
		expect(audit.events[0]).toMatchObject({
			source: "tool_server",
			actor: ada.actor,
			organisationId: ORG,
			subject: { kind: "tool_server", id: created.server.id },
		});
	});

	it("refuses a taken name, a bad name, another transport and a caller who isn't admin on the owner", async () => {
		const { service } = setUp();
		await service.create(ada, { name: "sal", transport: "tunnel" });
		await expect(service.create(ada, { name: "sal", transport: "tunnel" })).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(service.create(ada, { projectId: "proj-2", name: "sal", transport: "tunnel" })).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(service.create(ada, { name: "Sal_Tools", transport: "tunnel" })).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(service.create(ada, { name: "web", transport: "http" })).rejects.toMatchObject({ code: "invalid" });
		await expect(service.create(bea, { name: "bea", transport: "tunnel" })).rejects.toMatchObject({
			code: "forbidden",
		});
		await expect(service.create(cal, { name: "cal", transport: "tunnel" })).rejects.toMatchObject({
			code: "forbidden",
		});
		const project = await service.create(cal, { projectId: "proj-2", name: "cal", transport: "tunnel" });
		expect(project.server.projectId).toBe("proj-2");
		const agent = { actor: { kind: "agent", agentId: "worker", sessionId: "s1" }, organisationId: ORG } as const;
		await expect(service.create(agent, { name: "agent", transport: "tunnel" })).rejects.toMatchObject({
			code: "forbidden",
		});
	});

	it("shows a server to those who may read its owner, and another organisation's to no one", async () => {
		const { service } = setUp();
		const org = await service.create(ada, { name: "org-wide", transport: "tunnel" });
		const one = await service.create(ada, { projectId: "proj-1", name: "one", transport: "tunnel" });
		const two = await service.create(ada, { projectId: "proj-2", name: "two", transport: "tunnel" });
		const names = async (ctx: typeof ada, filter?: { projectId: string }) =>
			(await service.list(ctx, filter)).items.map((server) => server.name);
		expect(await names(ada)).toEqual(["one", "org-wide", "two"]);
		expect(await names(ada, { projectId: "proj-1" })).toEqual(["one", "org-wide"]);
		expect(await names(bea)).toEqual(["one", "org-wide", "two"]);
		expect(await names(cal)).toEqual(["two"]);
		await expect(service.get(cal, org.server.id)).rejects.toMatchObject({ code: "forbidden" });
		expect((await service.get(cal, two.server.id)).name).toBe("two");
		await expect(service.get(outsider, one.server.id)).rejects.toMatchObject({ code: "not_found" });
		expect(await names(outsider)).toEqual([]);

		const first = await service.list(ada, undefined, { limit: 2 });
		expect(first.items.map((server) => server.name)).toEqual(["one", "org-wide"]);
		expect(first.nextCursor).toBeDefined();
		const rest = await service.list(ada, undefined, { limit: 2, cursor: first.nextCursor ?? "" });
		expect(rest).toEqual({ items: [expect.objectContaining({ name: "two" })] });
	});

	it("needs operator for tokens, and revoking one closes only its tunnel", async () => {
		const { service, closes, audit, tick } = setUp();
		const { server, token } = await service.create(ada, { projectId: "proj-1", name: "sal", transport: "tunnel" });
		tick(1);
		const second = await service.createToken(bea, server.id);
		expect(second.secret).not.toBe(token?.secret);
		await expect(service.createToken(cal, server.id)).rejects.toMatchObject({ code: "forbidden" });
		expect((await service.listTokens(bea, server.id)).map((each) => each.id)).toEqual([
			token?.token.id,
			second.token.id,
		]);
		await service.revokeToken(bea, server.id, second.token.id);
		expect(closes).toEqual([
			{
				ref: { organisationId: ORG, toolServerId: server.id },
				code: 4003,
				reason: "The tunnel token was revoked",
				tokenId: second.token.id,
			},
		]);
		await expect(service.revokeToken(bea, server.id, second.token.id)).rejects.toMatchObject({ code: "not_found" });
		expect(await service.authenticateTunnel(server.id, second.secret)).toBeUndefined();
		expect(audit.events.filter((event) => event.type === "tool_server.token.revoked")).toEqual([
			expect.objectContaining({ actor: bea.actor, data: { tokenId: second.token.id, prefix: second.token.prefix } }),
		]);
	});

	it("checks a tunnel token against its server, recording its use", async () => {
		const { service, tick } = setUp();
		const sal = await service.create(ada, { name: "sal", transport: "tunnel" });
		const docs = await service.create(ada, { name: "docs", transport: "tunnel" });
		const secret = sal.token?.secret ?? "";
		tick(500);
		expect(await service.authenticateTunnel(sal.server.id, secret)).toEqual({
			organisationId: ORG,
			toolServerId: sal.server.id,
			tokenId: sal.token?.token.id,
		});
		expect((await service.listTokens(ada, sal.server.id))[0]?.lastUsedAt).toBe(1500);
		expect(await service.authenticateTunnel(sal.server.id, "hbt_wrong")).toBeUndefined();
		expect(await service.authenticateTunnel(sal.server.id, "")).toBeUndefined();
		await expect(service.authenticateTunnel(docs.server.id, secret)).rejects.toMatchObject({ code: "forbidden" });
		await expect(service.authenticateTunnel("ts_unknown", secret)).rejects.toMatchObject({ code: "not_found" });
	});

	it("keeps the connection and snapshot on the record, audits the hashes and tells the runtime", async () => {
		const { service, audit, changes, tick } = setUp();
		const { server, token } = await service.create(ada, { name: "sal", transport: "tunnel" });
		const grant = await service.authenticateTunnel(server.id, token?.secret ?? "");
		if (grant === undefined) throw new Error("no grant");
		const ref = { organisationId: ORG, toolServerId: server.id };
		audit.events.length = 0;

		tick(100);
		await service.connected(grant, {
			serverInfo: { name: "sal", version: "2" },
			snapshot: snapshot(["echo"], "sha256:one"),
			at: 1100,
		});
		expect((await service.get(ada, server.id)).connection).toEqual({
			status: "connected",
			connectedAt: 1100,
			lastSeenAt: 1100,
			serverInfo: { name: "sal", version: "2" },
		});
		await service.snapshotChanged(ref, snapshot(["echo"], "sha256:one"));
		await service.snapshotChanged(ref, snapshot(["echo", "added"], "sha256:two"));
		await service.disconnected(ref, 1200);
		const offline = await service.get(ada, server.id);
		expect(offline.connection).toEqual({
			status: "offline",
			lastSeenAt: 1200,
			serverInfo: { name: "sal", version: "2" },
		});
		expect(offline.snapshot?.hash).toBe("sha256:two");
		// Reconnecting with the same tools changes nothing to audit but the connect.
		await service.connected(grant, {
			serverInfo: undefined,
			snapshot: snapshot(["echo", "added"], "sha256:two"),
			at: 1300,
		});

		expect(audit.events.map((event) => [event.type, event.data])).toEqual([
			["tool_server.connected", { tokenId: grant.tokenId, tools: 1, serverName: "sal" }],
			["tool_server.tools.changed", { newHash: "sha256:one", tools: 1 }],
			["tool_server.tools.changed", { oldHash: "sha256:one", newHash: "sha256:two", tools: 2 }],
			["tool_server.disconnected", undefined],
			["tool_server.connected", { tokenId: grant.tokenId, tools: 2 }],
		]);
		expect(audit.events.every((event) => event.actor.kind === "system")).toBe(true);
		expect(changes).toEqual([
			{ organisationId: ORG, name: "sal" },
			{ organisationId: ORG, name: "sal" },
			{ organisationId: ORG, name: "sal" },
			{ organisationId: ORG, name: "sal" },
		]);
	});

	it("lists a snapshot's tools with what is enabled and what a session couldn't be offered", async () => {
		const { service } = setUp();
		const { server, token } = await service.create(ada, { name: "sal", transport: "tunnel" });
		const grant = await service.authenticateTunnel(server.id, token?.secret ?? "");
		if (grant === undefined) throw new Error("no grant");
		const long = "t".repeat(46);
		await service.connected(grant, {
			serverInfo: undefined,
			snapshot: snapshot(["echo", "other", long], "sha256:one"),
			at: 1,
		});
		const updated = await service.update(ada, server.id, { disabledTools: ["other"] });
		expect(updated.disabledTools).toEqual(["other"]);
		await expect(service.update(bea, server.id, { description: "no" })).rejects.toMatchObject({ code: "forbidden" });
		const view = await service.tools(bea, server.id);
		expect(view).toMatchObject({ toolServerId: server.id, hash: "sha256:one", takenAt: 5 });
		expect(
			view.tools.map(({ name, enabled, modelName, unavailableReason }) => ({
				name,
				enabled,
				modelName,
				unavailableReason,
			})),
		).toEqual([
			{ name: "echo", enabled: true, modelName: "sal__echo", unavailableReason: undefined },
			{ name: "other", enabled: false, modelName: "sal__other", unavailableReason: undefined },
			{
				name: long,
				enabled: true,
				modelName: `sal__${long}`,
				unavailableReason: expect.stringContaining("at most 50"),
			},
		]);
	});

	it("gives a session its organisation's servers and its own project's, and removing one closes its tunnel", async () => {
		const { service, closes, audit } = setUp();
		const org = await service.create(ada, { name: "org-wide", transport: "tunnel" });
		await service.create(ada, { projectId: "proj-1", name: "one", transport: "tunnel" });
		await service.create(ada, { projectId: "proj-2", name: "two", transport: "tunnel" });
		const all = ["org-wide", "one", "two", "missing"];
		const names = async (projectId?: string) =>
			(await service.forSession(record(projectId), all)).map((server) => server.name);
		expect(await names("proj-1")).toEqual(["org-wide", "one"]);
		expect(await names()).toEqual(["org-wide"]);

		await expect(service.remove(bea, org.server.id)).rejects.toMatchObject({ code: "forbidden" });
		await service.remove(ada, org.server.id);
		expect(closes).toEqual([
			{ ref: { organisationId: ORG, toolServerId: org.server.id }, code: 4004, reason: "The tool server was removed" },
		]);
		expect(await names("proj-1")).toEqual(["one"]);
		expect(await service.lookup({ organisationId: ORG, toolServerId: org.server.id })).toBeUndefined();
		await expect(service.get(ada, org.server.id)).rejects.toMatchObject({ code: "not_found" });
		expect(audit.events.at(-1)).toMatchObject({ type: "tool_server.deleted", subject: { id: org.server.id } });
	});
});
