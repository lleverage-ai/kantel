/**
 * The `kantel` command line: a table of commands, from which `help` is made too. Every command prints compact human
 * output, or Kantel's JSON answer as it is with `--json`. `run` takes its streams, environment, fetch and config
 * directory as options, so tests drive it with no globals.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ApiKey,
	type ApiKeyPreset,
	type ApiKeyScope,
	type Caller,
	type Command,
	createKantelClient,
	type EventType,
	type ExposedPort,
	type FileList,
	type Host,
	type IssuedApiKey,
	KantelApiError,
	type KantelClient,
	type Sandbox,
	type SandboxNotRunning,
	type SandboxSizeName,
	type SandboxType,
} from "@kantel/api/sdk";
import type { EntryBody } from "@kantel/e2e/chain";
import { type ByteChannel, SessionClient, SessionError } from "@kantel/e2e/session";
import {
	AGENTS_BLOCK,
	agentsGuide,
	claudeSetup,
	codexSetup,
	codexToml,
	HARNESSES,
	type McpLaunch,
	mcpLaunch,
	mcpServersJson,
	SKILL_MD,
	SKILL_PATHS,
	upsertAgentsBlock,
} from "./agents.ts";
import {
	booleanFlag,
	type FlagSpec,
	type FlagSpecs,
	listFlag,
	type ParsedArgs,
	parseArgs,
	stringFlag,
} from "./args.ts";
import {
	configDirectory,
	configFile,
	DEFAULT_URL,
	type Env,
	loadConfig,
	normaliseUrl,
	originOf,
	type ResolvedConfig,
	readStoredConfig,
	resolveConfig,
	writeStoredConfig,
} from "./config.ts";
import { type LocalConsole, type LocalInfo, serveLocalConsole } from "./console.ts";
import * as e2e from "./e2e.ts";
import {
	type Binding,
	bindingsText,
	describeEgress,
	describeEnvironment,
	type Environment,
	environmentTable,
	type GrantInput,
	grantText,
	mergeBindings,
	octal,
	parseBinding,
	parseGrant,
	withoutProtectedValues,
} from "./environments.ts";
import { CliError, HostAnswerError, notRunningOf, UsageError } from "./errors.ts";
import { ago, bytes, duration, fields, money, table, timestamp, until } from "./format.ts";
import { openInBrowser, type PendingLogin, readPendingLogin, startLogin, waitForLogin } from "./login.ts";
import { createMcpServer, serveStdio } from "./mcp.ts";
import { pipeTunnel, proxyUrlOf, SSH_URL_ENV, tunnelSshArgs, tunnelSshCommand } from "./ssh-proxy.ts";
import {
	checkPushRoot,
	downloadTree,
	getBytes,
	getFile,
	gitFiles,
	parseRemote,
	pushPlan,
	remoteIsDirectory,
	remoteJoin,
	remotePath,
	rootContexts,
	uploadFile,
	uploadTree,
	walk,
} from "./transfer.ts";
import { VERSION } from "./version.ts";

/** Where the CLI writes. */
export interface Output {
	write(chunk: string | Uint8Array): unknown;
	readonly isTTY?: boolean;
}

/** Where the CLI reads: the key for `login`, messages for `mcp`, a file for `files put <id> - <remote>`. */
export interface Input extends AsyncIterable<string | Uint8Array> {
	readonly isTTY?: boolean;
}

export interface RunOptions {
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Default `process.env`. */
	readonly env?: Env;
	readonly stdout?: Output;
	readonly stderr?: Output;
	readonly stdin?: Input;
	/** Where `config.json` is; default `${XDG_CONFIG_HOME:-~/.config}/kantel`. */
	readonly configDir?: string;
	/** What local paths are relative to; default the process's working directory. */
	readonly cwd?: string;
	/** Opens a URL in the person's browser, for `login`; default the system's opener. */
	readonly openUrl?: (url: string) => void;
	/** Waits between polls (`login`, `attach`); default a timer. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** The home directory, for `init --global`; default the user's. */
	readonly home?: string;
	/**
	 * How to start this CLI by absolute paths (Node, its flags and the script), for the MCP setups `agents` prints when
	 * `kantel` isn't on the PATH; default this process's.
	 */
	readonly self?: readonly string[];
	/** Opens the relay's WebSocket for an E2E session (`kantel e2e`); default a WebSocket to the URL. */
	readonly connect?: (url: string) => Promise<ByteChannel>;
	/** `kantel console` is serving: resolves when it should stop; default on Ctrl-C (SIGINT) or SIGTERM. */
	readonly served?: (console: LocalConsole) => Promise<void>;
}

interface Io {
	readonly fetch: typeof fetch;
	readonly env: Env;
	readonly stdout: Output;
	readonly stderr: Output;
	stdin(): Input;
	readonly configDir: string;
	readonly cwd: string;
	readonly openUrl: (url: string) => void;
	readonly sleep: (ms: number) => Promise<void>;
	readonly home: string;
	readonly self: readonly string[] | undefined;
	readonly connect: (url: string) => Promise<ByteChannel>;
	readonly served: (console: LocalConsole) => Promise<void>;
}

/** Until Ctrl-C or SIGTERM. */
function untilSignalled(): Promise<void> {
	return new Promise((done) => {
		const stop = () => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			done();
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});
}

/**
 * Where the console's built files are: `--dir`, `KANTEL_CONSOLE_DIR`, `console/` beside the bundled CLI (its npm
 * package), or the console's build in this checkout.
 */
async function consoleDir(ctx: Context): Promise<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const given = ctx.string("dir") ?? ctx.io.env.KANTEL_CONSOLE_DIR;
	const candidates =
		given === undefined
			? [join(here, "console"), join(here, "..", "..", "..", "apps", "console", "dist")]
			: [resolve(ctx.io.cwd, given)];
	for (const candidate of candidates) {
		if (
			await access(join(candidate, "index.html")).then(
				() => true,
				() => false,
			)
		) {
			return candidate;
		}
	}
	throw new CliError(
		given === undefined
			? "This CLI has no console files: install the kantel package, or build them with pnpm --filter @kantel/console build"
			: `There is no console in ${candidates[0]} (no index.html)`,
	);
}

/** What `kantel console` tells its page about E2E: this device, and each space it pinned, verified now. */
async function localInfo(ctx: Context): Promise<LocalInfo> {
	const device = await e2e.loadDevice(ctx.io.configDir).catch(() => undefined);
	const spaces = await Promise.all(
		(await e2e.pinnedSpaces(ctx.io.configDir)).map(async (id) => {
			try {
				const chain = await e2e.verifiedChain(await ctx.client(), ctx.io.configDir, id);
				return { id, mode: chain.state.mode };
			} catch (error) {
				// A chain this device can't verify is treated as E2E: the page never falls back to the gateway for it.
				return { id, mode: "strict" as const, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
	return {
		local: true,
		...(device === undefined ? {} : { device: { id: device.id, label: device.label } }),
		spaces,
	};
}

/** Whether an executable `name` is in one of the PATH's directories. */
export async function onPath(name: string, env: Env): Promise<boolean> {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (directory === "" || !isAbsolute(directory)) continue;
		try {
			await access(join(directory, name), constants.X_OK);
			return true;
		} catch {
			// Not here.
		}
	}
	return false;
}

/**
 * This process as a command, when it is the kantel CLI: the installed `kantel` (a link to kantel.mjs), the bundle, or
 * src/main.ts from a checkout. Undefined when another program called `run`.
 */
function thisCli(): readonly string[] | undefined {
	const script = process.argv[1];
	if (script === undefined) return undefined;
	const name = basename(script);
	if (!name.startsWith("kantel") && name !== "main.ts") return undefined;
	return [process.execPath, ...process.execArgv, resolve(script)];
}

/** How the MCP setups `agents` prints start `kantel mcp`: `kantel` from the PATH, or this CLI by its full path. */
async function mcpLaunchFor(io: Io): Promise<McpLaunch> {
	return mcpLaunch(await onPath("kantel", io.env), io.self);
}

/** What a command's `run` is given. */
interface Context {
	readonly io: Io;
	readonly json: boolean;
	readonly positionals: readonly string[];
	/** What followed `--`, for a command that takes it. */
	readonly rest: readonly string[] | undefined;
	arg(index: number): string;
	optional(index: number): string | undefined;
	string(flag: string): string | undefined;
	boolean(flag: string): boolean;
	list(flag: string): string[];
	config(): Promise<ResolvedConfig>;
	client(): Promise<KantelClient>;
	/** A line to stdout. */
	out(text: string): void;
	/** A line to stderr. */
	note(text: string): void;
	/** `value` as JSON with `--json`, else `human()`. */
	emit(value: unknown, human: () => string): void;
}

interface Arg {
	readonly name: string;
	readonly optional?: boolean;
	/** It takes the rest of the words. */
	readonly variadic?: boolean;
}

interface CommandSpec {
	/** Its words, such as `sandbox create`. */
	readonly name: string;
	readonly summary: string;
	/** Its usage line, when its arguments say it badly, such as `env set <env> <NAME>[=<value>]`. */
	readonly usage?: string;
	/** Left out of `kantel help`'s list: an older spelling kept working, such as `sandbox create` for `new`. */
	readonly hidden?: boolean;
	readonly args?: readonly Arg[];
	readonly flags?: FlagSpecs;
	/** What it takes after `--`, such as exec's `command…`. */
	readonly rest?: string;
	/** It runs without anything after `--`, as `ssh` does. */
	readonly restOptional?: boolean;
	/** More help, after the summary. */
	readonly details?: string;
	/** Resolves with the exit code, or anything else for 0. */
	readonly run: (context: Context) => Promise<unknown>;
}

interface Section {
	readonly title: string;
	readonly commands: readonly CommandSpec[];
}

// Values and checks.

const SANDBOX_TYPES: readonly SandboxType[] = ["isolate", "microvm"];
const SIZES: readonly SandboxSizeName[] = ["small", "default", "large", "xlarge"];
const PRESETS: readonly ApiKeyPreset[] = ["agent", "ci", "read-only", "admin"];
const SCOPES: readonly ApiKeyScope[] = [
	"sandboxes:read",
	"sandboxes:write",
	"sandboxes:delete",
	"exec",
	"files",
	"access",
	"snapshots:read",
	"snapshots:write",
	"account:read",
	"account:admin",
	"hosts:admin",
];
const EVENT_TYPES: readonly EventType[] = [
	"sandbox.created",
	"sandbox.running",
	"sandbox.stopped",
	"sandbox.paused",
	"sandbox.error",
	"sandbox.degraded",
	"sandbox.recovered",
	"sandbox.deleted",
	"snapshot.saved",
	"snapshot.deleted",
];
const SIGNALS: readonly ("metrics" | "logs")[] = ["metrics", "logs"];
/** Kantel reads and writes files of up to 1 MiB. */
const MAX_FILE = 1024 * 1024;

function choice<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T | undefined {
	if (value === undefined) return undefined;
	const found = allowed.find((item) => item === value);
	if (found === undefined) throw new UsageError(`${what} must be one of ${allowed.join(", ")}, not "${value}"`);
	return found;
}

function choices<T extends string>(values: readonly string[], allowed: readonly T[], what: string): T[] | undefined {
	if (values.length === 0) return undefined;
	const picked: T[] = [];
	for (const value of values) {
		const item = choice(value, allowed, what);
		if (item !== undefined) picked.push(item);
	}
	return picked;
}

function whole(value: string | undefined, what: string, min = 1): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value) || Number(value) < min) {
		throw new UsageError(`${what} must be a whole number of at least ${min}, not "${value}"`);
	}
	return Number(value);
}

function pairs(values: readonly string[], what: string): { [key: string]: string } | undefined {
	if (values.length === 0) return undefined;
	const record: { [key: string]: string } = {};
	for (const item of values) {
		const eq = item.indexOf("=");
		if (eq <= 0) throw new UsageError(`${what} takes key=value, not "${item}"`);
		record[item.slice(0, eq)] = item.slice(eq + 1);
	}
	return record;
}

const autoStopOf = (value: string | undefined): number | null | undefined =>
	value === "never" ? null : whole(value, "--auto-stop");

/** One word for a POSIX shell, quoted only when it needs to be. */
export function shellQuote(word: string): string {
	if (/^[\w@%+=:,./-]+$/.test(word)) return word;
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** What `exec` runs: one word as a shell command line, as it is; several as a command and its arguments, quoted. */
export function commandLine(words: readonly string[]): string {
	const [only] = words;
	return words.length === 1 && only !== undefined ? only : words.map(shellQuote).join(" ");
}

async function readAll(input: Input): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for await (const chunk of input) chunks.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
	return Buffer.concat(chunks);
}

/** `content` as text when it is UTF-8 with no NUL, else undefined. */
function utf8(content: Uint8Array): string | undefined {
	if (content.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
	} catch {
		return undefined;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readTextIfAny(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT")
			return undefined;
		throw error;
	}
}

function sameUrl(a: string, b: string): boolean {
	try {
		return normaliseUrl(a) === normaliseUrl(b);
	} catch {
		return false;
	}
}

const fileCount = (count: number): string => (count === 1 ? "1 file" : `${count} files`);

const more = (cursor: string | undefined, command: string): string =>
	cursor === undefined ? "" : `\n\nMore: ${command} --cursor ${cursor}`;

const hasValue = (value: string | undefined): value is string => value !== undefined && value !== "";

// Human output.

function callerName(caller: Caller): string {
	if (caller.user !== undefined) {
		return caller.user.email === undefined ? caller.user.name : `${caller.user.name} <${caller.user.email}>`;
	}
	if (caller.apiKey !== undefined) return `the key ${caller.apiKey.name} (${caller.apiKey.id})`;
	return "an unknown caller";
}

const kindOf = (sandbox: Sandbox): string =>
	sandbox.type === "microvm" && sandbox.size !== undefined ? `microvm ${sandbox.size}` : sandbox.type;

const stateOf = (sandbox: Sandbox): string => {
	const state = sandbox.placementReason === undefined ? sandbox.state : `${sandbox.state} (${sandbox.placementReason})`;
	return sandbox.reason === undefined ? state : `${state}: ${sandbox.reason}`;
};

function sandboxTable(sandboxes: readonly Sandbox[]): string {
	return table(
		["ID", "NAME", "TYPE", "STATE", "CREATED", "STOPS"],
		sandboxes.map((sandbox) => [
			sandbox.id,
			sandbox.name,
			kindOf(sandbox),
			sandbox.state,
			ago(sandbox.createdAt),
			sandbox.stopsAt === undefined ? "" : until(sandbox.stopsAt),
		]),
	);
}

function describeSandbox(sandbox: Sandbox): string {
	const resources = sandbox.resources;
	const machine = [
		sandbox.type,
		sandbox.size,
		resources === undefined ? undefined : `${resources.vcpus} vCPU, ${resources.memoryMb} MB, ${resources.diskGb} GB`,
	].filter((part) => part !== undefined);
	const autoStop = sandbox.autoStopMinutes === null ? "never" : `after ${sandbox.autoStopMinutes} min`;
	const labels = Object.entries(sandbox.labels).map(([key, value]) => `${key}=${value}`);
	const { cost } = sandbox;
	return fields([
		["id", sandbox.id],
		["name", sandbox.name],
		["type", machine.join(", ")],
		["image", sandbox.image],
		["state", stateOf(sandbox)],
		["health", sandbox.health === "degraded" ? "degraded" : undefined],
		["visibility", sandbox.visibility],
		["labels", labels.join(", ")],
		["auto-stop", sandbox.stopsAt === undefined ? autoStop : `${autoStop} (stops ${until(sandbox.stopsAt)})`],
		["snapshot", sandbox.latestSnapshotId],
		["created", `${timestamp(sandbox.createdAt)} (${ago(sandbox.createdAt)})`],
		["running", duration(sandbox.usage.runningSeconds)],
		["cost", `${money(cost.total, cost.currency)} (${money(cost.ratePerHour, cost.currency)} an hour)`],
	]);
}

function fileTable(list: FileList): string {
	if (list.items.length === 0) return `${list.path} is empty.`;
	return table(
		["KIND", "SIZE", "MODIFIED", "NAME"],
		list.items.map((entry) => [
			entry.kind === "directory" ? "dir" : entry.kind === "symlink" ? "link" : "file",
			entry.kind === "file" ? bytes(entry.size) : "",
			entry.modifiedAt === undefined ? "" : ago(entry.modifiedAt),
			entry.kind === "directory" ? `${entry.name}/` : entry.name,
		]),
	);
}

function keyState(key: ApiKey): string {
	if (key.revokedAt !== undefined) return "revoked";
	if (key.expiresAt !== undefined) return key.expiresAt <= Date.now() ? "expired" : `expires ${until(key.expiresAt)}`;
	return "active";
}

function issuedKey(issued: IssuedApiKey): string {
	return [
		`${issued.key.id} (${issued.key.name}): ${issued.key.scopes.join(", ")}`,
		"",
		`  ${issued.secret}`,
		"",
		"Store it now: it isn't shown again.",
	].join("\n");
}

/** A command's exit code: its own, 124 when it timed out (as timeout(1) does), 137 when it was killed. */
/** One of an account's own hosts, for `kantel host info`. */
function describeHost(host: Host): string {
	const labels = Object.entries(host.labels).map(([key, value]) => `${key}=${value}`);
	return fields([
		["id", host.id],
		["name", host.name],
		["state", host.state],
		["account", host.accountId],
		["version", host.version],
		["machine", [host.os, host.arch].filter(hasValue).join("/") || undefined],
		["tiers", host.tiers.join(", ")],
		["kvm", host.kvm ? "yes" : "no"],
		["capacity", `${host.capacity.vcpus} vCPUs, ${host.capacity.memoryMb} MB memory, ${host.capacity.diskGb} GB disk`],
		["sandboxes", String(host.allocated.sandboxes)],
		["labels", labels.length === 0 ? undefined : labels.join(", ")],
		["joined", timestamp(host.joinedAt)],
		["last seen", host.lastSeenAt === undefined ? undefined : ago(host.lastSeenAt)],
	]);
}

function exitCodeOf(command: Command): number {
	if (command.state === "timed_out") return 124;
	if (command.exitCode !== undefined) return command.exitCode;
	if (command.state === "killed") return 137;
	return command.state === "running" ? 0 : 1;
}

// The client.

function makeClient(io: Io, config: ResolvedConfig): KantelClient {
	const base = io.fetch;
	const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		try {
			return await base(input, init);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
			const reason = cause instanceof Error ? cause.message : String(cause);
			throw new CliError(`couldn't reach Kantel at ${originOf(config.url)}: ${reason}`);
		}
	};
	return createKantelClient({
		baseUrl: config.url,
		token: config.apiKey,
		fetch: guarded,
		headers: () => ({ "user-agent": `kantel-cli/${VERSION}` }),
	});
}

function runSsh(args: readonly string[], io: Io, env?: Readonly<Record<string, string>>): Promise<number> {
	return new Promise((done) => {
		const child = spawn("ssh", [...args], {
			stdio: "inherit",
			...(env === undefined ? {} : { env: { ...process.env, ...env } }),
		});
		child.once("error", (error) => {
			io.stderr.write(`kantel: couldn't run ssh: ${error.message}\n`);
			done(127);
		});
		child.once("exit", (code) => done(code ?? 1));
	});
}

// Flags.

const GLOBAL_FLAGS: FlagSpecs = {
	url: { type: "string", value: "<url>", description: `Kantel's URL (KANTEL_URL; default ${DEFAULT_URL})` },
	key: { type: "string", value: "<key>", description: "An API key (KANTEL_API_KEY); also --api-key" },
	"api-key": { type: "string", value: "<key>", description: "The same as --key", hidden: true },
	account: { type: "string", value: "<id>", description: "The account to act in (KANTEL_ACCOUNT)" },
	json: { type: "boolean", description: "Print Kantel's JSON answer as it is" },
	help: { type: "boolean", short: "h", description: "Show a command's help" },
};

const cursorFlag: FlagSpec = { type: "string", value: "<cursor>", description: "The next page, from a list's More" };
const noWait: FlagSpec = { type: "boolean", description: "Answer at once rather than once it runs" };
const viewOnly: FlagSpec = { type: "boolean", description: "Watch only: no keyboard or mouse" };
const ttl: FlagSpec = {
	type: "string",
	value: "<minutes>",
	description: "How long the URL can be opened for (default 10, at most 60)",
};
const sizeFlag: FlagSpec = { type: "string", value: "<small|default|large|xlarge>", description: "A microVM's size" };
const printOnly: FlagSpec = { type: "boolean", description: "Print the URL without opening it" };

/** Opens `url` in the browser when a person is at a terminal, and hasn't asked for the URL only. */
function openIfPerson(ctx: Context, url: string): void {
	if (ctx.boolean("print") || ctx.json || ctx.io.stdout.isTTY !== true || hasValue(ctx.io.env.KANTEL_NO_BROWSER))
		return;
	ctx.io.openUrl(url);
}

const ID_ARG: readonly Arg[] = [{ name: "id" }];

/** The start, stop, resume and recover commands, alike but for the call. */
function lifecycle(
	verb: string,
	summary: string,
	flags: FlagSpecs,
	call: (client: KantelClient, sandboxId: string, ctx: Context) => Promise<Sandbox>,
): CommandSpec {
	return {
		name: verb,
		summary,
		args: ID_ARG,
		flags,
		async run(ctx) {
			const sandbox = await call(await ctx.client(), ctx.arg(0), ctx);
			ctx.emit(sandbox, () => `${sandbox.id} ${stateOf(sandbox)}`);
			return sandbox.state === "error" ? 1 : 0;
		},
	};
}

/** A finished command's output on our stdout and stderr, and what became of it on stderr. */
function printOutput(ctx: Context, command: Command): void {
	if (command.stdout !== "") ctx.io.stdout.write(command.stdout);
	if (command.stderr !== "") ctx.io.stderr.write(command.stderr);
	if (command.truncated) ctx.note("kantel: the output was cut at 1 MiB");
	if (command.state === "killed") ctx.note("kantel: the command was killed");
}

/** `kantel exec --status`: the command as JSON, or its state and output so far. */
function showCommand(ctx: Context, command: Command): number {
	if (ctx.json) {
		ctx.out(JSON.stringify(command, null, 2));
		return 0;
	}
	const code = command.exitCode === undefined ? "" : ` ${command.exitCode}`;
	ctx.note(`kantel: ${command.id} ${command.state}${code}: ${command.command}`);
	printOutput(ctx, command);
	return 0;
}

function killed(ctx: Context, command: Command): number {
	ctx.emit(command, () => `${command.id} ${command.state}`);
	return 0;
}

/**
 * Follows a detached command: prints what it has written since the last look, every second or so, until it ends, and
 * answers its exit code. Kantel keeps a command's first 1 MiB of each stream, so that is all it can show.
 */
async function follow(
	ctx: Context,
	client: KantelClient,
	sandboxId: string,
	commandId: string,
	first?: Command,
): Promise<number> {
	let shown = { stdout: 0, stderr: 0 };
	let wait = 250;
	let command = first ?? (await client.getCommand(sandboxId, commandId));
	if (!ctx.json && first !== undefined) ctx.note(`kantel: started ${command.id}; Ctrl-C leaves it running`);
	for (;;) {
		if (!ctx.json) {
			const out = command.stdout.slice(shown.stdout);
			const err = command.stderr.slice(shown.stderr);
			if (out !== "") ctx.io.stdout.write(out);
			if (err !== "") ctx.io.stderr.write(err);
			shown = { stdout: command.stdout.length, stderr: command.stderr.length };
		}
		if (command.state !== "running") break;
		await ctx.io.sleep(wait);
		wait = Math.min(wait * 2, 1000);
		command = await client.getCommand(sandboxId, commandId);
	}
	if (ctx.json) ctx.out(JSON.stringify(command, null, 2));
	else {
		if (command.truncated) ctx.note("kantel: the output was cut at 1 MiB");
		if (command.state === "killed") ctx.note("kantel: the command was killed");
		if (command.state === "timed_out") ctx.note("kantel: the command timed out and was killed");
	}
	return exitCodeOf(command);
}

/** `--host 3000` or `--host 8080:public`. */
function hostedPort(value: string): { port: number; public?: true } {
	const match = /^(\d+)(:public)?$/.exec(value);
	if (match === null) throw new UsageError(`--host takes a port, or port:public, not "${value}"`);
	const port = Number(match[1]);
	if (port < 1 || port > 65535) throw new UsageError(`--host ${value} isn't a port`);
	return match[2] === undefined ? { port } : { port, public: true };
}

/**
 * The browser sign-in: the new key, or undefined when it only printed the code (no terminal and no `--wait`). It keeps
 * the code until it is used, so running `login` again carries on with it.
 */
async function browserLogin(ctx: Context, url: string): Promise<IssuedApiKey | undefined> {
	const client = makeClient(ctx.io, { url });
	const now = Date.now;
	const pending: PendingLogin =
		(await readPendingLogin(ctx.io.configDir, url, now())) ??
		(await startLogin(client, url, ctx.string("name") ?? `kantel on ${hostname()}`, ctx.io.configDir));
	const interactive = ctx.io.stdout.isTTY === true && !ctx.json;
	const waiting = interactive || ctx.boolean("wait");
	const shown = {
		event: "login_pending",
		url: pending.verificationUrlComplete,
		code: pending.userCode,
		expiresAt: pending.expiresAt,
	};
	// With --json, stdout holds one document: this when it stops here, else the signed-in caller.
	if (ctx.json) (waiting ? ctx.note : ctx.out)(JSON.stringify(shown));
	else {
		const say = interactive ? ctx.out : ctx.note;
		say(`Open this page and check the code matches: ${pending.userCode}`);
		say(`  ${pending.verificationUrlComplete}`);
	}
	if (!waiting) {
		// The same --url, or --wait would sign in to the saved or default URL, where this code isn't known.
		const flagUrl = ctx.string("url");
		if (!ctx.json) ctx.note(`Then run: kantel login --wait${flagUrl === undefined ? "" : ` --url ${originOf(url)}`}`);
		return undefined;
	}
	if (interactive && !ctx.boolean("no-browser") && !hasValue(ctx.io.env.KANTEL_NO_BROWSER)) {
		ctx.io.openUrl(pending.verificationUrlComplete);
	}
	if (interactive) ctx.out("Waiting for you to approve it in the browser…");
	return waitForLogin(client, pending, ctx.io.configDir, ctx.io.sleep, now);
}

// Environments and egress.

/** An environment's ID: `<env>` itself when it is one (`env_…`), else the ID of the one with that name in the account. */
async function environmentIdOf(ctx: Context, client: KantelClient, ref: string): Promise<string> {
	if (ref.startsWith("env_")) return ref;
	const config = await ctx.config();
	const list = await client.listEnvironments(config.account === undefined ? {} : { account: config.account });
	const found = list.items.find((environment) => environment.name === ref);
	if (found === undefined) throw new CliError(`there is no environment called "${ref}": kantel env list shows them`);
	return found.id;
}

async function loadEnvironment(ctx: Context, client: KantelClient, ref: string): Promise<Environment> {
	return client.getEnvironment(await environmentIdOf(ctx, client, ref));
}

/** A value from stdin, less one final newline, for `env set --value-stdin`. It is never printed. */
async function valueFromStdin(ctx: Context): Promise<string> {
	const stdin = ctx.io.stdin();
	if (stdin.isTTY === true) ctx.note("kantel: reading the value from stdin; end it with Ctrl-D");
	const value = new TextDecoder().decode(await readAll(stdin)).replace(/\r?\n$/, "");
	if (value === "") throw new UsageError("there was no value on stdin");
	return value;
}

/** `--mode 0600`: a file mode in octal. */
function modeOf(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^0?[0-7]{3}$/.test(value)) throw new UsageError(`--mode takes an octal mode such as 0600, not "${value}"`);
	return Number.parseInt(value, 8);
}

