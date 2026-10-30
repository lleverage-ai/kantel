/**
 * Portable parts of the session runtime that every target running Pi Durable shares: the projection onto protocol
 * items, host tools as Pi tools, run results from settled submissions, and directory paging and filters.
 */
import type { JsonValue as PiJsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type AssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type EntryRecord,
	type SettledSubmissionRecord,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type CallContext,
	HarbourError,
	type HostToolCall,
	type HostToolDefinition,
	type HostToolResult,
	type JsonValue,
	type Page,
	type PageRequest,
	type PromptLayer,
	type RunResult,
	type SessionFilter,
	type SessionRecord,
} from "@harbour/contracts";
import type { Usage } from "@harbour/protocol";

export * from "./attachments.ts";
export * from "./history.ts";
export * from "./project.ts";
export * from "./session-end.ts";

/** Where a profile's model route resolves to in Pi's model collection. */
export interface ResolvedModel {
	readonly provider: string;
	readonly modelId: string;
}

/** A Pi context carrying the call's cancellation, if any. */
export function piContext(ctx?: CallContext): Context {
	return ctx?.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
}

/** The system prompt of a profile: its layers' text joined in order. */
export function joinPromptLayers(layers: readonly PromptLayer[]): string {
	return layers
		.map((layer) => layer.text)
		.filter((text) => text !== "")
		.join("\n\n");
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;

/** One page of `items` by an offset cursor. A cursor that is not one this function gave out is `invalid`. */
export function paginate<T>(items: readonly T[], page?: PageRequest): Page<T> {
	const limit = Math.min(Math.max(1, Math.floor(page?.limit ?? DEFAULT_PAGE_LIMIT)), MAX_PAGE_LIMIT);
	let start = 0;
	if (page?.cursor !== undefined) {
		const match = /^o(\d+)$/.exec(page.cursor);
		if (match === null) throw new HarbourError("invalid", "Unknown page cursor");
		start = Number(match[1]);
	}
	const end = start + limit;
	const slice = items.slice(start, end);
	return end < items.length ? { items: slice, nextCursor: `o${end}` } : { items: slice };
}

/** Whether a session record passes a directory filter; every label given must match. */
export function matchesSessionFilter(record: SessionRecord, filter: SessionFilter | undefined): boolean {
	if (filter === undefined) return true;
	if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
	if (filter.agentId !== undefined && record.agentId !== filter.agentId) return false;
	if (filter.status !== undefined && record.status !== filter.status) return false;
	if (filter.parentSessionId !== undefined && record.parentSessionId !== filter.parentSessionId) return false;
	for (const [key, value] of Object.entries(filter.labels ?? {})) if (record.labels[key] !== value) return false;
	return true;
}

/** Rejects once `signal` aborts; resolves with `work` otherwise. A handler that ignores its signal cannot hold an abort. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new HarbourError("aborted", "The tool call was aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new HarbourError("aborted", "The tool call was aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

type HostToolHandlerLookup = ((call: HostToolCall, signal: AbortSignal) => Promise<HostToolResult>) | undefined;

export interface HostToolTarget {
	/** The call as the host sees it, without the per-call fields. */
	readonly call: Omit<HostToolCall, "callId" | "tool" | "args">;
	/** The host's current handler, looked up at call time: a tool unregistered meanwhile fails the call. */
	readonly handler: () => HostToolHandlerLookup | Promise<HostToolHandlerLookup>;
	readonly onStarted?: (call: HostToolCall) => void | Promise<void>;
	readonly onFinished?: (call: HostToolCall, outcome: "done" | "error" | "aborted") => void | Promise<void>;
}

/**
 * A host tool as a Pi tool. The host's JSON schema is the tool's parameters; the stable call ID is Pi's tool call ID;
 * the call's abort signal reaches the handler. Only `safe` tools rerun after a crash.
 */
export function hostToolAsPiTool(definition: HostToolDefinition, target: HostToolTarget): ToolRegistration {
	return defineTool({
		name: definition.name,
		description: definition.description,
		parameters: Type.Unsafe<{ [key: string]: JsonValue }>({ ...definition.inputSchema }),
		replay: definition.replay === "safe" ? "safe" : "unsafe",
		execute: async (args, api, context) => {
			const call: HostToolCall = {
				...target.call,
				callId: api.callId,
				tool: definition.name,
				args: args as JsonValue,
			};
			await target.onStarted?.(call);
			const handler = await target.handler();
			if (handler === undefined) {
				await target.onFinished?.(call, "error");
				return {
					output: [{ type: "text", text: `Tool ${definition.name} is not served by host ${call.hostId}` }],
					isError: true,
				};
			}
			const signal = context.abortSignal ?? new AbortController().signal;
			let result: HostToolResult;
			try {
				result = await untilAborted(handler(call, signal), signal);
			} catch (error) {
				await target.onFinished?.(call, signal.aborted ? "aborted" : "error");
				throw error;
			}
			await target.onFinished?.(call, result.isError === true ? "error" : "done");
			return {
				output: [{ type: "text", text: result.output }],
				isError: result.isError === true,
				...(result.structured === undefined ? {} : { details: result.structured as PiJsonValue }),
			};
		},
	});
}

/** The text of an assistant answer entry. */
export function answerText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") return "";
	let text = "";
	for (const block of message.content) if (block.type === "text") text += block.text;
	return text;
}

/** Protocol usage of one model response. */
export function usageOf(message: AssistantMessage): Usage {
	return {
		inputTokens: message.usage.input,
		outputTokens: message.usage.output,
		cacheReadTokens: message.usage.cacheRead,
		cacheWriteTokens: message.usage.cacheWrite,
		costUsd: message.usage.cost.total,
	};
}

/** How a run ended, from a settled Pi submission and its answer entry (when answered). */
export function runResultOf(
	sessionId: string,
	submissionId: string,
	settled: SettledSubmissionRecord,
	answer: EntryRecord | undefined,
): RunResult {
	if (settled.status === "done") {
		const message = answer?.model?.[0];
		return {
			sessionId,
			submissionId,
			status: "answered",
			answer: answerText(answer),
			...(message?.role === "assistant" ? { usage: usageOf(message) } : {}),
		};
	}
	if (settled.reason === "aborted") return { sessionId, submissionId, status: "aborted" };
	const detail = settled.detail === undefined ? "" : `: ${JSON.stringify(settled.detail)}`;
	return { sessionId, submissionId, status: "failed", error: `${settled.reason}${detail}` };
}
