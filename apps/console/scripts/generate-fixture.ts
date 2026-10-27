// Generates the console's stress fixture: a long recorded Pi Durable session, one JSONL line per watchEvents batch.
//
//   node apps/console/scripts/generate-fixture.ts [--turns 2000] [--seed 2000] [--out <path>]
//
// Line 1 is a RecordingHeader. Line 2 is the snapshot (seq 0), which holds the first N-1 runs as completed entries,
// because a late-joining watcher starts from a snapshot and nothing is replayed. Lines 3+ stream the last run live,
// in the event order of fixtures/pi-durable/small.jsonl, ending in a long markdown answer streamed in small deltas.
// The output is deterministic: all variation comes from a mulberry32 PRNG seeded by --seed.
//
// Choices where the spec left room:
// - The default output is fixtures/pi-durable/long-<turns>.jsonl, so the default run writes long-2000.jsonl and a
//   smaller --turns never overwrites it. --out is resolved against the current directory.
// - Each run takes one submission id and one task id for the run itself; every assistant message and every tool
//   execution then takes the next task id (its byTaskId). User entries have no byTaskId, as in small.jsonl.
// - Costs use nominal rates (3 / 15 / 0.3 USD per million input / output / cache-read tokens) so the console has
//   non-zero costs to show. The context drops back when it passes 150k tokens, standing in for a compaction; no
//   compaction entries are emitted.
// - The snapshot's usage and usage_changed mirror small.jsonl: { models: { "faux/faux-1": { input, output } }, tools }.
// - The live tool result's message_start carries the complete ToolResultMessage. The live run targets production.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type {
	AgentEvent,
	AssistantMessage,
	EntryRecord,
	Message,
	MessageChange,
	RecordedBatch,
	RecordingHeader,
	SnapshotEvent,
	StopReason,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../src/pi-durable/events.ts";

const PI_COMMIT = "973b74c55fcf096ad5976f8d8850c147ee2e62d4";
const START_TS = 1_793_000_000_000;
const MODEL = { api: "faux", provider: "faux", model: "faux-1" } as const;

// ---------------------------------------------------------------------------------------------------------------
// Seeded randomness

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let rnd: () => number = mulberry32(2000);
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const chance = (p: number): boolean => rnd() < p;
const hex = (len: number): string =>
	Math.floor(rnd() * 16 ** len)
		.toString(16)
		.padStart(len, "0");
const repeat = <T>(k: number, make: () => T): T[] => Array.from({ length: k }, () => make());

function pick<T>(items: readonly T[]): T {
	const item = items[Math.floor(rnd() * items.length)];
	if (item === undefined) throw new Error("pick from an empty pool");
	return item;
}

/** Up to k distinct items, in random order. */
function sample<T>(items: readonly T[], k: number): T[] {
	const pool = [...items];
	const out: T[] = [];
	while (out.length < k && pool.length > 0) out.push(...pool.splice(Math.floor(rnd() * pool.length), 1));
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary and templates. `{{key}}` is filled from the run's context or, for numbers and the like, drawn fresh.

const SERVICES = [
	"billing",
	"ledger",
	"notifications",
	"auth-gateway",
	"search-indexer",
	"invoices",
	"payments-api",
	"catalog",
	"scheduler",
	"webhooks",
	"reporting",
	"identity",
];
const MODULES = [
	"client",
	"handlers",
	"repository",
	"queue",
	"config",
	"metrics",
	"routes",
	"schema",
	"retry",
	"session",
	"export",
	"worker",
];
const VERBS = [
	"load",
	"fetch",
	"sync",
	"migrate",
	"resolve",
	"publish",
	"flush",
	"record",
	"validate",
	"build",
	"apply",
	"reconcile",
];
const NOUNS = [
	"Account",
	"Invoice",
	"Ledger",
	"Batch",
	"Config",
	"Tenant",
	"Webhook",
	"Schedule",
	"Snapshot",
	"Event",
	"Cursor",
	"Payout",
];
const TABLES = [
	"accounts",
	"invoices",
	"ledger_entries",
	"payouts",
	"tenants",
	"webhook_deliveries",
	"schedules",
	"audit_events",
];
const COLUMNS = ["tenant_id", "region", "external_ref", "settled_at", "currency", "status_v2", "owner_id"];
const ENVS = ["staging", "canary", "eu-west", "us-east", "sandbox"];
const PKGS = ["db-client", "queue", "flags", "telemetry", "http-kit", "config"];
const COMMITS = [
	"move {{svc}} to the new client",
	"backfill {{table}}.{{col}}",
	"drop the legacy shim in {{anymod}}",
	"bump {{pkg}} to {{ver}}",
	"add a timeout to {{fn}}",
	"dual-write {{table}} behind {{flag}}",
	"fix flaky {{anymod}} test",
];
const LINTS = [
	"Unexpected any. Specify a different type",
	"'legacyClient' is defined but never used",
	"Promise returned from {{fn}} is not awaited",
	"Prefer optional chaining",
];

type Ctx = {
	svc: string;
	mod: string;
	file: string;
	file2: string;
	fn: string;
	fn2: string;
	table: string;
	col: string;
	env: string;
	pkg: string;
	ver: string;
	queue: string;
	flag: string;
};

function runContext(): Ctx {
	const svc = pick(SERVICES);
	const mod = pick(MODULES);
	return {
		svc,
		mod,
		file: `services/${svc}/src/${mod}.ts`,
		file2: `services/${svc}/src/${pick(MODULES)}.test.ts`,
		fn: pick(VERBS) + pick(NOUNS),
		fn2: pick(VERBS) + pick(NOUNS),
		table: pick(TABLES),
		col: pick(COLUMNS),
		env: pick(ENVS),
		pkg: `@platform/${pick(PKGS)}`,
		ver: `${int(1, 4)}.${int(0, 20)}.${int(0, 9)}`,
		queue: `${svc}.${pick(["events", "jobs", "outbox", "retries"])}`,
		flag: `${svc.replace(/-/g, "_")}_${pick(["new_reads", "dual_write", "new_client", "shadow_traffic"])}`,
	};
}

const DYNAMIC: Record<string, (c: Ctx) => string> = {
	n: () => String(int(2, 480)),
	small: () => String(int(2, 6)),
	ms: () => String(int(12, 900)),
	pct: () => String(int(1, 50)),
	line: () => String(int(3, 640)),
	hex: () => hex(7),
	hex5: () => hex(5),
	anymod: () => pick(MODULES),
	commit: (c) => fill(pick(COMMITS), c),
	lint: (c) => fill(pick(LINTS), c),
	status: () => pick(["pending", "settled", "failed", "retrying"]),
};

function fill(template: string, c: Ctx): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
		const fromCtx = (c as Record<string, string | undefined>)[key];
		if (fromCtx !== undefined) return fromCtx;
		const make = DYNAMIC[key];
		if (make === undefined) throw new Error(`unknown placeholder {{${key}}}`);
		return make(c);
	});
}

