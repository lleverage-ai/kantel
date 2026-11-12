/**
 * Kantel's MCP server for coding agents, over stdio and without the MCP SDK: newline-delimited JSON-RPC 2.0, one
 * message a line. It answers `initialize`, `ping`, `tools/list` and `tools/call`; notifications get no reply. A tool
 * call that carries a `_meta.progressToken` gets `notifications/progress` every 15 s while it works, and
 * `notifications/cancelled` stops its wait (not what it started in the sandbox) and its answer. Its tools drive
 * sandboxes through the SDK, and an error Kantel answers comes back as a tool result with `isError`, so the agent can
 * read it. Nothing but JSON-RPC goes to stdout; logs go to stderr.
 */
import { setTimeout as delay } from "node:timers/promises";
import { type Command, KantelApiError, type KantelClient } from "@kantel/api/sdk";
import { notRunningOf } from "./errors.ts";

/** The protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL = "2025-06-18";

/** How to choose between an isolate and a microVM, for the instructions and sandbox_create alike. */
const CHOOSING_A_TYPE =
	"Choose its type. An isolate starts in milliseconds and costs almost nothing: a shell (just-bash) over files in " +
	"/workspace with curl, jq, grep, rg, sed, awk, sort, diff and gzip, plus `node` (JavaScript or TypeScript, with " +
	"fs, path, crypto, fetch and relative imports, but no npm packages) and `python` (Pyodide: the standard library " +
	"and numpy, but no pip install). Each command runs at most 30 s unless you give a timeoutMs. It has no git, " +
	"package manager, Docker, browser, ports or SSH. Use one for calling HTTP APIs, working on text, JSON or CSV, and " +
	"short scripts that need only what's built in, such as reading issues or logs with a token, reshaping an export, " +
	"or checking many items in forks. Use a microvm, a full Linux with root, Docker, a desktop and a browser, for " +
	"anything touching a codebase (clone, install, build, test, run), packages, a server or a long job. If unsure, " +
	"use a microvm. If an isolate's command needs a microVM (its answer says so, or 'command not " +
	"found' or 'not available in an isolate'), don't work around it: upgrade it with sandbox_upgrade, which keeps its " +
	"id, files (in /home/user/workspace, with /workspace linked there), env and grants, and run the command again. " +
	"Create an isolate with autoUpgrade to have that done for you.";

/** What `initialize` tells the agent about using the tools. */
export const INSTRUCTIONS =
	"Kantel gives you sandboxes: machines of your own to run code in, away from the user's computer. Create one with " +
	"sandbox_create and keep its id. " +
	CHOOSING_A_TYPE +
	" Run commands in it with sandbox_exec, and move files with " +
	"file_write, file_read and file_list. port_expose gives a server in it a URL; snapshot_save keeps its state to " +
	"start new sandboxes from. Stop it with sandbox_stop when you are done: a stopped sandbox keeps its disk and costs " +
	"nothing to run, and sandbox_resume brings it back. If a command may take longer than your MCP client waits " +
	"for a call, run sandbox_exec with detached, then wait for it with command_get; it runs with no time limit unless you " +
	"give it a timeoutMs (a host whose kantel-host predates exec-control still ends it after about 2 minutes on a microVM).";

/** How often a tool call that waits tells the client it is still working. */
export const PROGRESS_INTERVAL_MS = 15_000;

/** The longest any one tool call waits: an exec's longest timeout, or command_get's longest waitMs. */
export const MAX_WAIT_MS = 600_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** About 64 KiB of a command's stdout or stderr reaches the agent; the middle of a longer one is cut. */
const OUTPUT_LIMIT = 64 * 1024;
const OUTPUT_HEAD = 16 * 1024;

interface PropertySchema {
	readonly type: "string" | "integer" | "boolean" | "object";
	readonly description: string;
	readonly enum?: readonly string[];
	readonly minimum?: number;
	readonly maximum?: number;
	readonly additionalProperties?: { readonly type: "string" };
}

/** A tool's arguments, as a JSON Schema. */
export interface InputSchema {
	readonly type: "object";
	readonly properties: { readonly [name: string]: PropertySchema };
	readonly required?: readonly string[];
	readonly additionalProperties: false;
}

export interface ToolAnnotations {
	readonly title: string;
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

/** What `tools/call` answers. */
export interface ToolResult {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly structuredContent?: object;
	readonly isError?: boolean;
}

type Args = { readonly [name: string]: unknown };

interface ToolContext {
	readonly client: KantelClient;
	readonly account: string | undefined;
	/** Aborted when the client cancels the call: stops the wait, not what was started in the sandbox. */
	readonly signal: AbortSignal;
	/** The longest command_get waits between polls. */
	readonly pollIntervalMs: number;
}

interface Tool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: InputSchema;
	readonly annotations: ToolAnnotations;
	readonly call: (args: Args, context: ToolContext) => Promise<ToolResult>;
}

export interface McpServer {
	/**
	 * Answers one parsed JSON-RPC message (or a batch); undefined when it gets no reply, as a notification or a
	 * cancelled request doesn't. `notify` sends the client a notification while a request works, such as its progress.
	 */
	handle(message: unknown, notify?: (notification: object) => void): Promise<object | undefined>;
}

export interface McpServerOptions {
	readonly client: KantelClient;
	/** The CLI's version, for `serverInfo`. */
	readonly version: string;
	/** The account new sandboxes and lists are in; default the caller's. */
	readonly account?: string;
	/** Where a failure the server didn't expect is logged; default nowhere. */
	readonly log?: (line: string) => void;
	/** How often a call with a progress token reports progress; default 15 s. */
	readonly progressIntervalMs?: number;
	/** The longest command_get waits between polls for a command's end; default 2 s. */
	readonly pollIntervalMs?: number;
}

