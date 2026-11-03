// Environments and their protected variables: sealing, the routes, what a sandbox made from one is given (a placeholder
// of its own for each protected value, never the value), rotation, forks, grants, the host-facing `protectedTable` and
// `recordEgress`, and that no answer, event, webhook payload or error ever carries a protected value.
import { createKantelClient, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { BackendEgress, ExecRequest, ExecResult, SandboxBackend, SandboxSpec } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createEphemeralSealer, createSealer, parseSecretsKey, sealedAt } from "../src/secrets.ts";
import { MAX_EGRESS_ENTRIES, type ReportedEgress } from "../src/service.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import type { ComputeStore } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";
import { bytesToBase64 } from "../src/util.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
};

/** The protected value every test hides. */
const SECRET = "ghp_TESTSECRETVALUE123";
const GITHUB = [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET", "POST"] }];
const PLACEHOLDER = /^kph_[0-9A-Za-z]{40}$/;
const KEY = bytesToBase64(new Uint8Array(32).fill(7));
const OTHER_KEY = bytesToBase64(new Uint8Array(32).fill(9));

const opened: ComputeApi[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** What the service asked of the backend. */
interface Recorded {
	/** Every machine made, by create or fork. */
	readonly specs: SandboxSpec[];
	readonly egress: { readonly sandboxId: string; readonly egress: BackendEgress | undefined }[];
	readonly secrets: { readonly sandboxId: string; readonly version: number }[];
	readonly execs: ExecRequest[];
}

/** Answers a command in place of the stub's shell, or `undefined` to let the stub run it. */
type ExecHook = (request: ExecRequest) => ExecResult | undefined;

/** The stub backend, recording the specs it is given and taking egress and secrets updates as a host's would. */
function recordingBackend(execHook?: ExecHook): { readonly backend: SandboxBackend; readonly recorded: Recorded } {
	const stub = createStubBackend();
	const recorded: Recorded = { specs: [], egress: [], secrets: [], execs: [] };
	const backend: SandboxBackend = {
		...stub,
		exec: async (sandboxId, request) => {
			recorded.execs.push(request);
			return execHook?.(request) ?? stub.exec(sandboxId, request);
		},
		create: async (spec) => {
			recorded.specs.push(spec);
			return stub.create(spec);
		},
		fork: async (source, targets) => {
			recorded.specs.push(...targets);
			return stub.fork(source, targets);
		},
		updateEgress: async (sandboxId, egress) => {
			recorded.egress.push({ sandboxId, egress });
		},
		updateSecrets: async (sandboxId, version) => {
			recorded.secrets.push({ sandboxId, version });
		},
	};
	return { backend, recorded };
}

function setup(
	options: { readonly store?: ComputeStore; readonly secretsKey?: string; readonly exec?: ExecHook } = {},
) {
	const { backend, recorded } = recordingBackend(options.exec);
	/** The bodies of the webhook requests sent. */
	const sent: string[] = [];
	const api = createComputeApi({
		backend,
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async (input, init) => {
			sent.push(await new Request(input, init).text());
			return new Response(null, { status: 204 });
		},
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, recorded, sent, tom: client("tom-token"), ann: client("ann-token") };
}

/** The error a call failed with; fails the test when it succeeded. */
async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

/** The spec the backend was given for a sandbox. */
function specOf(recorded: Recorded, sandboxId: string): SandboxSpec {
	const spec = recorded.specs.find((each) => each.sandboxId === sandboxId);
	if (spec === undefined) throw new Error(`The backend made no machine for ${sandboxId}`);
	return spec;
}

function last<T>(items: readonly T[]): T | undefined {
	return items[items.length - 1];
}

/** `backend`, with a plain LOG_LEVEL and a protected GH_TOKEN bound to GitHub's API. */
async function githubEnvironment(client: KantelClient, name = "backend") {
	const environment = await client.createEnvironment({ name });
	await client.setEnvironmentVariable(environment.id, "LOG_LEVEL", { value: "debug" });
	return client.setEnvironmentVariable(environment.id, "GH_TOKEN", {
		protected: true,
		value: SECRET,
		bindings: GITHUB,
	});
}

const sqlTimeout = pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs };

describe("sealing", () => {
	const aad = sealedAt("environments", "env_one", "variables.GH_TOKEN");

	it("opens what it sealed, text or bytes, with a fresh IV each time", async () => {
		const sealer = createSealer(KEY);
		const sealed = await sealer.seal(SECRET, aad);
		expect(sealed.v).toBe(1);
		expect(JSON.stringify(sealed)).not.toContain(SECRET);
		expect(await sealer.openText(sealed, aad)).toBe(SECRET);
		expect((await sealer.seal(SECRET, aad)).iv).not.toBe(sealed.iv);

		const bytes = new Uint8Array([0, 1, 2, 254, 255]);
		expect([...(await sealer.open(await sealer.seal(bytes, aad), aad))]).toEqual([0, 1, 2, 254, 255]);
	});

	it("refuses to open a value moved to another place, or under another key, without saying what it was", async () => {
		const sealer = createSealer(KEY);
		const sealed = await sealer.seal(SECRET, aad);
		for (const opening of [
			sealer.open(sealed, sealedAt("environments", "env_two", "variables.GH_TOKEN")),
			sealer.open(sealed, sealedAt("environments", "env_one", "variables.OTHER")),
			createSealer(OTHER_KEY).open(sealed, aad),
			createEphemeralSealer().open(sealed, aad),
		]) {
			const error = await opening.then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(error).toMatchObject({ code: "unavailable" });
			expect(String((error as Error).message)).not.toContain(SECRET);
		}
		await expect(sealer.open({ ...sealed, v: 2 } as unknown as typeof sealed, aad)).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("refuses a key that isn't 32 bytes of base64, naming the setting and not the text", () => {
		expect(parseSecretsKey(KEY)).toHaveLength(32);
		expect(parseSecretsKey(` ${KEY}\n`)).toHaveLength(32);
		for (const text of [
			bytesToBase64(new Uint8Array(16)),
			bytesToBase64(new Uint8Array(33)),
			"not base64 at all!",
			"",
		]) {
			expect(() => parseSecretsKey(text)).toThrow(/KANTEL_SECRETS_KEY/);
			expect(() => createSealer(text)).toThrow(/32 bytes/);
		}
		try {
			createSealer("hunter2-is-not-a-key");
		} catch (error) {
			expect((error as Error).message).not.toContain("hunter2");
		}
		// A deployment with a key it can't use fails to start.
		expect(() =>
			createComputeApi({ backend: createStubBackend(), secretsKey: bytesToBase64(new Uint8Array(16)) }),
		).toThrow(/KANTEL_SECRETS_KEY/);
	});
});

describe("a SQL store", sqlTimeout, () => {
	async function sqlStore() {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		return database.driver;
	}

	it("without a secrets key refuses protected variables and secret files, and keeps plain variables", async () => {
		const driver = await sqlStore();
		const store = createSqlComputeStore(driver);
		expect(store.persistent).toBe(true);
		const { tom, recorded } = setup({ store });
		const environment = await tom.createEnvironment({ name: "plain" });

		const refused = await failure(
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: SECRET, bindings: GITHUB }),
		);
		expect(refused.code).toBe("not_supported");
		expect(refused.message).toContain("KANTEL_SECRETS_KEY");
		expect(refused.message).not.toContain(SECRET);
		const file = await failure(tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: "token" }));
		expect(file.code).toBe("not_supported");

		const plain = await tom.setEnvironmentVariable(environment.id, "LOG_LEVEL", { value: "debug" });
		expect(plain.variables).toEqual([
			{ name: "LOG_LEVEL", protected: false, value: "debug", bindings: [], updatedAt: expect.any(Number) },
		]);
		expect(plain.files).toEqual([]);
		const sandbox = await tom.createSandbox({ environment: "plain", wait: true });
		expect(sandbox.state).toBe("running");
		expect(specOf(recorded, sandbox.id).env).toEqual({ LOG_LEVEL: "debug" });
		expect(JSON.stringify(await store.environments.list())).not.toContain(SECRET);
	});

	it("with a secrets key keeps protected values sealed, for every gateway with that key", async () => {
		const driver = await sqlStore();
		const store = createSqlComputeStore(driver);
		const { tom } = setup({ store, secretsKey: KEY });
		await githubEnvironment(tom);
		const sandbox = await tom.createSandbox({ environment: "backend", wait: true });
		expect(JSON.stringify(await store.environments.list())).not.toContain(SECRET);

		// Another gateway (or this one after a restart) with the key opens it; one with another key can't.
		const again = setup({ store: createSqlComputeStore(driver), secretsKey: KEY });
		const table = await again.api.service.protectedTable(STUB_HOST_ID, sandbox.id);
		expect(table?.entries.map((entry) => [entry.name, entry.value])).toEqual([["GH_TOKEN", SECRET]]);
		const wrong = setup({ store: createSqlComputeStore(driver), secretsKey: OTHER_KEY });
		const error = await wrong.api.service.protectedTable(STUB_HOST_ID, sandbox.id).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toMatchObject({ code: "unavailable" });
		expect(String((error as Error).message)).not.toContain(SECRET);
	});
});

