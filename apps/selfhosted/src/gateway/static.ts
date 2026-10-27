// Serves a single-page app's build: files as they are, and index.html for any path without a file extension, so the
// console's client-side routes (/projects/:id/sessions/:id) load on a refresh.
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

const IMMUTABLE = "public, max-age=31536000, immutable";

const TYPES: { readonly [extension: string]: string } = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".jsonl": "application/x-ndjson; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export function createStaticHandler(root: string): (request: Request) => Promise<Response> {
	const base = resolve(root);
	const index = `${base}${sep}index.html`;

	const serveFile = async (path: string, cache: string): Promise<Response> =>
		new Response(new Uint8Array(await readFile(path)), {
			headers: {
				"content-type": TYPES[extname(path)] ?? "application/octet-stream",
				"cache-control": cache,
				"x-content-type-options": "nosniff",
			},
		});

	return async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
		}
		let path: string;
		try {
			path = decodeURIComponent(new URL(request.url).pathname);
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		if (path.includes("\0")) return new Response("Bad path", { status: 400 });
		const target = resolve(base, `.${normalize(`/${path}`)}`);
		if (target !== base && !target.startsWith(`${base}${sep}`)) return new Response("Not found", { status: 404 });
		if (extname(target) === "") {
			if (!(await isFile(index))) return new Response("The console has not been built", { status: 404 });
			return serveFile(index, "no-cache");
		}
		if (!(await isFile(target))) return new Response("Not found", { status: 404 });
		// Vite fingerprints everything under assets/, so those never change.
		return serveFile(target, path.startsWith("/assets/") ? IMMUTABLE : "no-cache");
	};
}
