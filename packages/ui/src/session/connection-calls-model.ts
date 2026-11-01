import type { ConnectionUse, ListedConnectionUse } from "@kantel/contracts";
import type { ToolItem } from "@kantel/protocol";
import { type Connection, type ConnectionsViewer, ownerText } from "../connections/connections-model.ts";
import {
	describeOperation,
	describeRequest,
	type RequestParts,
	requestParts,
	serviceOf,
} from "./connection-operations.ts";
import { type HarnessNote, splitHarness } from "./tool-views-model.ts";

// The connection tools' calls (`connection_request`, `connection_call`, @kantel/connections' tools.ts) and the scripts
// that make them (`codemode`), read for the transcript (connection-tools.tsx): which connection and request a call is,
// how it went, and what the host's records of it (`ConnectionUse`) say decided it.
//
// Interim: a call carries only its arguments and its text result today. Once it carries `details.connection` (#464),
// with its operation, decision and response, these read that instead; until then they derive what they can from the
// arguments and the text, and from the uses the host gives.

/** The connection tools whose calls are one request each, in one run per stretch of them. */
export const CONNECTION_TOOLS: readonly string[] = ["connection_request", "connection_call"];
/** Code mode's tool: a script that may make connection requests of its own (`tools.connection_request`). */
export const SCRIPT_TOOL = "codemode";

/** A connection the session's calls used, as the host knows it, for their rows and their opened view. */
export type ConnectionCallConnection = {
	readonly id: string;
	/** What a person calls it: "GitHub". */
	readonly name: string;
	readonly templateId?: string | undefined;
	/** Its logo: an https or data: URL. */
	readonly icon?: string | undefined;
	/** The account its credential acts as: "tvdavies". */
	readonly account?: string | undefined;
	/** Who owns it, in words: a project's ("Default project"), the organisation's name, a person's, or "You". */
	readonly owner?: string | undefined;
	/** A person's connection used here because its owner shared it with the session's project. */
	readonly shared?: boolean | undefined;
	/** Its page, where its rules are. Without it, nothing links there. */
	readonly href?: string | undefined;
};

/**
 * The Connections page's connections (`ConnectionsSource.connections`) as the session's calls name them: by the
 * template's name and logo, the account, and who owns each in the viewer's words. `href` is a connection's page.
 */
export function callConnectionsOf(
	connections: readonly Connection[],
	viewer: ConnectionsViewer,
	options: {
		people?: ((userId: string) => string | undefined) | undefined;
		href?: (connectionId: string) => string;
	} = {},
): ConnectionCallConnection[] {
	return connections.map((connection) => ({
		id: connection.id,
		name: connection.name,
		templateId: connection.templateId,
		icon: connection.icon,
		account: connection.account,
		owner: ownerText(connection.owner, viewer, options.people),
		shared: connection.owner.kind === "user" && connection.owner.userId !== viewer.userId,
		href: options.href?.(connection.id),
	}));
}

/**
 * What the host knows of a session's connection calls (`ConnectionCallsContext`): its connections by ID, and its uses
 * (`ConnectionUse`, `GET /v1/connections/uses?sessionId=`) by the call that made them. Make one with
 * `connectionCalls`.
 */
export type ConnectionCalls = {
	readonly connection: (connectionId: string | undefined) => ConnectionCallConnection | undefined;
	/** The use a call made, by its call ID: the newest, when it was held and then sent. */
	readonly useOf: (callId: string) => ConnectionUse | undefined;
	/** The requests a script made, by the script's call ID (`<callId>/c1` …), in the order it made them. */
	readonly scriptUses: (callId: string) => readonly ConnectionUse[];
};

const isUse = (use: ListedConnectionUse): use is ConnectionUse => !("redacted" in use && use.redacted === true);

/** The order of a script's request, from its use's step (`toolu_…/c9` is 9). */
const stepOf = (toolCallId: string): number => Number(/\/c(\d+)$/.exec(toolCallId)?.[1] ?? 0);