const SHORT_PROMPTS = [
	"What does `{{fn}}` in `{{file}}` do now?",
	"Is {{svc}} still reading from the old {{table}} table?",
	"Quick one: which env has {{flag}} turned on?",
	"Do we still need the shim in `{{file}}`?",
	"Why is {{svc}} pinned to {{pkg}}@{{ver}}?",
	"Remind me what the rollback step is for {{svc}}.",
	"How long did the {{table}} backfill take in {{env}}?",
	"Can `{{fn}}` throw, or does it always return a result?",
	"Is the {{queue}} queue drained yet?",
	"Should {{svc}} own the {{table}} schema, or the platform team?",
	"What's left before we can delete `{{file}}`?",
	"Did the {{env}} deploy pick up the new config?",
	"Does anything still call `{{fn2}}`?",
	"ok, and {{svc}}?",
	"Any reason not to merge the {{svc}} branch today?",
	"What's the p99 on {{svc}} since the switch?",
	"Which {{svc}} handlers still use the legacy client?",
	"Remind me why we kept `{{fn}}` synchronous.",
];
const SHORT_ANSWERS = [
	"`{{fn}}` wraps the new client and only falls back to the legacy path when {{flag}} is off.",
	"Yes, {{svc}} still reads from `{{table}}`; the switch is behind {{flag}}.",
	"The flag is on in {{env}} only; production still takes the old path.",
	"We can drop the shim once the last {{n}} callers have moved over.",
	"It's pinned because {{pkg}}@{{ver}} changed the retry defaults and {{svc}} depends on the old ones.",
	"Rollback is a flag flip: turn {{flag}} off and the next request reads from the old table again.",
	"The backfill took about {{n}} minutes in {{env}} and moved roughly {{n}}k rows.",
	"It can throw on a closed connection; everything else comes back as a result object.",
	"The {{queue}} queue had {{n}} messages left at the last check, all older than the cut-over.",
	"I'd keep the schema with {{svc}} until the migration is done, then hand it over.",
	"Nothing blocks it except the test in `{{file2}}`, which still imports the old module.",
	"The {{env}} pods restarted on time and their config hash matches the new one.",
	"`{{fn2}}` has no callers left outside the tests.",
	"I don't see a reason to wait: CI is green and the {{env}} soak looks clean.",
	"p99 is around {{ms}} ms, a little better than before the switch.",
	"Two handlers still use it: the webhook retry path and the nightly export.",
	"Keeping it synchronous keeps the ordering guarantee simple, at a cost of about {{ms}} ms per batch.",
	"Error rates on the dashboards are flat.",
	"It's worth a second look before production, though.",
	"The dual-write window is still open, so both tables are current.",
	"If we want to be careful, one more shadow comparison would settle it.",
	"That matches what we saw in staging last week.",
	"I'd leave it alone until the {{table}} cut-over is done.",
];
const BULLETS = [
	"`{{file}}` still imports the legacy client",
	"{{flag}} is off in production",
	"{{n}} rows in `{{table}}` are missing `{{col}}`",
	"the {{queue}} consumer lags by about {{ms}} ms",
	"CI runs the old integration suite twice",
	"`{{fn}}` has no timeout",
	"the {{env}} dashboards still show the old metrics",
	"{{pkg}} needs bumping to {{ver}}",
	"the rollback script hasn't been tried since the schema change",
];
const TOOL_PROMPTS = [
	"Run the {{svc}} tests and tell me what fails.",
	"Find every caller of `{{fn}}` and move them to the new client.",
	"Check whether `{{file}}` still needs the legacy import.",
	"Update `{{file}}` to read {{flag}} from config.",
	"Write a migration for `{{table}}.{{col}}`.",
	"What state are the {{svc}} pods in on {{env}}?",
	"Look for anything still talking to the old {{queue}} topic.",
	"Add a timeout to `{{fn}}`.",
	"Fix the lint errors in {{svc}}.",
	"Can you see why the {{svc}} build is red?",
];
const TOOL_INTROS = [
	"I'll look at `{{file}}` first.",
	"Let me check the current state.",
	"Running it now.",
	"I'll find the callers before changing anything.",
	"Checking the code, then making the change.",
	"Let me see what {{svc}} looks like at the moment.",
];
const WRAPUPS = [
	"`{{file}}` now uses the new client and the tests pass.",
	"{{n}} tests passed and none failed after the change.",
	"The only failure was in `{{file2}}`, and it's a stale snapshot rather than a regression.",
	"I've updated the call sites; there were {{small}} of them.",
	"The migration adds `{{col}}` as nullable so the backfill can run separately.",
	"All {{svc}} pods on {{env}} are running and none restarted in the last hour.",
	"Nothing else talks to the old topic.",
	"`{{fn}}` now gives up after {{ms}} ms and returns a timeout error.",
	"Lint is clean now.",
	"I didn't touch the tests; they already cover this path.",
	"Want the same change in the other services?",
];
const ERROR_ACKS = [
	"One call failed on the way, so I worked from the other results.",
	"The first attempt errored; the details are in the tool output.",
	"Heads up: one of the steps failed and needs a look.",
];
const THOUGHTS = [
	"Short answer wanted. Check the flag state first.",
	"Probably the {{table}} dual write. Confirm before saying so.",
	"Read before editing; the file may have moved.",
	"Keep the change small; the tests already cover {{fn}}.",
	"Two likely causes: config, or the client bump. Start with config.",
	"They asked about {{env}}, not production.",
];
const MEDIUM_PROMPTS = [
	"Sketch how {{svc}} should switch reads to the new store.",
	"Show me the config we need for {{svc}} on {{env}}.",
	"How would you write the backfill for `{{table}}.{{col}}`?",
	"Give me the deploy steps for {{svc}}.",
	"What should the new `{{fn}}` look like?",
];
const LONG_PROMPTS = [
	"Write up how the {{svc}} migration works end to end.",
	"Explain the whole {{table}} backfill, with the code.",
	"Document the {{svc}} rollout for the runbook.",
];
const HEADINGS = [
	"What changes",
	"Where {{svc}} stands",
	"Moving `{{fn}}` over",
	"The {{table}} backfill",
	"Rolling out to {{env}}",
	"Why this order",
	"Rollback",
	"What to watch",
	"Config for {{env}}",
	"Open questions",
];
const CODE_INTROS = [
	"Something like this:",
	"Here's the shape of it:",
	"The change looks like this:",
	"This is what I'd start from:",
	"Roughly:",
];
const PROSE = [
	"The {{svc}} service has been writing to both tables since the dual write started, so each side should match.",
	"Moving `{{fn}}` behind the new client keeps its signature, so no caller has to change.",
	"The {{queue}} consumer is the riskiest piece, because it replays messages when it restarts.",
	"On {{env}} the error rate stayed under {{pct}} basis points for the whole soak.",
	"Each step can be undone on its own by turning {{flag}} off.",
	"The backfill works in batches of {{n}}0 rows so it never holds a long lock on `{{table}}`.",
	"Reads only move once the comparison job reports no differences for a full day.",
	"The old client kept a connection pool per tenant, which is why memory grew with traffic.",
	"The new client shares one pool with a hard limit, so the worst case is predictable.",
	"Most of the work is mechanical: swap the import, run the tests, watch the dashboards.",
	"Anything that writes to `{{table}}` directly has to go through `{{fn}}` first.",
	"That's why I'd keep the flag for at least one release after the cut-over.",
	"The integration suite takes about {{n}} seconds, so it's cheap to run on every change.",
	"If a batch fails, the job records the last good id and resumes from there.",
	"Production sees roughly {{small}} times the traffic of {{env}}, so the timings there are a lower bound.",
	"None of this changes the API contract, so clients won't notice the switch.",
];

