// Drive the Cloudflare runs: N fresh containers per row, C at a time, raw JSON lines out.
//   BENCH_URL=... BENCH_TOKEN_FILE=... node drive.mjs <plan.json> <out.jsonl>
// plan.json: { "cacheSnapshot": "<id>", "ready": { "<repo>": { "snapshot": "<id>", "backupFull": {...}, "backupSrc": {...} } },
//              "n": 50, "concurrency": 8, "rows": ["container-start", "worktree:sal", ...] }
import { appendFileSync, readFileSync } from "node:fs";

const [planPath, out] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const url = process.env.BENCH_URL;
const token = readFileSync(process.env.BENCH_TOKEN_FILE, "utf8").trim();

const fixtures = Object.fromEntries(
	readFileSync(new URL("../fixtures.env", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l.startsWith('  "'))
		.map((l) => l.trim().replace(/^"|"$/g, "").split("|"))
		.map(([name, gh, sha, sparse]) => [name, { gh, sha, sparse }]),
);

function request(method, repo) {
	const f = fixtures[repo] ?? {};
	const ready = plan.ready?.[repo] ?? {};
	const base = { snapshot: plan.cacheSnapshot };
	const mirror = `mirror=/cache/mirrors/${repo}.git`;
	const stat = "stat=minimal";
	switch (method) {
		case "container-start":
			return { image: "slim", args: ["noop", `repo=${repo}`] };
		case "cache-start":
			return { ...base, args: ["noop", `repo=${repo}`] };
		case "worktree":
		case "ref-full":
		case "ref-sparse":
			return {
				...base,
				args: [method, `repo=${repo}`, `sha=${f.sha}`, mirror, "dst=/workspace/w", `sparse=${f.sparse}`],
			};
		case "squashfs":
			return { ...base, args: ["squashfs", `repo=${repo}`, `sqsh=/cache/sqsh/${repo}.sqsh`, "dst=/workspace/w", stat] };
		case "deps-archive":
			return { ...base, args: ["deps-archive", `repo=${repo}`, `archive=${plan.deps[repo]}`, "dst=/workspace/w"] };
		case "snapshot-restore":
			return { snapshot: ready.snapshot, args: ["status", `repo=${repo}`, "dst=/workspace/w", stat] };
		case "dirbackup-full":
			return { ...base, restoreBackup: ready.backupFull, args: ["status", `repo=${repo}`, "dst=/workspace/w", stat] };
		case "dirbackup-src":
			return { ...base, restoreBackup: ready.backupSrc, args: ["status", `repo=${repo}`, "dst=/workspace/w", stat] };
		default:
			throw new Error(`unknown method ${method}`);
	}
}

const jobs = [];
for (const row of plan.rows) {
	const [method, repo = "sal"] = row.split(":");
	for (let i = 1; i <= (plan.n ?? 50); i++) jobs.push({ method, repo, i });
}
let next = 0;
let failures = 0;
async function worker() {
	while (next < jobs.length) {
		const { method, repo, i } = jobs[next++];
		const body = request(method, repo);
		const box = `${method}-${repo}-${i}-${Date.now()}`;
		const t0 = Date.now();
		let r;
		try {
			const res = await fetch(`${url}/run?box=${encodeURIComponent(box)}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify(body),
			});
			r = await res.json();
		} catch (e) {
			r = { ok: false, error: String(e) };
		}
		const line = {
			target: "cloudflare-container-standard-4",
			method,
			repo,
			iteration: i,
			client_ms: Date.now() - t0,
			...r,
		};
		if (!r.ok) {
			failures++;
			console.error(`FAIL ${method} ${repo} ${i}: ${String(r.error).slice(0, 300)}`);
		}
		appendFileSync(out, `${JSON.stringify(line)}\n`);
	}
}
await Promise.all(Array.from({ length: plan.concurrency ?? 8 }, worker));
console.error(`done: ${jobs.length} runs, ${failures} failures`);
