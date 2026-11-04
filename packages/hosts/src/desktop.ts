/**
 * A sandbox's desktop in the browser (`openDesktop`'s `url`): Selkies, the guest's desktop stream on port 6080, at
 * `/v1/hosts/desktop/{ticket}/` on the gateway. As with every tunnel, the gateway reaches the port only through the
 * sandbox's host, which dialled out to it; nothing reaches the sandbox from outside.
 *
 * - The page and its scripts are Selkies' web client, and only the files of the version the image ships, byte for
 *   byte (`selkies-web.ts`): the page runs on the gateway's origin, beside the console, so the gateway never serves
 *   what a sandbox could have changed. Each file is fetched from the sandbox once, checked against its SHA-256 and kept.
 * - The stream is Selkies' one WebSocket, `api/websockets`, passed through message by message. Nothing else on the
 *   port (its HTTP API: file transfers, commands, settings) is reachable.
 * - The ticket's mode, kept in its row (`tunnel.ts`), decides what reaches Selkies. A view-only ticket's socket is opened as Selkies' viewer
 *   role, whatever the client asks for, and the gateway drops every message from it but the few a viewer needs to
 *   watch (`viewerMessage`), so no client, modified or not, can type, click, paste or change the desktop through it.
 */
import type { PortSink, PortStream } from "./hub.ts";
import { proxyHttp } from "./port-http.ts";
import { SELKIES_WEB } from "./selkies-web.ts";
import type { DesktopMode, IssuedGrant, TunnelTickets } from "./tunnel.ts";

export const HOSTS_DESKTOP_PATH = "/v1/hosts/desktop";
/** Where the guest image's desktop stream (Selkies: its web client and its WebSocket) listens, on loopback. */
export const DESKTOP_PORT = 6080;
/** Selkies' stream socket, under the page. */
export const DESKTOP_SOCKET = "/api/websockets";

const PATH = new RegExp(`^${HOSTS_DESKTOP_PATH}/([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)(/.*)?$`);

/**
 * What a view-only viewer may send: Selkies' own viewer allowlist (its input handler's `VIEWER_ALLOWED_PREFIXES`)
 * without the gamepad. Everything else, keys (`kd`, `ku`), the pointer (`m`, `m2`), the clipboard (`cw…`), commands
 * (`cmd`), resizes (`r,`) and every binary message (file uploads, compressed text), is dropped.
 */
export const VIEWER_MESSAGES = ["SETTINGS,", "START_VIDEO", "STOP_VIDEO", "REQUEST_KEYFRAME"] as const;

/** Whether a message from a view-only ticket's client may reach Selkies. */
export function viewerMessage(data: string | Uint8Array, binary: boolean): boolean {
	if (binary || typeof data !== "string") return false;
	return VIEWER_MESSAGES.some((prefix) => data.startsWith(prefix));
}

/** The desktop page's URL path for a ticket: `/v1/hosts/desktop/{ticket}/`, with `#shared` for view-only. */
export function desktopPath(ticket: string, mode: DesktopMode): string {
	return `${HOSTS_DESKTOP_PATH}/${ticket}/${mode === "view" ? "#shared" : ""}`;
}

/** The ticket and the rest of the path, for a path under `HOSTS_DESKTOP_PATH`. */
export function parseDesktopPath(pathname: string): { readonly ticket: string; readonly rest?: string } | undefined {
	const match = PATH.exec(pathname);
	if (match?.[1] === undefined) return undefined;
	return match[2] === undefined ? { ticket: match[1] } : { ticket: match[1], rest: match[2] };
}

/** Where a desktop's WebSocket goes on the port, and what of its client's messages may reach it. */
export interface DesktopSocket {
	readonly sandboxId: string;
	readonly port: number;
	/** Path and query on the port: Selkies' socket, as its viewer role for a view-only ticket. */
	readonly path: string;
	/** Whether a client message may pass; absent, all do. */
	readonly accept?: (data: string | Uint8Array, binary: boolean) => boolean;
	/** The ticket's grant, so the gateway can end the socket when its holder's access ends. */
	readonly grant: IssuedGrant;
}