describe("environments", () => {
	it("creates, lists, renames and deletes, with a name unique in its account", async () => {
		const { tom, ann } = setup();
		const made = await tom.createEnvironment({ name: "backend", description: "The API's" });
		expect(made).toMatchObject({
			name: "backend",
			description: "The API's",
			variables: [],
			files: [],
			repos: [],
			grants: [],
			sandboxCount: 0,
		});
		expect(made.id).toMatch(/^env_/);
		expect((await failure(tom.createEnvironment({ name: "backend" }))).code).toBe("conflict");
		expect((await failure(tom.createEnvironment({ name: "Not A Name" }))).code).toBe("invalid");

		// Another account has names of its own, and can't see this one's environments.
		const anns = await ann.createEnvironment({ name: "backend" });
		expect(anns.accountId).not.toBe(made.accountId);
		expect((await failure(ann.getEnvironment(made.id))).code).toBe("not_found");
		expect((await failure(ann.deleteEnvironment(made.id))).code).toBe("not_found");

		const other = await tom.createEnvironment({ name: "frontend" });
		expect((await failure(tom.updateEnvironment(other.id, { name: "backend" }))).code).toBe("conflict");
		const renamed = await tom.updateEnvironment(made.id, { name: "api", description: "" });
		expect(renamed.name).toBe("api");
		expect(renamed.description).toBeUndefined();
		// Renaming to its own name is no clash.
		expect((await tom.updateEnvironment(made.id, { name: "api" })).name).toBe("api");
		expect((await tom.getEnvironment(made.id)).name).toBe("api");
		expect((await tom.listEnvironments()).items.map((environment) => environment.name)).toEqual(["api", "frontend"]);

		await tom.deleteEnvironment(made.id);
		expect((await failure(tom.getEnvironment(made.id))).code).toBe("not_found");
		expect((await tom.listEnvironments()).items.map((environment) => environment.id)).toEqual([other.id]);
		expect((await ann.listEnvironments()).items.map((environment) => environment.id)).toEqual([anns.id]);
	});

	it("refuses Kantel's own names, a protected variable with no bindings, and bindings on a plain one", async () => {
		const { tom } = setup();
		const environment = await tom.createEnvironment({ name: "checks" });
		for (const name of ["KANTEL_X", "kantel_token", "https_proxy", "HTTP_PROXY", "No_Proxy", "1ST", "A-B"]) {
			expect((await failure(tom.setEnvironmentVariable(environment.id, name, { value: "x" }))).code).toBe("invalid");
		}
		const unbound = [
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: SECRET }),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: SECRET, bindings: [] }),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
				protected: true,
				value: SECRET,
				bindings: [{ host: "https://api.github.com" }],
			}),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
				protected: true,
				value: SECRET,
				bindings: [{ host: "api.github.com", pathPrefixes: ["/repos?token=1"] }],
			}),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: "", bindings: GITHUB }),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, bindings: GITHUB }),
			tom.setEnvironmentVariable(environment.id, "LOG_LEVEL", { value: "debug", bindings: GITHUB }),
			tom.setEnvironmentVariable(environment.id, "LOG_LEVEL", {}),
		];
		for (const call of unbound) {
			const refused = await failure(call);
			expect(refused.code).toBe("invalid");
			expect(refused.message).not.toContain(SECRET);
		}
		expect((await tom.getEnvironment(environment.id)).variables).toEqual([]);

		// A protected variable's bindings are kept in one form: lower-case hosts, upper-case methods.
		const saved = await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
			protected: true,
			value: SECRET,
			bindings: [{ host: "API.GitHub.com", methods: ["GET", "GET"] }, { host: "*.example.com" }],
		});
		expect(saved.variables).toEqual([
			{
				name: "GH_TOKEN",
				protected: true,
				bindings: [{ host: "api.github.com", methods: ["GET"] }, { host: "*.example.com" }],
				updatedAt: expect.any(Number),
			},
		]);
	});
});