// Schemas.

const SANDBOX_TYPES = ["isolate", "microvm"] as const;
const SIZES = ["small", "default", "large", "xlarge"] as const;
const ENCODINGS = ["utf8", "base64"] as const;

const sandboxId: PropertySchema = { type: "string", description: "The sandbox's ID, such as sbx_4kq9x2mt." };
const strings = (description: string): PropertySchema => ({
	type: "object",
	description,
	additionalProperties: { type: "string" },
});

function schema(
	properties: { readonly [name: string]: PropertySchema },
	required: readonly string[] = [],
): InputSchema {
	return { type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

// Reading validated arguments.

function text(args: Args, name: string): string {
	const value = args[name];
	if (typeof value !== "string") throw new ArgumentError(`${name} is required`);
	return value;
}

function optionalText(args: Args, name: string): string | undefined {
	const value = args[name];
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(args: Args, name: string): number | undefined {
	const value = args[name];
	return typeof value === "number" ? value : undefined;
}

function optionalBoolean(args: Args, name: string): boolean | undefined {
	const value = args[name];
	return typeof value === "boolean" ? value : undefined;
}

function optionalChoice<T extends string>(args: Args, name: string, allowed: readonly T[]): T | undefined {
	const value = args[name];
	return allowed.find((item) => item === value);
}

function optionalStrings(args: Args, name: string): { [key: string]: string } | undefined {
	const value = args[name];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record: { [key: string]: string } = {};
	for (const [key, item] of Object.entries(value)) if (typeof item === "string") record[key] = item;
	return record;
}

class ArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgumentError";
	}
}

function check(name: string, property: PropertySchema, value: unknown): string | undefined {
	switch (property.type) {
		case "string":
			if (typeof value !== "string") return `${name} must be a string`;
			if (property.enum !== undefined && !property.enum.includes(value)) {
				return `${name} must be one of ${property.enum.join(", ")}`;
			}
			return undefined;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) return `${name} must be a whole number`;
			if (property.minimum !== undefined && value < property.minimum)
				return `${name} must be at least ${property.minimum}`;
			if (property.maximum !== undefined && value > property.maximum)
				return `${name} must be at most ${property.maximum}`;
			return undefined;
		case "boolean":
			return typeof value === "boolean" ? undefined : `${name} must be true or false`;
		case "object":
			if (typeof value !== "object" || value === null || Array.isArray(value)) return `${name} must be an object`;
			if (property.additionalProperties !== undefined) {
				for (const [key, item] of Object.entries(value)) {
					if (typeof item !== "string") return `${name}.${key} must be a string`;
				}
			}
			return undefined;
	}
}

