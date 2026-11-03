// The kantel command line, through `run`, with a fake Kantel behind an injected fetch and a temporary config directory.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, Command, Sandbox, SandboxPage } from "@kantel/api/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS_END, AGENTS_START, claudeSetup, upsertAgentsBlock } from "../src/agents.ts";
import { parseArgs } from "../src/args.ts";
import { commandLine, type Input, run } from "../src/commands.ts";
import { DEFAULT_URL, normaliseUrl, resolveConfig } from "../src/config.ts";

interface Call {
	readonly method: string;
	readonly url: string;
	readonly path: string;
	readonly query: URLSearchParams;
	readonly body: unknown;
	readonly authorization: string | null;
}

type Route = (call: Call) => unknown;

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const kantelError = (status: number, code: string, message: string): Response =>
	json({ error: { code, message } }, status);

/** A fake Kantel: routes by `METHOD /v1/path`, answering what the route returns (a Response as it is, else JSON). */
function fakeKantel(routes: { readonly [route: string]: Route }) {
	const calls: Call[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const authorization = new Headers(init?.headers).get("authorization");
		const call: Call = { method, url: url.href, path: url.pathname, query: url.searchParams, body, authorization };
		calls.push(call);
		const route = routes[`${method} ${url.pathname}`];
		if (route === undefined) return kantelError(404, "not_found", `No route ${method} ${url.pathname}`);
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

const SANDBOX: Sandbox = {
	id: "sbx_test1",
	accountId: "acc_1",
	name: "brave-otter",
	subdomain: "brave-otter",
	type: "isolate",
	state: "running",
	visibility: "private",
	capabilities: {
		exec: true,
		files: true,
		ssh: false,
		desktop: false,
		browser: false,
		ports: true,
		docker: false,
		kvm: false,
		pause: false,
	},
	labels: {},
	autoStopMinutes: 60,
	createdBy: { kind: "api_key", id: "key_1" },
	createdAt: Date.now(),
	cost: { currency: "USD", total: 0, ratePerHour: 0 },
	usage: { runningSeconds: 0, cpuSeconds: 0, recentCpu: [] },
};

const CALLER: Caller = {
	apiKey: { id: "key_1", name: "laptop", scopes: ["sandboxes:read", "exec"] },
	accountId: "acc_1",
	accounts: [],
	superAdmin: false,
	mode: "selfhosted",
};

const command = (overrides: Partial<Command>): Command => ({
	id: "cmd_1",
	sandboxId: "sbx_test1",
	command: "true",
	state: "exited",
	exitCode: 0,
	stdout: "",
	stderr: "",
	truncated: false,
	startedAt: Date.now(),
	...overrides,
});

let configDir = "";

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "kantel-cli-"));
});

afterEach(async () => {
	await rm(configDir, { recursive: true, force: true });
});

interface KantelOptions {
	readonly routes?: { readonly [route: string]: Route };
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: Input;
}

async function kantel(argv: readonly string[], options: KantelOptions = {}) {
	const api = fakeKantel(options.routes ?? {});
	const stdout = capture();
	const stderr = capture();
	const code = await run(argv, {
		fetch: api.fetch,
		env: options.env ?? ENV,
		stdout,
		stderr,
		stdin: options.stdin ?? input(undefined, true),
		configDir,
		cwd: configDir,
	});
	return { code, stdout: stdout.text(), stderr: stderr.text(), calls: api.calls };
}

