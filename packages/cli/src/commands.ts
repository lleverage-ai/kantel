/**
 * The `kantel` command line: a table of commands, from which `help` is made too. Every command prints compact human
 * output, or Kantel's JSON answer as it is with `--json`. `run` takes its streams, environment, fetch and config
 * directory as options, so tests drive it with no globals.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
	type ApiKey,
	type ApiKeyPreset,
	type ApiKeyScope,
	type Caller,
	type Command,
	createKantelClient,
	type EventType,
	type FileContent,
	type FileList,
	type IssuedApiKey,
	KantelApiError,
	type KantelClient,
	type Sandbox,
	type SandboxSizeName,
	type SandboxType,
} from "@kantel/api/sdk";
import {
	AGENTS_BLOCK,
	agentsGuide,
	claudeSetup,
	codexSetup,
	codexToml,
	HARNESSES,
	mcpServersJson,
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
import { CliError, UsageError } from "./errors.ts";
import { ago, bytes, duration, fields, money, table, timestamp, until } from "./format.ts";
import { createMcpServer, serveStdio } from "./mcp.ts";
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
}

interface Io {
	readonly fetch: typeof fetch;
	readonly env: Env;
	readonly stdout: Output;
	readonly stderr: Output;
	stdin(): Input;
	readonly configDir: string;
	readonly cwd: string;
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
	readonly args?: readonly Arg[];
	readonly flags?: FlagSpecs;
	/** What it takes after `--`, such as exec's `command…`. */
	readonly rest?: string;
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

const bytesOf = (file: FileContent): Uint8Array =>
	Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");

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

const stateOf = (sandbox: Sandbox): string =>
	sandbox.reason === undefined ? sandbox.state : `${sandbox.state}: ${sandbox.reason}`;

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

