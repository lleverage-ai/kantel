#!/usr/bin/env bun
/**
 * Cold-start table for the Cloudflare spike, 50 runs per row by default.
 *
 *   HARBOUR_SPIKE_TOKEN=... bun scripts/bench.ts --base-url https://harbour-m0-cf1.<subdomain>.workers.dev \
 *     [--runs 50] [--rows isolate-ready,container-ready,isolate-warm,container-warm] [--out out]
 *
 * Server-side timings are the numbers that count: they are taken inside Cloudflare, around the calls, so they leave
 * out the round trip from wherever this script runs. The client wall time is recorded beside them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		"base-url": { type: "string" },
		runs: { type: "string", default: "50" },
		rows: { type: "string", default: "isolate-ready,container-ready,isolate-warm,container-warm" },
		out: { type: "string" },
	},
});
const baseUrl = values["base-url"] ?? process.env.HARBOUR_BASE_URL;
const token = process.env.HARBOUR_SPIKE_TOKEN;
if (baseUrl === undefined || token === undefined) throw new Error("need --base-url and HARBOUR_SPIKE_TOKEN");
const runs = Number(values.runs);
const rows = (values.rows as string).split(",");
const BENCH_WORKSPACE = "harbour-m0-bench";

async function post<T>(path: string, body: unknown): Promise<{ body: T; clientMs: number }> {
	const started = performance.now();
	const response = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const clientMs = Math.round(performance.now() - started);
	if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
	return { body: JSON.parse(text) as T, clientMs };
}

type ExecResponse = {
	tier: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	version: string;
	timings: Record<string, number>;
};

/** A workspace of 60 small files in a few directories, the same for every run. */
function benchSeed(): Record<string, string> {
	const seed: Record<string, string> = { "README.md": "# bench workspace\n" };
	for (let d = 0; d < 6; d += 1)
		for (let f = 0; f < 10; f += 1) seed[`src/dir${d}/file${f}.ts`] = `export const v${d}_${f} = ${d * 10 + f};\n`;
	return seed;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}

function summarise(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		n: sorted.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		min: sorted[0],
		max: sorted.at(-1),
	};
}

const results: Record<
	string,
	{
		samples: Record<string, unknown>[];
		failures: { run: number; error: string }[];
		summary: Record<string, ReturnType<typeof summarise>>;
	}
> = {};
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const benchSession = `bench-${stamp.toLowerCase()}`;

// One long-lived session over the bench workspace, for the warm rows and the container row.
await post(`/sessions/${benchSession}/setup`, {
	workspaceId: BENCH_WORKSPACE,
	scenario: { name: "bench", steps: [], finalAnswer: "ok", seed: benchSeed() },
});

for (const row of rows) {
	const samples: Record<string, unknown>[] = [];
	// A failed run is recorded and left out of the percentiles, not retried.
	const failures: { run: number; error: string }[] = [];
	console.error(`row ${row}: ${runs} runs`);
	for (let i = 0; i < runs; i += 1) {
		try {
			await runOnce(row, i, samples);
			process.stderr.write(".");
		} catch (error) {
			failures.push({ run: i, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
			process.stderr.write("x");
			if (row === "container-ready") {
				// Leave no container running for the next run.
				await post(`/sessions/${benchSession}/release`, { containerName: `${benchSession}-c${i}` }).catch(() => {});
			}
		}
	}
	process.stderr.write("\n");
	const numericKeys = Object.keys(samples[0] ?? {}).filter(
		(k) => samples.every((s) => typeof s[k] === "number") && k !== "run",
	);
	const summary = Object.fromEntries(numericKeys.map((k) => [k, summarise(samples.map((s) => s[k] as number))]));
	results[row] = { samples, failures, summary };
	console.error(
		JSON.stringify({ row, failures: failures.length, serverMs: summary.serverMs, clientMs: summary.clientMs }),
	);
}

async function runOnce(row: string, i: number, samples: Record<string, unknown>[]): Promise<void> {
	if (row === "isolate-ready") {
		// New SessionDO (Pi Durable opened on empty storage) + a Dynamic Worker never loaded before, listing the workspace.
		const { body, clientMs } = await post<{
			totalMs: number;
			sessionReadyMs: number;
			doCreateMs: number;
			setupMs: number;
			listMs: number;
			entries: string;
			setup: Record<string, number>;
			exec: Record<string, number>;
		}>("/bench/isolate-ready", { workspaceId: BENCH_WORKSPACE });
		samples.push({
			run: i,
			serverMs: body.totalMs,
			sessionReadyMs: body.sessionReadyMs,
			doCreateMs: body.doCreateMs,
			setupMs: body.setupMs,
			listMs: body.listMs,
			clientMs,
			entries: body.entries,
			...prefix("setup", body.setup),
			...prefix("exec", body.exec),
		});
	} else if (row === "container-ready") {
		// The isolate writes a marker (a new workspace version), then a container never started before runs on it.
		const marker = `run-${i}-${Date.now()}`;
		const write = await post<ExecResponse>(`/sessions/${benchSession}/exec`, {
			tier: "isolate",
			command: `echo ${marker} > marker.txt`,
		});
		const containerName = `${benchSession}-c${i}`;
		const { body, clientMs } = await post<ExecResponse>(`/sessions/${benchSession}/exec`, {
			tier: "container",
			containerName,
			command: "cat marker.txt && git --version",
		});
		const sawWrite = body.stdout.includes(marker);
		samples.push({
			run: i,
			serverMs: body.timings["container.call"],
			clientMs,
			version: write.body.version,
			sawIsolateWrite: sawWrite,
			exitCode: body.exitCode,
			...prefix("t", body.timings),
		});
		await post(`/sessions/${benchSession}/release`, { containerName });
	} else if (row === "isolate-warm") {
		const { body, clientMs } = await post<ExecResponse>(`/sessions/${benchSession}/exec`, {
			tier: "isolate",
			command: "ls -1R /workspace | wc -l",
		});
		samples.push({ run: i, serverMs: body.timings["isolate.call"], clientMs, ...prefix("t", body.timings) });
	} else if (row === "container-warm") {
		const containerName = `${benchSession}-warm`;
		const { body, clientMs } = await post<ExecResponse>(`/sessions/${benchSession}/exec`, {
			tier: "container",
			containerName,
			command: "git --version",
		});
		samples.push({ run: i, serverMs: body.timings["container.call"], clientMs, ...prefix("t", body.timings) });
		if (i === runs - 1) await post(`/sessions/${benchSession}/release`, { containerName });
	} else {
		throw new Error(`unknown row ${row}`);
	}
}

const report = {
	target: "cloudflare",
	baseUrl: new URL(baseUrl).host,
	recordedAt: new Date().toISOString(),
	runs,
	workspace: BENCH_WORKSPACE,
	results,
};
if (values.out !== undefined) {
	await mkdir(values.out, { recursive: true });
	await writeFile(`${values.out}/cold-start-${stamp}.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([row, r]) => [row, r.summary])), null, 2));

function prefix(name: string, record: Record<string, number> | undefined): Record<string, number> {
	return Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [`${name}:${k}`, v]));
}