type Snippet = { lang: string; lines: readonly string[] };
const TS_CLIENT: Snippet = {
	lang: "ts",
	lines: [
		'import { createClient } from "{{pkg}}";',
		'import { config } from "./config.ts";',
		"",
		"const client = createClient({ url: config.databaseUrl, poolSize: {{small}}0 });",
		"",
		"export async function {{fn}}(id: string): Promise<Result<Row>> {",
		"  const signal = AbortSignal.timeout({{ms}});",
		"  try {",
		'    const row = await client.one("select * from {{table}} where id = $1", [id], { signal });',
		'    return row ? { ok: true, value: row } : { ok: false, error: "not-found" };',
		"  } catch (error) {",
		"    return { ok: false, error: String(error) };",
		"  }",
		"}",
	],
};
const TS_ROUTING: Snippet = {
	lang: "ts",
	lines: [
		'import { flags } from "{{pkg}}";',
		'import { legacyStore, newStore, type Store } from "./stores.ts";',
		"",
		"export function storeFor(tenantId: string): Store {",
		'  return flags.enabled("{{flag}}", { tenantId }) ? newStore : legacyStore;',
		"}",
		"",
		"export async function {{fn2}}(tenantId: string, input: WriteInput): Promise<void> {",
		"  const store = storeFor(tenantId);",
		"  await store.write(input);",
		"  if (store !== legacyStore) await legacyStore.write(input); // dual write until it is switched off",
		'  metrics.increment("{{svc}}.writes", { store: store.name });',
		"}",
	],
};
const BASH_DEPLOY: Snippet = {
	lang: "bash",
	lines: [
		"set -euo pipefail",
		"export TARGET_ENV={{env}}",
		"pnpm --filter {{pkg}} build",
		"pnpm --filter {{pkg}} test -- --run",
		"./scripts/compare-tables.sh {{table}} --since 24h",
		'./scripts/flags.sh set {{flag}} --percent {{pct}} --env "$TARGET_ENV"',
		"kubectl -n {{svc}}-{{env}} rollout restart deploy/{{svc}}",
		"kubectl -n {{svc}}-{{env}} rollout status deploy/{{svc}} --timeout=300s",
		'./scripts/migration-status.sh --service {{svc}} --env "$TARGET_ENV"',
	],
};
const JSON_CONFIG: Snippet = {
	lang: "json",
	lines: [
		"{",
		'  "service": "{{svc}}",',
		'  "environment": "{{env}}",',
		'  "database": {',
		'    "poolSize": {{small}}0,',
		'    "statementTimeoutMs": {{ms}}',
		"  },",
		'  "flags": {',
		'    "{{flag}}": true,',
		'    "shadowReads": false',
		"  },",
		'  "queue": "{{queue}}"',
		"}",
	],
};
const SQL_BACKFILL: Snippet = {
	lang: "sql",
	lines: [
		"alter table {{table}} add column if not exists {{col}} text;",
		"",
		"update {{table}} t",
		"set {{col}} = l.{{col}}",
		"from legacy_{{table}} l",
		"where t.id = l.id",
		"  and t.id in (",
		"    select id from {{table}} where {{col}} is null order by id limit {{n}}0",
		"  );",
		"",
		"create index concurrently if not exists {{table}}_{{col}}_idx",
		"  on {{table}} ({{col}});",
	],
};
const YAML_DEPLOY: Snippet = {
	lang: "yaml",
	lines: [
		"apiVersion: apps/v1",
		"kind: Deployment",
		"metadata:",
		"  name: {{svc}}",
		"  namespace: {{svc}}-{{env}}",
		"spec:",
		"  replicas: {{small}}",
		"  template:",
		"    spec:",
		"      containers:",
		"        - name: {{svc}}",
		"          image: registry.internal/{{svc}}:{{ver}}",
	],
};
const SNIPPETS = [TS_CLIENT, TS_ROUTING, BASH_DEPLOY, JSON_CONFIG, SQL_BACKFILL, YAML_DEPLOY];