function runSsh(args: readonly string[], io: Io): Promise<number> {
	return new Promise((done) => {
		const child = spawn("ssh", [...args], { stdio: "inherit" });
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
const ttl: FlagSpec = { type: "string", value: "<minutes>", description: "How long the URL works (default 60)" };
const sizeFlag: FlagSpec = { type: "string", value: "<small|default|large|xlarge>", description: "A microVM's size" };

const ID_ARG: readonly Arg[] = [{ name: "id" }];

/** The start, stop, resume and recover commands, alike but for the call. */
function lifecycle(
	verb: string,
	summary: string,
	flags: FlagSpecs,
	call: (client: KantelClient, sandboxId: string, ctx: Context) => Promise<Sandbox>,
): CommandSpec {
	return {
		name: `sandbox ${verb}`,
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

// The commands.

const SECTIONS: readonly Section[] = [
	{
		title: "Signing in",
		commands: [
			{
				name: "login",
				summary: "Check an API key and save it for the commands after",
				details:
					"The key comes from --key, or from stdin when it is piped in, which keeps it out of your shell history:\n" +
					"  npx kantel login --url https://kantel.example < key.txt\n" +
					"It is saved, readable by you only, in ~/.config/kantel/config.json (or under XDG_CONFIG_HOME).",
				async run(ctx) {
					const stored = await readStoredConfig(ctx.io.configDir);
					let key = ctx.string("key") ?? ctx.string("api-key");
					if (key === undefined) {
						const stdin = ctx.io.stdin();
						if (stdin.isTTY === true) {
							throw new UsageError("give the key with --key <key>, or pipe it in: npx kantel login < key.txt");
						}
						key = new TextDecoder().decode(await readAll(stdin)).trim();
						if (key === "") throw new UsageError("there was no key on stdin");
					}
					const flagAccount = ctx.string("account");
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
				name: "sandbox create",
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
					"no-wait": noWait,
				},
				async run(ctx) {
					const body = {
						name: ctx.string("name"),
						type: choice(ctx.string("type"), SANDBOX_TYPES, "--type"),
						size: choice(ctx.string("size"), SIZES, "--size"),
						image: ctx.string("image"),
						from: ctx.string("from"),
						autoStopMinutes: autoStopOf(ctx.string("auto-stop")),
						labels: pairs(ctx.list("label"), "--label"),
						wait: !ctx.boolean("no-wait"),
					};
					const config = await ctx.config();
					const sandbox = await (await ctx.client()).createSandbox({ account: config.account, ...body });
					ctx.emit(sandbox, () =>
						[
							`Created ${sandbox.id} (${sandbox.name}): ${kindOf(sandbox)}, ${stateOf(sandbox)}.`,
							`  Run a command:  kantel exec ${sandbox.id} -- echo hello`,
							`  Stop it:        kantel sandbox stop ${sandbox.id}`,
						].join("\n"),
					);
					return sandbox.state === "error" ? 1 : 0;
				},
			},
			{
				name: "sandbox list",
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
						return `${sandboxTable(page.items)}${more(page.nextCursor, "kantel sandbox list")}`;
					});
				},
			},
			{
				name: "sandbox get",
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
				name: "sandbox fork",
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
				name: "sandbox delete",
				summary: "Delete a sandbox for good (needs --yes)",
				args: ID_ARG,
				flags: { yes: { type: "boolean", short: "y", description: "Yes, delete it: this can't be undone" } },
				details: "It erases the sandbox and its automatic snapshots; saved snapshots of it stay.",
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					if (!ctx.boolean("yes")) {
						throw new UsageError(
							`deleting a sandbox is permanent: it erases ${sandboxId} and its automatic snapshots. ` +
								`To delete it, run: kantel sandbox delete ${sandboxId} --yes`,
						);
					}
					const sandbox = await (await ctx.client()).deleteSandbox(sandboxId);
					ctx.emit(sandbox, () => `${sandbox.id} ${sandbox.state}`);
				},
			},
			{
				name: "sandbox extend",
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
				name: "sandbox usage",
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
				args: ID_ARG,
				rest: "command…",
				flags: {
					cwd: { type: "string", value: "<dir>", description: "Run it here (default the sandbox user's home)" },
					env: { type: "string", multiple: true, value: "<K=V>", description: "An environment variable; repeat it" },
					timeout: { type: "string", value: "<ms>", description: "Kill it after this long (default 30000)" },
					detach: { type: "boolean", description: "Start it and answer at once, with no time limit" },
					stdin: { type: "boolean", description: "Send this terminal's stdin to the command" },
				},
				details:
					"One word after -- is a shell command line: kantel exec <id> -- 'make && make test'. Several are a\n" +
					"command and its arguments, quoted for the shell. Its stdout and stderr come out on ours, and kantel\n" +
					"exits with its exit code (124 when it timed out).",
				async run(ctx) {
					const sandboxId = ctx.arg(0);
					const words = ctx.rest ?? [];
					if (words.length === 0) throw new UsageError("give the command after --: kantel exec <id> -- <command…>");
					const timeoutMs = whole(ctx.string("timeout"), "--timeout");
					const body = {
						command: commandLine(words),
						cwd: ctx.string("cwd"),
						env: pairs(ctx.list("env"), "--env"),
						timeoutMs,
						detached: ctx.boolean("detach") ? true : undefined,
						stdin: ctx.boolean("stdin") ? new TextDecoder().decode(await readAll(ctx.io.stdin())) : undefined,
					};
					const result = await (await ctx.client()).runCommand(sandboxId, body);
					if (ctx.json) {
						ctx.out(JSON.stringify(result, null, 2));
						return exitCodeOf(result);
					}
					if (result.state === "running") {
						ctx.out(`Started ${result.id} in ${sandboxId}.`);
						return 0;
					}
					if (result.stdout !== "") ctx.io.stdout.write(result.stdout);
					if (result.stderr !== "") ctx.io.stderr.write(result.stderr);
					if (result.truncated) ctx.note("kantel: the output was cut at 1 MiB");
					if (result.state === "timed_out") {
						const after = timeoutMs === undefined ? "" : ` after ${timeoutMs} ms`;
						ctx.note(`kantel: the command timed out${after} and was killed`);
					}
					if (result.state === "killed") ctx.note("kantel: the command was killed");
					return exitCodeOf(result);
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
					const file = await client.readFile(ctx.arg(0), { path: ctx.arg(1), encoding: "base64" });
					ctx.io.stdout.write(bytesOf(file));
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
				summary: "Copy a file (up to 1 MiB) out of a sandbox",
				args: [{ name: "id" }, { name: "remote" }, { name: "local", optional: true }],
				details: "The local path defaults to the file's name here; - writes it to stdout.",
				async run(ctx) {
					const remote = ctx.arg(1);
					const local = ctx.optional(2);
					const file = await (await ctx.client()).readFile(ctx.arg(0), { path: remote, encoding: "base64" });
					const content = bytesOf(file);
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
		],
	},
	{
		title: "Ports, SSH, desktop and browser",
		commands: [
			{
				name: "port expose",
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
				summary: "SSH access to a microVM: print the command that connects, or run it",
				args: ID_ARG,
				flags: {
					exec: { type: "boolean", description: "Run ssh now, in this terminal" },
					"public-key": {
						type: "string",
						value: "<file>",
						description: "Let in this OpenSSH public key (default: a key pair Kantel makes, kept here)",
					},
					ttl: { type: "string", value: "<minutes>", description: "How long the access lasts (default 60)" },
				},
				async run(ctx) {
					const sandboxId = ctx.arg(0);
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
					const args = [
						...(identityFile === undefined ? [] : ["-i", identityFile, "-o", "IdentitiesOnly=yes"]),
						"-p",
						String(access.port),
						`${access.user}@${access.host}`,
					];
					const command = identityFile === undefined ? access.command : ["ssh", ...args].map(shellQuote).join(" ");
					if (ctx.boolean("exec")) return runSsh(args, ctx.io);
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
				name: "desktop",
				summary: "A URL that shows a microVM's desktop in a browser",
				args: ID_ARG,
				flags: { "view-only": viewOnly, ttl },
				async run(ctx) {
					const access = await (await ctx.client()).openDesktop(ctx.arg(0), {
						viewOnly: ctx.boolean("view-only") ? true : undefined,
						ttlMinutes: whole(ctx.string("ttl"), "--ttl"),
					});
					ctx.emit(access, () => access.url);
				},
			},
			{
				name: "browser",
				summary: "Start a microVM's Chrome: its live view URL and CDP URL",
				args: ID_ARG,
				flags: { "view-only": viewOnly, ttl },
				async run(ctx) {
					const access = await (await ctx.client()).openBrowser(ctx.arg(0), {
						viewOnly: ctx.boolean("view-only") ? true : undefined,
						ttlMinutes: whole(ctx.string("ttl"), "--ttl"),
					});
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
		title: "Hosts (super-admins)",
		commands: [
			{
				name: "host list",
				summary: "The machines that run sandboxes",
				async run(ctx) {
					const hosts = await (await ctx.client()).listHosts();
					const rows = hosts.items.map((host) => [
						host.id,
						host.name,
						host.state,
						host.version ?? "",
						host.tiers.join(","),
						String(host.allocated.sandboxes),
						host.lastSeenAt === undefined ? "" : ago(host.lastSeenAt),
					]);
					const header = ["ID", "NAME", "STATE", "VERSION", "TYPES", "SANDBOXES", "SEEN"];
					ctx.emit(hosts, () => (rows.length === 0 ? "No hosts have joined." : table(header, rows)));
				},
			},
			{
				name: "host join-token",
				summary: "A one-use token, and the command that joins a Linux machine with it",
				flags: {
					name: { type: "string", value: "<name>", description: "The host's name" },
					label: { type: "string", multiple: true, value: "<k=v>", description: "A label; repeat for more" },
					"expires-minutes": { type: "string", value: "<n>", description: "Default 60" },
				},
				async run(ctx) {
					const token = await (await ctx.client()).createHostJoinToken({
						name: ctx.string("name"),
						labels: pairs(ctx.list("label"), "--label"),
						expiresInMinutes: whole(ctx.string("expires-minutes"), "--expires-minutes"),
					});
					ctx.emit(token, () =>
						[`Run this on the machine, before ${timestamp(token.expiresAt)}:`, "", `  ${token.command}`].join("\n"),
					);
				},
			},
		],
	},
	{
		title: "Coding agents",
		commands: [
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
					const snippets = {
						url,
						claude: claudeSetup(url),
						codex: codexSetup(url),
						codexToml: codexToml(url),
						mcpServers: JSON.parse(mcpServersJson(url)) as unknown,
						agentsMd: AGENTS_BLOCK,
					};
					ctx.emit(snippets, () => agentsGuide(url, harness));
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
	sandbox: "Create, inspect, stop and delete sandboxes",
	files: "Read, write and list a sandbox's files",
	port: "Give a sandbox's ports HTTPS URLs",
	snapshot: "Take, save, browse and delete snapshots",
	key: "Make, rotate and revoke scoped API keys",
	org: "Your organisations",
	webhook: "Send the account's events to a URL",
	telemetry: "Send the account's metrics and events to OpenTelemetry",
	host: "The machines that run sandboxes (super-admins)",
};
const GROUP_ALIASES: { readonly [alias: string]: string } = { sb: "sandbox" };
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
	const parts = [command.name, ...(command.args ?? []).map(argUsage)];
	if (command.rest !== undefined) parts.push(`-- <${command.rest}>`);
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
	const width = Math.max(...COMMANDS.map((command) => synopsis(command).length));
	const sections = SECTIONS.map((section) => `${section.title}:\n${commandList(section.commands, width)}`);
	return [
		`kantel ${VERSION}: Kantel's sandboxes from a terminal or a coding agent.`,
		"",
		"Usage: kantel <command> [flags]",
		"",
		sections.join("\n\n"),
		"",
		`Flags on every command:\n${indented(fields(flagRows(GLOBAL_FLAGS)))}`,
		"",
		'Aliases: sb for sandbox, ls for list, rm for delete. "kantel help <command>" shows a command\'s flags.',
	].join("\n");
}

function groupHelp(group: string): string {
	const commands = COMMANDS.filter((command) => command.name.startsWith(`${group} `));
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
	throw new UsageError(`there is no command "${words.join(" ")}"`);
}

// Finding the command.

type Resolution =
	| { readonly kind: "command"; readonly command: CommandSpec; readonly argv: readonly string[] }
	| { readonly kind: "group"; readonly group: string; readonly unknown?: string }
	| { readonly kind: "unknown"; readonly word?: string };

/** The command `argv` names in its first one or two words (flags may come before them), and the rest of `argv`. */
function resolveCommand(argv: readonly string[]): Resolution {
	const words: number[] = [];
	for (let index = 0; index < argv.length && words.length < 2; index++) {
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
	const [firstIndex, secondIndex] = words;
	if (firstIndex === undefined) return { kind: "unknown" };
	const typed = argv[firstIndex] ?? "";
	const first = GROUP_ALIASES[typed] ?? typed;
	const without = (...indices: number[]): string[] => argv.filter((_, index) => !indices.includes(index));
	const single = BY_NAME.get(first);
	if (single !== undefined) return { kind: "command", command: single, argv: without(firstIndex) };
	if (GROUPS[first] === undefined) return { kind: "unknown", word: typed };
	if (secondIndex === undefined) return { kind: "group", group: first };
	const second = argv[secondIndex] ?? "";
	const alias = SUBCOMMAND_ALIASES[second];
	const command = BY_NAME.get(`${first} ${second}`) ?? BY_NAME.get(`${first} ${alias ?? second}`);
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

function report(error: unknown, io: Io): number {
	if (error instanceof KantelApiError) {
		io.stderr.write(`kantel: ${error.code}: ${error.message}\n`);
		if (error.code === "unauthenticated") io.stderr.write("Sign in with: npx kantel login (or set KANTEL_API_KEY)\n");
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
	};
	try {
		return await dispatch(argv, io);
	} catch (error) {
		return report(error, io);
	}
}
