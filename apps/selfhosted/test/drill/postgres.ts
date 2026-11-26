// The Postgres drill: does the control plane survive what its database does? Run with Bun, beside Docker:
//
//   bun apps/selfhosted/test/drill/postgres.ts --database-url URL [--network NET] [--image IMAGE]
//     [--outage-command CMD] [--restore-url URL] [--gateways 3] [--writers 6] [--watch URL]... [--report FILE]
//
// It starts its own gateways, from the installed gateway image, as containers on NET with KANTEL_DATABASE_URL=URL, in a
// schema of their own (drill_<run>), so it never touches an install's tables, and runs three drills:
//
// 1. Concurrent start: every gateway starts at once on the empty schema. Each must become ready, with no error in its
//    log, and the schema must have every table.
// 2. Outage under load: writers create environments through every gateway (each write a row, acknowledged by a 201),
//    then CMD runs, which takes Postgres away and brings it back, or moves the URL's endpoint to a promoted standby.
//    The gateways must write again without being restarted, and every acknowledged write must still be there. With no
//    CMD, the drill waits for a failover you start yourself (from your provider's console, say).
// 3. Restore: a backup (pg_dump of the schema) taken under the same load is restored into the empty database at the
//    restore URL, and a gateway with the first one's bootstrap file starts on it. It must find its deployment, and
//    every write acknowledged before the backup started must be there.
//
// The database URL is as the gateways reach it from NET: `postgres:5432` on an install's own network, a managed
// service's address on `bridge`. pg_dump, pg_restore and psql run in a postgres container (--pg-image) on NET with the
// same URLs, so use an sslmode both node-postgres and libpq read the same way (verify-full, or none on a private
// network). --database-ca mounts a CA certificate at /etc/kantel/database-ca.pem in every container, as the installer
// does. The drill drops its schema from both databases and removes its containers at the end, unless --keep.
//
// It prints what it measured and writes it as JSON to --report. Exit status: 0 when every check passed, 1 when one
// failed, 2 when the drill couldn't run. The results on a local install are in docs/site/src/content/docs/self-hosting/
// database-drills.md; local-postgres.sh starts the Postgres primary, synchronous standby and restore target used there.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Settle } from "./settle.ts";