/** The grant flags `env grant` and `grant` share. */
const GRANT_FLAGS: FlagSpecs = {
	method: {
		type: "string",
		multiple: true,
		value: "<METHOD>",
		description: "Only requests with this method, such as DELETE; repeat it",
	},
	path: {
		type: "string",
		multiple: true,
		value: "<pattern>",
		description: "Only these paths: * is one segment, ** the rest; repeat it",
	},
};

const GRANT_DETAILS =
	"Grants apply on top of the account's proxy settings: the environment's, then the sandbox's own, and deny wins.\n" +
	"A grant with --method or --path has the egress proxy open that host's HTTPS to read each request.\n" +
	"Quote a pattern so your shell leaves its * alone:";

/** Where a new grant went: the grant in `after` whose ID wasn't in `before`. */
function addedGrantId(before: readonly { readonly id: string }[], after: readonly { readonly id: string }[]): string {
	const known = new Set(before.map((grant) => grant.id));
	const added = after.find((grant) => !known.has(grant.id));
	return added === undefined ? "" : ` (${added.id})`;
}

/** The other grants: all but `id`, or a `CliError` when there is none with that ID. */
function withoutGrant<T extends { readonly id: string }>(grants: readonly T[], id: string, where: string): T[] {
	const kept = grants.filter((grant) => grant.id !== id);
	if (kept.length === grants.length) throw new CliError(`${where} has no grant ${id}`);
	return kept;
}

/** How many times an edit of a list is read and written again when the list changed in between. */
const EDIT_ATTEMPTS = 3;

/**
 * Runs `edit`, which reads a list, changes it and writes it with `expected` the list as read: Kantel refuses the write
 * with `conflict` when the list changed in between, and the edit is made again on what is there now, so no one
 * else's change is lost. Answers the last attempt's result.
 */
async function editAsRead<T>(edit: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await edit();
		} catch (error) {
			if (attempt >= EDIT_ATTEMPTS || !(error instanceof KantelApiError) || error.code !== "conflict") throw error;
		}
	}
}

/** A variable as Kantel answered it, when the answer is an environment holding it. */
function variableIn(
	answer: unknown,
	name: string,
): { readonly protected: boolean; readonly bindings: readonly Binding[] } | undefined {
	if (typeof answer !== "object" || answer === null) return undefined;
	const variables = (answer as { readonly variables?: unknown }).variables;
	if (!Array.isArray(variables)) return undefined;
	const found = variables.find(
		(variable): variable is { name: string; protected: boolean; bindings: Binding[] } =>
			typeof variable === "object" &&
			variable !== null &&
			variable.name === name &&
			typeof variable.protected === "boolean" &&
			Array.isArray(variable.bindings),
	);
	return found === undefined ? undefined : { protected: found.protected, bindings: found.bindings };
}

/** A secret file as Kantel answered it, when the answer is an environment holding it at `path`. */
function fileIn(answer: unknown, path: string): { readonly mode: number; readonly sizeBytes: number } | undefined {
	if (typeof answer !== "object" || answer === null) return undefined;
	const files = (answer as { readonly files?: unknown }).files;
	if (!Array.isArray(files)) return undefined;
	// Kantel answers the path as it keeps it, absolute under /home/user (`~/` is there too); the command has it as typed.
	const wanted = new Set([path, posix.resolve("/home/user", path.startsWith("~/") ? path.slice(2) : path)]);
	const found = files.find(
		(file): file is { path: string; mode: number; sizeBytes: number } =>
			typeof file === "object" &&
			file !== null &&
			wanted.has(file.path) &&
			typeof file.mode === "number" &&
			typeof file.sizeBytes === "number",
	);
	return found === undefined ? undefined : { mode: found.mode, sizeBytes: found.sizeBytes };
}

// The commands.

// End-to-end encryption (e2e.ts).

/** The space a command acts in: --account, the config's, or the caller's own. */
async function e2eSpace(ctx: Context): Promise<string> {
	const account = (await ctx.config()).account;
	return account ?? (await (await ctx.client()).getCaller()).accountId;
}

async function e2eUser(ctx: Context): Promise<string> {
	const user = (await (await ctx.client()).getCaller()).user;
	if (user === undefined) throw new CliError("Sign in as a person (kantel login): an API key has no devices");
	return user.id;
}

const e2eFailure = (error: unknown) => new CliError(error instanceof Error ? error.message : String(error));

async function e2eChainOf(ctx: Context): Promise<{ chain: e2e.VerifiedChain; device: e2e.Device }> {
	try {
		const space = await e2eSpace(ctx);
		const [device, chain] = await Promise.all([
			e2e.loadDevice(ctx.io.configDir),
			e2e.verifiedChain(await ctx.client(), ctx.io.configDir, space),
		]);
		return { chain, device };
	} catch (error) {
		if (error instanceof KantelApiError) throw error;
		throw e2eFailure(error);
	}
}

/**
 * Signs `body` with this device after `checked`'s head (the chain whatever decided on it was read from) and adds it.
 * If another entry got there first, the gateway refuses it: nothing decided on an older chain is signed onto a newer
 * one.
 */
async function e2eSign(
	ctx: Context,
	checked: { chain: e2e.VerifiedChain; device: e2e.Device },
	body: EntryBody,
): Promise<e2e.VerifiedChain> {
	return e2e.appendEntry(await ctx.client(), ctx.io.configDir, checked.device, checked.chain, body).catch((error) => {
		if (error instanceof KantelApiError && error.code === "conflict") {
			throw new CliError("The chain changed while this ran (another change got there first): run it again");
		}
		if (error instanceof KantelApiError) throw error;
		throw e2eFailure(error);
	});
}

const emitChain = (ctx: Context, chain: e2e.VerifiedChain, done: string) =>
	ctx.emit({ space: chain.state.space, seq: chain.state.seq, head: chain.state.head }, () => done);

/** Signs and adds one entry with this device, and says what the chain is now. */
async function e2eAppend(ctx: Context, body: EntryBody, done: string): Promise<void> {
	emitChain(ctx, await e2eSign(ctx, await e2eChainOf(ctx), body), done);
}

/** Every sandbox in the space now, stopped ones too: those turning E2E on retires. */
async function spaceSandboxes(ctx: Context, space: string): Promise<string[]> {
	const client = await ctx.client();
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listSandboxes({ account: space, all: true, cursor });
		ids.push(...page.items.map((item) => item.id));
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	return ids;
}

const RETIRE_FLAGS = {
	yes: { type: "boolean", short: "y", description: "Yes, retire the space's existing sandboxes" },
} as const;

/**
 * Turning E2E on retires every sandbox the space has: hosts give sessions only to sandboxes they make while E2E is on,
 * as the gateway could have changed an older one. Without --yes this lists them and stops.
 */
async function confirmRetiring(ctx: Context, space: string, again: string): Promise<void> {
	const ids = await spaceSandboxes(ctx, space);
	if (ids.length === 0 || ctx.boolean("yes")) return;
	const shown = ids.slice(0, 20).join(", ") + (ids.length > 20 ? ` and ${ids.length - 20} more` : "");
	throw new UsageError(
		`Turning E2E on retires ${space}'s ${ids.length} existing sandbox${ids.length === 1 ? "" : "es"}: ${shown}. ` +
			"Hosts open E2E sessions only to sandboxes made while E2E is on, and the gateway can't reach these either. " +
			"Nothing is deleted: kantel delete <id> --yes removes them when you're done. " +
			`To go ahead, run: ${again} --yes`,
	);
}

/** What `kantel e2e ssh-proxy` is run with: the gateway, credential and account this invocation resolved. */
export function proxyEnv(config: ResolvedConfig): Record<string, string> {
	return {
		KANTEL_URL: config.url,
		...(config.apiKey === undefined ? {} : { KANTEL_API_KEY: config.apiKey }),
		...(config.account === undefined ? {} : { KANTEL_ACCOUNT: config.account }),
	};
}

/** A page of a sandbox's command history, as its host keeps it (`sandbox.history`), newest first. */
export interface E2EHistoryPage {
	readonly items: readonly E2EHistoryEntry[];
	readonly next?: string;
}

export interface E2EHistoryEntry {
	readonly id: string;
	readonly command?: string;
	readonly argv?: readonly string[];
	readonly cwd?: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly exitCode?: number;
	readonly timedOut?: boolean;
	readonly error?: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated?: boolean;
	readonly device: string;
	readonly deviceLabel?: string;
	readonly deviceClass?: string;
	readonly member?: string;
}

/** An `rpc` session's call, with its error as the CLI's. */
async function e2eCall<T>(ctx: Context, sandboxId: string, method: string, params: object): Promise<T> {
	let session: e2e.OpenedE2E;
	try {
		session = await e2e.openE2ESession(
			await ctx.client(),
			ctx.io.configDir,
			sandboxId,
			"rpc",
			undefined,
			ctx.io.connect,
		);
	} catch (error) {
		if (error instanceof KantelApiError) throw error;
		throw e2eFailure(error);
	}
	const client = new SessionClient(session);
	try {
		return await client.call<T>(method, params);
	} catch (error) {
		// The host's own refusal keeps its code, for `kantel console` to pass on (a path it won't read isn't a failure).
		if (error instanceof SessionError && error.answered) throw new HostAnswerError(error.code, error.message);
		throw e2eFailure(error);
	} finally {
		client.close();
	}
}

