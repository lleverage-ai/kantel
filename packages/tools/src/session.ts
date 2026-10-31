/**
 * The runtime's `SessionToolServers` over the registry and whatever holds the tunnels. A session's tool list is its
 * pin and never changes under it, so everything that went wrong since (the server removed, the tool disabled, the
 * tunnel down) is told to the model as the call's error result rather than thrown.
 */
import {
	type HostToolResult,
	isHarbourError,
	type JsonValue,
	type SessionToolServer,
	type SessionToolServers,
	TOOL_SERVER_META,
	type ToolServer,
} from "@harbour/contracts";
import type { TunnelLinks } from "./links.ts";
import type { ToolServersService } from "./service.ts";

export interface SessionToolServersOptions {
	readonly service: Pick<ToolServersService, "forSession" | "lookup">;
	/** Late-bound, for a host that builds the tunnels' holder after the runtime. */
	readonly links: () => TunnelLinks;
}

const asSessionServer = (server: ToolServer): SessionToolServer => ({
	id: server.id,
	name: server.name,
	transport: server.transport,
	...(server.snapshot === undefined ? {} : { snapshot: server.snapshot }),
	disabledTools: server.disabledTools,
});

const failed = (output: string): HostToolResult => ({ output, isError: true });

export function sessionToolServers(options: SessionToolServersOptions): SessionToolServers {
	const { service } = options;
	return {
		async servers(record, names) {
			return (await service.forSession(record, names)).map(asSessionServer);
		},

		async call(server, call, signal) {
			try {
				const ref = { organisationId: call.organisationId, toolServerId: server.id };
				const current = await service.lookup(ref);
				if (current === undefined) return failed(`Tool server ${server.name} was removed`);
				if (current.disabledTools.includes(call.tool)) {
					return failed(`Tool ${call.tool} of tool server ${server.name} is disabled`);
				}
				const meta: { [key: string]: JsonValue } = {
					[TOOL_SERVER_META.sessionId]: call.sessionId,
					[TOOL_SERVER_META.organisationId]: call.organisationId,
					...(call.projectId === undefined ? {} : { [TOOL_SERVER_META.projectId]: call.projectId }),
					[TOOL_SERVER_META.agentId]: call.agentId,
					[TOOL_SERVER_META.callId]: call.callId,
				};
				return await options.links().call(ref, { name: call.tool, args: call.args, meta }, signal);
			} catch (error) {
				// Whoever aborted has stopped listening; anything else is the model's to read.
				if (signal.aborted) throw error;
				if (isHarbourError(error) && error.code === "unavailable") return failed(error.message);
				return failed(`Tool server ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}