const { values } = parseArgs({
	options: {
		"database-url": { type: "string" },
		network: { type: "string", default: "bridge" },
		image: { type: "string", default: `harbour-selfhosted:${process.env.KANTEL_IMAGE_TAG ?? "dev"}` },
		"pg-image": { type: "string", default: "postgres:17-alpine" },
		"database-ca": { type: "string" },
		gateways: { type: "string", default: "3" },
		writers: { type: "string", default: "6" },
		"outage-command": { type: "string" },
		"restore-url": { type: "string" },
		watch: { type: "string", multiple: true, default: [] },
		warmup: { type: "string", default: "10" },
		settle: { type: "string", default: "10" },
		timeout: { type: "string", default: "300" },
		schema: { type: "string" },
		report: { type: "string" },
		keep: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

if (values.help || values["database-url"] === undefined) {
	console.log(
		"usage: bun apps/selfhosted/test/drill/postgres.ts --database-url URL [--network NET] [--image IMAGE]\n" +
			"  [--outage-command CMD] [--restore-url URL] [--gateways N] [--writers N] [--watch URL]... [--report FILE]\n" +
			"  [--database-ca FILE] [--pg-image IMAGE] [--warmup S] [--settle S] [--timeout S] [--schema NAME] [--keep]",
	);
	process.exit(values.help ? 0 : 2);
}

const databaseUrl = values["database-url"];
const restoreUrl = values["restore-url"];
const network = values.network;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const schema = values.schema ?? `drill_${run}`;
const gatewayCount = whole("gateways", 1);
const writerCount = whole("writers", 1);
const warmupMs = whole("warmup", 0) * 1000;
const settleMs = whole("settle", 1) * 1000;
const timeoutMs = whole("timeout", 10) * 1000;
const bootstrapFile = "/tmp/kantel-drill/bootstrap.json";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function whole(name: keyof typeof values, least: number): number {
	const value = Number(values[name]);
	if (!Number.isInteger(value) || value < least) {
		console.error(`--${name} must be a whole number, at least ${least}`);
		process.exit(2);
	}
	return value;
}

// Only a schema of the drill's own: it drops the schema at the end.
if (!/^drill_[a-z0-9_]{1,57}$/.test(schema)) {
	console.error("--schema must be drill_ and lower-case letters, digits and underscores");
	process.exit(2);
}

// ---- Checks and the report ----

interface Check {
	readonly drill: string;
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: unknown;
}
const checks: Check[] = [];
const results: Record<string, unknown> = { run, schema, network, image: values.image, gateways: gatewayCount };
const startedAt = Date.now();
const since = (at: number) => `${((at - startedAt) / 1000).toFixed(1)}s`;

function check(drill: string, name: string, ok: boolean, detail?: unknown): boolean {
	checks.push({ drill, name, ok, ...(detail === undefined ? {} : { detail }) });
	console.log(
		`${ok ? "ok  " : "FAIL"} [${drill}] ${name}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
	);
	return ok;
}

function say(message: string) {
	console.log(`     ${since(Date.now())} ${message}`);
}

// ---- Docker ----

interface Ran {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

function docker(args: readonly string[], input?: Buffer): Ran {
	const ran = spawnSync("docker", args, { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
	return { status: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

/** A command in the background, its output passed through; resolves with its exit status. */
function background(
	command: string,
	args: readonly string[],
	stdout: number | "inherit" | "ignore" = "inherit",
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", stdout, "inherit"] });
		child.on("exit", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}

const caMount =
	values["database-ca"] === undefined ? [] : ["-v", `${values["database-ca"]}:/etc/kantel/database-ca.pem:ro`];

/** psql against `url`, one statement, its rows as tab-separated lines. */
function psql(url: string, sql: string): Ran {
	return docker([
		"run",
		"--rm",
		"-i",
		"--network",
		network,
		...caMount,
		values["pg-image"],
		"psql",
		"--no-psqlrc",
		"-v",
		"ON_ERROR_STOP=1",
		"-At",
		"-F",
		"\t",
		"-d",
		url,
		"-c",
		sql,
	]);
}

// ---- Gateways ----

interface Gateway {
	readonly name: string;
	baseUrl: string;
	startedAt?: string;
}

let scratch = "";
const containers: string[] = [];
/** The databases the drill made its schema in, which it drops at the end. */
const madeIn: string[] = [];

/** Creates a gateway container on `url` (not started). */
async function createGateway(name: string, url: string): Promise<Gateway> {
	// Settings go in an env file, so the database URL's password isn't on a command line.
	const envFile = join(scratch, `${name}.env`);
	const settings = {
		KANTEL_DATABASE_URL: url,
		KANTEL_GATEWAY_SCHEMA: schema,
		KANTEL_BOOTSTRAP_FILE: bootstrapFile,
		KANTEL_CONSOLE_DIR: "/harbour/apps/console/dist",
		// With hosts on, as an install's gateway is: the registry of hosts, the relay and the cluster's tables too.
		KANTEL_COMPUTE_PUBLIC_URL: `http://${name}:8080`,
	};
	await writeFile(
		envFile,
		Object.entries(settings)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n"),
		{ mode: 0o600 },
	);
	const created = docker([
		"create",
		"--name",
		name,
		"--network",
		network,
		"--env-file",
		envFile,
		"-p",
		"127.0.0.1::8080",
		...caMount,
		values.image,
		"bun",
		"src/gateway/main.ts",
	]);
	if (created.status !== 0) throw new Error(`docker create ${name}: ${created.stderr.trim()}`);
	containers.push(name);
	return { name, baseUrl: "" };
}

/** Starts the gateways' containers at once (each `docker start` its own process), then reads their ports. */
async function startGateways(gateways: readonly Gateway[]): Promise<void> {
	const statuses = await Promise.all(
		gateways.map((gateway) => background("docker", ["start", gateway.name], "ignore")),
	);
	const failed = gateways.filter((_, n) => statuses[n] !== 0).map((gateway) => gateway.name);
	if (failed.length > 0) throw new Error(`docker start failed for ${failed.join(", ")}`);
	for (const gateway of gateways) described(gateway);
}

/** A started gateway's address on the host, and when it started. */
function described(gateway: Gateway) {
	const port = docker(["port", gateway.name, "8080/tcp"]).stdout.trim().split("\n")[0] ?? "";
	gateway.baseUrl = `http://${port.replace(/^0\.0\.0\.0/, "127.0.0.1")}`;
	gateway.startedAt = inspect(gateway.name).StartedAt;
}

interface ContainerState {
	readonly Running: boolean;
	readonly StartedAt: string;
	readonly ExitCode: number;
	readonly RestartCount: number;
}

function inspect(name: string): ContainerState {
	const out = docker(["inspect", "--format", "{{json .State}} {{.RestartCount}}", name]).stdout.trim();
	const split = out.lastIndexOf(" ");
	const state = JSON.parse(out.slice(0, split)) as Omit<ContainerState, "RestartCount">;
	return { ...state, RestartCount: Number(out.slice(split + 1)) };
}

function logs(name: string): string {
	const out = docker(["logs", name]);
	return `${out.stdout}${out.stderr}`;
}

/** Waits for `/readyz` to answer 200; the milliseconds it took, or undefined if it never did within `limitMs`. */
async function ready(baseUrl: string, from: number, limitMs: number): Promise<number | undefined> {
	while (Date.now() - from < limitMs) {
		try {
			const answer = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(2_000) });
			if (answer.status === 200) return Date.now() - from;
		} catch {}
		await pause(100);
	}
	return undefined;
}

async function bootstrapOf(gateway: Gateway): Promise<{ organisationId: string; apiKey: string; computeKey: string }> {
	const read = docker(["exec", gateway.name, "cat", bootstrapFile]);
	if (read.status !== 0) throw new Error(`reading ${gateway.name}'s bootstrap: ${read.stderr.trim()}`);
	return JSON.parse(read.stdout);
}

// ---- Load: writers creating environments, each acknowledged by a 201 ----

interface Write {
	readonly gateway: number;
	readonly name: string;
	readonly at: number;
	readonly ms: number;
	readonly ok: boolean;
	readonly error?: string;
}

function load(gateways: readonly Gateway[], key: string, settle: Settle) {
	const writes: Write[] = [];
	let running = true;
	let sequence = 0;
	const writer = async (n: number) => {
		const gateway = n % gateways.length;
		while (running) {
			const name = `drill-${(sequence++).toString(36)}`;
			const at = Date.now();
			settle.started(gateway, n, at);
			try {
				const answer = await fetch(`${gateways[gateway]?.baseUrl}/v1/environments`, {
					method: "POST",
					headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
					body: JSON.stringify({ name }),
					signal: AbortSignal.timeout(60_000),
				});
				const body = (await answer.json().catch(() => ({}))) as { name?: string; error?: { code?: string } };
				const ok = answer.status === 201 && body.name === name;
				writes.push({
					gateway,
					name,
					at,
					ms: Date.now() - at,
					ok,
					...(ok ? {} : { error: `${answer.status} ${body.error?.code ?? ""}`.trim() }),
				});
			} catch (error) {
				writes.push({ gateway, name, at, ms: Date.now() - at, ok: false, error: (error as Error).name });
			}
			const last = writes.at(-1);
			if (last !== undefined) settle.finished(gateway, n, last.at, last.at + last.ms, last.ok);
			if (last?.ok !== true) await pause(100);
		}
	};
	const writers = Array.from({ length: writerCount }, (_, n) => writer(n));
	return {
		writes,
		async stop() {
			running = false;
			await Promise.all(writers);
		},
	};
}

/** Polls `/readyz` on each URL every 250 ms, recording when each answer changed. */
function readiness(urls: readonly string[]) {
	const changes: { url: string; at: number; ready: boolean }[] = [];
	const last = new Map<string, boolean>();
	let running = true;
	const poll = async (url: string) => {
		while (running) {
			const ok = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2_000) }).then(
				(answer) => answer.status === 200,
				() => false,
			);
			if (last.get(url) !== ok) {
				last.set(url, ok);
				changes.push({ url, at: Date.now(), ready: ok });
			}
			await pause(250);
		}
	};
	const pollers = urls.map(poll);
	return {
		changes,
		async stop() {
			running = false;
			await Promise.all(pollers);
		},
	};
}