const E2E_DETAILS =
	"Sessions go through the gateway's relay to the sandbox's host, which only that host can read: this device checks\n" +
	"the host's key, and the host this device's, against the organisation's signed chain. The chain is trusted from\n" +
	"its genesis, which this device made (init) or an admin gave it (join), never from the gateway.";

const E2E_COMMANDS: readonly CommandSpec[] = [
	{
		name: "console",
		summary: "Open the console from this CLI on 127.0.0.1, with E2E sandboxes' commands and history",
		flags: {
			port: { type: "string", value: "<port>", description: "Where it listens on 127.0.0.1 (default a free port)" },
			"no-browser": { type: "boolean", description: "Only print the link (also KANTEL_NO_BROWSER)" },
			dir: { type: "string", value: "<dir>", description: "The console's built files, if not this CLI's own" },
		},
		details:
			"The console's code comes from this CLI's release, not from the gateway, so the gateway can't change what runs\n" +
			"it. Its API calls go to the gateway with this CLI's key, which stays here. In an end-to-end encrypted\n" +
			"organisation, commands, files and history go to the sandbox's host over sessions with this device's key.\n" +
			"Only the browser that opens the printed link gets in. Ctrl-C stops it.",
		async run(ctx) {
			const config = await ctx.config();
			if (config.apiKey === undefined) throw new CliError("Sign in first: kantel login");
			const portFlag = ctx.string("port");
			const port = portFlag === undefined ? 0 : Number(portFlag);
			if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new UsageError("--port is a port number");
			const served = await serveLocalConsole({
				dir: await consoleDir(ctx),
				gateway: config.url,
				apiKey: config.apiKey,
				fetch: ctx.io.fetch,
				userAgent: `kantel-cli/${VERSION} (console)`,
				port,
				info: () => localInfo(ctx),
				e2eCall: (sandboxId, method, params) => e2eCall(ctx, sandboxId, method, params),
			});
			try {
				ctx.emit(
					{ url: served.url },
					() => `The console is at ${served.url}\nOnly this link lets a browser in. Ctrl-C stops it.`,
				);
				if (!ctx.boolean("no-browser") && !hasValue(ctx.io.env.KANTEL_NO_BROWSER)) ctx.io.openUrl(served.url);
				await ctx.io.served(served);
			} finally {
				await served.close();
			}
		},
	},
	{
		name: "e2e status",
		summary: "This device, and the organisation's chain as this device verifies it",
		details: E2E_DETAILS,
		async run(ctx) {
			const device = await e2e.loadDevice(ctx.io.configDir);
			const space = await e2eSpace(ctx);
			const pinned = await e2e.pinnedGenesis(ctx.io.configDir, space);
			const state =
				pinned === undefined
					? undefined
					: (
							await e2e.verifiedChain(await ctx.client(), ctx.io.configDir, space).catch((error: unknown) => {
								throw e2eFailure(error);
							})
						).state;
			const view = {
				device: { id: device.id, label: device.label, fingerprint: await e2e.deviceFingerprint(device) },
				space,
				...(state === undefined
					? {}
					: {
							genesis: state.genesis,
							mode: state.mode,
							seq: state.seq,
							inChain: state.devices.has(device.id),
							members: Object.fromEntries(state.members),
							devices: [...state.devices.values()],
							hosts: [...state.hosts.values()],
						}),
			};
			ctx.emit(view, () => {
				const lines = [`This device: ${device.id} (${device.label}), fingerprint ${view.device.fingerprint}`];
				if (state === undefined) {
					lines.push(`${space}: this device trusts no chain yet (kantel e2e init, or kantel e2e join)`);
					return lines.join("\n");
				}
				lines.push(
					`${space}: E2E ${state.mode}, ${state.seq + 1} entries, genesis ${state.genesis}`,
					state.devices.has(device.id) ? "This device is in the chain." : "This device isn't in the chain yet.",
					"",
					table(
						["DEVICE", "PERSON", "ROLE", "CLASS", "LABEL"],
						[...state.devices.values()].map((d) => [d.id, d.user, state.members.get(d.user) ?? "", d.class, d.label]),
					),
					"",
					state.hosts.size === 0
						? "No hosts yet: kantel e2e host-ticket <name>."
						: table(
								["HOST", "NAME"],
								[...state.hosts.values()].map((h) => [h.id, h.name]),
							),
				);
				return lines.join("\n");
			});
		},
	},
	{
		name: "e2e init",
		summary: "Start the organisation's chain with this device as its first admin (an admin or owner)",
		flags: {
			mode: {
				type: "string",
				value: "<on|strict>",
				description: "strict also keeps the hosted console out; default on",
			},
			label: {
				type: "string",
				value: "<label>",
				description: "This device's name in the chain (default kantel on <host>)",
			},
			...RETIRE_FLAGS,
		},
		details:
			`${E2E_DETAILS}\nWith E2E on, the organisation's hosts in the chain run commands, files and ports only in sessions, ` +
			"and only in sandboxes they make while it is on: the space's existing sandboxes are retired (needs --yes).",
		async run(ctx) {
			const mode = choice(ctx.string("mode"), ["on", "strict"] as const, "--mode") ?? "on";
			const device = await e2e.loadDevice(ctx.io.configDir, ctx.string("label") ?? `kantel on ${hostname()}`);
			const space = await e2eSpace(ctx);
			await confirmRetiring(ctx, space, `kantel e2e init${mode === "on" ? "" : ` --mode ${mode}`}`);
			const chain = await e2e
				.initChain(await ctx.client(), ctx.io.configDir, device, space, await e2eUser(ctx), mode)
				.catch((error: unknown) => {
					if (error instanceof KantelApiError) throw error;
					throw e2eFailure(error);
				});
			// What the chain says, not what was asked: a resumed init finishes the one it started, whose mode was signed
			// then (a different one isn't resumed), and entries after its genesis may have changed it since.
			const started = chain.state.mode;
			ctx.emit({ space, genesis: chain.state.genesis, mode: started }, () =>
				[
					`Started ${space}'s chain, E2E ${started}. Its genesis is ${chain.state.genesis}.`,
					...(started === mode ? [] : [`It is E2E ${started}, not ${mode}: kantel e2e mode ${mode} changes it.`]),
					"Give each member that genesis yourself (not through Kantel) for: kantel e2e join " +
						`${space} ${chain.state.genesis}`,
					"Then enrol your hosts: kantel e2e host-ticket <name>.",
				].join("\n"),
			);
		},
	},
	{
		name: "e2e join",
		summary: "Trust an organisation's chain from the genesis an admin gave you",
		args: [{ name: "space" }, { name: "genesis" }],
		flags: {
			label: { type: "string", value: "<label>", description: "This device's name (default kantel on <host>)" },
		},
		async run(ctx) {
			const [space, genesis] = [ctx.arg(0), ctx.arg(1)];
			const device = await e2e.loadDevice(ctx.io.configDir, ctx.string("label") ?? `kantel on ${hostname()}`);
			await e2e.pinGenesis(ctx.io.configDir, space, genesis).catch((error: unknown) => {
				throw e2eFailure(error);
			});
			const card = await e2e.deviceCard(device, await e2eUser(ctx));
			const print = await e2e.deviceFingerprint(device);
			ctx.emit({ space, genesis, card, fingerprint: print }, () =>
				[
					`This device trusts ${space}'s chain from ${e2e.short(genesis)}.`,
					"Unless it is in the chain already, send an admin this, and check the fingerprint with them:",
					`kantel e2e add-device --member ${card}`,
					`Fingerprint: ${print}`,
				].join("\n"),
			);
		},
	},
	{
		name: "e2e device",
		summary: "This device's card, for an admin's kantel e2e add-device",
		flags: {
			label: { type: "string", value: "<label>", description: "This device's name (default kantel on <host>)" },
		},
		details: "Send the card to an admin yourself; they check the fingerprint with you before they add it.",
		async run(ctx) {
			const device = await e2e.loadDevice(ctx.io.configDir, ctx.string("label") ?? `kantel on ${hostname()}`);
			const card = await e2e.deviceCard(device, await e2eUser(ctx));
			const print = await e2e.deviceFingerprint(device);
			ctx.emit({ id: device.id, card, fingerprint: print }, () =>
				[`kantel e2e add-device ${card}`, `Fingerprint: ${print}`].join("\n"),
			);
		},
	},
	{
		name: "e2e add-device",
		summary: "Add a person's device to the chain from its card (yours, or anyone's as an admin)",
		args: [{ name: "card" }],
		flags: { member: { type: "boolean", description: "Also add its person to the chain as a member, if they aren't" } },
		async run(ctx) {
			const device = await e2e.parseCard(ctx.arg(0)).catch((error: unknown) => {
				throw new UsageError(error instanceof Error ? error.message : String(error));
			});
			const print = await e2e.cardFingerprint(device);
			ctx.note(`Adding ${device.id} (${device.label}) for ${device.user}, fingerprint ${print}: check it with them.`);
			// Whether they are a member is read from the chain the member.add is signed onto, so an admin made one in the
			// meantime is never made a member again.
			const checked = await e2eChainOf(ctx);
			let { chain } = checked;
			if (ctx.boolean("member") && !chain.state.members.has(device.user)) {
				chain = await e2eSign(ctx, checked, { type: "member.add", body: { user: device.user, role: "member" } });
			}
			chain = await e2eSign(ctx, { chain, device: checked.device }, { type: "device.add", body: { device } });
			emitChain(
				ctx,
				chain,
				`Added ${device.id}. They trust the chain with: kantel e2e join ${chain.state.space} ${chain.state.genesis}`,
			);
		},
	},
	{
		name: "e2e remove-device",
		summary: "Take a device out of the chain: hosts refuse its sessions from then on",
		args: [{ name: "device" }],
		async run(ctx) {
			await e2eAppend(ctx, { type: "device.remove", body: { id: ctx.arg(0) } }, `Removed ${ctx.arg(0)}.`);
		},
	},
	{
		name: "e2e add-member",
		summary: "Let a member of the organisation into the chain (an admin's device)",
		args: [{ name: "user" }],
		flags: { admin: { type: "boolean", description: "As an admin of the chain" } },
		async run(ctx) {
			const role = ctx.boolean("admin") ? "admin" : "member";
			await e2eAppend(ctx, { type: "member.add", body: { user: ctx.arg(0), role } }, `${ctx.arg(0)} is a ${role}.`);
		},
	},
	{
		name: "e2e remove-member",
		summary: "Take a person and all their devices out of the chain (an admin's device)",
		args: [{ name: "user" }],
		async run(ctx) {
			await e2eAppend(ctx, { type: "member.remove", body: { user: ctx.arg(0) } }, `Removed ${ctx.arg(0)}.`);
		},
	},
	{
		name: "e2e host-ticket",
		summary: "A one-off ticket for a host to join the chain (an admin's device)",
		args: [{ name: "name" }],
		flags: { expires: { type: "string", value: "<minutes>", description: "How long it lasts, default 60" } },
		details:
			"Run the command it prints on the host, as root: the host signs its own entry with the ticket and adds it.\n" +
			"The ticket is a secret until it is used, and works once.",
		async run(ctx) {
			const { chain, device } = await e2eChainOf(ctx);
			const word = await e2e
				.hostTicket(device, chain, ctx.arg(0), whole(ctx.string("expires"), "--expires") ?? 60)
				.catch((error: unknown) => {
					throw e2eFailure(error);
				});
			const command = `sudo kantel-host e2e join ${word}`;
			ctx.emit({ ticket: word, command }, () => command);
		},
	},
	{
		name: "e2e remove-host",
		summary: "Take a host out of the chain: devices won't open sessions to it",
		args: [{ name: "host" }],
		async run(ctx) {
			await e2eAppend(ctx, { type: "host.remove", body: { id: ctx.arg(0) } }, `Removed ${ctx.arg(0)}.`);
		},
	},
	{
		name: "e2e mode",
		summary: "Turn E2E off, on, or strict (strict also keeps the hosted console out)",
		args: [{ name: "mode" }],
		flags: RETIRE_FLAGS,
		details:
			"Turning it on (from off) retires the space's existing sandboxes (needs --yes): hosts open sessions only to " +
			"sandboxes made while E2E is on, and turning it off and on again retires those too.",
		async run(ctx) {
			const mode = choice(ctx.arg(0), ["off", "on", "strict"] as const, "The mode") ?? "on";
			// Signed onto the chain it was checked against: if it was turned off meanwhile, this is refused rather than
			// turning it on again without the confirmation.
			const checked = await e2eChainOf(ctx);
			if (mode !== "off" && checked.chain.state.mode === "off") {
				await confirmRetiring(ctx, checked.chain.state.space, `kantel e2e mode ${mode}`);
			}
			const done =
				mode === "off"
					? "E2E is off; hosts take it at their next session. Turning it on again retires every sandbox the space has then."
					: `E2E is ${mode}; hosts take it at their next session.`;
			emitChain(ctx, await e2eSign(ctx, checked, { type: "mode", body: { mode } }), done);
		},
	},
	{
		name: "e2e exec",
		summary: "Run a command in a sandbox over an E2E session",
		args: ID_ARG,
		rest: "command…",
		flags: { cwd: { type: "string", value: "<dir>", description: "Where it runs" } },
		details: E2E_DETAILS,
		async run(ctx) {
			const command = ctx.rest ?? [];
			if (command.length === 0) throw new UsageError("Give the command after --: kantel e2e exec <id> -- ls");
			const cwd = ctx.string("cwd");
			const result = await e2eCall<{ exitCode: number; stdout: string; stderr: string }>(
				ctx,
				ctx.arg(0),
				"sandbox.exec",
				{
					command: commandLine(command),
					...(cwd === undefined ? {} : { cwd }),
				},
			);
			if (ctx.json) {
				ctx.emit(result, () => "");
				return result.exitCode;
			}
			ctx.io.stdout.write(result.stdout);
			ctx.io.stderr.write(result.stderr);
			return result.exitCode;
		},
	},
	{
		name: "e2e history",
		summary: "The commands run in a sandbox over E2E sessions, from its host",
		args: ID_ARG,
		flags: {
			limit: { type: "string", value: "<n>", description: "How many, newest first (default 20, at most 100)" },
			before: { type: "string", value: "<command-id>", description: "Older than this one" },
			output: { type: "boolean", description: "Print each command's output too" },
		},
		details:
			"The gateway never sees what runs in an E2E session, so the host keeps the history: the last 200 commands of\n" +
			"each sandbox, with the last 64 KiB of their output. It goes when the sandbox is deleted, and can't be read\n" +
			"while the host is offline.",
		async run(ctx) {
			const limit = Number(ctx.string("limit") ?? "20");
			if (!Number.isInteger(limit) || limit < 1 || limit > 100)
				throw new UsageError("--limit is a number from 1 to 100");
			const before = ctx.string("before");
			const page = await e2eCall<E2EHistoryPage>(ctx, ctx.arg(0), "sandbox.history", {
				limit,
				...(before === undefined ? {} : { before }),
			});
			ctx.emit(page, () => {
				if (page.items.length === 0) return "No commands yet.";
				const lines = page.items.map((entry) => {
					const status = entry.exitCode === undefined ? (entry.error ?? "didn't finish") : `exit ${entry.exitCode}`;
					const who = entry.deviceLabel ?? entry.device;
					const head = `${entry.id}  ${new Date(entry.startedAt).toISOString()}  ${status}  ${who}\n  ${entry.command ?? (entry.argv ?? []).join(" ")}`;
					if (!ctx.boolean("output")) return head;
					const output = `${entry.stdout}${entry.stderr}`.trimEnd();
					return output === "" ? head : `${head}\n${output.replace(/^/gm, "    ")}`;
				});
				if (page.next !== undefined) lines.push(`More: kantel e2e history ${ctx.arg(0)} --before ${page.next}`);
				return lines.join("\n");
			});
		},
	},
	{
		name: "e2e cat",
		summary: "Print a sandbox's file, read over an E2E session",
		args: [{ name: "id" }, { name: "path" }],
		async run(ctx) {
			const read = await e2eCall<{ data: string }>(ctx, ctx.arg(0), "sandbox.files.read", { path: ctx.arg(1) });
			ctx.io.stdout.write(Buffer.from(read.data, "base64"));
		},
	},
	{
		name: "e2e put",
		summary: "Write a local file (or - for stdin) to a sandbox over an E2E session",
		args: [{ name: "id" }, { name: "local" }, { name: "remote" }],
		async run(ctx) {
			const local = ctx.arg(1);
			let data: Buffer;
			if (local === "-") {
				const chunks: Buffer[] = [];
				for await (const chunk of ctx.io.stdin()) chunks.push(Buffer.from(chunk));
				data = Buffer.concat(chunks);
			} else data = await readFile(resolve(ctx.io.cwd, local));
			if (data.byteLength > MAX_FILE) throw new UsageError("Kantel writes files of up to 1 MiB");
			await e2eCall(ctx, ctx.arg(0), "sandbox.files.write", { path: ctx.arg(2), data: data.toString("base64") });
			ctx.note(`Wrote ${bytes(data.byteLength)} to ${ctx.arg(2)}.`);
		},
	},
	{
		name: "e2e ssh",
		summary: "SSH into a microVM over an E2E session",
		args: ID_ARG,
		rest: "command…",
		restOptional: true,
		flags: {
			identity: {
				type: "string",
				value: "<file>",
				description: "Your SSH private key; its .pub is let in first (default ~/.ssh/id_ed25519)",
			},
		},
		details:
			"It lets your public key in over a session, then runs ssh with kantel e2e ssh-proxy as its ProxyCommand: the\n" +
			"relay carries the SSH connection inside the Noise session, so it sees neither.",
		async run(ctx) {
			const sandboxId = ctx.arg(0);
			const identityFile = resolve(ctx.io.cwd, ctx.string("identity") ?? join(ctx.io.home, ".ssh", "id_ed25519"));
			const publicKey = (await readFile(`${identityFile}.pub`, "utf8")).trim();
			const letIn = await e2eCall<{ exitCode: number; stderr: string }>(ctx, sandboxId, "sandbox.exec", {
				command:
					'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF "$K" ~/.ssh/authorized_keys || printf "%s\\n" "$K" >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys',
				env: { K: publicKey },
				user: "user",
			});
			if (letIn.exitCode !== 0) throw new CliError(`The sandbox didn't let the key in: ${letIn.stderr}`);
			const self = ctx.io.self ?? thisCli() ?? ["kantel"];
			const proxy = [...self, "e2e", "ssh-proxy", sandboxId].map(shellQuote).join(" ").replaceAll("%", "%%");
			const remote = ctx.rest ?? [];
			// The proxy is another kantel, which hasn't this one's flags: it gets the gateway and credential this one
			// resolved through its environment, not on ssh's command line.
			const env = proxyEnv(await ctx.config());
			return runSsh(
				[
					"-i",
					identityFile,
					"-o",
					"IdentitiesOnly=yes",
					"-o",
					`ProxyCommand=${proxy}`,
					"-o",
					`UserKnownHostsFile=${join(ctx.io.configDir, "ssh", "known_hosts")}`,
					"-o",
					`HostKeyAlias=${sandboxId}`,
					`user@${sandboxId}`,
					...(remote.length === 0 ? [] : ["--", commandLine(remote)]),
				],
				ctx.io,
				env,
			);
		},
	},
	{
		name: "e2e ssh-proxy",
		summary: "A sandbox's port over an E2E session, on stdin and stdout (ssh's ProxyCommand)",
		hidden: true,
		args: ID_ARG,
		flags: { port: { type: "string", value: "<port>", description: "Default 22" } },
		async run(ctx) {
			const port = whole(ctx.string("port"), "--port") ?? 22;
			let session: e2e.OpenedE2E;
			try {
				session = await e2e.openE2ESession(
					await ctx.client(),
					ctx.io.configDir,
					ctx.arg(0),
					"port",
					port,
					ctx.io.connect,
				);
			} catch (error) {
				ctx.io.stderr.write(`kantel e2e ssh-proxy: ${error instanceof Error ? error.message : String(error)}\n`);
				return 255;
			}
			return pipeSession(session, ctx.io);
		},
	},
];

