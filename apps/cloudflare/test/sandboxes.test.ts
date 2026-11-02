// The stack's sandboxes in Node: the isolate tier on the in-process backend, leases ended by the runtime's session end
// and swept on expiry, the container tier (refused without containers; with a stand-in for them, escalation, checkpoints
// and warm-up), git reads in the isolate, and the isolate-ready measurement as the gateway serves it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKantelError, systemContext } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createContainerBackend, type SandboxContainers, SYNC_BATCH_BYTES } from "../src/container-backend.ts";
import { createGateway } from "../src/gateway.ts";
import { MEASURE_COMMAND, MEASURE_FILES, MEASURE_PATH, MEASURE_WRITE_PATH } from "../src/measure.ts";
import { isolateBackendName } from "../src/sandboxes.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";
import { fakePrograms, fakeSandboxContainers } from "./sandbox-container.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const BASE = "https://kantel.test";

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

async function setup(
	options: {
		clock?: ReturnType<typeof manualClock>["clock"];
		gitFetch?: typeof globalThis.fetch;
		sandboxContainers?: SandboxContainers;
		warmOnMessage?: boolean;
	} = {},
) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
	});
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		...(options.clock === undefined ? {} : { clock: options.clock }),
		...(options.gitFetch === undefined ? {} : { gitFetch: options.gitFetch }),
		...(options.sandboxContainers === undefined ? {} : { sandboxContainers: options.sandboxContainers }),
	});
	opened.push(stack);
	const gateway = createGateway(stack, options.warmOnMessage === true ? { warmOnMessage: true } : {});
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
	const warmRoute = (sessionId: string, headers: Record<string, string> = signedIn) =>
		gateway.fetch(new Request(`${BASE}/v1/sessions/${sessionId}/warm`, { method: "POST", headers }));
	const message = (sessionId: string, text: string) =>
		gateway.fetch(
			new Request(`${BASE}/v1/sessions/${sessionId}/messages`, {
				method: "POST",
				headers: { ...signedIn, "content-type": "application/json" },
				body: JSON.stringify({ text }),
			}),
		);
	return { stack, measure, workspace, session, warmRoute, message };
}

/**
 * A git repository with four commits, served as GitHub serves it: `git-upload-pack` by the real upload-pack (protocol
 * v2, stateless) and the tarball by `git archive`.
 */
function gitOrigin() {
	const dir = mkdtempSync(join(tmpdir(), "kantel-cf-git-"));
	scratch.push(dir);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const git = (args: readonly string[], input?: string, extra: Record<string, string> = {}) =>
		execFileSync(
			"git",
			["-c", "user.name=H", "-c", "user.email=h@example.test", "-c", "commit.gpgsign=false", ...args],
			{
				cwd: dir,
				env: { ...env, ...extra },
				...(input === undefined ? {} : { input }),
				maxBuffer: 1 << 26,
			},
		);
	git(["init", "--quiet", "--initial-branch=main"]);
	git(["config", "uploadpack.allowFilter", "true"]);
	git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
	const commits: string[] = [];
	for (let index = 1; index <= 4; index++) {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "README.md"), `# site ${index}\n`);
		writeFileSync(join(dir, `src/file-${index}.ts`), `export const n = ${index};\n`);
		git(["add", "-A"]);
		git(["commit", "--quiet", "-m", `Change ${index}`]);
		commits.unshift(git(["rev-parse", "HEAD"]).toString().trim());
	}
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://github.com/kantel-fixtures/site.git/git-upload-pack") {
			const reply = git(["upload-pack", "--stateless-rpc", "."], String(init?.body ?? ""), {
				GIT_PROTOCOL: "version=2",
			});
			return new Response(new Uint8Array(reply));
		}
		const tarball = /^https:\/\/codeload\.github\.com\/kantel-fixtures\/site\/tar\.gz\/([0-9a-f]{40})$/.exec(url);
		if (tarball !== null) {
			return new Response(
				new Uint8Array(git(["archive", "--format=tar.gz", `--prefix=site-${tarball[1]}/`, tarball[1]!])),
			);
		}
		return new Response("", { status: 404 });
	}) as typeof globalThis.fetch;
	return { commits, fetch };
}