/** Every environment the account has, by name, through `gateway`. */
async function environments(gateway: Gateway, key: string): Promise<Set<string> | undefined> {
	const answer = await fetch(`${gateway.baseUrl}/v1/environments`, {
		headers: { authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(60_000),
	}).catch(() => undefined);
	if (answer?.status !== 200) return undefined;
	const body = (await answer.json()) as { items?: { name: string }[] };
	return new Set((body.items ?? []).map((item) => item.name));
}

// ---- The drills ----

async function concurrentStart(): Promise<Gateway[]> {
	const drill = "concurrent start";
	const existing = psql(databaseUrl, `SELECT count(*) FROM pg_namespace WHERE nspname = '${schema}'`);
	if (existing.status !== 0) throw new Error(`can't reach the database with psql: ${existing.stderr.trim()}`);
	if (existing.stdout.trim() !== "0") throw new Error(`schema ${schema} exists already: name another with --schema`);
	madeIn.push(databaseUrl);
	const gateways = await Promise.all(
		Array.from({ length: gatewayCount }, (_, n) => createGateway(`kantel-drill-${run}-${n + 1}`, databaseUrl)),
	);
	say(`starting ${gateways.length} gateways at once on an empty schema ${schema}`);
	const from = Date.now();
	await startGateways(gateways);
	const times = await Promise.all(gateways.map((gateway) => ready(gateway.baseUrl, from, 120_000)));
	results.concurrentStart = { readyMs: times };
	check(
		drill,
		`all ${gateways.length} gateways ready`,
		times.every((ms) => ms !== undefined),
		{ readyMs: times },
	);
	say(`ready after ${times.map((ms) => (ms === undefined ? "never" : `${ms} ms`)).join(", ")}`);
	const errors = gateways.flatMap((gateway) =>
		logs(gateway.name)
			.split("\n")
			.filter((line) => /error|exception|duplicate|already exists|failed/i.test(line))
			.map((line) => `${gateway.name}: ${line}`),
	);
	check(drill, "no error in any gateway's log", errors.length === 0, errors.slice(0, 10));
	const states = gateways.map((gateway) => inspect(gateway.name));
	check(
		drill,
		"every gateway still running, never restarted",
		states.every((state) => state.Running && state.RestartCount === 0),
		states,
	);
	const tables = psql(databaseUrl, `SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' ORDER BY 1`);
	const names = tables.stdout.trim().split("\n");
	const wanted = [
		"audit_events",
		"identity_organisations",
		"identity_api_keys",
		"compute_api_records",
		"compute_hosts",
		"compute_relay_tickets",
	];
	check(
		drill,
		"the schema has every table",
		wanted.every((name) => names.includes(name)),
		{ tables: names.length, missing: wanted.filter((name) => !names.includes(name)) },
	);
	// Each gateway with no bootstrap file makes a deployment of its own: say how many there are now.
	const organisations = psql(databaseUrl, `SELECT count(*) FROM ${schema}.identity_organisations`).stdout.trim();
	results.concurrentStart = { readyMs: times, tables: names.length, organisations: Number(organisations) };
	say(`${names.length} tables; ${organisations} organisations (one per gateway's own bootstrap)`);
	return gateways;
}

interface GatewayRecovery {
	readonly gateway: string;
	readonly failedWrites: number;
	readonly firstFailureAfterMs?: number;
	readonly writesBackAfterMs?: number;
	readonly writesBackAfterCommandMs?: number;
	readonly notReadyMs?: number;
	readonly slowestCallMs: number;
}

async function outage(gateways: Gateway[], key: string) {
	const drill = "outage under load";
	const loadFrom = Date.now();
	const settle = new Settle(gateways.length, loadFrom, settleMs);
	const writes = load(gateways, key, settle);
	const watched = [...gateways.map((gateway) => gateway.baseUrl), ...values.watch];
	const probes = readiness(watched);
	await pause(warmupMs);
	// When the outage began: when the command started, or with no command, when the first call that failed started.
	let t0 = Date.now();
	const before = writes.writes.filter((write) => write.at + write.ms < t0);
	check(drill, "writes succeed before the outage", before.length > 0 && before.every((write) => write.ok), {
		writes: before.length,
		failed: before.filter((write) => !write.ok).length,
	});
	const command = values["outage-command"];
	let commandMs: number | undefined;
	if (command === undefined) {
		say("no --outage-command: start the failover now; waiting for the first failed write");
		const waitFrom = t0;
		const failed = () => writes.writes.filter((write) => write.at >= waitFrom && !write.ok);
		while (failed().length === 0 && Date.now() - waitFrom < timeoutMs) await pause(250);
		if (check(drill, "the failover was seen: a write failed", failed().length > 0)) {
			t0 = Math.min(...failed().map((write) => write.at));
		}
		settle.outageFrom(t0);
	} else {
		settle.outageFrom(t0);
		say(`running the outage command: ${command}`);
		const status = await background("sh", ["-c", command]);
		commandMs = Date.now() - t0;
		check(drill, "the outage command succeeded", status === 0, { status });
		say(`the outage command finished after ${commandMs} ms`);
	}
	// Recovered: every gateway writing again, after `settle` seconds with no write failed or stuck (see settle.ts).
	while (!settle.all(Date.now()) && Date.now() - t0 < timeoutMs) await pause(250);
	const recoveredAt = Date.now();
	const recovered = settle.all(recoveredAt);
	const failuresAtRecovery = gateways.map((_, n) => settle.lastFailure(n));
	check(drill, `every gateway writes again, ${settleMs / 1000} s with no failure`, recovered, {
		afterMs: recoveredAt - t0,
	});
	// The backup, under the same load, for the restore drill.
	let backup: { file: string; startedAt: number; endedAt: number } | undefined;
	if (restoreUrl !== undefined) {
		backup = await dump();
		// Writes after the backup, which a restore must not have.
		await pause(5_000);
	}
	await writes.stop();
	await probes.stop();
	const endedAt = Date.now();
	// The writes still in flight at recovery have finished now: none may have failed since.
	if (recovered) {
		const later = writes.writes.filter(
			(write) => !write.ok && write.at + write.ms > (failuresAtRecovery[write.gateway] ?? Number.POSITIVE_INFINITY),
		);
		check(drill, "no write failed after the gateways recovered", later.length === 0, {
			failed: later.length,
			errors: tally(later.map((write) => write.error ?? "")),
		});
	}

	const recovery: GatewayRecovery[] = gateways.map((gateway, n) => {
		const mine = writes.writes.filter((write) => write.gateway === n && write.at + write.ms >= t0);
		const failed = mine.filter((write) => !write.ok);
		const firstFailure = failed[0];
		const lastFailed = failed.at(-1);
		const back =
			lastFailed === undefined
				? undefined
				: mine.find((write) => write.ok && write.at >= lastFailed.at + lastFailed.ms);
		return {
			gateway: gateway.name,
			failedWrites: failed.length,
			...(firstFailure === undefined ? {} : { firstFailureAfterMs: firstFailure.at + firstFailure.ms - t0 }),
			...(back === undefined ? {} : { writesBackAfterMs: back.at + back.ms - t0 }),
			...(back === undefined || commandMs === undefined
				? {}
				: { writesBackAfterCommandMs: back.at + back.ms - t0 - commandMs }),
			...notReady(probes.changes, gateway.baseUrl, t0),
			slowestCallMs: Math.max(0, ...mine.map((write) => write.ms)),
		};
	});
	const watchedRecovery = values.watch.map((url) => ({ url, ...notReady(probes.changes, url, t0) }));
	const all = writes.writes;
	const acknowledged = all.filter((write) => write.ok);
	results.outage = {
		command: command ?? "(manual)",
		commandMs,
		recoveredAfterMs: recoveredAt - t0,
		writes: all.length,
		acknowledged: acknowledged.length,
		failed: all.length - acknowledged.length,
		errors: tally(all.filter((write) => !write.ok).map((write) => write.error ?? "")),
		recovery,
		watched: watchedRecovery,
		writesPerSecond: Math.round(acknowledged.length / ((endedAt - loadFrom) / 1000)),
	};
	for (const gateway of recovery) {
		say(
			`${gateway.gateway}: ${gateway.failedWrites} failed writes; writes back ${gateway.writesBackAfterMs ?? "-"} ms` +
				` after the outage began (${gateway.writesBackAfterCommandMs ?? "-"} ms after the command finished);` +
				` not ready for ${gateway.notReadyMs ?? 0} ms; slowest call ${gateway.slowestCallMs} ms`,
		);
	}
	for (const url of watchedRecovery) say(`${url.url}: not ready for ${url.notReadyMs ?? 0} ms`);
	const states = gateways.map((gateway) => ({ gateway: gateway.name, ...inspect(gateway.name) }));
	check(
		drill,
		"no gateway was restarted",
		states.every((state, n) => state.Running && state.RestartCount === 0 && state.StartedAt === gateways[n]?.startedAt),
		states,
	);
	if (values.watch.length > 0) {
		const finals = await Promise.all(
			values.watch.map(async (url) => (await ready(url, Date.now(), 30_000)) !== undefined),
		);
		check(drill, "every watched gateway is ready again", finals.every(Boolean), values.watch);
	}
	// Every acknowledged write is in the database, read through each gateway.
	for (const gateway of gateways) {
		const names = await environments(gateway, key);
		const missing = names === undefined ? undefined : acknowledged.filter((write) => !names.has(write.name));
		check(
			drill,
			`every acknowledged write (${acknowledged.length}) reads back through ${gateway.name}`,
			missing?.length === 0,
			{
				listed: names?.size,
				missing: missing?.slice(0, 10).map((write) => write.name),
			},
		);
		if (names !== undefined) {
			const unacknowledged = all.filter((write) => !write.ok && names.has(write.name)).length;
			(results.outage as Record<string, unknown>).failedButWritten = unacknowledged;
		}
	}
	return { acknowledged, backup };
}

function notReady(changes: readonly { url: string; at: number; ready: boolean }[], url: string, t0: number) {
	let total = 0;
	let downAt: number | undefined;
	for (const change of changes.filter((change) => change.url === url)) {
		if (!change.ready && downAt === undefined) downAt = Math.max(change.at, t0);
		if (change.ready && downAt !== undefined) {
			if (change.at > t0) total += change.at - downAt;
			downAt = undefined;
		}
	}
	return downAt === undefined ? (total > 0 ? { notReadyMs: total } : {}) : { notReadyMs: total, stillNotReady: true };
}

function tally(errors: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const error of errors) counts[error] = (counts[error] ?? 0) + 1;
	return counts;
}

