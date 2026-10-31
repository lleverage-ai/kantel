import type { IssuedToolServerToken, ToolServer } from "@kantel/contracts";
import { OneTimeSecret } from "../primitives/one-time-secret.tsx";
import { tunnelCommand } from "./tool-servers-model.ts";

/**
 * A tunnel token, once, with the command that connects the server: for a stdio server, which the tunnel starts, and
 * for a Streamable HTTP server already listening on loopback. Shown when a server is added and when its token is
 * rotated; the owner forgets the secret on acknowledge.
 */
export function TunnelTokenReveal({
	server,
	issued,
	origin,
	rotated = false,
	onAcknowledge,
}: {
	server: Pick<ToolServer, "id" | "name">;
	issued: IssuedToolServerToken;
	/** Kantel's address, as the tunnel dials it. */
	origin: string;
	/** A new token for a server that had one: the heading says so. */
	rotated?: boolean;
	onAcknowledge: () => void;
}) {
	return (
		<OneTimeSecret
			title={rotated ? `Copy the new token for ${server.name} now` : `Copy the token for ${server.name} now`}
			secret={issued.secret}
			secretLabel="Tunnel token"
			copyLabel="Copy token"
			commands={[
				{
					label: "Run this where your MCP server runs, with the server's own command at the end",
					text: tunnelCommand(origin, server.id, issued.secret, "stdio"),
				},
				{
					label: "Or, for a Streamable HTTP server already listening on this machine",
					text: tunnelCommand(origin, server.id, issued.secret, "url"),
				},
			]}
			warning={`Kantel shows this token only once and keeps just a hash of it. If it's lost, rotate the token on ${server.name}'s page.`}
			onAcknowledge={onAcknowledge}
		/>
	);
}
