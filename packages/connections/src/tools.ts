/**
 * The session's connection tools. They run on the host, not in the sandbox: the credential is added by the
 * connections service on the way out (the vault opens it for the request's host only) and cut out of the answer, so
 * the agent never sees it, on Cloudflare (whose isolates have no network) and self-hosted alike.
 *
 * - `connections_list`: the connections this session may use (`connectionUsableIn`), most specific owner first.
 * - `connection_tools`: a remote MCP connection's tools.
 * - `connection_call`: calls one of them.
 * - `connection_request`: one HTTP request to an API connection's hosts. A script gets its answer as an object
 *   (`structuredOutput`: status, the headers that count, and the body parsed as JSON where it is JSON); the model gets
 *   it as text, `HTTP 200 (type)` and the body, cut to a parseable preview marked as cut when it is too long (#465).
 *
 * Every use is recorded against the session and the tool call (`ConnectionUse`), with the session's audience then.
 *
 * When a rule asks for a person's approval (#333), `connection_call` and `connection_request` wait for it inside the
 * call: the call's running details carry a `connectionApproval` card (the session shows it), the approval is read
 * until it is decided or expires, and once approved the identical request is sent once. A denied or expired request
 * comes back as an error saying so, and nothing was sent. An interrupted wait leaves the approval open: the same call
 * again waits on the same approval, by the request's digest.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
	type ApprovalPending,
	type ConnectionSessionScope,
	type HttpMethod,
	isKantelError,
	type Proposal,
	type SessionAudience,
	type SessionRecord,
	sessionAudienceOf,
	systemContext,
} from "@kantel/contracts";
import type { ConnectionsService } from "./service.ts";

const CONTEXT = systemContext("connections");

/** The tools' names, for a profile's `tools`. */
export const CONNECTION_TOOL_NAMES = [
	"connections_list",
	"connection_tools",
	"connection_call",
	"connection_request",
] as const;
const METHODS: readonly HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/**
 * The most text, in UTF-8 bytes, a tool result carries back to the model: under the harness's own limit (50 KiB), which
 * drops whole lines, so a long one-line answer is cut here to a marked preview rather than dropped there.
 */
export const TEXT_LIMIT = 40_000;
/** The most lines a text answer keeps, under the harness's 2,000. */
const LINE_LIMIT = 1_500;
/** A string in a JSON preview longer than this is shortened. */
const STRING_LIMIT = 2_000;
/** The response headers a script gets: those that say what came back, where next, and how much is left. */
const KEPT_HEADERS = new Set([
	"content-type",
	"content-length",
	"location",
	"link",
	"etag",
	"last-modified",
	"retry-after",
	"x-ratelimit-limit",
	"x-ratelimit-remaining",
	"x-ratelimit-reset",
	"x-ratelimit-used",
	"x-ratelimit-resource",
	"x-total-count",
]);

/** What a script gets back from `connection_request`. */
const RESPONSE_SCHEMA = Type.Object({
	status: Type.Integer({ description: "The HTTP status." }),
	headers: Type.Record(Type.String(), Type.String(), {
		description: "The headers that count (content-type, link, location, etag, rate limits), by lower-case name.",
	}),
	json: Type.Boolean({ description: "Whether body is the response parsed as JSON." }),
	body: Type.Unknown({ description: "The response parsed as JSON when it is JSON, else its text." }),
	bytes: Type.Integer({ description: "The body's size in bytes." }),
	truncated: Type.Boolean({
		description: "Whether body was cut to fit 1 MiB: a JSON body keeps the first items of its longest lists.",
	}),
});
/**
 * The most of a body a script gets, as it is journalled with the script: as much as an image a tool returns (1 MiB),
 * where a response may be 2 MiB (`RESPONSE_LIMIT`).
 */
export const SCRIPT_BODY_LIMIT = 1024 * 1024;

