/**
 * `kantel console`: the console, served by this CLI on 127.0.0.1 from the files in its own release, so the gateway
 * never chooses the code that runs it. Three things are served, and nothing else:
 *
 * - The console's files (`apps/console`'s build, shipped beside the CLI).
 * - `/v1/...`, passed to the gateway with this CLI's credentials, which never reach the browser.
 * - `/local/...`, this CLI's own: what the console needs to know about end-to-end encryption here (`/local/info`), and
 *   calls to a sandbox's host over an E2E session with this device's key (`/local/e2e`). The gateway relays those
 *   sessions but can't read them.
 *
 * Only this browser gets in: the link `kantel console` prints carries a one-off key, swapped for a cookie on the first
 * visit; a request without it is refused. The Host header must be the loopback address the server listens on (so a
 * page elsewhere can't reach it by DNS rebinding), and a call that changes something must come from the console's own
 * origin.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

/** What `/local/info` answers: that this console is local, who this device is, and each E2E space it is in. */
export interface LocalInfo {
	readonly local: true;
	readonly device?: { readonly id: string; readonly label: string };
	/** Each space this device verified a chain for, and its mode there. */
	readonly spaces: readonly { readonly id: string; readonly mode: "off" | "on" | "strict"; readonly error?: string }[];
}

/** The methods the console may call on a host over a session: a sandbox's commands, files and history. */
export const LOCAL_E2E_METHODS: ReadonlySet<string> = new Set([
	"sandbox.get",
	"sandbox.exec",
	"sandbox.history",
	"sandbox.files.read",
	"sandbox.files.write",
	"sandbox.files.delete",
	"sandbox.files.list",
]);

export interface LocalConsoleOptions {
	/** The console's built files (its index.html is the page for every route). */
	readonly dir: string;
	/** The gateway's URL, as the CLI's config has it. */
	readonly gateway: string;
	readonly apiKey: string;
	readonly fetch: typeof fetch;
	readonly info: () => Promise<LocalInfo>;
	readonly e2eCall: (sandboxId: string, method: string, params: object) => Promise<unknown>;
	/** Default 0: a free port. */
	readonly port?: number;
	/** The link's key; random by default. */
	readonly key?: string;
	readonly userAgent?: string;
}

export interface LocalConsole {
	/** The link to open: it carries the key. */
	readonly url: string;
	readonly origin: string;
	close(): Promise<void>;
}

const COOKIE = "kantel_console";
/** The most a request's body may be: a 1 MiB file, base64, with room for its JSON. */
const MAX_BODY = 4 << 20;

const TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json",
};

/**
 * The page's policy: its code and its calls are this server's only. Scripts come from the CLI's own files under
 * `scripts` (`<origin>/assets/`), never from `/v1/...`, which is the gateway's to answer, though on this origin.
 * `inline` is the hashes of the inline scripts in the CLI's own index.html (the theme, set before the page paints), and
 * no other inline script runs.
 */
const policy = (scripts: string, inline: readonly string[]) =>
	[
		"default-src 'self'",
		["script-src", scripts, ...inline.map((hash) => `'sha256-${hash}'`)].join(" "),
		`worker-src ${scripts}`,
		"object-src 'none'",
		"connect-src 'self'",
		"img-src 'self' data:",
		"style-src 'self' 'unsafe-inline'",
		"font-src 'self' data:",
		"frame-ancestors 'none'",
		"base-uri 'none'",
		"form-action 'self'",
	].join("; ");

/**
 * What the gateway answers is data on this origin, never a page or a script with its authority (its cookie and
 * `/local/e2e`, this device's key). Its type is one of these, or it goes as bytes; and whatever it is, a document made
 * of it is sandboxed with no scripts, in an origin of its own.
 */
const GATEWAY_TYPES: ReadonlySet<string> = new Set([
	"application/json",
	"application/problem+json",
	"application/x-ndjson",
	"application/octet-stream",
	"application/gzip",
	"application/x-tar",
	"application/zip",
	"text/plain",
	"text/event-stream",
]);

const GATEWAY_HEADERS: Record<string, string> = {
	"content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"cross-origin-resource-policy": "same-origin",
};