/** A port session's bytes on stdin and stdout, until either side ends. */
function pipeSession(session: e2e.OpenedE2E, io: Io): Promise<number> {
	return new Promise((done) => {
		if (session.leftover.byteLength > 0) io.stdout.write(session.leftover);
		session.stream.onData((bytes) => io.stdout.write(bytes));
		session.stream.onClose(() => done(0));
		void (async () => {
			try {
				for await (const chunk of io.stdin()) {
					await session.stream.write(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
				}
			} catch {
				// stdin closed under us.
			}
			session.stream.close("ssh closed its side");
		})();
	});
}

const SECTIONS: readonly Section[] = [
	{
		title: "Signing in",
		commands: [
			{
				name: "login",
				summary: "Sign in in the browser, or with an API key, and save it for the commands after",
				flags: {
					"key-stdin": {
						type: "boolean",
						description: "Read an API key from stdin rather than signing in in the browser",
					},
					"no-browser": { type: "boolean", description: "Print the sign-in URL but don't open it" },
					wait: {
						type: "boolean",
						description: "Wait for the browser sign-in even with no terminal (agents, scripts)",
					},
					name: { type: "string", value: "<name>", description: "The new key's name (default kantel on <host>)" },
				},
				details:
					"With no key it prints a code and opens Kantel's console, where you approve it; the CLI gets an API key of\n" +
					"its own (90 days), which you can revoke on the API keys page. With no terminal it prints the URL and code\n" +
					"and exits; run kantel login --wait to wait for the approval. Running it again shows the same code.\n" +
					"\n" +
					"An existing key comes from --key-stdin, which keeps it out of your shell history and process list:\n" +
					'  printf %s "$KANTEL_API_KEY" | kantel login --key-stdin --url https://kantel.example\n' +
					"It is saved, readable by you only, in ~/.config/kantel/config.json (or under XDG_CONFIG_HOME).",
				async run(ctx) {
					const stored = await readStoredConfig(ctx.io.configDir);
					let key = ctx.string("key") ?? ctx.string("api-key");
					if (key === undefined && ctx.boolean("key-stdin")) {
						key = new TextDecoder().decode(await readAll(ctx.io.stdin())).trim();
						if (key === "") throw new UsageError("there was no key on stdin");
					}
					const flagAccount = ctx.string("account");
					if (key === undefined) {
						const url = resolveConfig({ url: ctx.string("url") }, ctx.io.env, stored).url;
						const issued = await browserLogin(ctx, url);
						if (issued === undefined) return 0;
						key = issued.secret;
					}
					const flags = { url: ctx.string("url"), apiKey: key, account: flagAccount };
					const config = resolveConfig(flags, ctx.io.env, stored);
					const caller = await makeClient(ctx.io, config).getCaller();
					const sameServer = stored.url !== undefined && sameUrl(stored.url, config.url);
					const account = flagAccount ?? (sameServer ? stored.account : undefined);
					const path = await writeStoredConfig(ctx.io.configDir, { url: config.url, apiKey: key, account });
					const fromEnv = ctx.io.env.KANTEL_API_KEY;
					if (hasValue(fromEnv) && fromEnv !== key) {
						ctx.note("kantel: KANTEL_API_KEY is set in your environment, and comes before the saved key.");
					}
					ctx.emit(caller, () =>
						[
							`Signed in to ${originOf(config.url)} as ${callerName(caller)}, in ${caller.accountId}.`,
							`Saved to ${path}.`,
						].join("\n"),
					);
				},
			},
			{
				name: "logout",
				summary: "Forget the saved API key",
				async run(ctx) {
					const stored = await readStoredConfig(ctx.io.configDir);
					const path = configFile(ctx.io.configDir);
					if (stored.apiKey !== undefined) {
						await writeStoredConfig(ctx.io.configDir, { url: stored.url, account: stored.account });
					}
					if (hasValue(ctx.io.env.KANTEL_API_KEY)) {
						ctx.note("kantel: KANTEL_API_KEY is still set in your environment.");
					}
					ctx.emit({ signedOut: stored.apiKey !== undefined, path }, () =>
						stored.apiKey === undefined ? "No key was saved." : `Removed the saved key from ${path}.`,
					);
				},
			},
			{
				name: "whoami",
				summary: "Who the key is, and the accounts it may act in",
				async run(ctx) {
					const config = await ctx.config();
					const caller = await (await ctx.client()).getCaller();
					const { apiKey } = caller;
					const accounts = caller.accounts.map(
						(account) => `${account.id} (${account.kind === "personal" ? "personal" : account.name}, ${account.role})`,
					);
					ctx.emit(caller, () =>
						fields([
							["url", originOf(config.url)],
							["user", caller.user === undefined ? undefined : callerName(caller)],
							["key", apiKey === undefined ? undefined : `${apiKey.name} (${apiKey.id}): ${apiKey.scopes.join(", ")}`],
							["account", caller.accountId],
							["accounts", accounts.join(", ")],
							["mode", caller.mode],
							["super-admin", caller.superAdmin ? "yes" : undefined],
						]),
					);
				},
			},
		],
	},
	{
		title: "Sandboxes",
		commands: [
			{
				name: "new",
				summary: "Create a sandbox and wait until it runs",
				flags: {
					type: {
						type: "string",
						value: "<isolate|microvm>",
						description: "isolate (default): starts in milliseconds; microvm: a full Linux with Docker and SSH",
					},
					size: sizeFlag,
					name: { type: "string", value: "<name>", description: "Default: a generated name" },
					from: {
						type: "string",
						value: "<snapshot>",
						description: "Start from a snapshot's ID or a saved one's name",
					},
					image: { type: "string", value: "<image>", description: "A microVM's base image" },
					"auto-stop": {
						type: "string",
						value: "<minutes|never>",
						description: "Stop by itself this long after it starts (default 60)",
					},
					label: { type: "string", multiple: true, value: "<k=v>", description: "A label; repeat for more" },
					env: {
						type: "string",
						short: "e",
						multiple: true,
						value: "<K=V|env>",
						description:
							"K=V: a variable every command sees (not a secret), repeatable; or an environment to start from",
					},
					host: {
						type: "string",
						multiple: true,
						value: "<port[:public]>",
						description: "Give this port an HTTPS URL once it runs; repeat it",
					},
					"no-wait": noWait,
				},
				details:
					"--env takes a variable (K=V) or an environment (its name or env_… ID; kantel env list shows them). An\n" +
					"environment gives the sandbox its variables, secret files, repos and grants: a protected variable arrives\n" +
					"as a kph_… placeholder that the egress proxy swaps for the value only where it is bound.",
				async run(ctx) {
					const hosts = ctx.list("host").map(hostedPort);
					if (hosts.length > 0 && ctx.boolean("no-wait")) throw new UsageError("--host needs the sandbox running");
					// A variable has an =; an environment's name or ID never does.
					const envs = ctx.list("env");
					const environments = envs.filter((item) => !item.includes("="));
					if (environments.length > 1) {
						throw new UsageError("a sandbox starts from one environment: give --env <env> once");
					}
					const [environment] = environments;
					const body = {
						...(environment === undefined ? {} : { environment }),
						name: ctx.string("name"),
						type: choice(ctx.string("type"), SANDBOX_TYPES, "--type"),
						size: choice(ctx.string("size"), SIZES, "--size"),
						image: ctx.string("image"),
						from: ctx.string("from"),
						autoStopMinutes: autoStopOf(ctx.string("auto-stop")),
						labels: pairs(ctx.list("label"), "--label"),
						env: pairs(
							envs.filter((item) => item.includes("=")),
							"--env",
						),
						wait: !ctx.boolean("no-wait"),
					};
					const config = await ctx.config();
					const client = await ctx.client();
					const sandbox = await client.createSandbox({ account: config.account, ...body });
					const ports: ExposedPort[] = [];
					if (sandbox.state === "running") {
						for (const host of hosts) ports.push(await client.exposePort(sandbox.id, host));
					}
					ctx.emit(ports.length === 0 ? sandbox : { ...sandbox, hostedPorts: ports }, () =>
						[
							`Created ${sandbox.id} (${sandbox.name}): ${kindOf(sandbox)}, ${stateOf(sandbox)}.`,
							...ports.map((port) => `  Port ${port.port}:      ${port.url}`),
							`  Run a command:  kantel exec ${sandbox.id} -- echo hello`,
							`  Stop it:        kantel stop ${sandbox.id}`,
						].join("\n"),
					);
					return sandbox.state === "error" ? 1 : 0;
				},
			},
			{
				name: "list",
				summary: "List running sandboxes, or all of them",
				flags: {
					all: { type: "boolean", description: "Include stopped, paused and errored ones" },
					label: { type: "string", multiple: true, value: "<k=v>", description: "Only those with this label" },
					cursor: cursorFlag,
				},
				async run(ctx) {
					const config = await ctx.config();
					const all = ctx.boolean("all");
					const page = await (await ctx.client()).listSandboxes({
						account: config.account,
						all: all ? true : undefined,
						label: pairs(ctx.list("label"), "--label"),
						cursor: ctx.string("cursor"),
					});
					ctx.emit(page, () => {
						if (page.items.length === 0)
							return all ? "No sandboxes." : "No running sandboxes; --all shows stopped ones.";
						return `${sandboxTable(page.items)}${more(page.nextCursor, "kantel list")}`;
					});
				},
			},
			{
				name: "info",
				summary: "Show a sandbox",
				args: ID_ARG,
				async run(ctx) {
					const sandbox = await (await ctx.client()).getSandbox(ctx.arg(0));
					ctx.emit(sandbox, () => describeSandbox(sandbox));
				},
			},
			lifecycle(
				"start",
				"Boot a stopped sandbox fresh from its newest snapshot",
				{ "no-wait": noWait, size: sizeFlag },
				(client, sandboxId, ctx) =>
					client.startSandbox(sandboxId, {
						wait: !ctx.boolean("no-wait"),
						size: choice(ctx.string("size"), SIZES, "--size"),
					}),
			),
			lifecycle(
				"stop",
				"Stop a sandbox, keeping its disk; it then costs nothing to run",
				{
					pause: { type: "boolean", description: "Pause instead, keeping its memory too (microVMs only)" },
					wait: { type: "boolean", description: "Answer once it has stopped" },
				},
				(client, sandboxId, ctx) =>
					client.stopSandbox(sandboxId, {
						keepMemory: ctx.boolean("pause") ? true : undefined,
						wait: ctx.boolean("wait") ? true : undefined,
					}),
			),
			lifecycle(
				"resume",
				"Carry on a paused or stopped sandbox, with the same ID",
				{ "no-wait": noWait, size: sizeFlag },
				(client, sandboxId, ctx) =>
					client.resumeSandbox(sandboxId, {
						wait: !ctx.boolean("no-wait"),
						size: choice(ctx.string("size"), SIZES, "--size"),
					}),
			),
			lifecycle("recover", "Restart the machine of a sandbox that is stuck or in error", {}, (client, sandboxId) =>
				client.recoverSandbox(sandboxId),
			),
			{
				name: "fork",
				summary: "Copy a sandbox into new ones",
				args: ID_ARG,
				flags: {
					count: { type: "string", value: "<n>", description: "How many copies (default 1)" },
					name: { type: "string", value: "<name>", description: "The copies' name" },
					snapshot: { type: "string", value: "<id>", description: "Copy this snapshot of it; default its newest" },
					"no-wait": noWait,
				},
				async run(ctx) {
					const forked = await (await ctx.client()).forkSandbox(ctx.arg(0), {
						count: whole(ctx.string("count"), "--count"),
						name: ctx.string("name"),
						snapshotId: ctx.string("snapshot"),
						wait: !ctx.boolean("no-wait"),
					});
					ctx.emit(forked, () => sandboxTable(forked.items));
				},
			},
			{
				name: "delete",
				summary: "Delete a sandbox for good (needs --yes)",
				args: ID_ARG,
				flags: { yes: { type: "boolean", short: "y", description: "Yes, delete it: this can't be undone" } },
				details: "It erases the sandbox and its automatic snapshots; saved snapshots of it stay.",
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					if (!ctx.boolean("yes")) {
						throw new UsageError(
							`deleting a sandbox is permanent: it erases ${sandboxId} and its automatic snapshots. ` +
								`To delete it, run: kantel delete ${sandboxId} --yes (or kantel stop ${sandboxId} keeps it)`,
						);
					}
					const sandbox = await (await ctx.client()).deleteSandbox(sandboxId);
					ctx.emit(sandbox, () => `${sandbox.id} ${sandbox.state}`);
				},
			},
			{
				name: "extend",
				summary: "Move a sandbox's auto-stop to this many minutes from now",
				args: [{ name: "id" }, { name: "minutes" }],
				async run(ctx) {
					const minutes = whole(ctx.arg(1), "minutes") ?? 0;
					const sandbox = await (await ctx.client()).updateSandbox(ctx.arg(0), { extendMinutes: minutes });
					const { stopsAt } = sandbox;
					ctx.emit(sandbox, () =>
						stopsAt === undefined ? `${sandbox.id} ${sandbox.state}` : `${sandbox.id} stops ${until(stopsAt)}`,
					);
				},
			},
			{
				name: "usage",
				summary: "A sandbox's running time, CPU and cost over the last day",
				args: ID_ARG,
				async run(ctx) {
					const usage = await (await ctx.client()).getSandboxUsage(ctx.arg(0));
					const { totals } = usage;
					ctx.emit(usage, () =>
						fields([
							["running", duration(totals.runningSeconds)],
							["cpu", `${totals.cpuSeconds.toFixed(1)} s`],
							["cost", money(totals.cost.total, totals.cost.currency)],
						]),
					);
				},
			},
		],
	},
	{
		title: "Commands and files",
		commands: [
			{
				name: "exec",
				summary: "Run a command in a sandbox, with its output and exit code",
				args: [{ name: "id" }, { name: "command", optional: true, variadic: true }],
				rest: "command…",
				flags: {
					cwd: { type: "string", value: "<dir>", description: "Run it here (default the sandbox user's home)" },
					env: { type: "string", multiple: true, value: "<K=V>", description: "An environment variable; repeat it" },
					timeout: {
						type: "string",
						value: "<seconds>",
						description: "Kill it after this long (default 30, at most 600); 0: no limit, following its output",
					},
					detach: { type: "boolean", short: "d", description: "Start it and print its ID at once, with no time limit" },
					attach: { type: "string", value: "<command>", description: "Follow a detached command's output to its end" },
					status: { type: "string", value: "<command>", description: "Show a command: its state and output so far" },
					kill: { type: "string", value: "<command>", description: "Stop a detached command" },
					stdin: { type: "boolean", description: "Send this terminal's stdin to the command" },
				},
				details:
					"One word is a shell command line: kantel exec <id> 'make && make test'. Several are a command and its\n" +
					"arguments, quoted for the shell; put them after -- when they have flags of their own:\n" +
					"kantel exec <id> -- ls -la. Its stdout and stderr come out on ours, and kantel exits with its exit\n" +
					"code (124 when it timed out). A server or a long job: --detach, then kantel attach <id> <command>.",
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					const client = await ctx.client();
					const attach = ctx.string("attach");
					if (attach !== undefined) return follow(ctx, client, sandboxId, attach);
					const status = ctx.string("status");
					if (status !== undefined) return showCommand(ctx, await client.getCommand(sandboxId, status));
					const kill = ctx.string("kill");
					if (kill !== undefined) return killed(ctx, await client.killCommand(sandboxId, kill));
					const words = ctx.rest ?? ctx.positionals.slice(1);
					if (words.length === 0) throw new UsageError("give the command: kantel exec <id> -- <command…>");
					const seconds = whole(ctx.string("timeout"), "--timeout", 0);
					const unlimited = seconds === 0;
					const detached = ctx.boolean("detach") || unlimited;
					const timeoutMs = seconds === undefined || unlimited ? undefined : seconds * 1000;
					const body = {
						command: commandLine(words),
						cwd: ctx.string("cwd"),
						env: pairs(ctx.list("env"), "--env"),
						timeoutMs: detached ? undefined : timeoutMs,
						detached: detached ? true : undefined,
						stdin: ctx.boolean("stdin") ? new TextDecoder().decode(await readAll(ctx.io.stdin())) : undefined,
					};
					const result = await client.runCommand(sandboxId, body);
					if (unlimited && result.state === "running") return follow(ctx, client, sandboxId, result.id, result);
					if (ctx.json) {
						ctx.out(JSON.stringify(result, null, 2));
						return exitCodeOf(result);
					}
					if (result.state === "running") {
						ctx.out(result.id);
						ctx.note(
							`kantel: started ${result.id}. Follow it: kantel attach ${sandboxId} ${result.id}; ` +
								`stop it: kantel kill ${sandboxId} ${result.id}`,
						);
						return 0;
					}
					printOutput(ctx, result);
					if (result.state === "timed_out") {
						const after = seconds === undefined ? "" : ` after ${seconds} s`;
						ctx.note(`kantel: the command timed out${after} and was killed`);
					}
					return exitCodeOf(result);
				},
			},
			{
				name: "attach",
				summary: "Follow a detached command's output until it ends, and exit with its code",
				args: [{ name: "id" }, { name: "command" }],
				details: "Ctrl-C stops following; the command carries on. Its output from the start is printed first.",
				async run(ctx) {
					return follow(ctx, await ctx.client(), ctx.arg(0), ctx.arg(1));
				},
			},
			{
				name: "ps",
				summary: "A sandbox's commands, newest first, running ones included",
				args: ID_ARG,
				flags: { cursor: cursorFlag },
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					const page = await (await ctx.client()).listCommands(sandboxId, { cursor: ctx.string("cursor") });
					const rows = page.items.map((command) => [
						command.id,
						command.exitCode === undefined ? command.state : `${command.state} ${command.exitCode}`,
						ago(command.startedAt),
						command.durationMs === undefined ? "" : duration(command.durationMs / 1000),
						command.command.length > 60 ? `${command.command.slice(0, 59)}…` : command.command,
					]);
					ctx.emit(page, () =>
						rows.length === 0
							? "No commands yet."
							: `${table(["ID", "STATE", "STARTED", "TOOK", "COMMAND"], rows)}${more(page.nextCursor, `kantel ps ${sandboxId}`)}`,
					);
				},
			},
			{
				name: "kill",
				summary: "Stop a running command, and everything it started",
				args: [{ name: "id" }, { name: "command" }],
				async run(ctx) {
					return killed(ctx, await (await ctx.client()).killCommand(ctx.arg(0), ctx.arg(1)));
				},
			},
			{
				name: "files ls",
				summary: "List a directory in a sandbox",
				args: [{ name: "id" }, { name: "path", optional: true }],
				flags: { cursor: cursorFlag },
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					const list = await (await ctx.client()).listFiles(sandboxId, {
						path: ctx.optional(1),
						cursor: ctx.string("cursor"),
					});
					ctx.emit(list, () => fileTable(list) + more(list.nextCursor, `kantel files ls ${sandboxId} ${list.path}`));
				},
			},
			{
				name: "files cat",
				summary: "Print a file from a sandbox",
				args: [{ name: "id" }, { name: "path" }],
				async run(ctx) {
					const client = await ctx.client();
					if (ctx.json) {
						ctx.out(JSON.stringify(await client.readFile(ctx.arg(0), { path: ctx.arg(1) }), null, 2));
						return;
					}
					ctx.io.stdout.write(await getBytes(client, ctx.arg(0), ctx.arg(1)));
				},
			},
			{
				name: "files put",
				summary: "Copy a local file (up to 1 MiB) into a sandbox",
				args: [{ name: "id" }, { name: "local" }, { name: "remote" }],
				details: "A local path of - reads stdin. A binary file is sent as base64; an executable keeps its mode.",
				async run(ctx) {
					const local = ctx.arg(1);
					const path = resolve(ctx.io.cwd, local);
					const content = local === "-" ? await readAll(ctx.io.stdin()) : await readFile(path);
					if (content.length > MAX_FILE) {
						throw new CliError(`${local} is ${bytes(content.length)}: copy files over 1 MiB with exec or ssh`);
					}
					let mode: string | undefined;
					if (local !== "-") {
						const permissions = (await stat(path)).mode & 0o777;
						if ((permissions & 0o111) !== 0) mode = permissions.toString(8).padStart(4, "0");
					}
					const text = utf8(content);
					const entry = await (await ctx.client()).writeFile(ctx.arg(0), {
						path: ctx.arg(2),
						content: text ?? Buffer.from(content).toString("base64"),
						encoding: text === undefined ? "base64" : "utf8",
						mode,
					});
					ctx.emit(entry, () => `Wrote ${entry.path} (${bytes(entry.size)}).`);
				},
			},
			{
				name: "files get",
				summary: "Copy a file out of a sandbox",
				args: [{ name: "id" }, { name: "remote" }, { name: "local", optional: true }],
				details: "The local path defaults to the file's name here; - writes it to stdout.",
				async run(ctx) {
					const remote = ctx.arg(1);
					const local = ctx.optional(2);
					const file = await getFile(await ctx.client(), ctx.arg(0), remote);
					const content = file.content;
					if (local === "-") {
						ctx.io.stdout.write(content);
						return;
					}
					const name = basename(file.path || remote);
					if (local === undefined && name === "") throw new UsageError("give a local path to write it to");
					let target = resolve(ctx.io.cwd, local ?? name);
					if (await isDirectory(target)) target = join(target, name);
					await writeFile(target, content);
					const written = { path: target, remote: file.path, size: content.length };
					ctx.emit(written, () => `Wrote ${target} (${bytes(content.length)}).`);
				},
			},
			{
				name: "files rm",
				summary: "Delete a file, or a directory and everything in it",
				args: [{ name: "id" }, { name: "path" }],
				async run(ctx) {
					await (await ctx.client()).deleteFile(ctx.arg(0), { path: ctx.arg(1) });
					ctx.emit({ deleted: ctx.arg(1) }, () => `Deleted ${ctx.arg(1)}.`);
				},
			},
			{
				name: "scp",
				summary: "Copy files to or from a sandbox: <id>:<path> names a path in it",
				args: [{ name: "from" }, { name: "to" }],
				flags: {
					recursive: { type: "boolean", short: "r", description: "Copy a directory and everything in it" },
				},
				details:
					"  kantel scp ./report.txt sbx_123:/home/user/      upload a file into a directory\n" +
					"  kantel scp sbx_123:out.zip .                      download one (relative paths are under /home/user)\n" +
					"  kantel scp -r ./site sbx_123:/srv/site            upload a directory\n" +
					"It goes through Kantel's files API, so it works on isolates too. A file over 1 MiB comes down in parts;\n" +
					"one going up goes in parts that a command joins, which needs a microVM.",
				async run(ctx) {
					const from = ctx.arg(0);
					const to = ctx.arg(1);
					const source = parseRemote(from);
					const target = parseRemote(to);
					if ((source === undefined) === (target === undefined)) {
						throw new UsageError("name the sandbox on one side, and only one: kantel scp ./file sbx_123:/home/user/");
					}
					const client = await ctx.client();
					const recursive = ctx.boolean("recursive");
					const log = (path: string): void => {
						if (!ctx.json) ctx.note(path);
					};
					if (target !== undefined) {
						// Uploading.
						const local = resolve(ctx.io.cwd, from);
						const name = basename(local);
						const into = remotePath(target.path);
						const intoDirectory =
							into === "" || into.endsWith("/") || (await remoteIsDirectory(client, target.sandboxId, into));
						const remote = intoDirectory ? remoteJoin(into, name) : into;
						if (await isDirectory(local)) {
							if (!recursive) throw new UsageError(`${from} is a directory: add -r to copy it`);
							const copied = await uploadTree(client, target.sandboxId, local, await walk(local), remote, log);
							ctx.emit(
								{ ...copied, to: remote },
								() => `Copied ${fileCount(copied.files)} (${bytes(copied.bytes)}) to ${remote}.`,
							);
							return;
						}
						const size = await uploadFile(client, target.sandboxId, local, remote);
						ctx.emit({ files: 1, bytes: size, to: remote }, () => `Copied ${from} (${bytes(size)}) to ${remote}.`);
						return;
					}
					// Downloading.
					const remote = remotePath((source as { path: string }).path);
					const sandboxId = (source as { sandboxId: string }).sandboxId;
					const local = resolve(ctx.io.cwd, to);
					const name = posix.basename(remote.replace(/\/+$/, "")) || "home";
					const here = (await isDirectory(local)) ? join(local, name) : local;
					if (await remoteIsDirectory(client, sandboxId, remote)) {
						if (!recursive) throw new UsageError(`${from} is a directory: add -r to copy it`);
						const copied = await downloadTree(client, sandboxId, remote, here, log);
						ctx.emit(
							{ ...copied, to: here },
							() => `Copied ${fileCount(copied.files)} (${bytes(copied.bytes)}) to ${here}.`,
						);
						return;
					}
					const content = await getBytes(client, sandboxId, remote);
					await mkdir(dirname(here), { recursive: true });
					await writeFile(here, content);
					ctx.emit(
						{ files: 1, bytes: content.length, to: here },
						() => `Copied ${from} (${bytes(content.length)}) to ${here}.`,
					);
				},
			},
			{
				name: "push",
				summary: "Copy a local directory into a sandbox (in git, the files git would commit)",
				args: [{ name: "id" }, { name: "dir", optional: true }],
				flags: {
					to: { type: "string", value: "<path>", description: "Where in the sandbox (default /home/user/<dir name>)" },
					"allow-home": {
						type: "boolean",
						description: "Push your home directory, or one holding it, leaving Kantel's config out",
					},
					"no-default-excludes": {
						type: "boolean",
						description: "Send credentials, agents' sign-ins and .env files too",
					},
				},
				details:
					"In a git repository it sends the files git tracks and the new ones .gitignore doesn't leave out, so\n" +
					"node_modules, build output and .git stay here. Elsewhere it sends everything but .git. Files already\n" +
					"there are replaced; files you deleted here stay there. Executable bits are kept.\n" +
					"It leaves out, at any depth, .ssh, .gnupg, .aws, .azure, .kube, .netrc, .pypirc and .docker/config.json,\n" +
					"and, unless git tracks them, .claude, .codex, .cursor, .npmrc and .env files (not .env.example),\n" +
					"naming each on stderr; --no-default-excludes sends them. Links to outside the directory stay here.\n" +
					"It refuses your home directory, or a directory holding it or Kantel's config, without --allow-home,\n" +
					"and a directory inside one it leaves out, such as ~/.ssh, without --no-default-excludes.",
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					const root = resolve(ctx.io.cwd, ctx.optional(1) ?? ".");
					if (!(await isDirectory(root))) throw new UsageError(`${root} isn't a directory: use kantel scp for a file`);
					const git = await gitFiles(root);
					const defaultExcludes = !ctx.boolean("no-default-excludes");
					const config = await checkPushRoot(root, {
						home: ctx.io.home,
						configDir: ctx.io.configDir,
						allowHome: ctx.boolean("allow-home"),
						defaultExcludes,
						inRepository: git !== undefined,
					});
					const plan = await pushPlan(root, git?.files ?? (await walk(root)), {
						tracked: git?.tracked,
						defaultExcludes,
						keep: config === undefined ? [] : [config],
						contexts: await rootContexts(root, git?.top),
					});
					for (const skipped of plan.skipped) ctx.note(`kantel: left out ${skipped.path} (${skipped.why})`);
					if (plan.skipped.some((skipped) => skipped.byDefault === true) && !ctx.json) {
						ctx.note("kantel: --no-default-excludes sends credentials, sign-ins and .env files too");
					}
					const target = remotePath(ctx.string("to") ?? basename(root));
					const copied = await uploadTree(await ctx.client(), sandboxId, root, plan.files, target, (path) => {
						if (!ctx.json) ctx.note(path);
					});
					const where = target.startsWith("/") ? target : `/home/user/${target}`;
					ctx.emit(
						{ ...copied, to: where, skipped: plan.skipped },
						() => `Pushed ${fileCount(copied.files)} (${bytes(copied.bytes)}) to ${where}.`,
					);
				},
			},
		],
	},
	{
		title: "Ports, SSH, desktop and browser",
		commands: [
			{
				name: "host",
				summary: "Give a port in a sandbox an HTTPS URL, and print it",
				args: [{ name: "id" }, { name: "port" }],
				flags: { public: { type: "boolean", description: "Anyone with the URL may open it, with no token" } },
				details:
					"The URL carries a token unless --public: anyone holding the whole URL can open it. Asking again for the\n" +
					"same port gives the same URL. Start the server first, with kantel exec <id> --detach -- <command>.\n" +
					"kantel port list shows a sandbox's ports, and kantel port hide <id> <port> stops one working.",
				async run(ctx) {
					const port = whole(ctx.arg(1), "port") ?? 0;
					const exposed = await (await ctx.client()).exposePort(ctx.arg(0), {
						port,
						public: ctx.boolean("public") ? true : undefined,
					});
					ctx.emit(exposed, () => exposed.url);
				},
			},
			{
				name: "port expose",
				hidden: true,
				summary: "Give a port in a sandbox an HTTPS URL",
				args: [{ name: "id" }, { name: "port" }],
				flags: { public: { type: "boolean", description: "Anyone with the URL may open it, with no token" } },
				async run(ctx) {
					const port = whole(ctx.arg(1), "port") ?? 0;
					const exposed = await (await ctx.client()).exposePort(ctx.arg(0), {
						port,
						public: ctx.boolean("public") ? true : undefined,
					});
					ctx.emit(exposed, () => exposed.url);
				},
			},
			{
				name: "port list",
				summary: "A sandbox's exposed ports",
				args: ID_ARG,
				async run(ctx) {
					const ports = await (await ctx.client()).listPorts(ctx.arg(0));
					const rows = ports.items.map((item) => [String(item.port), item.url, item.public ? "yes" : "no"]);
					ctx.emit(ports, () => (rows.length === 0 ? "No exposed ports." : table(["PORT", "URL", "PUBLIC"], rows)));
				},
			},
			{
				name: "port hide",
				summary: "Stop a port's URL working",
				args: [{ name: "id" }, { name: "port" }],
				async run(ctx) {
					const port = whole(ctx.arg(1), "port") ?? 0;
					await (await ctx.client()).hidePort(ctx.arg(0), String(port));
					ctx.emit({ hidden: port }, () => `Port ${port} is hidden.`);
				},
			},
			{
				name: "ssh",
				summary: "SSH into a microVM, or run one command there over SSH",
				args: ID_ARG,
				rest: "command…",
				restOptional: true,
				flags: {
					print: { type: "boolean", description: "Print the ssh command that connects, rather than running it" },
					// Connecting was --exec when printing was the default; it still parses.
					exec: { type: "boolean", description: "Run ssh now (the default)", hidden: true },
					"public-key": {
						type: "string",
						value: "<file>",
						description: "Let in this OpenSSH public key (default: a key pair Kantel makes, kept here)",
					},
					ttl: {
						type: "string",
						value: "<minutes>",
						description: "How long a connection can be started (default 10, at most 60)",
					},
				},
				details:
					"Connects in this terminal, through the control plane's relay when the sandbox is on its own hosts. After --,\n" +
					"a command runs there instead of a shell, and kantel exits with its exit code: kantel ssh <id> -- uname -a.\n" +
					"--print (or --json) prints the ssh command with its key and options, for scp, rsync or an ssh config entry.",
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					const remote = ctx.rest ?? [];
					const print = ctx.boolean("print") || ctx.json;
					if (print && remote.length > 0) throw new UsageError("--print prints the ssh command; give it no command");
					// ssh joins its command's words with spaces for the remote shell, so each is quoted to arrive as it is.
					const remoteArgs = remote.length === 0 ? [] : ["--", commandLine(remote)];
					const keyPath = ctx.string("public-key");
					const publicKey =
						keyPath === undefined ? undefined : (await readFile(resolve(ctx.io.cwd, keyPath), "utf8")).trim();
					const access = await (await ctx.client()).openSsh(sandboxId, {
						publicKey,
						ttlMinutes: whole(ctx.string("ttl"), "--ttl"),
					});
					// A key pair Kantel made is shown once: keep its private half where ssh can use it.
					let identityFile: string | undefined;
					if (access.privateKey !== undefined) {
						const directory = join(ctx.io.configDir, "ssh");
						await mkdir(directory, { recursive: true, mode: 0o700 });
						identityFile = join(directory, sandboxId.replace(/[^\w.-]/g, "_"));
						const privateKey = access.privateKey.endsWith("\n") ? access.privateKey : `${access.privateKey}\n`;
						await writeFile(identityFile, privateKey, { mode: 0o600 });
						await chmod(identityFile, 0o600);
					}
					if (access.proxyUrl !== undefined) {
						// No SSH gateway: through the relay, with this CLI as ssh's ProxyCommand (ssh-proxy.ts).
						const tunnel = { user: access.user, proxyUrl: access.proxyUrl };
						const options = {
							self: [process.execPath, ...process.execArgv, process.argv[1] ?? "kantel"],
							sandboxId,
							knownHosts: join(ctx.io.configDir, "ssh", "known_hosts"),
							...(identityFile === undefined ? {} : { identityFile }),
						};
						await mkdir(join(ctx.io.configDir, "ssh"), { recursive: true, mode: 0o700 });
						if (!print) {
							return runSsh([...tunnelSshArgs(tunnel, options), ...remoteArgs], ctx.io, {
								[SSH_URL_ENV]: access.proxyUrl,
							});
						}
						const command = tunnelSshCommand(tunnel, { ...options, self: ["kantel"] });
						const shown = { user: access.user, command, identityFile, hostKeyFingerprint: access.hostKeyFingerprint };
						ctx.emit({ ...shown, expiresAt: access.expiresAt }, () =>
							[command, `(start it by ${timestamp(access.expiresAt)}; once connected it stays open)`].join("\n"),
						);
						return 0;
					}
					const args = [
						...(identityFile === undefined ? [] : ["-i", identityFile, "-o", "IdentitiesOnly=yes"]),
						"-p",
						String(access.port),
						`${access.user}@${access.host}`,
					];
					const command = identityFile === undefined ? access.command : ["ssh", ...args].map(shellQuote).join(" ");
					if (!print) return runSsh([...args, ...remoteArgs], ctx.io);
					// The private key stays in its file, out of the output.
					const shown = {
						host: access.host,
						port: access.port,
						user: access.user,
						command,
						identityFile,
						hostKeyFingerprint: access.hostKeyFingerprint,
						expiresAt: access.expiresAt,
					};
					ctx.emit(shown, () => `${command}\n(it works until ${timestamp(access.expiresAt)})`);
				},
			},
			{
				name: "ssh-proxy",
				summary: "ssh's ProxyCommand through Kantel's relay (kantel ssh runs it)",
				// Plumbing for the ssh command kantel ssh prints: `kantel help ssh-proxy` still shows it.
				hidden: true,
				flags: {
					url: { type: "string", value: "<wss-url>", description: `The answer's proxyUrl (default ${SSH_URL_ENV})` },
				},
				async run(ctx) {
					let url: string;
					try {
						url = proxyUrlOf(ctx.string("url"), ctx.io.env);
					} catch (error) {
						throw new UsageError(error instanceof Error ? error.message : String(error));
					}
					return pipeTunnel(url, {
						stdin: ctx.io.stdin(),
						stdout: ctx.io.stdout,
						stderr: ctx.io.stderr,
					});
				},
			},
			{
				name: "desktop",
				summary: "Open a microVM's desktop in your browser, and print its URL",
				args: ID_ARG,
				flags: { "view-only": viewOnly, ttl, print: printOnly },
				details: "The URL carries a short-lived token: treat it as a secret.",
				async run(ctx) {
					const access = await (await ctx.client()).openDesktop(ctx.arg(0), {
						viewOnly: ctx.boolean("view-only") ? true : undefined,
						ttlMinutes: whole(ctx.string("ttl"), "--ttl"),
					});
					openIfPerson(ctx, access.url);
					ctx.emit(access, () => access.url);
				},
			},
			{
				name: "browser",
				summary: "Start a microVM's Chromium: open its live view, and print that URL and its CDP URL",
				args: ID_ARG,
				flags: { "view-only": viewOnly, ttl, print: printOnly },
				details: "Drive it with Playwright: chromium.connectOverCDP(<cdp URL>). Both URLs carry short-lived tokens.",
				async run(ctx) {
					const access = await (await ctx.client()).openBrowser(ctx.arg(0), {
						viewOnly: ctx.boolean("view-only") ? true : undefined,
						ttlMinutes: whole(ctx.string("ttl"), "--ttl"),
					});
					openIfPerson(ctx, access.url);
					ctx.emit(access, () =>
						fields([
							["view", access.url],
							["cdp", access.cdpUrl],
						]),
					);
				},
			},
		],
	},
	{
		title: "Snapshots",
		commands: [
			{
				name: "snapshot list",
				summary: "Saved snapshots, or one sandbox's history",
				flags: {
					sandbox: { type: "string", value: "<id>", description: "Only this sandbox's snapshots" },
					saved: { type: "boolean", description: "Only saved snapshots" },
					cursor: cursorFlag,
				},
				async run(ctx) {
					const config = await ctx.config();
					const page = await (await ctx.client()).listSnapshots({
						account: config.account,
						sandboxId: ctx.string("sandbox"),
						kind: ctx.boolean("saved") ? "saved" : undefined,
						cursor: ctx.string("cursor"),
					});
					const rows = page.items.map((snapshot) => [
						snapshot.id,
						snapshot.name ?? "",
						snapshot.memory ? `${snapshot.kind}, memory` : snapshot.kind,
						snapshot.state,
						snapshot.sandboxId ?? "",
						snapshot.sizeBytes === undefined ? "" : bytes(snapshot.sizeBytes),
						ago(snapshot.createdAt),
					]);
					const header = ["ID", "NAME", "KIND", "STATE", "SANDBOX", "SIZE", "CREATED"];
					ctx.emit(page, () =>
						rows.length === 0 ? "No snapshots." : table(header, rows) + more(page.nextCursor, "kantel snapshot list"),
					);
				},
			},
			{
				name: "snapshot take",
				summary: "Add a snapshot of a sandbox's disk to its history now",
				args: ID_ARG,
				flags: { description: { type: "string", value: "<text>", description: "What it holds" } },
				async run(ctx) {
					const snapshot = await (await ctx.client()).takeSnapshot(ctx.arg(0), {
						description: ctx.string("description"),
					});
					ctx.emit(snapshot, () => `${snapshot.id} ${snapshot.state}`);
				},
			},
			{
				name: "snapshot save",
				summary: "Keep a sandbox's state under a name, to start new sandboxes from",
				args: [{ name: "sandboxId" }, { name: "name" }],
				flags: {
					replace: { type: "boolean", description: "Replace a saved snapshot of the same name" },
					description: { type: "string", value: "<text>", description: "What it holds" },
					snapshot: { type: "string", value: "<id>", description: "Save this snapshot of its history; default now" },
				},
				async run(ctx) {
					const snapshot = await (await ctx.client()).saveSnapshot({
						sandboxId: ctx.arg(0),
						name: ctx.arg(1),
						snapshotId: ctx.string("snapshot"),
						description: ctx.string("description"),
						replace: ctx.boolean("replace") ? true : undefined,
					});
					const name = snapshot.name ?? snapshot.id;
					ctx.emit(snapshot, () =>
						[`Saved ${name} (${snapshot.id}).`, `  Start from it:  kantel sandbox create --from ${name}`].join("\n"),
					);
				},
			},
			{
				name: "snapshot files",
				summary: "List a directory in a snapshot",
				args: [{ name: "snapshotId" }, { name: "path", optional: true }],
				flags: { cursor: cursorFlag },
				async run(ctx) {
					const snapshotId = ctx.arg(0);
					const list = await (await ctx.client()).listSnapshotFiles(snapshotId, {
						path: ctx.optional(1),
						cursor: ctx.string("cursor"),
					});
					const next = more(list.nextCursor, `kantel snapshot files ${snapshotId} ${list.path}`);
					ctx.emit(list, () => fileTable(list) + next);
				},
			},
			{
				name: "snapshot rm",
				summary: "Delete a snapshot",
				args: [{ name: "snapshotId" }],
				async run(ctx) {
					await (await ctx.client()).deleteSnapshot(ctx.arg(0));
					ctx.emit({ deleted: ctx.arg(0) }, () => `Deleted ${ctx.arg(0)}.`);
				},
			},
		],
	},
	{
		title: "Environments and egress",
		commands: [
			{
				name: "env list",
				summary: "The account's environments",
				async run(ctx) {
					const config = await ctx.config();
					const list = await (await ctx.client()).listEnvironments(
						config.account === undefined ? {} : { account: config.account },
					);
					ctx.emit(withoutProtectedValues(list), () =>
						list.items.length === 0
							? "No environments. Make one: kantel env create <name>"
							: environmentTable(list.items),
					);
				},
			},
			{
				name: "env create",
				summary: "Make an environment: variables, secret files, repos and grants for new sandboxes",
				args: [{ name: "name" }],
				flags: { description: { type: "string", value: "<text>", description: "What it is for" } },
				details: "A name is lower-case letters, digits and hyphens, unique in the account.",
				async run(ctx) {
					const config = await ctx.config();
					const description = ctx.string("description");
					const environment = await (await ctx.client()).createEnvironment({
						...(config.account === undefined ? {} : { account: config.account }),
						name: ctx.arg(0),
						...(description === undefined ? {} : { description }),
					});
					ctx.emit(withoutProtectedValues(environment), () =>
						[
							`Created ${environment.id} (${environment.name}).`,
							`  Add a variable:  kantel env set ${environment.name} NAME=value`,
							`  Use it:          kantel new --env ${environment.name}`,
						].join("\n"),
					);
				},
			},
			{
				name: "env show",
				summary: "Show an environment: its variables (never a protected one's value), files, repos and grants",
				args: [{ name: "env" }],
				async run(ctx) {
					const environment = await loadEnvironment(ctx, await ctx.client(), ctx.arg(0));
					ctx.emit(withoutProtectedValues(environment), () => describeEnvironment(environment));
				},
			},
			{
				name: "env delete",
				summary: "Delete an environment, with its sealed values and files",
				args: [{ name: "env" }],
				async run(ctx) {
					const client = await ctx.client();
					const environmentId = await environmentIdOf(ctx, client, ctx.arg(0));
					await client.deleteEnvironment(environmentId);
					ctx.emit({ deleted: environmentId }, () => `Deleted ${environmentId}.`);
				},
			},
			{
				name: "env set",
				usage: "env set <env> <NAME>[=<value>]",
				summary: "Set a variable: plain, or protected so sandboxes get a placeholder and never the value",
				args: [
					{ name: "env", optional: true },
					{ name: "NAME=value", optional: true },
				],
				flags: {
					env: { type: "string", value: "<env>", description: "The environment, instead of the first argument" },
					protected: {
						type: "boolean",
						description: "Keep the value out of sandboxes: each gets a kph_… placeholder instead",
					},
					bind: {
						type: "string",
						multiple: true,
						value: "<host>[/path][:METHOD,…]",
						description: "Where a protected value may be sent; repeat it",
					},
					"value-stdin": {
						type: "boolean",
						description: "Read the value from stdin, which keeps it out of your shell history",
					},
					"keep-value": {
						type: "boolean",
						description: "Change a protected variable's --bind without entering its value again",
					},
					plain: { type: "boolean", description: "Make a protected variable plain: sandboxes then get its value" },
				},
				details:
					"A protected variable's value never enters a sandbox. Each sandbox gets a kph_… placeholder in its place,\n" +
					"which the host's egress proxy swaps for the value only in requests to a --bind destination:\n" +
					"<host>[/path-prefix][:METHOD,…], such as api.github.com or api.openai.com/v1/:POST,GET.\n" +
					"\n" +
					"--value-stdin reads the value from stdin, which keeps it out of your shell history and the process list:\n" +
					'  printf %s "$GH_TOKEN" | kantel env set work GH_TOKEN --value-stdin --protected --bind api.github.com\n' +
					"\n" +
					"Setting a protected variable again with a new value rotates it: running sandboxes keep their placeholder\n" +
					"and send the new value from their next request. It stays protected unless you give --plain.\n" +
					"--keep-value with --bind changes where it may go without entering it again.",
				async run(ctx) {
					const flagEnv = ctx.string("env");
					const expected = flagEnv === undefined ? 2 : 1;
					if (ctx.positionals.length !== expected) {
						throw new UsageError(
							flagEnv === undefined
								? "give the environment and the variable: kantel env set <env> NAME=value"
								: "give the variable once: kantel env set --env <env> NAME=value",
						);
					}
					const ref = flagEnv ?? ctx.arg(0);
					const assignment = ctx.arg(expected - 1);
					const eq = assignment.indexOf("=");
					const name = eq === -1 ? assignment : assignment.slice(0, eq);
					const inline = eq === -1 ? undefined : assignment.slice(eq + 1);
					// Never put the assignment in a message: it may hold the value.
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
						throw new UsageError("a variable's name is letters, digits and _, such as GH_TOKEN, before any =");
					}
					const fromStdin = ctx.boolean("value-stdin");
					const keep = ctx.boolean("keep-value");
					const plain = ctx.boolean("plain");
					const asked = ctx.boolean("protected");
					const ways = [inline !== undefined, fromStdin, keep].filter((given) => given).length;
					if (ways === 0) {
						throw new UsageError(
							`give ${name} a value: ${name}=<value>, --value-stdin, or --keep-value to re-bind a protected one`,
						);
					}
					if (ways > 1) throw new UsageError("give the value one way: NAME=value, --value-stdin or --keep-value");
					if (plain && (asked || keep)) {
						throw new UsageError("--plain makes the variable plain: leave out --protected and --keep-value");
					}
					const bindings = mergeBindings(ctx.list("bind").map(parseBinding));
					if (plain && bindings.length > 0)
						throw new UsageError("--bind is for a protected variable, not a --plain one");
					if (keep && bindings.length === 0) {
						throw new UsageError("--keep-value changes where the value may go: give the new --bind");
					}
					const value = fromStdin ? await valueFromStdin(ctx) : inline;
					const client = await ctx.client();
					const environment = await loadEnvironment(ctx, client, ref);
					const existing = environment.variables.find((variable) => variable.name === name);
					const wasProtected = existing?.protected === true;
					if (keep && !wasProtected) {
						throw new CliError(`${name} isn't protected in ${environment.name}, so there is no value to keep`);
					}
					// Its bindings are sent only when --bind gives them, so a rotation never undoes a change to them made since
					// the read above. Its mode is sent when a flag gives it, and for a rotation of one read as protected: that
					// value is meant to be sealed, so if the variable was removed or made plain meanwhile, Kantel refuses the
					// write (a protected variable needs a binding) rather than keeping the new value in the clear. Read as plain
					// or new, a value alone leaves the mode as Kantel has it: one protected meanwhile stays so.
					const mode = plain ? false : asked || keep || bindings.length > 0 || wasProtected ? true : undefined;
					if (mode === true && bindings.length === 0 && !wasProtected) {
						throw new UsageError("a protected variable needs --bind <host>: where its value may be sent");
					}
					const answer: unknown = await client.setEnvironmentVariable(environment.id, name, {
						...(mode === undefined ? {} : { protected: mode }),
						...(value === undefined ? {} : { value }),
						...(bindings.length === 0 ? {} : { bindings }),
					});
					// What it is now, as Kantel answers; failing that, what was sent on what was read.
					const written = variableIn(answer, name);
					const isProtected = written?.protected ?? mode ?? wasProtected;
					const sent =
						written?.bindings ?? (bindings.length > 0 ? bindings : wasProtected ? (existing?.bindings ?? []) : []);
					const shown = answer ?? { environmentId: environment.id, name, protected: isProtected };
					const live = wasProtected && isProtected;
					const verb = live && value !== undefined ? "Rotated" : "Set";
					const where = isProtected ? `: protected, sent only to ${bindingsText(sent)}` : "";
					ctx.emit(withoutProtectedValues(shown), () =>
						[
							`${verb} ${name} in ${environment.name}${where}.`,
							live
								? "Running sandboxes use it from their next request, with the same placeholder."
								: "Sandboxes made from now on get it.",
						].join("\n"),
					);
				},
			},
			{
				name: "env unset",
				summary: "Remove a variable from an environment",
				args: [{ name: "env" }, { name: "NAME" }],
				async run(ctx) {
					const client = await ctx.client();
					const environmentId = await environmentIdOf(ctx, client, ctx.arg(0));
					const name = ctx.arg(1);
					await client.deleteEnvironmentVariable(environmentId, name);
					ctx.emit({ deleted: name, environmentId }, () => `Removed ${name} from ${ctx.arg(0)}.`);
				},
			},
			{
				name: "env file",
				summary: "Add or replace a secret file, written into each new sandbox once it runs",
				args: [{ name: "env" }, { name: "path" }],
				flags: {
					mode: { type: "string", value: "<octal>", description: "Its mode in the sandbox (default 0600)" },
					from: { type: "string", value: "<file>", description: "Read it from this local file; default stdin" },
				},
				details:
					"<path> is where it goes in the sandbox. Its content is sealed at rest and never shown again: kantel env\n" +
					"show lists its path, mode and size. A secret file is in the sandbox, so anything there can read it.\n" +
					"  kantel env file work /home/user/.npmrc --from ~/.npmrc\n" +
					"kantel env file rm <env> <path> removes one.",
				async run(ctx) {
					const path = ctx.arg(1);
					const mode = modeOf(ctx.string("mode"));
					const from = ctx.string("from");
					let content: Uint8Array;
					if (from === undefined) {
						const stdin = ctx.io.stdin();
						if (stdin.isTTY === true) throw new UsageError("give the content with --from <file>, or pipe it in");
						content = await readAll(stdin);
					} else content = await readFile(resolve(ctx.io.cwd, from));
					const client = await ctx.client();
					const environmentId = await environmentIdOf(ctx, client, ctx.arg(0));
					const answer: unknown = await client.setEnvironmentFile(environmentId, {
						path,
						...(mode === undefined ? {} : { mode }),
						content: Buffer.from(content).toString("base64"),
						encoding: "base64",
					});
					const size = content.length;
					// The mode it has now, as Kantel answers: new contents without --mode keep the file's.
					const saved = fileIn(answer, path);
					const shownMode = saved?.mode ?? mode ?? 0o600;
					ctx.emit(withoutProtectedValues(answer ?? { environmentId, path, sizeBytes: size }), () =>
						[
							`Saved ${path} (${bytes(saved?.sizeBytes ?? size)}, mode ${octal(shownMode)}) in ${ctx.arg(0)}.`,
							"Sandboxes made from now on get it.",
						].join("\n"),
					);
				},
			},
			{
				name: "env file rm",
				summary: "Remove a secret file from an environment",
				args: [{ name: "env" }, { name: "path" }],
				async run(ctx) {
					const client = await ctx.client();
					const environmentId = await environmentIdOf(ctx, client, ctx.arg(0));
					const path = ctx.arg(1);
					await client.deleteEnvironmentFile(environmentId, { path });
					ctx.emit({ deleted: path, environmentId }, () => `Removed ${path} from ${ctx.arg(0)}.`);
				},
			},
			{
				name: "env repo add",
				summary: "Clone a git repository into each new sandbox once it runs",
				args: [{ name: "env" }, { name: "url" }],
				flags: {
					path: { type: "string", value: "<dir>", description: "Where in the sandbox to clone it" },
					ref: { type: "string", value: "<ref>", description: "The branch or tag (default the repository's default)" },
				},
				details:
					"The URL is https://. It is cloned through the egress proxy, after the secret files are written, and a\n" +
					"failed clone is an event on the sandbox, not an error. Adding a URL again replaces its --path and --ref.",
				async run(ctx) {
					const url = ctx.arg(1);
					if (!url.startsWith("https://")) throw new UsageError("a repository's URL starts with https://");
					const path = ctx.string("path");
					const ref = ctx.string("ref");
					const client = await ctx.client();
					const repo = {
						url,
						...(path === undefined ? {} : { path }),
						...(ref === undefined ? {} : { ref }),
					};
					const { environment, updated } = await editAsRead(async () => {
						const environment = await loadEnvironment(ctx, client, ctx.arg(0));
						const repos = [...environment.repos.filter((item) => item.url !== url), repo];
						const expected = environment.repos;
						return { environment, updated: await client.putEnvironmentRepos(environment.id, { repos, expected }) };
					});
					ctx.emit(withoutProtectedValues(updated), () => `Added ${url} to ${environment.name}.`);
				},
			},
			{
				name: "env repo rm",
				summary: "Stop cloning a repository into new sandboxes",
				args: [{ name: "env" }, { name: "url" }],
				async run(ctx) {
					const url = ctx.arg(1);
					const client = await ctx.client();
					const { environment, updated } = await editAsRead(async () => {
						const environment = await loadEnvironment(ctx, client, ctx.arg(0));
						const repos = environment.repos.filter((item) => item.url !== url);
						if (repos.length === environment.repos.length) {
							throw new CliError(`${url} isn't one of ${environment.name}'s repositories`);
						}
						const expected = environment.repos;
						return { environment, updated: await client.putEnvironmentRepos(environment.id, { repos, expected }) };
					});
					ctx.emit(withoutProtectedValues(updated), () => `Removed ${url} from ${environment.name}.`);
				},
			},
			{
				name: "env grant",
				summary: "Allow or refuse requests to a host, by method and path, for every sandbox made from it",
				args: [{ name: "env" }, { name: "allow|deny" }, { name: "host" }],
				flags: GRANT_FLAGS,
				details: `${GRANT_DETAILS}\n  kantel env grant work deny api.github.com --method DELETE --path '/repos/**'`,
				async run(ctx) {
					const grant = parseGrant(ctx.arg(1), ctx.arg(2), ctx.list("method"), ctx.list("path"));
					const client = await ctx.client();
					const { environment, updated } = await editAsRead(async () => {
						const environment = await loadEnvironment(ctx, client, ctx.arg(0));
						const grants: GrantInput[] = [...environment.grants, grant];
						const expected = environment.grants;
						return { environment, updated: await client.putEnvironmentGrants(environment.id, { grants, expected }) };
					});
					const id = addedGrantId(environment.grants, updated.grants);
					ctx.emit(withoutProtectedValues(updated), () => `Added "${grantText(grant)}"${id} to ${environment.name}.`);
				},
			},
			{
				name: "env grant rm",
				summary: "Remove one of an environment's grants",
				args: [{ name: "env" }, { name: "grant-id" }],
				async run(ctx) {
					const client = await ctx.client();
					const { environment, updated } = await editAsRead(async () => {
						const environment = await loadEnvironment(ctx, client, ctx.arg(0));
						const grants = withoutGrant(environment.grants, ctx.arg(1), environment.name);
						const expected = environment.grants;
						return { environment, updated: await client.putEnvironmentGrants(environment.id, { grants, expected }) };
					});
					ctx.emit(withoutProtectedValues(updated), () => `Removed ${ctx.arg(1)} from ${environment.name}.`);
				},
			},
			{
				name: "egress",
				summary: "A sandbox's outbound requests: allowed or refused, and which protected variables were swapped in",
				args: [{ name: "sandbox" }],
				flags: {
					denied: { type: "boolean", description: "Only the refused requests" },
					limit: { type: "string", value: "<n>", description: "At most this many, newest first (Kantel keeps 1000)" },
				},
				details:
					"CODE/RULE is the X-Kantel-Proxy-Error code the sandbox saw, and the grant or setting that decided.\n" +
					"Paths are kept without their query. An HTTPS tunnel the proxy doesn't open shows as one CONNECT.",
				async run(ctx) {
					const limit = whole(ctx.string("limit"), "--limit");
					const client = await ctx.client();
					const egress = await client.getSandboxEgress(ctx.arg(0), limit === undefined ? undefined : { limit });
					const denied = ctx.boolean("denied");
					const entries = denied ? egress.entries.filter((entry) => entry.decision === "denied") : egress.entries;
					ctx.emit(withoutProtectedValues(denied ? { ...egress, entries } : egress), () =>
						describeEgress(egress, entries, denied),
					);
				},
			},
			{
				name: "grant",
				summary: "Allow or refuse one sandbox's requests to a host, by method and path",
				args: [{ name: "sandbox" }, { name: "allow|deny" }, { name: "host" }],
				flags: GRANT_FLAGS,
				details: [
					GRANT_DETAILS,
					"  kantel grant sbx_123 deny api.github.com --method DELETE --path '/repos/**'",
					"A running sandbox picks it up within seconds. kantel egress <sandbox> shows its grants.",
				].join("\n"),
				async run(ctx) {
					const grant = parseGrant(ctx.arg(1), ctx.arg(2), ctx.list("method"), ctx.list("path"));
					const client = await ctx.client();
					const { sandbox, updated } = await editAsRead(async () => {
						const sandbox = await client.getSandbox(ctx.arg(0));
						const grants: GrantInput[] = [...sandbox.grants, grant];
						const expected = sandbox.grants;
						return { sandbox, updated: await client.putSandboxGrants(sandbox.id, { grants, expected }) };
					});
					const id = addedGrantId(sandbox.grants, updated.grants);
					ctx.emit(updated, () => `Added "${grantText(grant)}"${id} to ${sandbox.id}.`);
				},
			},
			{
				name: "grant rm",
				summary: "Remove one of a sandbox's own grants",
				args: [{ name: "sandbox" }, { name: "grant-id" }],
				async run(ctx) {
					const client = await ctx.client();
					const { sandbox, updated } = await editAsRead(async () => {
						const sandbox = await client.getSandbox(ctx.arg(0));
						const grants = withoutGrant(sandbox.grants, ctx.arg(1), sandbox.id);
						const expected = sandbox.grants;
						return { sandbox, updated: await client.putSandboxGrants(sandbox.id, { grants, expected }) };
					});
					ctx.emit(updated, () => `Removed ${ctx.arg(1)} from ${sandbox.id}.`);
				},
			},
		],
	},
	{
		title: "API keys and organisations",
		commands: [
			{
				name: "key list",
				summary: "The account's API keys",
				async run(ctx) {
					const config = await ctx.config();
					const keys = await (await ctx.client()).listApiKeys({ account: config.account });
					const rows = keys.items.map((key) => [key.id, key.name, key.prefix, keyState(key), key.scopes.join(",")]);
					ctx.emit(keys, () =>
						rows.length === 0 ? "No API keys." : table(["ID", "NAME", "PREFIX", "STATE", "SCOPES"], rows),
					);
				},
			},
			{
				name: "key create",
				summary: "Make a scoped API key; its secret is shown once",
				args: [{ name: "name" }],
				flags: {
					preset: { type: "string", value: "<agent|ci|read-only|admin>", description: "A named set of scopes" },
					scope: { type: "string", multiple: true, value: "<scope>", description: "A scope; repeat for more" },
					"expires-days": { type: "string", value: "<n>", description: "It stops working after this many days" },
					sandbox: { type: "string", multiple: true, value: "<id>", description: "Limit it to this sandbox" },
				},
				details: `Scopes: ${SCOPES.join(", ")}.\nA coding agent's key: kantel key create agent --preset agent`,
				async run(ctx) {
					const config = await ctx.config();
					const sandboxIds = ctx.list("sandbox");
					const issued = await (await ctx.client()).createApiKey({
						account: config.account,
						name: ctx.arg(0),
						preset: choice(ctx.string("preset"), PRESETS, "--preset"),
						scopes: choices(ctx.list("scope"), SCOPES, "--scope"),
						expiresInDays: whole(ctx.string("expires-days"), "--expires-days"),
						sandboxIds: sandboxIds.length === 0 ? undefined : sandboxIds,
					});
					ctx.emit(issued, () => issuedKey(issued));
				},
			},
			{
				name: "key rotate",
				summary: "Replace a key's secret; the old one stops working at once",
				args: ID_ARG,
				async run(ctx) {
					const issued = await (await ctx.client()).rotateApiKey(ctx.arg(0));
					ctx.emit(issued, () => issuedKey(issued));
				},
			},
			{
				name: "key revoke",
				summary: "Stop a key working",
				args: ID_ARG,
				async run(ctx) {
					const key = await (await ctx.client()).revokeApiKey(ctx.arg(0));
					ctx.emit(key, () => `Revoked ${key.id} (${key.name}).`);
				},
			},
			{
				name: "org list",
				summary: "Your personal account and your organisations",
				async run(ctx) {
					const accounts = await (await ctx.client()).listAccounts();
					const rows = accounts.items.map((account) => [account.id, account.kind, account.name, account.role]);
					ctx.emit(accounts, () => table(["ID", "KIND", "NAME", "ROLE"], rows));
				},
			},
			{
				name: "org create",
				summary: "Make an organisation, with you as its owner",
				args: [{ name: "name" }],
				async run(ctx) {
					const account = await (await ctx.client()).createOrganisation({ name: ctx.arg(0) });
					ctx.emit(account, () => `Created ${account.id} (${account.name}).`);
				},
			},
			{
				name: "org join",
				summary: "Join an organisation with an invite's code",
				args: [{ name: "code" }],
				async run(ctx) {
					const account = await (await ctx.client()).joinOrganisation({ code: ctx.arg(0) });
					ctx.emit(account, () => `Joined ${account.name} (${account.id}) as ${account.role}.`);
				},
			},
		],
	},
	{
		title: "Webhooks, events and telemetry",
		commands: [
			{
				name: "webhook list",
				summary: "The account's webhooks",
				async run(ctx) {
					const config = await ctx.config();
					const hooks = await (await ctx.client()).listWebhooks({ account: config.account });
					const rows = hooks.items.map((hook) => {
						const last = hook.lastDelivery;
						const delivered = last === undefined ? "" : `${last.ok ? "ok" : "failed"} ${ago(last.at)}`;
						return [hook.id, hook.name, hook.url, hook.enabled ? "enabled" : "disabled", delivered];
					});
					ctx.emit(hooks, () =>
						rows.length === 0 ? "No webhooks." : table(["ID", "NAME", "URL", "STATE", "LAST DELIVERY"], rows),
					);
				},
			},
			{
				name: "webhook create",
				summary: "Send the account's events to a URL; its signing secret is shown once",
				args: [{ name: "url" }],
				flags: {
					event: { type: "string", multiple: true, value: "<type>", description: "An event to send; default all" },
					name: { type: "string", value: "<name>", description: "Default: the URL's host" },
				},
				details: `Events: ${EVENT_TYPES.join(", ")}.`,
				async run(ctx) {
					const config = await ctx.config();
					const url = ctx.arg(0);
					const created = await (await ctx.client()).createWebhook({
						account: config.account,
						name: ctx.string("name") ?? (URL.canParse(url) ? new URL(url).host : url),
						url,
						events: choices(ctx.list("event"), EVENT_TYPES, "--event") ?? EVENT_TYPES,
					});
					ctx.emit(created, () =>
						[
							`Created ${created.webhook.id} (${created.webhook.name}).`,
							"",
							`  ${created.secret}`,
							"",
							"Its signing secret: store it now, it isn't shown again.",
						].join("\n"),
					);
				},
			},
			{
				name: "webhook rm",
				summary: "Delete a webhook",
				args: ID_ARG,
				async run(ctx) {
					await (await ctx.client()).deleteWebhook(ctx.arg(0));
					ctx.emit({ deleted: ctx.arg(0) }, () => `Deleted ${ctx.arg(0)}.`);
				},
			},
			{
				name: "webhook test",
				summary: "Send a webhook a test delivery now",
				args: ID_ARG,
				async run(ctx) {
					const delivery = await (await ctx.client()).testWebhook(ctx.arg(0));
					const detail = delivery.lastStatus ?? delivery.lastError;
					ctx.emit(delivery, () => `${delivery.state}${detail === undefined ? "" : ` (${detail})`}`);
					return delivery.state === "failed" ? 1 : 0;
				},
			},
			{
				name: "events",
				summary: "The account's events, newest first",
				flags: {
					sandbox: { type: "string", value: "<id>", description: "Only this sandbox's" },
					type: { type: "string", value: "<type>", description: "Only this type of event" },
					cursor: cursorFlag,
				},
				async run(ctx) {
					const config = await ctx.config();
					const page = await (await ctx.client()).listEvents({
						account: config.account,
						sandboxId: ctx.string("sandbox"),
						type: choice(ctx.string("type"), EVENT_TYPES, "--type"),
						cursor: ctx.string("cursor"),
					});
					const rows = page.items.map((event) => {
						const { data } = event;
						const change =
							data.previousState !== undefined && data.state !== undefined
								? `${data.previousState} to ${data.state}`
								: data.state;
						const detail = [data.name, change, data.reason].filter((part) => part !== undefined).join(", ");
						return [timestamp(event.createdAt), event.type, event.sandboxId ?? event.snapshotId ?? "", detail];
					});
					ctx.emit(page, () =>
						rows.length === 0
							? "No events."
							: table(["TIME", "TYPE", "ON", "DETAIL"], rows) + more(page.nextCursor, "kantel events"),
					);
				},
			},
			{
				name: "telemetry get",
				summary: "Where the account's OpenTelemetry goes",
				async run(ctx) {
					const config = await ctx.config();
					const client = await ctx.client();
					try {
						const telemetry = await client.getTelemetry({ account: config.account });
						const last = telemetry.lastExport;
						const lastError = last?.error;
						const failed = lastError === undefined ? "failed" : `failed: ${lastError}`;
						const lastExport = last === undefined ? undefined : `${last.ok ? "ok" : failed} ${ago(last.at)}`;
						ctx.emit(telemetry, () =>
							fields([
								["endpoint", telemetry.endpoint],
								["signals", telemetry.signals.join(", ")],
								["headers", telemetry.headerNames.join(", ")],
								["last export", lastExport],
							]),
						);
					} catch (error) {
						if (!(error instanceof KantelApiError) || error.code !== "not_found") throw error;
						ctx.emit(null, () => "No OpenTelemetry export is set.");
					}
				},
			},
			{
				name: "telemetry set",
				summary: "Send the account's metrics and events to an OTLP/HTTP collector",
				args: [{ name: "endpoint" }],
				flags: {
					header: { type: "string", multiple: true, value: "<K=V>", description: "A header to send; repeat it" },
					signal: {
						type: "string",
						multiple: true,
						value: "<metrics|logs>",
						description: "What to send; default both",
					},
				},
				async run(ctx) {
					const config = await ctx.config();
					const saved = await (await ctx.client()).putTelemetry({
						account: config.account,
						endpoint: ctx.arg(0),
						headers: pairs(ctx.list("header"), "--header"),
						signals: choices(ctx.list("signal"), SIGNALS, "--signal"),
					});
					const { test } = saved;
					const answer = [
						test.status === undefined ? "" : ` (${test.status})`,
						test.error === undefined ? "" : `: ${test.error}`,
					].join("");
					ctx.emit(saved, () =>
						test.ok
							? `Saved; the collector took a test export${answer}.`
							: `Saved, but the collector refused a test export${answer}.`,
					);
				},
			},
			{
				name: "telemetry rm",
				summary: "Stop sending OpenTelemetry",
				async run(ctx) {
					const config = await ctx.config();
					await (await ctx.client()).deleteTelemetry({ account: config.account });
					ctx.emit({ deleted: true }, () => "Removed the OpenTelemetry export.");
				},
			},
		],
	},
	{
		title: "Your own hosts (experimental)",
		commands: [
			{
				name: "hosts add",
				summary: "Add a Linux machine of your own: only your account's sandboxes will run on it",
				args: [{ name: "name", optional: true }],
				flags: {
					label: { type: "string", multiple: true, value: "<K=V>", description: "A label for the host; repeat it" },
					expires: {
						type: "string",
						value: "<minutes>",
						description: "How long the token lasts, 5 to 10080; default 60",
					},
				},
				details:
					"It prints a one-line command to run on the machine, as root. kantel-host installs, dials out to\n" +
					"Kantel and keeps that connection open: the machine needs no inbound port and may sit behind NAT.\n" +
					"The host joins the account you act in (your personal account, or --account <org>); from then on that\n" +
					"account's new sandboxes go on its own hosts, and no other account's ever do. The deployment must\n" +
					"have account hosts turned on (KANTEL_ACCOUNT_HOSTS=experimental).",
				async run(ctx) {
					const config = await ctx.config();
					const joinToken = await (await ctx.client()).createAccountJoinToken({
						account: config.account,
						name: ctx.optional(0),
						labels: pairs(ctx.list("label"), "--label"),
						expiresInMinutes: whole(ctx.string("expires"), "--expires", 5),
					});
					ctx.emit(joinToken, () =>
						[
							`Run this on the machine, as root, before ${timestamp(joinToken.expiresAt)}:`,
							"",
							`  ${joinToken.command}`,
							"",
							`It joins account ${joinToken.accountId}; the token works once. Then: kantel hosts list`,
						].join("\n"),
					);
				},
			},
			{
				name: "hosts list",
				summary: "The hosts added to your account",
				async run(ctx) {
					const config = await ctx.config();
					const hosts = await (await ctx.client()).listAccountHosts({ account: config.account });
					const rows = hosts.items.map((host) => [
						host.id,
						host.name,
						host.state,
						host.tiers.join(","),
						String(host.allocated.sandboxes),
						host.lastSeenAt === undefined ? "" : ago(host.lastSeenAt),
					]);
					ctx.emit(hosts, () =>
						rows.length === 0
							? "No hosts of your own. Add one with: kantel hosts add"
							: table(["ID", "NAME", "STATE", "TIERS", "SANDBOXES", "LAST SEEN"], rows),
					);
				},
			},
			{
				name: "hosts info",
				summary: "One of your hosts",
				args: ID_ARG,
				async run(ctx) {
					const host = await (await ctx.client()).getAccountHost(ctx.arg(0));
					ctx.emit(host, () => describeHost(host));
				},
			},
			{
				name: "hosts drain",
				summary: "Stop placing new sandboxes on one of your hosts (--off to take them again)",
				args: ID_ARG,
				flags: { off: { type: "boolean", description: "Take new sandboxes again" } },
				async run(ctx) {
					const draining = !ctx.boolean("off");
					const host = await (await ctx.client()).updateAccountHost(ctx.arg(0), { draining });
					ctx.emit(host, () => `${host.id} (${host.name}) is ${host.state}.`);
				},
			},
			{
				name: "hosts rm",
				summary: "Remove one of your hosts: revoke its credential and close its connection",
				args: ID_ARG,
				details:
					"Its sandboxes keep their disks on the machine but can't be reached. To take kantel-host off the\n" +
					"machine too, run on it: sudo kantel-host uninstall",
				async run(ctx) {
					const host = await (await ctx.client()).removeAccountHost(ctx.arg(0));
					ctx.emit(host, () => `Removed ${host.id} (${host.name}); it is ${host.state}.`);
				},
			},
		],
	},
	{
		title: "End-to-end encryption (experimental)",
		commands: E2E_COMMANDS,
	},
	{
		title: "Coding agents",
		commands: [
			{
				name: "init",
				summary: "Teach this project's coding agents to use Kantel: AGENTS.md, CLAUDE.md and a kantel skill",
				flags: {
					global: {
						type: "boolean",
						description:
							"Install the skill for every project (~/.claude/skills, ~/.agents/skills) and skip the .md files",
					},
					for: {
						type: "string",
						multiple: true,
						value: "<claude|codex|pi>",
						description: "Only for these agents; repeat it (default all three)",
					},
				},
				details:
					"It writes Kantel's block into AGENTS.md (Codex, pi, Cursor) and CLAUDE.md (Claude Code), replacing an\n" +
					"older one between its markers and leaving the rest, and the kantel skill into .agents/skills (Codex,\n" +
					"pi) and .claude/skills (Claude Code). Nothing it writes holds a key. For MCP instead: kantel agents.",
				async run(ctx) {
					const wanted = choices(ctx.list("for"), ["claude", "codex", "pi"] as const, "--for") ?? [
						"claude",
						"codex",
						"pi",
					];
					const global = ctx.boolean("global");
					const base = global ? ctx.io.home : ctx.io.cwd;
					const claude = wanted.includes("claude");
					const others = wanted.includes("codex") || wanted.includes("pi");
					const written: string[] = [];
					const put = async (path: string, content: string): Promise<void> => {
						await mkdir(dirname(path), { recursive: true });
						await writeFile(path, content);
						written.push(path);
					};
					if (!global) {
						for (const [file, wants] of [
							["AGENTS.md", others],
							["CLAUDE.md", claude],
						] as const) {
							if (!wants) continue;
							const path = join(base, file);
							await put(path, upsertAgentsBlock(await readTextIfAny(path)));
						}
					}
					if (claude) await put(join(base, SKILL_PATHS.claude), SKILL_MD);
					if (others) await put(join(base, SKILL_PATHS.agents), SKILL_MD);
					const signedIn = (await ctx.config()).apiKey !== undefined;
					// What it writes tells agents to run `kantel` by name, so say so when that would fail.
					const found = await onPath("kantel", ctx.io.env);
					ctx.emit({ written, kantelOnPath: found }, () =>
						[
							...written.map((path) => `Wrote ${path}`),
							"",
							signedIn
								? "Your agents use the same sign-in as you (or set KANTEL_API_KEY to a key of their own)."
								: "Sign in with kantel login, or give the agents a key: kantel key create agent --preset agent.",
							...(found
								? []
								: [
										"",
										"kantel isn't on your PATH, and your agents run it by name: put the directory it's in on your PATH",
										"(install-cli.sh links it in ~/.local/bin).",
									]),
						].join("\n"),
					);
				},
			},
			{
				name: "mcp",
				summary: "Serve Kantel's MCP server on stdio, for a coding agent",
				details: "Its tools create sandboxes and run commands, files, ports and snapshots in them.",
				async run(ctx) {
					const config = await ctx.config();
					if (config.apiKey === undefined) {
						ctx.note("kantel mcp: no API key is set (KANTEL_API_KEY), so Kantel will refuse the tools' calls");
					}
					const server = createMcpServer({
						client: await ctx.client(),
						version: VERSION,
						account: config.account,
						log: (line) => ctx.note(line),
					});
					await serveStdio(server, { stdin: ctx.io.stdin(), stdout: ctx.io.stdout, stderr: ctx.io.stderr });
				},
			},
			{
				name: "agents",
				summary: "Setup for Claude Code, Codex, pi and Cursor (never with your key in it)",
				args: [{ name: "claude|codex|pi|cursor|all", optional: true }],
				flags: { write: { type: "boolean", description: "Write the pi block into ./AGENTS.md, replacing an old one" } },
				async run(ctx) {
					if (ctx.boolean("write")) {
						const path = resolve(ctx.io.cwd, "AGENTS.md");
						await writeFile(path, upsertAgentsBlock(await readTextIfAny(path)));
						ctx.emit({ path }, () => `Wrote Kantel's block into ${path}.`);
						return;
					}
					const harness = choice(ctx.optional(0) ?? "all", [...HARNESSES, "all" as const], "the agent") ?? "all";
					const url = originOf((await ctx.config()).url);
					const launch = await mcpLaunchFor(ctx.io);
					const snippets = {
						url,
						mcp: launch,
						claude: claudeSetup(url, launch),
						codex: codexSetup(url, launch),
						codexToml: codexToml(url, launch),
						mcpServers: JSON.parse(mcpServersJson(url, launch)) as unknown,
						agentsMd: AGENTS_BLOCK,
					};
					ctx.emit(snippets, () => agentsGuide(url, harness, launch));
				},
			},
		],
	},
	{
		title: "Help",
		commands: [
			{
				name: "help",
				summary: "Every command, or one command's flags",
				args: [{ name: "command", optional: true, variadic: true }],
				async run(ctx) {
					ctx.out(helpFor(ctx.positionals));
				},
			},
			{
				name: "version",
				summary: "The CLI's version (also --version)",
				async run(ctx) {
					ctx.out(VERSION);
				},
			},
		],
	},
];

