/**
 * Drives harbour-ready-spike and writes one JSON file per batch. Runs are sequential and paced, as the Cloudflare spike's were; a
 * failed run is recorded under `failures` and left out of the percentiles.
 *
 *   READY_SPIKE_TOKEN=… bun scripts/bench.ts --base-url https://harbour-ready-spike.<subdomain>.workers.dev \
 *     --mode cold|hot|idle --runs 50 [--idle-ms 60000] [--keep-alive none|timer|alarm] [--manifest-from workspace-do|r2] \
 *     [--batch name] [--out out]
 *
 * - cold: today's path, a new SessionDO and a new isolate per run (POST /bench/cold).
 * - hot:  warm one pool object, wait --gap-ms (default 1 s, under the 10 s after which an idle object may hibernate),
 *         hand it out.
 * - idle: warm --runs pool objects, then hand each out once it has been idle --idle-ms (with --keep-alive pinging it).
 */
import { mkdir, writeFile } from "node:fs/promises";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
const base = args.get("base-url") ?? "";
const token = process.env.READY_SPIKE_TOKEN ?? "";
const mode = args.get("mode") ?? "hot";
const runs = Number(args.get("runs") ?? 50);
const idleMs = Number(args.get("idle-ms") ?? 60_000);
const gapMs = Number(args.get("gap-ms") ?? 1_000);
const paceMs = Number(args.get("pace-ms") ?? 1_000);
const keepAlive = args.get("keep-alive") ?? "none";
const manifestFrom = args.get("manifest-from") ?? "workspace-do";
const workspaceId = args.get("workspace") ?? "ws-bench";
const batch = args.get("batch") ?? `${mode}-${Date.now().toString(36)}`;
const out = args.get("out") ?? "out";
if (base === "" || token === "") throw new Error("--base-url and READY_SPIKE_TOKEN are required");

type Result = Record<string, unknown> & { readyMs: number; clientMs: number };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function post(path: string, body: unknown): Promise<Record<string, unknown> & { clientMs: number }> {
	const started = performance.now();
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const clientMs = Math.round(performance.now() - started);
	if (!response.ok) throw new Error(`${path} ${response.status}: ${text.slice(0, 300)}`);
	return { ...(JSON.parse(text) as Record<string, unknown>), clientMs };
}

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
	return { n: sorted.length, p50: rank(50), p95: rank(95), min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
}

const results: Result[] = [];
const failures: { run: number; error: string }[] = [];
const warms: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();

async function handout(run: number) {
	try {
		results.push((await post("/bench/handout", { batch, workspaceId, manifestFrom })) as Result);
	} catch (error) {
		failures.push({ run, error: String(error) });
	}
}

if (mode === "cold") {
	for (let run = 0; run < runs; run += 1) {
		try {
			results.push((await post("/bench/cold", { workspaceId })) as Result);
		} catch (error) {
			failures.push({ run, error: String(error) });
		}
		await sleep(paceMs);
	}
} else if (mode === "hot") {
	for (let run = 0; run < runs; run += 1) {
		const slot = `${batch}-${run}`;
		try {
			warms.push(await post("/bench/warm", { batch, slot }));
			await sleep(gapMs);
			await handout(run);
		} catch (error) {
			failures.push({ run, error: String(error) });
		}
		await sleep(paceMs);
	}
} else if (mode === "idle") {
	const due: number[] = [];
	for (let run = 0; run < runs; run += 1) {
		try {
			warms.push(
				await post("/bench/warm", { batch, slot: `${batch}-${run}`, keepAlive, keepAliveMs: idleMs + 10 * 60_000 }),
			);
			due.push(Date.now() + idleMs);
		} catch (error) {
			failures.push({ run, error: `warm: ${String(error)}` });
		}
		await sleep(paceMs);
	}
	for (let run = 0; run < due.length; run += 1) {
		await sleep(due[run]! - Date.now());
		await handout(run);
	}
} else {
	throw new Error(`unknown mode ${mode}`);
}

const where = mode === "cold" ? undefined : await post("/where", { batch, workspaceId }).catch(String);
const summary = {
	readyMs: stats(results.map((r) => r.readyMs)),
	clientMs: stats(results.map((r) => r.clientMs)),
	...(mode === "cold"
		? {
				firstContactMs: stats(results.map((r) => (r.phases as { firstContactMs: number }).firstContactMs)),
				setupMs: stats(results.map((r) => (r.phases as { setupMs: number }).setupMs)),
				listMs: stats(results.map((r) => (r.phases as { listMs: number }).listMs)),
			}
		: {
				claimMs: stats(results.map((r) => (r.phases as { claimMs: number }).claimMs)),
				handoutCallMs: stats(results.map((r) => (r.phases as { handoutCallMs: number }).handoutCallMs)),
				manifestMs: stats(results.map((r) => (r.timings as { manifestMs: number }).manifestMs)),
				sessionRttMs: stats(results.map((r) => (r.rtt as { sessionMs: number }).sessionMs)),
				poolRttMs: stats(results.map((r) => (r.rtt as { poolMs: number }).poolMs)),
				// The isolate warm() loaded is still the one answering.
				isolateReused: results.filter((r) => (r.isolate as { reused: boolean }).reused).length,
				// The hand-out found a loaded isolate (warm's, or one a keep-alive ping reloaded): it had answered calls before.
				// Its list and ls are calls n+1 and n+2, so a load at the hand-out answers ls as call 2.
				isolateLoaded: results.filter((r) => (r.isolate as { calls: number }).calls > 2).length,
				readyMsLoaded: stats(results.filter((r) => (r.isolate as { calls: number }).calls > 2).map((r) => r.readyMs)),
				readyMsReloaded: stats(
					results.filter((r) => (r.isolate as { calls: number }).calls <= 2).map((r) => r.readyMs),
				),
				doInMemory: results.filter((r) => r.doInMemory === true).length,
				harnessInMemory: results.filter((r) => r.harnessInMemory === true).length,
				idleMs: stats(results.map((r) => r.idleMs as number)),
				warmMs: stats(warms.map((w) => w.warmMs as number)),
			}),
	workerColos: count(results.map((r) => String(r.colo))),
	doColos: count((mode === "cold" ? results : warms).map((r) => String(r.doColo))),
	failures: failures.length,
};

function count(values: string[]) {
	const counts: Record<string, number> = {};
	for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}

const file = `${out}/${batch}.json`;
await mkdir(out, { recursive: true });
await writeFile(
	file,
	`${JSON.stringify({ mode, batch, startedAt, params: { runs, idleMs, gapMs, paceMs, keepAlive, manifestFrom, workspaceId }, where, summary, failures, results, warms }, null, "\t")}\n`,
);
console.log(file, JSON.stringify(summary));