/** The gateway's content type, if it is data; otherwise bytes. */
export function gatewayType(type: string | null): string {
	const essence = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (!GATEWAY_TYPES.has(essence)) return "application/octet-stream";
	// Its parameters (a charset) only for text, and only a plain one.
	const charset = /;\s*charset="?([A-Za-z0-9_-]+)"?/i.exec(type ?? "")?.[1];
	return essence.startsWith("text/") && charset !== undefined ? `${essence}; charset=${charset}` : essence;
}

/** The hashes of a page's inline scripts (those without `src`). */
export function inlineScriptHashes(html: string): string[] {
	const hashes: string[] = [];
	for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
		if (/\ssrc\s*=/i.test(match[1] ?? "")) continue;
		hashes.push(
			createHash("sha256")
				.update(match[2] ?? "", "utf8")
				.digest("base64"),
		);
	}
	return hashes;
}

const PAGE_HEADERS: Record<string, string> = {
	"content-security-policy": policy("'none'", []),
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"cross-origin-opener-policy": "same-origin",
	"cache-control": "no-store",
};

/**
 * Request headers passed to the gateway; everything else (cookies, the browser's own credentials) stays here.
 * `kantel-organisation` is the organisation the console chose (@kantel/contracts' ORGANISATION_HEADER).
 */
const FORWARDED = ["accept", "content-type", "accept-language", "if-none-match", "kantel-organisation"];

function sameKey(given: string | undefined, key: string): boolean {
	if (given === undefined) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(key);
	return a.length === b.length && timingSafeEqual(a, b);
}