const COMMANDS: readonly CommandSpec[] = SECTIONS.flatMap((section) => section.commands);
const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

const GROUPS: { readonly [name: string]: string } = {
	sandbox: "Create, inspect, stop and delete sandboxes (the same as kantel new, list, info, stop…)",
	files: "Read, write and list a sandbox's files",
	port: "Give a sandbox's ports HTTPS URLs",
	snapshot: "Take, save, browse and delete snapshots",
	env: "Environments: the variables, protected secrets, files, repos and grants new sandboxes start with",
	key: "Make, rotate and revoke scoped API keys",
	org: "Your organisations",
	webhook: "Send the account's events to a URL",
	telemetry: "Send the account's metrics and events to OpenTelemetry",
	hosts: "Run your sandboxes on machines of your own (experimental)",
	e2e: "End-to-end encryption between your devices and your hosts, which the gateway relays but can't read",
};
const GROUP_ALIASES: { readonly [alias: string]: string } = { sb: "sandbox" };
/** Other names for commands: short ones, and the `sandbox …` spellings of the first CLI, which keep working. */
const ALIASES: { readonly [alias: string]: string } = {
	ls: "list",
	rm: "delete",
	create: "new",
	get: "info",
	"sandbox create": "new",
	"sandbox new": "new",
	"sandbox list": "list",
	"sandbox ls": "list",
	"sandbox get": "info",
	"sandbox info": "info",
	"sandbox stop": "stop",
	"sandbox resume": "resume",
	"sandbox fork": "fork",
	"sandbox delete": "delete",
	"sandbox rm": "delete",
	"sandbox extend": "extend",
	"sandbox usage": "usage",
};
/** Commands that moved to the operators' CLI, kantel-admin (a file on each of Kantel's GitHub Releases). */
const MOVED: { readonly [name: string]: string } = {
	"host list": "kantel-admin host list (your own hosts: kantel hosts list)",
	"host join-token": "kantel-admin host add (a host of your own: kantel hosts add)",
};
const SUBCOMMAND_ALIASES: { readonly [alias: string]: string } = {
	ls: "list",
	list: "ls",
	rm: "delete",
	delete: "rm",
};