/** Why `args` don't fit `inputSchema`, or undefined when they do. */
export function validateArguments(inputSchema: InputSchema, args: Args): string | undefined {
	for (const name of inputSchema.required ?? []) {
		if (args[name] === undefined || args[name] === null) return `${name} is required`;
	}
	for (const [name, value] of Object.entries(args)) {
		const property = inputSchema.properties[name];
		if (property === undefined) return `there is no argument ${name}`;
		if (value === undefined || value === null) continue;
		const problem = check(name, property, value);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

// Results.

function json(value: object, lead?: string): ToolResult {
	const body = JSON.stringify(value);
	return {
		content: [{ type: "text", text: lead === undefined ? body : `${lead}\n${body}` }],
		structuredContent: value,
	};
}

/**
 * A sandbox's state for a tool's answer: `running`, or for one in `error`, why, with what to do when its boot couldn't
 * place it (its `placementReason`).
 */
function stateLine(sandbox: {
	readonly state: string;
	readonly reason?: string;
	readonly placementReason?: string;
}): string {
	if (sandbox.state !== "error") return sandbox.state;
	const why = sandbox.placementReason === undefined ? "" : ` (${sandbox.placementReason})`;
	const reason = sandbox.reason === undefined ? "" : `: ${sandbox.reason}`;
	const hint = sandbox.placementReason === undefined ? undefined : PLACEMENT_HINTS[sandbox.placementReason];
	return `error${why}${reason}${hint === undefined ? "" : `\n${hint}`}`;
}

function errorResult(message: string, structured?: object): ToolResult {
	return {
		content: [{ type: "text", text: message }],
		...(structured === undefined ? {} : { structuredContent: structured }),
		isError: true,
	};
}

/** `output`, its middle cut to keep it near 64 KiB, with a note saying so. */
export function clipOutput(output: string): string {
	if (output.length <= OUTPUT_LIMIT) return output;
	const tail = OUTPUT_LIMIT - OUTPUT_HEAD;
	const cut = output.length - OUTPUT_LIMIT;
	return (
		`${output.slice(0, OUTPUT_HEAD)}\n[kantel: ${cut} characters cut here; redirect the output to a file and read ` +
		`it with file_read for all of it]\n${output.slice(-tail)}`
	);
}

/** How to pick up a command still running when the answer goes back. */
const pickUp = (command: Command): string =>
	`Wait for it and read its output with command_get (sandboxId ${command.sandboxId}, commandId ${command.id}, ` +
	`waitMs up to ${MAX_WAIT_MS}), or end it with command_kill.`;

/** A command as a tool answers it: its state, exit code and output, cut to about 64 KiB each. */
export function commandResult(command: Command): ToolResult {
	const stdout = clipOutput(command.stdout);
	const stderr = clipOutput(command.stderr);
	const lines: string[] = [];
	switch (command.state) {
		case "running":
			lines.push(`The command ${command.id} is still running. ${pickUp(command)}`);
			break;
		case "timed_out":
			lines.push(`The command timed out and was killed. Give it a longer timeoutMs, up to ${MAX_WAIT_MS}.`);
			break;
		case "killed":
			lines.push(
				command.stderr.includes("may still be running")
					? "The command is marked killed, but its host couldn't stop it (its stderr says why): to be sure, end it " +
							"with sandbox_exec, such as pkill -f."
					: "The command was killed, and the processes it started with it.",
			);
			break;
		default:
			lines.push(`The command exited with code ${command.exitCode ?? "unknown"}.`);
	}
	if (command.rerunOf !== undefined) {
		lines.push(
			`Its isolate needed a microVM for it (${command.rerunOf} said so): Kantel upgraded ${command.sandboxId} to a ` +
				"microVM, its files in /home/user/workspace (/workspace links there), and this is the command run again there.",
		);
	}
	if (command.rerunAs !== undefined) {
		lines.push(
			`It needed a microVM: Kantel upgraded ${command.sandboxId} and runs it again there as ${command.rerunAs}. ` +
				`Read that one with command_get (sandboxId ${command.sandboxId}, commandId ${command.rerunAs}).`,
		);
	} else if (command.needsMicrovm !== undefined) {
		lines.push(
			`${command.needsMicrovm.inferred === true ? "It looks like it needs a microVM (read from its output)" : "It needs a microVM"}: ${command.needsMicrovm.reason} Call sandbox_upgrade with sandboxId ${command.sandboxId} ` +
				"(it keeps the id, files, env and grants), then run it again.",
		);
	}
	if (command.terminated !== undefined) {
		lines.push(`The isolate stopped it for using too much ${command.terminated} time.`);
	}
	if (command.truncated) lines.push("Kantel kept only its first 1 MiB of output.");
	if (command.state !== "running" || stdout !== "" || stderr !== "") {
		lines.push("stdout:", stdout === "" ? "(empty)" : stdout);
		if (stderr !== "") lines.push("stderr:", stderr);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		structuredContent: {
			commandId: command.id,
			state: command.state,
			exitCode: command.exitCode ?? null,
			stdout,
			stderr,
			truncated: command.truncated || stdout !== command.stdout || stderr !== command.stderr,
			durationMs: command.durationMs ?? null,
			...(command.needsMicrovm === undefined ? {} : { needsMicrovm: command.needsMicrovm }),
			...(command.terminated === undefined ? {} : { terminated: command.terminated }),
			...(command.rerunAs === undefined ? {} : { rerunAs: command.rerunAs }),
			...(command.rerunOf === undefined ? {} : { rerunOf: command.rerunOf }),
		},
	};
}

const commandId: PropertySchema = { type: "string", description: "The command's ID, such as cmd_9a8b7c." };

const HINTS: { readonly [code: string]: string } = {
	unauthenticated:
		"Kantel needs an API key: set KANTEL_API_KEY in this MCP server's environment (make one with kantel key create " +
		"agent --preset agent).",
	forbidden: "The API key lacks the scope this needs.",
	conflict: "If the sandbox is stopped or paused, resume it with sandbox_resume first.",
};

/**
 * What to do about a 409 over an Idempotency-Key, by its `details.idempotencyKey`. Each tool call sends a new key, so
 * calling the tool again never meets the same key: these say whether that is safe.
 */
const IDEMPOTENCY_HINTS: { readonly [state: string]: string } = {
	in_progress: "The same call is still running: check its result (command_list for a command) before calling again.",
	held:
		"The first call didn't finish, so it may have taken effect: check (command_list, sandbox_list) before calling the " +
		"tool again.",
	withheld: "The call was done, but its secret isn't kept for a retry: look the record up instead.",
};

/** What to do about a sandbox that can't be placed, by its `reason`. */
const PLACEMENT_HINTS: { readonly [reason: string]: string } = {
	no_host: "No host is connected to run it. Try again once one is, or tell the user.",
	no_host_for_type: "No host runs this type. Try the other type (isolate or microvm), or tell the user.",
	no_host_with_labels: "No host has those host labels. Ask for others, or none.",
	no_host_offers_size: "No host offers that size or resources. Ask for a smaller size or other resources.",
	no_host_enforces_egress: "No host that could take it enforces egress grants. Tell the user to upgrade kantel-host.",
	no_host_for_template: "No host runs this template. Create the sandbox without it, or tell the user.",
	insufficient_capacity: "The hosts are full now. Try again in a minute, or ask for a smaller size.",
	host_unavailable:
		"The host this sandbox is on, or was asked to go on, can't take it now. Try again later, or create a new sandbox.",
	account_limit: "The account runs as many sandboxes as it may. Stop or delete one first.",
};

// Tools.

const TOOLS: readonly Tool[] = [
	{
		name: "sandbox_create",
		description:
			`Create a sandbox and wait until it runs; answers it, with its id. ${CHOOSING_A_TYPE} ` +
			"Stop it with sandbox_stop when you are done.",
		inputSchema: schema({
			type: {
				type: "string",
				enum: SANDBOX_TYPES,
				description: "isolate or microvm. Needed unless from names a snapshot, whose type it takes.",
			},
			size: { type: "string", enum: SIZES, description: "A microVM's size; default the deployment's." },
			name: { type: "string", description: "Default: a generated name." },
			from: { type: "string", description: "Start from this snapshot: its ID, or a saved snapshot's name." },
			image: { type: "string", description: "A microVM's base image; default the deployment's." },
			autoStopMinutes: {
				type: "integer",
				minimum: 1,
				description: "Stop by itself this many minutes after starting; default 60.",
			},
			idleStopMinutes: {
				type: "integer",
				minimum: 1,
				description:
					"Also stop by itself once it has gone this many minutes without use: no command, SSH, desktop, browser or " +
					"hosted-port traffic. Default: no idle stop.",
			},
			labels: strings("Labels to find it by, such as { task: 'PROJ-12' }."),
			env: strings("Environment variables every command sees. Not for secrets: anyone who may exec sees them."),
			host: {
				type: "string",
				description: "Run it on this host, its name or ID. Only when the user asks for a host; default: Kantel picks.",
			},
			autoUpgrade: {
				type: "boolean",
				description:
					"For an isolate: when a command needs a microVM, Kantel upgrades it (as sandbox_upgrade does) and runs the " +
					"command again there, once, answering that run. Use it when a task may turn out to need more than a shell.",
			},
		}),
		annotations: { title: "Create a sandbox", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		async call(args, { client, account, signal }) {
			// The API makes an isolate when no type is given, which an agent that left it out rarely wants: it has to choose.
			const type = optionalChoice(args, "type", SANDBOX_TYPES);
			const from = optionalText(args, "from");
			if (type === undefined && from === undefined) {
				throw new ArgumentError(
					"type is required: microvm for anything touching code, a runtime or a server; isolate only for HTTP calls " +
						"and text or JSON work.",
				);
			}
			const sandbox = await client.createSandbox(
				{
					account,
					type,
					size: optionalChoice(args, "size", SIZES),
					name: optionalText(args, "name"),
					from,
					image: optionalText(args, "image"),
					autoStopMinutes: optionalNumber(args, "autoStopMinutes"),
					idleStopMinutes: optionalNumber(args, "idleStopMinutes"),
					labels: optionalStrings(args, "labels"),
					env: optionalStrings(args, "env"),
					host: optionalText(args, "host"),
					...(optionalBoolean(args, "autoUpgrade") === true ? { autoUpgrade: true } : {}),
					wait: true,
				},
				{ signal },
			);
			return json(sandbox, `Sandbox ${sandbox.id} (${sandbox.name}) is ${stateLine(sandbox)}.`);
		},
	},
	{
		name: "sandbox_list",
		description: "List the account's sandboxes, newest first: running ones, or all of them with all.",
		inputSchema: schema({
			all: { type: "boolean", description: "Include stopped, paused and errored ones." },
			mine: { type: "boolean", description: "Only the key's person's own, not ones others share in an organisation." },
		}),
		annotations: { title: "List sandboxes", readOnlyHint: true },
		async call(args, { client, account, signal }) {
			const page = await client.listSandboxes(
				{ account, all: optionalBoolean(args, "all"), mine: optionalBoolean(args, "mine") },
				{ signal },
			);
			return json(page);
		},
	},
	{
		name: "sandbox_get",
		description: "Get a sandbox: its state, type, what it can do, when it stops by itself and what it has cost.",
		inputSchema: schema({ sandboxId }, ["sandboxId"]),
		annotations: { title: "Get a sandbox", readOnlyHint: true },
		async call(args, { client, signal }) {
			const sandbox = await client.getSandbox(text(args, "sandboxId"), { signal });
			return json(sandbox, `Sandbox ${sandbox.id} is ${stateLine(sandbox)}.`);
		},
	},
	{
		name: "sandbox_stop",
		description:
			"Stop a sandbox: its disk is kept as a snapshot and running programs end. It then costs nothing to run; " +
			"sandbox_resume brings it back. With pause, a microVM keeps its memory too. With wait, answers once it has " +
			"stopped and its snapshot is saved.",
		inputSchema: schema(
			{
				sandboxId,
				pause: { type: "boolean", description: "Keep its memory as well (microVMs only)." },
				wait: { type: "boolean", description: "Answer once it is stopped or paused, not while it is stopping." },
			},
			["sandboxId"],
		),
		annotations: { title: "Stop a sandbox", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async call(args, { client, signal }) {
			const sandbox = await client.stopSandbox(
				text(args, "sandboxId"),
				{
					keepMemory: optionalBoolean(args, "pause") === true ? true : undefined,
					wait: optionalBoolean(args, "wait") === true ? true : undefined,
				},
				{ signal },
			);
			return json(sandbox, `Sandbox ${sandbox.id} is ${stateLine(sandbox)}.`);
		},
	},
	{
		name: "sandbox_resume",
		description: "Resume a stopped or paused sandbox and wait until it runs. Same id; files are as they were.",
		inputSchema: schema({ sandboxId }, ["sandboxId"]),
		annotations: { title: "Resume a sandbox", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async call(args, { client, signal }) {
			const sandbox = await client.resumeSandbox(text(args, "sandboxId"), { wait: true }, { signal });
			return json(sandbox, `Sandbox ${sandbox.id} is ${stateLine(sandbox)}.`);
		},
	},
	{
		name: "sandbox_upgrade",
		description:
			"Turn an isolate into a microVM and wait until it runs: the same id, name, labels, env, environments, grants " +
			"and protected variables, and its /workspace files in /home/user/workspace, with /workspace a link there, so " +
			"its paths still work. Use it when an isolate's command needs a microVM (git, node, python, a package " +
			"manager, a build, Docker), then run the command again; a stopped isolate comes back running. A microVM " +
			"costs more than an isolate from then on. If the microVM can't be made, the isolate is left as it was.",
		inputSchema: schema(
			{
				sandboxId,
				size: { type: "string", enum: SIZES, description: "The microVM's size; default the deployment's." },
				image: { type: "string", description: "The microVM's base image; default the deployment's." },
			},
			["sandboxId"],
		),
		annotations: {
			title: "Upgrade an isolate to a microVM",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		},
		async call(args, { client, signal }) {
			const sandbox = await client.upgradeSandbox(
				text(args, "sandboxId"),
				{ size: optionalChoice(args, "size", SIZES), image: optionalText(args, "image"), wait: true },
				{ signal, idempotencyKey: crypto.randomUUID() },
			);
			return json(
				sandbox,
				`Sandbox ${sandbox.id} is a ${sandbox.type} now, ${stateLine(sandbox)}. Its files are in /home/user/workspace ` +
					"(/workspace links there): run the command again.",
			);
		},
	},
	{
		name: "sandbox_fork",
		description: "Make copies of a sandbox from its newest snapshot and wait until they run. The source is unchanged.",
		inputSchema: schema(
			{
				sandboxId,
				count: { type: "integer", minimum: 1, maximum: 50, description: "How many copies; default 1." },
				name: { type: "string", description: "The copies' name; default generated." },
			},
			["sandboxId"],
		),
		annotations: { title: "Fork a sandbox", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		async call(args, { client, signal }) {
			const forked = await client.forkSandbox(
				text(args, "sandboxId"),
				{ count: optionalNumber(args, "count"), name: optionalText(args, "name"), wait: true },
				{ signal },
			);
			return json(forked, `Made ${forked.items.map((sandbox) => sandbox.id).join(", ")}.`);
		},
	},
	{
		name: "sandbox_delete",
		description:
			"Delete a sandbox for good, with its automatic snapshots; saved snapshots of it stay. It can't be undone: " +
			"to stop paying for a sandbox you may want again, use sandbox_stop.",
		inputSchema: schema({ sandboxId }, ["sandboxId"]),
		annotations: { title: "Delete a sandbox", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		async call(args, { client, signal }) {
			const sandbox = await client.deleteSandbox(text(args, "sandboxId"), { signal });
			return json(sandbox, `Sandbox ${sandbox.id} is being deleted.`);
		},
	},
	{
		name: "sandbox_exec",
		description:
			"Run a shell command line in a running sandbox (bash -lc on a microVM) and wait for it to end; answers its " +
			"exit code, stdout and stderr, each cut to about 64 KiB. Default timeout 30 s, at most 10 minutes: past it the " +
			"command is killed. With detached it starts and answers its commandId at once, for when your MCP client " +
			"gives up on a call sooner than the command takes; then wait for it with command_get. A detached command has " +
			"no time limit unless you give it a timeoutMs; a host whose kantel-host predates exec-control still ends it after " +
			"about 2 minutes on a microVM, and an isolate runs a command for at most 30 s unless its timeoutMs says otherwise.",
		inputSchema: schema(
			{
				sandboxId,
				command: { type: "string", description: "A shell command line, such as 'npm test 2>&1 | tail -50'." },
				cwd: { type: "string", description: "The directory to run it in; default the sandbox user's home." },
				timeoutMs: {
					type: "integer",
					minimum: 1,
					maximum: MAX_WAIT_MS,
					description: "Kill it after this many milliseconds; default 30000, and none for a detached command.",
				},
				detached: {
					type: "boolean",
					description:
						"Start it and answer its commandId at once; it runs until it ends, its timeoutMs, or command_kill.",
				},
				env: strings("Environment variables for this command."),
			},
			["sandboxId", "command"],
		),
		annotations: { title: "Run a command", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async call(args, { client, signal }) {
			const detached = optionalBoolean(args, "detached") === true;
			// One key per tool call, whatever client this is given: a retry of the request runs the command once.
			const command = await client.runCommand(
				text(args, "sandboxId"),
				{
					command: text(args, "command"),
					cwd: optionalText(args, "cwd"),
					timeoutMs: optionalNumber(args, "timeoutMs"),
					env: optionalStrings(args, "env"),
					...(detached ? { detached: true } : {}),
				},
				{ signal, idempotencyKey: crypto.randomUUID() },
			);
			if (!detached || command.state !== "running") return commandResult(command);
			return json({ commandId: command.id, state: command.state }, `Started ${command.id}. ${pickUp(command)}`);
		},
	},
	{
		name: "command_get",
		description:
			"A command's state, exit code and output so far, each cut to about 64 KiB. With waitMs, waits up to that long " +
			"for it to end first; if it is still running then, call command_get again.",
		inputSchema: schema(
			{
				sandboxId,
				commandId,
				waitMs: {
					type: "integer",
					minimum: 0,
					maximum: MAX_WAIT_MS,
					description: "Wait up to this many milliseconds for it to end; default 0, at most 600000.",
				},
			},
			["sandboxId", "commandId"],
		),
		annotations: { title: "Get a command", readOnlyHint: true },
		async call(args, { client, signal, pollIntervalMs }) {
			const sandbox = text(args, "sandboxId");
			const id = text(args, "commandId");
			const deadline = Date.now() + (optionalNumber(args, "waitMs") ?? 0);
			let command = await client.getCommand(sandbox, id, { signal });
			let pause = Math.min(250, pollIntervalMs);
			while (command.state === "running" && Date.now() < deadline) {
				await delay(Math.max(0, Math.min(pause, deadline - Date.now())), undefined, { signal });
				pause = Math.min(pause * 2, pollIntervalMs);
				command = await client.getCommand(sandbox, id, { signal });
			}
			return commandResult(command);
		},
	},
	{
		name: "command_list",
		description:
			"A sandbox's commands, newest first, with their state and exit code but not their output (command_get has " +
			"it). Finds a command whose call your MCP client gave up on. When there are more, nextCursor is set: pass it " +
			"as cursor for the next, older page.",
		inputSchema: schema(
			{
				sandboxId,
				limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many; default 20." },
				cursor: { type: "string", description: "A previous answer's nextCursor, for the page after it." },
			},
			["sandboxId"],
		),
		annotations: { title: "List commands", readOnlyHint: true },
		async call(args, { client, signal }) {
			const page = await client.listCommands(
				text(args, "sandboxId"),
				{ limit: optionalNumber(args, "limit") ?? 20, cursor: optionalText(args, "cursor") },
				{ signal },
			);
			const items = page.items.map((command) => ({
				commandId: command.id,
				command: command.command,
				state: command.state,
				exitCode: command.exitCode ?? null,
				startedAt: command.startedAt,
				durationMs: command.durationMs ?? null,
			}));
			if (page.nextCursor === undefined) return json({ items });
			return json(
				{ items, nextCursor: page.nextCursor },
				`There are older commands: call command_list again with cursor ${page.nextCursor} for them.`,
			);
		},
	},
	{
		name: "command_kill",
		description:
			"Kill a running command and the processes it started. One that has ended is answered as it is. On a host " +
			"whose kantel-host predates exec-control it is only marked killed and its stderr says so: end it with " +
			"sandbox_exec too, such as pkill -f.",
		inputSchema: schema({ sandboxId, commandId }, ["sandboxId", "commandId"]),
		annotations: { title: "Kill a command", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async call(args, { client, signal }) {
			return commandResult(await client.killCommand(text(args, "sandboxId"), text(args, "commandId"), { signal }));
		},
	},
	{
		name: "file_read",
		description: "Read a file of up to 1 MiB from a sandbox, as UTF-8 text, or base64 for a binary file.",
		inputSchema: schema(
			{
				sandboxId,
				path: { type: "string", description: "An absolute path, or one relative to the sandbox user's home." },
				encoding: { type: "string", enum: ENCODINGS, description: "utf8 (default) or base64." },
			},
			["sandboxId", "path"],
		),
		annotations: { title: "Read a file", readOnlyHint: true },
		async call(args, { client, signal }) {
			const file = await client.readFile(
				text(args, "sandboxId"),
				{
					path: text(args, "path"),
					encoding: optionalChoice(args, "encoding", ENCODINGS),
				},
				{ signal },
			);
			return { content: [{ type: "text", text: file.content }], structuredContent: file };
		},
	},
	{
		name: "file_write",
		description: "Write a file in a sandbox, making its directories and replacing what was there.",
		inputSchema: schema(
			{
				sandboxId,
				path: { type: "string", description: "An absolute path, or one relative to the sandbox user's home." },
				content: { type: "string", description: "The file's content: text, or base64 with encoding base64." },
				encoding: { type: "string", enum: ENCODINGS, description: "utf8 (default) or base64." },
				mode: { type: "string", description: "Octal permissions, such as 0755." },
			},
			["sandboxId", "path", "content"],
		),
		annotations: { title: "Write a file", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		async call(args, { client, signal }) {
			const entry = await client.writeFile(
				text(args, "sandboxId"),
				{
					path: text(args, "path"),
					content: text(args, "content"),
					encoding: optionalChoice(args, "encoding", ENCODINGS),
					mode: optionalText(args, "mode"),
				},
				{ signal },
			);
			return json(entry, `Wrote ${entry.path} (${entry.size} bytes).`);
		},
	},
	{
		name: "file_list",
		description: "List a directory in a sandbox: each entry's name, kind and size.",
		inputSchema: schema(
			{ sandboxId, path: { type: "string", description: "The directory; default the sandbox user's home." } },
			["sandboxId"],
		),
		annotations: { title: "List a directory", readOnlyHint: true },
		async call(args, { client, signal }) {
			return json(await client.listFiles(text(args, "sandboxId"), { path: optionalText(args, "path") }, { signal }));
		},
	},
	{
		name: "port_expose",
		description:
			"Give a port in a sandbox an HTTPS URL, for a web server running in it (listening on 0.0.0.0 or localhost). " +
			"Unless public, the URL carries a token: share it only with whoever should open it.",
		inputSchema: schema(
			{
				sandboxId,
				port: { type: "integer", minimum: 1, maximum: 65_535, description: "The port the server listens on." },
				public: { type: "boolean", description: "Anyone with the URL may open it, with no token. Default false." },
			},
			["sandboxId", "port"],
		),
		annotations: { title: "Expose a port", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async call(args, { client, signal }) {
			const port = optionalNumber(args, "port") ?? 0;
			const exposed = await client.exposePort(
				text(args, "sandboxId"),
				{
					port,
					public: optionalBoolean(args, "public"),
				},
				{ signal },
			);
			return json(exposed, `Port ${exposed.port} is at ${exposed.url}`);
		},
	},
	{
		name: "snapshot_save",
		description:
			"Save a sandbox's state now under a name, kept until deleted. New sandboxes start from it with " +
			"sandbox_create's from.",
		inputSchema: schema(
			{
				sandboxId,
				name: { type: "string", description: "Unique in the account." },
				description: { type: "string", description: "What it holds." },
				replace: { type: "boolean", description: "Replace a saved snapshot of the same name." },
				memory: {
					type: "boolean",
					description:
						"Keep a running microVM's memory as well as its disk, so a sandbox made from it carries on where it was, " +
						"on the same size only. Default false: the disk alone, much smaller.",
				},
			},
			["sandboxId", "name"],
		),
		annotations: { title: "Save a snapshot", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		async call(args, { client, signal }) {
			const snapshot = await client.saveSnapshot(
				{
					sandboxId: text(args, "sandboxId"),
					name: text(args, "name"),
					description: optionalText(args, "description"),
					replace: optionalBoolean(args, "replace"),
					memory: optionalBoolean(args, "memory"),
				},
				{ signal },
			);
			return json(snapshot, `Saved ${snapshot.name ?? snapshot.id} (${snapshot.id}).`);
		},
	},
	{
		name: "snapshot_list",
		description: "List snapshots, newest first: the account's saved ones, or one sandbox's history.",
		inputSchema: schema({
			sandboxId: { type: "string", description: "Only this sandbox's snapshots." },
			saved: { type: "boolean", description: "Only saved snapshots." },
		}),
		annotations: { title: "List snapshots", readOnlyHint: true },
		async call(args, { client, account, signal }) {
			const page = await client.listSnapshots(
				{
					account,
					sandboxId: optionalText(args, "sandboxId"),
					kind: optionalBoolean(args, "saved") === true ? "saved" : undefined,
				},
				{ signal },
			);
			return json(page);
		},
	},
	{
		name: "browser_open",
		description:
			"Start a microVM sandbox's Chromium; answers a URL a person can watch and drive it at, and a CDP URL for " +
			"Playwright's connectOverCDP or Puppeteer.",
		inputSchema: schema(
			{ sandboxId, viewOnly: { type: "boolean", description: "Watch only: no keyboard or mouse." } },
			["sandboxId"],
		),
		annotations: { title: "Open the browser", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async call(args, { client, signal }) {
			const access = await client.openBrowser(
				text(args, "sandboxId"),
				{ viewOnly: optionalBoolean(args, "viewOnly") },
				{ signal },
			);
			return json(access, `Live view: ${access.url}\nCDP: ${access.cdpUrl}`);
		},
	},
	{
		name: "desktop_open",
		description: "A short-lived URL that shows a microVM sandbox's Linux desktop in a browser, to watch or drive.",
		inputSchema: schema(
			{ sandboxId, viewOnly: { type: "boolean", description: "Watch only: no keyboard or mouse." } },
			["sandboxId"],
		),
		annotations: { title: "Open the desktop", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		async call(args, { client, signal }) {
			const access = await client.openDesktop(
				text(args, "sandboxId"),
				{ viewOnly: optionalBoolean(args, "viewOnly") },
				{ signal },
			);
			return json(access, `Desktop: ${access.url}`);
		},
	},
];

/** The tools as `tools/list` describes them. */
export const TOOL_DEFINITIONS = TOOLS.map((tool) => ({
	name: tool.name,
	title: tool.annotations.title,
	description: tool.description,
	inputSchema: tool.inputSchema,
	annotations: tool.annotations,
}));

// The server.

type JsonRpcId = string | number | null;

const idOf = (value: unknown): JsonRpcId => (typeof value === "string" || typeof value === "number" ? value : null);

const success = (id: JsonRpcId, result: object): object => ({ jsonrpc: "2.0", id, result });

const failure = (id: JsonRpcId, code: number, message: string): object => ({
	jsonrpc: "2.0",
	id,
	error: { code, message },
});

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** An MCP server over `client`; feed it messages with `handle`, or serve it on stdio with `serveStdio`. */
export function createMcpServer(options: McpServerOptions): McpServer {
	const tools = new Map(TOOLS.map((tool) => [tool.name, tool]));
	const log = options.log ?? (() => undefined);
	const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
	const pollIntervalMs = options.pollIntervalMs ?? 2000;
	/** The tool calls under way, by request ID, to abort on `notifications/cancelled`. */
	const calls = new Map<string | number, AbortController>();

	async function callTool(
		id: JsonRpcId,
		params: { readonly [key: string]: unknown },
		notify: ((notification: object) => void) | undefined,
	): Promise<object | undefined> {
		const name = params.name;
		if (typeof name !== "string") return failure(id, INVALID_PARAMS, "Invalid params: name is required");
		const tool = tools.get(name);
		if (tool === undefined) return failure(id, INVALID_PARAMS, `Unknown tool: ${name}`);
		const raw = params.arguments ?? {};
		if (!isRecord(raw)) return success(id, errorResult("Invalid arguments: arguments must be an object"));
		const problem = validateArguments(tool.inputSchema, raw);
		if (problem !== undefined) return success(id, errorResult(`Invalid arguments: ${problem}`));
		const controller = new AbortController();
		if (id !== null) calls.set(id, controller);
		const meta = isRecord(params._meta) ? params._meta : {};
		const token = meta.progressToken;
		const started = Date.now();
		let ticks = 0;
		const ticker =
			notify !== undefined && (typeof token === "string" || typeof token === "number")
				? setInterval(() => {
						// MCP's progress must go up with every notification, so it counts them; the time is in the message.
						ticks += 1;
						const seconds = Math.round((Date.now() - started) / 1000);
						notify({
							jsonrpc: "2.0",
							method: "notifications/progress",
							params: { progressToken: token, progress: ticks, message: `${name}: still working after ${seconds} s` },
						});
					}, progressIntervalMs)
				: undefined;
		const context: ToolContext = {
			client: options.client,
			account: options.account,
			signal: controller.signal,
			pollIntervalMs,
		};
		// A cancellation ends the call at once, whatever its tool is waiting on: no more progress, and no answer.
		const cancelled = new Promise<undefined>((resolve) => {
			controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		const running = tool.call(raw, context);
		running.catch(() => undefined);
		try {
			const result = await Promise.race([running, cancelled]);
			return result === undefined || controller.signal.aborted ? undefined : success(id, result);
		} catch (error) {
			if (controller.signal.aborted) return undefined;
			if (error instanceof KantelApiError) {
				const reason = error.reason;
				// A sandbox that isn't running: its stable code, state and why, so the agent can resume it or call again.
				const notRunning = notRunningOf(error);
				const held = error.details?.idempotencyKey;
				const hint =
					notRunning?.code === "sandbox_starting"
						? "The sandbox is still starting: call the tool again in a moment."
						: typeof held === "string"
							? IDEMPOTENCY_HINTS[held]
							: ((reason === undefined ? undefined : PLACEMENT_HINTS[reason]) ?? HINTS[error.code]);
				const message = `${error.code}${reason === undefined ? "" : ` (${reason})`}: ${error.message}${hint === undefined ? "" : `\n${hint}`}`;
				return success(
					id,
					errorResult(message, {
						error: {
							code: error.code,
							message: error.message,
							...(reason === undefined ? {} : { reason }),
							...(notRunning === undefined ? {} : { details: notRunning }),
						},
					}),
				);
			}
			if (error instanceof ArgumentError) return success(id, errorResult(`Invalid arguments: ${error.message}`));
			const message = error instanceof Error ? error.message : String(error);
			log(`kantel mcp: ${name} failed: ${message}`);
			return success(id, errorResult(message));
		} finally {
			clearInterval(ticker);
			if (id !== null && calls.get(id) === controller) calls.delete(id);
		}
	}

	async function one(message: unknown, notify?: (notification: object) => void): Promise<object | undefined> {
		if (!isRecord(message)) return failure(null, INVALID_REQUEST, "Invalid request");
		const method = message.method;
		if (typeof method !== "string") {
			// A response from the client (this server sends no requests) gets no reply.
			if ("result" in message || "error" in message) return undefined;
			return failure(idOf(message.id), INVALID_REQUEST, "Invalid request: no method");
		}
		// A notification: no id, or one of MCP's. Only a cancellation needs anything from this server: the wait it names
		// stops, and its answer isn't sent.
		if (!("id" in message) || method.startsWith("notifications/")) {
			if (method === "notifications/cancelled" && isRecord(message.params)) {
				const requestId = message.params.requestId;
				if (typeof requestId === "string" || typeof requestId === "number") calls.get(requestId)?.abort();
			}
			return undefined;
		}
		const id = idOf(message.id);
		if (message.jsonrpc !== "2.0") return failure(id, INVALID_REQUEST, 'Invalid request: jsonrpc must be "2.0"');
		const params = isRecord(message.params) ? message.params : {};
		try {
			switch (method) {
				case "initialize": {
					const requested = params.protocolVersion;
					return success(id, {
						protocolVersion: PROTOCOL_VERSIONS.find((version) => version === requested) ?? LATEST_PROTOCOL,
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "kantel", version: options.version },
						instructions: INSTRUCTIONS,
					});
				}
				case "ping":
					return success(id, {});
				case "tools/list":
					return success(id, { tools: TOOL_DEFINITIONS });
				case "tools/call":
					return await callTool(id, params, notify);
				default:
					return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
			}
		} catch (error) {
			log(`kantel mcp: ${method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			return failure(id, INTERNAL_ERROR, "Internal error");
		}
	}

	return {
		async handle(message, notify) {
			if (!Array.isArray(message)) return one(message, notify);
			if (message.length === 0) return failure(null, INVALID_REQUEST, "Invalid request: an empty batch");
			const answers = (await Promise.all(message.map((item: unknown) => one(item, notify)))).filter(
				(answer): answer is object => answer !== undefined,
			);
			return answers.length === 0 ? undefined : answers;
		},
	};
}

export interface StdioOptions {
	readonly stdin: AsyncIterable<string | Uint8Array>;
	readonly stdout: { write(chunk: string): unknown };
	/** For logs; default nowhere. */
	readonly stderr?: { write(chunk: string): unknown };
}

/**
 * Serves `server` on stdio: one JSON-RPC message a line in, one answer (or notification) a line out. Requests are
 * handled as they arrive, so a long command doesn't hold up a `ping` or its own cancellation. Resolves once stdin ends and every answer is written.
 */
export async function serveStdio(server: McpServer, io: StdioOptions): Promise<void> {
	const pending = new Set<Promise<void>>();
	const write = (answer: object): void => {
		io.stdout.write(`${JSON.stringify(answer)}\n`);
	};
	const dispatch = (line: string): void => {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let message: unknown;
		try {
			message = JSON.parse(trimmed);
		} catch {
			write(failure(null, PARSE_ERROR, "Parse error"));
			return;
		}
		const task: Promise<void> = server
			.handle(message, write)
			.then((answer) => {
				if (answer !== undefined) write(answer);
			})
			.catch((error: unknown) => {
				io.stderr?.write(`kantel mcp: ${error instanceof Error ? error.message : String(error)}\n`);
				write(failure(isRecord(message) ? idOf(message.id) : null, INTERNAL_ERROR, "Internal error"));
			})
			.finally(() => pending.delete(task));
		pending.add(task);
	};

	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of io.stdin) {
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
			dispatch(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
		}
	}
	dispatch(buffer + decoder.decode());
	await Promise.all(pending);
}