/** How long a file of the client may take to come from the sandbox, head and body. */
export const DESKTOP_FILE_TIMEOUT_MS = 30_000;
/**
 * The most every sandbox's files still arriving hold together (Selkies' whole client is about 2.3 MB, its biggest file
 * about 0.5 MB): past it, a file is refused, as a wrong one is, and tried again on the next request.
 */
export const DESKTOP_FETCH_BUDGET = 32 * 1024 * 1024;

export interface DesktopRoutesOptions {
	/** How long a file may take to come from the sandbox (default `DESKTOP_FILE_TIMEOUT_MS`). */
	readonly fileTimeoutMs?: number;
	/** The most files still arriving hold together (default `DESKTOP_FETCH_BUDGET`). */
	readonly fetchBudgetBytes?: number;
	/** The relay's tickets, shared by every gateway replica. */
	readonly tickets: Pick<TunnelTickets, "verify">;
	/** Whether whoever was given the ticket may still use the sandbox (`relay-access.ts`); absent, everyone may. */
	readonly allowed?: (grant: IssuedGrant) => Promise<boolean>;
	readonly openPort: (sandboxId: string, port: number, sink: PortSink) => Promise<PortStream>;
	readonly now?: () => number;
	/** The web client's files (default `SELKIES_WEB`, the version the image ships). */
	readonly client?: ClientFiles;
}

export interface ClientFiles {
	readonly version: string;
	readonly files: { readonly [path: string]: { readonly sha256: string; readonly size: number } };
}

export interface DesktopRoutes {
	/** The page and its files, for a GET under `HOSTS_DESKTOP_PATH`; undefined for any other path. */
	fetch(request: Request): Promise<Response | undefined>;
	/**
	 * For an upgrade under `HOSTS_DESKTOP_PATH`: where its socket goes, `refused` when the ticket or the path won't do,
	 * or undefined for any other path.
	 */
	socket(url: string): Promise<DesktopSocket | "refused" | undefined>;
}

const TYPES: { readonly [extension: string]: string } = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	png: "image/png",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	woff2: "font/woff2",
	md: "text/plain; charset=utf-8",
};

const hex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const notFound = (text = "Not found") =>
	new Response(text, {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
	});

