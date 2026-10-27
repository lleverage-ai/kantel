// Restarts: a runtime that stops mid model call or mid tool call, and a later one on the same database that carries the
// work on; host registrations that outlive the process that made them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { AgentProfile, Authentication, HostToolHandler, ReplayPolicy } from "@harbour/contracts";
import { createSessionRuntime } from "@harbour/runtime/core";
import {
	callbackHostHandlers,
	createHostToolEndpoint,
	createSessionApi,
	staticTokenAuthenticator,
} from "@harbour/runtime/http";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";
import type { StoredHost } from "@harbour/runtime/store";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-restart";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const lookup = (replay: ReplayPolicy) => ({
	name: "lookup",
	description: "Looks up",
	inputSchema: { type: "object" },
	replay,
});
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [{ name: "role", text: "You help." }],
	tools: ["lookup"],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
	hostId: "sal",
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** A database file in its own directory, removed after the test. */
function databaseFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "harbour-restart-"));
	cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "harbour.db");
}

/**
 * One "process": its own connection to the file, its own runtime and model. A crash is a process that stops being
 * used: its model call or host call never finishes, and nothing of it is closed until the test ends.
 */
async function processOn(file: string, hostHandler?: (host: StoredHost) => HostToolHandler | undefined) {
	const db: SqliteDatabase = await openNodeSqliteDatabase(file);
	const { models, script } = createScriptedModel();
	const service = createSessionRuntime({
		store: await createSqlSessionStore(db),
		storage: (session) => sqlPiStorage(db, session.id),
		models,
		...(hostHandler === undefined ? {} : { hostHandler }),
	});
	cleanups.push(async () => {
		await service.close();
		await db.close();
	});
	return { service, script };
}

const never = () => new Promise<never>(() => {});

/**
 * A model call that never answers in its process. It ignores aborts as a dead process would, so the test lets it
 * fail once everything else has closed, for the dead process's Harness to close.
 */
function hungModelCall() {
	let fail: (error: Error) => void = () => {};
	const call = new Promise<never>((_resolve, reject) => {
		fail = reject;
	});
	call.catch(() => undefined);
	// Cleanups run last first: this runs before the dead process (set up earlier) closes.
	cleanups.push(async () => fail(new Error("the process is gone")));
	return () => call;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("a restart mid run", () => {
	it("carries on a run cut off mid model call, from a new process that resumes it", async () => {
		const file = databaseFile();
		const first = await processOn(file);
		await first.service.profiles.put(ctx, { ...profile, tools: [], hostId: undefined } as AgentProfile);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		first.script.reply(hungModelCall());
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await until(() => first.script.requests.length === 1, "the first model call");
		await until(
			async () => (await first.service.directory.get(ctx, session.id)).status === "running",
			"the session to show running",
		);

		const second = await processOn(file);
		second.script.reply({ text: "Answered after the restart" });
		expect(await second.service.resume()).toBe(1);
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
			status: "answered",
			answer: "Answered after the restart",
		});
		// The new process sent the same conversation again.
		expect(second.script.requests[0]?.messages.at(-1)).toMatchObject({ role: "user", text: "Hello" });
		expect((await second.service.directory.get(ctx, session.id)).status).toBe("idle");
	});

	it("reruns a replay-safe host tool cut off mid call, and the run finishes", async () => {
		const file = databaseFile();
		const reached: string[] = [];
		const first = await processOn(file, () => async (call) => {
			reached.push(`first:${call.callId}`);
			return never();
		});
		await first.service.profiles.put(ctx, profile);
		await first.service.hosts.register(
			ctx,
			"sal",
			[lookup("safe")],
			{ url: "https://sal.test/tools", secret: "s" },
			"owner",
		);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		first.script.reply({ toolCalls: [{ name: "lookup", args: { key: "plan" } }] });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Find the plan" });
		await until(() => reached.length === 1, "the first host call");

		const second = await processOn(file, () => async (call) => {
			reached.push(`second:${call.callId}`);
			return { output: "the plan" };
		});
		second.script.reply({ text: "Found it" });
		expect(await second.service.resume()).toBe(1);
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({
			status: "answered",
			answer: "Found it",
		});
		// The same call, retried: a host can deduplicate on the call ID.
		const [firstCall, secondCall] = reached.map((entry) => entry.split(":")[1]);
		expect(reached.map((entry) => entry.split(":")[0])).toEqual(["first", "second"]);
		expect(secondCall).toBe(firstCall);
		expect(second.script.requests[0]?.messages.at(-1)).toMatchObject({ role: "tool", text: "the plan" });
	});

	it("does not rerun a host tool that is not replay-safe; the model hears it was interrupted", async () => {
		const file = databaseFile();
		let calls = 0;
		const first = await processOn(file, () => async () => {
			calls += 1;
			return never();
		});
		await first.service.profiles.put(ctx, profile);
		await first.service.hosts.register(
			ctx,
			"sal",
			[lookup("unsafe")],
			{ url: "https://sal.test/tools", secret: "s" },
			"owner",
		);
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		first.script.reply({ toolCalls: [{ name: "lookup", args: {} }] });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Charge the card" });
		await until(() => calls === 1, "the first host call");

		const second = await processOn(file, () => async () => {
			calls += 1;
			return { output: "charged again" };
		});
		second.script.reply({ text: "It was interrupted; I will not retry" });
		await second.service.resume();
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ status: "answered" });
		expect(calls).toBe(1);
		const toolResult = second.script.requests[0]?.messages.find((message) => message.role === "tool");
		expect(toolResult?.text).toMatch(/interrupt/i);
	});

	it("leaves idle and closed sessions alone on resume", async () => {
		const file = databaseFile();
		const first = await processOn(file);
		await first.service.profiles.put(ctx, { ...profile, tools: [], hostId: undefined } as AgentProfile);
		await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const closed = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await first.service.runtime.close(ctx, closed.id);
		await first.service.close();
		const second = await processOn(file);
		expect(await second.service.resume()).toBe(0);
	});
});