export interface ConnectionToolsOptions {
	readonly connections: ConnectionsService;
	/**
	 * Who can see a session. Default: `private` to its acting person when `personal` is set (a deployment with one
	 * person, such as a personal agent), otherwise `shared`. A deployment that knows better passes its own.
	 */
	readonly audienceOf?: (record: SessionRecord) => SessionAudience;
	/** Every session acting for a person is that person's alone. */
	readonly personal?: boolean;
	/**
	 * The session's record as it is now, read for every call, so a change of who can see it (#335) takes effect on the
	 * next request rather than when the session next opens. Without it the record the tools were made with is used.
	 */
	readonly current?: (record: SessionRecord) => Promise<SessionRecord | undefined>;
	/** How often a call waiting on an approval reads it again. Default 2 seconds. */
	readonly approvalPollMs?: number;
}

/** Tools whose details may put a connection approval card in the transcript (`connectionApproval`). */
export const APPROVING_CONNECTION_TOOLS: readonly string[] = ["connection_call", "connection_request"];

/**
 * A connection approval card's fields, as a waiting call's details carry them (`details.connectionApproval`): the
 * protocol's `ConnectionApprovalCard` without its `type`, for an exact request.
 */
export interface ConnectionApprovalDetails {
	readonly proposalId: string;
	readonly status: Proposal["status"];
	readonly bindingCode: string;
	readonly what: string;
	readonly why: string;
	readonly host: string;
	readonly methods: readonly string[];
	readonly pathPrefix: string;
	readonly termsSource: "agent-proposed" | "approved";
	readonly expiresAt: number;
	readonly link: string;
	readonly request: {
		readonly connectionId: string;
		readonly connectionName: string;
		readonly kind: "http" | "mcp_call" | "mcp_tools";
		readonly method: string;
		readonly url: string;
		readonly tool?: string;
		readonly digest: string;
	};
}

/** The pending approval a refusal names, when a rule asked for one. */
export function approvalPendingOf(error: unknown): ApprovalPending | undefined {
	if (!isKantelError(error)) return undefined;
	const details = error.details as Partial<ApprovalPending> | undefined;
	if (details?.error !== "approval_pending") return undefined;
	if (typeof details.approvalId !== "string" || typeof details.digest !== "string" || typeof details.link !== "string")
		return undefined;
	return details as ApprovalPending;
}

/** The card a proposal for an exact request shows. */
export function approvalCardOf(proposal: Proposal, link: string): ConnectionApprovalDetails | undefined {
	const request = proposal.terms.request;
	if (request === undefined) return undefined;
	const what =
		request.kind === "mcp_call"
			? `Call ${request.tool ?? "a tool"} on ${request.connectionName}`
			: `${request.method} ${request.host}${request.path} through ${request.connectionName}`;
	return {
		proposalId: proposal.id,
		status: proposal.status,
		bindingCode: proposal.bindingCode,
		what,
		why: proposal.terms.reason,
		host: request.host,
		methods: [request.method],
		pathPrefix: request.path,
		termsSource: proposal.status === "approved" ? "approved" : "agent-proposed",
		expiresAt: proposal.expiresAt,
		link,
		request: {
			connectionId: request.connectionId,
			connectionName: request.connectionName,
			kind: request.kind,
			method: request.method,
			url: `${request.scheme}://${request.host}${request.port === (request.scheme === "https" ? 443 : 80) ? "" : `:${request.port}`}${request.path}${request.query.length === 0 ? "" : `?${request.query.map(({ name, value }) => `${name}=${value}`).join("&")}`}`,
			...(request.tool === undefined ? {} : { tool: request.tool }),
			digest: request.digest,
		},
	};
}

type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** The longest start of `text` within `bytes` UTF-8 bytes and `lines` lines, never splitting a character. */
function headOf(text: string, bytes: number, lines = Number.POSITIVE_INFINITY): string {
	let end = 0;
	let size = 0;
	let breaks = 0;
	for (const char of text) {
		const width = char.length === 2 ? 4 : char.charCodeAt(0) < 0x80 ? 1 : char.charCodeAt(0) < 0x800 ? 2 : 3;
		if (size + width > bytes) break;
		if (char === "\n") {
			breaks += 1;
			if (breaks >= lines) break;
		}
		size += width;
		end += char.length;
	}
	return text.slice(0, end);
}

