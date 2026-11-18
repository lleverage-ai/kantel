// Starts STORE and egress stand-ins and a kantel-isolate process for the integration tests, and tears them down by
// the exact PIDs it started (never by pattern). The binary and assets come from the environment:
//   KANTEL_ISOLATE_BIN     path to the built kantel-isolate (default: target/release/kantel-isolate)
//   KANTEL_ISOLATE_ASSETS  the --assets directory build-assets.sh made (default: $KANTEL_ISOLATE_TEST_ASSETS)
//   KANTEL_ISOLATE_TEST_PORT  the first port of the range the suite uses (default 29310; it takes the next 34)
// If neither the binary nor the assets (with a Pyodide snapshot) are present, `available()` is false and the suite
// skips with a message, so `pnpm test` without a Rust build doesn't fail.
//
// `start({ unix: true })` runs native mode's transport instead: the runtime listens on, and reaches the store and the
// egress proxy over, Unix sockets in one 0700 temp dir (as kantel-host's per-account dir), so seccomp allows it only
// AF_UNIX sockets and Landlock no TCP. The egress stand-in speaks proxy-style HTTP on its socket, as kantel-host's
// does; only the test upstream it forwards to is on TCP (the host's side). With `netns` too, the runtime is started in
// its own network namespace (unshare --user --map-current-user --net), so that namespace's /proc/<pid>/net/{tcp,udp}*
// tables list only its sockets.

import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";

const crateDir = resolve(import.meta.dir, "..");
export const BIN = process.env.KANTEL_ISOLATE_BIN || resolve(crateDir, "target/release/kantel-isolate");
export const ASSETS = process.env.KANTEL_ISOLATE_ASSETS || process.env.KANTEL_ISOLATE_TEST_ASSETS || "";

export function available(): string | true {
	if (!existsSync(BIN)) return `kantel-isolate not built at ${BIN} (set KANTEL_ISOLATE_BIN)`;
	if (!ASSETS || !existsSync(resolve(ASSETS, "python.snapshot")))
		return `assets with a Pyodide snapshot not found (set KANTEL_ISOLATE_ASSETS)`;
	return true;
}

// The first of the ports the suite uses (each harness takes four, from its basePort); set KANTEL_ISOLATE_TEST_PORT to
// move them when another run holds the default range.
export const BASE = Number(process.env.KANTEL_ISOLATE_TEST_PORT) || 29310;

export interface Harness {
	rt: string;
	store: string;
	/** Unix mode: the sockets' 0700 directory and the runtime's and store's sockets (fetch with `{ unix }`). */
	socketDir?: string;
	rtSocket?: string;
	storeSocket?: string;
	upstreamHits: { sandbox: string | null; path: string }[];
	sandboxFor: Map<string, string>; // sandbox id the proxy last saw per path
	stop(): Promise<void>;
	pid: number;
}

