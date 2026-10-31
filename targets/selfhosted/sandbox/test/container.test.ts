/**
 * The Docker container tier against a real Docker daemon. Skipped unless KANTEL_TEST_DOCKER=1. Needs the sandbox image
 * (images/sandbox, built as harbour-sandbox:dev by default) and the runtime (runsc-kvm by default) registered with the
 * daemon:
 *
 *   docker build -t harbour-sandbox:dev images/sandbox
 *   KANTEL_TEST_DOCKER=1 pnpm --filter @kantel/selfhosted-sandbox test
 *
 * Optional: KANTEL_TEST_SANDBOX_IMAGE, KANTEL_TEST_SANDBOX_RUNTIME (`runc` where gVisor is not installed) and
 * KANTEL_TEST_DOCKER_SOCKET. Every case labels what it creates with its own `<base>-<random>` prefix and removes it
 * afterwards; the base is KANTEL_TEST_LABEL_PREFIX (default `harbour-test`), which CI sets per run so it can remove
 * whatever a cancelled run left behind.
 */
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { release } from "node:os";
import type { CallContext, OwnerRef, WorkspaceId } from "@kantel/contracts";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import { createTieredSandboxes } from "@kantel/sandbox/tiered";
import { actors, type ConformanceDeps, contextFor, createDeps } from "@kantel/testing/harness";
import { registerSandboxConformance } from "@kantel/testing/sandbox";
import { createMemoryProjectFiles } from "@kantel/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces, listAll } from "@kantel/workspace/stored";
import { afterAll, describe, expect, it } from "vitest";
import {
	createDockerContainerBackend,
	type DockerContainerBackend,
	type DockerContainerBackendOptions,
	type ProxyCredentials,
} from "../src/container.ts";
import { DockerClient } from "../src/docker.ts";

const enabled = process.env.KANTEL_TEST_DOCKER === "1";
const image = process.env.KANTEL_TEST_SANDBOX_IMAGE ?? "harbour-sandbox:dev";
const runtime = process.env.KANTEL_TEST_SANDBOX_RUNTIME ?? "runsc-kvm";
const socketPath = process.env.KANTEL_TEST_DOCKER_SOCKET;
const labelBase = process.env.KANTEL_TEST_LABEL_PREFIX || "harbour-test";
const docker = new DockerClient(socketPath === undefined ? {} : { socketPath });

/** Every label prefix a case used, removed again in afterAll in case a case's own cleanup failed. */
const prefixes = new Set<string>();

function newPrefix(): string {
	const prefix = `${labelBase}-${crypto.randomUUID().slice(0, 8)}`;
	prefixes.add(prefix);
	return prefix;
}

async function removeLabelled(prefix: string): Promise<void> {
	for (const container of await docker.listContainers([`${prefix}.lease`])) await docker.removeContainer(container.Id);
	for (const network of await docker.listNetworks([`${prefix}.lease`])) {
		for (const member of Object.keys(network.Containers ?? {})) await docker.disconnectNetwork(network.Id, member);
		await docker.removeNetwork(network.Id);
	}
	for (const volume of await docker.listVolumes([`${prefix}.lease`])) await docker.removeVolume(volume.Name);
}

type Extra = Pick<DockerContainerBackendOptions, "maxOutputBytes" | "network" | "proxyCredentials">;

afterAll(async () => {
	if (!enabled) return;
	for (const prefix of prefixes) await removeLabelled(prefix);
	docker.close();
});

