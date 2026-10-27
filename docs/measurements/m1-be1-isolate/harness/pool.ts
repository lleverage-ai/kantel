// Checks and measures the isolate host's pre-loaded pool (images/isolate-host)
// as built: its own sources and config.capnp, with ISOLATE_POOL_SIZE unset (the
// pool, 4) and 0 (one isolate loaded per session, as in M0).
//
//   bun docs/measurements/m1-be1-isolate/harness/pool.ts --check
//   bun docs/measurements/m1-be1-isolate/harness/pool.ts --runs 50 --rounds 2
//
// Run by hand only. It builds into harness/dist-host/ (git-ignored), starts
// workerd with a fake vault proxy on a local port, seeds one workspace (as
// apps/selfhosted/src/measure.ts does) into the compose stack's MinIO under
// m1-be1-isolate/workspaces/<run>/, and deletes it afterwards.
//
// --check runs the behaviour checks in both modes: listing, lazy reads and
// writes, per-session egress tagging, refusing a blob name that isn't a
// SHA-256 digest, the pool refilling, and the switch's values.
//
// The measurement follows M0 (apps/selfhosted/src/measure.ts): one warm-up not
// recorded, then per run a new session's /list (isolate.ready), another new
// session's first command (isolate.first) and that session's second
// (isolate.warm). Host load is read before every run. Two cadences:
//   back-to-back  the next run starts as soon as the last ended, as in M0
//   paced         the next run waits until the pool is full again (arrivals
//                 slower than the refill rate); the same as back-to-back when off

if (process.env.CI) {
	console.error("pool.ts is a hand-run measurement harness; refusing to run under CI");
	process.exit(1);
}

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { S3Client, type Subprocess } from "bun";

const { values } = parseArgs({
	options: {
		check: { type: "boolean", default: false },
		runs: { type: "string", default: "50" },
		rounds: { type: "string", default: "1" },
		modes: { type: "string", default: "off,pool" },
		cadences: { type: "string", default: "back-to-back,paced" },
		"s3-endpoint": { type: "string", default: "http://127.0.0.1:59100" },
	},
});
const runs = Number(values.runs);
const rounds = Number(values.rounds);
const nproc = availableParallelism();

const harness = import.meta.dir;
const repo = join(harness, "../../../..");
const isolateHost = join(repo, "images/isolate-host");
const workerd: string = (await import(Bun.resolveSync("workerd", isolateHost))).default;

// --- Build: the image's sources and config, unchanged, into dist-host/ --------

const out = join(harness, "dist-host");
mkdirSync(join(out, "dist"), { recursive: true });
copyFileSync(join(isolateHost, "config.capnp"), join(out, "config.capnp"));
// The same options as images/isolate-host/build.ts.
const common = { target: "browser" as const, format: "esm" as const, minify: true, outdir: join(out, "dist") };
for (const [entry, naming, external] of [
	["src/sandbox.ts", "sandbox.js", []],
	["src/loader.ts", "loader.js", ["harbour-sandbox-bundle"]],
] as const) {
	const result = await Bun.build({
		...common,
		entrypoints: [join(isolateHost, entry)],
		naming,
		external: ["cloudflare:workers", "node:*", ...external],
	});
	if (!result.success) throw new AggregateError(result.logs, `${naming} build failed`);
}

// --- MinIO: this run's workspace only -----------------------------------------

const s3 = {
	endpoint: values["s3-endpoint"],
	bucket: "harbour",
	prefix: "m1-be1-isolate",
	accessKeyId: "harbour",
	secretAccessKey: "harbour-dev-secret",
};
const client = new S3Client({ ...s3, region: "us-east-1" });
const tag = `pool-${crypto.randomUUID()}`;
const workspaceId = `${tag}-ws`;
const ours = `${s3.prefix}/workspaces/${workspaceId}/`;
const uploads: Promise<unknown>[] = [];
let stopping = false;

type Manifest = Record<string, { kind: "file"; sha: string; size: number; mode: number } | { kind: "dir" }>;

async function seed(): Promise<{ version: string; manifest: Manifest; file0: string }> {
	const manifest: Manifest = {};
	const writes: Promise<unknown>[] = [];
	let file0 = "";
	for (let i = 0; i < 300; i++) {
		const dir = `src/pkg${i % 10}/mod${i % 7}`;
		manifest.src = { kind: "dir" };
		manifest[`src/pkg${i % 10}`] = { kind: "dir" };
		manifest[dir] = { kind: "dir" };
		const bytes = new TextEncoder().encode(`// file ${i}\n${"x".repeat(4096 - 20)}\n`);
		const sha = createHash("sha256").update(bytes).digest("hex");
		if (i === 0) file0 = sha;
		manifest[`${dir}/file${i}.ts`] = { kind: "file", sha, size: bytes.length, mode: 0o644 };
		writes.push(client.write(`${ours}blobs/${sha}`, bytes));
	}
	const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
	const version = `v-${createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16)}`;
	writes.push(client.write(`${ours}manifests/${version}.json`, JSON.stringify(sorted)));
	uploads.push(...writes);
	const failed = (await Promise.allSettled(writes)).find((write) => write.status === "rejected");
	if (failed) throw failed.reason;
	return { version, manifest: sorted, file0 };
}

