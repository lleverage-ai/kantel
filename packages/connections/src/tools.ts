/**
 * The session's connection tools. They run on the host, not in the sandbox: the credential is added by the
 * connections service on the way out (the vault opens it for the request's host only) and cut out of the answer, so
 * the agent never sees it, on Cloudflare (whose isolates have no network) and self-hosted alike.
 *
 * - `connections_list`: the connections this session may use (`connectionUsableIn`), most specific owner first.
 * - `connection_tools`: a remote MCP connection's tools.
 * - `connection_call`: calls one of them.
 * - `connection_request`: one HTTP request to an API connection's hosts.
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
	isHarbourError,
	type Proposal,
	type SessionAudience,
	type SessionRecord,
	systemContext,
} from "@harbour/contracts";
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
/** The most text a tool result carries back to the model. */
const TEXT_LIMIT = 60_000;

export interface ConnectionToolsOptions {
	readonly connections: ConnectionsService;
	/**
	 * Who can see a session. Default: `private` to its acting person when `personal` is set (a deployment with one
	 * person, such as a personal agent), otherwise `shared`. A deployment that knows better passes its own.
	 */
	readonly audienceOf?: (record: SessionRecord) => SessionAudience;
	/** Every session acting for a person is that person's alone. */
	readonly personal?: boolean;
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
	if (!isHarbourError(error)) return undefined;
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

const clip = (text: string) =>
	text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT)}\n[cut: ${text.length - TEXT_LIMIT} more characters]`;

/** A decided approval that lets nothing out: denied, expired or withdrawn. */
class ApprovalSettled extends Error {}

const failure = (error: unknown) => ({
	output: [
		{
			type: "text" as const,
			text:
				error instanceof ApprovalSettled
					? error.message
					: isHarbourError(error)
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
		options.audienceOf ??
		((record: SessionRecord): SessionAudience =>
			options.personal === true && record.userId !== undefined
				? { kind: "private", userId: record.userId }
				: { kind: "shared" });

	return (record) => {
		const scope = () => sessionScope(record, audienceOf(record));
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
					const usable = await connections.usable(CONTEXT, scope());
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
					const found = await connections.listTools(CONTEXT, scope(), args.connectionId, { toolCallId: api.callId });
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
					const at = scope();
					const sent = await sendApproved(
						at,
						() =>
							connections.callTool(CONTEXT, at, args.connectionId, {
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
				"the headers.",
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
					const at = scope();
					const sent = await sendApproved(
						at,
						() =>
							connections.send(CONTEXT, at, args.connectionId, {
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
					const text = `HTTP ${response.status}${type === "" ? "" : ` (${type})`}\n\n${clip(response.body)}`;
					return { output: [{ type: "text" as const, text }], isError: response.status >= 400, ...details };
				} catch (error) {
					return failure(error);
				}
			},
		});

		return [list, tools, call, request] as unknown as ToolRegistration[];
	};
}