/** pg_dump of the drill's schema, in custom format, to a file. */
async function dump() {
	const file = join(scratch, "drill.dump");
	const startedAt = Date.now();
	say("backing up the schema with pg_dump, under load");
	const out = openSync(file, "w", 0o600);
	const status = await background(
		"docker",
		[
			"run",
			"--rm",
			"--network",
			network,
			...caMount,
			values["pg-image"],
			"pg_dump",
			"--format=custom",
			"--no-owner",
			"--no-privileges",
			"--schema",
			schema,
			"-d",
			databaseUrl,
		],
		out,
	);
	closeSync(out);
	const endedAt = Date.now();
	check("restore", "pg_dump took a backup under load", status === 0, { status });
	say(`backup took ${endedAt - startedAt} ms`);
	return { file, startedAt, endedAt };
}

async function restore(
	first: Gateway,
	acknowledged: readonly Write[],
	backup: { file: string; startedAt: number; endedAt: number },
) {
	const drill = "restore";
	if (restoreUrl === undefined) return;
	const empty = psql(restoreUrl, `SELECT count(*) FROM pg_namespace WHERE nspname = '${schema}'`);
	if (
		!check(
			drill,
			"the restore database is reachable and has no drill schema",
			empty.stdout.trim() === "0",
			empty.stderr.trim(),
		)
	)
		return;
	madeIn.push(restoreUrl);
	const from = Date.now();
	const restored = docker(
		[
			"run",
			"--rm",
			"-i",
			"--network",
			network,
			...caMount,
			values["pg-image"],
			"pg_restore",
			"--no-owner",
			"--no-privileges",
			"--exit-on-error",
			"-d",
			restoreUrl,
		],
		readFileSync(backup.file),
	);
	const restoreMs = Date.now() - from;
	if (!check(drill, "pg_restore into a fresh database", restored.status === 0, restored.stderr.trim())) return;
	// A gateway on the restored database, with the first gateway's bootstrap file, as an install's volume would keep.
	const seeded = await bootstrapOf(first);
	const gateway = await createGateway(`kantel-drill-${run}-restored`, restoreUrl);
	const copied = join(scratch, "bootstrap");
	await mkdir(copied);
	await writeFile(join(copied, "bootstrap.json"), JSON.stringify(seeded), { mode: 0o600 });
	const copy = docker(["cp", `${copied}/.`, `${gateway.name}:${bootstrapFile.replace(/\/[^/]+$/, "")}`]);
	if (copy.status !== 0) throw new Error(`copying the bootstrap file: ${copy.stderr.trim()}`);
	const startAt = Date.now();
	await startGateways([gateway]);
	const readyMs = await ready(gateway.baseUrl, startAt, 120_000);
	check(drill, "a gateway starts on the restored database", readyMs !== undefined, { readyMs });
	if (readyMs === undefined) return;
	const after = await bootstrapOf(gateway);
	check(
		drill,
		"it finds its deployment, rather than making a new one",
		after.organisationId === seeded.organisationId,
		{
			before: seeded.organisationId,
			after: after.organisationId,
		},
	);
	const me = await fetch(`${gateway.baseUrl}/v1/me`, { headers: { authorization: `Bearer ${seeded.apiKey}` } });
	check(drill, "the bootstrap's API key from before the backup answers", me.status === 200, { status: me.status });
	const names = await environments(gateway, seeded.computeKey);
	const beforeBackup = acknowledged.filter((write) => write.at + write.ms < backup.startedAt);
	const afterBackup = acknowledged.filter((write) => write.at > backup.endedAt);
	const missing = beforeBackup.filter((write) => !names?.has(write.name));
	check(
		drill,
		`every write acknowledged before the backup (${beforeBackup.length}) is there`,
		names !== undefined && missing.length === 0,
		{
			missing: missing.slice(0, 10).map((write) => write.name),
		},
	);
	const later = afterBackup.filter((write) => names?.has(write.name));
	check(drill, `no write begun after the backup ended (${afterBackup.length}) is there`, later.length === 0, {
		present: later.length,
	});
	results.restore = {
		backupMs: backup.endedAt - backup.startedAt,
		restoreMs,
		gatewayReadyMs: readyMs,
		restoredWrites: names?.size,
		acknowledgedBeforeBackup: beforeBackup.length,
	};
	say(`restore took ${restoreMs} ms; the gateway on it was ready after ${readyMs} ms; ${names?.size} writes restored`);
}

