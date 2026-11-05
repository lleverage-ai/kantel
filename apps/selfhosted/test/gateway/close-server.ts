import type { Server } from "node:http";

/**
 * Closes a test's `node:http` server as the gateway's own `close` does: its connections first, then the server. On
 * Bun a bare `server.close()` never calls back once a connection has been upgraded, even after that socket has
 * closed; dropping the connections first lets it finish (with `ERR_SERVER_NOT_RUNNING` on Bun, which is fine here).
 */
export function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	});
}