describe("sandboxes made from an environment", () => {
	it("get its plain values and a placeholder of their own for each protected one, by ID or by name", async () => {
		const { api, tom, recorded } = setup();
		const environment = await githubEnvironment(tom);
		const byId = await tom.createSandbox({ environment: environment.id, env: { EXTRA: "1" }, wait: true });
		const byName = await tom.createSandbox({ environment: "backend", wait: true });
		expect(byId.environmentId).toBe(environment.id);
		expect(byName.environmentId).toBe(environment.id);
		expect(byId.grants).toEqual([]);

		const first = specOf(recorded, byId.id);
		const second = specOf(recorded, byName.id);
		expect(first.env).toMatchObject({ LOG_LEVEL: "debug", EXTRA: "1" });
		expect(Object.keys(first.env).sort()).toEqual(["EXTRA", "GH_TOKEN", "LOG_LEVEL"]);
		expect(first.env.GH_TOKEN).toMatch(PLACEHOLDER);
		expect(first.env.GH_TOKEN).toHaveLength(44);
		expect(second.env.GH_TOKEN).toMatch(PLACEHOLDER);
		expect(second.env.GH_TOKEN).not.toBe(first.env.GH_TOKEN);
		expect(JSON.stringify(recorded.specs)).not.toContain(SECRET);
		expect(JSON.stringify(await api.store.sandboxes.list())).not.toContain(SECRET);

		// Its egress names the bound hosts and the version, never the value.
		expect(first.egress).toEqual({
			defaultAction: "allow",
			allow: [],
			deny: [],
			attribution: false,
			protected: { version: expect.any(Number), intercept: ["api.github.com"] },
		});
		// A command sees the placeholder.
		const echoed = await tom.runCommand(byId.id, { command: "echo $GH_TOKEN" });
		expect(echoed.stdout.trim()).toBe(first.env.GH_TOKEN);
		expect((await tom.getEnvironment(environment.id)).sandboxCount).toBe(2);
		// A sandbox with no environment is given no egress of its own.
		const bare = await tom.createSandbox({ wait: true });
		expect(specOf(recorded, bare.id).egress).toBeUndefined();
	});

	it("refuses an env naming a protected variable or one of Kantel's, and an environment not in the account", async () => {
		const { tom, ann } = setup();
		const environment = await githubEnvironment(tom);
		const named = await failure(tom.createSandbox({ environment: "backend", env: { GH_TOKEN: "mine" } }));
		expect(named.code).toBe("invalid");
		expect(named.message).toContain("GH_TOKEN");
		expect((await failure(tom.createSandbox({ environment: "backend", env: { KANTEL_X: "1" } }))).code).toBe("invalid");
		expect((await failure(tom.createSandbox({ env: { HTTPS_PROXY: "http://elsewhere" } }))).code).toBe("invalid");
		expect((await failure(tom.createSandbox({ environment: "nope" }))).code).toBe("not_found");
		expect((await failure(ann.createSandbox({ environment: environment.id }))).code).toBe("not_found");
		expect((await failure(ann.createSandbox({ environment: "backend" }))).code).toBe("not_found");
		// A plain variable may be overridden.
		const own = await tom.createSandbox({ environment: "backend", env: { LOG_LEVEL: "trace" }, wait: true });
		expect((await tom.runCommand(own.id, { command: "echo $LOG_LEVEL" })).stdout).toBe("trace\n");
	});

	it("are written the environment's secret files once running", async () => {
		const { tom } = setup();
		const environment = await tom.createEnvironment({ name: "files" });
		const npmrc = "//registry.npmjs.org/:_authToken=npm_FILESECRET789\n";
		const saved = await tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: npmrc });
		expect(saved.files).toEqual([
			{ path: "/home/user/.npmrc", mode: 0o600, sizeBytes: npmrc.length, updatedAt: expect.any(Number) },
		]);
		expect(JSON.stringify(saved)).not.toContain("npm_FILESECRET789");
		const sandbox = await tom.createSandbox({ environment: "files", wait: true });
		expect((await tom.readFile(sandbox.id, { path: ".npmrc" })).content).toBe(npmrc);
	});

	it("clone the environment's repositories once running, never waiting on a prompt, and a failure is an event", async () => {
		const { tom, recorded } = setup({
			exec: (request) =>
				request.command.startsWith("git clone")
					? request.command.includes("private")
						? { exitCode: 128, stdout: "", stderr: "fatal: could not read Username", timedOut: false }
						: { exitCode: 0, stdout: "", stderr: "", timedOut: false }
					: undefined,
		});
		const environment = await githubEnvironment(tom, "repos");
		await tom.putEnvironmentRepos(environment.id, {
			repos: [
				{ url: "https://github.com/acme/app", ref: "main" },
				{ url: "https://github.com/acme/private", path: "/home/user/p" },
			],
		});
		const sandbox = await tom.createSandbox({ environment: "repos", wait: true });
		const clones = recorded.execs.filter((request) => request.command.startsWith("git clone"));
		expect(clones.map((request) => request.command)).toEqual([
			"git clone --depth 1 --branch 'main' -- 'https://github.com/acme/app' '/home/user/app'",
			"git clone --depth 1 -- 'https://github.com/acme/private' '/home/user/p'",
		]);
		for (const request of clones) {
			expect(request.env?.GIT_TERMINAL_PROMPT).toBe("0");
			// The placeholder, for the proxy to swap: never the value.
			expect(request.env?.GH_TOKEN).toMatch(PLACEHOLDER);
			expect(JSON.stringify(request)).not.toContain(SECRET);
		}
		const degraded = (await tom.listEvents({ sandboxId: sandbox.id })).items.filter(
			(event) => event.type === "sandbox.degraded",
		);
		expect(degraded.map((event) => (event.data as { reason?: string }).reason)).toEqual([
			"The environment's repository https://github.com/acme/private wasn't cloned into /home/user/p: fatal: could not read Username",
		]);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("keep their placeholder through a rotation, which their host is told of", async () => {
		const { api, tom, recorded } = setup();
		const environment = await githubEnvironment(tom);
		const sandbox = await tom.createSandbox({ environment: environment.id, wait: true });
		const placeholder = specOf(recorded, sandbox.id).env.GH_TOKEN;
		expect(placeholder).toMatch(PLACEHOLDER);

		const before = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
		expect(before?.entries).toEqual([
			{
				placeholder,
				name: "GH_TOKEN",
				value: SECRET,
				bindings: [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET", "POST"] }],
			},
		]);
		expect(recorded.secrets).toEqual([]);

		const rotated = "ghp_ROTATEDVALUE456";
		const answer = await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { value: rotated });
		expect(JSON.stringify(answer)).not.toContain(rotated);
		expect(answer.variables.find((variable) => variable.name === "GH_TOKEN")?.protected).toBe(true);
		await api.service.idle();
		const after = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
		expect(after?.entries.map((entry) => [entry.placeholder, entry.value])).toEqual([[placeholder, rotated]]);
		expect(after?.version).toBeGreaterThan(before?.version ?? Number.POSITIVE_INFINITY);
		expect(recorded.secrets).toEqual([{ sandboxId: sandbox.id, version: after?.version }]);
		expect((await api.store.sandboxes.get(sandbox.id))?.env.GH_TOKEN).toBe(placeholder);

		// New bindings without the value keep it, and reach the host's egress.
		await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { bindings: [{ host: "*.github.com" }] });
		await api.service.idle();
		const rebound = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
		expect(rebound?.entries).toEqual([
			{
				placeholder,
				name: "GH_TOKEN",
				value: rotated,
				bindings: [{ host: "*.github.com", pathPrefixes: [], methods: [] }],
			},
		]);
		expect(rebound?.version).toBeGreaterThan(after?.version ?? Number.POSITIVE_INFINITY);
		expect(last(recorded.secrets)).toEqual({ sandboxId: sandbox.id, version: rebound?.version });
		expect(last(recorded.egress)?.egress?.protected).toEqual({
			version: rebound?.version,
			intercept: ["*.github.com"],
		});
	});

	it("fork with fresh placeholders", async () => {
		const { api, tom, recorded } = setup();
		await githubEnvironment(tom);
		const source = await tom.createSandbox({ environment: "backend", wait: true });
		const [fork] = (await tom.forkSandbox(source.id, { wait: true })).items;
		if (fork === undefined) throw new Error("No fork");
		expect(fork.state).toBe("running");
		expect(fork.environmentId).toBe(source.environmentId);

		const parent = specOf(recorded, source.id).env.GH_TOKEN;
		const own = specOf(recorded, fork.id).env;
		expect(own.GH_TOKEN).toMatch(PLACEHOLDER);
		expect(own.GH_TOKEN).not.toBe(parent);
		expect(own.LOG_LEVEL).toBe("debug");
		expect(specOf(recorded, fork.id).egress?.protected?.intercept).toEqual(["api.github.com"]);

		const table = await api.service.protectedTable(STUB_HOST_ID, fork.id);
		expect(table?.entries.map((entry) => [entry.placeholder, entry.value])).toEqual([[own.GH_TOKEN, SECRET]]);
		expect(JSON.stringify(table)).not.toContain(parent ?? "kph_");
		expect((await tom.getSandboxEgress(fork.id)).protectedVariables).toEqual([
			{ name: "GH_TOKEN", placeholderPrefix: own.GH_TOKEN?.slice(0, 8), bindings: GITHUB },
		]);
	});
});