const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

	it("refuses a command the container tier would run when the deploy runs no containers", async () => {
		const { stack, workspace, session } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const run = stack.sandboxes.sandboxes.run(stack.admin, {
			sessionId,
			workspaceId,
			tool: "bash",
			request: { command: "npm install" },
		});
		await expect(run).rejects.toSatisfy((error: unknown) => isKantelError(error, "unavailable"));

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

	it("runs git reads in the isolate, and without containers leaves an unknown program to fail there", async () => {
		const { stack } = await setup();
		const sandboxes = stack.sandboxes.sandboxes;
		expect(sandboxes.route("bash", "git status")).toBe("isolate");
		expect(sandboxes.route("bash", "git log --oneline -5")).toBe("isolate");
		// No container tier: a git write goes to the isolate too, whose git says it needs one.
		expect(sandboxes.route("bash", "git commit -m x")).toBe("isolate");
		// No container to escalate to: the table decides, as before.
		expect(sandboxes.route("bash", "make all")).toBe("isolate");
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

	it("seeds a GitHub repository with its history, and answers git reads in the isolate", async () => {
		const origin = gitOrigin();
		const { stack, session } = await setup({ gitFetch: origin.fetch });
		const made = await stack.workspaces.create(stack.admin, {
			owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
			seed: { name: "site", sources: [{ kind: "git", repo: "kantel-fixtures/site", ref: "main" }] },
		});
		expect(made.seedReadiness).toBe("files");
		const { id: sessionId } = await session(made.id);
		const bash = (command: string) =>
			stack.sandboxes.sandboxes.run(stack.admin, {
				sessionId,
				workspaceId: made.id,
				tool: "bash",
				request: { command },
			});

		const log = await bash("git log --oneline -3");
		expect(log).toMatchObject({ exitCode: 0 });
		expect(log.stdout).toBe(
			origin.commits
				.slice(0, 3)
				.map((commit, index) => `${commit.slice(0, 7)} Change ${4 - index}\n`)
				.join(""),
		);
		// Every git command runs in the isolate, a pipeline too; the seeded tree is the commit's, so nothing has changed.
		expect(await bash("git status --short && git log --format=x | head -1")).toMatchObject({ exitCode: 0 });
		expect((await bash("git status")).stdout).toContain("On branch main\n");
		const show = (await bash("git show HEAD~1")).stdout;
		expect(show).toContain("    Change 3");
		// With its diff: recent diffs' blobs come with the history.
		expect(show).toContain("--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# site 2\n+# site 3\n");
		expect((await bash("git status --short")).stdout).toBe("");
		// A small repository brings every blob, so the working tree diffs too.
		await bash("echo more >> README.md");
		expect((await bash("git diff")).stdout).toContain("@@ -1 +1,2 @@\n # site 4\n+more\n");
		// A write says it needs the container tier.
		const commit = await bash("git commit -m x");
		expect(commit.exitCode).toBe(1);
		expect(commit.stderr).toMatch(/container tier/);
	});

	it("reads the backend from KANTEL_ISOLATE_BACKEND, refusing one it doesn't have", () => {
		expect(isolateBackendName({})).toBe("in-process");
		expect(isolateBackendName({ KANTEL_ISOLATE_BACKEND: " in-process " })).toBe("in-process");
		expect(() => isolateBackendName({ KANTEL_ISOLATE_BACKEND: "container" })).toThrow(/KANTEL_ISOLATE_BACKEND/);
	});
});

describe("the container tier", () => {
	async function withContainers(
		options: { clock?: ReturnType<typeof manualClock>["clock"]; warmOnMessage?: boolean } = {},
	) {
		const fakes = fakeSandboxContainers(fakePrograms);
		const set = await setup({ sandboxContainers: fakes.containers, ...options });
		const workspaceId = await set.workspace();
		await set.stack.workspaces.commit(set.stack.admin, workspaceId, {
			baseVersion: (await set.stack.workspaces.get(set.stack.admin, workspaceId)).head,
			changes: [{ op: "put", path: "src/in.txt", content: "v1" }],
		});
		const { id: sessionId } = await set.session(workspaceId);
		const run = (command: string) =>
			set.stack.sandboxes.sandboxes.run(set.stack.admin, {
				sessionId,
				workspaceId,
				tool: "bash",
				request: { command },
			});
		const text = async (path: string) =>
			new TextDecoder().decode((await set.stack.workspaces.read(set.stack.admin, workspaceId, path)).content);
		const warm = () => set.stack.sandboxes.warm(set.stack.admin, { sessionId, workspaceId });
		return { ...set, fakes, workspaceId, sessionId, run, text, warm, container: () => fakes.of(sessionId) };
	}

	it("keeps git reads in the isolate and sends git writes to the container", async () => {
		const { stack } = await withContainers();
		const sandboxes = stack.sandboxes.sandboxes;
		expect(sandboxes.route("bash", "git status")).toBe("isolate");
		expect(sandboxes.route("bash", "git log --oneline -5")).toBe("isolate");
		expect(sandboxes.route("bash", "git commit -m x")).toBe("container");
		expect(sandboxes.route("bash", "make all")).toBe("container");
	});

	it("escalates a command with a program the isolate lacks, and the workspace has what it wrote at once", async () => {
		const { run, text, container } = await withContainers();
		const built = await run("cat src/in.txt && make");
		expect(built).toMatchObject({ tier: "container", exitCode: 0, stdout: "v1" });
		// Checkpointed: the file tools, which read the workspace, see the build without waiting for a release.
		expect(await text("build/out.txt")).toBe("built: v1");
		expect(container().execs).toEqual(["cat src/in.txt && make"]);

		// The isolate carries on from it, and the container sees the isolate's write in turn.
		const read = await run("cat build/out.txt && printf '%s' v2 > src/in.txt");
		expect(read).toMatchObject({ tier: "isolate", exitCode: 0, stdout: "built: v1" });
		const again = await run("make && cat build/out.txt");
		expect(again).toMatchObject({ tier: "container", stdout: "built: v2", leaseId: built.leaseId });
		expect(container().starts).toBe(1);
	});

	it("checkpoints a container command from its own answer, with no second call to the container", async () => {
		const { run, text, container, stack, workspaceId } = await withContainers();
		// A command that writes: committed from what `exec` answered, then acknowledged.
		const built = await run("make");
		expect(built).toMatchObject({ tier: "container", exitCode: 0 });
		expect(await text("build/out.txt")).toBe("built: v1");
		expect(built.workspaceVersion).toBeGreaterThan(built.baseVersion);
		expect(container()).toMatchObject({ changesCalls: 0, acks: 1 });
		// One that writes nothing: no further call at all.
		const read = await run("cat build/out.txt && uname");
		expect(read).toMatchObject({ tier: "container", stdout: "built: v1Linux\n", workspaceVersion: read.baseVersion });
		expect(container()).toMatchObject({ changesCalls: 0, acks: 1 });

		// An agent from before `changes` on `/exec`: the checkpoint asks for them, as it did.
		container().legacyExec = true;
		await stack.workspaces.commit(stack.admin, workspaceId, {
			baseVersion: (await stack.workspaces.get(stack.admin, workspaceId)).head,
			changes: [{ op: "put", path: "src/in.txt", content: "v3" }],
		});
		await run("make");
		expect(container()).toMatchObject({ changesCalls: 1, acks: 2 });
		expect(await text("build/out.txt")).toBe("built: v3");
	});

	it("starts a stopped container again with the workspace as committed", async () => {
		const { run, text, container } = await withContainers();
		await run("make");
		container().stop();
		const after = await run("cat build/out.txt && uname");
		expect(after).toMatchObject({ tier: "container", exitCode: 0, stdout: "built: v1Linux\n" });
		expect(container().starts).toBe(2);
		expect(await text("build/out.txt")).toBe("built: v1");
	});

	it("stops the container when its lease expires, and a warm-up starts it again with the workspace", async () => {
		const time = manualClock();
		const { stack, run, warm, container } = await withContainers({ clock: time.clock });
		await run("make");
		expect(container().running).toBe(true);
		// The lease's 15 minutes pass without a command: the sweep ends it, and the container goes with it.
		time.advance(16 * 60_000);
		const swept = await stack.sandboxes.sweep(systemContext("session"));
		expect(swept.map((lease) => [lease.tier, lease.endReason])).toEqual([["container", "expired"]]);
		expect(container().running).toBe(false);

		expect((await warm()).container).toBe("started");
		const after = await run("cat build/out.txt && uname");
		expect(after).toMatchObject({ tier: "container", exitCode: 0, stdout: "built: v1Linux\n" });
		expect(container().starts).toBe(2);
	});

	it("sends a large sync in batches, each but the last staged ahead of the command", async () => {
		const { stack, workspaceId, sessionId, run, fakes } = await withContainers();
		await run("make");
		const big = "x".repeat(600);
		await stack.workspaces.commit(stack.admin, workspaceId, {
			baseVersion: (await stack.workspaces.get(stack.admin, workspaceId)).head,
			changes: ["a", "b", "c"].map((name) => ({ op: "put" as const, path: `big/${name}.txt`, content: big })),
		});
		const backend = createContainerBackend({
			workspaces: stack.workspaces,
			containers: fakes.containers,
			batchBytes: 1000,
		});
		const [lease] = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId, live: true });
		const record = await stack.workspaces.get(stack.admin, workspaceId);
		const ran = await backend.exec({ ctx: stack.admin, lease: lease!, record, request: { command: "cat big/c.txt" } });
		expect(ran).toMatchObject({ exitCode: 0, stdout: big });
		// Three files of 600 bytes in batches of 1,000: three batches, two staged ahead of the command's own.
		const container = fakes.of(sessionId);
		expect(container.stages).toBe(2);
		expect(container.file("big/a.txt")).toBe(big);
		expect(container.version).toBe(record.head);
		expect(SYNC_BATCH_BYTES).toBe(8 * 1024 * 1024);
	});

	it("warms only a session that has used a container, and only once it needs it", async () => {
		const { warm, run, container } = await withContainers();
		expect((await warm()).container).toBe("skipped");
		expect(container().starts).toBe(0);
		expect(container().putsReceived).toBe(0);

		await run("make");
		expect((await warm()).container).toBe("running");
		container().stop();
		const started = await warm();
		expect(started.container).toBe("started");
		expect(container().starts).toBe(2);
		// Re-based on the head, so the next command copies nothing.
		const received = container().putsReceived;
		expect(container().file("build/out.txt")).toBe("built: v1");
		expect((await warm()).container).toBe("running");
		await run("uname");
		expect(container().putsReceived).toBe(received);
	});

	it("asks a container what it holds after the stack object forgot, rather than copying the tree again", async () => {
		const { stack, workspaceId, sessionId, run, fakes } = await withContainers();
		await run("make");
		const container = fakes.of(sessionId);
		const received = container.putsReceived;
		// A new backend: an evicted stack object's, which knows nothing of the container.
		const fresh = createContainerBackend({ workspaces: stack.workspaces, containers: fakes.containers });
		const [lease] = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId, live: true });
		const record = await stack.workspaces.get(stack.admin, workspaceId);
		const ran = await fresh.exec({ ctx: stack.admin, lease: lease!, record, request: { command: "uname" } });
		expect(ran).toMatchObject({ exitCode: 0, stdout: "Linux\n" });
		expect(container.putsReceived).toBe(received);
	});

	it("serves POST /v1/sessions/{id}/warm to someone who may run the session", async () => {
		const { warmRoute, sessionId, run } = await withContainers();
		const first = await warmRoute(sessionId);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ container: "skipped" });
		await run("make");
		expect(await (await warmRoute(sessionId)).json()).toEqual({ container: "running" });
		expect((await warmRoute("no-such-session")).status).toBe(404);
		expect((await warmRoute(sessionId, {})).status).toBe(401);
	});

	it("starts a session's container on its first message, before any command, with warmOnMessage", async () => {
		const { message, sessionId, run, container } = await withContainers({ warmOnMessage: true });
		expect(container().running).toBe(false);
		expect((await message(sessionId, "Build it")).status).toBe(202);
		// In the background: the message is answered first.
		await vi.waitFor(() => expect(container().running).toBe(true));
		// The first command finds it started and current: no second start.
		await run("make");
		expect(container().starts).toBe(1);
	});

	it("leaves the container alone on a message without warmOnMessage", async () => {
		const { message, sessionId, container } = await withContainers();
		expect((await message(sessionId, "Build it")).status).toBe(202);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(container().running).toBe(false);
	});

	it("stops a session's container as soon as the session closes, after committing what it wrote", async () => {
		const { stack, sessionId, workspaceId, run, text, warm, warmRoute, container } = await withContainers();
		await run("make");
		expect(container().running).toBe(true);

		await stack.runtime.runtime.close(stack.admin, sessionId);
		// Stopped at once (the instance is free), not left for the 10-minute inactivity timeout.
		expect(container().running).toBe(false);
		expect(container().destroys).toBe(1);
		expect(await text("build/out.txt")).toBe("built: v1");
		const [ended] = await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId });
		expect(ended).toMatchObject({ tier: "container", endReason: "session_ended" });
		const stopped = await stack.audit.query(stack.admin, { type: "sandbox.container.stopped", sessionId });
		expect(stopped.items.map((event) => event.data)).toEqual([{ reason: "session_ended", via: "destroyed" }]);

		// Nothing starts it again: a warm-up (the API's or forced) skips it, and its object refuses a command.
		expect((await warm()).container).toBe("skipped");
		expect(await (await warmRoute(sessionId)).json()).toEqual({ container: "skipped" });
		expect((await stack.sandboxes.warm(stack.admin, { sessionId, workspaceId, force: true })).container).toBe(
			"skipped",
		);
		await expect(
			container().exec({
				leaseId: "later",
				sessionId,
				workspaceId,
				sync: { from: null, to: 0, put: [], remove: [] },
				request: { command: "uname" },
			}),
		).rejects.toThrow(/closed/);
		expect(container().starts).toBe(1);

		// Closing again changes nothing, and audits nothing more.
		await stack.runtime.runtime.close(stack.admin, sessionId);
		expect(container().destroys).toBe(1);
		expect((await stack.audit.query(stack.admin, { type: "sandbox.container.stopped", sessionId })).items).toHaveLength(
			1,
		);
	});

	it("stops the container of a deleted session, and leaves other sessions' containers running", async () => {
		const { stack, workspaceId, sessionId, run, session, fakes } = await withContainers();
		const other = (await session(workspaceId)).id;
		await run("make");
		await stack.sandboxes.sandboxes.run(stack.admin, {
			sessionId: other,
			workspaceId,
			tool: "bash",
			request: { command: "uname" },
		});
		expect([fakes.of(sessionId).running, fakes.of(other).running]).toEqual([true, true]);

		await stack.runtime.organising.remove(stack.admin, sessionId);
		expect(fakes.of(sessionId).running).toBe(false);
		expect(fakes.of(other).running).toBe(true);
		expect(fakes.of(other).destroys).toBe(0);
	});

	it("stops a container the stack object forgot (an eviction or a deploy) when its session closes", async () => {
		const { stack, sessionId, workspaceId, fakes, container } = await withContainers();
		// The container ran a command for a lease this stack object never knew: its in-memory leases are gone.
		const backend = createContainerBackend({ workspaces: stack.workspaces, containers: fakes.containers });
		const record = await stack.workspaces.get(stack.admin, workspaceId);
		const lease = {
			id: "before-the-deploy",
			sessionId,
			workspaceId,
			tier: "container" as const,
			baseVersion: record.head,
			acquiredAt: 0,
			expiresAt: Number.MAX_SAFE_INTEGER,
		};
		await backend.exec({ ctx: stack.admin, lease, record, request: { command: "uname" } });
		expect(container().running).toBe(true);
		expect(await stack.sandboxes.sandboxes.leases(stack.admin, { sessionId })).toHaveLength(0);

		await stack.runtime.runtime.close(stack.admin, sessionId);
		expect(container().running).toBe(false);
	});

	it("keeps the container warm when the session is only aborted, and touches nothing for one that never ran it", async () => {
		const { stack, workspaceId, sessionId, run, session, fakes, container } = await withContainers();
		await run("make");
		await stack.runtime.runtime.abort(stack.admin, sessionId, "stop");
		expect(container().running).toBe(true);
		expect((await run("uname")).stdout).toBe("Linux\n");
		expect(container().starts).toBe(1);

		// A session that only used the isolate: its close starts nothing and stops nothing.
		const isolateOnly = (await session(workspaceId)).id;
		await stack.sandboxes.sandboxes.run(stack.admin, {
			sessionId: isolateOnly,
			workspaceId,
			tool: "bash",
			request: { command: "true" },
		});
		await stack.runtime.runtime.close(stack.admin, isolateOnly);
		expect(fakes.of(isolateOnly)).toMatchObject({ running: false, starts: 0, destroys: 0, closed: false });
	});

	it("answers unavailable from the warm route without containers", async () => {
		const { warmRoute, workspace, session } = await setup();
		const { id: sessionId } = await session(await workspace());
		const response = await warmRoute(sessionId);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ container: "unavailable" });
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
