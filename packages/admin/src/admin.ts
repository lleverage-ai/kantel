/**
 * `kantel-admin`: the command for whoever runs a self-hosted Kantel, a single file attached to each of Kantel's GitHub
 * Releases. It installs and upgrades the control plane (by running kantel.dev's install.sh, never a copy of it),
 * changes the stack's settings in `~/.kantel/src/deploy/compose/.env`, reads the first compute key, and adds, lists,
 * drains and revokes the Linux hosts that run sandboxes. `host join`, run as root on a new machine, runs the release's
 * host installer (install.sh), which downloads the Go `kantel-host`, checks its SHA-256 and runs its `install`.
 *
 * The API commands use the same settings as `kantel`: `--url`/`--key`, `KANTEL_URL`/`KANTEL_API_KEY`, or the file
 * `kantel login` writes. They need a key with `hosts:admin`, which a deployment's first compute key has.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createKantelClient, type Host, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import {
	ago,
	booleanFlag,
	CliError,
	configDirectory,
	type Env,
	type FlagSpecs,
	fields,
	listFlag,
	loadConfig,
	normaliseUrl,
	originOf,
	parseArgs,
	readStoredConfig,
	stringFlag,
	table,
	timestamp,
	UsageError,
	writeStoredConfig,
} from "@kantel/cli";
import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
/** Where the installer comes from; `KANTEL_INSTALLER_URL` changes it. */
export const INSTALLER_URL = "https://kantel.dev/install.sh";
/** The host installer `host join` runs, from Kantel's latest GitHub Release; `KANTEL_HOST_INSTALLER_URL` changes it. */
export const HOST_INSTALLER_URL = "https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh";
/** The control plane's port on 127.0.0.1 unless `KANTEL_GATEWAY_PORT` says otherwise. */
const DEFAULT_PORT = "58090";

export interface Output {
	write(chunk: string): unknown;
}

/** What a child process gives back: its exit code, and its stdout when it was captured. */
export interface Ran {
	readonly code: number;
	readonly stdout: string;
}

/** Runs a program: its output on ours, or captured with `capture`; `input` goes to its stdin. */
export type Spawn = (
	command: string,
	args: readonly string[],
	options?: { readonly input?: string; readonly capture?: boolean },
) => Promise<Ran>;

export interface AdminOptions {
	readonly fetch?: typeof fetch;
	readonly env?: Env;
	readonly stdout?: Output;
	readonly stderr?: Output;
	/** `kantel`'s config directory, for the API commands and `bootstrap-key --save`. */
	readonly configDir?: string;
	/** The user's home, for `~/.kantel`. */
	readonly home?: string;
	readonly spawn?: Spawn;
	readonly platform?: NodeJS.Platform;
	/** Whether this process is root, for `host join`. */
	readonly isRoot?: boolean;
}

interface Io {
	readonly fetch: typeof fetch;
	readonly env: Env;
	readonly stdout: Output;
	readonly stderr: Output;
	readonly configDir: string;
	readonly home: string;
	readonly spawn: Spawn;
	readonly platform: NodeJS.Platform;
	readonly isRoot: boolean;
}

const defaultSpawn: Spawn = (command, args, options = {}) =>
	new Promise((done, fail) => {
		const child = nodeSpawn(command, [...args], {
			stdio: [
				options.input === undefined ? "inherit" : "pipe",
				options.capture === true ? "pipe" : "inherit",
				"inherit",
			],
		});
		const chunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.once("error", (error) => fail(new CliError(`couldn't run ${command}: ${error.message}`)));
		child.once("close", (code, signal) =>
			done({ code: code ?? (signal === null ? 1 : 128 + 1), stdout: Buffer.concat(chunks).toString("utf8") }),
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});

// The stack's settings file.

/** `<home>/src/deploy/compose`, where the installer keeps the stack. */
const composeDir = (kantelHome: string): string => join(kantelHome, "src", "deploy", "compose");

/** Reads `.env`'s `KEY=value` lines, the last of a key winning. */
export function parseEnvFile(text: string): Map<string, string> {
	const settings = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (match === null) continue;
		let value = match[2] as string;
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
		settings.set(match[1] as string, value);
	}
	return settings;
}

