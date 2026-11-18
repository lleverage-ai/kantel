// The deploy runs `wrangler deploy harbour` again when Cloudflare's container registry times out pushing an image
// (scripts/retry-registry.ts), and fails at once on anything else.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Attempt, isRegistryNetworkFailure, runWithRetry } from "../scripts/retry-registry.ts";

// Main's failed deploy of 13 November 2026 (run 43463959893), as Docker printed it.
const TIMED_OUT =
	'failed commit on ref "layer-sha256:b463165bfa2275e5cf32b165a43d8258e6e613703ce631d4c886fe39d371b998": failed to do request: ' +
	'Put "https://registry.cloudflare.com/v2/aac2b1acf442d4019d2912d96f7afe34/harbour-harbourbrowser/blobs/uploads/' +
	'cb77c717-c3ec-442a-89c0-aa8eb11085d1?_stateHash=81cacdfc&digest=sha256%3Ab463165b": net/http: timeout awaiting response headers';

describe("a registry network failure", () => {
	it("is the push timing out on a line naming the registry", () => {
		expect(
			isRegistryNetworkFailure(`Uploaded harbour (9.87 sec)\n${TIMED_OUT}\nDocker command exited with code: 1`),
		).toBe(true);
		expect(
			isRegistryNetworkFailure(
				'Put "https://registry.cloudflare.com/v2/a/b/blobs/uploads/c": read tcp 10.0.0.2:4431->1.1.1.1:443: read: connection reset by peer',
			),
		).toBe(true);
	});

	it("isn't a build error, a refused push, or a timeout somewhere else", () => {
		expect(
			isRegistryNetworkFailure('ERROR: failed to solve: process "/bin/sh -c apt-get update" did not complete'),
		).toBe(false);
		expect(
			isRegistryNetworkFailure("denied: requested access to the resource is denied (registry.cloudflare.com/a/b)"),
		).toBe(false);
		expect(
			isRegistryNetworkFailure(
				'Get "https://api.cloudflare.com/client/v4/accounts": net/http: timeout awaiting response headers',
			),
		).toBe(false);
		// The host and the failure on different lines aren't one failure.
		expect(isRegistryNetworkFailure("The push refers to repository [registry.cloudflare.com/a/b]\ni/o timeout")).toBe(
			false,
		);
	});
});

/** Answers the attempts in turn, counting them, with every wait recorded and skipped. */
function scripted(...answers: Attempt[]) {
	const waits: number[] = [];
	const logs: string[] = [];
	let runs = 0;
	const options = {
		run: async () => answers[runs++] ?? { code: 0, registryFailure: false },
		wait: async (ms: number) => waits.push(ms),
		log: (line: string) => logs.push(line),
	};
	return { options, waits, logs, runs: () => runs };
}

describe("running with retries", () => {
	it("runs again after a registry timeout, waiting longer each time, until it succeeds", async () => {
		const s = scripted(
			{ code: 1, registryFailure: true },
			{ code: 1, registryFailure: true },
			{ code: 0, registryFailure: false },
		);
		await expect(runWithRetry("wrangler", ["deploy"], { attempts: 3, delaySeconds: 20, ...s.options })).resolves.toBe(
			0,
		);
		expect(s.runs()).toBe(3);
		expect(s.waits).toEqual([20_000, 40_000]);
		expect(s.logs).toHaveLength(2);
	});

	it("fails at once on any other failure", async () => {
		const s = scripted({ code: 2, registryFailure: false });
		await expect(runWithRetry("wrangler", ["deploy"], { attempts: 3, delaySeconds: 20, ...s.options })).resolves.toBe(
			2,
		);
		expect(s.runs()).toBe(1);
		expect(s.waits).toEqual([]);
	});

	it("stops after the last attempt with the command's exit code", async () => {
		const timedOut = { code: 1, registryFailure: true };
		const s = scripted(timedOut, timedOut, timedOut, { code: 0, registryFailure: false });
		await expect(runWithRetry("wrangler", ["deploy"], { attempts: 3, delaySeconds: 20, ...s.options })).resolves.toBe(
			1,
		);
		expect(s.runs()).toBe(3);
		expect(s.logs.at(-1)).toContain("all 3 attempts");
	});
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The script run as the deploy runs it, around a stand-in command that fails `failures` times with `message` on stderr
 * (counting its runs in a file), then succeeds. Each failure ends `how`: with exit code 1; with the message on stderr
 * in two halves, a line on stdout between them, then exit code 1; or killed by a signal.
 */
function deploy(failures: number, message: string, how: "exit" | "split" | "signal" = "exit") {
	const dir = mkdtempSync(join(tmpdir(), "kantel-retry-registry-"));
	dirs.push(dir);
	const stand = [
		"const fs = require('node:fs');",
		"const [count, failures, message, how] = process.argv.slice(1);",
		"const n = (fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0) + 1;",
		"fs.writeFileSync(count, String(n));",
		"const later = (ms) => new Promise((done) => setTimeout(done, ms));",
		"(async () => {",
		"  if (n > Number(failures)) return console.log('deployed');",
		"  if (how === 'split') {",
		"    const half = Math.floor(message.length / 2);",
		"    process.stderr.write(message.slice(0, half));",
		"    await later(50);",
		"    process.stdout.write('Untagged: harbour-harboursandbox\\n');",
		"    await later(50);",
		"    process.stderr.write(message.slice(half) + '\\n');",
		"  } else console.error(message);",
		"  if (how === 'signal') process.kill(process.pid, 'SIGTERM');",
		"  else process.exit(1);",
		"})();",
	].join("\n");
	const script = join(import.meta.dirname, "../scripts/retry-registry.ts");
	const run = spawnSync(
		process.execPath,
		[
			script,
			"--attempts",
			"3",
			"--delay",
			"0",
			"--",
			process.execPath,
			"-e",
			stand,
			join(dir, "count"),
			String(failures),
			message,
			how,
		],
		{ encoding: "utf8" },
	);
	return {
		status: run.status,
		stdout: run.stdout,
		stderr: run.stderr,
		runs: Number(readFileSync(join(dir, "count"), "utf8")),
	};
}

describe("the script around a command", () => {
	it("succeeds when the command gets through after a registry timeout", () => {
		const run = deploy(1, TIMED_OUT);
		expect(run).toMatchObject({ status: 0, runs: 2 });
		expect(run.stdout).toContain("deployed");
		expect(run.stderr).toContain("timeout awaiting response headers");
		expect(run.stderr).toContain("attempt 1 of 3");
	});

	it("fails at once when the command fails for anything else", () => {
		const run = deploy(1, "✘ [ERROR] Build failed with 1 error");
		expect(run).toMatchObject({ status: 1, runs: 1 });
		expect(run.stderr).not.toContain("attempt 1 of 3");
	});

	it("reads stdout and stderr each on its own, so a line on one doesn't cut the other's in two", () => {
		expect(deploy(1, TIMED_OUT, "split")).toMatchObject({ status: 0, runs: 2 });
	});

	it("doesn't run again when the command was stopped by a signal", () => {
		expect(deploy(1, TIMED_OUT, "signal")).toMatchObject({ status: 1, runs: 1 });
	});

	it("fails once every attempt has timed out", () => {
		expect(deploy(5, TIMED_OUT)).toMatchObject({ status: 1, runs: 3 });
	});
});