describe("durable host registrations", () => {
	const owner: Authentication = { actor: { kind: "service", serviceId: "sal" }, organisationId: ORG };
	const intruder: Authentication = { actor: { kind: "service", serviceId: "other" }, organisationId: ORG };
	const SECRET = "a-callback-secret-of-at-least-32-characters";

	/** A process with the session API, its hosts kept in the store, calling hosts through `outbound`. */
	async function apiProcess(file: string, outbound: typeof fetch) {
		const db = await openNodeSqliteDatabase(file);
		const { models, script } = createScriptedModel();
		const service = createSessionRuntime({
			store: await createSqlSessionStore(db),
			storage: (session) => sqlPiStorage(db, session.id),
			models,
			hostHandler: callbackHostHandlers({ fetch: outbound }),
		});
		const api = createSessionApi({
			runtime: service.runtime,
			directory: service.directory,
			profiles: service.profiles,
			hostTools: service.hostTools,
			hosts: service.hosts,
			authenticator: staticTokenAuthenticator({ owner, intruder }),
			fetch: outbound,
			keepAliveMs: 60_000,
		});
		const stop = async () => {
			await api.close();
			await service.close();
			await db.close();
		};
		cleanups.push(stop);
		const request = (method: string, path: string, token: string, body?: unknown) =>
			api.fetch(
				new Request(`https://harbour.test/v1${path}`, {
					method,
					headers: {
						authorization: `Bearer ${token}`,
						...(body === undefined ? {} : { "content-type": "application/json" }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
		return { service, script, request, stop };
	}

	it("keeps a host registered over HTTP through a restart, calls it back signed, and only its owner removes it", async () => {
		const file = databaseFile();
		const received: string[] = [];
		const endpoint = createHostToolEndpoint(
			async (call) => {
				received.push(call.tool);
				return { output: "from the host" };
			},
			{ secret: SECRET },
		);
		const outbound: typeof fetch = async (input, init) => endpoint(new Request(input, init));

		const first = await apiProcess(file, outbound);
		await first.service.profiles.put(ctx, profile);
		const registered = await first.request("PUT", "/hosts/sal", "owner", {
			tools: [lookup("safe")],
			callback: { url: "https://sal.test/tools", secret: SECRET },
		});
		expect(registered.status).toBe(200);
		const { registration } = (await registered.json()) as { registration: string };
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		// The API going away does not end a durable registration.
		await first.stop();

		const second = await apiProcess(file, outbound);
		expect(await second.service.hostTools.list(ctx, "sal")).toEqual([lookup("safe")]);
		second.script.reply({ toolCalls: [{ name: "lookup", args: {} }] }, { text: "Done" });
		const prompt = await second.service.runtime.prompt(ctx, session.id, { text: "Look it up" });
		expect(await second.service.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ answer: "Done" });
		expect(received).toEqual(["lookup"]);

		expect((await second.request("DELETE", `/hosts/sal?registration=${registration}`, "intruder")).status).toBe(403);
		expect((await second.request("DELETE", "/hosts/sal?registration=not-it", "owner")).status).toBe(404);
		expect((await second.request("DELETE", `/hosts/sal?registration=${registration}`, "owner")).status).toBe(204);
		expect(await second.service.hostTools.list(ctx, "sal")).toEqual([]);
	});

	it("serves a replacement's tools, and the replaced registration can no longer remove it", async () => {
		const file = databaseFile();
		const outbound: typeof fetch = async () => new Response("{}", { status: 500 });
		const first = await apiProcess(file, outbound);
		const register = async (tools: unknown[]) =>
			(
				(await (
					await first.request("PUT", "/hosts/sal", "owner", {
						tools,
						callback: { url: "https://sal.test/tools", secret: SECRET },
					})
				).json()) as { registration: string }
			).registration;
		const old = await register([lookup("safe")]);
		await register([{ ...lookup("safe"), name: "search" }]);
		await first.stop();

		const second = await apiProcess(file, outbound);
		expect((await second.service.hostTools.list(ctx, "sal")).map((tool) => tool.name)).toEqual(["search"]);
		expect((await second.request("DELETE", `/hosts/sal?registration=${old}`, "owner")).status).toBe(404);
		expect((await second.service.hostTools.list(ctx, "sal")).map((tool) => tool.name)).toEqual(["search"]);
	});
});