/** `text` with each key in `changes` set (or removed, for undefined) in place, and new keys added at the end. */
export function updateEnvFile(text: string, changes: ReadonlyMap<string, string | undefined>): string {
	const pending = new Map(changes);
	const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
		if (key === undefined || !changes.has(key)) {
			kept.push(line);
			continue;
		}
		const value = pending.get(key);
		// The first line of a key takes its new value; later ones go.
		if (pending.has(key) && value !== undefined) kept.push(`${key}=${value}`);
		pending.delete(key);
	}
	for (const [key, value] of pending) if (value !== undefined) kept.push(`${key}=${value}`);
	return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

const SECRET_KEY = /SECRET|TOKEN|PASSWORD|_KEY$|SMTP_URL/;
const shownValue = (key: string, value: string): string => (SECRET_KEY.test(key) && value !== "" ? "(set)" : value);

// The command table.

interface Context {
	readonly io: Io;
	readonly json: boolean;
	readonly positionals: readonly string[];
	readonly rest: readonly string[];
	arg(index: number, name: string): string;
	string(flag: string): string | undefined;
	boolean(flag: string): boolean;
	list(flag: string): string[];
	client(): Promise<KantelClient>;
	/** `~/.kantel`, or `--home`, or `KANTEL_HOME`. */
	kantelHome(): string;
	out(text: string): void;
	note(text: string): void;
	emit(value: unknown, human: () => string): void;
}

interface CommandSpec {
	readonly name: string;
	readonly usage?: string;
	readonly summary: string;
	readonly details?: string;
	readonly flags?: FlagSpecs;
	run(ctx: Context): Promise<number | undefined> | Promise<void>;
}

const GLOBAL_FLAGS: FlagSpecs = {
	url: { type: "string", value: "<url>", description: "Kantel's URL (KANTEL_URL), for the API commands" },
	key: { type: "string", value: "<key>", description: "An API key with hosts:admin (KANTEL_API_KEY)" },
	home: { type: "string", value: "<dir>", description: "Where Kantel is installed (KANTEL_HOME, default ~/.kantel)" },
	json: { type: "boolean", description: "Print JSON" },
	help: { type: "boolean", short: "h", description: "Show a command's help" },
};

/** The installer's own options, passed on as they are. */
const INSTALLER_FLAGS: FlagSpecs = {
	email: { type: "string", value: "<address>", description: "The first admin, who signs in" },
	ref: { type: "string", value: "<ref>", description: "A branch, tag or commit instead of main" },
	repo: { type: "string", value: "<owner/name>", description: "Another repository, such as your fork" },
	tarball: { type: "string", value: "<path|url>", description: "A .tar.gz of the source instead of GitHub" },
	"no-open": { type: "boolean", description: "Don't open the console in a browser" },
};

async function runInstaller(ctx: Context, upgrade: boolean): Promise<number> {
	const args: string[] = [];
	for (const name of ["email", "ref", "repo", "tarball"]) {
		const value = ctx.string(name);
		if (value !== undefined) args.push(`--${name}`, value);
	}
	const home = ctx.string("home");
	if (home !== undefined) args.push("--home", home);
	if (ctx.boolean("no-open")) args.push("--no-open");
	if (upgrade) args.push("--upgrade");
	args.push(...ctx.rest);
	const url = ctx.io.env.KANTEL_INSTALLER_URL || INSTALLER_URL;
	const script = await fetchScript(ctx, url, "the installer");
	ctx.note(`kantel-admin: running ${url} ${args.join(" ")}`.trimEnd());
	const ran = await ctx.io.spawn("sh", ["-s", "--", ...args], { input: script });
	return ran.code;
}

