// The stack's sandboxes in Node: the isolate tier on the in-process backend, leases ended by the runtime's session end
// and swept on expiry, the container tier refused, and the isolate-ready measurement as the gateway serves it.
import { isHarbourError, systemContext } from "@harbour/contracts";
import { createMockAccess } from "@harbour/identity/testing";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { MEASURE_COMMAND, MEASURE_FILES, MEASURE_PATH, MEASURE_WRITE_PATH } from "../src/measure.ts";
import { isolateBackendName } from "../src/sandboxes.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** A clock the test moves. */
function manualClock(start = Date.parse("2026-10-28T10:00:00Z")) {
	let now = start;
	return {
		clock: { now: () => now },
		advance: (ms: number) => {
			now += ms;
		},
	};
}

async function setup(options: { clock?: ReturnType<typeof manualClock>["clock"] } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		HARBOUR_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		HARBOUR_ACCESS_AUD: AUD,
		HARBOUR_ADMIN_EMAIL: ADMIN,
	});
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
	opened.push(stack);
	const gateway = createGateway(stack);
	const signedIn = { "cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }) };
	const measure = (body?: unknown, headers: Record<string, string> = signedIn, method = "POST") =>
		gateway.fetch(
			new Request(`${BASE}${MEASURE_PATH}`, {
				method,
				headers: { ...headers, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	const workspace = async () => {
		const made = await stack.workspaces.create(stack.admin, {
			owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		});
		await stack.workspaces.commit(stack.admin, made.id, {
			baseVersion: made.head,
			changes: [{ op: "put", path: "notes/a.md", content: "# A" }],
		});
		return made.id;
	};
	const session = async (workspaceId: string) =>
		stack.runtime.runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			title: "Sandboxed",
			workspaceId,
		});
	return { stack, measure, workspace, session };
}

async function operatorKey(stack: Stack): Promise<string> {
	const service = await stack.identity.createServiceIdentity(stack.admin, { name: "measure" });
	const key = await stack.identity.issueApiKey(stack.admin, {
		serviceId: service.id,
		projectIds: [stack.project.id],
		role: "operator",
	});
	return key.secret;
}

describe("the stack's sandboxes", () => {
	it("runs the isolate tier in process and commits what a command writes", async () => {
		const { stack, workspace, session } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const sandboxes = stack.sandboxes.sandboxes;

		const wrote = await sandboxes.run(stack.admin, {
			sessionId,
			workspaceId,
			tool: "bash",
			request: { command: "cat notes/a.md && echo hello > notes/b.md" },
		});
		expect(wrote).toMatchObject({ exitCode: 0, stdout: "# A" });
		const read = await stack.workspaces.read(stack.admin, workspaceId, "notes/b.md");
		expect(new TextDecoder().decode(read.content)).toBe("hello\n");
		expect(stack.sandboxes.backend).toBe("in-process");
	});

	it("refuses a command the container tier would run, as Cloudflare has no container tier yet", async () => {
		const { stack, workspace, session } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const run = stack.sandboxes.sandboxes.run(stack.admin, {
			sessionId,
			workspaceId,
			tool: "bash",
			request: { command: "git status" },
		});
		await expect(run).rejects.toSatisfy((error: unknown) => isHarbourError(error, "unavailable"));

		// The refusal leaves the session working: the isolate still runs, and closing the session ends every lease.
		const after = await stack.sandboxes.sandboxes.run(stack.admin, {
			sessionId,
			workspaceId,
			tool: "bash",
			request: { command: "true" },
		});
		expect(after.exitCode).toBe(0);
		await stack.runtime.runtime.close(stack.admin, sessionId);
		expect(await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId, live: true })).toHaveLength(0);
	});

	it("ends a session's leases when the session closes", async () => {
		const { stack, workspace, session } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const sandboxes = stack.sandboxes.sandboxes;
		await sandboxes.run(stack.admin, { sessionId, workspaceId, tool: "bash", request: { command: "true" } });
		expect(await sandboxes.leases(stack.admin, { sessionId, live: true })).toHaveLength(1);

		await stack.runtime.runtime.close(stack.admin, sessionId);
		expect(await sandboxes.leases(stack.admin, { sessionId, live: true })).toHaveLength(0);
		const [ended] = await sandboxes.leases(stack.admin, { sessionId });
		expect(ended?.endReason).toBe("session_ended");
	});

	it("sweeps a lease past its TTL", async () => {
		const time = manualClock();
		const { stack, workspace, session } = await setup({ clock: time.clock });
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const sandboxes = stack.sandboxes.sandboxes;
		await sandboxes.acquire(stack.admin, { sessionId, workspaceId, tier: "isolate", ttlMs: 1_000 });
		time.advance(5_000);
		const swept = await stack.sandboxes.sweep(systemContext("session"));
		expect(swept.map((lease) => lease.endReason)).toEqual(["expired"]);
	});

	it("reads the backend from HARBOUR_ISOLATE_BACKEND, refusing one it doesn't have", () => {
		expect(isolateBackendName({})).toBe("in-process");
		expect(isolateBackendName({ HARBOUR_ISOLATE_BACKEND: " in-process " })).toBe("in-process");
		expect(() => isolateBackendName({ HARBOUR_ISOLATE_BACKEND: "container" })).toThrow(/HARBOUR_ISOLATE_BACKEND/);
	});
});

