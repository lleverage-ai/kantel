// Environments, protected variables, grants and the egress log on the command line, through `run`, with a fake Kantel
// behind an injected fetch. A protected value must never reach stdout or stderr, with or without --json.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Input, run } from "../src/commands.ts";
import { bindingTexts, mergeBindings, parseBinding, withoutProtectedValues } from "../src/environments.ts";

interface Call {
	readonly method: string;
	readonly path: string;
	readonly query: URLSearchParams;
	readonly body: unknown;
}

type Route = (call: Call) => unknown;

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** A fake Kantel: routes by `METHOD /v1/path`, answering what the route returns (a Response as it is, else JSON). */
function fakeKantel(routes: { readonly [route: string]: Route }) {
	const calls: Call[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const call: Call = { method, path: url.pathname, query: url.searchParams, body };
		calls.push(call);
		const route = routes[`${method} ${url.pathname}`];
		if (route === undefined) {
			return json({ error: { code: "not_found", message: `No route ${method} ${url.pathname}` } }, 404);
		}
		const answer = await route(call);
		if (answer instanceof Response) return answer;
		return answer === undefined ? new Response(null, { status: 204 }) : json(answer);
	};
	return { fetch, calls };
}

function capture() {
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	return {
		isTTY: false,
		write(chunk: string | Uint8Array) {
			chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
			return true;
		},
		text: () => chunks.join(""),
	};
}

function input(text?: string, isTTY = false): Input {
	return {
		isTTY,
		async *[Symbol.asyncIterator]() {
			if (text !== undefined) yield text;
		},
	};
}

const ENV = { KANTEL_URL: "https://kantel.test", KANTEL_API_KEY: "ksk_test" };
const NOW = Date.now();
const SECRET = "ghp_s3cretValueThatMustNeverPrint";

const ENVIRONMENT = {
	id: "env_work1",
	accountId: "acc_1",
	name: "work",
	description: "Day job",
	variables: [
		{ name: "NODE_ENV", protected: false, value: "production", bindings: [], updatedAt: NOW },
		{ name: "GH_TOKEN", protected: true, bindings: [{ host: "api.github.com" }], updatedAt: NOW },
	],
	files: [{ path: "/home/user/.npmrc", mode: 0o600, sizeBytes: 42, updatedAt: NOW }],
	repos: [{ url: "https://github.com/acme/app", path: "app" }],
	grants: [{ id: "grt_1", action: "deny", host: "api.github.com", methods: ["DELETE"], paths: ["/repos/**"] }],
	sandboxCount: 2,
	createdAt: NOW,
	updatedAt: NOW,
};

/** The routes that find `work` by name and answer it. */
const ENVIRONMENT_ROUTES = {
	"GET /v1/environments": () => ({ items: [ENVIRONMENT] }),
	"GET /v1/environments/env_work1": () => ENVIRONMENT,
};

let configDir = "";

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "kantel-cli-env-"));
});

afterEach(async () => {
	await rm(configDir, { recursive: true, force: true });
});

async function kantel(
	argv: readonly string[],
	options: { readonly routes?: { readonly [route: string]: Route }; readonly stdin?: Input } = {},
) {
	const api = fakeKantel(options.routes ?? {});
	const stdout = capture();
	const stderr = capture();
	const code = await run(argv, {
		fetch: api.fetch,
		env: ENV,
		stdout,
		stderr,
		stdin: options.stdin ?? input(undefined, true),
		configDir,
		cwd: configDir,
		home: join(configDir, "home"),
		self: ["/usr/local/bin/node", "/home/me/.local/bin/kantel"],
		openUrl: () => {},
		sleep: async () => {},
	});
	return { code, stdout: stdout.text(), stderr: stderr.text(), calls: api.calls };
}

const routeOf = (call: Call): string => `${call.method} ${call.path}`;

