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
import { type ComputeStore, createMemoryStore } from "../src/store.ts";
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
	readonly egress: {
		readonly sandboxId: string;
		readonly egress: BackendEgress | undefined;
		readonly revision?: number | undefined;
	}[];
	readonly secrets: { readonly sandboxId: string; readonly version: number }[];
	readonly execs: ExecRequest[];
}

/** Answers a command in place of the stub's shell, or `undefined` to let the stub run it. */
type ExecHook = (request: ExecRequest) => ExecResult | undefined;

/** The stub backend, recording the specs it is given and taking egress and secrets updates as a host's would. */
function recordingBackend(
	execHook?: ExecHook,
	beforeCreate?: (spec: SandboxSpec) => Promise<void>,
): { readonly backend: SandboxBackend; readonly recorded: Recorded } {
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
			await beforeCreate?.(spec);
			return stub.create(spec);
		},
		fork: async (source, targets) => {
			recorded.specs.push(...targets);
			return stub.fork(source, targets);
		},
		updateEgress: async (sandboxId, egress, revision) => {
			recorded.egress.push({ sandboxId, egress, ...(revision === undefined ? {} : { revision }) });
		},
		updateSecrets: async (sandboxId, version) => {
			recorded.secrets.push({ sandboxId, version });
		},
	};
	return { backend, recorded };
}

function setup(
	options: {
		readonly store?: ComputeStore;
		readonly secretsKey?: string;
		readonly exec?: ExecHook;
		/** Awaited inside the backend's create, before the machine is made. */
		readonly beforeCreate?: (spec: SandboxSpec) => Promise<void>;
	} = {},
) {
	const { backend, recorded } = recordingBackend(options.exec, options.beforeCreate);
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
		// Each made only when it is awaited, so none is refused before its refusal is looked for.
		const unbound = [
			() => tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: SECRET }),
			() => tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: SECRET, bindings: [] }),
			() =>
				tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
					protected: true,
					value: SECRET,
					bindings: [{ host: "https://api.github.com" }],
				}),
			() =>
				tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
					protected: true,
					value: SECRET,
					bindings: [{ host: "api.github.com", pathPrefixes: ["/repos?token=1"] }],
				}),
			() => tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, value: "", bindings: GITHUB }),
			() => tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: true, bindings: GITHUB }),
			() => tom.setEnvironmentVariable(environment.id, "LOG_LEVEL", { value: "debug", bindings: GITHUB }),
			() => tom.setEnvironmentVariable(environment.id, "LOG_LEVEL", {}),
		];
		for (const call of unbound) {
			const refused = await failure(call());
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
			revision: expect.any(Number),
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
			() => tom.setEnvironmentVariable(environment.id, "OTHER", { protected: true, value: SECRET }),
			() =>
				tom.setEnvironmentVariable(environment.id, "KANTEL_TOKEN", {
					protected: true,
					value: SECRET,
					bindings: GITHUB,
				}),
			() =>
				tom.setEnvironmentVariable(environment.id, "GH_TOKEN", {
					protected: true,
					value: SECRET,
					bindings: [{ host: SECRET }],
				}),
			() => tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { protected: false, bindings: GITHUB }),
			() => tom.createSandbox({ environment: "backend", env: { GH_TOKEN: SECRET } }),
		]) {
			messages.push((await failure(call())).message);
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
		const open = { defaultAction: "allow", allow: [], deny: [], attribution: false, revision: expect.any(Number) };

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
		expect(last(recorded.egress)).toEqual({
			sandboxId: sandbox.id,
			egress: { ...open, grants: [npm, deleteRepos] },
			revision: expect.any(Number),
		});

		// The environment's grants changed reach its running sandboxes.
		await tom.putEnvironmentGrants(environment.id, { grants: [] });
		await api.service.idle();
		expect(last(recorded.egress)).toEqual({
			sandboxId: sandbox.id,
			egress: { ...open, grants: [deleteRepos] },
			revision: expect.any(Number),
		});

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
		expect(last(recorded.egress)).toEqual({ sandboxId: sandbox.id, egress: undefined, revision: expect.any(Number) });
	});
});