describe("parsing", () => {
	const specs = {
		name: { type: "string", description: "" },
		label: { type: "string", multiple: true, description: "" },
		all: { type: "boolean", description: "" },
		wait: { type: "boolean", description: "" },
		help: { type: "boolean", short: "h", description: "" },
	} as const;

	it("reads --flag value, --flag=value, repeats, booleans and what follows --", () => {
		const parsed = parseArgs(
			["a", "--name", "x", "--label=k=v", "--label", "j=w", "--all", "--no-wait", "-h", "b", "--", "ls", "--all"],
			specs,
		);
		expect(parsed.flags).toEqual({ name: "x", label: ["k=v", "j=w"], all: true, wait: false, help: true });
		expect(parsed.positionals).toEqual(["a", "b"]);
		expect(parsed.rest).toEqual(["ls", "--all"]);
	});

	it("leaves rest undefined with no --, and takes --flag=false", () => {
		const parsed = parseArgs(["--all=false", "x"], specs);
		expect(parsed.flags).toEqual({ all: false });
		expect(parsed.rest).toBeUndefined();
	});

	it("refuses an unknown flag and a flag with no value", () => {
		expect(() => parseArgs(["--nope"], specs)).toThrow(/unknown flag --nope/);
		expect(() => parseArgs(["--name"], specs)).toThrow(/--name needs a value/);
		expect(() => parseArgs(["--name", "--all"], specs)).toThrow(/--name needs a value/);
	});

	it("quotes several words after -- for the shell, and keeps one as a command line", () => {
		expect(commandLine(["sh", "-c", "echo hi; exit 3"])).toBe("sh -c 'echo hi; exit 3'");
		expect(commandLine(["echo", "it's"])).toBe("echo 'it'\\''s'");
		expect(commandLine(["make && make test"])).toBe("make && make test");
	});

	it("finds a command after global flags, and its aliases", async () => {
		const routes = { "GET /v1/sandboxes": (): SandboxPage => ({ items: [SANDBOX] }) };
		const listed = await kantel(["--url", "https://kantel.test", "sb", "ls", "--all"], { routes });
		expect(listed.code).toBe(0);
		expect(listed.calls[0]?.query.get("all")).toBe("true");
		expect(listed.stdout).toContain("brave-otter");
	});

	it("generates help from the command table", async () => {
		const help = await kantel(["help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("sandbox create");
		expect(help.stdout).toContain("exec <id> -- <command…>");
		const create = await kantel(["sandbox", "create", "--help"]);
		expect(create.stdout).toContain("--no-wait");
		expect(create.stdout).toContain("--label <k=v>…");
		const group = await kantel(["sandbox"]);
		expect(group.stdout).toContain("sandbox delete <id>");
	});

	it("exits 2 on an unknown command or a missing argument, without calling Kantel", async () => {
		const unknown = await kantel(["frobnicate"]);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain('there is no command "frobnicate"');
		const missing = await kantel(["sandbox", "get"]);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("needs <id>");
		expect(missing.stderr).toContain("Usage: kantel sandbox get <id>");
		expect(missing.calls).toEqual([]);
	});

	it("prints the version", async () => {
		const version = await kantel(["--version"]);
		expect(version.code).toBe(0);
		expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("exec", () => {
	it("routes stdout and stderr to the matching streams and exits with the command's exit code", async () => {
		const result = await kantel(
			["exec", "sbx_test1", "--cwd", "/app", "--env", "A=1", "--timeout", "5000", "--", "sh", "-c", "echo hi; exit 3"],
			{
				routes: {
					"POST /v1/sandboxes/sbx_test1/commands": () => command({ exitCode: 3, stdout: "out\n", stderr: "err\n" }),
				},
			},
		);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("out\n");
		expect(result.stderr).toBe("err\n");
		expect(result.calls[0]?.body).toEqual({
			command: "sh -c 'echo hi; exit 3'",
			cwd: "/app",
			env: { A: "1" },
			timeoutMs: 5000,
		});
		expect(result.calls[0]?.authorization).toBe("Bearer ksk_test");
	});

	it("exits 0 for a command that succeeds, and 124 for one that timed out", async () => {
		const ok = await kantel(["exec", "sbx_test1", "--", "true"], {
			routes: { "POST /v1/sandboxes/sbx_test1/commands": () => command({ exitCode: 0, stdout: "fine\n" }) },
		});
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe("fine\n");
		const slow = await kantel(["exec", "sbx_test1", "--timeout", "10", "--", "sleep 5"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": () => command({ state: "timed_out", exitCode: undefined }),
			},
		});
		expect(slow.code).toBe(124);
		expect(slow.stderr).toContain("timed out after 10 ms");
	});

	it("prints the command as JSON with --json, still exiting with its code", async () => {
		const answer = command({ exitCode: 2, stdout: "x" });
		const result = await kantel(["exec", "sbx_test1", "--json", "--", "false"], {
			routes: { "POST /v1/sandboxes/sbx_test1/commands": () => answer },
		});
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toEqual(answer);
	});

	it("needs the command after --", async () => {
		const none = await kantel(["exec", "sbx_test1"]);
		expect(none.code).toBe(2);
		expect(none.stderr).toContain("give the command after --");
		const unseparated = await kantel(["exec", "sbx_test1", "ls"]);
		expect(unseparated.code).toBe(2);
		expect(unseparated.stderr).toContain("after --");
		expect(unseparated.calls).toEqual([]);
	});
});

describe("sandboxes", () => {
	it("refuses to delete a sandbox without --yes, and calls Kantel nothing", async () => {
		const routes = { "DELETE /v1/sandboxes/sbx_test1": () => ({ ...SANDBOX, state: "deleting" }) };
		const refused = await kantel(["sandbox", "delete", "sbx_test1"], { routes });
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain("permanent");
		expect(refused.calls).toEqual([]);
		const deleted = await kantel(["sandbox", "rm", "sbx_test1", "--yes"], { routes });
		expect(deleted.code).toBe(0);
		expect(deleted.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /v1/sandboxes/sbx_test1"]);
		expect(deleted.stdout).toContain("deleting");
	});

	it("creates a sandbox and waits for it by default", async () => {
		const routes = { "POST /v1/sandboxes": () => SANDBOX };
		const created = await kantel(["sandbox", "create", "--type", "microvm", "--label", "task=PROJ-12"], { routes });
		expect(created.code).toBe(0);
		expect(created.calls[0]?.body).toEqual({ type: "microvm", labels: { task: "PROJ-12" }, wait: true });
		expect(created.stdout).toContain("Created sbx_test1");
		const unwaited = await kantel(["sandbox", "create", "--no-wait", "--auto-stop", "never"], { routes });
		expect(unwaited.calls[0]?.body).toEqual({ autoStopMinutes: null, wait: false });
		const wrong = await kantel(["sandbox", "create", "--type", "vm"], { routes });
		expect(wrong.code).toBe(2);
		expect(wrong.calls).toEqual([]);
	});

	it("prints Kantel's answer as it is with --json, and compact text without", async () => {
		const page: SandboxPage = { items: [SANDBOX], nextCursor: "c2" };
		const routes = { "GET /v1/sandboxes": () => page };
		const asJson = await kantel(["sandbox", "list", "--json"], { routes });
		expect(asJson.code).toBe(0);
		expect(JSON.parse(asJson.stdout)).toEqual(page);
		const asText = await kantel(["sandbox", "list"], { routes });
		expect(asText.stdout).toMatch(/^ID\s+NAME\s+TYPE\s+STATE/);
		expect(asText.stdout).toContain("kantel sandbox list --cursor c2");
	});

	it("pauses with stop --pause", async () => {
		const routes = { "POST /v1/sandboxes/sbx_test1/stop": () => ({ ...SANDBOX, state: "paused" }) };
		const paused = await kantel(["sandbox", "stop", "sbx_test1", "--pause"], { routes });
		expect(paused.code).toBe(0);
		expect(paused.calls[0]?.body).toEqual({ keepMemory: true });
		expect(paused.stdout).toBe("sbx_test1 paused\n");
	});
});

describe("errors", () => {
	it("prints a Kantel error as kantel: <code>: <message> and exits 1", async () => {
		const routes = { "GET /v1/sandboxes/sbx_gone": () => kantelError(404, "not_found", "No such sandbox") };
		const result = await kantel(["sandbox", "get", "sbx_gone"], { routes });
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("kantel: not_found: No such sandbox\n");
		expect(result.stdout).toBe("");
	});

	it("tells an unauthenticated caller to log in", async () => {
		const routes = { "GET /v1/whoami": () => kantelError(401, "unauthenticated", "A bearer is needed") };
		const result = await kantel(["whoami"], { routes, env: { KANTEL_URL: "https://kantel.test" } });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("kantel: unauthenticated: A bearer is needed");
		expect(result.stderr).toContain("npx kantel login");
	});

	it("says which Kantel it couldn't reach", async () => {
		const stdout = capture();
		const stderr = capture();
		const code = await run(["whoami"], {
			fetch: async () => {
				throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
			},
			env: ENV,
			stdout,
			stderr,
			configDir,
		});
		expect(code).toBe(1);
		expect(stderr.text()).toBe("kantel: couldn't reach Kantel at https://kantel.test: connect ECONNREFUSED\n");
	});
});

describe("config", () => {
	it("normalises the URL to <origin>/v1", () => {
		expect(normaliseUrl("https://kantel.example")).toBe("https://kantel.example/v1");
		expect(normaliseUrl("https://kantel.example/v1/")).toBe("https://kantel.example/v1");
		expect(normaliseUrl("kantel.example")).toBe("https://kantel.example/v1");
		expect(normaliseUrl("localhost:58090")).toBe("http://localhost:58090/v1");
		expect(() => normaliseUrl("ftp://kantel.example")).toThrow();
	});

	it("takes each setting from the flags, then the environment, then the file", () => {
		const file = { url: "https://file.test", apiKey: "ksk_file", account: "acc_file" };
		const env = { KANTEL_URL: "https://env.test", KANTEL_API_KEY: "ksk_env" };
		expect(resolveConfig({}, {}, {})).toEqual({ url: `${DEFAULT_URL}/v1`, apiKey: undefined, account: undefined });
		expect(resolveConfig({}, {}, file)).toEqual({
			url: "https://file.test/v1",
			apiKey: "ksk_file",
			account: "acc_file",
		});
		expect(resolveConfig({}, env, file)).toEqual({
			url: "https://env.test/v1",
			apiKey: "ksk_env",
			account: "acc_file",
		});
		expect(resolveConfig({ url: "https://flag.test", apiKey: "ksk_flag" }, env, file)).toEqual({
			url: "https://flag.test/v1",
			apiKey: "ksk_flag",
			account: "acc_file",
		});
	});

	it("calls the Kantel and key the flags, the environment or the file name, in that order", async () => {
		await writeFile(join(configDir, "config.json"), JSON.stringify({ url: "https://file.test", apiKey: "ksk_file" }));
		const routes = { "GET /v1/whoami": () => CALLER };
		const fromFile = await kantel(["whoami"], { routes, env: {} });
		expect(fromFile.calls[0]?.url).toBe("https://file.test/v1/whoami");
		expect(fromFile.calls[0]?.authorization).toBe("Bearer ksk_file");
		const env = { KANTEL_URL: "https://env.test/v1", KANTEL_API_KEY: "ksk_env" };
		const fromEnv = await kantel(["whoami"], { routes, env });
		expect(fromEnv.calls[0]?.url).toBe("https://env.test/v1/whoami");
		expect(fromEnv.calls[0]?.authorization).toBe("Bearer ksk_env");
		const fromFlags = await kantel(["--key", "ksk_flag", "whoami", "--url=https://flag.test"], { routes, env });
		expect(fromFlags.calls[0]?.url).toBe("https://flag.test/v1/whoami");
		expect(fromFlags.calls[0]?.authorization).toBe("Bearer ksk_flag");
	});

	it("logs in with a key from stdin, checks it, and saves it readable by its owner only", async () => {
		const result = await kantel(["login", "--url", "https://kantel.test"], {
			env: {},
			stdin: input("ksk_piped\n"),
			routes: { "GET /v1/whoami": () => CALLER },
		});
		expect(result.code).toBe(0);
		expect(result.calls[0]?.authorization).toBe("Bearer ksk_piped");
		expect(result.stdout).toContain("Signed in to https://kantel.test");
		expect(result.stdout).not.toContain("ksk_piped");
		const path = join(configDir, "config.json");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "https://kantel.test/v1", apiKey: "ksk_piped" });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const after = await kantel(["logout"], { env: {} });
		expect(after.code).toBe(0);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: "https://kantel.test/v1" });
	});

	it("won't log in with no key when stdin is a terminal", async () => {
		const result = await kantel(["login"], { env: {}, stdin: input(undefined, true) });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--key");
		expect(result.calls).toEqual([]);
	});
});

describe("agents", () => {
	const SECRET = "ksk_supersecret_5n2p8r";
	const env = { KANTEL_URL: "https://kantel.example/v1", KANTEL_API_KEY: SECRET };

	it("never prints the real key, only the placeholder, with the resolved URL", async () => {
		for (const argv of [["agents"], ["agents", "claude"], ["agents", "all", "--json"], ["agents", "--key", SECRET]]) {
			const result = await kantel(argv, { env });
			expect(result.code).toBe(0);
			expect(result.stdout).not.toContain(SECRET);
			expect(result.stdout).toContain("$KANTEL_API_KEY");
			expect(result.stdout).toContain("https://kantel.example");
		}
		const claude = await kantel(["agents", "claude"], { env });
		expect(claude.stdout).toContain(claudeSetup("https://kantel.example"));
		expect(claude.stdout).toContain("npx kantel key create agent --preset agent");
		expect(claude.stdout).not.toContain("codex mcp add");
	});

	it("gives each harness its one line", () => {
		expect(claudeSetup("https://kantel.example")).toBe(
			"claude mcp add kantel -e KANTEL_URL=https://kantel.example -e KANTEL_API_KEY=$KANTEL_API_KEY " +
				"-- npx -y kantel mcp",
		);
	});

	it("writes the AGENTS.md block, replacing an old one", async () => {
		const path = join(configDir, "AGENTS.md");
		await writeFile(path, `# Agents\n\nBe kind.\n\n${AGENTS_START}\nold\n${AGENTS_END}\n\nAfter.\n`);
		const result = await kantel(["agents", "--write"], { env });
		expect(result.code).toBe(0);
		const written = await readFile(path, "utf8");
		expect(written.startsWith("# Agents\n\nBe kind.\n\n<!-- kantel:start -->")).toBe(true);
		expect(written.endsWith(`${AGENTS_END}\n\nAfter.\n`)).toBe(true);
		expect(written).not.toContain("\nold\n");
		expect(written.split(AGENTS_START)).toHaveLength(2);
		expect(written).toContain("npx kantel exec <id> -- <cmd>");
		expect(written).not.toContain(SECRET);
	});

	it("adds the block to a file without one, or makes the file", () => {
		expect(upsertAgentsBlock(undefined, "B")).toBe("B\n");
		expect(upsertAgentsBlock("# Agents", "B")).toBe("# Agents\n\nB\n");
		expect(upsertAgentsBlock(`x\n${AGENTS_START}\na\n${AGENTS_END}\ny\n`, `${AGENTS_START}\nb\n${AGENTS_END}`)).toBe(
			`x\n${AGENTS_START}\nb\n${AGENTS_END}\ny\n`,
		);
	});
});