/** A session's connection calls as the host knows them: its connections and its uses, in any order. */
export function connectionCalls(
	connections: readonly ConnectionCallConnection[],
	uses: readonly ListedConnectionUse[],
): ConnectionCalls {
	const byId = new Map(connections.map((connection) => [connection.id, connection]));
	const byCall = new Map<string, ConnectionUse>();
	const byScript = new Map<string, ConnectionUse[]>();
	for (const use of uses) {
		if (!isUse(use) || use.toolCallId === undefined) continue;
		const known = byCall.get(use.toolCallId);
		if (known === undefined || known.at <= use.at) byCall.set(use.toolCallId, use);
		const script = /^(.+)\/c\d+$/.exec(use.toolCallId)?.[1];
		if (script !== undefined) byScript.set(script, [...(byScript.get(script) ?? []), use]);
	}
	for (const list of byScript.values()) list.sort((a, b) => stepOf(a.toolCallId ?? "") - stepOf(b.toolCallId ?? ""));
	return {
		connection: (connectionId) => (connectionId === undefined ? undefined : byId.get(connectionId)),
		useOf: (callId) => byCall.get(callId),
		scriptUses: (callId) => byScript.get(callId) ?? [],
	};
}

/** A call's arguments as an object: a model sometimes sends them as a JSON string. */
export function argsOf(item: Pick<ToolItem, "args">): Record<string, unknown> {
	let args = item.args;
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			return {};
		}
	}
	return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** What a connection call asked for, from its arguments. */
export type ConnectionCallRequest =
	| {
			readonly kind: "http";
			readonly connectionId?: string | undefined;
			readonly method: string;
			readonly url: string;
			/** Undefined when the URL isn't one. */
			readonly parts?: RequestParts | undefined;
			readonly headers: readonly (readonly [string, string])[];
			readonly body?: string | undefined;
	  }
	| {
			readonly kind: "mcp";
			readonly connectionId?: string | undefined;
			readonly tool: string;
			readonly arguments?: unknown;
	  };

/** What a `connection_request` or `connection_call` asked for. */
export function connectionRequestOf(item: Pick<ToolItem, "name" | "args">): ConnectionCallRequest {
	const args = argsOf(item);
	const connectionId = text(args.connectionId);
	if (item.name === "connection_call") {
		return { kind: "mcp", connectionId, tool: text(args.tool) ?? "", arguments: args.arguments };
	}
	const method = (text(args.method) ?? "GET").toUpperCase();
	const url = text(args.url) ?? "";
	const headers =
		typeof args.headers === "object" && args.headers !== null
			? Object.entries(args.headers as Record<string, unknown>).map(([name, value]) => [name, String(value)] as const)
			: [];
	return {
		kind: "http",
		connectionId,
		method,
		url,
		parts: requestParts({ method, url }),
		headers,
		body: text(args.body),
	};
}

/** How a connection call went, from its text result. */
export type ConnectionCallResult =
	/** It hasn't answered yet. */
	| { readonly kind: "waiting" }
	/** The service answered: `HTTP 200 (application/json)` and the body, clipped at `cut` more characters. */
	| {
			readonly kind: "response";
			readonly status: number;
			readonly contentType?: string | undefined;
			readonly body: string;
			readonly cut?: number | undefined;
			/** The harness's notes on what it kept of the result: "Output truncated…". */
			readonly notes: readonly HarnessNote[];
	  }
	/** An MCP tool's answer, as text. */
	| { readonly kind: "tool"; readonly text: string; readonly failed: boolean }
	/** Kantel sent nothing: a rule or the connection's usage refused it, no one approved it, or it couldn't send. */
	| { readonly kind: "refused"; readonly code: string; readonly message: string }
	/** The session stopped it before it answered. */
	| { readonly kind: "interrupted" };

const RESPONSE = /^HTTP (\d{3})(?: \(([^)\n]*)\))?\n?\n?([\s\S]*)$/;
const CUT = /\n\[cut: (\d+) more characters\]$/;
const FAILURE = /^([a-z][a-z_]*): ([\s\S]*)$/;

