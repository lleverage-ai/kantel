/**
 * Sandbox conformance: tool-to-tier routing, isolate and container commits over one workspace, read-only mounts,
 * lease TTLs and sweeping, one live lease per session per tier, and usage. Commands use a portable subset that the
 * in-memory shell and a real `sh` both run.
 */
import type {
	CallContext,
	MountSource,
	OwnerRef,
	Sandboxes,
	SandboxTier,
	SessionId,
	WorkspaceId,
	Workspaces,
} from "@harbour/contracts";
import {
	actors,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface SandboxSubject {
	readonly sandboxes: Sandboxes;
	/** The workspaces `sandboxes` runs over. */
	readonly workspaces: Workspaces;
	/** A `project-files` source registered with `workspaces`; it must implement `write`. */
	readonly projectFiles: MountSource;
}

export type SandboxConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: SandboxSubject) => Promise<void>,
) => Promise<void>;

export const SANDBOX_FIXTURE = {
	organisationId: "org-harbour",
	otherOrganisationId: "org-elsewhere",
	projectId: "proj-harbour",
	sessionId: "sess-sandbox",
	otherSessionId: "sess-other",
	projectReadme: "project readme v1",
} as const;

const ctx: CallContext = contextFor(
	actors.agent("agent-1", SANDBOX_FIXTURE.sessionId),
	SANDBOX_FIXTURE.organisationId,
	SANDBOX_FIXTURE.projectId,
);
const otherCtx: CallContext = contextFor(actors.human("user-mallory"), SANDBOX_FIXTURE.otherOrganisationId);
const owner: OwnerRef = {
	kind: "project",
	organisationId: SANDBOX_FIXTURE.organisationId,
	projectId: SANDBOX_FIXTURE.projectId,
};
const sessionId: SessionId = SANDBOX_FIXTURE.sessionId;

const decoder = new TextDecoder();

