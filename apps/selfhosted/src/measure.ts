// Cold-start measurements for the self-hosted rows of the plan's Table 6.
// Runs inside a session host container (it needs the isolate host, MinIO,
// Postgres and the Docker socket), prints one JSON document:
//
//   docker compose -f deploy/compose/compose.yaml exec -T host-a \
//     bun src/measure.ts --runs 50 > docs/measurements/m0-sh1-selfhosted/raw/<date>.json
//
// Rows:
//   isolate.ready      new session's Dynamic Worker loaded and the workspace listed
//   isolate.first      new session's first command (ls -R | wc -l) on that workspace
//   isolate.warm       a further command in the same, already loaded isolate
//   container.same     container started on the same workspace version (warm image),
//                      ran `true`, and its workspace read back
//   session.open       session created: lease, Pi schema migrations, Harness open
// Every timing is wall-clock from the session host's point of view.

import { parseArgs } from "node:util";
import pg from "pg";
import type { Manifest } from "../../../spike/contracts/index.ts";
import { holdLiveness } from "./lease.ts";
import { build } from "./main.ts";
import { versionOf } from "./workspace.ts";

const { values } = parseArgs({
	options: {
		runs: { type: "string", default: "50" },
		files: { type: "string", default: "300" },
		"file-bytes": { type: "string", default: "4096" },
		// Leave out container.same: on a Docker daemon shared with an older stack, whose sandbox janitor removes any
		// sandbox it doesn't own, the measured containers can be removed mid-run. Without the container start between
		// runs (about 1 s), the isolate pool has less time to refill between new sessions.
		"no-container": { type: "boolean", default: false },
		// A pause after each run, standing in for that container start: the isolate pool refills only once no call has
		// been in flight for a moment (images/isolate-host/src/pool.ts), as between a session's model calls.
		"gap-ms": { type: "string", default: "0" },
	},
});
const withContainers = !values["no-container"];
const gapMs = Number(values["gap-ms"]);
// stdout carries only the JSON result; host log lines go to stderr.
const print = console.log.bind(console);
console.log = (...items: unknown[]) => console.error(...items);
const runs = Number(values.runs);
const fileCount = Number(values.files);
const fileBytes = Number(values["file-bytes"]);

const app = await build();
const { pool, leases, workspace, isolate, container, host } = app;
const owner = `measure/${crypto.randomUUID().slice(0, 8)}`;
const liveness = new pg.Client({ connectionString: app.cfg.databaseUrl });
await liveness.connect();
await holdLiveness(liveness, owner);
// The session.open row uses the host's own lease owner; mark it live without
// starting its takeover loop, so measuring never takes sessions from host-a or host-b.
await holdLiveness(liveness, host.owner);

const tag = `measure-${Date.now().toString(36)}`;

/** A workspace like a small repository: nested directories, `fileCount` files. */
async function seed(workspaceId: string): Promise<{ version: string; manifest: Manifest }> {
	await pool.query(
		`INSERT INTO harbour.sessions (id, workspace_id, pi_schema) VALUES ($1, $1, 'none') ON CONFLICT DO NOTHING`,
		[workspaceId],
	);
	await workspace.create(workspaceId);
	const lease = await leases.acquire(workspaceId, owner, "http://measure", 600_000);
	if (!lease) throw new Error("no lease for the seed workspace");
	const manifest: Manifest = {};
	const writes: Promise<unknown>[] = [];
	for (let i = 0; i < fileCount; i++) {
		const dir = `src/pkg${i % 10}/mod${i % 7}`;
		manifest.src = { kind: "dir" };
		manifest[`src/pkg${i % 10}`] = { kind: "dir" };
		manifest[dir] = { kind: "dir" };
		const bytes = new TextEncoder().encode(`// file ${i}\n${"x".repeat(fileBytes - 20)}\n`);
		writes.push(
			workspace.putBlob(workspaceId, bytes).then((sha) => {
				manifest[`${dir}/file${i}.ts`] = { kind: "file", sha, size: bytes.length, mode: 0o644 };
			}),
		);
	}
	await Promise.all(writes);
	const head = await workspace.commit(
		workspaceId,
		{ base: "empty", manifest, tier: "host", changed: Object.keys(manifest) },
		lease,
	);
	if (head.version !== versionOf(manifest)) throw new Error("version mismatch");
	return { version: head.version, manifest };
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
	const t = performance.now();
	const value = await fn();
	return { ms: Math.round((performance.now() - t) * 10) / 10, value };
}