// Tool templates. A bash template has an optional header and a line repeated for the output.
const BASH: { cmd: string; head?: string; line: string }[] = [
	{ cmd: "pnpm --filter {{pkg}} test -- --run", line: " ✓ src/{{anymod}}.test.ts ({{small}} tests) {{ms}}ms" },
	{
		cmd: 'git grep -n "{{fn}}" services/',
		line: "services/{{svc}}/src/{{anymod}}.ts:{{line}}:  const result = await {{fn}}(input);",
	},
	{
		cmd: "kubectl -n {{svc}}-{{env}} get pods",
		head: "NAME                              READY   STATUS    RESTARTS   AGE",
		line: "{{svc}}-{{hex}}-{{hex5}}   1/1     Running   0          {{small}}h",
	},
	{ cmd: "git log --oneline -n 12", line: "{{hex}} {{commit}}" },
	{ cmd: "pnpm --filter {{pkg}} lint", line: "{{file}}:{{line}}:{{small}}  warning  {{lint}}" },
	{
		cmd: 'psql "$DATABASE_URL" -c "select status, count(*) from {{table}} group by 1"',
		head: " status   | count\n----------+-------",
		line: " {{status}} | {{n}}",
	},
	{
		cmd: "./scripts/compare-tables.sh {{table}} --since 1h",
		line: "[compare] batch {{n}}: {{n}}0 rows checked, 0 differ",
	},
];
const GREP_LINES = [
	"services/{{svc}}/src/{{anymod}}.ts:{{line}}:  return {{fn}}(input, options);",
	'services/{{svc}}/src/{{anymod}}.ts:{{line}}:import { {{fn}} } from "../legacy/{{mod}}.ts";',
	"services/{{svc}}/test/{{anymod}}.test.ts:{{line}}:    await {{fn}}(fixture);",
];
type ToolName = "bash" | "read" | "grep" | "edit" | "write";
const ERRORS: Record<ToolName, readonly string[]> = {
	bash: [
		"Command exited with code 1\nError: Cannot find module '{{pkg}}/legacy'",
		"Command exited with code 2\nerror: unknown option '--run'",
		"Command timed out after 120000 ms",
	],
	read: ["ENOENT: no such file or directory, open '{{file2}}'"],
	grep: ["grep: services/{{svc}}/lib: No such file or directory"],
	edit: ["Could not find oldText in {{file}}; the file changed since it was read."],
	write: ["EACCES: permission denied, open 'services/{{svc}}/migrations'"],
};

// The live run's script.
const LIVE_PROMPT =
	"Write up the full cut-over plan for {{svc}}: where we stand, the steps, the commands, the config, the backfill SQL and how to roll back. It should be something I can hand to on-call as is.";
const LIVE_THOUGHTS = [
	"They want a handover document, not a chat answer.",
	" Check the live status first so the numbers are current,",
	" then structure it: state, plan, commands, config, backfill, rollback.",
	" Every step has to make sense without this thread.",
];
const LIVE_COMMAND = "./scripts/migration-status.sh --service {{svc}} --env production --verbose";
const LIVE_STATUS = [
	"[status] service={{svc}} env=production",
	"[status] reads: legacy store ({{flag}} off)",
	"[status] writes: dual, 0 mismatched rows in 24h",
	"[status] {{table}}: {{n}}0 rows, {{col}} null in {{n}}",
	"[status] queue {{queue}}: lag p99 {{ms}} ms",
	"[status] backfill: running, batch {{n}}",
	"[status] staging soak: {{small}} days clean",
	"[status] ready for cut-over: yes, 2 manual checks pending",
];
const PLAN_STEPS = [
	"Confirm the comparison job for `{{table}}` reported zero differences in the last 24 hours.",
	"Announce the window in the platform channel and pause other deploys to {{svc}}.",
	"Turn on **{{flag}}** in production for {{pct}}% of tenants.",
	"Watch the error rate and p99 latency for {{small}}0 minutes; both should stay within {{small}}% of the baseline.",
	"Move the remaining tenants in two steps: half, then all.",
	"Switch off the dual write once reads have been on the new store for a full day.",
	"Delete `{{file2}}` and the legacy client in a follow-up change.",
];
const WATCH = [
	"**Error rate** on {{svc}}: page if it stays above {{small}} per thousand requests for five minutes.",
	"**p99 latency** on reads: today's baseline is about {{ms}} ms.",
	"**Queue lag** on `{{queue}}`: it should stay under a second; steady growth means the consumer is stuck on the new store.",
	"**Comparison job**: any non-zero difference stops the rollout, whatever the other graphs say.",
	"**Connections** on the new database: the pool limit is {{small}}0 per pod, so the total should never pass that times the replica count.",
];
const ROLLBACK = [
	"**Reads misbehaving:** turn `{{flag}}` off. Reads return to the legacy store on the next request; no deploy is needed.",
	"**Writes failing:** the dual write stays on until step 6, so the legacy table is complete. Turn the flag off and restart the pods.",
	"**Backfill too slow:** stop the job. It records its position and resumes from the last good batch.",
	"**After step 6:** rolling back needs the reverse sync job. It works in staging but is slow, so treat step 6 as the point of no return.",
];
const COMMAND_NOTES = [
	"`rollout status` waits up to five minutes; if it times out, read the pod events before retrying.",
	"`compare-tables.sh` exits non-zero on any difference and prints the first {{small}}0 ids.",
	"The flag script is idempotent, so running it twice does no harm.",
	"Keep the terminal output and paste it into the change record afterwards.",
];

