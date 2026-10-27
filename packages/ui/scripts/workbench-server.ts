// Serves a built workbench (`ladle build` writes build/) on a local port, for screenshots and the design loop.
// A tiny static server, so the scripts need no second process to manage.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webmanifest": "application/manifest+json",
};

export type Served = { url: string; close(): Promise<void> };

export async function serve(root: string, port = 0): Promise<Served> {
	const server: Server = createServer((request, response) => {
		const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname));
		let file = join(root, path);
		if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
		response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
		createReadStream(file).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	const address = server.address();
	const actual = typeof address === "object" && address !== null ? address.port : port;
	return {
		url: `http://127.0.0.1:${actual}/`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