/** Text cut to what the model is given, saying how much was cut. */
export function clip(text: string): string {
	if (byteLength(text) <= TEXT_LIMIT && text.split("\n").length <= LINE_LIMIT) return text;
	const kept = headOf(text, TEXT_LIMIT, LINE_LIMIT);
	return `${kept}\n[cut: ${text.length - kept.length} more characters]`;
}

/**
 * A JSON value shortened until its JSON fits `limit` bytes: long strings cut, then the largest arrays cut from the end,
 * each to as many of its items as fit. What it cut is said in `cuts`, outermost first.
 */
export function jsonPreview(
	value: unknown,
	limit: number,
): {
	readonly text: string;
	readonly cuts: readonly { readonly path: string; readonly kept: number; readonly of: number }[];
} {
	const cuts: { path: string; kept: number; of: number }[] = [];
	const shorten = (node: unknown): unknown => {
		if (typeof node === "string") return node.length <= STRING_LIMIT ? node : `${node.slice(0, STRING_LIMIT)}…`;
		if (Array.isArray(node)) return node.map(shorten);
		if (typeof node === "object" && node !== null)
			return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, shorten(child)]));
		return node;
	};
	const root = { value: shorten(value) };
	const size = () => byteLength(JSON.stringify(root.value));
	/** Every array in the value with its path and parent, largest first. */
	const arrays = (): {
		path: string;
		parent: Record<string | number, unknown>;
		key: string | number;
		list: unknown[];
	}[] => {
		const out: { path: string; parent: Record<string | number, unknown>; key: string | number; list: unknown[] }[] = [];
		const walk = (node: unknown, parent: Record<string | number, unknown>, key: string | number, path: string) => {
			if (Array.isArray(node)) {
				if (node.length > 0) out.push({ path, parent, key, list: node });
				node.forEach((child, index) => {
					walk(child, node as unknown as Record<number, unknown>, index, path === "" ? `${index}` : `${path}.${index}`);
				});
			} else if (typeof node === "object" && node !== null) {
				for (const [name, child] of Object.entries(node)) {
					walk(child, node as Record<string, unknown>, name, path === "" ? name : `${path}.${name}`);
				}
			}
		};
		walk(root.value, root as unknown as Record<string, unknown>, "value", "");
		return out.sort((a, b) => byteLength(JSON.stringify(b.list)) - byteLength(JSON.stringify(a.list)));
	};
	for (let rounds = 0, total = size(); total > limit && rounds < 20; rounds += 1, total = size()) {
		const largest = arrays()[0];
		if (largest === undefined) break;
		const { parent, key, list } = largest;
		// As many leading items as fit beside everything else: `[` and `]`, each item, and a comma between two.
		const rest = total - byteLength(JSON.stringify(list));
		let used = rest + 2;
		let low = 0;
		while (low < list.length) {
			const next = used + byteLength(JSON.stringify(list[low]) ?? "null") + (low === 0 ? 0 : 1);
			if (next > limit) break;
			used = next;
			low += 1;
		}
		if (low >= list.length) low = list.length - 1;
		parent[key] = list.slice(0, low);
		const known = cuts.find((cut) => cut.path === largest.path);
		if (known === undefined) cuts.push({ path: largest.path, kept: low, of: list.length });
		else known.kept = low;
	}
	const text = JSON.stringify(root.value);
	return { text: byteLength(text) <= limit ? text : headOf(text, limit), cuts };
}

/**
 * A response body as the model is given it: whole when it fits, else a preview that stays parseable for JSON, with a
 * last line saying it was cut and how. A body that is JSON keeps its form; text is cut at the limit.
 */
export function bodyPreview(body: string, contentType: string | undefined): string {
	if (byteLength(body) <= TEXT_LIMIT && body.split("\n").length <= LINE_LIMIT) return body;
	const parsed = parseJson(body, contentType);
	if (parsed === undefined) return clip(body);
	const preview = jsonPreview(parsed.value, TEXT_LIMIT);
	const kept = preview.cuts
		.map((cut) => `the first ${cut.kept} of ${cut.of} items${cut.path === "" ? "" : ` of ${cut.path}`}`)
		.join(", ");
	return (
		`${preview.text}\n[cut: ${Math.max(0, body.length - preview.text.length)} more characters. The JSON above is a ` +
		`preview${kept === "" ? "" : ` keeping ${kept}`}; a code mode script gets the whole body]`
	);
}