// ---------------------------------------------------------------------------------------------------------------
// Text builders

const prose = (c: Ctx, k: number, pool: readonly string[] = PROSE): string =>
	sample(pool, k)
		.map((s) => fill(s, c))
		.join(" ");
const fence = (c: Ctx, s: Snippet): string => `\`\`\`${s.lang}\n${fill(s.lines.join("\n"), c)}\n\`\`\``;
const render = (c: Ctx, items: readonly string[], numbered: boolean): string =>
	items.map((s, i) => `${numbered ? `${i + 1}.` : "-"} ${fill(s, c)}`).join("\n");
const list = (c: Ctx, items: readonly string[], k: number, numbered: boolean): string =>
	render(c, sample(items, k), numbered);

function mediumAnswer(c: Ctx): string {
	const parts = [
		prose(c, int(1, 2)),
		`## ${fill(pick(HEADINGS), c)}`,
		list(c, BULLETS, int(3, 5), chance(0.5)),
		pick(CODE_INTROS),
		fence(c, pick(SNIPPETS)),
	];
	if (chance(0.5)) parts.push(prose(c, 1));
	return parts.join("\n\n");
}

/** 1,500–4,000 characters with at least two code blocks. */
function longAnswer(c: Ctx): string {
	const parts = [prose(c, 3)];
	const target = int(1500, 2600);
	let blocks = 0;
	while (parts.join("\n\n").length < target || blocks < 2) {
		parts.push(`## ${fill(pick(HEADINGS), c)}`, prose(c, int(1, 3)));
		if (blocks < 2 || chance(0.6)) {
			parts.push(fence(c, pick(SNIPPETS)));
			blocks++;
		} else parts.push(list(c, BULLETS, int(3, 5), chance(0.4)));
	}
	return parts.join("\n\n");
}

/** The live run's answer: 9,000–12,000 characters with headings, lists, a table and ts/bash/json/sql/yaml blocks. */
function liveAnswer(c: Ctx): string {
	const f = (s: string): string => fill(s, c);
	type Section = { optional: boolean; text: string };
	const sec = (optional: boolean, ...parts: string[]): Section => ({ optional, text: parts.join("\n\n") });
	const rows = [
		c.svc,
		...sample(
			SERVICES.filter((s) => s !== c.svc),
			6,
		),
	].map(
		(s) =>
			`| ${s} | ${pick(["new", "new", "dual", "legacy"])} | ${pick(["dual", "dual", "new", "legacy"])} | \`${s.replace(/-/g, "_")}_new_reads\` ${pick(["on", "off"])} | ${pick(["done", "soaking", "ready", "blocked on backfill", "not started"])} |`,
	);
	const table = ["| Service | Reads | Writes | Flag | Status |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
	const sections: Section[] = [
		sec(
			false,
			f(
				"Here is the cut-over plan for **{{svc}}**, written so whoever is on call can follow it without the history of this thread. The status check above is the starting point: reads are still on the legacy store, writes are dual, and `{{table}}` shows no drift over the last day.",
			),
			prose(c, 3),
		),
		sec(
			false,
			"## Where things stand",
			prose(c, 3),
			table,
			"Anything marked **soaking** needs one more clean day before it moves; anything **blocked** waits for its backfill.",
		),
		sec(
			false,
			"## The plan",
			prose(c, 2),
			render(c, PLAN_STEPS, true),
			"The routing change itself is small. Writes go through one function that checks the flag per tenant:",
			fence(c, TS_ROUTING),
			prose(c, 2),
		),
		sec(
			false,
			"## Commands",
			"Run these from the repo root with production credentials loaded. The script stops at the first failure, so a half-finished run is safe to repeat.",
			fence(c, BASH_DEPLOY),
			render(c, COMMAND_NOTES, false),
		),
		sec(
			false,
			"## Configuration",
			"The service reads its settings from one file per environment. This is the production file after the change; only the `flags` block and the pool size differ from today:",
			fence(c, JSON_CONFIG),
			prose(c, 2),
		),
		sec(
			false,
			"## Backfill",
			prose(c, 3),
			fence(c, SQL_BACKFILL),
			render(
				c,
				[
					"Batches of {{n}}0 rows keep each transaction well under a second.",
					"The index is built **concurrently**, so writes are never blocked.",
					"Re-running the update is safe: it only touches rows where `{{col}}` is still null.",
				],
				false,
			),
		),
		sec(
			true,
			"## The client wrapper",
			f("Every read now goes through `{{fn}}`, which adds a timeout and turns exceptions into results:"),
			fence(c, TS_CLIENT),
			prose(c, 2),
		),
		sec(
			true,
			"## Deployment",
			"The manifest doesn't change apart from the image tag, but here it is for reference:",
			fence(c, YAML_DEPLOY),
			prose(c, 1),
		),
		sec(false, "## What to watch", "Keep these open for the whole window:", render(c, WATCH, false)),
		sec(
			false,
			"## Rollback",
			"If anything looks wrong, roll back first and investigate afterwards:",
			render(c, ROLLBACK, false),
			prose(c, 1),
		),
	];
	const closing = sec(
		false,
		"## Next steps",
		render(
			c,
			[
				"Review this plan and the open pull request for `{{file}}`.",
				"Book the window with the on-call team for {{svc}}.",
				"Run the whole cut-over once more in staging as a dress rehearsal.",
				"Hold a short review a week later to retire the flag and delete the legacy code.",
			],
			true,
		),
		"I can turn this into a runbook page, or open the follow-up change for the legacy client, whenever you're ready.",
	).text;

	// Fit the budget: drop optional sections while long, then add soak notes while short.
	const join = (s: readonly Section[]): string => s.map((x) => x.text).join("\n\n");
	let body = sections;
	while (join(body).length + closing.length > 11_000 && body.some((s) => s.optional)) {
		const drop = body.findIndex((s) => s.optional);
		body = body.filter((_, i) => i !== drop);
	}
	const notes: string[] = [];
	while (join(body).length + closing.length + notes.join("\n\n").length + 40 < 9_600) notes.push(prose(c, 3));
	const text = [join(body), ...(notes.length > 0 ? ["## Notes from the soak", ...notes] : []), closing].join("\n\n");
	if (text.length < 9_000 || text.length > 12_000)
		throw new Error(`live answer is ${text.length} characters, outside 9,000-12,000`);
	return text;
}

/** Splits text into deltas of 2–8 words, mostly 2–4; the skew's scale adapts so there are about 700 deltas. */
function chunkText(text: string): string[] {
	const words = text.match(/\s*\S+/g) ?? [text];
	let scale = 1;
	let sizes: number[] = [];
	for (let attempt = 0; attempt < 40; attempt++) {
		sizes = [];
		for (let left = words.length; left > 0; ) {
			let size = Math.min(left, 8, 2 + Math.floor(-Math.log(1 - rnd()) * scale));
			if (left - size === 1) size = size < 8 ? size + 1 : size - 1; // never leave a single word behind
			sizes.push(size);
			left -= size;
		}
		if (sizes.length >= 620 && sizes.length <= 780) break;
		scale = Math.max(0.05, (scale * sizes.length) / 700);
	}
	const chunks: string[] = [];
	let start = 0;
	for (const size of sizes) {
		chunks.push(words.slice(start, start + size).join(""));
		start += size;
	}
	if (chunks.join("") !== text) throw new Error("streamed chunks do not add up to the answer");
	return chunks;
}

// ---------------------------------------------------------------------------------------------------------------
// Session state: ids, the clock and token accounting

const entries: EntryRecord[] = []; // the snapshot's history
let entryId = 0;
let taskId = 0;
let submissionId = 0;
let callSeq = 0;
let clock = START_TS;
let context = 3_200; // tokens already in the conversation: system prompt and tool definitions to start with
let pending = 0; // tokens added since the last model call
const totals = { input: 0, output: 0 };
const toolCounts: Record<string, number> = {};

const tok = (chars: number): number => Math.ceil(chars / 4);
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const countTool = (name: string): void => {
	toolCounts[name] = (toolCounts[name] ?? 0) + 1;
};
const usageSummary = (): Record<string, unknown> => ({
	models: { "faux/faux-1": { ...totals } },
	tools: { ...toolCounts },
});

function usage(input: number, output: number, cacheRead: number): Usage {
	const cost = {
		input: round6(input * 3e-6),
		output: round6(output * 15e-6),
		cacheRead: round6(cacheRead * 3e-7),
		cacheWrite: 0,
		total: 0,
	};
	cost.total = round6(cost.input + cost.output + cost.cacheRead);
	return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost };
}

