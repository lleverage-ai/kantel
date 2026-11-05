// The kantel command line, through `run`, with a fake Kantel behind an injected fetch and a temporary config directory.
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, Command, Host, Sandbox, SandboxPage } from "@kantel/api/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENTS_END,
	AGENTS_START,
	claudeSetup,
	codexSetup,
	codexToml,
	mcpServersJson,
	upsertAgentsBlock,
} from "../src/agents.ts";
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
	/** Each call's `Idempotency-Key`, or null. */
	const keys: (string | null)[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const authorization = new Headers(init?.headers).get("authorization");
		const call: Call = { method, url: url.href, path: url.pathname, query: url.searchParams, body, authorization };
		calls.push(call);
		keys.push(new Headers(init?.headers).get("idempotency-key"));
		const route = routes[`${method} ${url.pathname}`];
		if (route === undefined) return kantelError(404, "not_found", `No route ${method} ${url.pathname}`);
		const answer = await route(call);
		if (answer instanceof Response) return answer;
		return answer === undefined ? new Response(null, { status: 204 }) : json(answer);
	};
	return { fetch, calls, keys };
}

function capture(isTTY = false) {
	const chunks: string[] = [];
	const decoder = new TextDecoder();
	return {
		isTTY,
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
	grants: [],
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
	usage: { runningSeconds: 0, cpuSeconds: 0, recentCpu: [], recentMemory: [] },
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
	/** stdout is a terminal, as when a person runs it. */
	readonly tty?: boolean;
	readonly cwd?: string;
	/** This CLI by its full paths, for `agents` when `kantel` isn't on the PATH. */
	readonly self?: readonly string[];
	/** Kantel's config directory; default the temporary one. */
	readonly configDir?: string;
}

/** The `self` every run gets unless it says otherwise: Node and the installed CLI's link. */
const SELF = ["/usr/local/bin/node", "/home/me/.local/bin/kantel"];

async function kantel(argv: readonly string[], options: KantelOptions = {}) {
	const api = fakeKantel(options.routes ?? {});
	const stdout = capture(options.tty);
	const stderr = capture();
	const opened: string[] = [];
	const slept: number[] = [];
	const code = await run(argv, {
		fetch: api.fetch,
		env: options.env ?? ENV,
		stdout,
		stderr,
		stdin: options.stdin ?? input(undefined, true),
		configDir: options.configDir ?? configDir,
		cwd: options.cwd ?? configDir,
		home: join(configDir, "home"),
		self: options.self ?? SELF,
		openUrl: (url) => opened.push(url),
		sleep: async (ms) => {
			slept.push(ms);
		},
	});
	return { code, stdout: stdout.text(), stderr: stderr.text(), calls: api.calls, keys: api.keys, opened, slept };
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
		expect(() => parseArgs(["-x"], specs)).toThrow(/unknown flag -x/);
	});

	it("takes a word that starts with one dash as an argument when asked, since aliases are one letter", () => {
		// A base64url genesis starts with "-" one time in 64 (this one failed Main CI as "unknown flag -qWbW…").
		const genesis = "-qWbW7snP-gnS05KGEXLZGvxASDaweXJ8s3WBAU8llQ";
		const argv = ["org_1", genesis, "--all", "-h", "-5", "--name", "-n-"];
		const parsed = parseArgs(argv, specs, { dashArguments: true });
		expect(parsed.positionals).toEqual(["org_1", genesis, "-5"]);
		expect(parsed.flags).toEqual({ all: true, help: true, name: "-n-" });
		expect(() => parseArgs(["-x"], specs, { dashArguments: true })).toThrow(/unknown flag -x/);
		// Otherwise it is an unknown flag, as before.
		expect(() => parseArgs(argv, specs)).toThrow(`unknown flag ${genesis}`);
		// One that starts with "--" goes after --.
		expect(parseArgs(["org_1", "--", `-${genesis}`], specs).rest).toEqual([`-${genesis}`]);
	});

	it("joins an E2E chain from a genesis that starts with a dash, and says so for one that starts with two", async () => {
		const routes = { "GET /v1/whoami": (): Caller => ({ ...CALLER, user: { id: "usr_bob", name: "Bob" } }) };
		const genesis = "-qWbW7snP-gnS05KGEXLZGvxASDaweXJ8s3WBAU8llQ";
		const joined = await kantel(["e2e", "join", "org_1", genesis, "--json"], { routes });
		expect(joined.stderr).toBe("");
		expect(joined.code).toBe(0);
		expect(JSON.parse(joined.stdout)).toMatchObject({ space: "org_1", genesis });
		// Two dashes would be a flag; after -- it is the genesis.
		const dashes = `-${genesis.slice(0, -1)}`;
		const after = await kantel(["e2e", "join", "org_2", "--json", "--", dashes], { routes });
		expect(after.stderr).toBe("");
		expect(JSON.parse(after.stdout)).toMatchObject({ space: "org_2", genesis: dashes });
		const help = await kantel(["help", "e2e", "join"]);
		expect(help.stdout).toContain("kantel e2e join <space> -- <genesis>");
		// A mistyped flag isn't pinned as the genesis, nor taken as the space or one argument too many.
		const typo = await kantel(["e2e", "join", "org_3", "-json"], { routes });
		expect(typo.code).toBe(2);
		expect(typo.stderr).toContain(`"-json" isn't a genesis`);
		for (const argv of [
			["e2e", "join", "org_3", genesis, "-json"],
			["e2e", "join", "-json", genesis],
		]) {
			const refused = await kantel(argv, { routes });
			expect(refused.code, argv.join(" ")).toBe(2);
			expect(refused.stderr).toContain("unknown flag -json");
		}
		// A command with no such argument still refuses one before it calls Kantel.
		const info = await kantel(["info", "sbx_test1", "-json"]);
		expect(info.code).toBe(2);
		expect(info.stderr).toContain("unknown flag -json");
		expect(info.calls).toEqual([]);
		expect(await readFile(join(configDir, "e2e", "spaces", "org_3.json"), "utf8").catch(() => "none")).toBe("none");
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
		expect(help.stdout).toMatch(/^ {2}new {2,}Create a sandbox/m);
		expect(help.stdout).toContain("exec <id> [command…] -- <command…>");
		expect(help.stdout).not.toContain("port expose");
		const create = await kantel(["sandbox", "create", "--help"]);
		expect(create.stdout).toContain("Usage: kantel new");
		expect(create.stdout).toContain("--no-wait");
		expect(create.stdout).toContain("--label <k=v>…");
		const group = await kantel(["sandbox"]);
		expect(group.stdout).toContain("delete <id>");
	});

	it("exits 2 on an unknown command or a missing argument, without calling Kantel", async () => {
		const unknown = await kantel(["frobnicate"]);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain('there is no command "frobnicate"');
		const missing = await kantel(["sandbox", "get"]);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("needs <id>");
		expect(missing.stderr).toContain("Usage: kantel info <id>");
		expect(missing.calls).toEqual([]);
	});

	it("takes boat-style verbs, and the first CLI's sandbox … spellings", async () => {
		const stopped = { ...SANDBOX, state: "stopped" };
		const routes = {
			"GET /v1/sandboxes/sbx_test1": () => SANDBOX,
			"POST /v1/sandboxes/sbx_test1/stop": () => stopped,
			"POST /v1/sandboxes/sbx_test1/resume": () => SANDBOX,
		};
		for (const argv of [
			["info", "sbx_test1"],
			["get", "sbx_test1"],
			["sandbox", "get", "sbx_test1"],
			["sb", "info", "sbx_test1"],
		]) {
			const result = await kantel(argv, { routes });
			expect(result.code, argv.join(" ")).toBe(0);
			expect(result.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/sandboxes/sbx_test1"]);
		}
		expect((await kantel(["stop", "sbx_test1"], { routes })).stdout).toBe("sbx_test1 stopped\n");
		expect((await kantel(["sandbox", "resume", "sbx_test1"], { routes })).stdout).toBe("sbx_test1 running\n");
	});

	it("sends operators' commands to kantel-admin", async () => {
		const moved = await kantel(["host", "join-token"]);
		expect(moved.code).toBe(2);
		expect(moved.stderr).toContain("kantel-admin host add");
		expect(moved.calls).toEqual([]);
	});

	it("prints the version", async () => {
		const version = await kantel(["--version"]);
		expect(version.code).toBe(0);
		expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("retries", () => {
	it("sends a call that takes an Idempotency-Key again with the same key when Kantel can't be reached", async () => {
		let attempts = 0;
		const result = await kantel(["exec", "sbx_test1", "--", "make"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": () => {
					attempts++;
					if (attempts === 1) throw new TypeError("fetch failed");
					if (attempts === 2) return new Response("Bad gateway", { status: 502 });
					return command({ exitCode: 0, stdout: "built\n" });
				},
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("built\n");
		expect(result.calls).toHaveLength(3);
		expect(result.keys[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(new Set(result.keys)).toEqual(new Set([result.keys[0]]));
		expect(result.slept).toEqual([500, 2_000]);
	});

	it("gives each invocation its own key, and gives up after the last retry", async () => {
		const routes = { "POST /v1/sandboxes/sbx_test1/commands": () => command({}) };
		const first = await kantel(["exec", "sbx_test1", "--", "true"], { routes });
		const second = await kantel(["exec", "sbx_test1", "--", "true"], { routes });
		expect(first.keys[0]).not.toBe(second.keys[0]);

		const down = await kantel(["exec", "sbx_test1", "--", "true"], {
			routes: { "POST /v1/sandboxes/sbx_test1/commands": () => new Response("Unavailable", { status: 503 }) },
		});
		expect(down.code).not.toBe(0);
		expect(down.calls).toHaveLength(3);
	});

	it("sends a keyed call once when Kantel itself answers, even a 503, and never loops on a held key's 409", async () => {
		for (const answer of [
			() => kantelError(503, "unavailable", "The host didn't answer the command; its outcome is unknown"),
			() =>
				json(
					{
						error: {
							code: "conflict",
							message: "A call with this Idempotency-Key didn't finish: check, then use a new key",
							details: { idempotencyKey: "held" },
						},
					},
					409,
				),
		]) {
			const result = await kantel(["exec", "sbx_test1", "--", "make"], {
				routes: { "POST /v1/sandboxes/sbx_test1/commands": answer },
			});
			expect(result.code).not.toBe(0);
			expect(result.calls).toHaveLength(1);
			expect(result.slept).toEqual([]);
		}
	});

	it("sends a newer keyed call with its key but once, as an older control plane would do it again", async () => {
		// A control plane from before this route took keys: the save happened, and only its answer was lost.
		let saves = 0;
		const result = await kantel(["snapshot", "save", "sbx_test1", "base"], {
			routes: {
				"POST /v1/snapshots": () => {
					saves++;
					return new Response("Bad gateway", { status: 502 });
				},
			},
		});
		expect(result.code).not.toBe(0);
		expect(saves).toBe(1);
		expect(result.keys[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(result.slept).toEqual([]);
	});

	it("sends a call that takes no key once, however it fails", async () => {
		const result = await kantel(["stop", "sbx_test1"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/stop": () => {
					throw new TypeError("fetch failed");
				},
			},
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("couldn't reach Kantel");
		expect(result.calls).toHaveLength(1);
		expect(result.keys).toEqual([null]);
		expect(result.slept).toEqual([]);
	});
});

describe("exec", () => {
	it("routes stdout and stderr to the matching streams and exits with the command's exit code", async () => {
		const result = await kantel(
			["exec", "sbx_test1", "--cwd", "/app", "--env", "A=1", "--timeout", "5", "--", "sh", "-c", "echo hi; exit 3"],
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
		expect(slow.stderr).toContain("timed out after 10 s");
		expect(slow.calls[0]?.body).toEqual({ command: "sleep 5", timeoutMs: 10_000 });
	});

	it("prints the command as JSON with --json, still exiting with its code", async () => {
		const answer = command({ exitCode: 2, stdout: "x" });
		const result = await kantel(["exec", "sbx_test1", "--json", "--", "false"], {
			routes: { "POST /v1/sandboxes/sbx_test1/commands": () => answer },
		});
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toEqual(answer);
	});

	it("needs a command, which may come without --", async () => {
		const none = await kantel(["exec", "sbx_test1"]);
		expect(none.code).toBe(2);
		expect(none.stderr).toContain("give the command");
		expect(none.calls).toEqual([]);
		const routes = { "POST /v1/sandboxes/sbx_test1/commands": () => command({}) };
		const unseparated = await kantel(["exec", "sbx_test1", "make && make test"], { routes });
		expect(unseparated.code).toBe(0);
		expect(unseparated.calls[0]?.body).toEqual({ command: "make && make test" });
	});

	it("detaches, printing the command's ID, and attach follows it to its exit code", async () => {
		const started = await kantel(["exec", "sbx_test1", "-d", "--", "npm", "run", "dev"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": () => command({ state: "running", exitCode: undefined }),
			},
		});
		expect(started.code).toBe(0);
		expect(started.stdout).toBe("cmd_1\n");
		expect(started.stderr).toContain("kantel attach sbx_test1 cmd_1");
		expect(started.calls[0]?.body).toEqual({ command: "npm run dev", detached: true });

		const views = [
			command({ state: "running", exitCode: undefined, stdout: "one\n" }),
			command({ state: "running", exitCode: undefined, stdout: "one\ntwo\n", stderr: "warn\n" }),
			command({ state: "exited", exitCode: 4, stdout: "one\ntwo\nthree\n", stderr: "warn\n" }),
		];
		const attached = await kantel(["attach", "sbx_test1", "cmd_1"], {
			routes: { "GET /v1/sandboxes/sbx_test1/commands/cmd_1": () => views.shift() },
		});
		expect(attached.code).toBe(4);
		expect(attached.stdout).toBe("one\ntwo\nthree\n");
		expect(attached.stderr).toBe("warn\n");
	});

	it("with --timeout 0 runs it detached and follows it", async () => {
		const views = [command({ state: "exited", exitCode: 0, stdout: "built\n" })];
		const result = await kantel(["exec", "sbx_test1", "--timeout", "0", "--", "make"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": () => command({ state: "running", exitCode: undefined }),
				"GET /v1/sandboxes/sbx_test1/commands/cmd_1": () => views.shift(),
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("built\n");
		expect(result.calls[0]?.body).toEqual({ command: "make", detached: true });
		// Its ID, and how to follow it again, from the start.
		expect(result.stderr).toContain("kantel attach sbx_test1 cmd_1 follows it again");
	});

	it("follows a command on while Kantel is out of reach for a moment, printing each part of its output once", async () => {
		const dropped = new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
		const views: (Command | Response | Error)[] = [
			command({ state: "running", exitCode: undefined, stdout: "Reading package lists...\n" }),
			dropped,
			kantelError(503, "unavailable", "The gateway is restarting"),
			kantelError(502, "bad_gateway", "Bad gateway"),
			command({ state: "running", exitCode: undefined, stdout: "Reading package lists...\nSetting up gcc\n" }),
			command({ state: "exited", exitCode: 0, stdout: "Reading package lists...\nSetting up gcc\nDone\n" }),
		];
		const result = await kantel(["exec", "sbx_test1", "--timeout", "0", "--", "apt-get install -y gcc"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": () => command({ state: "running", exitCode: undefined }),
				"GET /v1/sandboxes/sbx_test1/commands/cmd_1": () => {
					const view = views.shift();
					if (view instanceof Error) throw view;
					return view;
				},
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("Reading package lists...\nSetting up gcc\nDone\n");
		expect(result.stderr).toContain(
			"kantel: couldn't reach Kantel at https://kantel.test: read ECONNRESET; trying again",
		);
	});

	it("gives up following once Kantel has been out of reach for a while, saying the command may still run and how to attach", async () => {
		const result = await kantel(["attach", "sbx_test1", "cmd_1"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/commands/cmd_1": () => kantelError(503, "unavailable", "The gateway is down"),
			},
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Kantel can't answer for now (The gateway is down); cmd_1 may still be running: kantel attach sbx_test1 cmd_1",
		);
		// Asked again for two minutes of waits, then no more.
		expect(result.slept.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(120_000);
		expect(result.calls.length).toBeLessThan(30);
	});

	it("doesn't ask again after an answer that won't change, such as an unknown command", async () => {
		const result = await kantel(["attach", "sbx_test1", "cmd_9"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/commands/cmd_9": () => kantelError(404, "not_found", "No such command"),
			},
		});
		expect(result.code).toBe(1);
		expect(result.calls).toHaveLength(1);
	});

	it("lists a sandbox's commands and kills one", async () => {
		const routes = {
			"GET /v1/sandboxes/sbx_test1/commands": () => ({ items: [command({ command: "npm run dev" })] }),
			"DELETE /v1/sandboxes/sbx_test1/commands/cmd_1": () => command({ state: "killed", exitCode: undefined }),
		};
		const listed = await kantel(["ps", "sbx_test1"], { routes });
		expect(listed.stdout).toMatch(/cmd_1\s+exited 0/);
		expect(listed.stdout).toContain("npm run dev");
		const killed = await kantel(["kill", "sbx_test1", "cmd_1"], { routes });
		expect(killed.code).toBe(0);
		expect(killed.stdout).toBe("cmd_1 killed\n");
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
		expect(asText.stdout).toContain("kantel list --cursor c2");
	});

	it("pauses with stop --pause", async () => {
		const routes = { "POST /v1/sandboxes/sbx_test1/stop": () => ({ ...SANDBOX, state: "paused" }) };
		const paused = await kantel(["sandbox", "stop", "sbx_test1", "--pause"], { routes });
		expect(paused.code).toBe(0);
		expect(paused.calls[0]?.body).toEqual({ keepMemory: true });
		expect(paused.stdout).toBe("sbx_test1 paused\n");
	});
});

describe("hosts", () => {
	const HOST: Host = {
		id: "host_own1",
		name: "tom-box",
		state: "online",
		version: "0.4.0",
		os: "linux",
		arch: "x86_64",
		tiers: ["microvm", "isolate"],
		kvm: true,
		nestedVirtualisation: false,
		capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
		allocated: { sandboxes: 2, vcpus: 4, memoryMb: 4096, diskGb: 40 },
		labels: { site: "home" },
		accountId: "acc_org",
		joinedAt: Date.now(),
		lastSeenAt: Date.now(),
	};

	it("makes a join token for the account it acts in and prints the command to run on the machine", async () => {
		const routes = {
			"POST /v1/hosts/join-tokens": (call: Call) => ({
				id: "enr_1",
				accountId: (call.body as { account: string }).account,
				token: "kth_secret",
				command: "curl -fsSL https://x/install.sh | sudo sh -s -- --url https://kantel.test --token kth_secret",
				expiresAt: Date.now() + 3_600_000,
			}),
		};
		const enrolled = await kantel(
			["hosts", "add", "tom-box", "--label", "site=home", "--expires", "30", "--account", "acc_org"],
			{ routes },
		);
		expect(enrolled.code).toBe(0);
		expect(enrolled.calls[0]?.body).toEqual({
			account: "acc_org",
			name: "tom-box",
			labels: { site: "home" },
			expiresInMinutes: 30,
		});
		expect(enrolled.stdout).toContain("--token kth_secret");
		expect(enrolled.stdout).toContain("It joins account acc_org");
		// Too short a token's life is refused before calling Kantel.
		const short = await kantel(["hosts", "add", "--expires", "1"], { routes });
		expect(short.code).toBe(2);
		expect(short.calls).toEqual([]);
	});

	it("lists, shows, drains and removes the account's hosts", async () => {
		const routes = {
			"GET /v1/hosts": () => ({ items: [HOST] }),
			"GET /v1/hosts/host_own1": () => HOST,
			"PATCH /v1/hosts/host_own1": (call: Call) => ({
				...HOST,
				state: (call.body as { draining: boolean }).draining ? "draining" : "online",
			}),
			"DELETE /v1/hosts/host_own1": () => ({ ...HOST, state: "revoked" }),
		};
		const listed = await kantel(["hosts", "ls"], { routes });
		expect(listed.stdout).toMatch(/^ID\s+NAME\s+STATE\s+TIERS\s+SANDBOXES/);
		expect(listed.stdout).toContain("host_own1");
		const shown = await kantel(["hosts", "info", "host_own1"], { routes });
		expect(shown.stdout).toContain("acc_org");
		expect(shown.stdout).toContain("site=home");
		const drained = await kantel(["hosts", "drain", "host_own1"], { routes });
		expect(drained.calls[0]?.body).toEqual({ draining: true });
		expect(drained.stdout).toContain("draining");
		const undrained = await kantel(["hosts", "drain", "host_own1", "--off"], { routes });
		expect(undrained.calls[0]?.body).toEqual({ draining: false });
		const removed = await kantel(["hosts", "rm", "host_own1"], { routes });
		expect(removed.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /v1/hosts/host_own1"]);
		expect(removed.stdout).toContain("revoked");
		const empty = await kantel(["hosts", "list"], { routes: { "GET /v1/hosts": () => ({ items: [] }) } });
		expect(empty.stdout).toContain("kantel hosts add");
	});

	it("passes on a deployment's refusal while account hosts are off", async () => {
		const routes = {
			"GET /v1/hosts": () =>
				kantelError(501, "not_supported", "Account hosts are off on this deployment (KANTEL_ACCOUNT_HOSTS)"),
		};
		const result = await kantel(["hosts", "list"], { routes });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not_supported: Account hosts are off");
	});

	it("keeps `host` for a sandbox's port and points the operators' host commands at kantel-admin", async () => {
		const moved = await kantel(["host", "list"], { routes: {} });
		expect(moved.code).toBe(2);
		expect(moved.stderr).toContain("kantel-admin host list (your own hosts: kantel hosts list)");
		expect(moved.calls).toEqual([]);
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

	it("names why a sandbox can't be placed", async () => {
		const routes = {
			"POST /v1/sandboxes": () =>
				json(
					{
						error: {
							code: "exhausted",
							message: "The account may run 5 sandboxes at once",
							details: { reason: "account_limit" },
						},
					},
					429,
				),
		};
		const result = await kantel(["sandbox", "create"], { routes });
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("kantel: exhausted: The account may run 5 sandboxes at once (reason: account_limit)\n");
	});

	it("tells the caller how to resume a sandbox that isn't running", async () => {
		const notRunning = (code: string, state: string, message: string, stopReason?: string) => () =>
			json(
				{
					error: {
						code: "conflict",
						message,
						details: {
							code,
							sandboxId: "sbx_test1",
							state,
							...(stopReason === undefined ? {} : { stopReason }),
							hint: "Resume it with kantel resume sbx_test1 or POST /v1/sandboxes/sbx_test1/resume, then try again",
						},
					},
				},
				409,
			);
		const stopped = await kantel(["exec", "sbx_test1", "ls"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": notRunning(
					"sandbox_stopped",
					"stopped",
					"The sandbox is stopped (auto-stop); resume it first",
					"auto-stop",
				),
			},
		});
		expect(stopped.code).toBe(1);
		expect(stopped.stderr).toBe(
			"kantel: conflict: The sandbox is stopped (auto-stop); resume it first\nResume it with: kantel resume sbx_test1\n",
		);

		const starting = await kantel(["exec", "sbx_test1", "ls"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/commands": notRunning(
					"sandbox_starting",
					"starting",
					"The sandbox is still starting after 60 seconds; send the call again",
				),
			},
		});
		expect(starting.stderr).toContain("It is still starting: run the command again in a moment.");

		// A conflict of another kind prints no hint.
		const other = await kantel(["exec", "sbx_test1", "ls"], {
			routes: { "POST /v1/sandboxes/sbx_test1/commands": () => kantelError(409, "conflict", "Busy") },
		});
		expect(other.stderr).toBe("kantel: conflict: Busy\n");
	});

	it("tells an unauthenticated caller to log in", async () => {
		const routes = { "GET /v1/whoami": () => kantelError(401, "unauthenticated", "A bearer is needed") };
		const result = await kantel(["whoami"], { routes, env: { KANTEL_URL: "https://kantel.test" } });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("kantel: unauthenticated: A bearer is needed");
		expect(result.stderr).toContain("Sign in with: kantel login");
		expect(result.stderr).not.toContain("npx");
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
		const result = await kantel(["login", "--key-stdin", "--url", "https://kantel.test"], {
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

	it("won't log in with --key-stdin and nothing on stdin", async () => {
		const result = await kantel(["login", "--key-stdin"], { env: {}, stdin: input("") });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("no key on stdin");
		expect(result.calls).toEqual([]);
	});
});

describe("agents", () => {
	const SECRET = "ksk_supersecret_5n2p8r";
	/** Kantel's URL and key, with a PATH that has an installed `kantel` on it. */
	let env: { readonly [name: string]: string } = {};
	/** The same with nothing on the PATH. */
	let bare: { readonly [name: string]: string } = {};

	beforeEach(async () => {
		const bin = join(configDir, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "kantel"), "#!/bin/sh\n");
		await chmod(join(bin, "kantel"), 0o755);
		const empty = join(configDir, "empty");
		await mkdir(empty);
		bare = { KANTEL_URL: "https://kantel.example/v1", KANTEL_API_KEY: SECRET, PATH: empty };
		env = { ...bare, PATH: [empty, bin].join(":") };
	});

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
		expect(claude.stdout).toContain("kantel key create agent --preset agent");
		expect(claude.stdout).not.toContain("codex mcp add");
	});

	it("gives each harness its one line, running the installed kantel rather than npx", () => {
		const url = "https://kantel.example";
		expect(claudeSetup(url)).toBe(
			"claude mcp add kantel -e KANTEL_URL=https://kantel.example -e KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp",
		);
		expect(codexSetup(url)).toBe(
			"codex mcp add kantel --env KANTEL_URL=https://kantel.example --env KANTEL_API_KEY=$KANTEL_API_KEY -- kantel mcp",
		);
		expect(codexToml(url)).toContain('command = "kantel"\nargs = ["mcp"]\n');
		expect(codexToml(url)).toContain("\ntool_timeout_sec = 660");
		expect(JSON.parse(mcpServersJson(url))).toMatchObject({
			mcpServers: { kantel: { command: "kantel", args: ["mcp"] } },
		});
	});

	it("prints no npx anywhere, and kantel mcp when kantel is on the PATH", async () => {
		const text = await kantel(["agents"], { env });
		expect(text.stdout).not.toContain("npx");
		expect(text.stdout).toContain("-- kantel mcp");
		expect(text.stdout).not.toContain("isn't on your PATH");
		// Each MCP client's tool timeout, long enough for Kantel's longest wait.
		expect(text.stdout).toContain('"timeout": 660000');
		expect(text.stdout).toContain("tool_timeout_sec = 660 under [mcp_servers.kantel]");
		expect(text.stdout).toContain("at least 660 s");
		const json = JSON.parse((await kantel(["agents", "--json"], { env })).stdout) as {
			readonly mcp: unknown;
			readonly mcpServers: unknown;
			readonly codexToml: string;
		};
		expect(json.mcp).toEqual({ command: "kantel", args: ["mcp"] });
		expect(json.mcpServers).toMatchObject({ mcpServers: { kantel: { command: "kantel", args: ["mcp"] } } });
		expect(JSON.stringify(json)).not.toContain("npx");
	});

	it("starts this kantel by its full path when kantel isn't on the PATH, and says so", async () => {
		const text = await kantel(["agents"], { env: bare });
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("-- /usr/local/bin/node /home/me/.local/bin/kantel mcp");
		expect(text.stdout).toContain("kantel isn't on your PATH");
		const json = JSON.parse((await kantel(["agents", "--json"], { env: bare })).stdout) as {
			readonly mcp: unknown;
			readonly mcpServers: unknown;
			readonly codexToml: string;
		};
		const launch = { command: "/usr/local/bin/node", args: ["/home/me/.local/bin/kantel", "mcp"] };
		expect(json.mcp).toEqual(launch);
		expect(json.mcpServers).toMatchObject({ mcpServers: { kantel: launch } });
		expect(json.codexToml).toContain('command = "/usr/local/bin/node"\nargs = ["/home/me/.local/bin/kantel", "mcp"]');
		// A path with a space is quoted for the shell in the one-liners.
		const spaced = await kantel(["agents", "claude"], {
			env: bare,
			self: ["/opt/my node/node", "/Users/me/Kantel CLI/kantel"],
		});
		expect(spaced.stdout).toContain("-- '/opt/my node/node' '/Users/me/Kantel CLI/kantel' mcp");
		// Not knowing where this CLI is, it stays with the name.
		const unknown = await kantel(["agents", "claude"], { env: bare, self: [] });
		expect(unknown.stdout).toContain("-- kantel mcp");
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
		expect(written).toContain('`kantel exec "$id" -- npm test`');
		expect(written).not.toContain("npx");
		expect(written).not.toContain(SECRET);
	});

	it("adds the block to a file without one, or makes the file", () => {
		expect(upsertAgentsBlock(undefined, "B")).toBe("B\n");
		expect(upsertAgentsBlock("# Agents", "B")).toBe("# Agents\n\nB\n");
		expect(upsertAgentsBlock(`x\n${AGENTS_START}\na\n${AGENTS_END}\ny\n`, `${AGENTS_START}\nb\n${AGENTS_END}`)).toBe(
			`x\n${AGENTS_START}\nb\n${AGENTS_END}\ny\n`,
		);
	});

	it("init writes AGENTS.md, CLAUDE.md and the kantel skill for Claude Code, Codex and pi, with no key", async () => {
		const project = join(configDir, "project");
		await mkdir(project);
		await writeFile(join(project, "CLAUDE.md"), "# Claude\n");
		const result = await kantel(["init"], { env, cwd: project });
		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("isn't on your PATH");
		const claude = await readFile(join(project, "CLAUDE.md"), "utf8");
		expect(claude.startsWith("# Claude\n\n<!-- kantel:start -->")).toBe(true);
		const agents = await readFile(join(project, "AGENTS.md"), "utf8");
		expect(agents).toContain("`id=$(kantel new --type microvm --json | jq -r .id)`");
		expect(agents).toContain("curl -fsSL https://kantel.dev/cli.sh | sh");
		expect(agents + claude).not.toContain("npx");
		for (const skill of [".claude/skills/kantel/SKILL.md", ".agents/skills/kantel/SKILL.md"]) {
			const text = await readFile(join(project, skill), "utf8");
			expect(text).toMatch(/^---\nname: kantel\ndescription: /);
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain("npx");
		}
		expect(agents + claude).not.toContain(SECRET);
		// Again: the block is replaced, not added twice.
		await kantel(["init"], { env, cwd: project });
		expect((await readFile(join(project, "AGENTS.md"), "utf8")).split(AGENTS_START)).toHaveLength(2);
	});

	it("init says when kantel isn't on the PATH, since what it writes runs kantel by name", async () => {
		const result = await kantel(["init"], { env: bare });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("kantel isn't on your PATH");
	});

	it("init --global installs only the skill, under the home", async () => {
		const result = await kantel(["init", "--global", "--for", "claude"], { env });
		expect(result.code).toBe(0);
		await expect(stat(join(configDir, "home", ".claude/skills/kantel/SKILL.md"))).resolves.toBeTruthy();
		await expect(stat(join(configDir, "home", ".agents/skills/kantel/SKILL.md"))).rejects.toThrow();
		await expect(stat(join(configDir, "home", "CLAUDE.md"))).rejects.toThrow();
	});
});

describe("login in the browser", () => {
	const STARTED = {
		deviceCode: "kdc_secret",
		userCode: "BCDF-GHJK",
		verificationUrl: "https://kantel.test/device",
		verificationUrlComplete: "https://kantel.test/device?code=BCDF-GHJK",
		intervalSeconds: 2,
		expiresAt: Date.now() + 15 * 60_000,
	};
	const ISSUED = { key: { id: "key_9", name: "kantel on box" }, secret: "ksk_fromdevice" };

	it("shows the code, opens the page, waits for the approval and saves the new key", async () => {
		const polls = [{ state: "pending" }, { state: "approved", issued: ISSUED }];
		const result = await kantel(["login", "--url", "https://kantel.test", "--name", "kantel on box"], {
			env: {},
			tty: true,
			routes: {
				"POST /v1/auth/device": () => STARTED,
				"POST /v1/auth/device/token": () => polls.shift(),
				"GET /v1/whoami": () => CALLER,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("BCDF-GHJK");
		expect(result.stdout).not.toContain("kdc_secret");
		expect(result.stdout).not.toContain("ksk_fromdevice");
		expect(result.opened).toEqual([STARTED.verificationUrlComplete]);
		expect(result.slept).toEqual([2000]);
		expect(result.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"POST /v1/auth/device",
			"POST /v1/auth/device/token",
			"POST /v1/auth/device/token",
			"GET /v1/whoami",
		]);
		expect(result.calls[0]?.authorization).toBeNull();
		expect(result.calls[0]?.body).toEqual({ clientName: "kantel on box" });
		expect(result.calls[1]?.body).toEqual({ deviceCode: "kdc_secret" });
		expect(result.calls[3]?.authorization).toBe("Bearer ksk_fromdevice");
		const saved = JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as { apiKey?: string };
		expect(saved.apiKey).toBe("ksk_fromdevice");
		await expect(stat(join(configDir, "login-pending.json"))).rejects.toThrow();
	});

	it("with no terminal prints the code and stops; login --wait carries on with the same code", async () => {
		const routes = {
			"POST /v1/auth/device": () => STARTED,
			"POST /v1/auth/device/token": () => ({ state: "denied" }),
		};
		const first = await kantel(["login", "--url", "https://kantel.test"], { env: {}, routes });
		expect(first.code).toBe(0);
		expect(first.stderr).toContain(STARTED.verificationUrlComplete);
		// With the --url it was given: --wait alone would ask the saved or default URL, which doesn't know the code.
		expect(first.stderr).toContain("Then run: kantel login --wait --url https://kantel.test");
		expect(first.opened).toEqual([]);
		const pending = join(configDir, "login-pending.json");
		expect((await stat(pending)).mode & 0o777).toBe(0o600);
		const waited = await kantel(["login", "--wait", "--url", "https://kantel.test"], { env: {}, routes });
		expect(waited.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/auth/device/token"]);
		expect(waited.code).toBe(1);
		expect(waited.stderr).toContain("the sign-in was denied in the browser");
		await expect(stat(pending)).rejects.toThrow();
	});

	it("with --json prints the code as JSON for an agent", async () => {
		const result = await kantel(["login", "--json", "--url", "https://kantel.test"], {
			env: {},
			routes: { "POST /v1/auth/device": () => STARTED },
		});
		expect(JSON.parse(result.stdout)).toEqual({
			event: "login_pending",
			url: STARTED.verificationUrlComplete,
			code: "BCDF-GHJK",
			expiresAt: STARTED.expiresAt,
		});
	});
});

describe("copying files", () => {
	type Written = { path: string; content: string; encoding?: string; mode?: string };

	it("push sends a directory's files (not .git), as text or base64, keeping the executable bit", async () => {
		const dir = join(configDir, "app");
		await mkdir(join(dir, "src"), { recursive: true });
		await mkdir(join(dir, ".git"));
		await writeFile(join(dir, ".git", "HEAD"), "ref");
		await writeFile(join(dir, "src", "a.ts"), "export {};\n");
		await writeFile(join(dir, "logo.bin"), Buffer.from([0xff, 0x00, 0xfe]));
		await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
		await chmod(join(dir, "run.sh"), 0o755);
		const written: Written[] = [];
		const result = await kantel(["push", "sbx_test1", "app"], {
			configDir: join(configDir, "kantel"),
			routes: {
				"PUT /v1/sandboxes/sbx_test1/files": (call) => {
					written.push(call.body as Written);
					return { path: (call.body as Written).path, size: 1 };
				},
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Pushed 3 files");
		expect(result.stdout).toContain("/home/user/app");
		const byPath = Object.fromEntries(written.map((file) => [file.path, file]));
		expect(Object.keys(byPath).sort()).toEqual(["app/logo.bin", "app/run.sh", "app/src/a.ts"]);
		expect(byPath["app/src/a.ts"]).toEqual({ path: "app/src/a.ts", content: "export {};\n", encoding: "utf8" });
		expect(byPath["app/logo.bin"]).toMatchObject({ encoding: "base64", content: "/wD+" });
		expect(byPath["app/run.sh"]?.mode).toBe("0755");
	});

	/** Pushes with `args`, answering the paths it wrote. */
	async function pushed(args: readonly string[], options: KantelOptions = {}) {
		const written: string[] = [];
		const result = await kantel(["push", "sbx_test1", ...args], {
			configDir: join(configDir, "kantel"),
			...options,
			routes: {
				"PUT /v1/sandboxes/sbx_test1/files": (call) => {
					written.push((call.body as Written).path);
					return { path: (call.body as Written).path, size: 1 };
				},
			},
		});
		return { ...result, written: written.sort() };
	}

	/** Writes each file under `dir`, making its directories. */
	async function files(dir: string, paths: readonly string[]): Promise<void> {
		for (const path of paths) {
			await mkdir(join(dir, path, ".."), { recursive: true });
			await writeFile(join(dir, path), `${path}\n`);
		}
	}

	it("push leaves credentials, agents' sign-ins and .env files behind, naming each", async () => {
		const dir = join(configDir, "app");
		await files(dir, [
			"src/a.ts",
			".env",
			".env.local",
			".env.example",
			".npmrc",
			"deep/.ssh/id_ed25519",
			"deep/.aws/credentials",
			".docker/config.json",
			".docker/daemon.json",
			".claude/settings.json",
			"pkg/.netrc",
			"loud/.SSH/id_rsa",
		]);
		const result = await pushed(["app"]);
		expect(result.code).toBe(0);
		expect(result.written).toEqual(["app/.docker/daemon.json", "app/.env.example", "app/src/a.ts"]);
		for (const line of [
			"kantel: left out .claude (an agent's sign-in and settings)",
			"kantel: left out .docker/config.json (credentials)",
			"kantel: left out .env (an environment file)",
			"kantel: left out .env.local (an environment file)",
			"kantel: left out .npmrc (it can hold a registry token)",
			"kantel: left out deep/.aws (credentials)",
			"kantel: left out deep/.ssh (credentials)",
			"kantel: left out pkg/.netrc (credentials)",
			"kantel: left out loud/.SSH (credentials)",
			"kantel: --no-default-excludes sends",
		]) {
			expect(result.stderr).toContain(line);
		}

		const all = await pushed(["app", "--no-default-excludes"]);
		expect(all.code).toBe(0);
		expect(all.written).toContain("app/deep/.ssh/id_ed25519");
		expect(all.written).toContain("app/.env");
		expect(all.stderr).not.toContain("left out");
	});

	it("push in git sends tracked agent settings and .env, never credentials or links out of the tree", async () => {
		const dir = join(configDir, "repo");
		await files(dir, [
			".claude/settings.json",
			".claude/settings.local.json",
			".env",
			".env.local",
			".ssh/config",
			"a.ts",
		]);
		await files(join(configDir, "elsewhere"), ["x"]);
		await symlink(join(configDir, "elsewhere", "x"), join(dir, "x-link"));
		await symlink(join(dir, ".ssh", "config"), join(dir, "ssh-link"));
		await symlink(join(dir, ".env.local"), join(dir, "env-link"));
		await symlink(join(dir, "a.ts"), join(dir, "a-link.ts"));
		const inRepo = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
		inRepo("init", "-q");
		inRepo(
			"add",
			"a.ts",
			".claude/settings.json",
			".env",
			".ssh/config",
			"x-link",
			"ssh-link",
			"env-link",
			"a-link.ts",
		);
		const result = await pushed(["repo"]);
		expect(result.code).toBe(0);
		expect(result.written).toEqual(["repo/.claude/settings.json", "repo/.env", "repo/a-link.ts", "repo/a.ts"]);
		expect(result.stderr).toContain("kantel: left out .claude/settings.local.json (an agent's sign-in and settings)");
		expect(result.stderr).toContain("kantel: left out .ssh (credentials)");
		expect(result.stderr).toContain("kantel: left out x-link (a link to outside the directory)");
		expect(result.stderr).toContain("kantel: left out ssh-link (a link to .ssh, credentials)");
		// Git tracks the link, not the untracked file it points to.
		expect(result.stderr).toContain("kantel: left out env-link (a link to .env.local, an environment file)");

		// A directory in the repository named like one push leaves out is pushed by its tracked files.
		const claude = await pushed(["repo/.claude"]);
		expect(claude.code).toBe(0);
		expect(claude.written).toEqual([".claude/settings.json"]);
		expect(claude.stderr).toContain("kantel: left out settings.local.json (an agent's sign-in and settings)");

		// A link out of the tree stays here even for someone who means the rest.
		const all = await pushed(["repo", "--no-default-excludes"]);
		expect(all.written).toContain("repo/.ssh/config");
		expect(all.written).not.toContain("repo/x-link");
	});

	it("push refuses the home directory, or one holding it or Kantel's config, without --allow-home", async () => {
		await files(join(configDir, "home"), ["notes.txt", ".ssh/id_ed25519"]);
		const home = await pushed(["home"]);
		expect(home.code).toBe(1);
		expect(home.stderr).toContain("is your home directory: push a project directory, or add --allow-home");
		expect(home.written).toEqual([]);
		const above = await pushed(["."]);
		expect(above.code).toBe(1);
		expect(above.stderr).toContain("holds your home directory");

		const allowed = await pushed(["home", "--allow-home"]);
		expect(allowed.code).toBe(0);
		expect(allowed.written).toEqual(["home/notes.txt"]);

		const tree = join(configDir, "tree");
		const config = join(tree, ".config", "kantel");
		await files(tree, ["a.txt", ".config/other.json"]);
		await files(config, ["e2e/device.json"]);
		await writeFile(join(config, "config.json"), "{}\n");
		const holding = await pushed(["tree"], { configDir: config });
		expect(holding.code).toBe(1);
		expect(holding.stderr).toContain("holds Kantel's config directory");
		const rest = await pushed(["tree", "--allow-home", "--no-default-excludes"], { configDir: config });
		expect(rest.code).toBe(0);
		expect(rest.written).toEqual(["tree/.config/other.json", "tree/a.txt"]);
		expect(rest.stderr).toContain("kantel: left out .config/kantel (Kantel's config, with your API key)");
		const inside = await pushed(["tree/.config/kantel", "--allow-home", "--no-default-excludes"], {
			configDir: config,
		});
		expect(inside.code).toBe(1);
		expect(inside.stderr).toContain("is in Kantel's config directory");
		expect(inside.written).toEqual([]);
	});

	it("push refuses a directory inside one it leaves out, and keeps a root's own name in mind", async () => {
		await files(join(configDir, "elsewhere"), [
			".ssh/id_ed25519",
			".ssh/keys/old",
			".docker/config.json",
			".docker/a.json",
		]);
		for (const dir of ["elsewhere/.ssh", "elsewhere/.ssh/keys"]) {
			const refused = await pushed([dir]);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("one push leaves out (credentials): add --no-default-excludes");
			expect(refused.written).toEqual([]);
		}
		expect((await pushed(["elsewhere/.ssh", "--no-default-excludes"])).written).toEqual([
			".ssh/id_ed25519",
			".ssh/keys/old",
		]);
		const docker = await pushed(["elsewhere/.docker"]);
		expect(docker.written).toEqual([".docker/a.json"]);
		expect(docker.stderr).toContain("kantel: left out config.json (credentials)");
	});

	it("push classifies files under what leads to the root: a deeper root, a linked root, a worktree", async () => {
		const inside =
			(dir: string) =>
			(...args: string[]) =>
				execFileSync("git", args, { cwd: dir, stdio: "ignore" });

		// A root deeper in an agent directory, in a repository: its untracked files still stay behind.
		const repo = join(configDir, "repo");
		await files(repo, [".cursor/rules.md", ".cursor/User/settings.json", ".cursor/User/auth.json", "a.ts"]);
		const inRepo = inside(repo);
		inRepo("init", "-q");
		inRepo("add", ".cursor/rules.md", ".cursor/User/settings.json", "a.ts");
		const deeper = await pushed(["repo/.cursor/User"]);
		expect(deeper.code).toBe(0);
		expect(deeper.written).toEqual(["User/settings.json"]);
		expect(deeper.stderr).toContain("kantel: left out auth.json (an agent's sign-in and settings)");

		// A root named .docker through a link, outside and inside a repository.
		await files(join(configDir, "elsewhere", "docker-files"), ["config.json", "daemon.json"]);
		await symlink(join(configDir, "elsewhere", "docker-files"), join(configDir, "elsewhere", ".docker"));
		const linked = await pushed(["elsewhere/.docker"]);
		expect(linked.code).toBe(0);
		expect(linked.written).toEqual([".docker/daemon.json"]);
		expect(linked.stderr).toContain("kantel: left out config.json (credentials)");
		const meant = await pushed(["elsewhere/.docker", "--no-default-excludes"]);
		expect(meant.written).toEqual([".docker/config.json", ".docker/daemon.json"]);
		await files(join(repo, "docker-files"), ["config.json", "daemon.json"]);
		await symlink(join(repo, "docker-files"), join(repo, ".docker"));
		inRepo("add", "docker-files");
		const linkedInRepo = await pushed(["repo/.docker"]);
		expect(linkedInRepo.written).toEqual([".docker/daemon.json"]);
		expect(linkedInRepo.stderr).toContain("kantel: left out config.json (credentials)");

		// A separate worktree in .claude/worktrees is a project of its own: its new files go, its .env doesn't.
		const outer = join(configDir, "outer");
		const worktree = join(outer, ".claude", "worktrees", "wt");
		await files(outer, ["README.md"]);
		await files(worktree, ["a.ts", "new.ts", ".env"]);
		inside(outer)("init", "-q");
		const inWorktree = inside(worktree);
		inWorktree("init", "-q");
		inWorktree("add", "a.ts");
		const separate = await pushed([worktree]);
		expect(separate.code).toBe(0);
		expect(separate.written).toEqual(["wt/a.ts", "wt/new.ts"]);
		expect(separate.stderr).toContain("kantel: left out .env (an environment file)");

		// The same worktree through a link in another project's .claude: still a project of its own.
		await mkdir(join(repo, ".claude", "worktrees"), { recursive: true });
		await symlink(worktree, join(repo, ".claude", "worktrees", "wt"));
		const throughLink = await pushed(["repo/.claude/worktrees/wt"]);
		expect(throughLink.code).toBe(0);
		expect(throughLink.written).toEqual(["wt/a.ts", "wt/new.ts"]);

		// An agent directory that is a link, above the root: what's under it still counts as its.
		const linkedAgent = join(configDir, "linked-agent");
		await files(linkedAgent, ["editor-state/User/settings.json", "editor-state/User/auth.json", "a.ts"]);
		await symlink(join(linkedAgent, "editor-state"), join(linkedAgent, ".cursor"));
		const inLinkedAgent = inside(linkedAgent);
		inLinkedAgent("init", "-q");
		inLinkedAgent("add", "editor-state/User/settings.json", "a.ts");
		const throughAgentLink = await pushed(["linked-agent/.cursor/User"]);
		expect(throughAgentLink.code).toBe(0);
		expect(throughAgentLink.written).toEqual(["User/settings.json"]);
		expect(throughAgentLink.stderr).toContain("kantel: left out auth.json (an agent's sign-in and settings)");

		// A repository whose top is .docker itself.
		const dockerRepo = join(configDir, "docker-home", ".docker");
		await files(dockerRepo, ["config.json", "daemon.json"]);
		inside(dockerRepo)("init", "-q");
		const dockerTop = await pushed(["docker-home/.docker"]);
		expect(dockerTop.code).toBe(0);
		expect(dockerTop.written).toEqual([".docker/daemon.json"]);
		expect(dockerTop.stderr).toContain("kantel: left out config.json (credentials)");
	});

	it("scp sends a file over 1 MiB in parts and joins them with one command", async () => {
		const big = Buffer.alloc(1024 * 1024 + 10, 7);
		await writeFile(join(configDir, "big.bin"), big);
		const written: Written[] = [];
		const result = await kantel(["scp", "big.bin", "sbx_test1:/srv/big.bin"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/files/list": () => ({ path: "/srv", items: [] }),
				"PUT /v1/sandboxes/sbx_test1/files": (call) => {
					written.push(call.body as Written);
					return { path: "x", size: 1 };
				},
				"POST /v1/sandboxes/sbx_test1/commands": () => command({}),
			},
		});
		expect(result.code).toBe(0);
		expect(written.map((file) => file.path)).toEqual(["/srv/big.bin.kantel-part-0", "/srv/big.bin.kantel-part-1"]);
		const joined = Buffer.concat(written.map((file) => Buffer.from(file.content, "base64")));
		expect(joined.equals(big)).toBe(true);
		const joining = result.calls.find((call) => call.path.endsWith("/commands"));
		expect((joining?.body as { command?: string } | undefined)?.command).toBe(
			"cat /srv/big.bin.kantel-part-0 /srv/big.bin.kantel-part-1 > /srv/big.bin && " +
				"rm -f /srv/big.bin.kantel-part-0 /srv/big.bin.kantel-part-1",
		);
	});

	it("scp downloads a file into a local directory, and a directory with -r", async () => {
		const routes = {
			"GET /v1/sandboxes/sbx_test1/files/list": (call: Call) =>
				call.query.get("path") === "out"
					? { path: "/home/user/out", items: [{ name: "a.txt", path: "/home/user/out/a.txt", kind: "file", size: 2 }] }
					: {
							path: "/home/user",
							items: [
								{ name: "out", path: "/home/user/out", kind: "directory", size: 0 },
								{ name: "note.txt", path: "/home/user/note.txt", kind: "file", size: 2 },
							],
						},
			"GET /v1/sandboxes/sbx_test1/files": (call: Call) => ({
				path: call.query.get("path"),
				content: Buffer.from(`${call.query.get("path")}!`).toString("base64"),
				encoding: "base64",
				size: 2,
			}),
		};
		const one = await kantel(["scp", "sbx_test1:note.txt", "."], { routes });
		expect(one.code).toBe(0);
		expect(await readFile(join(configDir, "note.txt"), "utf8")).toBe("note.txt!");
		const refused = await kantel(["scp", "sbx_test1:out", "."], { routes });
		expect(refused.code).toBe(2);
		expect(refused.stderr).toContain("add -r");
		const tree = await kantel(["scp", "-r", "sbx_test1:out", "."], { routes });
		expect(tree.code).toBe(0);
		expect(await readFile(join(configDir, "out", "a.txt"), "utf8")).toBe("out/a.txt!");
	});

	it("scp -r refuses a listing that names a file outside the directory, writing nothing", async () => {
		const result = await kantel(["scp", "-r", "sbx_test1:out", "got"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/files/list": (call: Call) =>
					call.query.get("path") === "out"
						? {
								path: "/home/user/out",
								items: [
									{ name: "a.txt", path: "/home/user/out/a.txt", kind: "file", size: 2 },
									{ name: "../../evil.txt", path: "/home/evil.txt", kind: "file", size: 2 },
								],
							}
						: { path: "/home/user", items: [{ name: "out", path: "/home/user/out", kind: "directory", size: 0 }] },
				"GET /v1/sandboxes/sbx_test1/files": () => ({ path: "x", content: "eA==", encoding: "base64", size: 1 }),
			},
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("which isn't safe here");
		await expect(stat(join(configDir, "evil.txt"))).rejects.toThrow();
		await expect(stat(join(configDir, "got"))).rejects.toThrow();
	});

	it("scp reads a file over 1 MiB in ranged reads, with no command in the sandbox", async () => {
		const big = Buffer.alloc(2 * 1024 * 1024 + 300);
		for (let i = 0; i < big.length; i++) big[i] = i % 251;
		const result = await kantel(["scp", "sbx_test1:/srv/big.bin", "got.bin"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/files/list": () => ({
					path: "/srv",
					items: [{ name: "big.bin", path: "/srv/big.bin", kind: "file", size: big.length }],
				}),
				"GET /v1/sandboxes/sbx_test1/files": (call) => {
					const offset = Number(call.query.get("offset"));
					const part = big.subarray(offset, offset + Number(call.query.get("length")));
					return {
						path: "/srv/big.bin",
						encoding: "base64",
						content: part.toString("base64"),
						size: big.length,
						offset,
					};
				},
			},
		});
		expect(result.code).toBe(0);
		expect((await readFile(join(configDir, "got.bin"))).equals(big)).toBe(true);
		const reads = result.calls.filter((call) => call.path.endsWith("/files"));
		expect(reads.map((call) => [call.query.get("offset"), call.query.get("length")])).toEqual([
			["0", "1048576"],
			["1048576", "1048576"],
			["2097152", "1048576"],
		]);
		expect(result.calls.filter((call) => call.path.endsWith("/commands"))).toEqual([]);
	});

	it("files get stops when a file changes size while it is read in parts", async () => {
		let size = 1024 * 1024 + 10;
		const result = await kantel(["files", "get", "sbx_test1", "/srv/log", "log"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/files": (call) => {
					const offset = Number(call.query.get("offset"));
					const part = Buffer.alloc(Math.min(1024 * 1024, size - offset), 1);
					const answer = { path: "/srv/log", encoding: "base64", content: part.toString("base64"), size, offset };
					size += 5;
					return answer;
				},
			},
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("changed size");
	});

	it("scp reads a file over 1 MiB in parts with commands from a control plane before ranged reads", async () => {
		const big = Buffer.alloc(1024 * 1024 + 300);
		for (let i = 0; i < big.length; i++) big[i] = i % 251;
		const result = await kantel(["scp", "sbx_test1:/srv/big.bin", "got.bin"], {
			routes: {
				"GET /v1/sandboxes/sbx_test1/files/list": () => ({
					path: "/srv",
					items: [{ name: "big.bin", path: "/srv/big.bin", kind: "file", size: big.length }],
				}),
				"GET /v1/sandboxes/sbx_test1/files": () => kantelError(400, "invalid", "/srv/big.bin is larger than 1 MiB"),
				"POST /v1/sandboxes/sbx_test1/commands": (call) => {
					const line = (call.body as { command: string }).command;
					if (line.startsWith("stat ")) return command({ stdout: `${big.length}\n` });
					const match = /tail -c \+(\d+) .* head -c (\d+)/.exec(line);
					const from = Number(match?.[1]) - 1;
					const part = big.subarray(from, from + Number(match?.[2]));
					return command({ stdout: part.toString("base64") });
				},
			},
		});
		expect(result.code).toBe(0);
		expect((await readFile(join(configDir, "got.bin"))).equals(big)).toBe(true);
		expect(result.calls.filter((call) => call.path.endsWith("/commands"))).toHaveLength(4);
	});

	it("scp needs the sandbox on one side only", async () => {
		const neither = await kantel(["scp", "a", "b"]);
		expect(neither.code).toBe(2);
		const both = await kantel(["scp", "sbx_1:a", "sbx_2:b"]);
		expect(both.code).toBe(2);
		expect(both.calls).toEqual([]);
	});
});

describe("ports and live views", () => {
	it("host prints a port's URL", async () => {
		const result = await kantel(["host", "sbx_test1", "3000", "--public"], {
			routes: {
				"POST /v1/sandboxes/sbx_test1/ports": () => ({
					port: 3000,
					url: "https://p3000-brave-otter.kantel.test",
					public: true,
					createdAt: 1,
				}),
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("https://p3000-brave-otter.kantel.test\n");
		expect(result.calls[0]?.body).toEqual({ port: 3000, public: true });
	});

	it("desktop opens the live view for a person, and only prints it for a script", async () => {
		const routes = {
			"POST /v1/sandboxes/sbx_test1/desktop": () => ({ url: "https://desk.kantel.test/#t", expiresAt: 1 }),
		};
		const person = await kantel(["desktop", "sbx_test1"], { routes, tty: true });
		expect(person.opened).toEqual(["https://desk.kantel.test/#t"]);
		const script = await kantel(["desktop", "sbx_test1"], { routes });
		expect(script.opened).toEqual([]);
		expect(script.stdout).toContain("https://desk.kantel.test/#t");
	});
});
