// Isolate readiness on the self-hosted isolate host, measured as M0 did: a
// seeded workspace of 300 files of 4 KB in 81 directories (381 entries), one
// warm-up not recorded, then 50 runs, each a new session. Run by hand with Bun
// from the repository root, with the compose stack's MinIO up:
//
//   bun docs/measurements/m1-be1-isolate/harness/run.ts [--runs 50] [--rounds 2] [--variants a,b,c,d,e,f,g]
//
// It builds images/isolate-host/src (unchanged) and bench-host.ts into
// harness/dist/, seeds MinIO under the key prefix m1-be1-isolate/ in the
// stack's bucket, starts its own workerd for every batch, and writes one JSON
// document to raw/. It deletes what it wrote to MinIO and stops workerd before
// it exits. Not part of `pnpm check` or CI.
//
// Variants (each run is a new session ID):
//   a  today: POST /list, loader.ts's own handler, a new Dynamic Worker per session
//   b  one isolate per workspace: the workspace's isolate is already loaded
//   c  pre-loaded pool: a loaded isolate handed to the session, scope per call
//   d  today's load in phases: manifest read, Dynamic Worker load, listing
//   e  a new Dynamic Worker with a trivial bundle: the fixed cost of an isolate
//   f  a new Dynamic Worker per session that loads just-bash on its first exec
//   g  as c, but the refill starts before the response: a session arriving while another isolate loads
// For a and f the session's first command (ls -R | wc -l) follows, timed apart from readiness.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { S3Client, type Subprocess } from "bun";

// By hand only: it builds bundles, starts workerd and writes to a shared MinIO.
if (process.env.CI) {
	console.error("run.ts is a hand-run measurement harness; refusing to run under CI");
	process.exit(1);
}

const { values } = parseArgs({
	options: {
		runs: { type: "string", default: "50" },
		rounds: { type: "string", default: "2" },
		variants: { type: "string", default: "a,b,c,d,e,f,g" },
		"pool-size": { type: "string", default: "4" },
		"max-attempts": { type: "string", default: "3" },
		"s3-endpoint": { type: "string", default: "http://127.0.0.1:59100" },
	},
});
const runs = Number(values.runs);
const rounds = Number(values.rounds);
const variants = values.variants.split(",") as Variant[];
const poolSize = Number(values["pool-size"]);
const maxAttempts = Number(values["max-attempts"]);

const harness = import.meta.dir;
const repo = join(harness, "../../../..");
const isolateHost = join(repo, "images/isolate-host");
// The workerd binary itself (the npm package's main export), not its node shim, so stopping it stops workerd.
const workerd: string = (await import(Bun.resolveSync("workerd", isolateHost))).default;

// MinIO from deploy/compose/compose.yaml. Only the key prefix m1-be1-isolate/ is ours.
const s3 = {
	endpoint: values["s3-endpoint"],
	bucket: "harbour",
	prefix: "m1-be1-isolate",
	accessKeyId: "harbour",
	secretAccessKey: "harbour-dev-secret",
};

type Variant = "a" | "b" | "c" | "d" | "e" | "f" | "g";
const variantNames: Record<Variant, string> = {
	a: "today: new Dynamic Worker per session, workspace listed",
	b: "one isolate per workspace, already loaded",
	c: "pre-loaded pool, scope per call",
	d: "today, in phases",
	e: "new Dynamic Worker, trivial bundle",
	f: "new Dynamic Worker per session, just-bash loaded on first exec",
	g: "pre-loaded pool, refill starts before the response",
};
const routes: Record<Variant, string> = {
	a: "/list",
	b: "/bench/per-workspace",
	c: "/bench/pool",
	d: "/bench/split",
	e: "/bench/trivial",
	f: "/bench/lazy",
	g: "/bench/pool",
};
/** The session's first command after readiness, for the variants that time it. */
const firstExecRoutes: Partial<Record<Variant, string>> = { a: "/exec", f: "/bench/lazy/exec" };

// A batch is skewed, and run again, when the host is busy (load1 above 0.75 per
// thread at any sample) or its load moves a lot while it runs (load1 changes by
// more than 0.25 per thread between the first and last sample).
const nproc = availableParallelism();
const skewLoad = 0.75 * nproc;
const skewDelta = 0.25 * nproc;

// --- Build -------------------------------------------------------------------

/** Resolve the harness's own bare imports (aws4fetch) from images/isolate-host, as loader.ts's are. */
const fromIsolateHost: Bun.BunPlugin = {
	name: "from-isolate-host",
	setup(build) {
		build.onResolve({ filter: /^aws4fetch$/ }, (args) => ({ path: Bun.resolveSync(args.path, isolateHost) }));
	},
};

async function bundle(entry: string, naming: string, external: string[] = []) {
	const result = await Bun.build({
		entrypoints: [entry],
		plugins: [fromIsolateHost],
		outdir: join(harness, "dist"),
		naming,
		target: "browser",
		format: "esm",
		minify: true,
		external: ["cloudflare:workers", "node:*", ...external],
	});
	if (!result.success) throw new AggregateError(result.logs, `${naming} build failed`);
	return result.outputs[0]!.size;
}