/** A promise and the function that settles it. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
	let open = () => {};
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { wait, open };
}

/** `store`, with the first `environments.get` after `armed()` held until its gate opens. */
function holdingFirstRead(store: ComputeStore) {
	let held: { readonly wait: Promise<void>; readonly reached: () => void } | undefined;
	const wrapped: ComputeStore = {
		...store,
		environments: {
			...store.environments,
			get: async (id) => {
				const read = await store.environments.get(id);
				const holding = held;
				held = undefined;
				if (holding !== undefined) {
					holding.reached();
					await holding.wait;
				}
				return read;
			},
		},
	};
	return {
		store: wrapped,
		/** Holds the next read; answers when it has been made, and the gate that lets it go on. */
		arm() {
			const release = gate();
			const reached = gate();
			held = { wait: release.wait, reached: reached.open };
			return { reached: reached.wait, release: release.open };
		},
	};
}

describe("a repository's clone", () => {
	it("needs a caller who may run commands: its env would choose the commands", async () => {
		const { api, tom, recorded } = setup({ exec: () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) });
		const environment = await githubEnvironment(tom, "repos");
		await tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: "//registry/:_authToken=secret" });
		await tom.putEnvironmentRepos(environment.id, { repos: [{ url: "https://github.com/acme/app" }] });
		const keyed = (secret: string) =>
			createKantelClient({
				baseUrl: BASE_URL,
				token: secret,
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		const writer = keyed(
			(await tom.createApiKey({ name: "writer", scopes: ["sandboxes:read", "sandboxes:write"] })).secret,
		);
		// An exported function named for git would run in its place, with the secret file already written.
		const payload = { "BASH_FUNC_git%%": "() { /bin/cat /home/user/.npmrc >&2; return 1; }" };
		const refused = await failure(writer.createSandbox({ environment: "repos", env: payload, wait: true }));
		expect(refused.code).toBe("forbidden");
		expect(recorded.specs).toEqual([]);
		expect(recorded.execs).toEqual([]);
		expect((await tom.listSandboxes()).items).toEqual([]);

		// One with exec may: the clone runs.
		const runner = keyed(
			(await tom.createApiKey({ name: "runner", scopes: ["sandboxes:read", "sandboxes:write", "exec"] })).secret,
		);
		await runner.createSandbox({ environment: "repos", wait: true });
		expect(recorded.execs.filter((request) => request.command.includes(" clone "))).toHaveLength(1);
		// An environment with no repositories runs nothing, so needs nothing more.
		const plain = await tom.createEnvironment({ name: "plain-env" });
		await tom.setEnvironmentVariable(plain.id, "LOG_LEVEL", { value: "debug" });
		expect((await writer.createSandbox({ environment: plain.id, wait: true })).state).toBe("running");
	});

	it("clones the repositories authorised at the create, not ones added before it booted", async () => {
		let release = () => {};
		const booting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { api, tom, recorded } = setup({
			exec: () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
			beforeCreate: () => booting,
		});
		const environment = await githubEnvironment(tom, "repos");
		await tom.putEnvironmentRepos(environment.id, { repos: [{ url: "https://github.com/acme/app" }] });
		await tom.createSandbox({ environment: "repos" });
		await tom.putEnvironmentRepos(environment.id, {
			repos: [{ url: "https://github.com/acme/app" }, { url: "https://github.com/acme/later" }],
		});
		release();
		await api.service.idle();
		const clones = recorded.execs.filter((request) => request.command.includes(" clone "));
		expect(clones.map((request) => request.command.split(" -- ")[1])).toEqual([
			"'https://github.com/acme/app' '/home/user/app'",
		]);
	});

	it("gives Git the placeholder of the protected variable bound to the repository, through a helper Git runs", async () => {
		const { tom, recorded } = setup({ exec: () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) });
		const environment = await tom.createEnvironment({ name: "git" });
		await tom.setEnvironmentVariable(environment.id, "GIT_TOKEN", {
			protected: true,
			value: SECRET,
			bindings: [{ host: "github.com", pathPrefixes: ["/acme/"], methods: ["GET", "POST"] }],
		});
		await tom.putEnvironmentRepos(environment.id, {
			repos: [{ url: "https://github.com/acme/private" }, { url: "https://github.com/other/public" }],
		});
		await tom.createSandbox({ environment: "git", wait: true });
		const [bound, other] = recorded.execs.filter((request) => request.command.includes(" clone "));
		const placeholder = bound?.env?.GIT_TOKEN ?? "";
		expect(placeholder).toMatch(PLACEHOLDER);
		expect(bound?.command).toContain("credential.helper=!f()");
		expect(bound?.command).toContain("password=$GIT_TOKEN");
		expect(JSON.stringify(bound)).not.toContain(SECRET);
		// Outside the binding's paths: anonymous.
		expect(other?.command).not.toContain("credential.helper=!f()");

		// Git itself, given the same configuration, answers the placeholder for the repository's host.
		const { execFileSync } = await import("node:child_process");
		const gitConfig = (bound?.command ?? "").split(" clone ")[0]?.replace(/^git /, "") ?? "";
		let answered = "";
		try {
			answered = execFileSync("/bin/sh", ["-c", `git ${gitConfig} credential fill`], {
				input: "protocol=https\nhost=github.com\npath=acme/private\n\n",
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: "/nonexistent",
					GIT_TOKEN: placeholder,
					GIT_TERMINAL_PROMPT: "0",
				},
			}).toString();
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return;
			throw error;
		}
		expect(answered).toContain("username=x-access-token");
		expect(answered).toContain(`password=${placeholder}`);
	});
});

