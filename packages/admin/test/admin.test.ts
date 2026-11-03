// kantel-admin through `runAdmin`, with a fake Kantel behind an injected fetch, a fake spawn and a temporary home.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Host } from "@kantel/api/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AdminOptions,
	HOST_INSTALLER_URL,
	parseEnvFile,
	type Ran,
	runAdmin,
	updateEnvFile,
} from "../src/admin.ts";

interface Call {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly authorization: string | null;
}

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function fakeFetch(routes: { readonly [route: string]: (call: Call) => unknown }) {
	const calls: Call[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const call = { method, path: url.pathname, body, authorization: new Headers(init?.headers).get("authorization") };
		calls.push(call);
		const route = routes[`${method} ${url.origin}${url.pathname}`] ?? routes[`${method} ${url.pathname}`];
		if (route === undefined)
			return json({ error: { code: "not_found", message: `No route ${method} ${url.pathname}` } }, 404);
		const answer = await route(call);
		return answer instanceof Response ? answer : json(answer);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

function capture() {
	const chunks: string[] = [];
	return {
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		text: () => chunks.join(""),
	};
}

interface Spawned {
	readonly command: string;
	readonly args: readonly string[];
	readonly input?: string;
}

const HOST: Host = {
	id: "host_6t5r4e",
	name: "builder-1",
	state: "online",
	version: "0.4.0",
	latestVersion: "0.5.0",
	os: "linux",
	arch: "x86_64",
	tiers: ["microvm", "isolate"],
	kvm: true,
	nestedVirtualisation: false,
	capacity: { vcpus: 16, memoryMb: 65536, diskGb: 500 },
	allocated: { sandboxes: 3, vcpus: 6, memoryMb: 12288, diskGb: 60 },
	labels: { zone: "ams" },
	joinedAt: Date.UTC(2026, 10, 1),
	lastSeenAt: Date.now() - 5_000,
};

let home: string;
let configDir: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "kantel-admin-"));
	configDir = join(home, ".config", "kantel");
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function admin(
	argv: readonly string[],
	options: Partial<AdminOptions> & { readonly ran?: (spawned: Spawned) => Ran } = {},
) {
	const stdout = capture();
	const stderr = capture();
	const spawned: Spawned[] = [];
	const code = await runAdmin(argv, {
		env: { KANTEL_URL: "https://kantel.test", KANTEL_API_KEY: "ksk_admin" },
		home,
		configDir,
		platform: "linux",
		isRoot: false,
		fetch: fakeFetch({}).fetch,
		...options,
		stdout,
		stderr,
		spawn: async (command, args, opts) => {
			const call = { command, args, input: opts?.input };
			spawned.push(call);
			return options.ran?.(call) ?? { code: 0, stdout: "" };
		},
	});
	return { code, out: stdout.text(), err: stderr.text(), spawned };
}

async function install(env = "KANTEL_GATEWAY_PORT=58123\nKANTEL_SMTP_PASSWORD=hunter2\n"): Promise<string> {
	const dir = join(home, ".kantel", "src", "deploy", "compose");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "compose.yaml"), "name: harbour\n");
	if (env !== "") await writeFile(join(dir, ".env"), env);
	return join(dir, ".env");
}

describe(".env", () => {
	it("reads the last value of each key, unquoting it", () => {
		const settings = parseEnvFile("# a comment\nA=1\nexport B='two words'\nA=3\nnot a setting\n");
		expect([...settings]).toEqual([
			["A", "3"],
			["B", "two words"],
		]);
	});

	it("changes keys in place, drops repeats and removed keys, and adds new ones at the end", () => {
		const text = "# keep me\nA=1\nB=2\nA=again\nC=3\n";
		const changed = updateEnvFile(
			text,
			new Map([
				["A", "10"],
				["C", undefined],
				["D", "4"],
			]),
		);
		expect(changed).toBe("# keep me\nA=10\nB=2\nD=4\n");
	});
});