// ---- Main ----

/** Removes the drill's containers, and its schema from each database it made it in, unless --keep. */
function cleanUp() {
	if (values.keep) return;
	if (containers.length > 0) docker(["rm", "-fv", ...containers.splice(0)]);
	for (const url of madeIn.splice(0)) psql(url, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}

async function finish(exitCode: number): Promise<never> {
	cleanUp();
	if (scratch !== "") await rm(scratch, { recursive: true, force: true });
	results.checks = checks;
	results.passed = exitCode === 0;
	if (values.report !== undefined) await writeFile(values.report, `${JSON.stringify(results, null, "\t")}\n`);
	console.log(exitCode === 0 ? "the drill passed" : exitCode === 1 ? "the drill FAILED" : "the drill didn't run");
	process.exit(exitCode);
}

// Interrupted: still remove what the drill made.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		console.error(`the drill was interrupted (${signal})`);
		void finish(2);
	});
}

try {
	scratch = await mkdtemp(join(tmpdir(), "kantel-drill-"));
	const pulled = docker(["image", "inspect", values.image]);
	if (pulled.status !== 0) {
		throw new Error(`no image ${values.image}: build it (install.sh does) or name it with --image`);
	}
	say(`run ${run}, schema ${schema}, network ${network}, image ${values.image}`);
	const gateways = await concurrentStart();
	const first = gateways[0];
	if (first === undefined || !checks.every((c) => c.ok)) await finish(1);
	else {
		const { computeKey } = await bootstrapOf(first);
		const { acknowledged, backup } = await outage(gateways, computeKey);
		if (backup !== undefined) await restore(first, acknowledged, backup);
		await finish(checks.every((c) => c.ok) ? 0 : 1);
	}
} catch (error) {
	console.error(`the drill couldn't run: ${(error as Error).message}`);
	await finish(2);
}