export async function start(
	opts: {
		cpuMs?: number;
		pool?: number;
		maxSandboxes?: number;
		basePort?: number;
		/** Unix-socket transport for --listen, --store and --egress (see the header). */
		unix?: boolean;
		/** Unix mode only: start the runtime in its own network namespace. */
		netns?: boolean;
	} = {},
): Promise<Harness> {
	const base = opts.basePort ?? BASE;
	const ports = { store: base, egress: base + 1, upstream: base + 2, rt: base + 3 };
	const socketDir = opts.unix ? mkdtempSync(join(tmpdir(), "kt-isolate-sockets-")) : undefined;
	if (socketDir) chmodSync(socketDir, 0o700);
	const sock = socketDir
		? { store: join(socketDir, "store.sock"), egress: join(socketDir, "egress.sock"), rt: join(socketDir, "rt.sock") }
		: undefined;
	// Where a stand-in listens: its Unix socket in Unix mode, else its loopback port.
	const at = (unix: string | undefined, port: number) => (unix ? { unix } : { port, hostname: "127.0.0.1" as const });
	const upstreamHits: { sandbox: string | null; path: string }[] = [];
	const blobs = new Map<string, Uint8Array>();
	const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

	const store = Bun.serve({
		...at(sock?.store, ports.store),
		maxRequestBodySize: 1 << 30,
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method === "PUT" && url.pathname === "/blobs") {
				const bytes = new Uint8Array(await req.arrayBuffer());
				const sha = hex(await crypto.subtle.digest("SHA-256", bytes));
				blobs.set(sha, bytes);
				return Response.json({ sha });
			}
			const m = /^\/blobs\/([0-9a-f]{64})$/.exec(url.pathname);
			if (req.method === "GET" && m) {
				const b = blobs.get(m[1]);
				return b ? new Response(b) : new Response("not found", { status: 404 });
			}
			return new Response("not found", { status: 404 });
		},
	});
	// Proxy-style: the runtime sends the absolute URL as the request target (over TCP or the Unix socket alike).
	const egress = Bun.serve({
		...at(sock?.egress, ports.egress),
		async fetch(req) {
			const sandbox = req.headers.get("kantel-isolate-sandbox");
			if (!sandbox) return new Response("no sandbox\n", { status: 403 });
			const headers = new Headers(req.headers);
			for (const k of [...headers.keys()]) if (k.startsWith("kantel-")) headers.delete(k);
			// Forward to the test upstream, recording which sandbox the proxy was told.
			const url = new URL(req.url);
			upstreamHits.push({ sandbox, path: url.pathname });
			const target = `http://127.0.0.1:${ports.upstream}${url.pathname}${url.search}`;
			return fetch(target, {
				method: req.method,
				headers,
				body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
				redirect: "manual",
			});
		},
	});
	const upstream = Bun.serve({
		port: ports.upstream,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/json") return Response.json({ hello: "world", n: 7 });
			if (url.pathname === "/echo") return new Response(req.body, { status: 200 });
			if (url.pathname === "/echo-auth") return new Response(req.headers.get("authorization") ?? "none");
			if (url.pathname === "/redirect-cross")
				return new Response(null, { status: 302, headers: { location: "http://b.test/echo-auth" } });
			if (url.pathname === "/redirect-same")
				return new Response(null, {
					status: 302,
					headers: { location: `http://${req.headers.get("x-origin-host") ?? "a.test"}/echo-auth` },
				});
			// /redirect/<status> answers that redirect to /method-echo, which echoes what arrived: the method, the
			// content type and the body.
			const redirect = /^\/redirect\/(\d{3})$/.exec(url.pathname);
			if (redirect) return new Response(null, { status: Number(redirect[1]), headers: { location: "/method-echo" } });
			if (url.pathname === "/method-echo")
				return new Response(
					`${req.method} ${req.headers.get("content-type") ?? "none"} ${req.method === "HEAD" ? "" : await req.text()}`,
				);
			if (url.pathname === "/stream-forever") {
				const stream = new ReadableStream({
					async pull(c) {
						c.enqueue(new Uint8Array(64 * 1024));
						await Bun.sleep(5);
					},
				});
				return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
			}
			if (url.pathname === "/slow") {
				await Bun.sleep(1500);
				return new Response("done\n");
			}
			return new Response(`upstream ${req.method} ${url.pathname}\n`);
		},
	});

	const netns = opts.unix && opts.netns ? ["unshare", "--user", "--map-current-user", "--net", "--"] : [];
	const proc = spawn({
		cmd: [
			...netns,
			BIN,
			"serve",
			"--listen",
			sock ? `unix:${sock.rt}` : `127.0.0.1:${ports.rt}`,
			"--store",
			sock ? `unix:${sock.store}` : `http://127.0.0.1:${ports.store}`,
			"--egress",
			sock ? `unix:${sock.egress}` : `http://127.0.0.1:${ports.egress}`,
			"--assets",
			ASSETS,
			"--pool",
			String(opts.pool ?? 2),
			"--node-pool",
			"2",
			"--python-pool",
			"1",
			"--cpu-ms",
			String(opts.cpuMs ?? 2000),
			"--max-sandboxes",
			String(opts.maxSandboxes ?? 64),
			"--log-format",
			"text",
		],
		// Not "pipe": nothing drains it, and a full pipe would block the server. Set KANTEL_ISOLATE_TEST_LOG to see it.
		stdout: process.env.KANTEL_ISOLATE_TEST_LOG ? "inherit" : "ignore",
		stderr: process.env.KANTEL_ISOLATE_TEST_LOG ? "inherit" : "ignore",
		env: { ...process.env },
	});

	// In Unix mode the host part of these URLs is ignored: requests go over the socket.
	const rt = sock ? "http://kantel-isolate" : `http://127.0.0.1:${ports.rt}`;
	const rtFetch = (path: string, init: RequestInit = {}) =>
		fetch(`${rt}${path}`, sock ? { ...init, unix: sock.rt } : init);
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const h = await rtFetch("/healthz");
			if (h.ok) break;
		} catch {}
		if (Date.now() > deadline) {
			proc.kill();
			throw new Error("kantel-isolate did not become ready");
		}
		await Bun.sleep(150);
	}
	// Wait for the pools (python especially) to be warm, so the first python run isn't a cold boot in a timing test.
	for (let i = 0; i < 100; i++) {
		const h = (await (await rtFetch("/healthz")).json()) as { warm?: boolean };
		if (h.warm) break;
		await Bun.sleep(100);
	}

	return {
		rt,
		store: sock ? "http://store" : `http://127.0.0.1:${ports.store}`,
		socketDir,
		rtSocket: sock?.rt,
		storeSocket: sock?.store,
		upstreamHits,
		sandboxFor: new Map(),
		pid: proc.pid,
		async stop() {
			proc.kill();
			await proc.exited;
			store.stop(true);
			egress.stop(true);
			upstream.stop(true);
			if (socketDir) rmSync(socketDir, { recursive: true, force: true });
		},
	};
}

export function client(h: Harness) {
	// Over the runtime's (or the store's) Unix socket in Unix mode.
	const via = (unix: string | undefined, init: RequestInit): RequestInit => (unix ? { ...init, unix } : init);
	const post = async (path: string, body: unknown) => {
		const r = await fetch(
			`${h.rt}${path}`,
			via(h.rtSocket, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return (await r.json()) as Record<string, unknown>;
	};
	const put = async (bytes: Uint8Array | string) => {
		const r = await fetch(`${h.store}/blobs`, via(h.storeSocket, { method: "PUT", body: bytes }));
		return ((await r.json()) as { sha: string }).sha;
	};
	return {
		post,
		put,
		async fileEntry(s: string) {
			return { kind: "file" as const, sha: await put(s), size: new TextEncoder().encode(s).byteLength, mode: 0o644 };
		},
		load: (sandboxId: string, memoryMiB?: number) => post("/load", { sandboxId, memoryMiB }),
		exec: (sandboxId: string, command: string, manifest: Record<string, unknown> = {}, timeoutMs = 8000) =>
			post("/exec", { sandboxId, command, cwd: "/workspace", env: {}, manifest, timeoutMs }),
		health: async () => (await (await fetch(`${h.rt}/healthz`, via(h.rtSocket, {}))).json()) as Record<string, unknown>,
	};
}