describe("install and upgrade", () => {
	it("downloads kantel.dev's installer and runs it with the flags passed on", async () => {
		const { fetch, calls } = fakeFetch({ "GET https://kantel.dev/install.sh": () => new Response("echo installer") });
		const { code, spawned, err } = await admin(["install", "--email", "me@example.com", "--no-open", "--", "--extra"], {
			fetch,
		});
		expect(code).toBe(0);
		expect(calls.map((call) => call.path)).toEqual(["/install.sh"]);
		expect(spawned).toEqual([
			{
				command: "sh",
				args: ["-s", "--", "--email", "me@example.com", "--no-open", "--extra"],
				input: "echo installer",
			},
		]);
		expect(err).toContain("running https://kantel.dev/install.sh");
	});

	it("upgrade adds --upgrade and --home, and passes the installer's exit code back", async () => {
		const script = join(home, "install.sh");
		await writeFile(script, "echo local");
		const { code, spawned } = await admin(["upgrade", "--home", "/srv/kantel"], {
			env: { KANTEL_INSTALLER_URL: script },
			ran: () => ({ code: 3, stdout: "" }),
		});
		expect(code).toBe(3);
		expect(spawned[0]?.args).toEqual(["-s", "--", "--home", "/srv/kantel", "--upgrade"]);
		expect(spawned[0]?.input).toBe("echo local");
	});
});