/** How a connection call went, from its status and text result (`HTTP <status> (<type>)\n\n<body>`, or `<code>: <message>`). */
export function connectionResultOf(item: Pick<ToolItem, "name" | "status" | "output">): ConnectionCallResult {
	const output = item.output ?? "";
	if (item.status === "interrupted") return { kind: "interrupted" };
	if (item.status === "running" && output === "") return { kind: "waiting" };
	const { body: kept, notes } = splitHarness(output);
	const response = RESPONSE.exec(kept);
	if (response !== null && item.name !== "connection_call") {
		const raw = response[3] ?? "";
		const cut = CUT.exec(raw);
		return {
			kind: "response",
			status: Number(response[1]),
			contentType: response[2],
			body: cut === null ? raw : raw.slice(0, cut.index),
			cut: cut === null ? undefined : Number(cut[1]),
			notes,
		};
	}
	if (item.status === "error") {
		const failure = FAILURE.exec(kept.trim());
		if (failure !== null) {
			const message = (failure[2] ?? "").trim();
			// A held request is refused as `refused: approval_pending: …`; the code is the approval's.
			const pending = /^approval_pending: ([\s\S]*)$/.exec(message);
			return pending === null
				? { kind: "refused", code: failure[1] ?? "", message }
				: { kind: "refused", code: "approval_pending", message: pending[1] ?? "" };
		}
		if (item.name !== "connection_call") return { kind: "refused", code: "failed", message: kept.trim() };
	}
	return { kind: "tool", text: kept, failed: item.status === "error" };
}

/** The media type alone: "application/json" for "application/json; charset=utf-8". */
export const mediaType = (contentType: string | undefined): string | undefined =>
	contentType?.split(";")[0]?.trim() || undefined;