describe("no protected value leaves Kantel but to its sandbox's host", () => {
	it("in any answer, event, webhook payload, error or stored record", async () => {
		const { api, tom, sent } = setup();
		await tom.createWebhook({
			name: "everything",
			url: "https://hooks.example.com/kantel",
			events: ["sandbox.created", "sandbox.running", "sandbox.degraded", "sandbox.stopped"],
		});
		const answers: unknown[] = [];
		const keep = <T>(answer: T): T => {
			answers.push(answer);
			return answer;
		};
		const environment = keep(await tom.createEnvironment({ name: "backend" }));
		keep(
			await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
				protected: true,
				value: SECRET,
				bindings: GITHUB,
			}),
		);
		keep(await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { bindings: [{ host: "api.github.com" }] }));
		keep(await tom.getEnvironment(environment.id));
		keep(await tom.listEnvironments());
		keep(await tom.updateEnvironment(environment.id, { description: "With a token" }));
		keep(
			await tom.putEnvironmentGrants(environment.id, {
				grants: [{ action: "deny", host: "api.github.com", methods: ["DELETE"] }],
			}),
		);
		const sandbox = keep(await tom.createSandbox({ environment: "backend", wait: true }));
		keep(await tom.getSandbox(sandbox.id));
		keep(await tom.listSandboxes());
		keep(await tom.getSandboxEgress(sandbox.id));
		keep(await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "allow", host: "example.com" }] }));
		keep(await tom.forkSandbox(sandbox.id, { wait: true }));
		keep(await tom.runCommand(sandbox.id, { command: "env" }));
		// Only the host it runs on is given it.
		const table = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
		expect(table?.entries.map((entry) => entry.value)).toEqual([SECRET]);
		keep(await tom.stopSandbox(sandbox.id, { wait: true }));
		keep(await tom.listEvents());

		const messages: string[] = [];
		for (const call of [
			tom.setEnvironmentVariable(environment.id, "OTHER", { protected: true, value: SECRET }),
			tom.setEnvironmentVariable(environment.id, "KANTEL_TOKEN", { protected: true, value: SECRET, bindings: GITHUB }),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
				protected: true,
				value: SECRET,
				bindings: [{ host: SECRET }],
			}),
			tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: false, bindings: GITHUB }),
			tom.createSandbox({ environment: "backend", env: { GH_TOKEN: SECRET } }),
		]) {
			messages.push((await failure(call)).message);
		}
		await api.service.idle();

		for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(SECRET);
		for (const message of messages) {
			expect(message).not.toContain(SECRET);
			expect(message.toLowerCase()).not.toContain(SECRET.toLowerCase());
		}
		await api.dispatcher.drain();
		const deliveries = await api.store.deliveries.list();
		expect(deliveries.length).toBeGreaterThan(0);
		for (const body of sent) expect(body).not.toContain(SECRET);
		for (const records of [
			deliveries,
			await api.store.events.list(),
			await api.store.environments.list(),
			await api.store.sandboxes.list(),
			await api.store.commands.list(),
			await api.store.idempotency.list(),
		]) {
			expect(JSON.stringify(records)).not.toContain(SECRET);
		}
	});
});