/** The body as JSON, when its type says JSON or it reads as JSON. */
function parseJson(body: string, contentType: string | undefined): { readonly value: unknown } | undefined {
	const trimmed = body.trim();
	const typed = /[/+]json\b/i.test(contentType ?? "");
	if (!typed && !/^[[{]/.test(trimmed)) return undefined;
	if (trimmed === "") return undefined;
	try {
		return { value: JSON.parse(trimmed) };
	} catch {
		return undefined;
	}
}

/** A response as a script gets it (`RESPONSE_SCHEMA`). */
export function scriptResponse(response: {
	readonly status: number;
	readonly headers: { readonly [name: string]: string };
	readonly body: string;
}): {
	status: number;
	headers: Record<string, string>;
	json: boolean;
	body: unknown;
	bytes: number;
	truncated: boolean;
} {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(response.headers)) {
		if (KEPT_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
	}
	const parsed = parseJson(response.body, headers["content-type"]);
	const bytes = byteLength(response.body);
	const truncated = bytes > SCRIPT_BODY_LIMIT;
	if (parsed === undefined || !truncated) {
		const body = parsed === undefined ? headOf(response.body, SCRIPT_BODY_LIMIT) : (parsed.value ?? null);
		return { status: response.status, headers, json: parsed !== undefined, body, bytes, truncated };
	}
	// A preview that still parses; one whose lists can't be cut enough (one huge object) is given as text.
	const preview = jsonPreview(parsed.value, SCRIPT_BODY_LIMIT).text;
	try {
		return { status: response.status, headers, json: true, body: JSON.parse(preview) as unknown, bytes, truncated };
	} catch {
		return { status: response.status, headers, json: false, body: preview, bytes, truncated };
	}
}

/** A decided approval that lets nothing out: denied, expired or withdrawn. */
class ApprovalSettled extends Error {}

const failure = (error: unknown) => ({
	output: [
		{
			type: "text" as const,
			text:
				error instanceof ApprovalSettled
					? error.message
					: isKantelError(error)
						? `${error.code}: ${error.message}`
						: "The connection call failed",
		},
	],
	isError: true,
});

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) return resolve();
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", done);
			resolve();
		}, ms);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** The scope a session's connection calls are checked against. Never from the model's arguments. */
export function sessionScope(record: SessionRecord, audience: SessionAudience): ConnectionSessionScope {
	return {
		organisationId: record.organisationId,
		...(record.projectId === undefined ? {} : { projectId: record.projectId }),
		sessionId: record.id,
		agentId: record.agentId,
		...(record.userId === undefined ? {} : { actingUserId: record.userId }),
		...(record.unattended === undefined ? {} : { unattended: true as const }),
		audience,
	};
}