describe("status and settings", () => {
	it("status reports the console's health, the services and compute", async () => {
		await install("KANTEL_GATEWAY_PORT=58123\nKANTEL_COMPUTE=experimental\n");
		const { fetch, calls } = fakeFetch({ "GET http://127.0.0.1:58123/healthz": () => ({ ok: true }) });
		const { code, out, spawned } = await admin(["status"], {
			fetch,
			ran: () => ({ code: 0, stdout: "gateway running\npostgres running\nworker exited\n" }),
		});
		expect(code).toBe(0);
		expect(calls[0]?.path).toBe("/healthz");
		expect(spawned[0]?.args.slice(0, 3)).toEqual([
			"compose",
			"-f",
			join(home, ".kantel/src/deploy/compose/compose.yaml"),
		]);
		expect(out).toContain("http://127.0.0.1:58123 (answering)");
		expect(out).toContain("2 of 3 running");
		expect(out).toContain("your hosts");
		expect(out).toContain("hosts on this machine join at http://127.0.0.1:58123");
	});

	it("status exits 1 when the console doesn't answer, and says when nothing is installed", async () => {
		const missing = await admin(["status"]);
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("there is no Kantel install in");
		await install();
		const down = await admin(["status", "--json"], {
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		expect(down.code).toBe(1);
		expect(JSON.parse(down.out)).toMatchObject({ healthy: false, compute: "on", computeBackend: "hosts" });
	});

	it("config list hides secrets; config set and unset edit .env in place", async () => {
		const path = await install();
		const list = await admin(["config", "list"]);
		expect(list.out).toContain("KANTEL_SMTP_PASSWORD  (set)");
		expect(list.out).not.toContain("hunter2");

		const set = await admin([
			"config",
			"set",
			"KANTEL_PUBLIC_URL=https://kantel.example.com",
			"KANTEL_GATEWAY_PORT=58200",
		]);
		expect(set.code).toBe(0);
		expect(set.err).toContain("kantel-admin apply");
		expect(await readFile(path, "utf8")).toBe(
			"KANTEL_GATEWAY_PORT=58200\nKANTEL_SMTP_PASSWORD=hunter2\nKANTEL_PUBLIC_URL=https://kantel.example.com\n",
		);
		await admin(["config", "unset", "KANTEL_SMTP_PASSWORD"]);
		expect(await readFile(path, "utf8")).not.toContain("SMTP");

		const bad = await admin(["config", "set", "lower=1"]);
		expect(bad.code).toBe(2);
	});

	it("compute enable drops the old switch and the stand-in, sets a public URL and restarts the stack with --apply", async () => {
		const path = await install("KANTEL_COMPUTE=experimental\nKANTEL_COMPUTE_BACKEND=stub\nKANTEL_GATEWAY_PORT=58123\n");
		const done = await admin(["compute", "enable", "--hosts", "--public-url", "kantel.example.com/", "--apply"]);
		expect(done.code).toBe(0);
		expect(await readFile(path, "utf8")).toBe(
			"KANTEL_GATEWAY_PORT=58123\nKANTEL_PUBLIC_URL=https://kantel.example.com\n",
		);
		expect(done.spawned).toHaveLength(1);
		expect(done.spawned[0]?.command).toBe("docker");
		expect(done.spawned[0]?.args.slice(3)).toEqual(["up", "-d", "--wait"]);

		const failed = await admin(["apply"], { ran: () => ({ code: 1, stdout: "" }) });
		expect(failed.code).toBe(1);
		expect(failed.err).toContain("the stack didn't start");
	});
});

describe("bootstrap-key", () => {
	it("prints the gateway's compute key", async () => {
		await install();
		const { out, spawned } = await admin(["bootstrap-key"], {
			ran: () => ({ code: 0, stdout: JSON.stringify({ apiKey: "ksk_operator", computeKey: "ksk_compute" }) }),
		});
		expect(out.trim()).toBe("ksk_compute");
		expect(spawned[0]?.args.slice(3)).toEqual(["exec", "-T", "gateway", "sh", "-c", "cat /var/lib/*/bootstrap.json"]);
	});

	it("--save checks it and writes kantel's config with the local URL", async () => {
		await install();
		const { fetch, calls } = fakeFetch({
			"GET http://127.0.0.1:58123/v1/whoami": () => ({
				accountId: "acc_1",
				accounts: [],
				superAdmin: true,
				mode: "selfhosted",
			}),
		});
		const { code, out } = await admin(["bootstrap-key", "--save"], {
			fetch,
			ran: () => ({ code: 0, stdout: JSON.stringify({ computeKey: "ksk_compute" }) }),
		});
		expect(code).toBe(0);
		expect(calls[0]?.authorization).toBe("Bearer ksk_compute");
		expect(out).toContain("Saved the bootstrap key for http://127.0.0.1:58123");
		const saved = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
		expect(saved).toMatchObject({ url: "http://127.0.0.1:58123/v1", apiKey: "ksk_compute" });
	});

	it("says to upgrade when there is no key", async () => {
		await install();
		const { code, err } = await admin(["bootstrap-key"], { ran: () => ({ code: 0, stdout: "{}" }) });
		expect(code).toBe(1);
		expect(err).toContain("kantel-admin upgrade");
	});
});

describe("hosts", () => {
	it("host list prints a table, flagging an out-of-date agent", async () => {
		const { fetch, calls } = fakeFetch({ "GET /v1/admin/hosts": () => ({ items: [HOST] }) });
		const { code, out } = await admin(["host", "list"], { fetch });
		expect(code).toBe(0);
		expect(calls[0]?.authorization).toBe("Bearer ksk_admin");
		expect(out).toMatch(/host_6t5r4e\s+builder-1\s+online\s+0\.4\.0 \(0\.5\.0 out\)\s+microvm,isolate\s+3/);
	});

	it("host list says how to add the first host, and explains a missing scope", async () => {
		const empty = await admin(["host", "list"], {
			fetch: fakeFetch({ "GET /v1/admin/hosts": () => ({ items: [] }) }).fetch,
		});
		expect(empty.out).toContain("kantel-admin host add");
		const forbidden = await admin(["host", "list"], {
			fetch: fakeFetch({
				"GET /v1/admin/hosts": () => json({ error: { code: "forbidden", message: "needs hosts:admin" } }, 403),
			}).fetch,
		});
		expect(forbidden.code).toBe(1);
		expect(forbidden.err).toContain("Host commands need a key with hosts:admin");
	});

	it("host add makes a token with labels and prints the command", async () => {
		const token = {
			id: "hjt_1",
			token: "kth_secret",
			command: `curl -fsSL ${HOST_INSTALLER_URL} | sudo sh -s -- --url https://kantel.test --token kth_secret`,
			expiresAt: Date.UTC(2026, 10, 3, 12),
		};
		const { fetch, calls } = fakeFetch({ "POST /v1/admin/hosts/join-tokens": () => token });
		const { out } = await admin(["host", "add", "--name", "b2", "--label", "zone=ams", "--expires-minutes", "30"], {
			fetch,
		});
		expect(calls[0]?.body).toEqual({ name: "b2", labels: { zone: "ams" }, expiresInMinutes: 30 });
		expect(out).toContain(`  ${token.command}`);
	});

	it("host add --ssh runs the command on the machine without echoing the token", async () => {
		const token = { id: "hjt_1", token: "kth_secret", command: "sudo sh install --token kth_secret", expiresAt: 0 };
		const { fetch } = fakeFetch({ "POST /v1/admin/hosts/join-tokens": () => token });
		const { code, err, spawned } = await admin(["host", "add", "--ssh", "root@b2"], { fetch });
		expect(code).toBe(0);
		expect(spawned).toEqual([{ command: "ssh", args: ["-t", "root@b2", token.command], input: undefined }]);
		expect(err).not.toContain("kth_secret");
	});

	it("host join runs the release's host installer as root, and host run the installed kantel-host", async () => {
		const notRoot = await admin(["host", "join", "--url", "kantel.test", "--token", "kth_x"]);
		expect(notRoot.code).toBe(1);
		expect(notRoot.err).toContain("needs root");

		const { fetch, calls } = fakeFetch({ [`GET ${HOST_INSTALLER_URL}`]: () => new Response("echo install.sh\n") });
		const joined = await admin(
			["host", "join", "--url", "kantel.test", "--token", "kth_x", "--", "--tiers", "isolate"],
			{ isRoot: true, fetch },
		);
		expect(joined.code).toBe(0);
		expect(calls.map((call) => call.path)).toEqual([new URL(HOST_INSTALLER_URL).pathname]);
		expect(joined.spawned).toEqual([
			{
				command: "sh",
				args: ["-s", "--", "--url", "https://kantel.test", "--token", "kth_x", "--tiers", "isolate"],
				input: "echo install.sh\n",
			},
		]);
		expect(joined.err).not.toContain("kth_x");

		const run = await admin(["host", "run", "--", "doctor"]);
		expect(run.spawned).toEqual([{ command: "kantel-host", args: ["doctor"], input: undefined }]);

		const mac = await admin(["host", "run", "--", "status"], { platform: "darwin" });
		expect(mac.code).toBe(1);
		expect(mac.err).toContain("runs on Linux");
	});

	it("host drain, drain --undo and revoke --yes", async () => {
		const { fetch, calls } = fakeFetch({
			"PATCH /v1/admin/hosts/host_6t5r4e": (call) => ({
				...HOST,
				state: (call.body as { draining: boolean }).draining ? "draining" : "online",
			}),
			"DELETE /v1/admin/hosts/host_6t5r4e": () => ({ ...HOST, state: "revoked" }),
		});
		expect((await admin(["host", "drain", "host_6t5r4e"], { fetch })).out.trim()).toBe("host_6t5r4e draining");
		expect((await admin(["host", "drain", "host_6t5r4e", "--undo"], { fetch })).out.trim()).toBe("host_6t5r4e online");
		const unsure = await admin(["host", "revoke", "host_6t5r4e"], { fetch });
		expect(unsure.code).toBe(2);
		expect((await admin(["host", "revoke", "host_6t5r4e", "--yes"], { fetch })).out.trim()).toBe("host_6t5r4e revoked");
		expect(calls.map((call) => `${call.method} ${JSON.stringify(call.body ?? null)}`)).toEqual([
			'PATCH {"draining":true}',
			'PATCH {"draining":false}',
			"DELETE null",
		]);
	});

	it("needs a key for the API commands", async () => {
		const { code, err } = await admin(["host", "list"], { env: {} });
		expect(code).toBe(1);
		expect(err).toContain("bootstrap-key --save");
	});
});

describe("help", () => {
	it("lists every command, and an unknown one exits 2", async () => {
		const help = await admin([]);
		for (const name of [
			"install",
			"upgrade",
			"status",
			"compute enable",
			"bootstrap-key",
			"host add",
			"host join",
			"host revoke",
		]) {
			expect(help.out).toContain(name);
		}
		const sub = await admin(["help", "host", "join"]);
		expect(sub.out).toContain("Usage: kantel-admin host join");
		const flagHelp = await admin(["host", "add", "--help"]);
		expect(flagHelp.out).toContain("--ssh <user@machine>");
		const unknown = await admin(["nope"]);
		expect(unknown.code).toBe(2);
	});

	it("finds the command after flags that take a value", async () => {
		await install("KANTEL_COMPUTE=experimental\n");
		const { code, out } = await admin(["--home", join(home, ".kantel"), "--json", "config", "list"]);
		expect(code).toBe(0);
		expect(JSON.parse(out)).toEqual({ KANTEL_COMPUTE: "experimental" });
	});
});