describe("protectedTable", () => {
	it("is the sandbox's own host's alone, and empty once its environment is gone", async () => {
		const { api, tom, recorded } = setup();
		const environment = await githubEnvironment(tom);
		const sandbox = await tom.createSandbox({ environment: environment.id, wait: true });
		expect(await api.service.protectedTable("host_other", sandbox.id)).toBeUndefined();
		expect(await api.service.protectedTable(STUB_HOST_ID, "sbx_missing")).toBeUndefined();
		const table = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
		expect(table?.entries.map((entry) => entry.name)).toEqual(["GH_TOKEN"]);

		const bare = await tom.createSandbox({ wait: true });
		expect(await api.service.protectedTable(STUB_HOST_ID, bare.id)).toMatchObject({ entries: [] });

		// A variable removed no longer resolves, and the host is told.
		await tom.deleteEnvironmentVariable(environment.id, "GH_TOKEN");
		await api.service.idle();
		expect(await api.service.protectedTable(STUB_HOST_ID, sandbox.id)).toMatchObject({ entries: [] });
		expect(last(recorded.secrets)?.sandboxId).toBe(sandbox.id);
		expect((await tom.getSandboxEgress(sandbox.id)).protectedVariables).toEqual([]);

		// So with the environment deleted.
		await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: SECRET, bindings: GITHUB });
		await api.service.idle();
		const told = recorded.secrets.length;
		await tom.deleteEnvironment(environment.id);
		await api.service.idle();
		expect(recorded.secrets.length).toBe(told + 1);
		expect(await api.service.protectedTable(STUB_HOST_ID, sandbox.id)).toMatchObject({ entries: [] });
		// Deleted, it is gone for the host too.
		await tom.stopSandbox(sandbox.id, { wait: true });
		await tom.deleteSandbox(sandbox.id);
		await api.service.idle();
		expect(await api.service.protectedTable(STUB_HOST_ID, sandbox.id)).toBeUndefined();
	});
});