export function createDesktopRoutes(options: DesktopRoutesOptions): DesktopRoutes {
	const now = options.now ?? Date.now;
	const client = options.client ?? SELKIES_WEB;
	const fileTimeout = options.fileTimeoutMs ?? DESKTOP_FILE_TIMEOUT_MS;
	const budget = { limit: options.fetchBudgetBytes ?? DESKTOP_FETCH_BUDGET, held: 0 };
	/**
	 * Checked files, by SHA-256: the same in every sandbox on the same Selkies, so fetched once per gateway. Only bytes
	 * that matched are kept here, so one sandbox's slow or wrong answer never stands for another's.
	 */
	const verified = new Map<string, Uint8Array>();
	/** Fetches under way, by sandbox and SHA-256: requests for the same file of the same sandbox share one. */
	const fetching = new Map<string, Promise<Uint8Array | undefined>>();

	async function grantOf(ticket: string): Promise<IssuedGrant | undefined> {
		const grant = await options.tickets.verify(ticket, now());
		if (grant?.desktop === undefined || grant.port !== DESKTOP_PORT) return undefined;
		return options.allowed === undefined || (await options.allowed(grant)) ? grant : undefined;
	}

	/**
	 * A file of the client from the sandbox, if it is byte for byte the one Kantel knows. Its bytes go straight into one
	 * buffer of this fetch's own as the parser reads them (`take`): nothing else of the answer is kept or queued,
	 * however it is split. The buffer grows only as bytes come, never past the file's size, and what it has allocated is
	 * what is charged against the budget every file still arriving shares; past either, the answer fails and its stream
	 * is closed. Given up on once the time is up, and its charge let go of however it ends.
	 */
	async function fetchFile(
		sandboxId: string,
		file: string,
		sha256: string,
		size: number,
	): Promise<Uint8Array | undefined> {
		let data = new Uint8Array(0);
		let length = 0;
		let finished = false;
		const take = (bytes: Uint8Array) => {
			if (finished || length + bytes.length > size) return false;
			if (length + bytes.length > data.length) {
				const capacity = Math.min(size, Math.max(length + bytes.length, data.length * 2));
				if (budget.held + capacity - data.length > budget.limit) return false;
				budget.held += capacity - data.length;
				const grown = new Uint8Array(capacity);
				grown.set(data.subarray(0, length));
				data = grown;
			}
			data.set(bytes, length);
			length += bytes.length;
			return true;
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const answer = await proxyHttp(
				(sink) => options.openPort(sandboxId, DESKTOP_PORT, sink),
				new Request(`http://127.0.0.1:${DESKTOP_PORT}/${file}`),
				{ host: `127.0.0.1:${DESKTOP_PORT}`, path: `/${file}`, headTimeoutMs: fileTimeout, take },
			);
			const declared = answer.headers.get("content-length");
			if (answer.status !== 200 || answer.body === null || (declared !== null && Number(declared) !== size)) {
				await answer.body?.cancel().catch(() => undefined);
				return undefined;
			}
			// The stream carries no bytes (they are `take`'s): it only says when the body ends, or that it failed.
			const reader = answer.body.getReader();
			timer = setTimeout(() => void reader.cancel().catch(() => undefined), fileTimeout);
			try {
				while (!(await reader.read()).done) {}
			} catch {
				return undefined;
			}
			if (finished || length !== size) return undefined;
			if (hex(await crypto.subtle.digest("SHA-256", data)) !== sha256) return undefined;
			return data;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			// Read, failed or given up on: its charge is let go of (a verified copy is the cache's, bounded by the client).
			finished = true;
			budget.held -= data.length;
		}
	}

	return {
		async fetch(request) {
			const url = new URL(request.url);
			const target = parseDesktopPath(url.pathname);
			if (target === undefined) return undefined;
			if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
			const grant = await grantOf(target.ticket);
			if (grant === undefined) return notFound("This desktop link has expired or isn't valid.");
			// The client's files are relative to the page, so it is the ticket's directory.
			if (target.rest === undefined) {
				return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}` } });
			}
			const file = target.rest === "/" ? "index.html" : target.rest.slice(1);
			const known = Object.hasOwn(client.files, file) ? client.files[file] : undefined;
			if (known === undefined) return notFound();
			let bytes = verified.get(known.sha256);
			if (bytes === undefined) {
				const key = `${grant.sandboxId}\n${known.sha256}`;
				let pending = fetching.get(key);
				if (pending === undefined) {
					const started = fetchFile(grant.sandboxId, file, known.sha256, known.size)
						.catch(() => undefined)
						.then((fetched) => {
							// Only this fetch's own entry is let go of; only checked bytes are kept.
							if (fetching.get(key) === started) fetching.delete(key);
							if (fetched !== undefined) verified.set(known.sha256, fetched);
							return fetched;
						});
					pending = started;
					fetching.set(key, started);
				}
				bytes = await pending;
			}
			if (bytes === undefined) {
				// Not kept: the next request tries again, perhaps in a sandbox whose desktop is up by then.
				return new Response(`The sandbox's desktop isn't up, or isn't Selkies ${client.version} as Kantel ships it.`, {
					status: 502,
					headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
				});
			}
			const extension = file.slice(file.lastIndexOf(".") + 1);
			const headers: Record<string, string> = {
				"content-type": TYPES[extension] ?? "application/octet-stream",
				"content-length": String(bytes.length),
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				// The page is the ticket's, so it isn't kept; its files are the same for every ticket.
				"cache-control": file === "index.html" ? "no-store" : "private, max-age=3600, immutable",
			};
			return new Response(request.method === "HEAD" ? null : bytes.slice(), { headers });
		},

		async socket(raw) {
			const url = new URL(raw, "http://gateway");
			const target = parseDesktopPath(url.pathname);
			if (target === undefined) return undefined;
			const grant = await grantOf(target.ticket);
			if (grant === undefined || target.rest !== DESKTOP_SOCKET) return "refused";
			if (grant.desktop === "view") {
				// The client's own query (a role, a player slot, a token) never reaches Selkies.
				return {
					sandboxId: grant.sandboxId,
					port: DESKTOP_PORT,
					path: `${DESKTOP_SOCKET}?role=viewer`,
					accept: viewerMessage,
					grant,
				};
			}
			return { sandboxId: grant.sandboxId, port: DESKTOP_PORT, path: `${DESKTOP_SOCKET}${url.search}`, grant };
		},
	};
}
