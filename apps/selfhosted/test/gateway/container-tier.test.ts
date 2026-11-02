// The gateway's container tier (tier 2, sandboxes.ts): its settings, the runtime `auto` picks, the Docker backend's
// wiring and the vault proxy's tokens, then a session's `bash` routed as on Cloudflare: `git`, `node`, `python3` and
// the rest of DEFAULT_TIER_ROUTES, and anything the isolate doesn't have, to the container; the rest to the isolate.
// The container here is a fake that records each command; the real Docker backend runs in its own package's tests
// (KANTEL_TEST_DOCKER=1) and in the compose stack.
import { type CallContext, type SandboxLease, type SessionId, systemContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import type { DockerContainerBackendOptions } from "@kantel/selfhosted-sandbox";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
import {
	autoRuntime,
	containerTierConfig,
	type GatewayContainerBackend,
	type GatewayContainers,
	prepareContainerTier,
	proxyTokens,
	SANDBOX_BINDING,
} from "../../src/gateway/sandboxes.ts";

describe("containerTierConfig", () => {
	it("is off without an image, and on with one", () => {
		expect(containerTierConfig({})).toBeUndefined();
		expect(containerTierConfig({ KANTEL_SANDBOX_CONTAINERS: "off", KANTEL_SANDBOX_IMAGE: "sbx:1" })).toBeUndefined();
		expect(containerTierConfig({ KANTEL_SANDBOX_IMAGE: "sbx:1" })).toEqual({
			socketPath: "/var/run/docker.sock",
			image: "sbx:1",
			runtime: "auto",
			labelPrefix: "kantel",
			memoryBytes: 2 * 1024 * 1024 * 1024,
			nanoCpus: 2_000_000_000,
		});
	});

	it("reads compose's settings, the vault proxy's included", () => {
		expect(
			containerTierConfig({
				KANTEL_SANDBOX_CONTAINERS: "docker",
				KANTEL_SANDBOX_IMAGE: "harbour-sandbox:dev",
				KANTEL_SANDBOX_RUNTIME: "runsc-kvm",
				KANTEL_DOCKER_SOCKET: "/run/docker.sock",
				KANTEL_SANDBOX_LABEL_PREFIX: "kantel-gateway.harbour",
				KANTEL_SANDBOX_MEMORY_BYTES: "1073741824",
				KANTEL_SANDBOX_NANO_CPUS: "1000000000",
				KANTEL_VAULT_PROXY_URL: "http://vault-proxy:3128",
				KANTEL_VAULT_CONTAINER: "harbour-vault-proxy",
				KANTEL_SANDBOX_NETWORK: "harbour-sbx-gw",
				KANTEL_SANDBOX_SUBNET_POOL: "10.251.0.0/16",
			}),
		).toEqual({
			socketPath: "/run/docker.sock",
			image: "harbour-sandbox:dev",
			runtime: "runsc-kvm",
			labelPrefix: "kantel-gateway.harbour",
			memoryBytes: 1073741824,
			nanoCpus: 1000000000,
			network: {
				name: "harbour-sbx-gw",
				proxyUrl: "http://vault-proxy:3128",
				proxyContainer: "harbour-vault-proxy",
				subnetPool: "10.251.0.0/16",
			},
		});
		// The proxy's container defaults to the URL's host.
		expect(
			containerTierConfig({ KANTEL_SANDBOX_IMAGE: "sbx:1", KANTEL_VAULT_PROXY_URL: "http://vault-proxy:3128" })
				?.network,
		).toEqual({ name: "kantel-sbx", proxyUrl: "http://vault-proxy:3128", proxyContainer: "vault-proxy" });
	});

	it("refuses settings it can't use", () => {
		expect(() => containerTierConfig({ KANTEL_SANDBOX_CONTAINERS: "docker" })).toThrow(/needs KANTEL_SANDBOX_IMAGE/);
		expect(() => containerTierConfig({ KANTEL_SANDBOX_CONTAINERS: "podman", KANTEL_SANDBOX_IMAGE: "x" })).toThrow(
			/docker or off/,
		);
		expect(() => containerTierConfig({ KANTEL_SANDBOX_IMAGE: "x", KANTEL_SANDBOX_NANO_CPUS: "1.5" })).toThrow(
			/positive whole number/,
		);
		expect(() => containerTierConfig({ KANTEL_SANDBOX_IMAGE: "x", KANTEL_VAULT_PROXY_URL: "vault-proxy" })).toThrow(
			/must be a URL/,
		);
	});
});

describe("autoRuntime", () => {
	it("is runsc when the daemon has gVisor registered, runc otherwise", () => {
		expect(autoRuntime({ Runtimes: { runc: {}, "io.containerd.runc.v2": {}, runsc: {} } })).toBe("runsc");
		expect(autoRuntime({ Runtimes: { runc: {}, "runsc-kvm": {} } })).toBe("runc");
		expect(autoRuntime({})).toBe("runc");
	});
});

/** A container backend that records each command and answers it, with nothing to commit. */
function fakeContainer() {
	const commands: { readonly sessionId: string; readonly command: string }[] = [];
	const ended: string[] = [];
	let reaped = 0;
	let closed = false;
	const backend: GatewayContainerBackend = {
		async exec({ lease, request }) {
			const command = typeof request.command === "string" ? request.command : request.command.join(" ");
			commands.push({ sessionId: lease.sessionId, command });
			return { exitCode: 0, stdout: `container ran: ${command}\n`, stderr: "" };
		},
		pending: async () => ({ changes: [], stamp: 0, settled: true }),
		committed: async () => undefined,
		ended: async (lease) => {
			ended.push(lease.id);
		},
		reapExpired: async () => {
			reaped += 1;
			return 0;
		},
		close: async () => {
			closed = true;
		},
	};
	return {
		backend,
		commands,
		ended,
		get reaped() {
			return reaped;
		},
		get closed() {
			return closed;
		},
	};
}

describe("prepareContainerTier", () => {
	const config = {
		socketPath: "/var/run/docker.sock",
		image: "harbour-sandbox:dev",
		runtime: "auto",
		labelPrefix: "kantel-gateway.harbour",
		memoryBytes: 1024,
		nanoCpus: 1000,
		network: {
			name: "harbour-sbx-gw",
			proxyUrl: "http://vault-proxy:3128",
			proxyContainer: "harbour-vault-proxy",
		},
	};

	it("builds the Docker backend on the runtime `auto` picks, on per-lease networks with the vault proxy", async () => {
		const created: DockerContainerBackendOptions[] = [];
		const fake = fakeContainer();
		const tier = await prepareContainerTier(config, {
			info: async () => ({ Runtimes: { runc: {}, runsc: {} } }),
			create: (options) => {
				created.push(options);
				return fake.backend;
			},
			log: () => {},
		});
		expect(tier.binding).toMatch(/Docker container tier \(runsc, auto\)/);
		expect(tier.binding).toMatch(/harbour-sandbox:dev/);
		expect(tier.binding).toMatch(/vault proxy \(harbour-vault-proxy\), no session tokens/);
		const workspaces = {} as Parameters<GatewayContainers["backend"]>[0];
		expect(tier.backend(workspaces)).toBe(fake.backend);
		expect(created).toEqual([
			{
				workspaces,
				socketPath: "/var/run/docker.sock",
				image: "harbour-sandbox:dev",
				runtime: "runsc",
				memoryBytes: 1024,
				nanoCpus: 1000,
				labelPrefix: "kantel-gateway.harbour",
				network: {
					name: "harbour-sbx-gw",
					proxyUrl: "http://vault-proxy:3128",
					isolation: "per-lease",
					proxyContainer: "harbour-vault-proxy",
				},
			},
		]);
	});

	it("takes runc where gVisor isn't registered, and a runtime named outright", async () => {
		const runtimes: (string | undefined)[] = [];
		const create = (options: DockerContainerBackendOptions) => {
			runtimes.push(options.runtime);
			return fakeContainer().backend;
		};
		const runcOnly = async () => ({ Runtimes: { runc: {} } });
		const auto = await prepareContainerTier(config, { info: runcOnly, create, log: () => {} });
		auto.backend({} as Parameters<GatewayContainers["backend"]>[0]);
		const logs: string[] = [];
		const named = await prepareContainerTier(
			{ ...config, runtime: "runsc-kvm" },
			{ info: runcOnly, create, log: (line) => logs.push(line) },
		);
		named.backend({} as Parameters<GatewayContainers["backend"]>[0]);
		expect(runtimes).toEqual(["runc", "runsc-kvm"]);
		expect(auto.binding).toMatch(/\(runc, auto\)/);
		expect(named.binding).toMatch(/\(runsc-kvm\)/);
		// A runtime the daemon doesn't have is named in the log, not fatal.
		expect(logs.join("\n")).toMatch(/no runtime runsc-kvm/);
	});

	it("refuses container commands, saying why, when the daemon doesn't answer", async () => {
		const tier = await prepareContainerTier(config, {
			info: async () => {
				throw new Error("connect ENOENT /var/run/docker.sock");
			},
			log: () => {},
		});
		expect(tier.binding).toMatch(/container tier unavailable: the Docker daemon .* did not answer/);
		const backend = tier.backend({} as Parameters<GatewayContainers["backend"]>[0]);
		await expect(backend.exec({} as Parameters<GatewayContainerBackend["exec"]>[0])).rejects.toThrow(/ENOENT/);
	});

	it("issues the proxy's tokens in harbour.sandbox_tokens when the table is there", async () => {
		const database = await pgliteDatabase.open();
		try {
			const create = (options: DockerContainerBackendOptions) => {
				expect(options.proxyCredentials).toBeDefined();
				return fakeContainer().backend;
			};
			const without = await prepareContainerTier(config, {
				tokens: database.driver,
				info: async () => ({ Runtimes: { runc: {} } }),
				create: (options) => {
					expect(options.proxyCredentials).toBeUndefined();
					return fakeContainer().backend;
				},
				log: () => {},
			});
			without.backend({} as Parameters<GatewayContainers["backend"]>[0]);
			expect(without.binding).toMatch(/no session tokens/);

			await database.driver.query("CREATE SCHEMA harbour");
			await database.driver.query(
				"CREATE TABLE harbour.sandbox_tokens (token text PRIMARY KEY, session_id text NOT NULL, tier text NOT NULL, expires_at timestamptz NOT NULL)",
			);
			const tier = await prepareContainerTier(config, {
				tokens: database.driver,
				info: async () => ({ Runtimes: { runc: {} } }),
				create,
				log: () => {},
			});
			tier.backend({} as Parameters<GatewayContainers["backend"]>[0]);
			expect(tier.binding).not.toMatch(/no session tokens/);
		} finally {
			await database.close();
		}
	}, 30_000);
});

describe("proxyTokens", () => {
	it("issues a token per container the proxy resolves to the session, and revokes every one of a lease", async () => {
		const database = await pgliteDatabase.open();
		try {
			const { driver } = database;
			await driver.query("CREATE SCHEMA harbour");
			await driver.query(
				"CREATE TABLE harbour.sandbox_tokens (token text PRIMARY KEY, session_id text NOT NULL, tier text NOT NULL, expires_at timestamptz NOT NULL)",
			);
			const tokens = proxyTokens(driver);
			const lease = (id: string, sessionId: string) => ({ id, sessionId }) as SandboxLease;
			const ctx = systemContext("container-tier-test");
			const first = await tokens.issue({ ctx, lease: lease("lease-1", "sess-1") });
			const again = await tokens.issue({ ctx, lease: lease("lease-1", "sess-1") });
			const other = await tokens.issue({ ctx, lease: lease("lease-2", "sess-2") });
			expect(first).toMatch(/^lease-1\.[0-9a-f]{32}$/);
			expect(first).not.toBe(again);
			// The proxy's own query (apps/vault-proxy, callerOf).
			const resolve = async (token: string) =>
				driver.query<{ session_id: string; tier: string }>(
					"SELECT session_id, tier FROM harbour.sandbox_tokens WHERE token = ? AND expires_at > now()",
					[token],
				);
			expect(await resolve(first)).toEqual([{ session_id: "sess-1", tier: "container" }]);
			await tokens.revoke("lease-1");
			expect(await resolve(first)).toEqual([]);
			expect(await resolve(again)).toEqual([]);
			expect(await resolve(other)).toEqual([{ session_id: "sess-2", tier: "container" }]);
			// Repeating it, or for a lease with none, is fine.
			await tokens.revoke("lease-1");
			await tokens.revoke("lease-3");
		} finally {
			await database.close();
		}
	}, 30_000);
});

describe("a session's bash on the gateway with a container tier", () => {
	const opened: GatewayComponents[] = [];
	afterEach(async () => {
		for (const components of opened.splice(0)) await components.close();
	});

	async function setUp(containers?: GatewayContainers) {
		const { models, script } = createScriptedModel();
		const components = createGatewayComponents({
			models: { models },
			...(containers === undefined ? {} : { containers }),
		});
		opened.push(components);
		const seeded = await bootstrap(components, { organisation: "Tier two", project: "tier-two" });
		const key = await components.identity.authenticateApiKey(
			{ ...systemContext("container-tier-test"), organisationId: seeded.organisationId },
			seeded.apiKey,
		);
		const operator: CallContext = {
			actor: key.actor,
			organisationId: seeded.organisationId,
			projectId: seeded.projectId,
		};
		const { runtime } = components.runtime;
		const created = await runtime.create(operator, {
			projectId: seeded.projectId,
			agentId: "echo",
			workspaceId: seeded.workspaceId,
		});
		const bash = async (sessionId: SessionId, ...commands: string[]) => {
			script.reply(...commands.map((command) => ({ toolCalls: [{ name: "bash", args: { command } }] })), {
				text: "Ran",
			});
			const prompt = await runtime.prompt(operator, sessionId, { text: "Run them" });
			expect(await runtime.wait(operator, sessionId, prompt.id)).toMatchObject({ status: "answered" });
			return (
				script.requests
					.at(-1)
					?.messages.filter((message) => message.role === "tool")
					.map((message) => message.text) ?? []
			).slice(-commands.length);
		};
		const live = () =>
			components.sandboxes.leases(
				{ ...systemContext("container-tier-test"), organisationId: seeded.organisationId },
				{ sessionId: created.id, live: true },
			);
		return { components, operator, created, bash, live };
	}

	const tierOf = (fake: ReturnType<typeof fakeContainer>) => ({
		binding: "test container tier",
		backend: () => fake.backend,
	});

	it("runs git, node and python3 in the container, as DEFAULT_TIER_ROUTES says, and the rest in the isolate", async () => {
		const fake = fakeContainer();
		const { components, operator, created, bash, live } = await setUp(tierOf(fake));
		expect(components.bindings.sandboxes).toBe("test container tier");

		const results = await bash(created.id, "git status", "node -v", "python3 -V", "echo from-the-isolate", "make all");
		expect(fake.commands.map((entry) => entry.command)).toEqual(["git status", "node -v", "python3 -V", "make all"]);
		expect(fake.commands.every((entry) => entry.sessionId === created.id)).toBe(true);
		expect(results[0]).toContain("container ran: git status");
		expect(results[1]).toContain("container ran: node -v");
		expect(results[2]).toContain("container ran: python3 -V");
		// Not in the table, and the isolate has echo: the isolate ran it.
		expect(results[3]).toContain("from-the-isolate");
		expect(results[3]).not.toContain("container ran");
		// The isolate has no make: it escalated rather than failing there.
		expect(results[4]).toContain("container ran: make all");
		expect((await live()).map((lease) => lease.tier).sort()).toEqual(["container", "isolate"]);

		// Closing the session ends its container lease.
		await components.runtime.runtime.close(operator, created.id);
		expect(await live()).toEqual([]);
		expect(fake.ended).toHaveLength(1);
	});

	it("runs the janitor when it attaches, and closes the tier with the gateway", async () => {
		const fake = fakeContainer();
		const { components } = await setUp(tierOf(fake));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fake.reaped).toBe(1);
		await components.close();
		opened.splice(opened.indexOf(components), 1);
		expect(fake.closed).toBe(true);
	});

	it("without one, says so and refuses those commands", async () => {
		const { components, created, bash } = await setUp();
		expect(components.bindings.sandboxes).toBe(SANDBOX_BINDING);
		const [git, echo] = await bash(created.id, "git status", "echo still-here");
		expect(git).toMatch(/no container tier/);
		expect(echo).toContain("still-here");
	});
});