/** A script to run: a path or file: URL is read, anything else downloaded. */
async function fetchScript(ctx: Context, url: string, what: string): Promise<string> {
	if (url.startsWith("/") || url.startsWith("file:")) return await readFile(url.replace(/^file:\/\//, ""), "utf8");
	const response = await ctx.io.fetch(url);
	if (!response.ok) throw new CliError(`couldn't download ${what} from ${url}: HTTP ${response.status}`);
	return await response.text();
}

async function envPath(ctx: Context): Promise<string> {
	return join(composeDir(ctx.kantelHome()), ".env");
}

async function readSettings(ctx: Context): Promise<{ path: string; text: string; settings: Map<string, string> }> {
	const path = await envPath(ctx);
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") throw error;
		try {
			await readFile(join(composeDir(ctx.kantelHome()), "compose.yaml"), "utf8");
		} catch {
			throw new CliError(
				`there is no Kantel install in ${ctx.kantelHome()}: run kantel-admin install (or give --home)`,
			);
		}
	}
	return { path, text, settings: parseEnvFile(text) };
}

async function changeSettings(ctx: Context, changes: ReadonlyMap<string, string | undefined>): Promise<number> {
	const { path, text } = await readSettings(ctx);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, updateEnvFile(text, changes));
	const shown = [...changes].map(([key, value]) =>
		value === undefined ? `${key} removed` : `${key}=${shownValue(key, value)}`,
	);
	ctx.emit({ path, changed: Object.fromEntries(changes) }, () =>
		[`Updated ${path}:`, ...shown.map((line) => `  ${line}`)].join("\n"),
	);
	if (ctx.boolean("apply")) return applySettings(ctx);
	if (!ctx.json) ctx.note("It takes effect with: kantel-admin apply");
	return 0;
}

/** The console on this machine. Compose takes a setting from the environment before `.env`, so this does too. */
const localUrl = (ctx: Context, settings: Map<string, string>): string =>
	`http://127.0.0.1:${ctx.io.env.KANTEL_GATEWAY_PORT || settings.get("KANTEL_GATEWAY_PORT") || DEFAULT_PORT}`;

async function compose(ctx: Context, args: readonly string[], capture = true): Promise<Ran> {
	const file = join(composeDir(ctx.kantelHome()), "compose.yaml");
	return ctx.io.spawn("docker", ["compose", "-f", file, ...args], { capture });
}

function hostTable(hosts: readonly Host[]): string {
	if (hosts.length === 0) return "No hosts have joined. Add one: kantel-admin host add";
	return table(
		["ID", "NAME", "STATE", "VERSION", "TYPES", "SANDBOXES", "SEEN"],
		hosts.map((host) => [
			host.id,
			host.name,
			host.state,
			host.version === undefined
				? ""
				: host.updating !== undefined
					? `${host.version} (updating to ${host.updating.version})`
					: host.updateAvailable === true && host.latestVersion !== undefined
						? `${host.version} (${host.latestVersion} out)`
						: host.version,
			host.tiers.join(","),
			String(host.allocated.sandboxes),
			host.lastSeenAt === undefined ? "" : ago(host.lastSeenAt),
		]),
	);
}

const applyFlag = { type: "boolean", description: "Restart the stack with it now (kantel-admin apply)" } as const;

/** Starts the stack with its settings as they are: Compose recreates the containers whose settings changed. */
async function applySettings(ctx: Context): Promise<number> {
	await readSettings(ctx);
	ctx.note("kantel-admin: restarting the stack with its settings (docker compose up -d --wait)");
	const ran = await compose(ctx, ["up", "-d", "--wait"], false);
	if (ran.code !== 0) throw new CliError("the stack didn't start: see kantel-admin status, and docker compose logs");
	return 0;
}