describe("an environment's items, changed at once", () => {
	const cases = [
		["in memory", async () => createMemoryStore()],
		["in SQL", async () => createSqlComputeStore(await sqlDriver())],
	] as const;

	async function sqlDriver() {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		return database.driver;
	}

	for (const [where, makeStore] of cases) {
		it(
			`keep what the other changed: a bindings edit a rotation, a mode edit new contents (${where})`,
			sqlTimeout,
			async () => {
				const holding = holdingFirstRead(await makeStore());
				const { api, tom } = setup({ store: holding.store, secretsKey: KEY });
				const environment = await githubEnvironment(tom);
				const sandbox = await tom.createSandbox({ environment: environment.id, wait: true });
				const rotated = "ghp_ROTATEDVALUE456";
				const narrower = [{ host: "api.github.com", pathPrefixes: ["/repos/acme/"], methods: ["GET"] }];

				// The bindings edit reads the environment, then waits while the rotation lands.
				let held = holding.arm();
				const bindingsEdit = tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { bindings: narrower });
				await held.reached;
				await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { value: rotated });
				held.release();
				await bindingsEdit;
				const table = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
				expect(table?.entries.map((entry) => [entry.value, entry.bindings])).toEqual([[rotated, narrower]]);

				// And the other way round: the rotation waits while the bindings edit lands.
				held = holding.arm();
				const rotation = tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { value: SECRET });
				await held.reached;
				await tom.setEnvironmentVariable(environment.id, "GH_TOKEN", { bindings: GITHUB });
				held.release();
				await rotation;
				const after = await api.service.protectedTable(STUB_HOST_ID, sandbox.id);
				expect(after?.entries.map((entry) => [entry.value, entry.bindings])).toEqual([[SECRET, GITHUB]]);

				// A mode-only edit doesn't put old contents back over new ones, nor new contents the old mode.
				await tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: "v1", mode: 0o600 });
				held = holding.arm();
				const modeEdit = tom.setEnvironmentFile(environment.id, { path: ".npmrc", mode: 0o640 });
				await held.reached;
				await tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: "version two" });
				const replaced = (await api.store.environments.get(environment.id))?.files[0];
				held.release();
				await modeEdit;
				const file = (await api.store.environments.get(environment.id))?.files[0];
				expect(file?.mode).toBe(0o640);
				expect(file?.sizeBytes).toBe("version two".length);
				expect(file?.sealed).toEqual(replaced?.sealed);

				held = holding.arm();
				const contentEdit = tom.setEnvironmentFile(environment.id, { path: ".npmrc", content: "three" });
				await held.reached;
				await tom.setEnvironmentFile(environment.id, { path: ".npmrc", mode: 0o400 });
				held.release();
				await contentEdit;
				const latest = (await api.store.environments.get(environment.id))?.files[0];
				expect([latest?.mode, latest?.sizeBytes]).toEqual([0o400, "three".length]);
				// Other names and paths still merge.
				await Promise.all([
					tom.setEnvironmentVariable(environment.id, "A", { value: "1" }),
					tom.setEnvironmentVariable(environment.id, "B", { value: "2" }),
					tom.setEnvironmentFile(environment.id, { path: ".a", content: "a" }),
					tom.setEnvironmentFile(environment.id, { path: ".b", content: "b" }),
				]);
				const merged = await tom.getEnvironment(environment.id);
				expect(merged.variables.map((variable) => variable.name).sort()).toEqual(["A", "B", "GH_TOKEN", "LOG_LEVEL"]);
				expect(merged.files.map((each) => each.path).sort()).toEqual([
					"/home/user/.a",
					"/home/user/.b",
					"/home/user/.npmrc",
				]);
			},
		);
	}
});

