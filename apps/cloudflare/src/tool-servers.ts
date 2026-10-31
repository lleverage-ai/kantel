/**
 * Tool servers on Cloudflare (docs/design/private-mcp-tools.md, section 2B; build plan item 4), the stack's side. The
 * registry lives in D1 with the stack, and each server's tunnel socket in its own `KantelTunnel` Durable Object
 * (`src/tunnel-object.ts`), named by the server's ID. The objects talk over RPC:
 *
 * - the Worker asks the stack `authenticateTunnel` before it forwards an upgrade (`src/route.ts`);
 * - a tunnel object tells the stack when its server connected, changed its tools or went away;
 * - the stack asks a tunnel object to `call` a tool or `close` its socket.
 *
 * Everything that crosses RPC is plain data: a thrown error keeps its message but not its `code`, so answers that the
 * caller tells apart (a refused token, an offline server) are values here, not errors.
 *
 * Experimental: on only when the Worker's `KANTEL_TOOL_SERVERS` is `experimental`. Off, there are no routes, no upgrade
 * and no registry tables, and sessions are as they were. Portable: no Cloudflare APIs, so the tests run it in Node.
 */
import {
	type ErrorCode,
	type HostToolResult,
	isKantelError,
	KantelError,
	type Timestamp,
	type ToolServerSnapshot,
	type ToolServerTokenId,
	toolServersEnabled,
} from "@kantel/contracts";
import type { ToolServerRef, TunnelLinks } from "@kantel/tools/links";
import type { McpCallToolInput } from "@kantel/tools/mcp-client";
import type { ToolServersService, TunnelConnected, TunnelGrant } from "@kantel/tools/service";

export interface ToolServersVars {
	/** `experimental` turns tool servers on. Anything else, or unset, leaves them off. */
	readonly KANTEL_TOOL_SERVERS?: string;
}

export function toolServersOn(vars: ToolServersVars): boolean {
	return toolServersEnabled(vars.KANTEL_TOOL_SERVERS);
}

/** What the stack says of a tunnel token, so the Worker can answer 401, 403 or 404 before any upgrade. */
export type TunnelAuthentication = { readonly grant: TunnelGrant } | { readonly refused: 401 | 403 | 404 };

/** A tool call as it crosses to the tunnel object: no signal, which RPC can't carry. */
export type TunnelCallInput = Omit<McpCallToolInput, "signal">;

/** A tunnel object's answer to a call: the server's result, no socket open, or the error the call failed with. */
export type TunnelCallAnswer =
	| { readonly result: HostToolResult }
	| { readonly offline: true }
	| { readonly error: { readonly code: ErrorCode; readonly message: string } };

/** The tunnel object's RPC methods the stack calls (`KantelTunnel`). */
export interface TunnelObjectRpc {
	call(ref: ToolServerRef, input: TunnelCallInput): Promise<TunnelCallAnswer>;
	close(code: number, reason: string, tokenId?: ToolServerTokenId): Promise<void>;
}

/** The stack object's RPC methods a tunnel object calls (`KantelStack`). */
export interface StackTunnelRpc {
	tunnelConnected(grant: TunnelGrant, info: TunnelConnected): Promise<void>;
	tunnelSnapshotChanged(ref: ToolServerRef, snapshot: ToolServerSnapshot): Promise<void>;
	tunnelDisconnected(ref: ToolServerRef, at: Timestamp): Promise<void>;
}

/** The stack object's RPC method the Worker calls before it forwards a tunnel's upgrade. */
export interface TunnelAuthority {
	authenticateTunnel(serverId: string, secret: string): Promise<TunnelAuthentication>;
}

/**
 * The stack's tunnel RPC over its registry. With no registry (tool servers off), every token is refused as an unknown
 * server's and a tunnel object's reports are dropped.
 */
export function stackTunnelRpc(service: ToolServersService | undefined): StackTunnelRpc & TunnelAuthority {
	return {
		async authenticateTunnel(serverId, secret) {
			if (service === undefined) return { refused: 404 };
			try {
				const grant = await service.authenticateTunnel(serverId, secret);
				return grant === undefined ? { refused: 401 } : { grant };
			} catch (error) {
				if (isKantelError(error, "not_found")) return { refused: 404 };
				if (isKantelError(error, "forbidden")) return { refused: 403 };
				throw error;
			}
		},
		async tunnelConnected(grant, info) {
			await service?.connected(grant, info);
		},
		async tunnelSnapshotChanged(ref, snapshot) {
			await service?.snapshotChanged(ref, snapshot);
		},
		async tunnelDisconnected(ref, at) {
			await service?.disconnected(ref, at);
		},
	};
}

/** `work`, or a rejection with `aborted` as soon as `signal` aborts. `work` itself carries on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(new KantelError("aborted", "tools/call was aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export interface ObjectTunnelLinksOptions {
	/** The tunnel object of a server, by its stored ID. */
	readonly tunnels: (toolServerId: string) => TunnelObjectRpc;
	/** The server as stored, to name it when it is offline. */
	readonly lookup: ToolServersService["lookup"];
}

/**
 * `TunnelLinks` over the tunnel objects, with the hub's rules (`@kantel/tools/hub`): a call with no socket open rejects
 * with `unavailable` naming the server, and a close with a token closes only a tunnel that token opened.
 */
export function objectTunnelLinks(options: ObjectTunnelLinksOptions): TunnelLinks {
	return {
		async call(ref, input, signal) {
			if (signal.aborted) throw new KantelError("aborted", "tools/call was aborted");
			// A signal can't cross RPC: an abort stops the wait here, and the tunnel object's call runs on until the server
			// answers or the client's timeout ends it.
			const answer = await untilAborted(options.tunnels(ref.toolServerId).call(ref, input), signal);
			if ("result" in answer) return answer.result;
			if ("offline" in answer) {
				const server = await options.lookup(ref).catch(() => undefined);
				throw new KantelError("unavailable", `Tool server ${server?.name ?? ref.toolServerId} is offline`);
			}
			throw new KantelError(answer.error.code, answer.error.message);
		},
		async close(ref, code, reason, tokenId) {
			await options.tunnels(ref.toolServerId).close(code, reason, tokenId);
		},
	};
}
