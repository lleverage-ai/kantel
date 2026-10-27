// The spike conformance suite: what both targets must do, checked only
// through the spike HTTP API (spike/contracts), so it runs unchanged against
// Cloudflare and self-hosted. Run it with spike/conformance/run.ts.
//
// Every case drives the scripted model with an `exec` spec: a fixed list of
// tool calls, so the result depends only on the platform.

import { describe, expect, test } from "bun:test";
import type { ExecSpec } from "../contracts/index.ts";
import { SpikeClient } from "../scenario/client.ts";

const base = process.env.HARBOUR_TARGET_URL ?? "http://127.0.0.1:58081";
const canary = process.env.HARBOUR_CANARY_SECRET ?? "harbour-canary-0000";
const research = process.env.HARBOUR_RESEARCH_URL ?? "http://research-site/";
const client = new SpikeClient(base);
const T = 120_000;

async function run(steps: ExecSpec["steps"], keepGoing = true) {
	const session = await client.create();
	await client.prompt(session.sessionId, { kind: "exec", steps, keepGoing });
	const settled = await client.settle(session.sessionId, { timeoutMs: T });
	expect(settled.done).toBe(true);
	return { session, ...settled, results: settled.state.toolResults };
}

const bash = (command: string) => ({ tool: "bash" as const, args: { command } });

describe(`spike conformance (${base})`, () => {
	test(
		"the tool picks the tier: shell builtins in the isolate, git in a container",
		async () => {
			const { results } = await run([bash("echo hello"), bash("git --version")]);
			expect(results[0]?.tier).toBe("isolate");
			expect(results[0]?.output?.trim()).toBe("hello");
			expect(results[1]?.tier).toBe("container");
			expect(results[1]?.output).toContain("git version");
		},
		T,
	);

	test(
		"each tier sees the other's last write, and every command commits",
		async () => {
			const { results, state } = await run([
				bash("mkdir -p d && echo one > d/f.txt"),
				bash("git --version >/dev/null && cat d/f.txt && echo two >> d/f.txt"),
				bash("cat d/f.txt && echo three >> d/f.txt"),
				bash("git --version >/dev/null && cat d/f.txt"),
			]);
			expect(results.map((r) => r.tier)).toEqual(["isolate", "container", "isolate", "container"]);
			expect(results[1]?.output?.trim()).toBe("one");
			expect(results[2]?.output?.trim()).toBe("one\ntwo");
			expect(results[3]?.output?.trim()).toBe("one\ntwo\nthree");
			// Three writing commands, three versions.
			expect(state.workspace.seq).toBe(3);
		},
		T,
	);

	test(
		"a read-only command does not create a workspace version",
		async () => {
			const { state } = await run([bash("echo x > a.txt"), bash("cat a.txt"), bash("git --version")]);
			expect(state.workspace.seq).toBe(1);
		},
		T,
	);

	test(
		"isolate egress: allowed route gets the injected credential, everything else is refused",
		async () => {
			const { results } = await run([
				bash(`curl -sS -f ${research} | grep -c 'Tides of the Harbour'`),
				bash("curl -sS -f http://api.github.com/zen"),
				bash("curl -sS -f https://api.github.com/zen"),
			]);
			expect(results[0]?.isError).toBe(false);
			expect(results[0]?.output?.trim()).toBe("1");
			expect(results[1]?.isError).toBe(true);
			expect(results[2]?.isError).toBe(true);
		},
		T,
	);

	test(
		"container egress: allowed route gets the injected credential, everything else is refused",
		async () => {
			const { results } = await run([
				bash(`git --version >/dev/null && curl -sS -f ${research} | grep -c 'Tides of the Harbour'`),
				bash("git --version >/dev/null && curl -sS -f --max-time 10 http://api.github.com/zen"),
				bash("git --version >/dev/null && curl -sS -f --max-time 10 https://api.github.com/zen"),
				// Bypassing the proxy must not work either: no route out.
				bash("git --version >/dev/null && curl -sS -f --max-time 5 --noproxy '*' http://1.1.1.1/"),
			]);
			expect(results.map((r) => r.tier)).toEqual(["container", "container", "container", "container"]);
			expect(results[0]?.isError).toBe(false);
			expect(results[0]?.output?.trim()).toBe("1");
			expect(results[1]?.isError).toBe(true);
			expect(results[2]?.isError).toBe(true);
			expect(results[3]?.isError).toBe(true);
		},
		T,
	);

	test(
		"the canary secret is in neither sandbox nor the transcript",
		async () => {
			const { results, state } = await run([
				bash(`curl -sS -f ${research} > page.html; env; cat page.html`),
				bash(`git --version >/dev/null && curl -sS -f -o page2.html ${research}; env; cat page2.html`),
				bash("cat page.html page2.html | wc -c"),
			]);
			expect(Number(results[2]?.output?.trim())).toBeGreaterThan(100);
			expect(JSON.stringify(state)).not.toContain(canary);
			for (const result of results) expect(result.output ?? "").not.toContain(canary);
		},
		T,
	);

	test(
		"a failing command is an error result, and its exit status reaches the model",
		async () => {
			const { results, result } = await run([bash("exit 3"), bash("git --version >/dev/null && exit 4")]);
			expect(results[0]?.isError).toBe(true);
			expect(results[1]?.isError).toBe(true);
			expect(result?.errors).toEqual([true, true]);
		},
		T,
	);

	test(
		"resubmitting with the same request ID does not run the input twice",
		async () => {
			const session = await client.create();
			const spec: ExecSpec = { kind: "exec", steps: [bash("echo once >> count.txt && cat count.txt")] };
			const first = await client.prompt(session.sessionId, spec, "same-request");
			const again = await client.prompt(session.sessionId, spec, "same-request");
			expect(again.submissionId).toBe(first.submissionId);
			const { state } = await client.settle(session.sessionId, { timeoutMs: T });
			expect(state.toolResults.length).toBe(1);
			expect(state.toolResults[0]?.output?.trim()).toBe("once");
		},
		T,
	);
});