export function createSandboxConformance(options: {
	assertions: ConformanceAssertions;
	provider: SandboxConformanceProvider;
}): readonly ConformanceCase[] {
	const a = options.assertions;
	const withSubject = (run: (subject: SandboxSubject, deps: ConformanceDeps) => Promise<void>) => async () => {
		const deps = createDeps();
		await options.provider(deps, (subject) => run(subject, deps));
	};

	/** A workspace with `/project` mounted from the project files source. */
	async function setUp(subject: SandboxSubject): Promise<{ workspaceId: WorkspaceId; projectVersion: string }> {
		const { projectFiles } = subject;
		if (projectFiles.write === undefined) throw new Error("the project files source must implement write");
		const { version } = await projectFiles.write(ctx, SANDBOX_FIXTURE.projectId, [
			{ op: "put", path: "README.md", content: SANDBOX_FIXTURE.projectReadme },
		]);
		const record = await subject.workspaces.create(ctx, {
			owner,
			sessionId,
			mounts: [{ path: "/project", source: projectFiles.kind, ref: SANDBOX_FIXTURE.projectId }],
		});
		return { workspaceId: record.id, projectVersion: version };
	}

	const bash = (workspaceId: WorkspaceId, command: string) => ({
		sessionId,
		workspaceId,
		tool: "bash",
		request: { command },
	});

	async function head(subject: SandboxSubject, workspaceId: WorkspaceId): Promise<number> {
		return (await subject.workspaces.get(ctx, workspaceId)).head;
	}

	async function fileText(subject: SandboxSubject, workspaceId: WorkspaceId, path: string): Promise<string> {
		return decoder.decode((await subject.workspaces.read(ctx, workspaceId, path)).content);
	}

	return [
		{
			name: "routes tools to tiers through the table",
			run: withSubject(async ({ sandboxes }) => {
				const cases: [string, string | readonly string[] | undefined, SandboxTier][] = [
					["bash", "git status", "container"],
					["bash", "cd repo && git status", "container"],
					["bash", "FOO=1 git status", "container"],
					["bash", ["/usr/bin/git", "status"], "container"],
					["bash", "bun test", "container"],
					["bash", "cat notes/a.md", "isolate"],
					["bash", "cd repo && cat a.md", "isolate"],
					["bash", undefined, "isolate"],
					["read", undefined, "isolate"],
					["write", undefined, "isolate"],
					["edit", "git status", "isolate"],
					["an-unknown-tool", "git status", "isolate"],
				];
				for (const [tool, command, tier] of cases) {
					a.strictEqual(sandboxes.route(tool, command), tier, `${tool} ${JSON.stringify(command)}`);
				}
			}),
		},
		{
			name: "commits an isolate write at the end of the command",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				const before = await head(subject, workspaceId);
				const written = await subject.sandboxes.run(
					ctx,
					bash(workspaceId, "mkdir -p notes && printf '%s' 'hello' > notes/a.txt"),
				);
				a.partialDeepEqual(written, { exitCode: 0, tier: "isolate", workspaceVersion: before + 1 });
				a.strictEqual(await head(subject, workspaceId), before + 1);
				a.strictEqual(await fileText(subject, workspaceId, "notes/a.txt"), "hello");

				const appended = await subject.sandboxes.run(ctx, bash(workspaceId, "printf '%s' ' world' >> notes/a.txt"));
				a.strictEqual(appended.workspaceVersion, before + 2);
				a.strictEqual(await fileText(subject, workspaceId, "notes/a.txt"), "hello world");

				const readOnly = await subject.sandboxes.run(ctx, bash(workspaceId, "cat notes/a.txt"));
				a.partialDeepEqual(readOnly, { exitCode: 0, stdout: "hello world", workspaceVersion: before + 2 });
				a.strictEqual(await head(subject, workspaceId), before + 2);
			}),
		},
		{
			name: "lets the container see the isolate's last write",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				// The container lease is already live when the isolate writes.
				const first = await subject.sandboxes.run(ctx, bash(workspaceId, "git --version"));
				a.strictEqual(first.tier, "container");
				await subject.sandboxes.run(
					ctx,
					bash(workspaceId, "mkdir -p notes && printf '%s' 'from isolate' > notes/i.txt"),
				);
				const seen = await subject.sandboxes.run(ctx, bash(workspaceId, "git --version && cat notes/i.txt"));
				a.strictEqual(seen.tier, "container");
				a.strictEqual(seen.leaseId, first.leaseId);
				a.strictEqual(seen.exitCode, 0);
				a.ok(seen.stdout.endsWith("from isolate"), `container stdout: ${seen.stdout}`);
			}),
		},
		{
			name: "lets the isolate see the container's write after the container lease is released",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				const before = await head(subject, workspaceId);
				const container = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
				const written = await subject.sandboxes.exec(ctx, container.id, {
					command: "mkdir -p notes && printf '%s' 'from container' > notes/c.txt",
				});
				a.strictEqual(written.exitCode, 0);
				a.strictEqual(await head(subject, workspaceId), before, "the container commits only on release");

				const released = await subject.sandboxes.release(ctx, container.id);
				a.strictEqual(released.endReason, "released");
				a.strictEqual(await head(subject, workspaceId), before + 1);
				const seen = await subject.sandboxes.run(ctx, bash(workspaceId, "cat notes/c.txt"));
				a.partialDeepEqual(seen, { tier: "isolate", exitCode: 0, stdout: "from container" });
			}),
		},
		{
			name: "has no git in the isolate and git in the container",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				const isolate = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				const missing = await subject.sandboxes.exec(ctx, isolate.id, { command: "git --version" });
				a.strictEqual(missing.exitCode, 127);
				a.ok(missing.stderr.includes("not found"), `isolate stderr: ${missing.stderr}`);
				const container = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
				const present = await subject.sandboxes.exec(ctx, container.id, { command: "git --version" });
				a.strictEqual(present.exitCode, 0);
				a.ok(present.stdout.startsWith("git version"), `container stdout: ${present.stdout}`);
			}),
		},
		{
			name: "propagates exit codes",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				for (const tier of ["isolate", "container"] as const) {
					const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier });
					const expectations: [string, number][] = [
						["true", 0],
						["false", 1],
						["exit 3", 3],
						["true && exit 7", 7],
						["false && exit 7", 1],
						["echo hi && false", 1],
					];
					for (const [command, exitCode] of expectations) {
						const result = await subject.sandboxes.exec(ctx, lease.id, { command });
						a.strictEqual(result.exitCode, exitCode, `${tier}: ${command}`);
					}
				}
			}),
		},
		{
			name: "refuses writes under /project from either tier and leaves the source and workspace unchanged, while reads work",
			run: withSubject(async (subject) => {
				const { workspaceId, projectVersion } = await setUp(subject);
				const before = await head(subject, workspaceId);
				for (const tier of ["isolate", "container"] as const) {
					const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier });
					const write = await subject.sandboxes.exec(ctx, lease.id, {
						command: "printf '%s' 'overwritten' > /project/README.md",
					});
					a.ok(write.exitCode !== 0, `${tier}: a write under /project must fail`);
					a.ok(write.stderr.includes("Read-only file system"), `${tier} stderr: ${write.stderr}`);
					const mkdir = await subject.sandboxes.exec(ctx, lease.id, { command: "mkdir -p /project/new" });
					a.ok(mkdir.exitCode !== 0, `${tier}: mkdir under /project must fail`);
					const read = await subject.sandboxes.exec(ctx, lease.id, { command: "cat /project/README.md" });
					a.partialDeepEqual(read, { exitCode: 0, stdout: SANDBOX_FIXTURE.projectReadme });
					await subject.sandboxes.release(ctx, lease.id);
				}
				a.strictEqual(await head(subject, workspaceId), before);
				a.strictEqual(await subject.projectFiles.latestVersion(ctx, SANDBOX_FIXTURE.projectId), projectVersion);
				const source = await subject.projectFiles.read(ctx, SANDBOX_FIXTURE.projectId, projectVersion, "README.md");
				a.strictEqual(decoder.decode(source), SANDBOX_FIXTURE.projectReadme);
				a.strictEqual(await fileText(subject, workspaceId, "/project/README.md"), SANDBOX_FIXTURE.projectReadme);
			}),
		},
		{
			name: "sweeps a lease past its TTL as expired and rejects exec and renew on it",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await setUp(subject);
				const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate", ttlMs: 1000 });
				a.strictEqual(lease.expiresAt, lease.acquiredAt + 1000);
				deps.clock.advance(900);
				const renewed = await subject.sandboxes.renew(ctx, lease.id, 1000);
				a.strictEqual(renewed.expiresAt, deps.clock.now() + 1000);
				deps.clock.advance(900);
				a.deepEqual(await subject.sandboxes.sweep(), [], "a renewed lease is still live");
				deps.clock.advance(200);
				const swept = await subject.sandboxes.sweep();
				a.deepEqual(
					swept.map((ended) => [ended.id, ended.endReason]),
					[[lease.id, "expired"]],
				);
				await a.rejectsWithCode(subject.sandboxes.exec(ctx, lease.id, { command: "true" }), "expired");
				await a.rejectsWithCode(subject.sandboxes.renew(ctx, lease.id, 1000), "expired");
				a.deepEqual(await subject.sandboxes.leases(ctx, { sessionId, live: true }), []);
				a.deepEqual(await subject.sandboxes.sweep(), [], "a swept lease is not swept twice");
			}),
		},
		{
			name: "rejects a second live lease on the same tier with conflict",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				const isolate = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				await a.rejectsWithCode(
					subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" }),
					"conflict",
				);
				await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
				await subject.sandboxes.acquire(ctx, {
					sessionId: SANDBOX_FIXTURE.otherSessionId,
					workspaceId,
					tier: "isolate",
				});
				const reused = await subject.sandboxes.run(ctx, bash(workspaceId, "true"));
				a.strictEqual(reused.leaseId, isolate.id, "run reuses the live lease");
				await subject.sandboxes.release(ctx, isolate.id);
				const next = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				a.ok(next.id !== isolate.id);
			}),
		},
		{
			name: "ends every live lease of a session on releaseSession",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
				const other = await subject.sandboxes.acquire(ctx, {
					sessionId: SANDBOX_FIXTURE.otherSessionId,
					workspaceId,
					tier: "isolate",
				});
				await subject.sandboxes.releaseSession(ctx, sessionId);
				a.deepEqual(await subject.sandboxes.leases(ctx, { sessionId, live: true }), []);
				const ended = await subject.sandboxes.leases(ctx, { sessionId });
				a.deepEqual(
					ended.map((lease) => lease.endReason),
					["session_ended", "session_ended"],
				);
				const stillLive = await subject.sandboxes.leases(ctx, {
					sessionId: SANDBOX_FIXTURE.otherSessionId,
					live: true,
				});
				a.deepEqual(
					stillLive.map((lease) => lease.id),
					[other.id],
				);
			}),
		},
		{
			name: "reports held time per tier",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await setUp(subject);
				await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				deps.clock.advance(1000);
				const container = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
				deps.clock.advance(500);
				await subject.sandboxes.release(ctx, container.id);
				deps.clock.advance(250);
				const usage = await subject.sandboxes.usage(ctx, sessionId);
				const isolate = usage.find((entry) => entry.tier === "isolate");
				const containerUsage = usage.find((entry) => entry.tier === "container");
				a.partialDeepEqual(isolate, { tier: "isolate", leases: 1, heldMs: 1750 });
				a.partialDeepEqual(containerUsage, { tier: "container", leases: 1, heldMs: 500 });
				a.ok((isolate?.busyMs ?? -1) >= 0 && (containerUsage?.busyMs ?? -1) >= 0, "busy time is never negative");
			}),
		},
		{
			name: "reuses the session's lease per tier in run and audits escalation once",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await setUp(subject);
				const first = await subject.sandboxes.run(ctx, bash(workspaceId, "true"));
				const second = await subject.sandboxes.run(ctx, bash(workspaceId, "echo again"));
				a.strictEqual(second.leaseId, first.leaseId);
				const git = await subject.sandboxes.run(ctx, bash(workspaceId, "git --version"));
				a.strictEqual(git.tier, "container");
				const third = await subject.sandboxes.run(ctx, bash(workspaceId, "git --version"));
				a.strictEqual(third.leaseId, git.leaseId);
				a.strictEqual(deps.audit.ofType("sandbox.escalated").length, 1);
				a.partialDeepEqual(deps.audit.ofType("sandbox.escalated")[0], {
					source: "sandbox",
					organisationId: SANDBOX_FIXTURE.organisationId,
					sessionId,
				});
				a.strictEqual(deps.audit.ofType("sandbox.lease.acquired").length, 2);
			}),
		},
		{
			name: "releases idempotently and audits the release once",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await setUp(subject);
				const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
				const first = await subject.sandboxes.release(ctx, lease.id);
				const second = await subject.sandboxes.release(ctx, lease.id);
				a.deepEqual(second, first);
				a.strictEqual(first.endReason, "released");
				const released = deps.audit.ofType("sandbox.lease.released");
				a.strictEqual(released.length, 1);
				a.partialDeepEqual(released[0], {
					source: "sandbox",
					organisationId: SANDBOX_FIXTURE.organisationId,
					sessionId,
					subject: { id: lease.id },
				});
				await a.rejectsWithCode(subject.sandboxes.exec(ctx, lease.id, { command: "true" }), "expired");
			}),
		},
		{
			name: "hides another organisation's leases as not_found",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				await a.rejectsWithCode(subject.sandboxes.exec(otherCtx, lease.id, { command: "true" }), "not_found");
				await a.rejectsWithCode(subject.sandboxes.renew(otherCtx, lease.id, 1000), "not_found");
				await a.rejectsWithCode(subject.sandboxes.release(otherCtx, lease.id), "not_found");
				await a.rejectsWithCode(
					subject.sandboxes.acquire(otherCtx, { sessionId, workspaceId, tier: "container" }),
					"not_found",
				);
				a.deepEqual(await subject.sandboxes.leases(otherCtx, { sessionId }), []);
				a.deepEqual(
					(await subject.sandboxes.leases(ctx, { sessionId, live: true })).map((live) => live.id),
					[lease.id],
				);
			}),
		},
	];
}

export function registerSandboxConformance(
	runner: ConformanceRunner,
	name: string,
	provider: SandboxConformanceProvider,
): void {
	registerCases(
		runner,
		name,
		createSandboxConformance({ assertions: createExpectAssertions(runner.expect), provider }),
	);
}
