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
	assertAccessDenied,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
	WORKER,
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
	otherProjectId: "proj-elsewhere",
	sessionId: "sess-sandbox",
	/** A child session of `sessionId`, so its agent may act on it as a supervisor. */
	otherSessionId: "sess-other",
	projectReadme: "project readme v1",
} as const;

const ctx: CallContext = contextFor(
	actors.agent("agent-1", SANDBOX_FIXTURE.sessionId),
	SANDBOX_FIXTURE.organisationId,
	SANDBOX_FIXTURE.projectId,
);
const otherCtx: CallContext = contextFor(actors.human("user-mallory"), SANDBOX_FIXTURE.otherOrganisationId);
/** An operator on the project. */
const operatorCtx: CallContext = contextFor(
	actors.human("user-alice"),
	SANDBOX_FIXTURE.organisationId,
	SANDBOX_FIXTURE.projectId,
);
/** An operator in the same organisation, on another project only. */
const outsiderCtx: CallContext = contextFor(
	actors.human("user-oscar"),
	SANDBOX_FIXTURE.organisationId,
	SANDBOX_FIXTURE.otherProjectId,
);
/** An agent whose session belongs to another project. */
const strayAgentCtx: CallContext = contextFor(
	actors.agent("agent-3", "sess-elsewhere"),
	SANDBOX_FIXTURE.organisationId,
);
/** An agent in the project whose session the case closes. */
const closingAgentCtx: CallContext = contextFor(
	actors.agent("agent-4", "sess-closing"),
	SANDBOX_FIXTURE.organisationId,
);
/** The context the session-end hook gives a teardown. */
const teardownCtx: CallContext = contextFor(actors.system("session-end"), SANDBOX_FIXTURE.organisationId);
const owner: OwnerRef = {
	kind: "project",
	organisationId: SANDBOX_FIXTURE.organisationId,
	projectId: SANDBOX_FIXTURE.projectId,
};
const sessionId: SessionId = SANDBOX_FIXTURE.sessionId;

const decoder = new TextDecoder();

/** Records the roles and agent sessions the cases use, whether or not the project-access cases run. */
function seedTenancy(deps: ConformanceDeps): void {
	const { organisationId, projectId, otherProjectId } = SANDBOX_FIXTURE;
	deps.tenancy.bind(operatorCtx.actor, organisationId, "operator", projectId);
	deps.tenancy.bind(outsiderCtx.actor, organisationId, "operator", otherProjectId);
	deps.tenancy.session({ id: sessionId, organisationId, projectId, agentId: "agent-1" });
	deps.tenancy.session({
		id: SANDBOX_FIXTURE.otherSessionId,
		organisationId,
		projectId,
		agentId: "agent-2",
		parentSessionId: sessionId,
	});
	deps.tenancy.session({ id: "sess-elsewhere", organisationId, projectId: otherProjectId, agentId: "agent-3" });
	deps.tenancy.session({ id: "sess-closing", organisationId, projectId, agentId: "agent-4" });
}