describe("recordEgress", () => {
	it("keeps a host's reports for its own sandboxes, without query strings, the newest 1000", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const record = (at: number, extra: Partial<ReportedEgress> = {}): ReportedEgress => ({
			at,
			sandboxId: sandbox.id,
			method: "GET",
			host: "api.github.com",
			port: 443,
			path: "/repos/lleverage-ai/kantel",
			allowed: true,
			swapped: [],
			inspected: true,
			status: 200,
			bytesUp: 10,
			bytesDown: 20,
			...extra,
		});
		const tunnel: ReportedEgress = {
			at: 3,
			sandboxId: sandbox.id,
			method: "CONNECT",
			host: "tracker.example",
			port: 443,
			allowed: false,
			reason: "Denied by a grant",
			rule: "deny tracker.example",
			code: "denied",
			swapped: [],
			inspected: false,
			bytesUp: 0,
			bytesDown: 0,
		};

		// Another host's report of this sandbox, and a report of a sandbox that doesn't exist, are dropped.
		await api.service.recordEgress("host_other", [record(1)]);
		await api.service.recordEgress(STUB_HOST_ID, [{ ...record(1), sandboxId: "sbx_missing" }]);
		expect((await tom.getSandboxEgress(sandbox.id)).entries).toEqual([]);

		await api.service.recordEgress(STUB_HOST_ID, [
			record(2, { path: `/search?q=${SECRET}#frag`, swapped: ["GH_TOKEN"] }),
			tunnel,
		]);
		const [connect, search, ...rest] = (await tom.getSandboxEgress(sandbox.id)).entries;
		expect(rest).toEqual([]);
		expect(search).toEqual({
			id: expect.stringMatching(/^egr_/),
			at: 2,
			method: "GET",
			host: "api.github.com",
			port: 443,
			path: "/search",
			decision: "allowed",
			swapped: ["GH_TOKEN"],
			inspected: true,
			status: 200,
			bytesUp: 10,
			bytesDown: 20,
		});
		expect(connect).toEqual({
			id: expect.stringMatching(/^egr_/),
			at: 3,
			method: "CONNECT",
			host: "tracker.example",
			port: 443,
			decision: "denied",
			reason: "Denied by a grant",
			rule: "deny tracker.example",
			code: "denied",
			swapped: [],
			inspected: false,
			bytesUp: 0,
			bytesDown: 0,
		});
		expect(JSON.stringify(await api.store.egress.list())).not.toContain(SECRET);

		// 2 + 998 is 1000; 7 more push the oldest 7 out.
		await api.service.recordEgress(
			STUB_HOST_ID,
			Array.from({ length: 998 }, (_, index) => record(100 + index)),
		);
		expect(await api.store.egress.list({ sandboxId: sandbox.id })).toHaveLength(MAX_EGRESS_ENTRIES);
		await api.service.recordEgress(
			STUB_HOST_ID,
			Array.from({ length: 7 }, (_, index) => record(5000 + index)),
		);
		const kept = await api.store.egress.list({ sandboxId: sandbox.id });
		expect(kept).toHaveLength(MAX_EGRESS_ENTRIES);
		const times = kept.map((entry) => entry.at);
		expect(Math.min(...times)).toBe(105);
		expect(Math.max(...times)).toBe(5006);
		const answered = await tom.getSandboxEgress(sandbox.id, { limit: 3 });
		expect(answered.entries.map((entry) => entry.at)).toEqual([5006, 5005, 5004]);
		expect((await tom.getSandboxEgress(sandbox.id)).entries).toHaveLength(100);
	});
});

