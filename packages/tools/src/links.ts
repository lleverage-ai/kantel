/**
 * Whatever holds tool servers' tunnel sockets, as the registry and the runtime reach it: the gateway's own process
 * self-hosted (`createTunnelHub`), one Durable Object per server on Cloudflare. Calls and closes name the server by its
 * stored organisation and ID, never by anything a request said.
 */
import type { HostToolResult, ToolServerTokenId } from "@harbour/contracts";
import type { McpCallToolInput } from "./mcp-client.ts";

/** A tool server, as the holder of its tunnel knows it. */
export interface ToolServerRef {
	readonly organisationId: string;
	readonly toolServerId: string;
}

export interface TunnelLinks {
	/**
	 * Calls a tool over the server's tunnel. Rejects with `unavailable` ("Tool server <name> is offline") when no tunnel
	 * is open, and with `aborted` when `signal` aborts.
	 */
	call(ref: ToolServerRef, input: Omit<McpCallToolInput, "signal">, signal: AbortSignal): Promise<HostToolResult>;
	/** Closes the server's tunnel with `code`; with `tokenId`, only a tunnel opened with that token. */
	close(ref: ToolServerRef, code: number, reason: string, tokenId?: ToolServerTokenId): Promise<void>;
}
