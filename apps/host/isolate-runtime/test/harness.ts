// Starts STORE and egress stand-ins and a kantel-isolate process for the integration tests, and tears them down by
// the exact PIDs it started (never by pattern). The binary and assets come from the environment:
//   KANTEL_ISOLATE_BIN     path to the built kantel-isolate (default: target/release/kantel-isolate)
//   KANTEL_ISOLATE_ASSETS  the --assets directory build-assets.sh made (default: $KANTEL_ISOLATE_TEST_ASSETS)
// If neither the binary nor the assets (with a Pyodide snapshot) are present, `available()` is false and the suite
// skips with a message, so `pnpm test` without a Rust build doesn't fail.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

const BASE = 29310;

export interface Harness {
	rt: string;
	store: string;
	upstreamHits: { sandbox: string | null; path: string }[];
	sandboxFor: Map<string, string>; // sandbox id the proxy last saw per path
	stop(): Promise<void>;
	pid: number;
}

export async function start(opts: { cpuMs?: number; pool?: number; maxSandboxes?: number; basePort?: number } = {}): Promise<Harness> {
	const base = opts.basePort ?? BASE;
	const ports = { store: base, egress: base + 1, upstream: base + 2, rt: base + 3 };
	const upstreamHits: { sandbox: string | null; path: string }[] = [];
	const blobs = new Map<string, Uint8Array>();
	const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

	const store = Bun.serve({
		port: ports.store,
		hostname: "127.0.0.1",
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
	const egress = Bun.serve({
		port: ports.egress,
		hostname: "127.0.0.1",
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
				return new Response(null, { status: 302, headers: { location: `http://${req.headers.get("x-origin-host") ?? "a.test"}/echo-auth` } });
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

	const proc = spawn({
		cmd: [
			BIN,
			"serve",
			"--listen",
			`127.0.0.1:${ports.rt}`,
			"--store",
			`http://127.0.0.1:${ports.store}`,
			"--egress",
			`http://127.0.0.1:${ports.egress}`,
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

	const rt = `http://127.0.0.1:${ports.rt}`;
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			const h = await fetch(`${rt}/healthz`);
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
		const h = (await (await fetch(`${rt}/healthz`)).json()) as { warm?: boolean };
		if (h.warm) break;
		await Bun.sleep(100);
	}

	return {
		rt,
		store: `http://127.0.0.1:${ports.store}`,
		upstreamHits,
		sandboxFor: new Map(),
		pid: proc.pid,
		async stop() {
			proc.kill();
			await proc.exited;
			store.stop(true);
			egress.stop(true);
			upstream.stop(true);
		},
	};
}

export function client(h: Harness) {
	const post = async (path: string, body: unknown) => {
		const r = await fetch(`${h.rt}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return (await r.json()) as Record<string, unknown>;
	};
	const put = async (bytes: Uint8Array | string) => {
		const r = await fetch(`${h.store}/blobs`, { method: "PUT", body: bytes });
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
		health: async () => (await (await fetch(`${h.rt}/healthz`)).json()) as Record<string, unknown>,
	};
}