describe("an environment's name", () => {
	async function sqlStores() {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		return [createSqlComputeStore(database.driver), createSqlComputeStore(database.driver)] as const;
	}

	it("is one environment's, in memory, whatever the order of creates and renames", async () => {
		const { tom, ann } = setup();
		// Tom has signed in before (his first call makes his account).
		await tom.listEnvironments();
		const outcomes = await Promise.allSettled([
			tom.createEnvironment({ name: "dup" }),
			tom.createEnvironment({ name: "dup" }),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const other = await tom.createEnvironment({ name: "other" });
		const third = await tom.createEnvironment({ name: "third" });
		const raced = await Promise.allSettled([
			tom.updateEnvironment(other.id, { name: "target" }),
			tom.updateEnvironment(third.id, { name: "target" }),
			tom.createEnvironment({ name: "target" }),
		]);
		expect(raced.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const names = (await tom.listEnvironments()).items.map((environment) => environment.name);
		expect(names.filter((name) => name === "target")).toHaveLength(1);
		expect(names.filter((name) => name === "dup")).toHaveLength(1);
		// Renaming to its own name is fine, a released name is free again, and another account has its own names.
		const kept = (await tom.listEnvironments()).items.find((environment) => environment.name === "target");
		expect((await tom.updateEnvironment(kept?.id ?? "", { name: "target" })).name).toBe("target");
		await tom.updateEnvironment(kept?.id ?? "", { name: "renamed" });
		expect((await tom.createEnvironment({ name: "target" })).name).toBe("target");
		expect((await ann.createEnvironment({ name: "target" })).name).toBe("target");
		// A failed rename keeps the old name.
		const renamed = (await tom.listEnvironments()).items.find((environment) => environment.name === "renamed");
		expect((await failure(tom.updateEnvironment(renamed?.id ?? "", { name: "target" }))).code).toBe("conflict");
		expect((await tom.getEnvironment(renamed?.id ?? "")).name).toBe("renamed");
		// A deleted environment's name can be taken again.
		await tom.deleteEnvironment(renamed?.id ?? "");
		const again = await tom.createEnvironment({ name: "renamed" });
		// A sandbox made by name finds exactly that one.
		const sandbox = await tom.createSandbox({ environment: "renamed", wait: true });
		expect(sandbox.environmentId).toBe(again.id);
	});

	it("is one environment's across two gateways on one SQL database", sqlTimeout, async () => {
		const [first, second] = await sqlStores();
		const one = setup({ store: first, secretsKey: KEY });
		const two = setup({ store: second, secretsKey: KEY });
		// Each gateway has seen Tom before.
		await one.tom.listEnvironments();
		await two.tom.listEnvironments();
		const created = await Promise.allSettled([
			one.tom.createEnvironment({ name: "dup" }),
			two.tom.createEnvironment({ name: "dup" }),
		]);
		expect(created.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const a = await one.tom.createEnvironment({ name: "a" });
		const b = await two.tom.createEnvironment({ name: "b" });
		const raced = await Promise.allSettled([
			one.tom.updateEnvironment(a.id, { name: "target" }),
			two.tom.updateEnvironment(b.id, { name: "target" }),
			two.tom.createEnvironment({ name: "target" }),
		]);
		expect(raced.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const names = (await one.tom.listEnvironments()).items.map((environment) => environment.name);
		expect(names.filter((name) => name === "target")).toHaveLength(1);
		expect(names.filter((name) => name === "dup")).toHaveLength(1);
	});
});

describe("a policy changed while a sandbox starts", () => {
	it("reaches its backend once it runs: its grants, its environment's", async () => {
		let release = () => {};
		const booting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { api, tom, recorded } = setup({ beforeCreate: () => booting });
		const environment = await tom.createEnvironment({ name: "slow" });
		const sandbox = await tom.createSandbox({ environment: environment.id });
		expect(sandbox.state).toBe("starting");
		await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "evil.example" }] });
		await tom.putEnvironmentGrants(environment.id, { grants: [{ action: "allow", host: "registry.npmjs.org" }] });
		// Nothing is sent while it starts: its host has no sandbox yet.
		expect(recorded.egress).toEqual([]);
		release();
		await api.service.idle();
		const sent = last(recorded.egress.filter((each) => each.sandboxId === sandbox.id));
		expect(sent?.egress?.grants?.map((grant) => grant.rule)).toEqual(["allow registry.npmjs.org", "deny evil.example"]);
		expect(sent?.revision).toBe((await api.store.sandboxes.get(sandbox.id))?.egressRevision);
	});

	it("is not sent again when nothing changed while it started", async () => {
		const { api, tom, recorded } = setup();
		const environment = await tom.createEnvironment({ name: "quiet" });
		await tom.putEnvironmentGrants(environment.id, { grants: [{ action: "deny", host: "evil.example" }] });
		const sandbox = await tom.createSandbox({ environment: environment.id, wait: true });
		await api.service.idle();
		expect(recorded.egress.filter((each) => each.sandboxId === sandbox.id)).toEqual([]);
		// The boot carried them, with its revision.
		expect(specOf(recorded, sandbox.id).egress?.revision).toBe(
			(await api.store.sandboxes.get(sandbox.id))?.egressRevision,
		);
	});
});

describe("egress updates", () => {
	it("carry a revision that moves on with each change, the latest with the latest grants", async () => {
		const { api, tom, recorded } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const hosts = ["one.example", "two.example", "three.example"];
		await Promise.all(hosts.map((host) => tom.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host }] })));
		await api.service.idle();
		const stored = await api.store.sandboxes.get(sandbox.id);
		const pushes = recorded.egress.filter((each) => each.sandboxId === sandbox.id);
		const revisions = pushes.map((each) => each.revision ?? 0);
		const newest = pushes.find((each) => each.revision === Math.max(...revisions));
		// Whatever order they were sent in, the newest revision is the stored one, with the stored grants.
		expect(newest?.revision).toBe(stored?.egressRevision);
		expect(newest?.egress?.grants?.map((grant) => grant.host)).toEqual(stored?.grants?.map((grant) => grant.host));
		// One revision, one egress: two sent with the same revision were read from the same state.
		const byRevision = new Map<number, string>();
		for (const push of pushes) {
			const grants = JSON.stringify(push.egress?.grants);
			expect(byRevision.get(push.revision ?? 0) ?? grants).toBe(grants);
			byRevision.set(push.revision ?? 0, grants);
		}
		// Each change moved it on past the create's.
		expect(Math.min(...revisions)).toBeGreaterThan(specOf(recorded, sandbox.id).egress?.revision ?? 0);
		expect(stored?.egressRevision).toBeGreaterThanOrEqual((specOf(recorded, sandbox.id).egress?.revision ?? 0) + 3);
		// Turning them all off is ordered too: a null egress with its revision.
		await tom.putSandboxGrants(sandbox.id, { grants: [] });
		await api.service.idle();
		const cleared = last(recorded.egress);
		expect(cleared?.egress).toBeUndefined();
		expect(cleared?.revision).toBeGreaterThan(stored?.egressRevision ?? 0);
	});
});
