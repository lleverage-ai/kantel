// Which real implementations pass their contract's conformance suite against the compose stack's services:
//
//   bun apps/selfhosted/test/bindings.ts [--postgres-url …] [--s3-endpoint …] [--smtp-url …] [--mailpit-url …]
//                                        [--json report.json] [--markdown summary.md]
//
// Each binding is a suite its lane registered (or, for the runtime, the self-hosted Postgres registration in
// test/gateway), run with vitest and the environment that points it at the stack. Only the describe blocks that run on
// the stack's services count: the same files also register PGlite, SQLite and D1 variants, which CI's check job
// covers. A binding passes when those blocks ran at least one test and none failed or were skipped, so a suite that
// quietly skipped for want of its environment fails here. Defaults are the M0 stack's ports. Exits 1 if any failed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		"postgres-url": { type: "string", default: "postgres://harbour:harbour@127.0.0.1:55432/harbour" },
		"s3-endpoint": { type: "string", default: "http://127.0.0.1:59000" },
		"smtp-url": { type: "string", default: "smtp://127.0.0.1:58125?starttls=off" },
		"mailpit-url": { type: "string", default: "http://127.0.0.1:58025" },
		json: { type: "string" },
		markdown: { type: "string" },
	},
});

interface Binding {
	readonly contract: string;
	readonly implementation: string;
	/** Directory vitest runs in (its config decides what it may include), relative to the repository root. */
	readonly cwd: string;
	readonly files: readonly string[];
	/** The describe blocks that run on the stack's services. */
	readonly blocks: RegExp;
	/** Skips the file's other variants (PGlite, SQLite, D1) when they are slow; vitest's `-t`. */
	readonly only?: string;
}

const BINDINGS: readonly Binding[] = [
	{
		contract: "session runtime",
		implementation: "SQL session store and Pi Durable tables on Postgres (#69)",
		cwd: "apps/selfhosted",
		files: ["test/gateway/runtime-postgres.conformance.test.ts"],
		blocks: /^session runtime on Postgres/,
	},
	{
		contract: "audit",
		implementation: "SQL audit store and outbox on Postgres (#70)",
		cwd: ".",
		files: ["packages/audit/test/sql.conformance.test.ts"],
		blocks: /^SQL audit store and outbox on Postgres$/,
		only: "^SQL audit store and outbox on Postgres (?!\\(PGlite\\))",
	},
	{
		contract: "identity",
		implementation: "SQL identity directory on Postgres (#83)",
		cwd: ".",
		files: ["packages/identity/test/sql.conformance.test.ts"],
		blocks: /^SQL identity on Postgres$/,
		only: "^SQL identity on Postgres (?!\\(PGlite\\))",
	},
	{
		contract: "email one-time PIN",
		implementation: "OTP sign-in on Postgres, mail through Mailpit (#93)",
		cwd: ".",
		files: ["packages/identity/test/otp.mailpit.test.ts"],
		blocks: /^email one-time PIN through Mailpit/,
	},
	{
		contract: "workspaces",
		implementation: "self-hosted workspaces on Postgres and S3 (MinIO), keyed (#72)",
		cwd: "targets/selfhosted/workspace",
		files: ["test/conformance.stack.test.ts"],
		blocks: /^self-hosted workspaces on Postgres \+ S3/,
	},
	{
		contract: "gateway",
		implementation: "the M1 gateway on all of the above, across a restart (durable.ts)",
		cwd: "apps/selfhosted",
		files: ["test/gateway/durable.stack.test.ts"],
		blocks: /^the gateway on Postgres and S3$/,
	},
	{
		contract: "vault",
		implementation: "vault engine on the Postgres vault store (#75)",
		cwd: "targets/selfhosted/vault",
		files: ["test/postgres.conformance.test.ts"],
		blocks: /^Postgres vault store \(pg\)/,
	},
];