describe("--bind", () => {
	it("reads a host, an optional path prefix and optional methods", () => {
		expect(parseBinding("api.github.com")).toEqual({ host: "api.github.com" });
		expect(parseBinding("api.openai.com/v1/:POST,GET")).toEqual({
			host: "api.openai.com",
			pathPrefixes: ["/v1/"],
			methods: ["POST", "GET"],
		});
		expect(parseBinding("API.GitHub.com/repos/:get")).toEqual({
			host: "api.github.com",
			pathPrefixes: ["/repos/"],
			methods: ["GET"],
		});
		expect(parseBinding("api.github.com:PUT")).toEqual({ host: "api.github.com", methods: ["PUT"] });
		expect(parseBinding("*.example.com")).toEqual({ host: "*.example.com" });
		expect(parseBinding("api.github.com/")).toEqual({ host: "api.github.com" });
	});

	it("keeps a colon that isn't followed by methods in the path", () => {
		expect(parseBinding("generativelanguage.googleapis.com/v1/models/m:generateContent")).toEqual({
			host: "generativelanguage.googleapis.com",
			pathPrefixes: ["/v1/models/m:generateContent"],
		});
	});

	it("refuses a URL, a port, a query and a name that isn't a host", () => {
		expect(() => parseBinding("https://api.github.com")).toThrow(/not a URL/);
		expect(() => parseBinding("api.github.com:443")).toThrow(/no port/);
		expect(() => parseBinding("api.github.com/user?x=1")).toThrow(/no query/);
		expect(() => parseBinding("api github")).toThrow(/isn't a host name/);
		expect(() => parseBinding("api.*.com")).toThrow(/isn't a host name/);
		expect(() => parseBinding("api.github.com:")).toThrow(/no port/);
	});

	it("merges binds for the same host and methods, and prints them as --bind takes them", () => {
		const merged = mergeBindings(
			["api.github.com/repos/", "api.github.com/user", "api.openai.com:POST", "api.openai.com/v1/:POST"].map(
				parseBinding,
			),
		);
		expect(merged).toEqual([
			{ host: "api.github.com", pathPrefixes: ["/repos/", "/user"] },
			{ host: "api.openai.com", methods: ["POST"] },
		]);
		expect(merged.flatMap(bindingTexts)).toEqual([
			"api.github.com/repos/",
			"api.github.com/user",
			"api.openai.com:POST",
		]);
	});

	it("drops a protected value from anything shown, at any depth", () => {
		const leaky = {
			items: [
				{
					variables: [
						{ name: "A", protected: true, value: SECRET },
						{ name: "B", value: "b" },
					],
				},
			],
		};
		expect(JSON.stringify(withoutProtectedValues(leaky))).not.toContain(SECRET);
		expect(withoutProtectedValues(leaky)).toEqual({
			items: [
				{
					variables: [
						{ name: "A", protected: true },
						{ name: "B", value: "b" },
					],
				},
			],
		});
	});
});

describe("env set", () => {
	const setRoutes = (answer: (call: Call) => unknown) => ({
		...ENVIRONMENT_ROUTES,
		"PUT /v1/environments/env_work1/variables/OPENAI_API_KEY": answer,
		"PUT /v1/environments/env_work1/variables/GH_TOKEN": answer,
		"PUT /v1/environments/env_work1/variables/NODE_ENV": answer,
	});
	/** Kantel answering the variable, as it never should, with its value. */
	const leaky = (call: Call) => ({ ...(call.body as object), name: "OPENAI_API_KEY", updatedAt: NOW });

	it("sets a protected variable bound to its destinations, by the environment's name", async () => {
		const result = await kantel(
			[
				"env",
				"set",
				"work",
				`OPENAI_API_KEY=${SECRET}`,
				"--protected",
				"--bind",
				"api.openai.com/v1/:POST,GET",
				"--bind",
				"api.openai.com/v2/:GET,POST",
			],
			{ routes: setRoutes(leaky) },
		);
		expect(result.code).toBe(0);
		expect(result.calls.map(routeOf)).toEqual([
			"GET /v1/environments",
			"GET /v1/environments/env_work1",
			"PUT /v1/environments/env_work1/variables/OPENAI_API_KEY",
		]);
		expect(result.calls[2]?.body).toEqual({
			protected: true,
			value: SECRET,
			bindings: [{ host: "api.openai.com", pathPrefixes: ["/v1/", "/v2/"], methods: ["POST", "GET"] }],
		});
		expect(result.stdout).toContain("Set OPENAI_API_KEY in work: protected, sent only to api.openai.com/v1/:POST,GET");
		expect(result.stdout + result.stderr).not.toContain(SECRET);
	});

	it("never prints the value with --json, even when Kantel answers it", async () => {
		const result = await kantel(
			["env", "set", "env_work1", `OPENAI_API_KEY=${SECRET}`, "--protected", "--bind", "api.openai.com", "--json"],
			{ routes: setRoutes(leaky) },
		);
		expect(result.code).toBe(0);
		expect(result.calls.map(routeOf)).toEqual([
			"GET /v1/environments/env_work1",
			"PUT /v1/environments/env_work1/variables/OPENAI_API_KEY",
		]);
		expect(result.stdout + result.stderr).not.toContain(SECRET);
		expect(JSON.parse(result.stdout)).toMatchObject({ name: "OPENAI_API_KEY", protected: true });
	});

	it("reads the value from stdin with --value-stdin, and takes the environment as --env", async () => {
		const result = await kantel(
			[
				"env",
				"set",
				"--env",
				"work",
				"OPENAI_API_KEY",
				"--value-stdin",
				"--protected",
				"--bind",
				"api.openai.com/v1/:POST",
			],
			{ routes: setRoutes(leaky), stdin: input(`${SECRET}\n`) },
		);
		expect(result.code).toBe(0);
		expect(result.calls[2]?.body).toEqual({
			protected: true,
			value: SECRET,
			bindings: [{ host: "api.openai.com", pathPrefixes: ["/v1/"], methods: ["POST"] }],
		});
		expect(result.stdout + result.stderr).not.toContain(SECRET);
	});

	it("refuses an empty stdin, and help says why --value-stdin is there", async () => {
		const empty = await kantel(["env", "set", "work", "GH_TOKEN", "--value-stdin"], {
			routes: setRoutes(leaky),
			stdin: input(""),
		});
		expect(empty.code).toBe(2);
		expect(empty.stderr).toContain("no value on stdin");
		expect(empty.calls).toEqual([]);
		const help = await kantel(["env", "set", "--help"]);
		expect(help.stdout).toContain("Usage: kantel env set <env> <NAME>[=<value>]");
		expect(help.stdout).toContain("keeps it out of your shell history");
	});

	it("rotates a protected variable: it stays protected, on the bindings it has", async () => {
		const result = await kantel(["env", "set", "work", "GH_TOKEN", "--value-stdin"], {
			routes: setRoutes(leaky),
			stdin: input(SECRET),
		});
		expect(result.code).toBe(0);
		// The value and that it is protected: its bindings stay as Kantel has them when it is written, not as they were
		// read, and the value is never kept plain, even if the variable was removed or made plain meanwhile.
		expect(result.calls[2]?.body).toEqual({ protected: true, value: SECRET });
		expect(result.stdout).toContain("Rotated GH_TOKEN in work");
		expect(result.stdout).toContain("same placeholder");
		expect(result.stdout + result.stderr).not.toContain(SECRET);
	});

	it("says what Kantel has after a rotation, not what it read before", async () => {
		// Someone narrowed GH_TOKEN's bindings after the read: the answer has them, and so does what is printed.
		const narrowed = [{ host: "api.github.com", pathPrefixes: ["/repos/acme/"], methods: ["GET"] }];
		const answer = {
			...ENVIRONMENT,
			variables: ENVIRONMENT.variables.map((variable) =>
				variable.name === "GH_TOKEN" ? { ...variable, bindings: narrowed } : variable,
			),
		};
		const result = await kantel(["env", "set", "work", "GH_TOKEN", "--value-stdin"], {
			routes: setRoutes(() => answer),
			stdin: input(SECRET),
		});
		expect(result.code).toBe(0);
		expect(result.calls[2]?.body).toEqual({ protected: true, value: SECRET });
		expect(result.stdout).toContain("Rotated GH_TOKEN in work: protected, sent only to api.github.com/repos/acme/:GET");
		expect(result.stdout + result.stderr).not.toContain(SECRET);
	});

	it("re-binds a protected variable with --keep-value, sending no value", async () => {
		const result = await kantel(
			["env", "set", "work", "GH_TOKEN", "--keep-value", "--bind", "api.github.com/repos/:GET"],
			{ routes: setRoutes(leaky) },
		);
		expect(result.code).toBe(0);
		expect(result.calls[2]?.body).toEqual({
			protected: true,
			bindings: [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET"] }],
		});
		const plain = await kantel(["env", "set", "work", "NODE_ENV", "--keep-value", "--bind", "api.github.com"], {
			routes: setRoutes(leaky),
		});
		expect(plain.code).toBe(1);
		expect(plain.stderr).toContain("NODE_ENV isn't protected in work");
	});

	it("sets a plain variable, and --plain makes a protected one plain", async () => {
		const plain = await kantel(["env", "set", "work", "NODE_ENV=test"], { routes: setRoutes(leaky) });
		expect(plain.code).toBe(0);
		expect(plain.calls[2]?.body).toEqual({ value: "test" });
		const unprotected = await kantel(["env", "set", "work", "GH_TOKEN=public", "--plain"], {
			routes: setRoutes(leaky),
		});
		expect(unprotected.calls[2]?.body).toEqual({ protected: false, value: "public" });
	});

	it("refuses a muddled command line before calling Kantel, without echoing the value", async () => {
		const cases: readonly (readonly string[])[] = [
			["env", "set", "work", "GH_TOKEN"],
			["env", "set", "work", `GH_TOKEN=${SECRET}`, "--value-stdin"],
			["env", "set", "work", `GH TOKEN=${SECRET}`],
			["env", "set", "work", `GH_TOKEN=${SECRET}`, "--plain", "--bind", "api.github.com"],
			["env", "set", "work", "GH_TOKEN", "--keep-value"],
			["env", "set", `GH_TOKEN=${SECRET}`],
			["env", "set", "work", `GH_TOKEN=${SECRET}`, "--bind", `https://api.github.com`],
		];
		for (const argv of cases) {
			const result = await kantel(argv, { routes: setRoutes(leaky) });
			expect(result.code, argv.join(" ")).toBe(2);
			expect(result.calls, argv.join(" ")).toEqual([]);
			expect(result.stdout + result.stderr, argv.join(" ")).not.toContain(SECRET);
		}
	});

	it("needs a --bind for a new protected variable", async () => {
		const result = await kantel(["env", "set", "work", `NEW_TOKEN=${SECRET}`, "--protected"], {
			routes: setRoutes(leaky),
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("needs --bind");
		expect(result.calls.map(routeOf)).not.toContain("PUT /v1/environments/env_work1/variables/NEW_TOKEN");
		expect(result.stdout + result.stderr).not.toContain(SECRET);
	});
});

describe("env show and list", () => {
	/** Kantel answering a protected variable's value, as it never should. */
	const leakyEnvironment = {
		...ENVIRONMENT,
		variables: ENVIRONMENT.variables.map((variable) =>
			variable.protected ? { ...variable, value: SECRET } : variable,
		),
	};
	const routes = {
		"GET /v1/environments": () => ({ items: [leakyEnvironment] }),
		"GET /v1/environments/env_work1": () => leakyEnvironment,
	};

	it("shows a plain value, and a protected variable's bindings but never its value", async () => {
		const shown = await kantel(["env", "show", "work"], { routes });
		expect(shown.code).toBe(0);
		expect(shown.stdout).toMatch(/NODE_ENV\s+production/);
		expect(shown.stdout).toMatch(/GH_TOKEN\s+protected\s+api\.github\.com/);
		expect(shown.stdout).toMatch(/\/home\/user\/\.npmrc\s+0600\s+42 B/);
		expect(shown.stdout).toContain("https://github.com/acme/app");
		expect(shown.stdout).toMatch(/grt_1\s+deny DELETE api\.github\.com \/repos\/\*\*/);
		expect(shown.stdout).not.toContain(SECRET);
	});

	it("leaves protected values out of --json and of the list", async () => {
		for (const argv of [
			["env", "show", "work", "--json"],
			["env", "list", "--json"],
			["env", "list"],
		]) {
			const result = await kantel(argv, { routes });
			expect(result.code, argv.join(" ")).toBe(0);
			expect(result.stdout, argv.join(" ")).not.toContain(SECRET);
		}
		const listed = await kantel(["env", "ls"], { routes });
		expect(listed.stdout).toMatch(/env_work1\s+work\s+2\s+1\s+1\s+1\s+2/);
	});

	it("says when there is no environment of that name", async () => {
		const missing = await kantel(["env", "show", "home"], { routes });
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('there is no environment called "home"');
	});

	it("lists the env commands under kantel env", async () => {
		const group = await kantel(["env"]);
		expect(group.code).toBe(0);
		for (const name of ["env set", "env file rm", "env repo add", "env grant rm"]) expect(group.stdout).toContain(name);
	});
});

describe("env files, repos and grants", () => {
	it("says the mode a secret file has once saved: new contents without --mode keep the file's", async () => {
		const saved = (mode: number) => () => ({
			...ENVIRONMENT,
			files: [{ path: "/home/user/.npmrc", mode, sizeBytes: 3, updatedAt: NOW }],
		});
		const kept = await kantel(["env", "file", "work", "~/.npmrc"], {
			routes: { ...ENVIRONMENT_ROUTES, "PUT /v1/environments/env_work1/files": saved(0o644) },
			stdin: input("abc"),
		});
		expect(kept.code).toBe(0);
		expect(kept.calls.at(-1)?.body).toEqual({ path: "~/.npmrc", content: "YWJj", encoding: "base64" });
		expect(kept.stdout).toContain("Saved ~/.npmrc (3 B, mode 0644) in work.");
		const fresh = await kantel(["env", "file", "work", ".npmrc"], {
			routes: { ...ENVIRONMENT_ROUTES, "PUT /v1/environments/env_work1/files": saved(0o600) },
			stdin: input("abc"),
		});
		expect(fresh.stdout).toContain("mode 0600");
	});

	it("sends a secret file's content as base64, from --from or stdin, and removes one", async () => {
		const local = join(configDir, "npmrc");
		await writeFile(local, "//registry.npmjs.org/:_authToken=secret\n");
		const routes = {
			...ENVIRONMENT_ROUTES,
			"PUT /v1/environments/env_work1/files": () => ENVIRONMENT,
			"DELETE /v1/environments/env_work1/files": () => undefined,
		};
		const fromFile = await kantel(["env", "file", "work", "/home/user/.npmrc", "--from", local, "--mode", "0640"], {
			routes,
		});
		expect(fromFile.code).toBe(0);
		expect(fromFile.calls.at(-1)?.body).toEqual({
			path: "/home/user/.npmrc",
			mode: 0o640,
			content: Buffer.from("//registry.npmjs.org/:_authToken=secret\n").toString("base64"),
			encoding: "base64",
		});
		const fromStdin = await kantel(["env", "file", "env_work1", "/etc/key"], { routes, stdin: input("abc") });
		expect(fromStdin.calls.at(-1)?.body).toEqual({ path: "/etc/key", content: "YWJj", encoding: "base64" });
		const noContent = await kantel(["env", "file", "work", "/etc/key"], { routes });
		expect(noContent.code).toBe(2);
		expect(noContent.calls).toEqual([]);
		const removed = await kantel(["env", "file", "rm", "work", "/home/user/.npmrc"], { routes });
		expect(removed.code).toBe(0);
		const last = removed.calls.at(-1);
		expect(last === undefined ? "" : routeOf(last)).toBe("DELETE /v1/environments/env_work1/files");
		expect(last?.query.get("path")).toBe("/home/user/.npmrc");
	});

	it("adds and removes repos, replacing one with the same URL", async () => {
		const routes = { ...ENVIRONMENT_ROUTES, "PUT /v1/environments/env_work1/repos": () => ENVIRONMENT };
		const added = await kantel(["env", "repo", "add", "work", "https://github.com/acme/app", "--ref", "main"], {
			routes,
		});
		expect(added.code).toBe(0);
		// With the list as read, so Kantel refuses the write when it has changed since.
		expect(added.calls.at(-1)?.body).toEqual({
			repos: [{ url: "https://github.com/acme/app", ref: "main" }],
			expected: ENVIRONMENT.repos,
		});
		const removed = await kantel(["env", "repo", "rm", "work", "https://github.com/acme/app"], { routes });
		expect(removed.calls.at(-1)?.body).toEqual({ repos: [], expected: ENVIRONMENT.repos });
		const notHttps = await kantel(["env", "repo", "add", "work", "git@github.com:acme/app.git"], { routes });
		expect(notHttps.code).toBe(2);
	});

	it("reads the list again and redoes the edit when Kantel says it changed since it was read", async () => {
		const theirs = { id: "grt_7", action: "allow", host: "registry.npmjs.org" };
		let reads = 0;
		const routes = {
			...ENVIRONMENT_ROUTES,
			// Someone else's grant lands between the first read and its write.
			"GET /v1/environments/env_work1": () => {
				reads++;
				return reads === 1 ? ENVIRONMENT : { ...ENVIRONMENT, grants: [...ENVIRONMENT.grants, theirs] };
			},
			"PUT /v1/environments/env_work1/grants": (call: Call) => {
				const body = call.body as { grants: unknown[]; expected: unknown[] };
				if (body.expected.length !== 2) {
					return json({ error: { code: "conflict", message: "The environment's grants changed" } }, 409);
				}
				return {
					...ENVIRONMENT,
					grants: body.grants.map((grant, index) => ({ id: `grt_${index}`, ...(grant as object) })),
				};
			},
		};
		const result = await kantel(["env", "grant", "env_work1", "deny", "*", "--method", "DELETE"], { routes });
		expect(result.code).toBe(0);
		const puts = result.calls.filter((call) => call.method === "PUT");
		expect(puts).toHaveLength(2);
		// The second write is made on the list as it is now: their grant is kept.
		expect(puts[1]?.body).toEqual({
			grants: [...ENVIRONMENT.grants, theirs, { action: "deny", host: "*", methods: ["DELETE"] }],
			expected: [...ENVIRONMENT.grants, theirs],
		});

		// One that keeps changing is a conflict in the end, not a write over it.
		const busy = {
			...ENVIRONMENT_ROUTES,
			"PUT /v1/environments/env_work1/repos": () =>
				json({ error: { code: "conflict", message: "The environment's repositories changed" } }, 409),
		};
		const refused = await kantel(["env", "repo", "add", "env_work1", "https://github.com/acme/web"], { routes: busy });
		expect(refused.code).toBe(1);
		expect(refused.calls.filter((call) => call.method === "PUT")).toHaveLength(3);
		expect(refused.stderr).toContain("changed");
	});

	it("adds an environment grant beside the ones it has, and removes one by ID", async () => {
		const added = { id: "grt_2", action: "allow", host: "api.github.com", methods: ["GET"] };
		const routes = {
			...ENVIRONMENT_ROUTES,
			"PUT /v1/environments/env_work1/grants": (call: Call) => ({
				...ENVIRONMENT,
				grants: (call.body as { grants: unknown[] }).grants.map((grant) =>
					(grant as { id?: string }).id === undefined ? added : grant,
				),
			}),
		};
		const result = await kantel(["env", "grant", "work", "allow", "API.github.com", "--method", "get"], { routes });
		expect(result.code).toBe(0);
		expect(result.calls.at(-1)?.body).toEqual({
			grants: [ENVIRONMENT.grants[0], { action: "allow", host: "api.github.com", methods: ["GET"] }],
			expected: ENVIRONMENT.grants,
		});
		expect(result.stdout).toContain('Added "allow GET api.github.com" (grt_2) to work.');
		const removed = await kantel(["env", "grant", "rm", "work", "grt_1"], { routes });
		expect(removed.code).toBe(0);
		expect(removed.calls.at(-1)?.body).toEqual({ grants: [], expected: ENVIRONMENT.grants });
		const unknown = await kantel(["env", "grant", "rm", "work", "grt_9"], { routes });
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("work has no grant grt_9");
	});
});

describe("sandboxes", () => {
	const SANDBOX = { id: "sbx_test1", name: "brave-otter", state: "running", grants: [] as unknown[] };

	it("starts a sandbox from an environment with --env, beside K=V variables", async () => {
		const routes = { "POST /v1/sandboxes": () => ({ ...SANDBOX, type: "isolate", environmentId: "env_work1" }) };
		const created = await kantel(["new", "--env", "work", "-e", "A=1"], { routes });
		expect(created.code).toBe(0);
		expect(created.calls[0]?.body).toEqual({ environment: "work", env: { A: "1" }, wait: true });
		const two = await kantel(["new", "--env", "work", "--env", "home"], { routes });
		expect(two.code).toBe(2);
		expect(two.calls).toEqual([]);
	});

	it("adds and removes a sandbox's own grants", async () => {
		const routes = {
			"GET /v1/sandboxes/sbx_test1": () => ({ ...SANDBOX, grants: [{ id: "grt_5", action: "allow", host: "*" }] }),
			"PUT /v1/sandboxes/sbx_test1/grants": (call: Call) => ({
				...SANDBOX,
				grants: (call.body as { grants: { id?: string }[] }).grants.map((grant) => ({ id: "grt_6", ...grant })),
			}),
		};
		const added = await kantel(
			["grant", "sbx_test1", "deny", "api.github.com", "--method", "DELETE", "--path", "/repos/**"],
			{ routes },
		);
		expect(added.code).toBe(0);
		expect(added.calls.at(-1)?.body).toEqual({
			grants: [
				{ id: "grt_5", action: "allow", host: "*" },
				{ action: "deny", host: "api.github.com", methods: ["DELETE"], paths: ["/repos/**"] },
			],
			expected: [{ id: "grt_5", action: "allow", host: "*" }],
		});
		expect(added.stdout).toContain('Added "deny DELETE api.github.com /repos/**" (grt_6) to sbx_test1.');
		const removed = await kantel(["grant", "rm", "sbx_test1", "grt_5"], { routes });
		expect(removed.code).toBe(0);
		expect(removed.calls.map(routeOf)).toEqual(["GET /v1/sandboxes/sbx_test1", "PUT /v1/sandboxes/sbx_test1/grants"]);
		expect(removed.calls.at(-1)?.body).toEqual({ grants: [], expected: [{ id: "grt_5", action: "allow", host: "*" }] });
		const badPath = await kantel(["grant", "sbx_test1", "deny", "api.github.com", "--path", "repos"], { routes });
		expect(badPath.code).toBe(2);
		expect(badPath.calls).toEqual([]);
	});

	it("prints the egress log as a table, and only refusals with --denied", async () => {
		const egress = {
			sandboxId: "sbx_test1",
			sandboxName: "brave-otter",
			accountId: "acc_1",
			environment: { id: "env_work1", name: "work" },
			protectedVariables: [{ name: "GH_TOKEN", placeholderPrefix: "kph_7Qx2", bindings: [{ host: "api.github.com" }] }],
			environmentGrants: ENVIRONMENT.grants,
			grants: [],
			entries: [
				{
					id: "egr_2",
					at: Date.UTC(2026, 10, 3, 14, 5, 9),
					method: "POST",
					host: "evil.example",
					port: 443,
					path: "/collect",
					decision: "denied",
					code: "placeholder-unbound",
					swapped: [],
					inspected: true,
					status: 403,
					bytesUp: 0,
					bytesDown: 0,
				},
				{
					id: "egr_1",
					at: Date.UTC(2026, 10, 3, 14, 5, 2),
					method: "GET",
					host: "api.github.com",
					port: 443,
					path: "/user",
					decision: "allowed",
					swapped: ["GH_TOKEN"],
					inspected: true,
					status: 200,
					bytesUp: 120,
					bytesDown: 900,
				},
			],
		};
		const routes = { "GET /v1/sandboxes/sbx_test1/egress": () => egress };
		const all = await kantel(["egress", "sbx_test1", "--limit", "50"], { routes });
		expect(all.code).toBe(0);
		expect(all.calls[0]?.query.get("limit")).toBe("50");
		expect(all.stdout).toContain("GH_TOKEN (kph_7Qx2…) to api.github.com");
		expect(all.stdout).toMatch(/^TIME\s+METHOD\s+DESTINATION\s+DECISION\s+CODE\/RULE\s+SWAPPED$/m);
		expect(all.stdout).toMatch(
			/2026-11-03 14:05:09\s+POST\s+evil\.example\/collect\s+denied 403\s+placeholder-unbound/,
		);
		expect(all.stdout).toMatch(/GET\s+api\.github\.com\/user\s+allowed 200\s+GH_TOKEN/);
		const denied = await kantel(["egress", "sbx_test1", "--denied", "--json"], { routes });
		const shown = JSON.parse(denied.stdout) as { entries: { id: string }[] };
		expect(shown.entries.map((entry) => entry.id)).toEqual(["egr_2"]);
	});
});