const bundles = {
	"sandbox.js": await bundle(join(isolateHost, "src/sandbox.ts"), "sandbox.js"),
	"pooled-sandbox.js": await bundle(join(harness, "pooled-sandbox.ts"), "pooled-sandbox.js"),
	"trivial-sandbox.js": await bundle(join(harness, "trivial-sandbox.ts"), "trivial-sandbox.js"),
	"lazy-sandbox.js": await bundle(join(harness, "lazy-sandbox.ts"), "lazy-sandbox.js"),
	"bench-host.js": await bundle(join(harness, "bench-host.ts"), "bench-host.js", [
		"harbour-sandbox-bundle",
		"harbour-pooled-sandbox-bundle",
		"harbour-trivial-bundle",
		"harbour-lazy-sandbox-bundle",
	]),
};

// --- Seed --------------------------------------------------------------------

const client = new S3Client({
	endpoint: s3.endpoint,
	bucket: s3.bucket,
	accessKeyId: s3.accessKeyId,
	secretAccessKey: s3.secretAccessKey,
	region: "us-east-1",
});
const tag = `bench-${crypto.randomUUID()}`;
const workspaceId = `${tag}-ws`;
const key = (path: string) => `${s3.prefix}/workspaces/${workspaceId}/${path}`;

type Manifest = Record<string, { kind: "file"; sha: string; size: number; mode: number } | { kind: "dir" }>;

/** Only this invocation's workspace: a concurrent run's objects are left alone. */
const ours = `${s3.prefix}/workspaces/${workspaceId}/`;
/** Every upload this run started; clean-up waits for them all, so none lands after it. */
const uploads: Promise<unknown>[] = [];
/** Set (synchronously) by teardown: no further workerd or batch starts. */
let stopping = false;

