/**
 * The Docker container tier against a real Docker daemon. Skipped unless HARBOUR_TEST_DOCKER=1. Needs the sandbox image
 * (images/sandbox, built as harbour-sandbox:dev by default) and the runtime (runsc-kvm by default) registered with the
 * daemon:
 *
 *   docker build -t harbour-sandbox:dev images/sandbox
 *   HARBOUR_TEST_DOCKER=1 pnpm --filter @harbour/selfhosted-sandbox test
 *
 * Optional: HARBOUR_TEST_SANDBOX_IMAGE, HARBOUR_TEST_SANDBOX_RUNTIME (`runc` where gVisor is not installed) and
 * HARBOUR_TEST_DOCKER_SOCKET. Every case labels what it creates with its own `harbour-test-<random>` prefix and removes
 * it afterwards.
 */
import { release } from "node:os";
import type { CallContext, OwnerRef, WorkspaceId } from "@harbour/contracts";
import { createInProcessIsolateBackend } from "@harbour/sandbox/isolate";
import { createTieredSandboxes } from "@harbour/sandbox/tiered";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@harbour/testing/harness";
import { registerSandboxConformance } from "@harbour/testing/sandbox";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces, listAll } from "@harbour/workspace/stored";
import { afterAll, describe, expect, it } from "vitest";
import { createDockerContainerBackend, type DockerContainerBackend } from "../src/container.ts";
import { DockerClient } from "../src/docker.ts";

const enabled = process.env.HARBOUR_TEST_DOCKER === "1";
const image = process.env.HARBOUR_TEST_SANDBOX_IMAGE ?? "harbour-sandbox:dev";
const runtime = process.env.HARBOUR_TEST_SANDBOX_RUNTIME ?? "runsc-kvm";
const socketPath = process.env.HARBOUR_TEST_DOCKER_SOCKET;
const docker = new DockerClient(socketPath === undefined ? {} : { socketPath });

/** Every label prefix a case used, removed again in afterAll in case a case's own cleanup failed. */
const prefixes = new Set<string>();

function newPrefix(): string {
	const prefix = `harbour-test-${crypto.randomUUID().slice(0, 8)}`;
	prefixes.add(prefix);
	return prefix;
}

async function removeLabelled(prefix: string): Promise<void> {
	for (const container of await docker.listContainers([`${prefix}.lease`])) await docker.removeContainer(container.Id);
	for (const volume of await docker.listVolumes([`${prefix}.lease`])) await docker.removeVolume(volume.Name);
}

afterAll(async () => {
	if (!enabled) return;
	for (const prefix of prefixes) await removeLabelled(prefix);
	docker.close();
});

function backendFor(
	workspaces: Parameters<typeof createDockerContainerBackend>[0]["workspaces"],
	prefix: string,
	deps: ConformanceDeps,
	extra: { readonly maxOutputBytes?: number } = {},
): DockerContainerBackend {
	return createDockerContainerBackend({
		workspaces,
		image,
		runtime,
		labelPrefix: prefix,
		clock: deps.clock,
		...(socketPath === undefined ? {} : { socketPath }),
		...extra,
	});
}

registerSandboxConformance(
	{ describe: describe.skipIf(!enabled), expect, it },
	`self-hosted sandboxes, Docker container tier (${runtime})`,
	async (deps, use) => {
		const prefix = newPrefix();
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createStoredWorkspaces({
			store: createMemoryWorkspaceStore(),
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
		});
		const container = backendFor(workspaces, prefix, deps);
		const sandboxes = createTieredSandboxes({
			workspaces,
			isolate: createInProcessIsolateBackend(workspaces),
			container,
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
		});
		try {
			await use({ sandboxes, workspaces, projectFiles });
		} finally {
			await container.close();
			await removeLabelled(prefix);
		}
	},
	{ projectAccess: true },
);

const ORGANISATION = "org-harbour";
const PROJECT = "proj-harbour";
const SESSION = "sess-container";
const ctx: CallContext = contextFor(actors.agent("agent-1", SESSION), ORGANISATION, PROJECT);
const owner: OwnerRef = { kind: "project", organisationId: ORGANISATION, projectId: PROJECT };