describe("the isolate-ready measurement", () => {
	it("creates a session, lists its workspace in the isolate, and closes it", async () => {
		const { stack, measure } = await setup();
		const response = await measure({});
		expect(response.status).toBe(200);
		const run = (await response.json()) as {
			backend: string;
			sessionId: string;
			workspaceId: string;
			exitCode: number;
			listed: number;
			timings: Record<string, number>;
			clock: Record<string, number>;
		};
		expect(run).toMatchObject({ backend: "in-process", exitCode: 0 });
		// The marks behind the timings, as Unix milliseconds, in order, so the script can check them against its own.
		const marks = ["entered", "signedIn", "started", "created", "ran"].map((mark) => run.clock[mark]);
		for (const mark of marks) expect(mark).toBeTypeOf("number");
		expect(marks).toEqual([...marks].sort((a, b) => a! - b!));
		expect(Math.abs(Date.now() - run.clock.ran!)).toBeLessThan(60_000);
		// `ls -1R` prints every file, each directory's heading and its entries.
		expect(run.listed).toBeGreaterThanOrEqual(MEASURE_FILES);
		for (const phase of ["session", "isolate", "total"]) expect(run.timings[phase]).toBeTypeOf("number");

		// The session is closed and its lease ended; the next run reuses the workspace with a new session.
		expect(await stack.runtime.directory.get(stack.admin, run.sessionId)).toMatchObject({ status: "done" });
		const live = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: run.sessionId, live: true });
		expect(live).toHaveLength(0);
		const again = (await (await measure()).json()) as { sessionId: string; workspaceId: string };
		expect(again.workspaceId).toBe(run.workspaceId);
		expect(again.sessionId).not.toBe(run.sessionId);
		expect(MEASURE_COMMAND).toBe("ls -1R");
	});

	it("keeps a session open on request, runs warm on it again and again, and leaves closing it to the caller", async () => {
		const { stack, measure } = await setup();
		type Run = {
			sessionId: string;
			workspaceId: string;
			warm: boolean;
			open: boolean;
			exitCode: number;
			listed: number;
			timings: Record<string, number>;
			clock: Record<string, number>;
		};
		const warmup = (await (await measure({ keep: true })).json()) as Run;
		expect(warmup).toMatchObject({ warm: false, open: true, exitCode: 0 });
		expect(await stack.runtime.directory.get(stack.admin, warmup.sessionId)).not.toMatchObject({ status: "done" });
		const [lease] = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: warmup.sessionId, live: true });
		expect(lease).toBeDefined();

		for (let i = 0; i < 3; i++) {
			const response = await measure({ sessionId: warmup.sessionId });
			expect(response.status).toBe(200);
			const run = (await response.json()) as Run;
			expect(run).toMatchObject({
				sessionId: warmup.sessionId,
				workspaceId: warmup.workspaceId,
				warm: true,
				open: true,
				exitCode: 0,
				listed: warmup.listed,
			});
			for (const phase of ["lookup", "isolate", "total"]) expect(run.timings[phase]).toBeTypeOf("number");
			expect(run.timings.session).toBeUndefined();
			for (const mark of ["entered", "signedIn", "looking", "started", "ran"]) {
				expect(run.clock[mark]).toBeTypeOf("number");
			}
			expect(run.clock.created).toBeUndefined();
		}
		// The same lease every time: the runs are on the warm session, not new ones.
		const live = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: warmup.sessionId, live: true });
		expect(live.map((each) => each.id)).toEqual([lease!.id]);

		// Closing it ends the lease; a warm run on a closed session is refused.
		await stack.runtime.runtime.close(stack.admin, warmup.sessionId);
		const after = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: warmup.sessionId, live: true });
		expect(after).toHaveLength(0);
		expect((await measure({ sessionId: warmup.sessionId })).status).toBe(409);
	});

	it("with tools, runs the session's file tools on its workspace first, leasing nothing until the command", async () => {
		const { stack, measure } = await setup();
		const response = await measure({ tools: true });
		expect(response.status).toBe(200);
		const run = (await response.json()) as {
			sessionId: string;
			workspaceId: string;
			exitCode: number;
			leasedBeforeBash: number;
			timings: Record<string, number>;
		};
		expect(run).toMatchObject({ exitCode: 0, leasedBeforeBash: 0 });
		for (const phase of ["session", "read", "ls", "write", "isolate", "total"]) {
			expect(run.timings[phase]).toBeTypeOf("number");
		}
		const wrote = await stack.workspaces.read(stack.admin, run.workspaceId, MEASURE_WRITE_PATH);
		expect(new TextDecoder().decode(wrote.content)).toBe(`measured in ${run.sessionId}\n`);
		// Written as the session's agent, and the command's lease ended with the session.
		const [commit] = (await stack.audit.query(stack.admin, { type: "workspace.committed", sessionId: run.sessionId }))
			.items;
		expect(commit?.actor).toEqual({ kind: "agent", agentId: DEFAULT_AGENT_ID, sessionId: run.sessionId });
		expect(await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: run.sessionId, live: true })).toEqual([]);
		expect((await measure({ tools: "yes" })).status).toBe(400);
	});

	it("with tools on a warm session, times the file tools on the open session, then runs on its lease", async () => {
		const { stack, measure } = await setup();
		const warmup = (await (await measure({ keep: true })).json()) as { sessionId: string };
		const [lease] = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: warmup.sessionId, live: true });
		const response = await measure({ sessionId: warmup.sessionId, tools: true });
		expect(response.status).toBe(200);
		const run = (await response.json()) as {
			warm: boolean;
			exitCode: number;
			leasedBeforeBash: number;
			timings: Record<string, number>;
		};
		// The warm-up's lease, and no other: the file tools took none.
		expect(run).toMatchObject({ warm: true, exitCode: 0, leasedBeforeBash: 1 });
		for (const phase of ["read", "ls", "write", "lookup", "isolate"]) expect(run.timings[phase]).toBeTypeOf("number");
		const live = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId: warmup.sessionId, live: true });
		expect(live.map((each) => each.id)).toEqual([lease!.id]);
		await stack.runtime.runtime.close(stack.admin, warmup.sessionId);
	});

	it("runs warm only on an open measurement session on the same backend", async () => {
		const { stack, measure, workspace, session } = await setup();
		const other = await session(await workspace());
		expect((await measure({ sessionId: other.id })).status).toBe(400);
		const warmup = (await (await measure({ keep: true })).json()) as { sessionId: string };
		// A backend this Worker doesn't have is unavailable before any session is looked at.
		expect((await measure({ sessionId: warmup.sessionId, backend: "dynamic-worker" })).status).toBe(503);
		// A measurement session labelled with another backend is refused on this one.
		const elsewhere = await stack.runtime.runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			labels: { measurement: "isolate-ready", backend: "dynamic-worker" },
			workspaceId: await workspace(),
		});
		const refused = await measure({ sessionId: elsewhere.id, backend: "in-process" });
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("on in-process");
		expect((await measure({ sessionId: "no-such-session" })).status).toBe(404);
		expect((await measure({ sessionId: warmup.sessionId, keep: true })).status).toBe(400);
		expect((await measure({ sessionId: "" })).status).toBe(400);
		expect((await measure({ keep: "yes" })).status).toBe(400);
		await stack.runtime.runtime.close(stack.admin, warmup.sessionId);
	});

	it("refuses an unknown backend, a bad body, another method and an anonymous caller", async () => {
		const { measure } = await setup();
		expect((await measure({ backend: "dynamic-everything" })).status).toBe(400);
		expect((await measure({ backend: 7 })).status).toBe(400);
		expect((await measure(undefined, undefined, "GET")).status).toBe(405);
		expect((await measure({}, {})).status).toBe(401);
		expect((await measure({ backend: "in-process", pad: "x".repeat(2048) })).status).toBe(413);
	});

	it("finds the measurement workspace again after a restart, rather than making another", async () => {
		const { stack, measure } = await setup();
		const first = (await (await measure()).json()) as { workspaceId: string };
		// A new gateway over the same stack forgets the workspace, as an object restart does.
		const restarted = createGateway(stack);
		const response = await restarted.fetch(
			new Request(`${BASE}${MEASURE_PATH}`, {
				method: "POST",
				headers: { authorization: `Bearer ${await operatorKey(stack)}` },
			}),
		);
		expect(response.status).toBe(200);
		const second = (await response.json()) as { workspaceId: string };
		expect(second.workspaceId).toBe(first.workspaceId);
	});
});