async function cleanUp(): Promise<number> {
	let deleted = 0;
	for (;;) {
		const page = await client.list({ prefix: ours, maxKeys: 1000 });
		const keys = (page.contents ?? []).map((object) => object.key);
		if (keys.length === 0) return deleted;
		await Promise.all(keys.map((name) => client.delete(name)));
		deleted += keys.length;
	}
}

// --- A fake vault proxy: records what reaches it -------------------------------

// workerd speaks to it as an HTTP forward proxy (an absolute URL on the request
// line), which Bun.serve refuses, so this reads the request head off the socket.
const vaultSeen: { url: string; session?: string; tier?: string; hostKey?: string }[] = [];
const vault = Bun.listen<{ head: string }>({
	hostname: "127.0.0.1",
	port: 0,
	socket: {
		open(socket) {
			socket.data = { head: "" };
		},
		data(socket, chunk) {
			socket.data.head += new TextDecoder().decode(chunk);
			const end = socket.data.head.indexOf("\r\n\r\n");
			if (end < 0) return;
			const [line = "", ...lines] = socket.data.head.slice(0, end).split("\r\n");
			const headers = new Map(
				lines.map((header) => {
					const colon = header.indexOf(":");
					return [header.slice(0, colon).trim().toLowerCase(), header.slice(colon + 1).trim()] as const;
				}),
			);
			vaultSeen.push({
				url: line.split(" ")[1] ?? "",
				session: headers.get("x-harbour-session"),
				tier: headers.get("x-harbour-tier"),
				hostKey: headers.get("x-harbour-host-key"),
			});
			socket.end(
				"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvault-ok\n",
			);
		},
	},
});

// --- workerd -------------------------------------------------------------------

let host: Subprocess | undefined;

function freePort(): number {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = server.port!;
	server.stop(true);
	return port;
}

/** poolSize undefined leaves ISOLATE_POOL_SIZE unset, so the host's default applies. */
async function startHost(poolSize: string | undefined): Promise<string> {
	if (stopping) throw new Error("stopping: no new workerd");
	const port = freePort();
	const env: Record<string, string | undefined> = {
		...process.env,
		S3_ENDPOINT: s3.endpoint,
		S3_BUCKET: `${s3.bucket}/${s3.prefix}`,
		S3_ACCESS_KEY: s3.accessKeyId,
		S3_SECRET_KEY: s3.secretAccessKey,
		VAULT_ISOLATE_KEY: "m1-be1-pool-check",
	};
	delete env.ISOLATE_POOL_SIZE;
	if (poolSize !== undefined) env.ISOLATE_POOL_SIZE = poolSize;
	host = Bun.spawn(
		[
			workerd,
			"serve",
			join(out, "config.capnp"),
			"--experimental",
			`--socket-addr=http=127.0.0.1:${port}`,
			`--external-addr=vault=127.0.0.1:${vault.port}`,
		],
		{ env, stdout: "inherit", stderr: "inherit" },
	);
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(`${base}/healthz`)).ok) return base;
		} catch {}
		await Bun.sleep(25);
	}
	throw new Error("workerd did not answer /healthz");
}

async function stopHost(): Promise<void> {
	if (!host) return;
	host.kill("SIGTERM");
	await host.exited;
	host = undefined;
}

let tearingDown: Promise<number> | undefined;
const tearDown = () => {
	stopping = true;
	tearingDown ??= (async () => {
		await Promise.allSettled(uploads);
		await stopHost();
		vault.stop(true);
		vault.unref();
		return cleanUp();
	})();
	return tearingDown;
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopping = true;
		console.error(`${signal}: stopping workerd and deleting ${ours}`);
		void tearDown()
			.catch((error) => console.error("clean-up failed:", error))
			.finally(() => process.exit(130));
	});
}

// --- Calls -----------------------------------------------------------------------

interface Health {
	ok: boolean;
	pool?: { size: number; idle: number; sessions: number };
}

const health = async (base: string) => (await (await fetch(`${base}/healthz`)).json()) as Health;

/** Until the pool holds `size` idle isolates (each /healthz also asks for a refill). */
async function poolFull(base: string, size: number): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if ((await health(base)).pool?.idle === size) return;
		await Bun.sleep(10);
	}
	throw new Error("the pool did not fill");
}