/** A response body as JSON, when it is JSON. */
export function jsonBody(body: string): { readonly value: unknown } | undefined {
	const trimmed = body.trim();
	if (!/^[[{]/.test(trimmed)) return undefined;
	try {
		return { value: JSON.parse(trimmed) };
	} catch {
		return undefined;
	}
}

const plural = (count: number, one: string, many: string) =>
	`${count.toLocaleString("en-GB")} ${count === 1 ? one : many}`;

/** What a JSON answer holds, in a few words: "295 results" for a search, "40 items" for a list. */
export function resultCount(body: string): string | undefined {
	const json = jsonBody(body);
	if (json === undefined) return undefined;
	const { value } = json;
	if (Array.isArray(value)) return plural(value.length, "item", "items");
	const total = (value as { total_count?: unknown }).total_count;
	return typeof total === "number" ? plural(total, "result", "results") : undefined;
}

/** A service's own words for an error answer: its JSON `message`, or the first sentences of its text. */
export function serviceMessage(body: string): string | undefined {
	const json = jsonBody(body);
	const said = (json?.value as { message?: unknown; error?: unknown } | undefined) ?? undefined;
	const message =
		typeof said?.message === "string" ? said.message : typeof said?.error === "string" ? said.error : undefined;
	const words = (message ?? (json === undefined ? body : ""))
		.replace(/<[^>]+>/g, " ")
		.replace(/\s*\(?https?:\/\/[^\s)]+\)?/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (words === "") return undefined;
	// The first two sentences: a service's error page says what's wrong first, then where to read more.
	const sentences = words.match(/[^.!?]+[.!?]?/g) ?? [words];
	const kept = sentences
		.slice(0, 2)
		.join("")
		.trim()
		.replace(/[.\s]+$/, "");
	return kept.length > 160 ? `${kept.slice(0, 159)}…` : kept;
}

/** Why Kantel sent nothing, in words, from a refusal's code and message (@kantel/connections' tools.ts). */
export function refusalReason(code: string, message: string): string {
	switch (code) {
		case "approval_denied":
			return "A person denied it, so nothing was sent";
		case "approval_expired":
			return "No one approved it in time, so nothing was sent";
		case "approval_withdrawn":
			return "Its approval was withdrawn, so nothing was sent";
		case "approval_pending":
			return "It needs a person's approval, so nothing was sent yet";
		default:
			return message === "" ? "The connection call failed" : message.replace(/\.$/, "");
	}
}

/** Whether a call's failure is a refusal (by the service or by Kantel), rather than a request that broke. */
export function refusedCall(result: ConnectionCallResult): boolean {
	if (result.kind === "response") return result.status >= 400 && result.status < 500;
	if (result.kind !== "refused") return false;
	return result.code !== "unavailable" && result.code !== "failed" && result.code !== "conflict";
}

/** Whether a connection call failed: an error answer, a refusal, an MCP tool's error, or stopped. */
export function failedCall(result: ConnectionCallResult): boolean {
	return (
		(result.kind === "response" && result.status >= 400) ||
		result.kind === "refused" ||
		(result.kind === "tool" && result.failed) ||
		result.kind === "interrupted"
	);
}

/** The service a call went to, in words: the host's connection's name, else GitHub by its host, else the host. */
export function serviceOfCall(
	request: ConnectionCallRequest,
	connection: ConnectionCallConnection | undefined,
): string | undefined {
	if (connection !== undefined) return connection.name;
	if (request.kind === "http" && request.parts !== undefined) return serviceOf(request.parts.host);
	return undefined;
}

/** "search_issues" as "Search issues": an MCP tool's name in words. */
const toolWords = (tool: string): string => {
	const words = tool.replace(/[_-]+/g, " ").trim();
	return words === "" ? "Called a tool" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** A connection call's row: what it does, in words ("Search pull requests: author tvdavies, created 31 Oct"). */
export function connectionCallLabel(item: Pick<ToolItem, "name" | "args">): string {
	const request = connectionRequestOf(item);
	if (request.kind === "mcp") return toolWords(request.tool);
	if (request.url === "") return "Sending a request";
	return describeRequest({ method: request.method, url: request.url });
}

/** Why a call failed, under its row: the service's message for an error answer, or why Kantel refused it. */
export function connectionCallNote(item: ToolItem): string | undefined {
	const result = connectionResultOf(item);
	const request = connectionRequestOf(item);
	const service = serviceOfCall(request, undefined) ?? "The service";
	switch (result.kind) {
		case "response": {
			if (result.status < 400) return undefined;
			const message = serviceMessage(result.body);
			const verb = result.status < 500 ? "refused it" : "failed";
			return message === undefined ? `${service} ${verb}` : `${service} ${verb}: ${message}`;
		}
		case "refused":
			return refusalReason(result.code, result.message);
		case "tool":
			return result.failed ? (serviceMessage(result.text) ?? "The tool failed") : undefined;
		case "interrupted":
			return "Stopped before it answered";
		default:
			return undefined;
	}
}

/** A use's request in words, for a script's step: its operation, or `GET api.github.com/user/repos`. */
export function labelOfUse(use: Pick<ConnectionUse, "kind" | "method" | "host" | "path" | "tool">): string {
	if (use.kind === "mcp_call") return toolWords(use.tool ?? "");
	if (use.kind === "mcp_tools") return "List its tools";
	return (
		describeOperation({ method: use.method, host: use.host, path: use.path, query: [] }) ??
		`${use.method} ${use.host}${use.path}`
	);
}

/** What decided a use, in words, with the tone of its badge. */
export type UseDecision = {
	readonly badge: "Allowed" | "Refused" | "Waiting";
	readonly tone: "done" | "error" | "approval";
	readonly words: string;
	/** The words name a rule: the connection's page shows it. */
	readonly rule: boolean;
};

/** What decided a request, from its use (`decision`, `decidedBy`, its approval and its reason). */
export function decisionOfUse(use: ConnectionUse): UseDecision {
	if (use.outcome === "held") {
		const state = use.approval?.state;
		const words =
			state === "denied"
				? "A person denied it"
				: state === "expired"
					? "No one approved it in time"
					: state === "withdrawn"
						? "Its approval was withdrawn"
						: "It waits for a person to approve it";
		return {
			badge: state === "pending" || state === undefined ? "Waiting" : "Refused",
			tone: state === "pending" || state === undefined ? "approval" : "error",
			words,
			rule: false,
		};
	}
	if (use.outcome === "denied") {
		return {
			badge: "Refused",
			tone: "error",
			words: (use.reason ?? "Kantel refused it").replace(/\.$/, ""),
			rule: use.decidedBy === "rule",
		};
	}
	if (use.approvalId !== undefined || use.approval?.state === "used")
		return { badge: "Allowed", tone: "done", words: "A person approved it", rule: false };
	if (use.decidedBy === "rule") return { badge: "Allowed", tone: "done", words: "A rule allowed it", rule: true };
	if (use.decidedBy === "unmatched")
		return {
			badge: "Allowed",
			tone: "done",
			words: "No rule covers it, and this connection lets such requests through",
			rule: false,
		};
	return { badge: "Allowed", tone: "done", words: "Its connection let it through", rule: false };
}

/** A script's result (`codemode`): whether it completed, how long it ran, and what it printed or why it failed. */
export type ScriptResult = {
	readonly ok: boolean;
	/** "5.3 seconds" */
	readonly wallTime?: string | undefined;
	/** What it returned or printed, or its error. */
	readonly output: string;
	/** A failed script's error, its first line: "SyntaxError: Unexpected end of JSON input". */
	readonly error?: string | undefined;
};

/** A `codemode` call's result, from its text (`Script completed\nWall time 5.3 seconds\nOutput:\n…`). */
export function scriptResultOf(item: Pick<ToolItem, "status" | "output">): ScriptResult {
	const { body } = splitHarness(item.output ?? "");
	const lines = body.split("\n");
	const ok = item.status !== "error" && !/^Script failed/.test(lines[0] ?? "");
	const wallTime = /^Wall time (.+)$/m.exec(body)?.[1];
	const start = lines.indexOf("Output:");
	const output = (
		start < 0 ? lines.slice(/^Script (completed|failed)/.test(lines[0] ?? "") ? 1 : 0) : lines.slice(start + 1)
	)
		.join("\n")
		.trim();
	const error = ok
		? undefined
		: output
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line !== "" && line !== "Script error:");
	return { ok, wallTime, output, ...(error === undefined ? {} : { error }) };
}

/** A script's code, from its arguments. */
export const scriptCode = (item: Pick<ToolItem, "args">): string => text(argsOf(item).code) ?? "";

/** A failed script's error, under its row. */
export function scriptNote(item: ToolItem): string | undefined {
	if (item.status === "interrupted") return "Stopped before it finished";
	const result = scriptResultOf(item);
	if (result.ok || result.error === undefined) return undefined;
	return result.error.length > 160 ? `${result.error.slice(0, 159)}…` : result.error;
}

/** How a script's requests went: how many, to which services, and how many were refused. */
export function scriptRequests(
	uses: readonly ConnectionUse[],
	calls: ConnectionCalls | undefined,
): { readonly count: number; readonly services: readonly string[]; readonly refused: number } {
	const services: string[] = [];
	for (const use of uses) {
		const name = calls?.connection(use.connectionId)?.name ?? serviceOf(use.host);
		if (!services.includes(name)) services.push(name);
	}
	return { count: uses.length, services, refused: uses.filter((use) => use.outcome !== "allowed").length };
}

/** "9 GitHub requests", "3 requests" across services. */
export function requestsWords(count: number, services: readonly string[]): string {
	const noun = count === 1 ? "request" : "requests";
	return services.length === 1 ? `${count} ${services[0]} ${noun}` : `${count} ${noun}`;
}

/** "GitHub", "GitHub and Linear", "GitHub, Linear and Notion". */
export function namesList(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A run's count of requests and of failures, and whether every failure was a refusal. */
export function runCounts(calls: readonly ToolItem[]): {
	readonly count: number;
	readonly failed: number;
	readonly allRefused: boolean;
} {
	let failed = 0;
	let refused = 0;
	for (const call of calls) {
		const result = connectionResultOf(call);
		if (!failedCall(result)) continue;
		failed += 1;
		if (refusedCall(result)) refused += 1;
	}
	return { count: calls.length, failed, allRefused: failed === refused };
}

/** "1.8s", "420ms": how long a request took. */
export function requestTime(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

/** A body's size in bytes, as UTF-8. */
export const bodyBytes = (body: string): number => new TextEncoder().encode(body).length;