describe.skipIf(!enabled)(`Docker container tier (${runtime})`, () => {
	async function setUp(extra: { readonly maxOutputBytes?: number } = {}) {
		const prefix = newPrefix();
		const deps = createDeps();
		deps.tenancy.session({ id: SESSION, organisationId: ORGANISATION, projectId: PROJECT, agentId: "agent-1" });
		const projectFiles = createMemoryProjectFiles({ access: deps.access });
		const workspaces = createStoredWorkspaces({
			store: createMemoryWorkspaceStore(),
			clock: deps.clock,
			audit: deps.audit,
			sources: [projectFiles],
			access: deps.access,
		});
		await projectFiles.write(ctx, PROJECT, [{ op: "put", path: "README.md", content: "project readme" }]);
		const record = await workspaces.create(ctx, {
			owner,
			sessionId: SESSION,
			mounts: [{ path: "/project", source: projectFiles.kind, ref: PROJECT }],
		});
		const backend = backendFor(workspaces, prefix, deps, extra);
		const sandboxes = createTieredSandboxes({
			workspaces,
			isolate: createInProcessIsolateBackend(workspaces),
			container: backend,
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
		});
		const workspaceId: WorkspaceId = record.id;
		const acquire = (tier: "isolate" | "container", ttlMs?: number) =>
			sandboxes.acquire(ctx, { sessionId: SESSION, workspaceId, tier, ...(ttlMs === undefined ? {} : { ttlMs }) });
		const cleanup = async () => {
			await backend.close();
			await removeLabelled(prefix);
		};
		return { prefix, deps, workspaces, backend, sandboxes, workspaceId, acquire, cleanup };
	}

	const containersOf = (prefix: string, leaseId: string) => docker.listContainers([`${prefix}.lease=${leaseId}`]);

	it("shows the isolate's write to the container's next command, and commits the container's write on release", async () => {
		const { sandboxes, workspaces, workspaceId, acquire, cleanup } = await setUp();
		try {
			const isolate = await acquire("isolate");
			const container = await acquire("container");
			expect((await sandboxes.exec(ctx, container.id, { command: "true" })).exitCode).toBe(0);

			await sandboxes.exec(ctx, isolate.id, { command: "mkdir -p notes && printf '%s' 'from isolate' > notes/i.txt" });
			const seen = await sandboxes.exec(ctx, container.id, { command: "cat notes/i.txt" });
			expect(seen).toMatchObject({ exitCode: 0, stdout: "from isolate" });

			const head = (await workspaces.get(ctx, workspaceId)).head;
			const wrote = await sandboxes.exec(ctx, container.id, {
				command: "printf '%s' 'from container' > notes/c.txt && printf '%s' ' and more' >> notes/i.txt",
			});
			expect(wrote.exitCode).toBe(0);
			expect((await workspaces.get(ctx, workspaceId)).head, "the container commits only on release").toBe(head);

			await sandboxes.release(ctx, container.id);
			expect((await workspaces.get(ctx, workspaceId)).head).toBe(head + 1);
			const read = await sandboxes.exec(ctx, isolate.id, { command: "cat notes/c.txt && cat notes/i.txt" });
			expect(read).toMatchObject({ exitCode: 0, stdout: "from containerfrom isolate and more" });
		} finally {
			await cleanup();
		}
	});

	it("keeps the executable bit in both directions", async () => {
		const { sandboxes, workspaces, workspaceId, acquire, cleanup } = await setUp();
		try {
			const base = (await workspaces.get(ctx, workspaceId)).head;
			await workspaces.commit(ctx, workspaceId, {
				baseVersion: base,
				changes: [{ op: "put", path: "bin/tool.sh", content: "#!/bin/sh\necho tool\n", mode: 0o755 }],
			});
			const container = await acquire("container");
			const ran = await sandboxes.exec(ctx, container.id, { command: "./bin/tool.sh && stat -c %a bin/tool.sh" });
			expect(ran).toMatchObject({ exitCode: 0, stdout: "tool\n755\n" });

			const made = await sandboxes.exec(ctx, container.id, {
				command: "printf '#!/bin/sh\\necho made\\n' > made.sh && chmod 755 made.sh && printf 'data' > plain.txt",
			});
			expect(made.exitCode).toBe(0);
			await sandboxes.release(ctx, container.id);
			const modes = new Map(
				(await listAll(workspaces, ctx, workspaceId))
					.filter((entry) => entry.kind === "file")
					.map((entry) => [entry.path, entry.mode]),
			);
			expect(modes.get("made.sh")).toBe(0o755);
			expect(modes.get("bin/tool.sh")).toBe(0o755);
			expect(modes.get("plain.txt") ?? 0o644).toBe(0o644);
		} finally {
			await cleanup();
		}
	});

	it("passes cwd, env and stdin, and keeps background jobs from holding a command open", async () => {
		const { sandboxes, acquire, cleanup } = await setUp();
		try {
			const container = await acquire("container");
			await sandboxes.exec(ctx, container.id, { command: "mkdir -p sub/dir" });
			const result = await sandboxes.exec(ctx, container.id, {
				command: 'pwd && printf "%s\\n" "$GREETING" && cat',
				cwd: "sub/dir",
				env: { GREETING: "hello there" },
				stdin: "from stdin\n",
			});
			expect(result).toMatchObject({ exitCode: 0, stdout: "/workspace/sub/dir\nhello there\nfrom stdin\n" });
			const argv = await sandboxes.exec(ctx, container.id, { command: ["printf", "%s|", "a b", "$HOME"] });
			expect(argv).toMatchObject({ exitCode: 0, stdout: "a b|$HOME|" });

			const started = Date.now();
			const background = await sandboxes.exec(ctx, container.id, {
				command: "(sleep 60 &) ; echo started",
				timeoutMs: 30_000,
			});
			expect(background).toMatchObject({ exitCode: 0, stdout: "started\n" });
			expect(Date.now() - started).toBeLessThan(20_000);
		} finally {
			await cleanup();
		}
	});

	it("kills a command at its timeout and returns promptly", async () => {
		const { sandboxes, acquire, cleanup } = await setUp();
		try {
			const container = await acquire("container");
			await sandboxes.exec(ctx, container.id, { command: "true" });
			const started = Date.now();
			const result = await sandboxes.exec(ctx, container.id, { command: "sleep 60", timeoutMs: 1000 });
			const elapsed = Date.now() - started;
			expect(result.exitCode).toBe(124);
			expect(result.stderr).toContain("timed out after 1000 ms");
			expect(elapsed).toBeLessThan(15_000);
			// The lease is still usable afterwards.
			expect((await sandboxes.exec(ctx, container.id, { command: "echo ok" })).stdout).toBe("ok\n");
		} finally {
			await cleanup();
		}
	});

	it("truncates output past maxOutputBytes", async () => {
		const { sandboxes, acquire, cleanup } = await setUp({ maxOutputBytes: 1024 });
		try {
			const container = await acquire("container");
			const result = await sandboxes.exec(ctx, container.id, { command: "head -c 5000 /dev/zero | tr '\\0' x" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("x".repeat(1024));
			expect(result.truncated).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("reads /project and refuses writes to it", async () => {
		const { sandboxes, acquire, cleanup } = await setUp();
		try {
			const container = await acquire("container");
			const read = await sandboxes.exec(ctx, container.id, { command: "cat /project/README.md" });
			expect(read).toMatchObject({ exitCode: 0, stdout: "project readme" });
			const write = await sandboxes.exec(ctx, container.id, { command: "printf x > /project/README.md" });
			expect(write.exitCode).not.toBe(0);
			expect(write.stderr).toContain("Read-only file system");
		} finally {
			await cleanup();
		}
	});

	it("removes the container and its mount volumes when the lease ends", async () => {
		const { prefix, sandboxes, acquire, cleanup } = await setUp();
		try {
			const container = await acquire("container");
			await sandboxes.exec(ctx, container.id, { command: "true" });
			const running = await containersOf(prefix, container.id);
			expect(running.map((summary) => summary.Labels[`${prefix}.role`])).toEqual(["sandbox"]);
			expect(running[0]?.Labels).toMatchObject({
				[`${prefix}.session`]: SESSION,
				[`${prefix}.expires-at`]: String(container.expiresAt),
			});
			expect((await docker.listVolumes([`${prefix}.lease=${container.id}`])).length).toBe(1);

			await sandboxes.release(ctx, container.id);
			expect(await containersOf(prefix, container.id)).toEqual([]);
			expect(await docker.listVolumes([`${prefix}.lease=${container.id}`])).toEqual([]);
			await expect(sandboxes.exec(ctx, container.id, { command: "true" })).rejects.toMatchObject({
				code: "expired",
			});
		} finally {
			await cleanup();
		}
	});

	it("reaps a container whose expiry passed once no backend serves its lease", async () => {
		const { prefix, deps, workspaces, backend, sandboxes, acquire, cleanup } = await setUp();
		const restarted = backendFor(workspaces, prefix, deps);
		try {
			const container = await acquire("container", 60_000);
			await sandboxes.exec(ctx, container.id, { command: "true" });
			expect(await backend.reapExpired(container.expiresAt + 1), "the serving backend keeps its live lease").toBe(0);
			// A second backend over the same labels, as after a host restart.
			expect(await restarted.reapExpired(container.expiresAt - 1), "not expired yet").toBe(0);
			expect(await containersOf(prefix, container.id)).toHaveLength(1);
			expect(await restarted.reapExpired(container.expiresAt)).toBe(1);
			expect(await containersOf(prefix, container.id)).toEqual([]);
			expect(await docker.listVolumes([`${prefix}.lease=${container.id}`])).toEqual([]);

			// The lease's next command says its container is gone, and the one after starts a new container.
			await expect(sandboxes.exec(ctx, container.id, { command: "true" })).rejects.toMatchObject({
				code: "unavailable",
			});
			expect((await sandboxes.exec(ctx, container.id, { command: "echo again" })).stdout).toBe("again\n");
		} finally {
			await restarted.close();
			await cleanup();
		}
	});

	it("has git, and runs on the configured runtime's kernel", async () => {
		const { sandboxes, acquire, cleanup } = await setUp();
		try {
			const container = await acquire("container");
			const git = await sandboxes.exec(ctx, container.id, { command: "git --version" });
			expect(git.exitCode).toBe(0);
			expect(git.stdout).toMatch(/^git version /);
			const uname = await sandboxes.exec(ctx, container.id, { command: "uname -a" });
			expect(uname.exitCode).toBe(0);
			// Recorded for the measurements: gVisor reports its own kernel version, not the host's.
			console.info(`uname -a on ${runtime}: ${uname.stdout.trim()} (host kernel ${release()})`);
			if (runtime.startsWith("runsc")) expect(uname.stdout).not.toContain(release());
		} finally {
			await cleanup();
		}
	});
});