export function connectionTools(options: ConnectionToolsOptions): (record: SessionRecord) => ToolRegistration[] {
	const { connections } = options;
	const pollMs = Math.max(10, options.approvalPollMs ?? 2_000);

	/**
	 * Sends with `send`; when a rule asks, waits for the person's decision and sends the identical request once it is
	 * approved. `show` publishes the card while waiting. Returns the send's result, or the error result to give back.
	 */
	async function sendApproved<T>(
		scope: ConnectionSessionScope,
		send: () => Promise<T>,
		show: (card: ConnectionApprovalDetails) => Promise<void>,
		signal: AbortSignal | undefined,
	): Promise<
		| { readonly value: T; readonly card?: ConnectionApprovalDetails }
		| { readonly failed: unknown; readonly card?: ConnectionApprovalDetails }
	> {
		try {
			return { value: await send() };
		} catch (error) {
			const pending = approvalPendingOf(error);
			if (pending === undefined) return { failed: error };
			let proposal: Proposal;
			try {
				proposal = await connections.approvalStatus(CONTEXT, scope, pending.approvalId);
			} catch {
				return { failed: error };
			}
			let card = approvalCardOf(proposal, pending.link);
			if (card !== undefined) await show(card);
			// Until it is decided or expires, read a little past its expiry so the vault's own expiry is what ends it.
			const until = proposal.expiresAt + 2 * pollMs;
			// Interrupted, the call gives back the pending refusal: the approval stays open for the same call again. Past
			// its expiry with no decision read, it is over, whatever the vault's sweep has yet to record.
			const stopped = () =>
				signal?.aborted === true
					? { failed: error, ...(card === undefined ? {} : { card }) }
					: Date.now() > until
						? {
								failed: new ApprovalSettled(
									`approval_expired: no one decided in time, so nothing was sent. Approval ${pending.approvalId}.`,
								),
								...(card === undefined ? {} : { card }),
							}
						: undefined;
			while (proposal.status === "pending") {
				const before = stopped();
				if (before !== undefined) return before;
				await sleep(pollMs, signal);
				const after = stopped();
				if (after !== undefined) return after;
				try {
					proposal = await connections.approvalStatus(CONTEXT, scope, pending.approvalId);
				} catch {
					// A read that fails is read again: the approval is the vault's, not this call's.
				}
			}
			card = approvalCardOf(proposal, pending.link) ?? card;
			if (card !== undefined) await show(card);
			if (proposal.status !== "approved") {
				return {
					failed: new ApprovalSettled(
						`approval_${proposal.status}: a person ${proposal.status === "denied" ? "denied" : `didn't approve (${proposal.status})`} ` +
							`this request, so nothing was sent. Approval ${proposal.id}.`,
					),
					...(card === undefined ? {} : { card }),
				};
			}
			// Approved: the identical request again, once. Anything that asks again is given back as it is.
			try {
				return { value: await send(), ...(card === undefined ? {} : { card }) };
			} catch (again) {
				return { failed: again, ...(card === undefined ? {} : { card }) };
			}
		}
	}
	const audienceOf =
		options.audienceOf ?? ((record: SessionRecord): SessionAudience => sessionAudienceOf(record, options.personal));

	return (record) => {
		const scope = async () => {
			const latest = (await options.current?.(record).catch(() => undefined)) ?? record;
			return sessionScope(latest, audienceOf(latest));
		};
		const list = defineTool({
			name: "connections_list",
			description:
				"List the connections (outside services and remote MCP servers someone connected) this session may use. " +
				"Use connection_tools and connection_call for an MCP connection, connection_request for an API connection. " +
				"Credentials are added for you; never ask for or handle a token.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => {
				try {
					const usable = await connections.usable(CONTEXT, await scope());
					const text =
						usable.length === 0
							? "No connections are available to this session."
							: JSON.stringify(
									usable.map((connection) => ({
										id: connection.id,
										name: connection.name,
										kind: connection.kind,
										owner: connection.owner,
										...(connection.templateId === undefined ? {} : { template: connection.templateId }),
										...(connection.account === undefined ? {} : { account: connection.account }),
										hosts: connection.hosts,
									})),
									null,
									2,
								);
					return { output: [{ type: "text" as const, text }], isError: false };
				} catch (error) {
					return failure(error);
				}
			},
		});

		const tools = defineTool({
			name: "connection_tools",
			description: "List the tools a remote MCP connection offers, with their input schemas.",
			parameters: Type.Object({ connectionId: Type.String({ description: "From connections_list." }) }),
			replay: "safe",
			execute: async (args, api) => {
				try {
					const found = await connections.listTools(CONTEXT, await scope(), args.connectionId, {
						toolCallId: api.callId,
					});
					const text = JSON.stringify(
						found.map((tool) => ({
							name: tool.name,
							...(tool.description === undefined ? {} : { description: tool.description }),
							...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
							...(tool.annotations?.readOnlyHint === undefined ? {} : { readOnly: tool.annotations.readOnlyHint }),
						})),
					);
					return { output: [{ type: "text" as const, text: clip(text) }], isError: false };
				} catch (error) {
					return failure(error);
				}
			},
		});

		const call = defineTool({
			name: "connection_call",
			description:
				"Call one tool on a remote MCP connection. Get its name and input schema from connection_tools first.",
			parameters: Type.Object({
				connectionId: Type.String({ description: "From connections_list." }),
				tool: Type.String({ description: "The tool's name, from connection_tools." }),
				arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "The tool's arguments." })),
			}),
			replay: "unsafe",
			execute: async (args, api, context) => {
				try {
					const at = await scope();
					const sent = await sendApproved(
						at,
						async () =>
							connections.callTool(CONTEXT, await scope(), args.connectionId, {
								name: args.tool,
								arguments: args.arguments ?? {},
								toolCallId: api.callId,
							}),
						(card) => api.details({ connectionApproval: card } as never, context),
						context.abortSignal,
					);
					const details = sent.card === undefined ? {} : { details: { connectionApproval: sent.card } as never };
					if ("failed" in sent) return { ...failure(sent.failed), ...details };
					const result = sent.value;
					const content: Content[] = [];
					for (const item of result.content) {
						const part = item as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
						if (part.type === "text" && typeof part.text === "string")
							content.push({ type: "text", text: clip(part.text) });
						else if (part.type === "image" && typeof part.mimeType === "string" && typeof part.data === "string") {
							content.push({ type: "image", mimeType: part.mimeType, data: part.data });
						} else content.push({ type: "text", text: clip(JSON.stringify(item)) });
					}
					if (content.length === 0 && result.structuredContent !== undefined) {
						content.push({ type: "text", text: clip(JSON.stringify(result.structuredContent)) });
					}
					if (content.length === 0) content.push({ type: "text", text: "(no content)" });
					return { output: content, isError: result.isError === true, ...details };
				} catch (error) {
					return failure(error);
				}
			},
		});

		const request = defineTool({
			name: "connection_request",
			description:
				"Send one HTTPS request to an API connection's hosts, with its credential added for you. Never put a token in " +
				"the headers. The connection's service gets the headers it needs (such as GitHub's User-Agent and Accept) " +
				"unless you set your own. A long answer is cut to a preview; in a code mode script you get the whole answer " +
				"as { status, headers, json, body, bytes }, with body parsed when it is JSON.",
			structuredOutputSchema: RESPONSE_SCHEMA,
			parameters: Type.Object({
				connectionId: Type.String({ description: "From connections_list." }),
				method: Type.Union(METHODS.map((method) => Type.Literal(method))),
				url: Type.String({ description: "An absolute https URL on one of the connection's hosts." }),
				headers: Type.Optional(Type.Record(Type.String(), Type.String())),
				body: Type.Optional(Type.String()),
			}),
			replay: "unsafe",
			execute: async (args, api, context) => {
				try {
					const at = await scope();
					const sent = await sendApproved(
						at,
						async () =>
							connections.send(CONTEXT, await scope(), args.connectionId, {
								method: args.method as HttpMethod,
								url: args.url,
								...(args.headers === undefined ? {} : { headers: args.headers }),
								...(args.body === undefined ? {} : { body: args.body }),
								kind: "http",
								toolCallId: api.callId,
							}),
						(card) => api.details({ connectionApproval: card } as never, context),
						context.abortSignal,
					);
					const details = sent.card === undefined ? {} : { details: { connectionApproval: sent.card } as never };
					if ("failed" in sent) return { ...failure(sent.failed), ...details };
					const response = sent.value;
					const type = response.headers["content-type"] ?? "";
					const text = `HTTP ${response.status}${type === "" ? "" : ` (${type})`}\n\n${bodyPreview(response.body, type)}`;
					return {
						output: [{ type: "text" as const, text }],
						structuredOutput: scriptResponse(response) as never,
						isError: response.status >= 400,
						...details,
					};
				} catch (error) {
					return failure(error);
				}
			},
		});

		return [list, tools, call, request] as unknown as ToolRegistration[];
	};
}