// Help.

const argUsage = (arg: Arg): string => {
	const name = `${arg.name}${arg.variadic === true ? "…" : ""}`;
	return arg.optional === true ? `[${name}]` : `<${name}>`;
};

function synopsis(command: CommandSpec): string {
	const parts = [command.usage ?? [command.name, ...(command.args ?? []).map(argUsage)].join(" ")];
	if (command.rest !== undefined) {
		parts.push(command.restOptional === true ? `[-- <${command.rest}>]` : `-- <${command.rest}>`);
	}
	return parts.join(" ");
}

function flagRows(specs: FlagSpecs): (readonly [string, string])[] {
	return Object.entries(specs)
		.filter(([, spec]) => spec.hidden !== true)
		.map(([name, spec]) => {
			const short = spec.short === undefined ? "" : `-${spec.short}, `;
			const value = spec.value === undefined ? "" : ` ${spec.value}`;
			return [`${short}--${name}${value}${spec.multiple === true ? "…" : ""}`, spec.description] as const;
		});
}

const indented = (text: string): string =>
	text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");

function commandList(commands: readonly CommandSpec[], width: number): string {
	return commands.map((command) => `  ${synopsis(command).padEnd(width)}  ${command.summary}`).join("\n");
}

function mainHelp(): string {
	const shown = (commands: readonly CommandSpec[]): CommandSpec[] => commands.filter((c) => c.hidden !== true);
	const width = Math.max(...shown(COMMANDS).map((command) => synopsis(command).length));
	const sections = SECTIONS.map((section) => `${section.title}:\n${commandList(shown(section.commands), width)}`);
	return [
		`kantel ${VERSION}: Kantel's sandboxes from a terminal or a coding agent.`,
		"",
		"Usage: kantel <command> [flags]",
		"",
		sections.join("\n\n"),
		"",
		`Flags on every command:\n${indented(fields(flagRows(GLOBAL_FLAGS)))}`,
		"",
		'Aliases: ls for list, rm for delete. "kantel help <command>" shows a command\'s flags.',
		"Operators of a self-hosted Kantel (install, upgrade, hosts): kantel-admin help, from Kantel's GitHub Releases.",
	].join("\n");
}