const pct = (values: number[], p: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

const workspaceId = `${tag}-ws`;
const seeded = await seed(workspaceId);
const rows: Record<string, { ms: number[]; detail?: Record<string, number>[] }> = {
	"isolate.ready": { ms: [] },
	"isolate.first": { ms: [], detail: [] },
	"isolate.warm": { ms: [] },
	...(withContainers ? { "container.same": { ms: [], detail: [] } } : {}),
	"session.open": { ms: [] },
};

// Warm-up, not recorded: first image use, first connections.
await isolate.list(`${tag}-warmup`, workspaceId, seeded.version);
if (withContainers) {
	await container.exec(
		{ sessionId: `${tag}-warmup`, workspaceId, version: seeded.version, command: "true" },
		seeded.manifest,
	);
}

for (let i = 0; i < runs; i++) {
	const sessionId = `${tag}-iso-${i}`;
	const ready = await time(() => isolate.list(sessionId, workspaceId, seeded.version));
	if (ready.value.entries !== Object.keys(seeded.manifest).length) throw new Error("listing mismatch");
	rows["isolate.ready"]!.ms.push(ready.ms);

	const firstId = `${tag}-first-${i}`;
	const first = await time(() =>
		isolate.exec(
			{ sessionId: firstId, workspaceId, version: seeded.version, command: "ls -R | wc -l" },
			seeded.manifest,
		),
	);
	rows["isolate.first"]!.ms.push(first.ms);
	rows["isolate.first"]!.detail!.push(first.value.timings);
	const warm = await time(() =>
		isolate.exec(
			{ sessionId: firstId, workspaceId, version: seeded.version, command: "ls -R | wc -l" },
			seeded.manifest,
		),
	);
	rows["isolate.warm"]!.ms.push(warm.ms);

	if (!withContainers) {
		if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
		process.stderr.write(".");
		continue;
	}
	const started = await time(() =>
		container.exec(
			{ sessionId: `${tag}-ctr-${i}`, workspaceId, version: seeded.version, command: "true" },
			seeded.manifest,
		),
	);
	if (started.value.exitCode !== 0 || started.value.changed.length !== 0)
		throw new Error("container round trip changed the workspace");
	rows["container.same"]!.ms.push(started.ms);
	rows["container.same"]!.detail!.push(started.value.timings);
	process.stderr.write(".");
}

// Session open: lease, per-session Pi schema and migrations, Harness open.
for (let i = 0; i < runs; i++) {
	const opened = await time(() => host.create(`${tag}-session-${i}`));
	rows["session.open"]!.ms.push(opened.ms);
}
process.stderr.write("\n");
await host.stop();

const summary = Object.fromEntries(
	Object.entries(rows).map(([name, row]) => {
		const phases: Record<string, number> = {};
		if (row.detail?.length) {
			for (const key of Object.keys(row.detail[0]!))
				phases[key] = pct(
					row.detail.map((d) => d[key] ?? 0),
					50,
				);
		}
		return [
			name,
			{
				runs: row.ms.length,
				p50: pct(row.ms, 50),
				p95: pct(row.ms, 95),
				min: Math.min(...row.ms),
				max: Math.max(...row.ms),
				...(row.detail?.length ? { phaseP50: phases } : {}),
			},
		];
	}),
);

print(
	JSON.stringify(
		{
			measuredAt: new Date().toISOString(),
			target: "selfhosted",
			host: app.cfg.hostId,
			sandboxRuntime: withContainers ? app.cfg.container.runtime : "not measured (--no-container)",
			isolateRuntime: process.env.HARBOUR_ISOLATE_RUNTIME ?? "runc (compose default)",
			workspace: { files: fileCount, fileBytes, entries: Object.keys(seeded.manifest).length },
			...(withContainers ? {} : { gapMs }),
			summary,
			raw: Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, row.ms])),
		},
		null,
		2,
	),
);
await liveness.end();
await pool.end();
process.exit(0);