describe("grants", () => {
	it("reach the backend's egress, the environment's then the sandbox's, each with its rule", async () => {
		const { api, tom, recorded } = setup();
		const environment = await tom.createEnvironment({ name: "grants" });
		const withGrants = await tom.putEnvironmentGrants(environment.id, {
			grants: [{ action: "allow", host: "registry.npmjs.org" }],
		});
		expect(withGrants.grants).toEqual([
			{ id: expect.stringMatching(/^grt_[a-z0-9]+$/), action: "allow", host: "registry.npmjs.org" },
		]);
		const npm = { action: "allow", host: "registry.npmjs.org", rule: "allow registry.npmjs.org" };
		const open = { defaultAction: "allow", allow: [], deny: [], attribution: false };

		const sandbox = await tom.createSandbox({ environment: environment.id, wait: true });
		// Made with the environment's grants; with no protected variable, nothing to intercept for them.
		expect(specOf(recorded, sandbox.id).egress).toEqual({ ...open, grants: [npm] });

		const egress = await tom.putSandboxGrants(sandbox.id, {
			grants: [{ action: "deny", host: "API.github.com", methods: ["DELETE"], paths: ["/repos/*"] }],
		});
		expect(egress.grants).toEqual([
			{
				id: expect.stringMatching(/^grt_[a-z0-9]+$/),
				action: "deny",
				host: "api.github.com",
				methods: ["DELETE"],
				paths: ["/repos/*"],
			},
		]);
		expect(egress.environmentGrants).toEqual(withGrants.grants);
		await api.service.idle();
		const deleteRepos = {
			action: "deny",
			host: "api.github.com",
			methods: ["DELETE"],
			paths: ["/repos/*"],
			rule: "deny DELETE api.github.com /repos/*",
		};
		expect(last(recorded.egress)).toEqual({ sandboxId: sandbox.id, egress: { ...open, grants: [npm, deleteRepos] } });

		// The environment's grants changed reach its running sandboxes.
		await tom.putEnvironmentGrants(environment.id, { grants: [] });
		await api.service.idle();
		expect(last(recorded.egress)).toEqual({ sandboxId: sandbox.id, egress: { ...open, grants: [deleteRepos] } });

		// An edit keeps its grants' IDs; the sandbox answers them too.
		const kept = await tom.putSandboxGrants(sandbox.id, { grants: egress.grants });
		expect(kept.grants.map((grant) => grant.id)).toEqual(egress.grants.map((grant) => grant.id));
		expect((await tom.getSandbox(sandbox.id)).grants).toEqual(kept.grants);
		expect(
			(await failure(tom.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "not a host" }] }))).code,
		).toBe("invalid");

		// Every grant off, the sandbox's egress is nothing again.
		await tom.putSandboxGrants(sandbox.id, { grants: [] });
		await api.service.idle();
		expect(last(recorded.egress)).toEqual({ sandboxId: sandbox.id, egress: undefined });
	});
});