/** The same workspace as apps/selfhosted/src/measure.ts seeds. */
async function seed(fileCount = 300, fileBytes = 4096): Promise<{ version: string; manifest: Manifest }> {
	const manifest: Manifest = {};
	const writes: Promise<unknown>[] = [];
	for (let i = 0; i < fileCount; i++) {
		const dir = `src/pkg${i % 10}/mod${i % 7}`;
		manifest.src = { kind: "dir" };
		manifest[`src/pkg${i % 10}`] = { kind: "dir" };
		manifest[dir] = { kind: "dir" };
		const bytes = new TextEncoder().encode(`// file ${i}\n${"x".repeat(fileBytes - 20)}\n`);
		const sha = createHash("sha256").update(bytes).digest("hex");
		manifest[`${dir}/file${i}.ts`] = { kind: "file", sha, size: bytes.length, mode: 0o644 };
		writes.push(client.write(key(`blobs/${sha}`), bytes));
	}
	uploads.push(...writes);
	const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
	const version = `v-${createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16)}`;
	const manifestWrite = client.write(key(`manifests/${version}.json`), JSON.stringify(sorted));
	writes.push(manifestWrite);
	uploads.push(manifestWrite);
	// Every write settles before a failure surfaces, so clean-up never races an upload still in flight.
	const failed = (await Promise.allSettled(writes)).find((write) => write.status === "rejected");
	if (failed) throw failed.reason;
	return { version, manifest: sorted };
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

// --- workerd -----------------------------------------------------------------

let host: Subprocess | undefined;

function freePort(): number {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = server.port!;
	server.stop(true);
	return port;
}

async function startHost(): Promise<string> {
	if (stopping) throw new Error("stopping: no new workerd");
	const port = freePort();
	host = Bun.spawn(
		[workerd, "serve", join(harness, "config.capnp"), "--experimental", `--socket-addr=http=127.0.0.1:${port}`],
		{
			env: {
				...process.env,
				S3_ENDPOINT: s3.endpoint,
				S3_BUCKET: `${s3.bucket}/${s3.prefix}`,
				S3_ACCESS_KEY: s3.accessKeyId,
				S3_SECRET_KEY: s3.secretAccessKey,
			},
			stdout: "inherit",
			stderr: "inherit",
		},
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

// --- Measuring -----------------------------------------------------------------

interface Load {
	load1: number;
	load5: number;
	load15: number;
	nproc: number;
	at: string;
}

function load(): Load {
	const [load1, load5, load15] = readFileSync("/proc/loadavg", "utf8").split(" ").map(Number) as [
		number,
		number,
		number,
	];
	return { load1, load5, load15, nproc, at: new Date().toISOString() };
}

interface Run {
	ms: number;
	entries: number;
	exitCode?: number;
	poolHit?: boolean;
	timings: Record<string, number>;
	/** The session's first command after readiness: client ms and server phases. */
	firstExec?: { ms: number; timings: Record<string, number> };
}

async function call(base: string, path: string, body: unknown): Promise<Run> {
	const started = performance.now();
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});
	const json = (await response.json()) as Omit<Run, "ms"> & { error?: string };
	const ms = Math.round((performance.now() - started) * 10) / 10;
	if (!response.ok || json.error) throw new Error(`${path}: ${json.error ?? response.status}`);
	if (json.timings === undefined) throw new Error(`${path}: no timings`);
	return {
		ms,
		entries: json.entries,
		...(json.exitCode === undefined ? {} : { exitCode: json.exitCode }),
		...(json.poolHit === undefined ? {} : { poolHit: json.poolHit }),
		timings: json.timings,
	};
}

const pct = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

function summarise(values: number[]) {
	return { p50: pct(values, 50), p95: pct(values, 95), min: Math.min(...values), max: Math.max(...values) };
}

async function batch(variant: Variant, seeded: { version: string; manifest: Manifest }) {
	const base = await startHost();
	try {
		const body = (sessionId: string) => ({
			sessionId,
			workspaceId,
			version: seeded.version,
			...(variant === "g" ? { refill: "now" } : {}),
		});
		const expected = variant === "e" ? 0 : Object.keys(seeded.manifest).length;
		const fill = () => call(base, "/bench/pool/fill", { ...body("fill"), size: poolSize });
		const before = load();
		// Warm-up, not recorded: first connections, and for b the workspace's isolate.
		const pooled = variant === "c" || variant === "g";
		if (pooled) await fill();
		await call(base, routes[variant], body(`${tag}-${variant}-warmup`));
		const measured: Run[] = [];
		const samples: number[] = [before.load1];
		for (let i = 0; i < runs; i++) {
			if (i > 0 && i % 10 === 0) samples.push(load().load1);
			// The pool is refilled in the background after each hand-out; a session
			// arrives once it is full again, as at any rate below the refill rate.
			if (pooled) await fill();
			const sessionId = `${tag}-${variant}-${crypto.randomUUID()}`;
			const run = await call(base, routes[variant], body(sessionId));
			if (run.entries !== expected) throw new Error(`${variant}: listed ${run.entries}, expected ${expected}`);
			const firstExecRoute = firstExecRoutes[variant];
			if (firstExecRoute) {
				const exec = await call(base, firstExecRoute, { ...body(sessionId), command: "ls -R | wc -l" });
				if (exec.exitCode !== 0) throw new Error(`${variant}: first command exited ${exec.exitCode}`);
				run.firstExec = { ms: exec.ms, timings: exec.timings };
			}
			measured.push(run);
		}
		const after = load();
		samples.push(after.load1);
		const skewed = Math.max(...samples) > skewLoad || Math.abs(after.load1 - before.load1) > skewDelta;
		const phases: Record<string, ReturnType<typeof summarise>> = {};
		for (const name of Object.keys(measured[0]!.timings))
			phases[name] = summarise(measured.map((run) => run.timings[name] ?? 0));
		return {
			variant,
			name: variantNames[variant],
			load: { before, after, load1Samples: samples },
			skewed,
			summary: {
				runs: measured.length,
				...summarise(measured.map((run) => run.ms)),
				...(pooled ? { poolHits: measured.filter((run) => run.poolHit).length } : {}),
				serverPhases: phases,
				...(firstExecRoutes[variant]
					? { firstExec: summarise(measured.map((run) => run.firstExec?.ms ?? Number.NaN)) }
					: {}),
			},
			raw: measured,
		};
	} finally {
		await stopHost();
	}
}

/** Stops workerd and deletes this run's objects, once, however the run ends. */
let tearingDown: Promise<number> | undefined;
const tearDown = () => {
	stopping = true;
	tearingDown ??= (async () => {
		await Promise.allSettled(uploads);
		await stopHost();
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

const startedAt = new Date().toISOString();
const batches: Awaited<ReturnType<typeof batch>>[] = [];
let deleted = 0;
try {
	const seeded = await seed();
	if (stopping) throw new Error("stopping before the first batch");
	console.error(`seeded ${workspaceId}@${seeded.version}: ${Object.keys(seeded.manifest).length} entries`);
	for (let round = 1; round <= rounds; round++) {
		for (const variant of variants) {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				if (stopping) throw new Error("stopping: no further batches");
				const result = { round, attempt, ...(await batch(variant, seeded)) };
				batches.push(result);
				const { p50, p95 } = result.summary;
				console.error(
					`round ${round} ${variant} attempt ${attempt}: p50 ${p50} p95 ${p95} ms, load ${result.load.before.load1} -> ${result.load.after.load1}${result.skewed ? " (skewed)" : ""}`,
				);
				if (!result.skewed) break;
				await Bun.sleep(30_000);
			}
		}
	}
} finally {
	deleted = await tearDown();
	console.error(`deleted ${deleted} objects under ${s3.bucket}/${ours}`);
}

const out = join(harness, "../raw", `isolate-ready-${startedAt.replaceAll(":", "-").replace(/\..*/, "")}.json`);
await Bun.write(
	out,
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
			workspace: { id: workspaceId, files: 300, fileBytes: 4096, entries: 381 },
			bundles,
			poolSize,
			skew: { load1Above: skewLoad, load1DeltaAbove: skewDelta },
			minio: { prefix: `${s3.bucket}/${ours}`, deletedAfter: deleted },
			batches,
		},
		null,
		"\t",
	)}\n`,
);
console.error(`wrote ${out}`);
