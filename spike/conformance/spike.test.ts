// The spike conformance suite: what both M0 targets must do, checked only
// through the scenario surface they both serve (M0-CF1's
// spikes/scenario/README.md), so it runs unchanged against Cloudflare and
// self-hosted. Run it with spike/conformance/run.ts.
//
// Every case gives the scripted model a fixed list of tool calls, so the
// result depends only on the platform. Egress uses the same public hosts and
// policy as the shared scenario: postman-echo.com/headers is allowed with an
// injected header, api.github.com is not.

import { describe, expect, test } from "bun:test";
import { execOf, FINAL, SharedSurface, type Step } from "./shared.ts";

const base = process.env.HARBOUR_TARGET_URL ?? "http://127.0.0.1:58081";
const canary = process.env.HARBOUR_CANARY ?? process.env.HARBOUR_CANARY_SECRET ?? "harbour-canary-0000";
const surface = new SharedSurface(base);
const T = 180_000;

const bash = (command: string): Step => ({ tool: "bash", args: { command } });
/** Force the container tier the portable way: the tool escalates any command that runs git. */
const inContainer = (command: string) => `git --version >/dev/null && ${command}`;
const ECHO = "curl -sS -f https://postman-echo.com/headers | jq -r '.headers[\"x-harbour-vault\"]'";