type Call = { input: number; cacheRead: number };

function beginCall(): Call {
	const call = { input: pending + int(30, 160), cacheRead: context };
	pending = 0;
	return call;
}

function endCall(call: Call, output: number): void {
	context += call.input + output;
	if (context > 150_000) context = int(18_000, 30_000); // stands in for a compaction
	totals.input += call.input;
	totals.output += output;
}

function entry(kind: string, message: Message, byTaskId?: number, data?: unknown): EntryRecord {
	const record: EntryRecord = { id: ++entryId, conversationId: 1, kind, model: [message] };
	if (data !== undefined) record.data = data;
	if (byTaskId !== undefined) record.byTaskId = byTaskId;
	return record;
}

const userMessage = (text: string, timestamp: number): UserMessage => ({ role: "user", content: text, timestamp });

function assistantMessage(
	content: AssistantMessage["content"],
	call: Call,
	output: number,
	stopReason: StopReason,
	timestamp: number,
	durationMs?: number,
): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		...MODEL,
		usage: usage(call.input, output, call.cacheRead),
		stopReason,
		timestamp,
	};
	if (durationMs !== undefined) message.durationMs = durationMs;
	return message;
}

function toolResultMessage(
	toolCallId: string,
	toolName: string,
	text: string,
	isError: boolean,
	timestamp: number,
	durationMs: number,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp,
		durationMs,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// History: completed runs for the snapshot

function pushUser(text: string): void {
	entries.push(entry("pi.user", userMessage(text, clock)));
	pending += tok(text.length);
}

function pushAssistant(c: Ctx, body: (TextContent | ToolCall)[]): void {
	const content: AssistantMessage["content"] = chance(0.2)
		? [{ type: "thinking", thinking: fill(pick(THOUGHTS), c) }, ...body]
		: body;
	const chars = content.reduce(
		(n, b) =>
			n +
			(b.type === "text"
				? b.text.length
				: b.type === "thinking"
					? b.thinking.length
					: JSON.stringify(b.arguments).length),
		0,
	);
	const output = tok(chars);
	const call = beginCall();
	const timestamp = clock + int(150, 900);
	const durationMs = output * int(10, 22) + int(200, 700);
	clock = timestamp + durationMs;
	endCall(call, output);
	const stop = body.some((b) => b.type === "toolCall") ? "toolUse" : "stop";
	entries.push(entry("pi.assistant", assistantMessage(content, call, output, stop, timestamp, durationMs), ++taskId));
}

type ToolPlan = { name: ToolName; args: Record<string, unknown>; output: string; isError: boolean; durationMs: number };

function toolBody(name: ToolName, c: Ctx): { args: Record<string, unknown>; lines: string[] } {
	switch (name) {
		case "bash": {
			const b = pick(BASH);
			return {
				args: { command: fill(b.cmd, c) },
				lines: [...(b.head === undefined ? [] : [b.head]), ...repeat(int(1, 12), () => fill(b.line, c))],
			};
		}
		case "read":
			return {
				args: { path: c.file },
				lines: fill(pick([TS_CLIENT, TS_ROUTING]).lines.join("\n"), c)
					.split("\n")
					.slice(0, int(1, 15)),
			};
		case "grep":
			return {
				args: { pattern: c.fn, path: `services/${c.svc}` },
				lines: repeat(int(1, 8), () => fill(pick(GREP_LINES), c)),
			};
		case "edit": {
			const args = {
				path: c.file,
				oldText: fill('import { {{fn}} } from "../legacy/{{mod}}.ts";', c),
				newText: fill('import { {{fn}} } from "{{pkg}}";', c),
			};
			return { args, lines: [`Edited ${c.file}: 1 replacement.`] };
		}
		case "write": {
			const path = fill("services/{{svc}}/migrations/{{n}}_add_{{col}}.sql", c);
			const content = `${fill(SQL_BACKFILL.lines.join("\n"), c)}\n`;
			return { args: { path, content }, lines: [`Wrote ${content.length} bytes to ${path}.`] };
		}
	}
}

function planTool(c: Ctx): ToolPlan {
	const r = rnd();
	const name: ToolName = r < 0.4 ? "bash" : r < 0.65 ? "read" : r < 0.8 ? "grep" : r < 0.92 ? "edit" : "write";
	const isError = chance(0.1);
	const { args, lines } = toolBody(name, c);
	const output = isError ? fill(pick(ERRORS[name]), c) : `${lines.join("\n")}\n`;
	return { name, args, output, isError, durationMs: name === "bash" ? int(400, 30_000) : int(8, 220) };
}

/** Text and 1–3 tool calls, one result entry per call, then a final answer. */
function toolRun(c: Ctx): void {
	pushUser(fill(pick(TOOL_PROMPTS), c));
	const steps = repeat(int(1, 3), () => {
		const plan = planTool(c);
		const call: ToolCall = { type: "toolCall", id: `call-${++callSeq}`, name: plan.name, arguments: plan.args };
		return { plan, call };
	});
	pushAssistant(c, [{ type: "text", text: fill(pick(TOOL_INTROS), c) }, ...steps.map((s) => s.call)]);
	for (const { plan, call } of steps) {
		clock += int(5, 60) + plan.durationMs;
		const result = toolResultMessage(call.id, plan.name, plan.output, plan.isError, clock, plan.durationMs);
		entries.push(entry("pi.tool-result", result, ++taskId, { diagnostics: [] }));
		pending += tok(plan.output.length);
		countTool(plan.name);
	}
	const failed = steps.some((s) => s.plan.isError);
	pushAssistant(c, [
		{ type: "text", text: (failed ? `${fill(pick(ERROR_ACKS), c)} ` : "") + prose(c, int(1, 3), WRAPUPS) },
	]);
}

function historyRun(): void {
	const c = runContext();
	submissionId++;
	taskId++; // the run itself
	clock += chance(0.7) ? int(4_000, 60_000) : int(60_000, 300_000);
	const r = rnd();
	if (r < 0.45) {
		pushUser(fill(pick(SHORT_PROMPTS), c));
		let text = prose(c, int(1, 4), SHORT_ANSWERS);
		if (chance(0.25)) text += `\n\n${list(c, BULLETS, int(2, 4), false)}`;
		pushAssistant(c, [{ type: "text", text }]);
	} else if (r < 0.8) {
		toolRun(c);
	} else if (r < 0.95) {
		pushUser(fill(pick(MEDIUM_PROMPTS), c));
		pushAssistant(c, [{ type: "text", text: mediumAnswer(c) }]);
	} else {
		pushUser(fill(pick(LONG_PROMPTS), c));
		pushAssistant(c, [{ type: "text", text: longAnswer(c) }]);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// The live run, as recorded batches

function liveRun(c: Ctx): RecordedBatch[] {
	const batches: RecordedBatch[] = [];
	let at = 0;
	const t0 = clock + int(20_000, 90_000) - 500; // wall-clock time at `at` = 0
	const advance = (gap: number): number => {
		at += gap;
		return t0 + at;
	};
	const push = (...events: AgentEvent[]): void => {
		batches.push({ seq: batches.length + 1, at, events });
	};
	// Each message_update carries the usage so far, its output growing as content arrives.
	const updater = (call: Call): ((changes: MessageChange[], chars: number) => AgentEvent) => {
		let streamed = 0;
		return (changes, chars) => {
			streamed += chars;
			return { type: "message_update", usage: usage(call.input, tok(streamed), call.cacheRead), changes };
		};
	};

	// The user's message is placed and the run starts.
	let now = advance(500);
	const prompt = fill(LIVE_PROMPT, c);
	const user = userMessage(prompt, now);
	const userEntry = entry("pi.user", user);
	pending += tok(prompt.length);
	const sub = ++submissionId;
	taskId++; // the run itself
	push(
		{ type: "message_start", message: user },
		{ type: "message_end", entry: userEntry },
		{
			type: "submission",
			record: { id: sub, conversationId: 1, type: "input", status: "placed", entry: userEntry.id },
		},
	);
	advance(50);
	push({ type: "run_start", inputs: [sub] }, { type: "turn_start" });

	// Turn 1: think, then call bash.
	const call1 = beginCall();
	const start1 = advance(250);
	push({ type: "message_start", message: assistantMessage([], call1, 0, "pending", start1) });
	const up1 = updater(call1);
	const thoughts = LIVE_THOUGHTS.map((t) => fill(t, c));
	thoughts.forEach((piece, i) => {
		advance(i === 0 ? 120 : 100);
		push(
			up1(
				[
					i === 0
						? { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: piece } }
						: { type: "thinking_delta", contentIndex: 0, delta: piece },
				],
				piece.length,
			),
		);
	});
	const command = fill(LIVE_COMMAND, c);
	const callId = `call-${++callSeq}`;
	advance(100);
	push(
		up1(
			[
				{
					type: "toolcall_start",
					contentIndex: 1,
					block: { type: "toolCall", id: callId, name: "bash", arguments: { command: "" } },
				},
			],
			0,
		),
	);
	const cut = Math.max(1, command.indexOf(" --"));
	for (const part of [command.slice(0, cut), command.slice(cut)]) {
		advance(80);
		push(up1([{ type: "toolcall_delta", contentIndex: 1, path: ["arguments", "command"], delta: part }], part.length));
	}
	const thinking = thoughts.join("");
	const out1 = tok(thinking.length + command.length);
	now = advance(100);
	endCall(call1, out1);
	const toolCall: ToolCall = { type: "toolCall", id: callId, name: "bash", arguments: { command } };
	const callEntry = entry(
		"pi.assistant",
		assistantMessage([{ type: "thinking", thinking }, toolCall], call1, out1, "toolUse", start1, now - start1),
		++taskId,
	);
	const toolTask = ++taskId;
	const toolStart = now;
	push(
		{ type: "message_end", entry: callEntry },
		{ type: "tool_execution_start", toolCallId: callId, toolName: "bash", taskId: toolTask, args: { command } },
	);

	// The tool streams its output in 4–8 appends about 150 ms apart.
	const status = LIVE_STATUS.map((line) => `${fill(line, c)}\n`);
	const appends = int(4, 8);
	for (let i = 0; i < appends; i++) {
		const chunk = status
			.slice(Math.floor((i * status.length) / appends), Math.floor(((i + 1) * status.length) / appends))
			.join("");
		advance(150 + int(-15, 15));
		push({
			type: "tool_execution_update",
			toolCallId: callId,
			toolName: "bash",
			taskId: toolTask,
			output: { append: chunk },
		});
	}
	now = advance(120);
	const toolOutput = status.join("");
	const result = toolResultMessage(callId, "bash", toolOutput, false, now, now - toolStart);
	const resultEntry = entry("pi.tool-result", result, toolTask, { diagnostics: [] });
	pending += tok(toolOutput.length);
	countTool("bash");
	push(
		{ type: "tool_execution_end", toolCallId: callId, toolName: "bash", taskId: toolTask, entry: resultEntry },
		{ type: "message_start", message: result },
		{ type: "message_end", entry: resultEntry },
		{ type: "turn_end" },
	);

	// Turn 2: the long answer, one text delta every 50 ms.
	const call2 = beginCall();
	const start2 = advance(150);
	push({ type: "turn_start" }, { type: "message_start", message: assistantMessage([], call2, 0, "pending", start2) });
	const answer = liveAnswer(c);
	const up2 = updater(call2);
	chunkText(answer).forEach((chunk, i) => {
		advance(i === 0 ? 200 : 50);
		push(
			up2(
				[
					i === 0
						? { type: "text_start", contentIndex: 0, block: { type: "text", text: chunk } }
						: { type: "text_delta", contentIndex: 0, delta: chunk },
				],
				chunk.length,
			),
		);
	});
	const out2 = tok(answer.length);
	now = advance(80);
	endCall(call2, out2);
	const answerEntry = entry(
		"pi.assistant",
		assistantMessage([{ type: "text", text: answer }], call2, out2, "stop", start2, now - start2),
		++taskId,
	);
	push(
		{ type: "message_end", entry: answerEntry },
		{ type: "turn_end" },
		{ type: "run_end", inputs: [sub] },
		{
			type: "submission",
			record: {
				id: sub,
				conversationId: 1,
				type: "input",
				status: "done",
				entry: userEntry.id,
				answer: answerEntry.id,
			},
		},
		{ type: "usage_changed", usage: usageSummary() },
	);
	return batches;
}

// ---------------------------------------------------------------------------------------------------------------
// CLI

function main(): void {
	const { values } = parseArgs({
		options: {
			turns: { type: "string", default: "2000" },
			seed: { type: "string", default: "2000" },
			out: { type: "string" },
		},
	});
	const turns = Number(values.turns);
	const seed = Number(values.seed);
	if (!Number.isInteger(turns) || turns < 1) throw new Error("--turns must be a positive integer");
	if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
	rnd = mulberry32(seed);

	for (let run = 1; run < turns; run++) historyRun();
	const snapshot: SnapshotEvent = {
		type: "snapshot",
		entries,
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: { model: { provider: "faux", modelId: "faux-1" } },
		usage: usageSummary(),
	};
	const live = liveRun({ ...runContext(), env: "production" });

	const header: RecordingHeader = {
		recording: "pi-durable/watchEvents",
		pi: { repo: "earendil-works/pi", commit: PI_COMMIT, package: "@earendil-works/pi-durable" },
		title: "Platform migration, long-running",
		note: `Generated by apps/console/scripts/generate-fixture.ts with --seed ${seed} --turns ${turns}; do not edit by hand. The snapshot holds ${turns - 1} completed runs; the last run streams live and ends in a long markdown answer.`,
	};
	const first: RecordedBatch = { seq: 0, at: 0, events: [snapshot] };
	const text = `${[header, first, ...live].map((line) => JSON.stringify(line)).join("\n")}\n`;

	const outPath =
		values.out === undefined
			? fileURLToPath(new URL(`../../../fixtures/pi-durable/long-${turns}.jsonl`, import.meta.url))
			: resolve(values.out);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, text);
	console.log(
		`${outPath}: ${turns} runs, ${entryId} entries, ${live.length} live batches, ${Buffer.byteLength(text)} bytes`,
	);
}

main();