export function createSandboxConformance(options: {
	assertions: ConformanceAssertions;
	provider: SandboxConformanceProvider;
	projectAccess?: boolean;
}): readonly ConformanceCase[] {
	const a = options.assertions;
	const withSubject = (run: (subject: SandboxSubject, deps: ConformanceDeps) => Promise<void>) => async () => {
		const deps = createDeps();
		seedTenancy(deps);
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

	/** Runs the session-end teardown for `sessionId` twice, checking what the first run ended and that the second is silent. */
	async function teardownCase(subject: SandboxSubject, deps: ConformanceDeps, reason: "session_ended" | "aborted") {
		const { workspaceId } = await setUp(subject);
		const isolate = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
		const container = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "container" });
		const other = await subject.sandboxes.acquire(ctx, {
			sessionId: SANDBOX_FIXTURE.otherSessionId,
			workspaceId,
			tier: "isolate",
		});
		await subject.sandboxes.exec(ctx, container.id, { command: "printf '%s' 'held' > held.txt" });

		await subject.sandboxes.releaseSession(teardownCtx, sessionId, reason);
		const ended = await subject.sandboxes.leases(ctx, { sessionId });
		a.deepEqual(
			ended.map((lease) => [lease.id, lease.endReason, lease.endedAt !== undefined]),
			[
				[isolate.id, reason, true],
				[container.id, reason, true],
			],
		);
		for (const lease of [isolate, container]) {
			await a.rejectsWithCode(subject.sandboxes.exec(ctx, lease.id, { command: "true" }), "expired");
			await a.rejectsWithCode(subject.sandboxes.renew(ctx, lease.id, 1000), "expired");
		}
		const released = deps.audit.ofType("sandbox.lease.released");
		for (const lease of [isolate, container]) {
			const events = released.filter((event) => event.subject?.id === lease.id);
			a.strictEqual(events.length, 1, `the ${lease.tier} lease's release is audited once`);
			a.partialDeepEqual(events[0], { source: "sandbox", sessionId, data: { reason } });
		}
		a.strictEqual(
			released.filter((event) => event.subject?.id === other.id).length,
			0,
			"another session's lease is not released",
		);
		a.deepEqual(
			(await subject.sandboxes.leases(ctx, { sessionId: SANDBOX_FIXTURE.otherSessionId, live: true })).map(
				(lease) => lease.id,
			),
			[other.id],
		);

		const audited = deps.audit.events.length;
		const before = await subject.sandboxes.leases(ctx, { sessionId });
		await subject.sandboxes.releaseSession(teardownCtx, sessionId, reason);
		a.strictEqual(deps.audit.events.length, audited, "a second teardown audits nothing");
		a.deepEqual(await subject.sandboxes.leases(ctx, { sessionId }), before, "a second teardown changes nothing");
		return { workspaceId };
	}

	const cases: ConformanceCase[] = [
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
				a.deepEqual(await subject.sandboxes.sweep(WORKER), [], "a renewed lease is still live");
				deps.clock.advance(200);
				const swept = await subject.sandboxes.sweep(WORKER);
				a.deepEqual(
					swept.map((ended) => [ended.id, ended.endReason]),
					[[lease.id, "expired"]],
				);
				await a.rejectsWithCode(subject.sandboxes.exec(ctx, lease.id, { command: "true" }), "expired");
				await a.rejectsWithCode(subject.sandboxes.renew(ctx, lease.id, 1000), "expired");
				a.deepEqual(await subject.sandboxes.leases(ctx, { sessionId, live: true }), []);
				a.deepEqual(await subject.sandboxes.sweep(WORKER), [], "a swept lease is not swept twice");
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
		{
			name: "session end: the teardown (session_ended) ends the session's leases once, and a second run changes nothing",
			run: withSubject(async (subject, deps) => {
				await teardownCase(subject, deps, "session_ended");
			}),
		},
		{
			name: "session end: the teardown (aborted) ends the session's leases once and leaves the session usable",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await teardownCase(subject, deps, "aborted");
				const next = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				a.strictEqual(next.endedAt, undefined);
				const ran = await subject.sandboxes.run(ctx, bash(workspaceId, "git --version"));
				a.strictEqual(ran.exitCode, 0);
				a.deepEqual(
					(await subject.sandboxes.leases(ctx, { sessionId, live: true })).map((lease) => lease.tier),
					["isolate", "container"],
				);
			}),
		},
	];
	if (options.projectAccess !== true) return cases;

	/**
	 * Refuses `caller` every call on the session's records, each through `assertAccessDenied` with its operation. Calls
	 * start one at a time, so each refusal's audit is counted on its own.
	 */
	async function assertSessionCallsDenied(
		subject: SandboxSubject,
		deps: ConformanceDeps,
		target: { readonly workspaceId: WorkspaceId; readonly leaseId: string },
		caller: CallContext,
	): Promise<void> {
		const { sandboxes } = subject;
		const { workspaceId, leaseId } = target;
		const calls: [string, () => Promise<unknown>][] = [
			["sandbox.acquire", () => sandboxes.acquire(caller, { sessionId, workspaceId, tier: "container" })],
			["sandbox.run", () => sandboxes.run(caller, bash(workspaceId, "true"))],
			["sandbox.renew", () => sandboxes.renew(caller, leaseId, 60_000)],
			["sandbox.exec", () => sandboxes.exec(caller, leaseId, { command: "printf x > stray.txt" })],
			["sandbox.release", () => sandboxes.release(caller, leaseId)],
			["sandbox.leases", () => sandboxes.leases(caller, { sessionId })],
			["sandbox.usage", () => sandboxes.usage(caller, sessionId)],
			["sandbox.releaseSession", () => sandboxes.releaseSession(caller, sessionId)],
		];
		for (const [operation, call] of calls) {
			await assertAccessDenied(a, deps, call(), { operation, message: `${operation} on this project's session` });
		}
	}

	/** What the denial cases check stayed the same: the session's leases, the workspace head and the audit trail. */
	async function snapshot(subject: SandboxSubject, deps: ConformanceDeps, workspaceId: WorkspaceId) {
		return {
			leases: await subject.sandboxes.leases(ctx, { sessionId }),
			head: await head(subject, workspaceId),
			sandboxEvents: deps.audit.events.filter((event) => event.source === "sandbox").length,
		};
	}

	cases.push(
		{
			name: "project access: refuses an operator outside the project on every session call, and changes nothing",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await setUp(subject);
				const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				const before = await snapshot(subject, deps, workspaceId);
				await assertSessionCallsDenied(subject, deps, { workspaceId, leaseId: lease.id }, outsiderCtx);
				a.deepEqual(await snapshot(subject, deps, workspaceId), before);
			}),
		},
		{
			name: "project access: refuses an agent whose session belongs to another project, and changes nothing",
			run: withSubject(async (subject, deps) => {
				const { workspaceId } = await setUp(subject);
				const lease = await subject.sandboxes.acquire(ctx, { sessionId, workspaceId, tier: "isolate" });
				const before = await snapshot(subject, deps, workspaceId);
				await assertSessionCallsDenied(subject, deps, { workspaceId, leaseId: lease.id }, strayAgentCtx);
				await assertAccessDenied(
					a,
					deps,
					subject.sandboxes.acquire(strayAgentCtx, { sessionId: "sess-elsewhere", workspaceId, tier: "isolate" }),
					{ operation: "sandbox.acquire", message: "a lease for its own session on this project's workspace" },
				);
				await assertAccessDenied(
					a,
					deps,
					subject.sandboxes.run(strayAgentCtx, { ...bash(workspaceId, "true"), sessionId: "sess-elsewhere" }),
					{ operation: "sandbox.run", message: "a run for its own session on this project's workspace" },
				);
				a.deepEqual(await subject.sandboxes.leases(teardownCtx, { sessionId: "sess-elsewhere" }), []);
				a.deepEqual(await snapshot(subject, deps, workspaceId), before);
			}),
		},
		{
			name: "project access: refuses an agent whose session was closed",
			run: withSubject(async (subject, deps) => {
				await setUp(subject);
				const shared = await subject.workspaces.create(ctx, { owner });
				const lease = await subject.sandboxes.acquire(closingAgentCtx, {
					sessionId: "sess-closing",
					workspaceId: shared.id,
					tier: "isolate",
				});
				a.strictEqual((await subject.sandboxes.exec(closingAgentCtx, lease.id, { command: "true" })).exitCode, 0);
				deps.tenancy.close("sess-closing");
				await assertAccessDenied(a, deps, subject.sandboxes.exec(closingAgentCtx, lease.id, { command: "true" }), {
					operation: "sandbox.exec",
				});
				await assertAccessDenied(a, deps, subject.sandboxes.renew(closingAgentCtx, lease.id, 60_000), {
					operation: "sandbox.renew",
				});
				await assertAccessDenied(
					a,
					deps,
					subject.sandboxes.acquire(closingAgentCtx, {
						sessionId: "sess-closing",
						workspaceId: shared.id,
						tier: "container",
					}),
					{ operation: "sandbox.acquire" },
				);
				await assertAccessDenied(
					a,
					deps,
					subject.sandboxes.run(closingAgentCtx, {
						...bash(shared.id, "true"),
						sessionId: "sess-closing",
					}),
					{ operation: "sandbox.run" },
				);
				// The session-end teardown still ends what the closed session holds.
				await subject.sandboxes.releaseSession(teardownCtx, "sess-closing", "session_ended");
				a.deepEqual(await subject.sandboxes.leases(teardownCtx, { sessionId: "sess-closing", live: true }), []);
			}),
		},
		{
			name: "project access: lets an operator on the project and an agent in its own session work",
			run: withSubject(async (subject) => {
				const { workspaceId } = await setUp(subject);
				const ran = await subject.sandboxes.run(ctx, bash(workspaceId, "printf '%s' 'agent' > a.txt"));
				a.strictEqual(ran.exitCode, 0);
				const lease = await subject.sandboxes.acquire(operatorCtx, { sessionId, workspaceId, tier: "container" });
				a.strictEqual((await subject.sandboxes.exec(operatorCtx, lease.id, { command: "cat a.txt" })).stdout, "agent");
				await subject.sandboxes.renew(operatorCtx, lease.id, 60_000);
				a.strictEqual((await subject.sandboxes.leases(operatorCtx, { sessionId, live: true })).length, 2);
				a.strictEqual((await subject.sandboxes.usage(operatorCtx, sessionId)).length, 2);
				await subject.sandboxes.release(operatorCtx, lease.id);
				await subject.sandboxes.releaseSession(operatorCtx, sessionId);
				a.deepEqual(await subject.sandboxes.leases(ctx, { sessionId, live: true }), []);
			}),
		},
	);
	return cases;
}

export function registerSandboxConformance(
	runner: ConformanceRunner,
	name: string,
	provider: SandboxConformanceProvider,
	options?: ConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createSandboxConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
		}),
	);
}