describe(`spike conformance (${base})`, () => {
	test(
		"the tool picks the tier: shell builtins in the isolate, git in a container",
		async () => {
			const { state } = await surface.run([bash("echo hello"), bash("git --version")]);
			expect(state.submission?.status).toBe("done");
			expect(state.answer).toBe(FINAL);
			expect(execOf(state, "echo hello")?.tier).toBe("isolate");
			expect(execOf(state, "git --version")?.tier).toBe("container");
			expect(state.toolResults[0]?.text.trim()).toBe("hello");
			expect(state.toolResults[1]?.text).toContain("git version");
		},
		T,
	);

	test(
		"each tier sees the other's last write, and every writing command makes a new version",
		async () => {
			const commands = [
				"mkdir -p d && echo one > d/f.txt",
				inContainer("cat d/f.txt && echo two >> d/f.txt"),
				"cat d/f.txt && echo three >> d/f.txt",
				inContainer("cat d/f.txt"),
			];
			const { state } = await surface.run(commands.map(bash));
			expect(commands.map((c) => execOf(state, c)?.tier)).toEqual(["isolate", "container", "isolate", "container"]);
			const text = state.toolResults.map((r) => r.text.trim());
			expect(text.slice(1)).toEqual(["one", "one\ntwo", "one\ntwo\nthree"]);
			const execs = commands.map((c) => execOf(state, c)!);
			// Each command starts on the version the previous one left.
			for (let i = 1; i < execs.length; i++) expect(execs[i]!.base).toBe(execs[i - 1]!.version);
			expect(execs.slice(0, 3).every((e) => e.version !== e.base)).toBe(true);
			expect(state.workspace.head).toBe(execs[3]!.version);
		},
		T,
	);

	test(
		"a read-only command, in either tier, does not create a workspace version",
		async () => {
			const commands = ["echo x > a.txt", "cat a.txt", "git --version"];
			const { state } = await surface.run(commands.map(bash));
			const [write, read, git] = commands.map((c) => execOf(state, c)!);
			expect(write!.version).not.toBe(write!.base);
			expect(read!.version).toBe(read!.base);
			expect(git!.tier).toBe("container");
			expect(git!.version).toBe(git!.base);
		},
		T,
	);

	test(
		"the write and read tools see the sandboxes' files, and the sandboxes see theirs",
		async () => {
			const { state } = await surface.run([
				{ tool: "write", args: { path: "/workspace/notes/n.md", content: "from the write tool\n" } },
				bash("cat notes/n.md && echo from-isolate > i.txt"),
				bash(inContainer("cat notes/n.md i.txt > both.txt")),
				{ tool: "read", args: { path: "/workspace/both.txt" } },
			]);
			expect(state.toolResults.map((r) => r.isError)).toEqual([false, false, false, false]);
			expect(state.toolResults[1]?.text).toContain("from the write tool");
			expect(state.toolResults[3]?.text).toContain("from the write tool");
			expect(state.toolResults[3]?.text).toContain("from-isolate");
		},
		T,
	);

	test(
		"isolate egress: the allowed route gets the injected header, redacted on the way back; everything else is refused",
		async () => {
			const commands = [ECHO, "curl -sS -f http://api.github.com/zen", "curl -sS -f https://api.github.com/zen"];
			const { sessionId, state } = await surface.run(commands.map(bash));
			expect(commands.map((c) => execOf(state, c)?.tier)).toEqual(["isolate", "isolate", "isolate"]);
			expect(state.toolResults.map((r) => r.isError)).toEqual([false, true, true]);
			expect(state.toolResults[0]?.text.trim()).toBe("[vault:redacted]");
			const uses = (await surface.vault(sessionId)).filter((u) => u.tier === "isolate");
			expect(uses.some((u) => u.decision === "allowed" && u.injected !== undefined && (u.redactions ?? 0) > 0)).toBe(
				true,
			);
			expect(uses.filter((u) => u.decision === "denied").length).toBeGreaterThanOrEqual(2);
		},
		T,
	);

	test(
		"container egress: HTTPS too goes through the vault and its policy; there is no other route out",
		async () => {
			const commands = [
				inContainer(ECHO),
				inContainer("curl -sS -f --max-time 10 http://api.github.com/zen"),
				inContainer("curl -sS -o /dev/null -w '%{http_code}\\n' --max-time 10 https://api.github.com/zen"),
				// Bypassing the proxy must not work: no route out.
				inContainer("curl -sS -f --max-time 5 --noproxy '*' http://1.1.1.1/"),
			];
			const { sessionId, state } = await surface.run(commands.map(bash));
			expect(commands.map((c) => execOf(state, c)?.tier)).toEqual(["container", "container", "container", "container"]);
			expect(state.toolResults.map((r) => r.isError)).toEqual([false, true, false, true]);
			expect(state.toolResults[0]?.text.trim()).toBe("[vault:redacted]");
			expect(state.toolResults[2]?.text.trim()).toBe("403");
			const uses = (await surface.vault(sessionId)).filter((u) => u.tier === "container");
			expect(uses.some((u) => u.decision === "allowed" && u.injected !== undefined && (u.redactions ?? 0) > 0)).toBe(
				true,
			);
			expect(uses.filter((u) => u.decision === "denied").length).toBeGreaterThanOrEqual(2);
		},
		T,
	);

	test(
		"a sandbox cannot reach another session's sandbox directly",
		async () => {
			// A serves on a port for a while; B, at the same time, probes every
			// address on its own /24 for that port. On a shared sandbox network B
			// would find A; with per-sandbox networks it finds no one.
			const serve = inContainer(
				"(python3 -m http.server 8765 --bind 0.0.0.0 >/dev/null 2>&1 &) ; sleep 20; echo served",
			);
			const probe = inContainer(
				`sleep 4; python3 -c "${[
					"import socket, concurrent.futures as f",
					"me = socket.gethostbyname(socket.gethostname()); net = me.rsplit('.', 1)[0]",
					"def hit(h):",
					"    s = socket.socket(); s.settimeout(0.5)",
					"    try: return h if s.connect_ex((h, 8765)) == 0 else None",
					"    finally: s.close()",
					"hosts = [net + '.' + str(i) for i in range(1, 255) if net + '.' + str(i) != me]",
					"found = [h for h in f.ThreadPoolExecutor(64).map(hit, hosts) if h]",
					"print('peers:', ','.join(found) or 'none')",
				].join("\n")}"`,
			);
			const [a, b] = await Promise.all([surface.run([bash(serve)]), surface.run([bash(probe)])]);
			expect(a.state.toolResults[0]?.text).toContain("served");
			expect(execOf(b.state, probe)?.tier).toBe("container");
			expect(b.state.toolResults[0]?.text.trim()).toBe("peers: none");
		},
		T,
	);

	test(
		"a malformed CONNECT is refused without taking the vault down",
		async () => {
			// Only where egress is an HTTP proxy (self-hosted); elsewhere it reports "no proxy".
			const connect = inContainer(
				`python3 -c "${[
					"import base64, os, socket, urllib.parse as u",
					"p = os.environ.get('HTTPS_PROXY')",
					"if not p: print('no proxy'); raise SystemExit",
					"p = u.urlsplit(p); auth = base64.b64encode(f'{p.username}:{p.password}'.encode()).decode()",
					"s = socket.create_connection((p.hostname, p.port), 10)",
					"s.sendall(f'CONNECT postman-echo.com:99999 HTTP/1.1\\\\r\\\\nProxy-Authorization: Basic {auth}\\\\r\\\\n\\\\r\\\\n'.encode())",
					"print(s.recv(200).decode().splitlines()[0])",
				].join("\n")}"`,
			);
			const commands = [connect, inContainer(ECHO)];
			const { state } = await surface.run(commands.map(bash));
			const status = state.toolResults[0]?.text.trim() ?? "";
			expect(status === "no proxy" || /^HTTP\/1\.1 4\d\d/.test(status)).toBe(true);
			expect(state.toolResults[1]?.isError).toBe(false);
			expect(state.toolResults[1]?.text.trim()).toBe("[vault:redacted]");
		},
		T,
	);

	test(
		"the canary secret reaches neither sandbox nor the transcript",
		async () => {
			const { state } = await surface.run([
				bash(`${ECHO}; env`),
				bash(inContainer(`${ECHO}; env; cat /proc/self/environ | tr '\\0' '\\n'`)),
			]);
			expect(state.toolResults.length).toBe(2);
			expect(JSON.stringify(state)).not.toContain(canary);
		},
		T,
	);

	test(
		"a failing command is an error result in either tier, and the run carries on",
		async () => {
			const { state } = await surface.run([bash("exit 3"), bash(inContainer("exit 4")), bash("echo after")]);
			expect(state.toolResults.map((r) => r.isError)).toEqual([true, true, false]);
			expect(execOf(state, "exit 3")?.exitCode).toBe(3);
			expect(execOf(state, inContainer("exit 4"))?.exitCode).toBe(4);
			expect(state.answer).toBe(FINAL);
		},
		T,
	);

	test(
		"resubmitting with the same request ID does not run the input twice",
		async () => {
			const sessionId = `conformance-${crypto.randomUUID().slice(0, 12)}`;
			await surface.call("POST", sessionId, "setup", {
				scenario: {
					name: "idempotency",
					seed: {},
					steps: [bash("echo once >> count.txt && cat count.txt")],
					finalAnswer: FINAL,
				},
			});
			const first = await surface.prompt(sessionId, "same-request");
			const again = await surface.prompt(sessionId, "same-request");
			expect(String(again.submissionId)).toBe(String(first.submissionId));
			const state = await surface.settle(sessionId, first.submissionId);
			expect(state.toolResults.length).toBe(1);
			expect(state.toolResults[0]?.text.trim()).toBe("once");
			expect(state.execs.length).toBe(1);
		},
		T,
	);
});
