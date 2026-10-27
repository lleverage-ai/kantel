#!/usr/bin/env bun
// The spike's scripted research-style task (plan §15), against any target.
//
//   bun spike/scenario/run.ts --base URL [--url PAGE] [--canary VALUE]
//       [--crash --kill-cmd "CMD" --fallback URL] [--json OUT]
//
// Asserts: the page came through the vault (the fixture refuses requests
// without the injected credential); notes/x.md was written; each tier saw the
// other's last write; git ran in the container; the canary is not in the
// transcript. With --crash it kills the session owner mid tool call (by
// running --kill-cmd), keeps polling --fallback, and asserts the session was
// taken over, the cut-off call came back interrupted (not replayed), and the
// task still finished.

import { parseArgs } from "node:util";
import type { SessionState } from "../contracts/index.ts";
import { SpikeClient } from "./client.ts";

const { values: args } = parseArgs({
	options: {
		base: { type: "string", default: "http://127.0.0.1:58081" },
		fallback: { type: "string" },
		url: { type: "string", default: "http://research-site/" },
		canary: { type: "string", default: process.env.HARBOUR_CANARY_SECRET ?? "harbour-canary-0000" },
		crash: { type: "boolean", default: false },
		"kill-cmd": { type: "string" },
		/** Run once the task settles, e.g. to unpause a paused owner. */
		"after-cmd": { type: "string" },
		/** Allowed kill-to-takeover time; defaults to the target's lease TTL. */
		"takeover-budget-ms": { type: "string" },
		json: { type: "string" },
		timeout: { type: "string", default: "180000" },
	},
});

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const client = new SpikeClient(args.base!);
const target = await client.target();
const t0 = performance.now();
const session = await client.create();
const createMs = performance.now() - t0;
await client.prompt(session.sessionId, { kind: "research", url: args.url!, crash: args.crash });
console.log(`target ${target.target}, session ${session.sessionId} on ${session.owner}`);

let killedAt: number | undefined;
let killedOwner: string | undefined;
let killCmdMs: number | undefined;
const onState = async (state: SessionState) => {
	if (!args.crash || killedAt !== undefined) return;
	// Steps 1-4 done means step 5 (the long container call) is running.
	if (state.toolResults.length >= 4) {
		await Bun.sleep(1500);
		killedOwner = state.owner ?? undefined;
		killedAt = Date.now();
		console.log(`killing ${killedOwner} mid tool call: ${args["kill-cmd"]}`);
		const kill = Bun.spawnSync(["sh", "-c", args["kill-cmd"]!], { stdout: "inherit", stderr: "inherit" });
		killCmdMs = Date.now() - killedAt;
		if (kill.exitCode !== 0) throw new Error("kill command failed");
		if (args.fallback) client.base = args.fallback;
	}
};

const settled = await client.settle(session.sessionId, { timeoutMs: Number(args.timeout), onState });
const totalMs = performance.now() - t0;
if (args["after-cmd"]) Bun.spawnSync(["sh", "-c", args["after-cmd"]], { stdout: "inherit", stderr: "inherit" });
const { state, result } = settled;
check("task finished (DONE)", settled.done, settled.done ? undefined : state.answer?.slice(0, 500));

const results = state.toolResults;
const step = (i: number) => results[i];
const crashOffset = args.crash ? 1 : 0;
check("page fetched through the vault (fixture requires the injected header)", step(0)?.isError === false && Number(step(0)?.output) > 0, `${step(0)?.output} bytes`);
check("fetch ran in the isolate tier", step(0)?.tier === "isolate", step(0)?.tier);
check("title extracted in the isolate", (step(1)?.output ?? "").includes("Tides of the Harbour"), step(1)?.output);
check("notes/x.md written", step(2)?.isError === false && (step(2)?.output ?? "").includes("notes/x.md"), step(2)?.output);
check("isolate sees the host write", (step(3)?.output ?? "").includes("# Research notes") && (step(3)?.output ?? "").includes("Tides"), step(3)?.tier);
const git = step(4 + crashOffset);
check("git ran in the container tier", git?.tier === "container" && /^[0-9a-f]{40}$/.test((git?.output ?? "").trim()), `${git?.tier}: ${git?.output?.trim()}`);
const after = step(5 + crashOffset);
check(
	"isolate sees the container's write (.git and git-commits.txt)",
	after?.tier === "isolate" && (after?.output ?? "").includes(".git/HEAD") && (after?.output ?? "").startsWith("1"),
	after?.output?.replace(/\n/g, " | "),
);
check("canary absent from the transcript", !JSON.stringify(state).includes(args.canary!));

let takeoverMs: number | undefined;
let takeoverDetail: Record<string, number | undefined> | undefined;
if (args.crash) {
	const interrupted = step(4);
	check(
		"cut-off call came back as an error, not replayed",
		interrupted?.isError === true && !(interrupted?.output ?? "").includes("finished"),
		interrupted?.output?.slice(0, 200),
	);
	check("session moved to another owner", state.owner !== null && state.owner !== killedOwner, `${killedOwner} -> ${state.owner}, fence ${state.fence}`);
	if (args.fallback) {
		const takeovers = (await (await fetch(`${args.fallback}/v0/takeovers`)).json()) as {
			takeovers: { sessionId: string; resumedAt: number; acquiredAt?: number; previousExpiresAt?: number }[];
		};
		const mine = takeovers.takeovers.find((t) => t.sessionId === session.sessionId);
		if (mine && killedAt) {
			takeoverMs = mine.resumedAt - killedAt;
			// Target-specific detail when the target reports it.
			if (mine.acquiredAt !== undefined) {
				takeoverDetail = {
					killToAcquireMs: mine.acquiredAt - killedAt,
					acquireToResumeMs: mine.resumedAt - mine.acquiredAt,
					...(mine.previousExpiresAt === undefined ? {} : { acquireMinusOldExpiryMs: mine.acquiredAt - mine.previousExpiresAt }),
					killCmdMs,
				};
			}
		}
		const budget = Number(args["takeover-budget-ms"] ?? target.leaseTtlMs ?? Number.NaN);
		check(
			`taken over within ${budget} ms of the kill`,
			takeoverMs !== undefined && (Number.isNaN(budget) || takeoverMs <= budget),
			`${takeoverMs} ms, TTL ${target.leaseTtlMs} ms`,
		);
	}
}

const failed = checks.filter((c) => !c.ok).length;
const summary = {
	target: target.target,
	sessionId: session.sessionId,
	crash: args.crash,
	createMs: Math.round(createMs),
	totalMs: Math.round(totalMs),
	takeoverMs,
	takeoverDetail,
	steps: result?.steps,
	tiers: results.map((r) => r.tier ?? r.name),
	checks,
	passed: failed === 0,
};
if (args.json) await Bun.write(args.json, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${failed === 0 ? "PASS" : "FAIL"}: ${checks.length - failed}/${checks.length} checks, ${Math.round(totalMs)} ms`);
process.exit(failed === 0 ? 0 : 1);