const env = {
	...process.env,
	KANTEL_TEST_POSTGRES_URL: values["postgres-url"],
	KANTEL_TEST_DATABASE_URL: values["postgres-url"],
	KANTEL_TEST_S3_ENDPOINT: values["s3-endpoint"],
	KANTEL_TEST_SMTP_URL: values["smtp-url"],
	KANTEL_TEST_MAILPIT_URL: values["mailpit-url"],
};

interface VitestReport {
	readonly testResults: readonly {
		readonly name: string;
		readonly message?: string;
		readonly assertionResults: readonly {
			readonly ancestorTitles: readonly string[];
			readonly fullName: string;
			readonly status: string;
			readonly failureMessages?: readonly string[];
		}[];
	}[];
}

interface Result {
	readonly contract: string;
	readonly implementation: string;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly ms: number;
	readonly ok: boolean;
	readonly failures: readonly string[];
}

const root = resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "harbour-bindings-"));
const results: Result[] = [];
try {
	for (const [index, binding] of BINDINGS.entries()) {
		const output = join(scratch, `${index}.json`);
		const started = performance.now();
		const run = spawnSync(
			"pnpm",
			[
				"exec",
				"vitest",
				"run",
				"--reporter=json",
				`--outputFile=${output}`,
				...(binding.only === undefined ? [] : ["-t", binding.only]),
				...binding.files,
			],
			{ cwd: join(root, binding.cwd), env, encoding: "utf8", timeout: 15 * 60_000 },
		);
		const ms = Math.round(performance.now() - started);
		let report: VitestReport | undefined;
		try {
			report = JSON.parse(readFileSync(output, "utf8")) as VitestReport;
		} catch {
			report = undefined;
		}
		const tests = (report?.testResults ?? [])
			.flatMap((file) => file.assertionResults)
			.filter((test) => binding.blocks.test(test.ancestorTitles[0] ?? ""));
		const count = (status: string) => tests.filter((test) => test.status === status).length;
		const passed = count("passed");
		const failed = count("failed");
		// Tests `-t` left out never reach the blocks counted here, so a skip is one the suite chose.
		const skipped = tests.length - passed - failed;
		// Vitest also fails a run for an unhandled error, which its JSON report leaves out; and a timeout can stop it
		// after the report is written. So the process must have succeeded too.
		const processFailed = run.error !== undefined || run.signal !== null || run.status !== 0;
		const failures = [
			...tests.filter((test) => test.status === "failed").map((test) => test.fullName),
			...(report === undefined ? ["vitest wrote no report"] : []),
			...(processFailed
				? [
						`vitest ${run.error ? `could not run: ${run.error.message}` : run.signal ? `was stopped by ${run.signal}` : `exited ${run.status}`}: ${(run.stderr ?? "").slice(-2000)}`,
					]
				: []),
			// A file that failed to load has no assertion results, only a message.
			...(report?.testResults ?? []).flatMap((file) => (file.message ? [`${file.name}: ${file.message}`] : [])),
		];
		results.push({
			contract: binding.contract,
			implementation: binding.implementation,
			passed,
			failed,
			skipped,
			ms,
			ok: passed > 0 && failed === 0 && skipped === 0 && failures.length === 0,
			failures,
		});
		const last = results.at(-1);
		console.log(
			`${last?.ok ? "ok  " : "FAIL"} ${binding.contract}: ${passed} passed, ${failed} failed, ${skipped} skipped (${ms} ms)`,
		);
		for (const failure of failures.slice(0, 20)) console.log(`       ${failure}`);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

const markdown = [
	"| Contract | Implementation | Passed | Failed | Skipped | Result |",
	"|---|---|---|---|---|---|",
	...results.map(
		(result) =>
			`| ${result.contract} | ${result.implementation} | ${result.passed} | ${result.failed} | ${result.skipped} | ${result.ok ? "pass" : "fail"} |`,
	),
].join("\n");
console.log(`\n${markdown}`);
if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(results, null, "\t")}\n`);
if (values.markdown !== undefined) {
	writeFileSync(values.markdown, `### Bindings against the compose stack\n\n${markdown}\n`, { flag: "a" });
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