async function post(base: string, path: string, body: unknown) {
	const started = performance.now();
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
	const json = (await response.json()) as Record<string, unknown> & { error?: string };
	return {
		ms: Math.round((performance.now() - started) * 10) / 10,
		status: response.status,
		isolate: response.headers.get("x-harbour-isolate") ?? undefined,
		json,
	};
}

async function ok(base: string, path: string, body: unknown) {
	const result = await post(base, path, body);
	if (result.status !== 200 || result.json.error) throw new Error(`${path}: ${result.json.error ?? result.status}`);
	return result;
}

// --- Checks ----------------------------------------------------------------------

function expect(condition: boolean, what: string): void {
	if (!condition) throw new Error(`check failed: ${what}`);
	console.error(`ok   ${what}`);
}

async function check(mode: string, poolSize: string | undefined, seeded: Awaited<ReturnType<typeof seed>>) {
	const base = await startHost(poolSize);
	try {
		const size = poolSize === undefined ? 4 : Number(poolSize);
		const first = await health(base);
		expect(first.pool?.size === size, `${mode}: /healthz reports pool size ${size}`);
		if (size > 0) await poolFull(base, size);
		const session = (name: string) => `${tag}-${mode}-${name}`;
		const body = (name: string) => ({ sessionId: session(name), workspaceId, version: seeded.version });

		const listed = await ok(base, "/list", body("a"));
		expect(listed.json.entries === Object.keys(seeded.manifest).length, `${mode}: a new session lists 381 entries`);
		if (size > 0) {
			await poolFull(base, size);
			expect((await health(base)).pool?.sessions === 1, `${mode}: the pool refills after a hand-out`);
		}

		const read = await ok(base, "/exec", {
			...body("a"),
			command: "head -c 9 src/pkg0/mod0/file0.ts; echo written > out.txt",
		});
		expect(read.json.stdout === "// file 0", `${mode}: a command reads a file body lazily through the workspace`);
		const manifest = read.json.manifest as Manifest;
		const written = manifest["out.txt"];
		expect(
			written?.kind === "file" && (await client.exists(`${ours}blobs/${written.sha}`)),
			`${mode}: a written file is put into this workspace's blobs`,
		);

		vaultSeen.length = 0;
		for (const name of ["a", "b"]) {
			const out = await ok(base, "/exec", { ...body(name), command: "curl -sS http://vault.test/ping" });
			expect(
				out.json.stdout === "vault-ok\n",
				`${mode}: session ${name}'s curl goes out through the vault${out.json.stdout === "vault-ok\n" ? "" : ` (${JSON.stringify({ exitCode: out.json.exitCode, stdout: out.json.stdout, stderr: out.json.stderr })} ${JSON.stringify(vaultSeen)})`}`,
			);
		}
		expect(
			vaultSeen.length === 2 &&
				vaultSeen[0]?.session === session("a") &&
				vaultSeen[1]?.session === session("b") &&
				vaultSeen.every((seen) => seen.tier === "isolate" && seen.hostKey === "m1-be1-pool-check"),
			`${mode}: the vault sees each session's own ID, tier and host key`,
		);

		const evil: Manifest = {
			"evil.ts": { kind: "file", sha: `../../${workspaceId}/blobs/${seeded.file0}`, size: 4096, mode: 0o644 },
		};
		const refused = await post(base, "/exec", { ...body("c"), manifest: evil, command: "cat evil.ts" });
		expect(
			refused.status !== 200 || (refused.json.exitCode !== 0 && !String(refused.json.stdout).includes("// file 0")),
			`${mode}: a blob name that isn't a SHA-256 digest is refused`,
		);
	} finally {
		await stopHost();
	}
}

async function checkSwitch() {
	for (const [value, size] of [
		["", 4],
		["0", 0],
		["2", 2],
		["abc", 0],
		["65", 0],
	] as const) {
		const base = await startHost(value);
		try {
			expect((await health(base)).pool?.size === size, `ISOLATE_POOL_SIZE="${value}" gives pool size ${size}`);
		} finally {
			await stopHost();
		}
	}
}

// --- Measuring -------------------------------------------------------------------

function load() {
	const [load1, load5, load15] = readFileSync("/proc/loadavg", "utf8").split(" ").map(Number) as [
		number,
		number,
		number,
	];
	return { load1, load5, load15 };
}

const pct = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};
const summarise = (values: number[]) => ({
	p50: pct(values, 50),
	p95: pct(values, 95),
	min: Math.min(...values),
	max: Math.max(...values),
});

/** A batch looks skewed when the host's load moved a lot during it, or sat above three quarters of its threads. */
const skewed = (loads: number[]) => Math.max(...loads) > nproc * 0.75 || Math.max(...loads) - Math.min(...loads) > 6;