function backendFor(
	workspaces: Parameters<typeof createDockerContainerBackend>[0]["workspaces"],
	prefix: string,
	deps: ConformanceDeps,
	extra: Extra = {},
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

async function setUp(extra: Extra | ((prefix: string) => Extra) = {}) {
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
	const backend = backendFor(workspaces, prefix, deps, typeof extra === "function" ? extra(prefix) : extra);
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

describe.skipIf(!enabled)(`Docker container tier (${runtime})`, () => {
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

	it("never imports the working copy's Python modules during maintenance", async () => {
		const { sandboxes, workspaces, workspaceId, acquire, cleanup } = await setUp();
		try {
			const isolate = await acquire("isolate");
			const container = await acquire("container");
			// Imported by any maintenance script that put the working directory on sys.path: it leaves /tmp/pwned and makes
			// the script fail.
			const hostile = 'import os\nopen("/tmp/pwned", "w").write("pwned")\nraise SystemExit(3)\n';
			const planted = await sandboxes.exec(ctx, container.id, {
				command:
					'for name in hashlib json os stat tarfile io shutil; do printf "%s" "$HOSTILE" > "$name.py"; done && echo planted',
				env: { HOSTILE: hostile },
			});
			expect(planted).toMatchObject({ exitCode: 0, stdout: "planted\n" });

			// A write from the head, so the next command's re-base runs the scan and the apply script too.
			await sandboxes.exec(ctx, isolate.id, { command: "printf '%s' 'from isolate' > from-isolate.txt" });
			const next = await sandboxes.exec(ctx, container.id, {
				command: "cat from-isolate.txt && if [ -e /tmp/pwned ]; then echo ' pwned'; else echo ' clean'; fi",
			});
			expect(next).toMatchObject({ exitCode: 0, stdout: "from isolate clean\n" });

			await sandboxes.release(ctx, container.id);
			const files = (await listAll(workspaces, ctx, workspaceId)).map((entry) => entry.path);
			expect(files).toEqual(expect.arrayContaining(["hashlib.py", "json.py", "from-isolate.txt"]));
		} finally {
			await cleanup();
		}
	});

	it("writes the head's files in as the sandbox user, with their modes", async () => {
		const { sandboxes, workspaces, workspaceId, acquire, cleanup } = await setUp();
		try {
			const base = (await workspaces.get(ctx, workspaceId)).head;
			await workspaces.commit(ctx, workspaceId, {
				baseVersion: base,
				changes: [{ op: "put", path: "secret/deep/key.txt", content: "key", mode: 0o600 }],
			});
			const container = await acquire("container");
			const listed = await sandboxes.exec(ctx, container.id, {
				command: "stat -c '%u:%g %a %n' secret secret/deep secret/deep/key.txt && cat secret/deep/key.txt",
			});
			expect(listed).toMatchObject({
				exitCode: 0,
				stdout: "1000:1000 755 secret\n1000:1000 755 secret/deep\n1000:1000 600 secret/deep/key.txt\nkey",
			});
			await sandboxes.release(ctx, container.id);
			expect((await workspaces.get(ctx, workspaceId)).head, "nothing changed in the container").toBe(base + 1);
		} finally {
			await cleanup();
		}
	});

	it("skips what the sandbox user cannot read, without failing or deleting it", async () => {
		const { sandboxes, workspaces, workspaceId, acquire, cleanup } = await setUp();
		try {
			const base = (await workspaces.get(ctx, workspaceId)).head;
			await workspaces.commit(ctx, workspaceId, {
				baseVersion: base,
				changes: [{ op: "put", path: "kept/a.txt", content: "kept" }],
			});
			const container = await acquire("container");
			const locked = await sandboxes.exec(ctx, container.id, {
				command: "printf x > locked.txt && chmod 000 locked.txt && chmod 000 kept && echo locked",
			});
			expect(locked).toMatchObject({ exitCode: 0, stdout: "locked\n" });
			expect((await sandboxes.exec(ctx, container.id, { command: "echo ok" })).stdout).toBe("ok\n");

			await sandboxes.release(ctx, container.id);
			const files = (await listAll(workspaces, ctx, workspaceId))
				.filter((entry) => entry.kind === "file")
				.map((entry) => entry.path);
			expect(files, "an unreadable directory's files are not deleted").toContain("kept/a.txt");
			expect(files, "an unreadable file is not collected").not.toContain("locked.txt");
			expect((await workspaces.get(ctx, workspaceId)).head).toBe(base + 1);
		} finally {
			await cleanup();
		}
	});

	it("kills the sandbox user's background jobs before the final snapshot", async () => {
		const { backend, sandboxes, workspaces, workspaceId, acquire, cleanup } = await setUp();
		try {
			const container = await acquire("container");
			const started = await sandboxes.exec(ctx, container.id, {
				command: "(sleep 1; echo late > late.txt) & echo started",
			});
			expect(started).toMatchObject({ exitCode: 0, stdout: "started\n" });
			const record = await workspaces.get(ctx, workspaceId);
			// The final snapshot, taken directly, then a wait past the job's write: a job that survived the snapshot would
			// have written late.txt by the time the release takes its own.
			const first = await backend.pending({ ctx, lease: container, record }, { final: true });
			expect(first.changes.map((change) => change.path)).not.toContain("late.txt");
			await new Promise((resolve) => setTimeout(resolve, 2000));

			await sandboxes.release(ctx, container.id);
			const files = (await listAll(workspaces, ctx, workspaceId)).map((entry) => entry.path);
			expect(files).not.toContain("late.txt");
			expect((await workspaces.get(ctx, workspaceId)).head, "nothing to commit").toBe(record.head);
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

/**
 * A stand-in for the vault proxy, run from the sandbox image: answers every request with the Proxy-Authorization header
 * it carried, so a case can see which credentials a sandbox's requests reach the proxy with.
 */
const FAKE_PROXY = [
	"import http.server, json, sys",
	"class Handler(http.server.BaseHTTPRequestHandler):",
	"    def do_GET(self):",
	"        body = json.dumps({'auth': self.headers.get('Proxy-Authorization'), 'path': self.path}).encode()",
	"        self.send_response(200)",
	"        self.send_header('content-type', 'application/json')",
	"        self.send_header('content-length', str(len(body)))",
	"        self.end_headers()",
	"        self.wfile.write(body)",
	"    def log_message(self, *args):",
	"        pass",
	"http.server.ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1])), Handler).serve_forever()",
].join("\n");

/**
 * A GET through the sandbox's HTTP_PROXY, printing the body. Python's urllib, not curl: curl answers every `.localhost`
 * name with the loopback address itself, without reading /etc/hosts, and these cases' proxy has such a name.
 */
function proxied(url: string): string {
	return `python3 -c 'import sys, urllib.request; sys.stdout.write(urllib.request.urlopen("${url}", timeout=10).read().decode())'`;
}

/** Proxy credentials that record what they issue and revoke. */
function recordingCredentials() {
	const issued = new Map<string, { token: string; actor: CallContext["actor"]; sessionId: string }>();
	const revoked: string[] = [];
	/** `issue:<lease>` and `revoke:<lease>`, in order. */
	const events: string[] = [];
	const credentials: ProxyCredentials = {
		async issue({ ctx: call, lease }) {
			const token = `tok-${crypto.randomUUID()}`;
			issued.set(lease.id, { token, actor: call.actor, sessionId: lease.sessionId });
			events.push(`issue:${lease.id}`);
			return token;
		},
		async revoke(leaseId) {
			revoked.push(leaseId);
			events.push(`revoke:${leaseId}`);
		},
	};
	return { credentials, issued, revoked, events };
}

describe("Docker container tier options", () => {
	const workspaces = {} as DockerContainerBackendOptions["workspaces"];
	const make = (extra: Extra) => () => createDockerContainerBackend({ workspaces, image, ...extra });

	it("refuses per-lease networks without a proxy host name, and pool or proxy options on a shared network", () => {
		const perLease = { name: "sbx", isolation: "per-lease" as const };
		expect(make({ network: { ...perLease, proxyUrl: "http://10.0.0.2:3128" } })).toThrow(/host name/);
		expect(make({ network: { name: "sbx", proxyUrl: "http://vault:3128", subnetPool: "10.1.0.0/16" } })).toThrow(
			/per-lease/,
		);
		for (const subnetPool of ["10.1.0.0/29", "10.1.0.1/16", "300.1.0.0/16", "10.1.0.0"]) {
			expect(make({ network: { ...perLease, proxyUrl: "http://vault:3128", subnetPool } })).toThrow(/subnetPool/);
		}
		expect(make({ network: { ...perLease, proxyUrl: "http://vault:3128", subnetPool: "10.1.0.0/16" } })).not.toThrow();
	});

	it("refuses proxy credentials without a network to send them to", () => {
		expect(make({ proxyCredentials: recordingCredentials().credentials })).toThrow(/needs a network/);
	});
});

describe.skipIf(!enabled)(`Docker container tier, per-lease networks (${runtime})`, () => {
	/** The pool each case's lease networks come from: well away from the host's own networks. */
	const SUBNET_POOL = "10.231.0.0/16";

	/**
	 * A stack with a fake proxy: a container from the sandbox image (on runc; it plays the vault, not a sandbox) and, on
	 * the host, the CA it serves at `/ca.crt`. The backend fetches the CA from the proxy URL, which names the proxy by a
	 * `.localhost` host name: that reaches the host's CA server, while each sandbox resolves it to the proxy's address
	 * on its own network. Skipped where the host does not resolve `.localhost` names.
	 */
	async function withProxy(
		skip: () => void,
		run: (stack: Awaited<ReturnType<typeof stackFor>>) => Promise<void>,
	): Promise<void> {
		try {
			await lookup("harbour-sandbox-test.localhost");
		} catch {
			skip();
			return;
		}
		const ca = createServer((_request, response) => response.end("not a real CA\n"));
		await new Promise<void>((resolve) => ca.listen(0, "::", resolve));
		const stack = await stackFor((ca.address() as AddressInfo).port);
		try {
			await run(stack);
		} finally {
			await stack.cleanup();
			await new Promise((resolve) => ca.close(resolve));
		}
	}

	async function stackFor(port: number) {
		const recorded = recordingCredentials();
		let proxyName = "";
		let options: Extra = {};
		const set = await setUp((prefix) => {
			proxyName = `${prefix}-proxy`;
			options = {
				network: {
					name: `${prefix}-net`,
					proxyUrl: `http://${proxyName}.localhost:${port}`,
					isolation: "per-lease",
					proxyContainer: proxyName,
					subnetPool: SUBNET_POOL,
				},
				proxyCredentials: recorded.credentials,
			};
			return options;
		});
		const proxyId = await docker.createContainer(
			{
				Image: image,
				User: "1000:1000",
				Entrypoint: ["python3", "-c", FAKE_PROXY, String(port)],
				Labels: { [`${set.prefix}.lease`]: "proxy" },
				HostConfig: { Runtime: "runc" },
			},
			proxyName,
		);
		await docker.startContainer(proxyId);
		const networksOf = (leaseId: string) => docker.listNetworks([`${set.prefix}.lease=${leaseId}`]);
		return { ...set, ...recorded, proxyName, networksOf, options };
	}

	const SESSION_2 = "sess-container-2";
	const ctx2: CallContext = contextFor(actors.agent("agent-2", SESSION_2), ORGANISATION, PROJECT);

	it("gives each lease a network with only the proxy on it, and its own token on every proxied request", async (t) => {
		await withProxy(t.skip, async ({ deps, workspaces, sandboxes, acquire, issued, proxyName, networksOf }) => {
			deps.tenancy.session({ id: SESSION_2, organisationId: ORGANISATION, projectId: PROJECT, agentId: "agent-2" });
			const other = await workspaces.create(ctx2, { owner, sessionId: SESSION_2, mounts: [] });
			const a = await acquire("container");
			const b = await sandboxes.acquire(ctx2, { sessionId: SESSION_2, workspaceId: other.id, tier: "container" });

			for (const [lease, call] of [
				[a, ctx],
				[b, ctx2],
			] as const) {
				const asked = await sandboxes.exec(call, lease.id, { command: proxied("http://example.test/hello") });
				expect(asked.exitCode).toBe(0);
				const seen = JSON.parse(asked.stdout) as { auth: string | null; path: string };
				const token = issued.get(lease.id)?.token;
				expect(seen.auth).toBe(`Basic ${btoa(`sbx:${token}`)}`);
				expect(seen.path).toBe("http://example.test/hello");
				expect(issued.get(lease.id)).toMatchObject({ sessionId: lease.sessionId, actor: call.actor });
			}
			// The token is in the proxy URL only, and differs per lease.
			expect(issued.get(a.id)?.token).not.toBe(issued.get(b.id)?.token);

			const [networkA] = await networksOf(a.id);
			const [networkB] = await networksOf(b.id);
			expect(networkA?.Id).toBeDefined();
			expect(networkB?.Id).toBeDefined();
			expect(networkA?.Id).not.toBe(networkB?.Id);
			const membersA = Object.values((await docker.inspectNetwork(networkA!.Id)).Containers ?? {});
			// The proxy and the lease's own container, nothing else.
			expect(membersA).toHaveLength(2);
			expect(membersA.map((member) => member.Name)).toContain(proxyName);
			const addressA = membersA.find((member) => member.Name !== proxyName)?.IPv4Address.split("/")[0];
			expect(addressA?.startsWith("10.231.")).toBe(true);

			// A server in lease a: a reaches it, b cannot.
			await sandboxes.exec(ctx, a.id, {
				command: "(python3 -m http.server 8000 --bind 0.0.0.0 >/dev/null 2>&1 &) ; sleep 1",
			});
			const own = await sandboxes.exec(ctx, a.id, {
				command: `curl -s -o /dev/null -m 5 --noproxy '*' http://${addressA}:8000/ ; echo $?`,
			});
			expect(own.stdout.trim()).toBe("0");
			const across = await sandboxes.exec(ctx2, b.id, {
				command: `curl -s -o /dev/null -m 5 --noproxy '*' http://${addressA}:8000/ ; echo $?`,
			});
			expect(across.stdout.trim()).not.toBe("0");
		});
	});

	it("removes a lease's network and revokes its token when it ends, and leaves the proxy on the others", async (t) => {
		await withProxy(t.skip, async ({ deps, workspaces, sandboxes, acquire, revoked, proxyName, networksOf }) => {
			deps.tenancy.session({ id: SESSION_2, organisationId: ORGANISATION, projectId: PROJECT, agentId: "agent-2" });
			const other = await workspaces.create(ctx2, { owner, sessionId: SESSION_2, mounts: [] });
			const a = await acquire("container");
			const b = await sandboxes.acquire(ctx2, { sessionId: SESSION_2, workspaceId: other.id, tier: "container" });
			await sandboxes.exec(ctx, a.id, { command: "true" });
			await sandboxes.exec(ctx2, b.id, { command: "true" });

			// Each lease's container creation clears what an earlier one left, its credentials included; only what follows counts.
			const before = revoked.length;
			await sandboxes.release(ctx, a.id);
			expect(await networksOf(a.id)).toEqual([]);
			expect(revoked.slice(before)).toEqual([a.id]);
			const [networkB] = await networksOf(b.id);
			const membersB = Object.values((await docker.inspectNetwork(networkB!.Id)).Containers ?? {});
			expect(membersB.map((member) => member.Name)).toContain(proxyName);
			const still = await sandboxes.exec(ctx2, b.id, { command: proxied("http://example.test/") });
			expect(still.exitCode).toBe(0);
		});
	});

	it("reaps an expired lease's network and revokes its token after a restart", async (t) => {
		await withProxy(t.skip, async ({ deps, workspaces, sandboxes, acquire, prefix, revoked, networksOf, options }) => {
			const container = await acquire("container", 60_000);
			await sandboxes.exec(ctx, container.id, { command: "true" });
			expect(await networksOf(container.id)).toHaveLength(1);
			// A revocation that fails leaves everything for the next pass, rather than a live token with nothing to find it by.
			let failNext = true;
			const credentials = options.proxyCredentials!;
			const restarted = backendFor(workspaces, prefix, deps, {
				...options,
				proxyCredentials: {
					issue: (input) => credentials.issue(input),
					async revoke(leaseId) {
						if (failNext) {
							failNext = false;
							throw new Error("token store unavailable");
						}
						await credentials.revoke(leaseId);
					},
				},
			});
			try {
				await expect(restarted.reapExpired(container.expiresAt)).rejects.toThrow("token store unavailable");
				expect(await networksOf(container.id)).toHaveLength(1);
				expect(await docker.listContainers([`${prefix}.lease=${container.id}`])).toHaveLength(1);
				const before = revoked.length;
				expect(await restarted.reapExpired(container.expiresAt)).toBe(1);
				expect(await networksOf(container.id)).toEqual([]);
				expect(revoked.slice(before)).toEqual([container.id]);
			} finally {
				await restarted.close();
			}
		});
	});

	it("never revokes the token of a container a command starts while the janitor runs", async (t) => {
		await withProxy(
			t.skip,
			async ({ deps, workspaces, workspaceId, sandboxes, acquire, prefix, issued, events, options }) => {
				const lease = await acquire("container", 60_000);
				await sandboxes.exec(ctx, lease.id, { command: "true" });
				const record = await workspaces.get(ctx, workspaceId);
				// Each round, a restarted backend finds the last round's container expired and a command for its lease at once;
				// the delays move the command's start across the janitor's listing. Whichever goes first, the container that
				// serves the command keeps its token.
				for (const delayMs of [0, 2, 5, 10, 20, 40]) {
					const restarted = backendFor(workspaces, prefix, deps, options);
					try {
						const [, ran] = await Promise.all([
							restarted.reapExpired(lease.expiresAt),
							new Promise((resolve) => setTimeout(resolve, delayMs)).then(() =>
								restarted.exec({ ctx, lease, record, request: { command: proxied("http://example.test/") } }),
							),
						]);
						expect(ran.exitCode, `after ${delayMs} ms`).toBe(0);
						const seen = JSON.parse(ran.stdout) as { auth: string | null };
						expect(seen.auth).toBe(`Basic ${btoa(`sbx:${issued.get(lease.id)?.token}`)}`);
						const mine = events.filter((event) => event.endsWith(`:${lease.id}`));
						expect(mine.at(-1), `after ${delayMs} ms`).toBe(`issue:${lease.id}`);
					} finally {
						await restarted.close();
					}
				}
			},
		);
	});
});

describe.skipIf(!enabled)(`Docker container tier, proxy credentials on a shared network (${runtime})`, () => {
	it("leaves a lease the janitor can find when its container fails after the token was issued", async (t) => {
		try {
			await lookup("harbour-sandbox-test.localhost");
		} catch {
			t.skip();
			return;
		}
		const ca = createServer((_request, response) => response.end("not a real CA\n"));
		await new Promise<void>((resolve) => ca.listen(0, "::", resolve));
		const port = (ca.address() as AddressInfo).port;
		const revoked: string[] = [];
		let revokes = 0;
		let proxyHost = "";
		// The token is refused after it was issued, so creation fails then; and the revocation in the cleanup after it
		// fails too (the first is the one before creation). With no mounts and a shared network, only the credentials
		// marker is left to find the lease by.
		const { prefix, deps, workspaces, sandboxes, cleanup } = await setUp((prefix) => {
			proxyHost = `${prefix}-sp.localhost`;
			return {
				network: { name: `${prefix}-shared`, proxyUrl: `http://${proxyHost}:${port}` },
				proxyCredentials: {
					issue: async () => "not a url-safe token!",
					async revoke(leaseId) {
						revokes++;
						if (revokes === 2) throw new Error("token store unavailable");
						if (revokes > 2) revoked.push(leaseId);
					},
				},
			};
		});
		try {
			await docker.createInternalNetwork(`${prefix}-shared`, { [`${prefix}.lease`]: "shared" });
			const proxyId = await docker.createContainer(
				{
					Image: image,
					User: "1000:1000",
					Entrypoint: ["python3", "-c", FAKE_PROXY, String(port)],
					Labels: { [`${prefix}.lease`]: "proxy" },
					HostConfig: { Runtime: "runc", NetworkMode: `${prefix}-shared` },
				},
				proxyHost,
			);
			await docker.startContainer(proxyId);
			const bare = await workspaces.create(ctx, { owner, sessionId: SESSION, mounts: [] });
			const lease = await sandboxes.acquire(ctx, {
				sessionId: SESSION,
				workspaceId: bare.id,
				tier: "container",
				ttlMs: 60_000,
			});
			await expect(sandboxes.exec(ctx, lease.id, { command: "true" })).rejects.toThrow(/proxy token/);
			const left = await docker.listVolumes([`${prefix}.lease=${lease.id}`]);
			expect(left.map((volume) => volume.Labels?.[`${prefix}.role`])).toEqual(["credentials"]);
			expect(revoked).toEqual([]);

			const restarted = backendFor(workspaces, prefix, deps, {
				network: { name: `${prefix}-shared`, proxyUrl: `http://${proxyHost}:${port}` },
				proxyCredentials: { issue: async () => "unused", revoke: async (leaseId) => void revoked.push(leaseId) },
			});
			try {
				await restarted.reapExpired(lease.expiresAt);
				expect(revoked).toEqual([lease.id]);
				expect(await docker.listVolumes([`${prefix}.lease=${lease.id}`])).toEqual([]);
			} finally {
				await restarted.close();
			}
		} finally {
			await cleanup();
			await new Promise((resolve) => ca.close(resolve));
		}
	});
});