const COMMANDS: readonly CommandSpec[] = [
	{
		name: "install",
		summary: "Install Kantel's control plane on this machine (Docker Compose), with kantel.dev's installer",
		flags: INSTALLER_FLAGS,
		details:
			"It downloads https://kantel.dev/install.sh and runs it, passing these options on; anything after -- goes\n" +
			"to it too. KANTEL_INSTALLER_URL runs another copy, such as a path in a checkout.",
		run: (ctx) => runInstaller(ctx, false),
	},
	{
		name: "upgrade",
		summary: "Download Kantel again and rebuild the stack with it, keeping its settings and data",
		flags: INSTALLER_FLAGS,
		run: (ctx) => runInstaller(ctx, true),
	},
	{
		name: "apply",
		summary: "Restart the stack with its current settings, without downloading Kantel again",
		run: (ctx) => applySettings(ctx),
	},
	{
		name: "status",
		summary: "Whether the control plane runs and answers, and its compute settings",
		async run(ctx) {
			const { path, settings } = await readSettings(ctx);
			const url = localUrl(ctx, settings);
			let healthy = false;
			try {
				healthy = (await ctx.io.fetch(`${url}/healthz`)).ok;
			} catch {
				healthy = false;
			}
			const ps = await compose(ctx, ["ps", "--format", "{{.Service}} {{.State}}"]);
			const services = ps.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split(" "));
			const running = services.filter(([, state]) => state === "running").length;
			const status = {
				home: ctx.kantelHome(),
				settings: path,
				url,
				healthy,
				services: { running, total: services.length },
				// Always on since the console became the compute console; the field stays for scripts that read it.
				compute: "on",
				computeBackend: settings.get("KANTEL_COMPUTE_BACKEND") === "stub" ? "stub" : "hosts",
				publicUrl: settings.get("KANTEL_PUBLIC_URL"),
			};
			ctx.emit(status, () =>
				fields([
					["home", status.home],
					["console", `${url} (${healthy ? "answering" : "not answering"})`],
					["services", `${running} of ${services.length} running`],
					["backend", status.computeBackend === "hosts" ? "your hosts" : "the built-in stand-in (no hosts)"],
					["public URL", status.publicUrl ?? `none: hosts on this machine join at ${url}`],
				]),
			);
			return healthy ? 0 : 1;
		},
	},
	{
		name: "config list",
		summary: "The stack's settings (secrets show as (set))",
		async run(ctx) {
			const { path, settings } = await readSettings(ctx);
			const rows = [...settings].map(([key, value]) => [key, shownValue(key, value)] as const);
			ctx.emit(Object.fromEntries(rows), () => (rows.length === 0 ? `${path} sets nothing.` : fields(rows)));
		},
	},
	{
		name: "config set",
		usage: "config set <KEY=value>…",
		summary: "Change the stack's settings in deploy/compose/.env",
		flags: { apply: applyFlag },
		async run(ctx) {
			if (ctx.positionals.length === 0)
				throw new UsageError("give KEY=value: kantel-admin config set KANTEL_PUBLIC_URL=https://…");
			const changes = new Map<string, string | undefined>();
			for (const pair of ctx.positionals) {
				const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(pair);
				if (match === null) throw new UsageError(`"${pair}" isn't KEY=value`);
				if (/[\n\r]/.test(match[2] as string)) throw new UsageError(`${match[1]}'s value has a line break`);
				changes.set(match[1] as string, match[2] as string);
			}
			return changeSettings(ctx, changes);
		},
	},
	{
		name: "config unset",
		usage: "config unset <KEY>…",
		summary: "Remove settings from deploy/compose/.env",
		flags: { apply: applyFlag },
		async run(ctx) {
			if (ctx.positionals.length === 0) throw new UsageError("give the keys to remove");
			return changeSettings(ctx, new Map(ctx.positionals.map((key) => [key, undefined])));
		},
	},
	{
		name: "compute enable",
		summary: "Run sandboxes on your own hosts (the default), optionally reached at a public URL",
		details:
			"The compute API is always on, and sandboxes run on the hosts you add. This undoes KANTEL_COMPUTE_BACKEND=stub\n" +
			"and drops the old KANTEL_COMPUTE switch. Hosts on other machines need --public-url: without it, only a host\n" +
			"on this machine can join, at the local address.",
		flags: {
			"public-url": {
				type: "string",
				value: "<url>",
				description: "Where hosts and people reach the control plane, such as https://kantel.example.com",
			},
			hosts: { type: "boolean", description: "Accepted for older scripts: hosts are the default" },
			apply: applyFlag,
		},
		async run(ctx) {
			const { settings } = await readSettings(ctx);
			const changes = new Map<string, string | undefined>();
			if (settings.has("KANTEL_COMPUTE")) changes.set("KANTEL_COMPUTE", undefined);
			if (settings.has("KANTEL_COMPUTE_BACKEND")) changes.set("KANTEL_COMPUTE_BACKEND", undefined);
			const publicUrl = ctx.string("public-url");
			if (publicUrl !== undefined) changes.set("KANTEL_PUBLIC_URL", originOf(normaliseUrl(publicUrl)));
			return changeSettings(ctx, changes);
		},
	},
	{
		name: "bootstrap-key",
		summary: "The deployment's first compute key (every scope, hosts:admin too)",
		flags: { save: { type: "boolean", description: "Sign kantel and kantel-admin in with it instead of printing it" } },
		details:
			"It reads the key the control plane wrote in its gateway container. With --save it checks the key and saves it\n" +
			"with the local URL in kantel's config, as kantel login does. Keep it to yourself: make scoped keys for\n" +
			"people, scripts and agents with kantel key create.",
		async run(ctx) {
			const { settings } = await readSettings(ctx);
			const ran = await compose(ctx, ["exec", "-T", "gateway", "sh", "-c", "cat /var/lib/*/bootstrap.json"]);
			if (ran.code !== 0)
				throw new CliError("couldn't read the gateway's bootstrap.json: is the stack running? (kantel-admin status)");
			let key: unknown;
			try {
				key = (JSON.parse(ran.stdout) as { computeKey?: unknown }).computeKey;
			} catch {
				throw new CliError("the gateway's bootstrap.json isn't JSON");
			}
			if (typeof key !== "string") {
				throw new CliError("there is no compute key yet: kantel-admin upgrade, then try again");
			}
			if (!ctx.boolean("save")) {
				ctx.out(key);
				return;
			}
			// The local URL: this runs on the control plane's machine, which may not reach its own public URL.
			const url = normaliseUrl(localUrl(ctx, settings));
			const caller = await createKantelClient({ baseUrl: url, token: key, fetch: ctx.io.fetch }).getCaller();
			const stored = await readStoredConfig(ctx.io.configDir);
			const path = await writeStoredConfig(ctx.io.configDir, { ...stored, url, apiKey: key, account: undefined });
			ctx.emit(
				{ url, accountId: caller.accountId, path },
				() => `Saved the bootstrap key for ${originOf(url)} to ${path}.`,
			);
		},
	},
	{
		name: "host list",
		summary: "The machines that run sandboxes",
		async run(ctx) {
			const hosts = await (await ctx.client()).listHosts();
			ctx.emit(hosts, () => hostTable(hosts.items));
		},
	},
	{
		name: "host info",
		usage: "host info <hostId>",
		summary: "One host: its state, capacity and what it runs",
		async run(ctx) {
			const host = await (await ctx.client()).getHost(ctx.arg(0, "hostId"));
			ctx.emit(host, () =>
				fields([
					["id", host.id],
					["name", host.name],
					["state", host.state],
					["version", host.version],
					["machine", [host.os, host.arch].filter(Boolean).join(" ")],
					["runs", host.tiers.join(", ")],
					["kvm", host.kvm ? "yes" : "no"],
					["sandboxes", String(host.allocated.sandboxes)],
					[
						"labels",
						Object.entries(host.labels)
							.map(([k, v]) => `${k}=${v}`)
							.join(", "),
					],
					["joined", timestamp(host.joinedAt)],
					["seen", host.lastSeenAt === undefined ? undefined : ago(host.lastSeenAt)],
				]),
			);
		},
	},
	{
		name: "host add",
		summary: "Make a one-use join token, and print the command to run on the new machine (or run it over SSH)",
		flags: {
			name: { type: "string", value: "<name>", description: "The host's name" },
			label: { type: "string", multiple: true, value: "<k=v>", description: "A label; repeat for more" },
			"expires-minutes": { type: "string", value: "<n>", description: "How long the token works (default 60)" },
			ssh: {
				type: "string",
				value: "<user@machine>",
				description: "Run the join command on that machine now, over ssh",
			},
		},
		details:
			"The machine needs Linux with /dev/kvm for microVMs, curl and root. It dials out to the control plane, so it\n" +
			"needs no open port. The command it prints runs the host installer from Kantel's latest release:\n" +
			`  curl -fsSL ${HOST_INSTALLER_URL} | sudo sh -s -- --url <kantel> --token kth_…\n` +
			"which kantel-admin host join runs too.",
		async run(ctx) {
			const labels: { [key: string]: string } = {};
			for (const item of ctx.list("label")) {
				const eq = item.indexOf("=");
				if (eq <= 0) throw new UsageError(`--label takes key=value, not "${item}"`);
				labels[item.slice(0, eq)] = item.slice(eq + 1);
			}
			const minutes = ctx.string("expires-minutes");
			if (minutes !== undefined && !/^\d+$/.test(minutes)) throw new UsageError("--expires-minutes is a whole number");
			const token = await (await ctx.client()).createHostJoinToken({
				name: ctx.string("name"),
				labels: Object.keys(labels).length === 0 ? undefined : labels,
				expiresInMinutes: minutes === undefined ? undefined : Number(minutes),
			});
			const target = ctx.string("ssh");
			if (target !== undefined) {
				ctx.note(`kantel-admin: joining ${target} (ssh ${target} ${token.command.replace(/kth_\S+/, "kth_…")})`);
				const ran = await ctx.io.spawn("ssh", ["-t", target, token.command]);
				if (ran.code === 0) ctx.note("kantel-admin: it has joined: kantel-admin host list");
				return ran.code;
			}
			ctx.emit(token, () =>
				[`Run this on the machine as root, before ${timestamp(token.expiresAt)}:`, "", `  ${token.command}`].join("\n"),
			);
		},
	},
	{
		name: "host join",
		summary: "Run on a new Linux machine, as root: install kantel-host and join it to Kantel",
		flags: {
			token: { type: "string", value: "<kth_…>", description: "The join token from kantel-admin host add" },
		},
		details:
			"  sudo kantel-admin host join --url https://kantel.example.com --token kth_…\n" +
			"It runs the host installer from Kantel's latest release (KANTEL_HOST_INSTALLER_URL runs another), which\n" +
			"downloads kantel-host, checks its SHA-256 and runs kantel-host install: that checks /dev/kvm, copies the\n" +
			"binary to /usr/local/bin, fetches Firecracker and the images and starts the kantel-host service. Anything\n" +
			"after -- goes to it, such as -- --tiers isolate --isolate-runtime native on a machine without KVM.",
		async run(ctx) {
			const url = ctx.string("url");
			const token = ctx.string("token");
			if (url === undefined || token === undefined) {
				throw new UsageError("give both: kantel-admin host join --url <kantel> --token <kth_…>");
			}
			if (!ctx.io.isRoot) {
				throw new CliError("joining installs a system service, so it needs root: sudo kantel-admin host join …");
			}
			linuxOnly(ctx);
			const installer = ctx.io.env.KANTEL_HOST_INSTALLER_URL || HOST_INSTALLER_URL;
			const script = await fetchScript(ctx, installer, "the host installer");
			const args = ["--url", originOf(normaliseUrl(url)), "--token", token, ...ctx.rest];
			ctx.note(`kantel-admin: running ${installer} ${args.join(" ").replace(/kth_\S+/, "kth_…")}`);
			return (await ctx.io.spawn("sh", ["-s", "--", ...args], { input: script })).code;
		},
	},
	{
		name: "host run",
		usage: "host run -- <kantel-host args…>",
		summary: "Run kantel-host on this machine: doctor, status, update, uninstall",
		async run(ctx) {
			if (ctx.rest.length === 0)
				throw new UsageError("give kantel-host's command after --, such as: host run -- doctor");
			return kantelHost(ctx, ctx.rest);
		},
	},
	{
		name: "host drain",
		usage: "host drain <hostId>",
		summary: "Stop placing new sandboxes on a host (--undo takes it back)",
		flags: { undo: { type: "boolean", description: "Let it take new sandboxes again" } },
		async run(ctx) {
			const host = await (await ctx.client()).updateHost(ctx.arg(0, "hostId"), { draining: !ctx.boolean("undo") });
			ctx.emit(host, () => `${host.id} ${host.state}`);
		},
	},
	{
		name: "host update",
		usage: "host update <hostId>",
		summary: "Update a host's kantel-host to the version it should run, over its connection",
		details:
			"The version is KANTEL_HOST_VERSION when it's set, otherwise Kantel's latest release (`host list` shows it beside a " +
			"host that's behind). The host fetches it, checks it against the release's SHA256SUMS and restarts; its sandboxes " +
			"keep running. On the machine itself, use `host run -- update`.",
		async run(ctx) {
			const host = await (await ctx.client()).updateHostAgent(ctx.arg(0, "hostId"));
			ctx.emit(host, () => `${host.id} updating to ${host.updating?.version ?? host.latestVersion ?? "the latest"}`);
		},
	},
	{
		name: "host revoke",
		usage: "host revoke <hostId> --yes",
		summary: "Revoke a host's credential and close its connection",
		flags: { yes: { type: "boolean", description: "Yes, revoke it" } },
		details: "Its sandboxes keep their disks but can't be reached until it joins again with a new token.",
		async run(ctx) {
			const hostId = ctx.arg(0, "hostId");
			if (!ctx.boolean("yes"))
				throw new UsageError(`to revoke ${hostId}, run: kantel-admin host revoke ${hostId} --yes`);
			const host = await (await ctx.client()).revokeHost(hostId);
			ctx.emit(host, () => `${host.id} ${host.state}`);
		},
	},
	{
		name: "version",
		summary: "kantel-admin's version",
		async run(ctx) {
			ctx.out(VERSION);
		},
	},
];