async function batch(mode: "off" | "pool", cadence: string, round: number, seeded: Awaited<ReturnType<typeof seed>>) {
	const poolSize = mode === "off" ? "0" : undefined;
	const base = await startHost(poolSize);
	try {
		const size = (await health(base)).pool?.size ?? 0;
		const body = (sessionId: string) => ({ sessionId, workspaceId, version: seeded.version });
		const command = "ls -R | wc -l";
		const prefix = `${tag}-${mode}-${cadence}-${round}`;
		if (size > 0) await poolFull(base, size);
		// Warm-up, not recorded.
		await ok(base, "/list", body(`${prefix}-warmup`));
		await ok(base, "/exec", { ...body(`${prefix}-warmup`), command });
		const before = load();
		const rows: {
			load1: number;
			ready: number;
			first: number;
			warm: number;
			isolate: { ready?: string; first?: string; warm?: string };
			serverReady: Record<string, number>;
		}[] = [];
		for (let i = 0; i < runs; i++) {
			if (stopping) throw new Error("stopping");
			// Back-to-back sends nothing between runs: a health probe would wait out a refill load.
			if (size > 0 && cadence === "paced") await poolFull(base, size);
			const { load1 } = load();
			const ready = await ok(base, "/list", body(`${prefix}-iso-${i}`));
			if (ready.json.entries !== 381) throw new Error("listing mismatch");
			if (size > 0 && cadence === "paced") await poolFull(base, size);
			const first = await ok(base, "/exec", { ...body(`${prefix}-first-${i}`), command });
			if (String(first.json.stdout).trim() === "") throw new Error("first command printed nothing");
			const warm = await ok(base, "/exec", { ...body(`${prefix}-first-${i}`), command });
			rows.push({
				load1,
				ready: ready.ms,
				first: first.ms,
				warm: warm.ms,
				isolate: { ready: ready.isolate, first: first.isolate, warm: warm.isolate },
				serverReady: ready.json.timings as Record<string, number>,
			});
		}
		const after = load();
		const loads = [before.load1, ...rows.map((row) => row.load1), after.load1];
		const result = {
			mode,
			cadence,
			round,
			poolSize: size,
			load: { before, after, min: Math.min(...loads), max: Math.max(...loads), nproc },
			skewed: skewed(loads),
			poolHits: {
				ready: rows.filter((row) => row.isolate.ready === "pool-hit").length,
				first: rows.filter((row) => row.isolate.first === "pool-hit").length,
			},
			summary: {
				"isolate.ready": summarise(rows.map((row) => row.ready)),
				"isolate.first": summarise(rows.map((row) => row.first)),
				"isolate.warm": summarise(rows.map((row) => row.warm)),
			},
			runs: rows,
		};
		const { p50, p95 } = result.summary["isolate.ready"];
		console.error(
			`${mode} ${cadence} round ${round}: ready p50 ${p50} p95 ${p95} ms (hits ${result.poolHits.ready}), first p50 ${result.summary["isolate.first"].p50}, warm p50 ${result.summary["isolate.warm"].p50}, load1 ${result.load.min}-${result.load.max}${result.skewed ? " (skewed)" : ""}`,
		);
		return result;
	} finally {
		await stopHost();
	}
}

// --- Main ------------------------------------------------------------------------

const startedAt = new Date().toISOString();
const batches: Awaited<ReturnType<typeof batch>>[] = [];
let deleted = 0;
try {
	const seeded = await seed();
	if (stopping) throw new Error("stopping before the first batch");
	if (values.check) {
		await check("pool", undefined, seeded);
		await check("off", "0", seeded);
		await checkSwitch();
	} else {
		for (let round = 1; round <= rounds; round++) {
			for (const mode of values.modes.split(",") as ("off" | "pool")[]) {
				for (const cadence of values.cadences.split(",")) {
					if (mode === "off" && cadence === "paced") continue;
					batches.push(await batch(mode, cadence, round, seeded));
				}
			}
		}
	}
} finally {
	deleted = await tearDown();
	console.error(`deleted ${deleted} objects under ${s3.bucket}/${ours}`);
}

if (!values.check) {
	const file = join(harness, "../raw", `pool-${startedAt.replaceAll(":", "-").replace(/\..*/, "")}.json`);
	await Bun.write(
		file,
		`${JSON.stringify(
			{
				startedAt,
				finishedAt: new Date().toISOString(),
				host: {
					cpu: cpus()[0]?.model,
					nproc,
					workerd: (await Bun.$`${workerd} --version`.text()).trim(),
					bun: Bun.version,
				},
				isolateRuntime: "workerd on the host, no container (runc or gVisor not involved)",
				source: "images/isolate-host/src and config.capnp, built as build.ts does",
				workspace: { files: 300, fileBytes: 4096, entries: 381 },
				minio: { prefix: `${s3.bucket}/${ours}`, deletedAfter: deleted },
				batches,
			},
			null,
			"\t",
		)}\n`,
	);
	console.error(`wrote ${file}`);
}