function groupHelp(group: string): string {
	const sandboxVerbs = new Set(
		Object.entries(ALIASES)
			.filter(([alias]) => alias.startsWith("sandbox "))
			.map(([, name]) => name),
	);
	const commands = COMMANDS.filter((command) =>
		group === "sandbox" ? sandboxVerbs.has(command.name) : command.name.startsWith(`${group} `),
	);
	const width = Math.max(...commands.map((command) => synopsis(command).length));
	return [
		`kantel ${group}: ${GROUPS[group] ?? ""}.`,
		"",
		commandList(commands, width),
		"",
		`"kantel help ${group} <command>" shows a command's flags.`,
	].join("\n");
}

function commandHelp(command: CommandSpec): string {
	const lines = [`Usage: kantel ${synopsis(command)} [flags]`, "", `${command.summary}.`];
	if (command.details !== undefined) lines.push("", command.details);
	const own = flagRows(command.flags ?? {});
	if (own.length > 0) lines.push("", `Flags:\n${indented(fields(own))}`);
	lines.push("", `Flags on every command:\n${indented(fields(flagRows(GLOBAL_FLAGS)))}`);
	return lines.join("\n");
}

function helpFor(words: readonly string[]): string {
	if (words.length === 0) return mainHelp();
	const found = resolveCommand(words);
	if (found.kind === "command") return commandHelp(found.command);
	if (found.kind === "group" && found.unknown === undefined) return groupHelp(found.group);
	if (found.kind === "moved") return `${found.name} is for operators now: ${found.to}`;
	throw new UsageError(`there is no command "${words.join(" ")}"`);
}