function cookieOf(request: IncomingMessage): string | undefined {
	for (const part of (request.headers.cookie ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === COOKIE) return value.join("=");
	}
	return undefined;
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).byteLength;
		if (size > MAX_BODY) throw new RangeError("too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

function send(
	response: ServerResponse,
	status: number,
	body: string | Buffer,
	type: string,
	extra: Record<string, string> = {},
): void {
	response.writeHead(status, { ...PAGE_HEADERS, "content-type": type, ...extra });
	response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	send(response, status, JSON.stringify(value), "application/json");
}

const refusal = (code: string, message: string) => ({ error: { code, message } });

/** Serves the console on 127.0.0.1 until closed. */
export async function serveLocalConsole(options: LocalConsoleOptions): Promise<LocalConsole> {
	const key = options.key ?? randomBytes(24).toString("base64url");
	const root = resolve(options.dir);
	const index = await readFile(join(root, "index.html")).catch(() => {
		throw new Error(`The console's files aren't in ${root}: build it with pnpm --filter @kantel/console build`);
	});
	const inline = inlineScriptHashes(index.toString("utf8"));
	const gateway = new URL(options.gateway);
	let origin = "";
	let hosts: readonly string[] = [];
	// Set once the port is known: a path in a policy names its origin.
	let pageHeaders: Record<string, string> = {};

	const serveFile = async (response: ServerResponse, pathname: string): Promise<void> => {
		const path = resolve(root, `.${normalize(decodeURIComponent(pathname))}`);
		if (path !== root && !path.startsWith(root + sep)) return send(response, 404, "Not found", "text/plain");
		const info = await stat(path).catch(() => undefined);
		if (info?.isFile()) {
			const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
			// Built assets are named by their content: they may be kept.
			const cache: Record<string, string> = pathname.startsWith("/assets/")
				? { "cache-control": "public, max-age=31536000, immutable" }
				: {};
			const page = path === join(root, "index.html") ? pageHeaders : {};
			return send(response, 200, await readFile(path), type, { ...cache, ...page });
		}
		// A file that isn't there is a 404; any other path is a page of the console's.
		if (extname(pathname) !== "") return send(response, 404, "Not found", "text/plain");
		return send(response, 200, index, TYPES[".html"] as string, pageHeaders);
	};

	const proxy = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
		const target = new URL(`${url.pathname}${url.search}`, gateway);
		const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}` };
		for (const name of FORWARDED) {
			const value = request.headers[name];
			if (typeof value === "string") headers[name] = value;
		}
		if (options.userAgent !== undefined) headers["user-agent"] = options.userAgent;
		const method = request.method ?? "GET";
		const body = method === "GET" || method === "HEAD" ? undefined : await bodyOf(request);
		let answer: Response;
		try {
			answer = await options.fetch(target, {
				method,
				headers,
				...(body === undefined ? {} : { body: new Uint8Array(body) }),
				redirect: "manual",
			});
		} catch (error) {
			return sendJson(
				response,
				502,
				refusal("unreachable", `Couldn't reach Kantel at ${gateway.origin}: ${(error as Error).message}`),
			);
		}
		const out: Record<string, string> = {};
		for (const name of ["etag", "www-authenticate", "retry-after", "location"]) {
			const value = answer.headers.get(name);
			if (value !== null) out[name] = value;
		}
		const bytes = Buffer.from(await answer.arrayBuffer());
		response.writeHead(answer.status, {
			...PAGE_HEADERS,
			...out,
			...GATEWAY_HEADERS,
			"content-type": gatewayType(answer.headers.get("content-type")),
		});
		response.end(bytes);
	};

	const local = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
		if (url.pathname === "/local/info" && request.method === "GET") {
			return sendJson(response, 200, await options.info());
		}
		if (url.pathname === "/local/e2e" && request.method === "POST") {
			let call: { sandboxId?: unknown; method?: unknown; params?: unknown };
			try {
				call = JSON.parse((await bodyOf(request)).toString("utf8")) as typeof call;
			} catch {
				return sendJson(response, 400, refusal("invalid", "The call isn't JSON"));
			}
			const { sandboxId, method, params = {} } = call;
			if (
				typeof sandboxId !== "string" ||
				typeof method !== "string" ||
				typeof params !== "object" ||
				params === null
			) {
				return sendJson(response, 400, refusal("invalid", "A call names a sandboxId, a method and its params"));
			}
			if (!LOCAL_E2E_METHODS.has(method)) {
				return sendJson(response, 400, refusal("unsupported", `The console doesn't call ${method} over a session`));
			}
			try {
				return sendJson(response, 200, { result: await options.e2eCall(sandboxId, method, params) });
			} catch (error) {
				return sendJson(response, 502, refusal("e2e", error instanceof Error ? error.message : String(error)));
			}
		}
		return sendJson(response, 404, refusal("not_found", "No such call"));
	};

	const server = createServer((request, response) => {
		void (async () => {
			// Only the loopback names this server listens on: a page on another name that resolves here is refused.
			if (!hosts.includes(request.headers.host ?? "")) {
				return send(response, 421, "This console answers on 127.0.0.1 only", "text/plain");
			}
			const url = new URL(request.url ?? "/", origin);
			const given = url.searchParams.get("k");
			if (given !== null) {
				if (!sameKey(given, key)) return send(response, 403, "That link's key is wrong", "text/plain");
				url.searchParams.delete("k");
				return send(response, 303, "", "text/plain", {
					location: `${url.pathname}${url.search}`,
					"set-cookie": `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
				});
			}
			if (!sameKey(cookieOf(request), key)) {
				return send(
					response,
					403,
					"Open the link kantel console printed: this console only lets in the browser it was opened in.",
					"text/plain",
				);
			}
			const method = request.method ?? "GET";
			if (method !== "GET" && method !== "HEAD" && request.headers.origin !== origin) {
				return sendJson(response, 403, refusal("forbidden", "Calls that change something come from the console"));
			}
			if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return proxy(request, response, url);
			if (url.pathname.startsWith("/local/")) return local(request, response, url);
			if (method !== "GET" && method !== "HEAD") return send(response, 405, "", "text/plain");
			return serveFile(response, url.pathname);
		})().catch((error: unknown) => {
			if (response.headersSent) return response.destroy();
			if (error instanceof RangeError)
				return sendJson(response, 413, refusal("too_large", "That request is too large"));
			sendJson(response, 500, refusal("failed", error instanceof Error ? error.message : String(error)));
		});
	});
	await new Promise<void>((done, failed) => {
		server.once("error", failed);
		server.listen(options.port ?? 0, "127.0.0.1", () => done());
	});
	const { port } = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${port}`;
	// Not localhost: the cookie and the origin calls are checked against are 127.0.0.1's.
	hosts = [`127.0.0.1:${port}`];
	pageHeaders = { "content-security-policy": policy(`${origin}/assets/`, inline) };
	return {
		url: `${origin}/?k=${key}`,
		origin,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}