function linuxOnly(ctx: Context): void {
	if (ctx.io.platform !== "linux") {
		throw new CliError(
			`kantel-host runs on Linux (x64 or arm64), not ${ctx.io.platform}: run this on the machine to add`,
		);
	}
}

/** Runs the `kantel-host` that `host join` installed on this machine. */
async function kantelHost(ctx: Context, args: readonly string[]): Promise<number> {
	linuxOnly(ctx);
	try {
		return (await ctx.io.spawn("kantel-host", args)).code;
	} catch (error) {
		if (error instanceof CliError && /ENOENT/.test(error.message)) {
			throw new CliError("kantel-host isn't installed on this machine: join it first, with kantel-admin host join");
		}
		throw error;
	}
}

// Help.

function flagLines(specs: FlagSpecs): string {
	return fields(
		Object.entries(specs)
			.filter(([, spec]) => spec.hidden !== true)
			.map(([name, spec]) => [
				`${spec.short === undefined ? "" : `-${spec.short}, `}--${name}${spec.value === undefined ? "" : ` ${spec.value}`}`,
				spec.description,
			]),
	)
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function mainHelp(): string {
	const usage = (command: CommandSpec): string => command.usage ?? command.name;
	const width = Math.max(...COMMANDS.map((command) => usage(command).length));
	return [
		`kantel-admin ${VERSION}: run a self-hosted Kantel and its hosts.`,
		"",
		"Usage: kantel-admin <command> [flags]",
		"",
		...COMMANDS.map((command) => `  ${usage(command).padEnd(width)}  ${command.summary}`),
		"",
		`Flags on every command:\n${flagLines(GLOBAL_FLAGS)}`,
		"",
		"Sandboxes themselves are the kantel command's: kantel help.",
	].join("\n");
}

function commandHelp(command: CommandSpec): string {
	const lines = [`Usage: kantel-admin ${command.usage ?? command.name} [flags]`, "", `${command.summary}.`];
	if (command.details !== undefined) lines.push("", command.details);
	if (command.flags !== undefined) lines.push("", `Flags:\n${flagLines(command.flags)}`);
	return lines.join("\n");
}

function find(words: readonly string[]): { command: CommandSpec; used: number } | undefined {
	const two = COMMANDS.find((command) => command.name === `${words[0]} ${words[1]}`);
	if (two !== undefined) return { command: two, used: 2 };
	const one = COMMANDS.find((command) => command.name === words[0]);
	return one === undefined ? undefined : { command: one, used: 1 };
}

/** Every flag, on any command, that takes a value: the word after it is its value, not a command word. */
const VALUE_FLAGS = new Set(
	[GLOBAL_FLAGS, ...COMMANDS.map((command) => command.flags ?? {})].flatMap((specs) =>
		Object.entries(specs).flatMap(([name, spec]) =>
			spec.type === "string" ? [`--${name}`, ...(spec.short === undefined ? [] : [`-${spec.short}`])] : [],
		),
	),
);

/** The positions in `head` of the words that aren't flags or flags' values. */
function wordIndexes(head: readonly string[]): number[] {
	const indexes: number[] = [];
	for (let index = 0; index < head.length; index++) {
		const word = head[index] as string;
		if (VALUE_FLAGS.has(word)) index++;
		else if (!word.startsWith("-")) indexes.push(index);
	}
	return indexes;
}

/** Runs `kantel-admin` with `argv` and resolves with its exit code. */
export async function runAdmin(argv: readonly string[], options: AdminOptions = {}): Promise<number> {
	const env = options.env ?? process.env;
	const io: Io = {
		fetch: options.fetch ?? fetch,
		env,
		stdout: options.stdout ?? process.stdout,
		stderr: options.stderr ?? process.stderr,
		configDir: configDirectory(env, options.configDir),
		home: options.home ?? homedir(),
		spawn: options.spawn ?? defaultSpawn,
		platform: options.platform ?? process.platform,
		isRoot: options.isRoot ?? process.getuid?.() === 0,
	};
	const say = (text: string): void => {
		io.stdout.write(`${text}\n`);
	};
	const dashDash = argv.indexOf("--");
	const head = dashDash === -1 ? argv : argv.slice(0, dashDash);
	const indexes = wordIndexes(head);
	const words = indexes.map((index) => head[index] as string);
	if (
		head.length === 0 ||
		words[0] === "help" ||
		(words.length === 0 && (head.includes("-h") || head.includes("--help")))
	) {
		const named = words[0] === "help" ? find(words.slice(1)) : undefined;
		say(named === undefined ? mainHelp() : commandHelp(named.command));
		return 0;
	}
	if (head.includes("--version")) {
		say(VERSION);
		return 0;
	}
	const found = find(words);
	if (found === undefined) {
		io.stderr.write(
			`kantel-admin: there is no command "${words.slice(0, 2).join(" ")}". "kantel-admin help" lists them.\n`,
		);
		return 2;
	}
	const { command } = found;
	try {
		// Drop the command's own words, the first ones that aren't flags or their values.
		const own = new Set(indexes.slice(0, found.used));
		const rest = argv.filter((_, index) => !own.has(index));
		const parsed = parseArgs(rest, { ...GLOBAL_FLAGS, ...command.flags });
		if (booleanFlag(parsed, "help") === true) {
			say(commandHelp(command));
			return 0;
		}
		const json = booleanFlag(parsed, "json") === true;
		const ctx: Context = {
			io,
			json,
			positionals: parsed.positionals,
			rest: parsed.rest ?? [],
			arg(index, name) {
				const value = parsed.positionals[index];
				if (value === undefined) throw new UsageError(`${command.name} needs <${name}>`);
				return value;
			},
			string: (flag) => stringFlag(parsed, flag),
			boolean: (flag) => booleanFlag(parsed, flag) === true,
			list: (flag) => listFlag(parsed, flag),
			async client() {
				const config = await loadConfig(
					{ url: stringFlag(parsed, "url"), apiKey: stringFlag(parsed, "key") },
					io.env,
					io.configDir,
				);
				if (config.apiKey === undefined) {
					throw new CliError(
						"this needs a key with hosts:admin: kantel-admin bootstrap-key --save, or KANTEL_URL and KANTEL_API_KEY",
					);
				}
				return createKantelClient({ baseUrl: config.url, token: config.apiKey, fetch: io.fetch });
			},
			kantelHome: () => stringFlag(parsed, "home") ?? (io.env.KANTEL_HOME || join(io.home, ".kantel")),
			out: say,
			note: (text) => {
				io.stderr.write(`${text}\n`);
			},
			emit(value, human) {
				say(json ? JSON.stringify(value, null, 2) : human());
			},
		};
		const code = await command.run(ctx);
		return typeof code === "number" ? code : 0;
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr.write(`kantel-admin: ${error.message}\nUsage: kantel-admin ${command.usage ?? command.name} [flags]\n`);
			return 2;
		}
		if (error instanceof KantelApiError) {
			io.stderr.write(`kantel-admin: ${error.code}: ${error.message}\n`);
			if (error.code === "forbidden") io.stderr.write("Host commands need a key with hosts:admin.\n");
			return 1;
		}
		if (error instanceof CliError) {
			io.stderr.write(`kantel-admin: ${error.message}\n`);
			return error.exitCode;
		}
		io.stderr.write(`kantel-admin: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