// Finding the command.

type Resolution =
	| { readonly kind: "command"; readonly command: CommandSpec; readonly argv: readonly string[] }
	| { readonly kind: "group"; readonly group: string; readonly unknown?: string }
	| { readonly kind: "moved"; readonly name: string; readonly to: string }
	| { readonly kind: "unknown"; readonly word?: string };

/**
 * The command `argv` names in its first one, two or three words (flags may come before them), and the rest of `argv`.
 * The longest name wins: `env file rm` over `env file`, and `grant rm` over `grant`.
 */
function resolveCommand(argv: readonly string[]): Resolution {
	const words: number[] = [];
	for (let index = 0; index < argv.length && words.length < 3; index++) {
		const token = argv[index] ?? "";
		if (token === "--") break;
		if (token.startsWith("-") && token !== "-") {
			const name = token.replace(/^--?/, "");
			// A global flag's value isn't a word.
			if (!name.includes("=") && GLOBAL_FLAGS[name]?.type === "string") index++;
			continue;
		}
		words.push(index);
	}
	const [firstIndex, secondIndex, thirdIndex] = words;
	if (firstIndex === undefined) return { kind: "unknown" };
	const typed = argv[firstIndex] ?? "";
	const first = GROUP_ALIASES[typed] ?? typed;
	const without = (...indices: number[]): string[] => argv.filter((_, index) => !indices.includes(index));
	const second = secondIndex === undefined ? undefined : (argv[secondIndex] ?? "");
	const pair = second === undefined ? undefined : `${first} ${second}`;
	if (pair !== undefined && MOVED[pair] !== undefined) return { kind: "moved", name: pair, to: MOVED[pair] };
	const named = (name: string): CommandSpec | undefined => BY_NAME.get(ALIASES[name] ?? name);
	/** `prefix word`, or `prefix` and the word's other spelling (`rm` for `delete`). */
	const sub = (prefix: string, word: string): CommandSpec | undefined => {
		const alias = SUBCOMMAND_ALIASES[word];
		return named(`${prefix} ${word}`) ?? (alias === undefined ? undefined : named(`${prefix} ${alias}`));
	};
	if (pair !== undefined && secondIndex !== undefined && thirdIndex !== undefined) {
		const triple = sub(pair, argv[thirdIndex] ?? "");
		if (triple !== undefined)
			return { kind: "command", command: triple, argv: without(firstIndex, secondIndex, thirdIndex) };
	}
	const single = named(first);
	if (single !== undefined) {
		// A command of its own may have subcommands too: `grant rm` beside `grant`.
		const double = second === undefined || secondIndex === undefined ? undefined : sub(first, second);
		if (double !== undefined && secondIndex !== undefined) {
			return { kind: "command", command: double, argv: without(firstIndex, secondIndex) };
		}
		return { kind: "command", command: single, argv: without(firstIndex) };
	}
	if (GROUPS[first] === undefined) return { kind: "unknown", word: typed };
	if (second === undefined || secondIndex === undefined) return { kind: "group", group: first };
	const command = sub(first, second);
	if (command === undefined) return { kind: "group", group: first, unknown: second };
	return { kind: "command", command, argv: without(firstIndex, secondIndex) };
}

// Running.

function createContext(
	io: Io,
	parsed: ParsedArgs,
	positionals: readonly string[],
	rest: readonly string[] | undefined,
): Context {
	let config: Promise<ResolvedConfig> | undefined;
	const loadOnce = (): Promise<ResolvedConfig> => {
		if (config === undefined) {
			const flags = {
				url: stringFlag(parsed, "url"),
				apiKey: stringFlag(parsed, "key") ?? stringFlag(parsed, "api-key"),
				account: stringFlag(parsed, "account"),
			};
			config = loadConfig(flags, io.env, io.configDir);
		}
		return config;
	};
	const json = booleanFlag(parsed, "json") === true;
	const out = (text: string): void => {
		io.stdout.write(`${text}\n`);
	};
	return {
		io,
		json,
		positionals,
		rest,
		arg(index) {
			const value = positionals[index];
			if (value === undefined) throw new UsageError("an argument is missing");
			return value;
		},
		optional: (index) => positionals[index],
		string: (flag) => stringFlag(parsed, flag),
		boolean: (flag) => booleanFlag(parsed, flag) === true,
		list: (flag) => listFlag(parsed, flag),
		config: loadOnce,
		client: async () => makeClient(io, await loadOnce()),
		out,
		note: (text) => {
			io.stderr.write(`${text}\n`);
		},
		emit(value, human) {
			if (json) {
				out(JSON.stringify(value, null, 2));
				return;
			}
			const text = human();
			if (text !== "") out(text);
		},
	};
}

async function execute(command: CommandSpec, argv: readonly string[], io: Io): Promise<number> {
	const parsed = parseArgs(argv, { ...GLOBAL_FLAGS, ...command.flags });
	if (booleanFlag(parsed, "help") === true) {
		io.stdout.write(`${commandHelp(command)}\n`);
		return 0;
	}
	// `--` ends the flags; a command that doesn't take `-- <rest>` gets what follows as more arguments.
	const takesRest = command.rest !== undefined;
	const positionals =
		takesRest || parsed.rest === undefined ? parsed.positionals : [...parsed.positionals, ...parsed.rest];
	const args = command.args ?? [];
	const missing = args.slice(positionals.length).filter((arg) => arg.optional !== true);
	if (missing.length > 0) throw new UsageError(`${command.name} needs ${missing.map(argUsage).join(" ")}`);
	const variadic = args.at(-1)?.variadic === true;
	if (!variadic && positionals.length > args.length) {
		const extra = positionals[args.length] ?? "";
		throw new UsageError(takesRest ? `put the ${command.rest} after --` : `${command.name} takes no "${extra}"`);
	}
	const code = await command.run(createContext(io, parsed, positionals, takesRest ? parsed.rest : undefined));
	return typeof code === "number" ? code : 0;
}

/** What to do about a sandbox that isn't running, as a command to type. */
function notRunningHint(details: SandboxNotRunning): string {
	const resume = `kantel resume ${details.sandboxId}`;
	switch (details.code) {
		case "sandbox_starting":
			return "It is still starting: run the command again in a moment.";
		case "sandbox_stopping":
			return `Once it has stopped, resume it with: ${resume}`;
		case "sandbox_stopped":
		case "sandbox_paused":
		case "sandbox_error":
			return `Resume it with: ${resume}`;
		default:
			return details.hint;
	}
}

function report(error: unknown, io: Io): number {
	if (error instanceof KantelApiError) {
		io.stderr.write(
			`kantel: ${error.code}: ${error.message}${error.reason === undefined ? "" : ` (reason: ${error.reason})`}\n`,
		);
		if (error.code === "unauthenticated") io.stderr.write("Sign in with: kantel login (or set KANTEL_API_KEY)\n");
		const notRunning = notRunningOf(error);
		if (notRunning !== undefined) io.stderr.write(`${notRunningHint(notRunning)}\n`);
		return 1;
	}
	if (error instanceof CliError) {
		io.stderr.write(`kantel: ${error.message}\n`);
		return error.exitCode;
	}
	io.stderr.write(`kantel: ${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
}

async function dispatch(argv: readonly string[], io: Io): Promise<number> {
	const say = (text: string): void => {
		io.stdout.write(`${text}\n`);
	};
	const head = argv[0];
	if (head === undefined || head === "--help" || head === "-h") {
		say(mainHelp());
		return 0;
	}
	if (head === "--version" || head === "-V") {
		say(VERSION);
		return 0;
	}
	const found = resolveCommand(argv);
	if (found.kind === "moved") {
		io.stderr.write(`kantel: ${found.name} is for operators now: ${found.to}\n`);
		return 2;
	}
	if (found.kind === "unknown") {
		const problem = found.word === undefined ? "give a command" : `there is no command "${found.word}"`;
		io.stderr.write(`kantel: ${problem}. "kantel help" lists them.\n`);
		return 2;
	}
	if (found.kind === "group") {
		if (found.unknown === undefined) {
			say(groupHelp(found.group));
			return 0;
		}
		io.stderr.write(`kantel: there is no command "${found.group} ${found.unknown}".\n\n${groupHelp(found.group)}\n`);
		return 2;
	}
	const { command } = found;
	try {
		return await execute(command, found.argv, io);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		io.stderr.write(`kantel: ${error.message}\nUsage: kantel ${synopsis(command)} [flags]\n`);
		return 2;
	}
}

/**
 * Runs `kantel` with `argv` (the words after `kantel`) and resolves with its exit code. Every stream, the environment,
 * `fetch` and the config directory may be given; each defaults to the process's own.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
	const env = options.env ?? process.env;
	const io: Io = {
		fetch: options.fetch ?? fetch,
		env,
		stdout: options.stdout ?? process.stdout,
		stderr: options.stderr ?? process.stderr,
		stdin: () => options.stdin ?? process.stdin,
		configDir: configDirectory(env, options.configDir),
		cwd: options.cwd ?? process.cwd(),
		openUrl: options.openUrl ?? openInBrowser,
		sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
		home: options.home ?? homedir(),
		self: options.self ?? thisCli(),
		connect: options.connect ?? e2e.webSocketChannel,
		served: options.served ?? untilSignalled,
	};
	try {
		return await dispatch(argv, io);
	} catch (error) {
		return report(error, io);
	}
}
