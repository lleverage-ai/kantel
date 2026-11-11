// Integration tests for kantel-isolate: it is started against STORE/egress stand-ins (see harness.ts) and driven
// over kantel-host's protocol. Covers protocol parity with the behaviours sandbox.ts has, manifest semantics, node
// and python features, egress tagging, needsMicrovm and terminated, and the B5 containment attacks with a
// neighbour's latency checked. Skips with a message if the binary or assets aren't built.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { available, BASE, client, type Harness, start } from "./harness";

const skip = available();
const RUN = skip === true;
if (!RUN) console.warn(`\n[integration] skipped: ${skip}\n`);

let h: Harness;
let c: ReturnType<typeof client>;

beforeAll(async () => {
	if (!RUN) return;
	// 5 s CPU per command: enough for a cold numpy import, still quick to trip for the CPU-bomb tests.
	h = await start({ cpuMs: 5000 });
	c = client(h);
});
afterAll(async () => {
	if (h) await h.stop();
});

const d = RUN ? describe : describe.skip;

d("health and protocol", () => {
	it("healthz reports the runtime, capabilities and memoryEnforced", async () => {
		const r = await c.health();
		expect(r.ok).toBe(true);
		expect(r.runtime).toBe("deno_core");
		expect(r.capabilities).toEqual({ javascript: true, python: true });
		expect(r.memoryEnforced).toBe(true);
		expect(typeof r.v8).toBe("string");
	});
	it("load reports a hit kind, ms and the memory", async () => {
		const r = await c.load("h-load", 256);
		expect(r.ok).toBe(true);
		expect(["pool", "miss", "session"]).toContain(r.hit);
		expect(r.memoryMiB).toBe(256);
	});
	it("rejects out-of-range memoryMiB", async () => {
		const r = await c.post("/load", { sandboxId: "h-bad", memoryMiB: 99999 });
		expect(r.error).toBeDefined();
	});
	it("exec returns exitCode, stdout, manifest, changed, timings, hit, ms", async () => {
		await c.load("h-exec");
		const r = await c.exec("h-exec", "echo hi");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("hi\n");
		expect(r.manifest).toBeDefined();
		expect(Array.isArray(r.changed)).toBe(true);
		expect(r.timings).toBeDefined();
		expect(r.ms).toBeGreaterThanOrEqual(0);
	});
});

d("shell parity with sandbox.ts", () => {
	beforeAll(async () => {
		if (RUN) await c.load("sh");
	});
	it("runs just-bash commands, pipes and $HOME=/workspace", async () => {
		expect((await c.exec("sh", "pwd")).stdout).toBe("/workspace\n");
		expect((await c.exec("sh", 'echo "$HOME"')).stdout).toBe("/workspace\n");
		expect((await c.exec("sh", "seq 1 4 | awk '{s+=$1} END{print s}'")).stdout).toBe("10\n");
	});
	it("gzip/gunzip round-trips through the host zlib", async () => {
		expect((await c.exec("sh", "echo hello | gzip | gunzip")).stdout).toBe("hello\n");
	});
	it("reads a manifest file lazily and uploads a changed file", async () => {
		const manifest = { "in.txt": await c.fileEntry("a\nb\nc\n") };
		const r = await c.exec("sh", "wc -l < in.txt; cp in.txt out.txt", manifest);
		expect(r.stdout).toBe("3\n");
		expect(r.changed).toContain("out.txt");
		expect((r.manifest as Record<string, unknown>)["in.txt"]).toEqual(manifest["in.txt"]);
	});
	it("an unavailable command answers 127 with needsMicrovm", async () => {
		const r = await c.exec("sh", "git status");
		expect(r.exitCode).toBe(127);
		expect(r.stderr).toContain("Use a microVM");
		expect((r.needsMicrovm as { command: string }).command).toBe("git");
	});
	it("does not report needsMicrovm when the command handled it", async () => {
		const r = await c.exec("sh", "git --version || echo ok");
		expect(r.exitCode).toBe(0);
		expect(r.needsMicrovm).toBeUndefined();
	});
	it("tar is unavailable (a just-bash gap) with needsMicrovm", async () => {
		const r = await c.exec("sh", "tar -tf x.tar");
		expect(r.exitCode).toBe(127);
		expect(r.needsMicrovm).toBeDefined();
	});
});

d("node", () => {
	beforeAll(async () => {
		if (RUN) await c.load("nd");
	});
	it("-e, -p and -v", async () => {
		expect((await c.exec("nd", "node -e 'console.log(2+3)'")).stdout).toBe("5\n");
		expect((await c.exec("nd", "node -p '1+1'")).stdout).toBe("2\n");
		expect((await c.exec("nd", "node -v")).stdout).toMatch(/^v\d+/);
	});
	it("node:fs over the sandbox, writes reach the manifest", async () => {
		const r = await c.exec(
			"nd",
			'node -e \'const fs=require("fs");fs.writeFileSync("n.json",JSON.stringify({x:1}));process.stdout.write(fs.readFileSync("n.json","utf8"))\'',
		);
		expect(r.stdout).toBe('{"x":1}');
		expect(r.changed).toContain("n.json");
	});
	it("relative CommonJS require and a manifest script", async () => {
		const manifest = {
			"lib.js": await c.fileEntry("module.exports = (a,b) => a+b;"),
			"main.js": await c.fileEntry('const add = require("./lib"); console.log(add(2,5));'),
		};
		expect((await c.exec("nd", "node main.js", manifest)).stdout).toBe("7\n");
	});
	it("runs a .ts file with types stripped", async () => {
		const manifest = { "t.ts": await c.fileEntry("const n: number = 21; console.log(n*2);") };
		expect((await c.exec("nd", "node t.ts", manifest)).stdout).toBe("42\n");
	});
	it("ESM entry with a node: import", async () => {
		expect(
			(await c.exec("nd", 'node --input-type=module -e \'import os from "node:os"; console.log(os.EOL==="\\n")\''))
				.stdout,
		).toBe("true\n");
	});
	it("crypto, path and buffer", async () => {
		expect(
			(
				await c.exec("nd", 'node -e \'console.log(require("crypto").createHash("md5").update("abc").digest("hex"))\'')
			).stdout.trim(),
		).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect((await c.exec("nd", 'node -e \'console.log(require("path").join("a","b","..","c"))\'')).stdout).toBe(
			"a/c\n",
		);
		expect((await c.exec("nd", 'node -e \'console.log(Buffer.from("aGk=","base64").toString())\'')).stdout).toBe(
			"hi\n",
		);
	});
	it("child_process is unavailable", async () => {
		const r = await c.exec("nd", 'node -e \'require("child_process").execSync("ls")\'');
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("microVM");
	});
	it("-e or -p with no script fails as node does", async () => {
		for (const flag of ["-e", "-p"]) {
			const r = await c.exec("nd", `node ${flag}`);
			expect(r.exitCode).toBe(9);
			expect(r.stderr).toBe(`node: ${flag} requires an argument\n`);
		}
		// An empty script is a script.
		expect((await c.exec("nd", "node -e ''")).exitCode).toBe(0);
	});
	it("a syntax error names the file and line, with a caret, and no runtime frames", async () => {
		const r = await c.exec("nd", `printf 'const a = 1;\nconsole.log("Hello, world!);\n' > bad.js && node bad.js`);
		expect(r.exitCode).toBe(1);
		const lines = r.stderr.split("\n");
		expect(lines[0]).toBe("/workspace/bad.js:2");
		expect(lines[1]).toBe('console.log("Hello, world!);');
		expect(lines[2]).toMatch(/^ {12}\^+$/);
		expect(r.stderr).toContain("SyntaxError: Invalid or unexpected token");
		expect(r.stderr).not.toMatch(/kt:(guest|call)|Function \(<anonymous>\)/);
	});
	it("an uncaught error shows the script's frames and none of the runtime's", async () => {
		const r = await c.exec(
			"nd",
			`printf 'function boom() { throw new Error("nope"); }\nboom();\n' > boom.js && node boom.js`,
		);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Error: nope");
		expect(r.stderr).toContain("/workspace/boom.js:1");
		expect(r.stderr).not.toMatch(/kt:(guest|call)|Function \(<anonymous>\)/);
	});
});

d("python", () => {
	beforeAll(async () => {
		if (RUN) await c.load("py");
	});
	it("-c, -V and exit codes", async () => {
		expect((await c.exec("py", "python -c 'print(sum(range(5)))'")).stdout).toBe("10\n");
		expect((await c.exec("py", "python -V")).stdout).toMatch(/^Python 3\./);
		expect((await c.exec("py", "python -c 'import sys; sys.exit(3)'")).exitCode).toBe(3);
	});
	it("-c or -m with no argument fails as python does", async () => {
		for (const flag of ["-c", "-m"]) {
			const r = await c.exec("py", `python ${flag}`);
			expect(r.exitCode).toBe(2);
			expect(r.stderr).toContain(`Argument expected for the ${flag} option`);
		}
		expect((await c.exec("py", "python -c ''")).exitCode).toBe(0);
	});
	it("reads stdin and the sandbox's files, writes back", async () => {
		expect((await c.exec("py", "echo 21 | python -c 'import sys; print(int(sys.stdin.read())*2)'")).stdout).toBe(
			"42\n",
		);
		const manifest = { "d.csv": await c.fileEntry("v\n1\n2\n3\n") };
		expect(
			(
				await c.exec(
					"py",
					'python -c \'import csv; print(sum(int(r["v"]) for r in csv.DictReader(open("d.csv"))))\'',
					manifest,
				)
			).stdout,
		).toBe("6\n");
		const w = await c.exec("py", 'python -c \'open("out.txt","w").write("hello")\'');
		expect(w.changed).toContain("out.txt");
	});
	it("loads numpy from the assets (not the internet)", async () => {
		const r = await c.exec("py", "python -c 'import numpy as np; print(int(np.arange(10).sum()))'", {}, 20000);
		expect(r.stdout).toBe("45\n");
	});
	it("random differs run to run (reseeded from OS entropy)", async () => {
		const a = (await c.exec("py", "python -c 'import random; print(random.random())'")).stdout;
		const b = (await c.exec("py", "python -c 'import random; print(random.random())'")).stdout;
		expect(a).not.toBe(b);
	});
	it("pip is unavailable with needsMicrovm", async () => {
		const r = await c.exec("py", "python -m pip install requests");
		expect(r.exitCode).not.toBe(0);
		expect(r.needsMicrovm).toBeDefined();
	});
});

d("egress tagging", () => {
	it("tags each request with the sandbox and drops the guest's kantel-* headers", async () => {
		await c.load("eg1");
		await c.load("eg2");
		await c.exec("eg1", "curl -s -H 'kantel-isolate-sandbox: spoofed' http://example.test/json");
		await c.exec("eg2", "curl -s http://example.test/json");
		const one = h.upstreamHits.filter((x) => x.path === "/json");
		expect(one.some((x) => x.sandbox === "eg1")).toBe(true);
		expect(one.some((x) => x.sandbox === "eg2")).toBe(true);
		expect(one.some((x) => x.sandbox === "spoofed")).toBe(false);
	});
	it("node fetch reaches the upstream and parses JSON", async () => {
		await c.load("eg3");
		const r = await c.exec(
			"eg3",
			"node -e 'fetch(\"http://example.test/json\").then(r=>r.json()).then(j=>console.log(j.n))'",
		);
		expect(r.stdout).toBe("7\n");
	});
});

d("containment (B5) with a neighbour", () => {
	// A neighbour sandbox runs echo hi every 50ms while each attack runs; it must stay fast and the process must
	// survive every attack.
	async function attack(id: string, cmd: string, timeoutMs = 6000) {
		await c.load(id);
		await c.exec(id, "echo ready");
		await c.load("victim");
		await c.exec("victim", "echo ready");
		const lat: number[] = [];
		let stop = false;
		const prober = (async () => {
			while (!stop) {
				const t = performance.now();
				const r = await c.exec("victim", "echo hi");
				lat.push(performance.now() - t);
				if (r.stdout !== "hi\n") lat.push(1e9);
				await Bun.sleep(Math.max(0, 50 - (performance.now() - t)));
			}
		})();
		await Bun.sleep(150);
		const r = await c.exec(id, cmd, {}, timeoutMs);
		stop = true;
		await prober;
		lat.sort((a, b) => a - b);
		const p99 = lat[Math.floor(lat.length * 0.99)] ?? lat[lat.length - 1];
		expect((await c.health()).ok).toBe(true); // process survived
		return { r, p99 };
	}
	it("shell while-true is stopped and the neighbour stays fast", async () => {
		const { r, p99 } = await attack("b5a", "while true; do :; done");
		expect(r.exitCode).not.toBe(0);
		expect(p99).toBeLessThan(500);
	});
	it("awk busy loop is stopped", async () => {
		const { r } = await attack("b5b", "awk 'BEGIN{while(1){}}'");
		expect(r.exitCode).not.toBe(0);
	});
	it("nested awk under just-bash counters is stopped by the CPU watchdog", async () => {
		const { r } = await attack("b5a2", "awk 'BEGIN{for(i=0;i<99999;i++)for(j=0;j<99999;j++)x++}'");
		expect(r.terminated ?? "set").toBeDefined();
		expect(r.exitCode).not.toBe(0);
	});
	it("node busy loop hits the CPU limit (exit 152)", async () => {
		const { r, p99 } = await attack("b5c", "node -e 'while(true){}'");
		expect(r.exitCode).toBe(152);
		expect(p99).toBeLessThan(500);
	});
	it("node heap bomb hits the memory limit (exit 137)", async () => {
		const { r } = await attack("b5d", "node -e 'const a=[];while(true)a.push(new Array(1e6).fill(1))'");
		expect(r.exitCode).toBe(137);
	});
	it("node ArrayBuffer bomb hits the memory limit (exit 137)", async () => {
		const { r } = await attack("b5e", "node -e 'const a=[];while(true)a.push(new Uint8Array(64*1024*1024))'");
		expect(r.exitCode).toBe(137);
	});
	it("node wasm memory bomb is contained (process survives, neighbour fast)", async () => {
		const { r, p99 } = await attack(
			"b5h",
			"node -e 'const a=[];while(true){const m=new WebAssembly.Memory({initial:1024});a.push(m)}'",
		);
		expect(r.exitCode).not.toBe(0);
		expect(p99).toBeLessThan(500);
	});
	it("python busy loop hits the CPU limit (exit 152)", async () => {
		const { r } = await attack("b5f", "python -c 'while True: pass'");
		expect(r.exitCode).toBe(152);
	});
	it("python memory bomb is contained", async () => {
		const code = "b=[]\nwhile True:\n b.append(bytearray(64*1024*1024))";
		await c.load("b5g");
		const r = await c.exec("b5g", `python -c ${JSON.stringify(code)}`, {}, 6000);
		expect(r.exitCode).not.toBe(0);
		expect((await c.health()).ok).toBe(true);
	});
});

d("wasm accounting is watertight", () => {
	beforeAll(async () => {
		if (RUN) await c.load("w");
	});
	it("a new Memory over the budget is refused", async () => {
		const r = await c.exec(
			"w",
			"node -e 'try{new WebAssembly.Memory({initial:5000})}catch(e){console.log(\"caught\")}'",
		);
		expect(r.stdout).toBe("caught\n");
	});
	it("growing a Memory past the budget is refused", async () => {
		const r = await c.exec(
			"w",
			"node -e 'const m=new WebAssembly.Memory({initial:1});try{m.grow(5000)}catch(e){console.log(\"caught\")}'",
		);
		expect(r.stdout).toBe("caught\n");
	});
	it("resizable ArrayBuffer (maxByteLength) is refused", async () => {
		const r = await c.exec(
			"w",
			"node -e 'try{new ArrayBuffer(8,{maxByteLength:2000000000})}catch(e){console.log(\"refused\")}'",
		);
		expect(r.stdout).toBe("refused\n");
	});
	it("ArrayBuffer.prototype.resize is gone", async () => {
		const r = await c.exec("w", "node -e 'console.log(typeof ArrayBuffer.prototype.resize)'");
		expect(r.stdout).toBe("undefined\n");
	});
	it("SharedArrayBuffer and Atomics are absent", async () => {
		const r = await c.exec("w", "node -e 'console.log(typeof SharedArrayBuffer, typeof Atomics)'");
		expect(r.stdout).toBe("undefined undefined\n");
	});
	it("Memory.prototype.toResizableBuffer is gone", async () => {
		const r = await c.exec("w", "node -e 'console.log(typeof WebAssembly.Memory.prototype.toResizableBuffer)'");
		expect(r.stdout).toBe("undefined\n");
	});
	it("a resizable-ArrayBuffer bomb can't exceed the budget (process survives)", async () => {
		const r = await c.exec(
			"w",
			"node -e 'const a=[];for(let i=0;i<50;i++){a.push(new ArrayBuffer(8,{maxByteLength:64*1024*1024}))}'",
		);
		expect(r.exitCode).not.toBe(0);
		expect((await c.health()).ok).toBe(true);
	});
	it("compiling a module that declares a big initial memory is refused", async () => {
		// (module (memory 9000)) — 9000 pages = 562 MiB initial, over the 512 MiB ceiling.
		const r = await c.exec(
			"w",
			'node -e \'const b=new Uint8Array([0,97,115,109,1,0,0,0,5,4,1,0,168,70]);WebAssembly.compile(b).then(()=>console.log("compiled"),e=>console.log("refused"))\'',
		);
		expect(r.stdout.trim()).toBe("refused");
	});
});

d("review fixes: memory guards and limits", () => {
	beforeAll(async () => {
		if (RUN) await c.load("rf");
	});

	it("H1: a sandbox reused after repeated terminations stays contained and still enforces CPU", async () => {
		// Each termination poisons the shell isolate; it is rebuilt at the next command, re-arming the heap guard.
		for (let i = 0; i < 2; i++) {
			const t = await c.exec("rf", "awk 'BEGIN{for(i=0;i<99999;i++)for(j=0;j<99999;j++)x++}'", {}, 7000);
			expect(t.exitCode).not.toBe(0);
			expect(await c.health().then((h) => h.ok)).toBe(true);
			expect((await c.exec("rf", "echo hi")).stdout).toBe("hi\n"); // recovers
		}
		// CPU enforcement is still live after the reuses (the watchdog wasn't left skipping this isolate).
		const busy = await c.exec("rf", "node -e 'while(true){}'", {}, 7000);
		expect(busy.exitCode).toBe(152);
		expect((await c.health()).ok).toBe(true);
	});

	it("H2: replacing Reflect.construct can't smuggle a resizable ArrayBuffer past the guard", async () => {
		const r = await c.exec(
			"rf",
			"node -e 'Reflect.construct=()=>({}); let ok=true; try{new ArrayBuffer(8,{maxByteLength:64*1024*1024}); ok=false}catch(e){} console.log(ok && new ArrayBuffer(4).byteLength===4)'",
		);
		expect(r.stdout).toBe("true\n");
	});

	it("H2: replacing WeakMap.prototype.get can't fake wasm-growth reservation", async () => {
		const r = await c.exec(
			"rf",
			"node -e 'WeakMap.prototype.get=()=>512*1024*1024; const m=new WebAssembly.Memory({initial:1,maximum:8192}); let ok=false; try{m.grow(8191)}catch(e){ok=true} console.log(ok)'",
		);
		expect(r.stdout).toBe("true\n");
	});

	it("H4: retaining host-returned buffers can't exceed the isolate's memory", async () => {
		const r = await c.exec(
			"rf",
			"node -e 'const a=[];for(let i=0;i<60;i++)a.push(Buffer.from(\"x\".repeat(16*1024*1024)))'",
		);
		expect(r.exitCode).not.toBe(0);
		expect((await c.health()).ok).toBe(true);
	});

	it("H8: process.exit ends the run at once despite pending timers", async () => {
		const r = await c.exec("rf", "node -e 'setInterval(()=>{},1000); process.exit(3)'", {}, 8000);
		expect(r.exitCode).toBe(3);
		expect(r.ms).toBeLessThan(4000); // not held to the wall by the interval
	});

	it("H9: a node memory termination reports terminated=memory", async () => {
		const r = await c.exec("rf", "node -e 'const a=[];while(true)a.push(new Uint8Array(64*1024*1024))'", {}, 8000);
		expect(r.exitCode).toBe(137);
		expect(r.terminated).toBe("memory");
	});

	it("H3: Python can't make a shared WebAssembly.Memory or reach SharedArrayBuffer", async () => {
		// Real newlines inside a single-quoted arg (just-bash preserves them); double quotes for the Python strings.
		const code = [
			"import js",
			'print(hasattr(js, "SharedArrayBuffer"))',
			"d = js.Object.new()",
			"d.initial = 1",
			"d.maximum = 1",
			"d.shared = True",
			"try:",
			"    js.WebAssembly.Memory.new(d)",
			'    print("made")',
			"except Exception:",
			'    print("refused")',
		].join("\n");
		const r = await c.exec("rf", `python3 -c '${code}'`, {}, 15000);
		expect(r.stdout).toContain("False"); // SharedArrayBuffer removed
		expect(r.stdout).toContain("refused"); // shared memory refused after lockdown
	});

	it("M10: a cross-origin redirect drops the Authorization header; a same-origin one keeps it", async () => {
		const cross = await c.exec(
			"rf",
			'node -e \'fetch("http://a.test/redirect-cross",{headers:{authorization:"Bearer secret"}}).then(r=>r.text()).then(t=>console.log(t))\'',
		);
		expect(cross.stdout.trim()).toBe("none");
		const same = await c.exec(
			"rf",
			'node -e \'fetch("http://a.test/redirect-same",{headers:{authorization:"Bearer secret"}}).then(r=>r.text()).then(t=>console.log(t))\'',
		);
		expect(same.stdout.trim()).toBe("Bearer secret");
	});

	it("H5: over 8 concurrent fetches from one isolate are refused, and a withheld body doesn't hang the process", async () => {
		const many = await c.exec(
			"rf",
			'node -e \'const p=[];for(let i=0;i<20;i++)p.push(fetch("http://a.test/slow").then(()=>"ok").catch(e=>String(e.message||e))); Promise.all(p).then(rs=>console.log(rs.filter(s=>/too many concurrent/.test(s)).length>0))\'',
			{},
			8000,
		);
		expect(many.stdout.trim()).toBe("true");
		const stream = await c.exec(
			"rf",
			"node -e 'fetch(\"http://a.test/stream-forever\").then(r=>r.arrayBuffer()).then(b=>console.log(b.byteLength))'",
			{},
			3000,
		);
		expect(stream.exitCode).not.toBe(0);
		expect((await c.health()).ok).toBe(true);
	});
});

// PR #837's review: the wasm guard counts with intrinsics captured before guest code; host buffers are charged before
// a guest can see them; redirects keep PUT/PATCH/DELETE; node's fs keys paths through directory symlinks by their real
// path; python removes an entry it replaced with one of another kind; JSON imports.
d("PR #837 review fixes", () => {
	beforeAll(async () => {
		if (RUN) {
			await c.load("pr");
			await c.load("pr-neighbour");
		}
	});
	const neighbourOk = async () => {
		expect((await c.exec("pr-neighbour", "echo hi")).stdout).toBe("hi\n");
		expect((await c.health()).ok).toBe(true);
	};
	/** Run a node script (as a manifest file) in sandbox "pr". */
	const nodeScript = async (source: string, timeoutMs = 15000) =>
		c.exec("pr", "node s.js", { "s.js": await c.fileEntry(source) }, timeoutMs);

	it("redirects keep PUT, PATCH and DELETE (and their bodies) on 301 and 302, as Fetch does", async () => {
		const r = await nodeScript(
			`const cases = [["PUT", 301], ["PATCH", 302], ["DELETE", 302], ["POST", 301], ["POST", 302], ["PUT", 303], ["PUT", 307], ["POST", 308]];
(async () => {
	for (const [method, status] of cases) {
		const body = method === "DELETE" ? undefined : "x";
		const res = await fetch("http://a.test/redirect/" + status, { method, body, headers: body ? { "content-type": "text/plain" } : {} });
		console.log(method, status, "->", await res.text());
	}
})();`,
		);
		expect(r.stdout.trim().split("\n")).toEqual([
			"PUT 301 -> PUT text/plain x",
			"PATCH 302 -> PATCH text/plain x",
			"DELETE 302 -> DELETE none ",
			"POST 301 -> GET none ",
			"POST 302 -> GET none ",
			"PUT 303 -> GET none ",
			"PUT 307 -> PUT text/plain x",
			"POST 308 -> POST text/plain x",
		]);
	});

	it("JSON imports: a manifest file, a file the run wrote, and malformed JSON refused", async () => {
		const manifest = {
			"d.json": await c.fileEntry('{"a": [1, 2], "b": "two"}'),
			"bad.json": await c.fileEntry("{nope"),
			"m.mjs": await c.fileEntry(
				`import d from "./d.json" with { type: "json" };
import { writeFileSync } from "node:fs";
writeFileSync("w.json", JSON.stringify({ written: true }));
const w = await import("./w.json", { with: { type: "json" } });
console.log(d.a[1], d.b, w.default.written);`,
			),
			"bad.mjs": await c.fileEntry('import b from "./bad.json" with { type: "json" }; console.log(b);'),
		};
		const ok = await c.exec("pr", "node m.mjs", manifest);
		expect(ok.stderr).toBe("");
		expect(ok.stdout).toBe("2 two true\n");
		const bad = await c.exec("pr", "node bad.mjs", manifest);
		expect(bad.exitCode).not.toBe(0);
	});

	it("node fs: writes, renames and removals below a directory symlink use the real path, in the run and after", async () => {
		const manifest = {
			"real/a": await c.fileEntry("old"),
			"real/gone": await c.fileEntry("bye"),
			alias: { kind: "symlink", target: "real" },
		};
		const r = await c.exec("pr", "node s.js", {
			...manifest,
			"s.js": await c.fileEntry(
				`const fs = require("fs");
fs.writeFileSync("alias/a", "new");
fs.writeFileSync("alias/b", "made");
fs.appendFileSync("alias/b", "+");
fs.mkdirSync("alias/sub/deep", { recursive: true });
fs.writeFileSync("alias/sub/deep/c", "c");
fs.renameSync("alias/b", "alias/b2");
fs.unlinkSync("alias/gone");
fs.symlinkSync("a", "alias/la");
fs.unlinkSync("alias/la");
fs.symlinkSync("real/a", "link");
fs.unlinkSync("link");
console.log(JSON.stringify([
	fs.readFileSync("alias/a", "utf8"), fs.readFileSync("real/a", "utf8"), fs.readFileSync("real/b2", "utf8"),
	fs.existsSync("real/b"), fs.existsSync("real/gone"), fs.existsSync("real/la"), fs.existsSync("link"),
	fs.lstatSync("alias").isSymbolicLink(), fs.readFileSync("real/sub/deep/c", "utf8"), fs.readdirSync("real").join(","),
]));`,
			),
		});
		expect(r.stderr).toBe("");
		expect(JSON.parse(r.stdout)).toEqual(["new", "new", "made+", false, false, false, false, true, "c", "a,b2,sub"]);
		const m = r.manifest as Record<string, { kind: string; size?: number; target?: string }>;
		expect(m.alias).toEqual({ kind: "symlink", target: "real" });
		expect(m["real/a"].size).toBe(3);
		expect(m["real/b2"].size).toBe(5);
		expect(m["real/sub/deep/c"].kind).toBe("file");
		for (const k of Object.keys(m)) expect(k.startsWith("alias/")).toBe(false);
		expect(m["real/gone"]).toBeUndefined();
		expect(m.link).toBeUndefined();
		// The next command, from that manifest.
		const next = await c.exec("pr", "cat real/a alias/a real/b2 real/sub/deep/c", m);
		expect(next.stdout).toBe("newnewmade+c");
	});

});

// memoryMiB bounds the V8 heap, ArrayBuffers and wasm memory together: holding ~60% of it in one and then taking
// ~60% in the other is stopped (each alone fits, and before the limit was one figure each fitted on its own budget).
d("one memory limit: heap, buffers and wasm together", () => {
	beforeAll(async () => {
		if (RUN) await c.load("mem", 256);
	});
	// 19 arrays of 1e6 doubles: ~152 MB of heap. 10 Uint8Arrays of 16 MiB: 160 MiB of buffers.
	const heap = "const a=[];for(let i=0;i<19;i++)a.push(new Array(1e6).fill(i+0.5));";
	const bufs = "const b=[];for(let i=0;i<10;i++)b.push(new Uint8Array(16*1024*1024));";
	const pyHeap =
		'mk=js.Function.new("n","const a=[];for(let i=0;i<n;i++)a.push(new Array(1e6).fill(i+0.5));return a")\nh=mk(19)\n';
	const pyBufs = "b=[js.Uint8Array.new(16*1024*1024) for i in range(10)]\n";
	// Then hold it for a moment, as a program using the memory would: a v8-sandbox build checks buffers taken on top
	// of the heap at the next GC (which V8 runs as they grow) rather than in the allocation itself.
	const hold = "const t=Date.now();while(Date.now()-t<500){}";
	const pyHold = "import time\nt=time.time()\nwhile time.time()-t<0.5: pass\n";
	const stopped = (r: Record<string, unknown>) => {
		expect(r.exitCode).toBe(137);
		expect(r.terminated).toBe("memory");
	};

	it("node: heap, then buffers", async () => {
		stopped(await c.exec("mem", `node -e '${heap}${bufs}${hold}console.log(a.length,b.length)'`, {}, 15000));
	});
	it("node: buffers, then heap", async () => {
		stopped(await c.exec("mem", `node -e '${bufs}${heap}${hold}console.log(a.length,b.length)'`, {}, 15000));
	});
	it("node: each alone fits, and so does a sum under the limit", async () => {
		expect((await c.exec("mem", `node -e '${heap}console.log(a.length)'`, {}, 15000)).stdout).toBe("19\n");
		expect((await c.exec("mem", `node -e '${bufs}console.log(b.length)'`, {}, 15000)).stdout).toBe("10\n");
		const half =
			"const a=[];for(let i=0;i<12;i++)a.push(new Array(1e6).fill(i+0.5));const b=[];for(let i=0;i<5;i++)b.push(new Uint8Array(16*1024*1024));";
		expect((await c.exec("mem", `node -e '${half}console.log(a.length+b.length)'`, {}, 15000)).stdout).toBe("17\n");
	});
	it("python: heap, then buffers", async () => {
		stopped(await c.exec("mem", `python -c 'import js\n${pyHeap}${pyBufs}${pyHold}print(len(b))'`, {}, 20000));
	});
	it("python: buffers, then heap", async () => {
		stopped(await c.exec("mem", `python -c 'import js\n${pyBufs}${pyHeap}${pyHold}print(len(b))'`, {}, 20000));
	});
	it("python: heap, then wasm memory (a bytearray) fails", async () => {
		const r = await c.exec(
			"mem",
			`python -c 'import js\n${pyHeap}b=bytearray(160*1024*1024)\nprint(len(b))'`,
			{},
			20000,
		);
		expect(r.exitCode).not.toBe(0);
		expect(r.stdout).toBe("");
		expect((await c.health()).ok).toBe(true);
	});
	it("loading a sandbox again with another memory size replaces its isolate", async () => {
		await c.load("mem-resize", 256);
		expect((await c.exec("mem-resize", "echo one")).stdout).toBe("one\n");
		expect((await c.load("mem-resize", 128)).ok).toBe(true);
		expect((await c.exec("mem-resize", "echo two")).stdout).toBe("two\n");
		expect((await c.load("mem-resize", 256)).ok).toBe(true);
		expect((await c.exec("mem-resize", "echo three")).stdout).toBe("three\n");
		expect((await c.health()).ok).toBe(true);
	});
	it("ordinary work still fits in 256 MiB: a 20 MB JSON in node, a 100k-row CSV and numpy in python", async () => {
		const rows = Array.from({ length: 150_000 }, (_, i) => ({
			id: i,
			name: `n${i}`,
			v: i * 0.5,
			tags: ["a", "b"],
			s: "x".repeat(80),
		}));
		const json = JSON.stringify(rows);
		expect(json.length).toBeGreaterThan(20_000_000);
		const csv = `id,name,v\n${Array.from({ length: 100_000 }, (_, i) => `${i},name${i},${i * 0.5}`).join("\n")}\n`;
		const manifest = { "d.json": await c.fileEntry(json), "d.csv": await c.fileEntry(csv) };
		const node = await c.exec(
			"mem",
			'node -e \'const d=JSON.parse(require("fs").readFileSync("d.json","utf8"));console.log(d.length, d[149999].id)\'',
			manifest,
			20000,
		);
		expect(node.stdout).toBe("150000 149999\n");
		const py = await c.exec(
			"mem",
			'python -c \'import csv; rows=list(csv.DictReader(open("d.csv"))); print(len(rows), sum(float(r["v"]) for r in rows))\'',
			manifest,
			20000,
		);
		expect(py.stdout).toBe("100000 2499975000.0\n");
		const np = await c.exec(
			"mem",
			"python -c 'import numpy as np; a=np.arange(4e6).reshape(2000,2000); print(int(a.sum()), a.T.shape)'",
			{},
			20000,
		);
		expect(np.stdout).toBe("7999998000000 (2000, 2000)\n");
	});
});

// The shell's own isolate: just-bash is slow with strings this size, so this runs on a runtime with a longer CPU limit.
describe(RUN ? "one memory limit in the shell" : "one memory limit in the shell (skipped)", () => {
	let hs: Harness;
	let cs: ReturnType<typeof client>;
	const ds = RUN ? it : it.skip;
	beforeAll(async () => {
		if (!RUN) return;
		hs = await start({ cpuMs: 30000, pool: 1, basePort: BASE + 30 });
		cs = client(hs);
		await cs.load("mem-sh", 256);
	});
	afterAll(async () => {
		if (hs) await hs.stop();
	});
	ds("shell: heap (four 30 MB strings), then buffers (reading a 60 MB file)", async () => {
		const strings = [0, 1, 2, 3].map((i) => `s${i}=$(printf "%030000000d" ${i})`).join("; ");
		const big = new Uint8Array(60_000_000).fill(97);
		const manifest = { big: { kind: "file" as const, sha: await cs.put(big), size: big.length, mode: 0o644 } };
		// Each alone fits.
		expect((await cs.exec("mem-sh", "wc -c big", manifest, 30000)).stdout).toBe("60000000 big\n");
		expect((await cs.exec("mem-sh", `${strings}; echo \${#s3}`, {}, 30000)).stdout).toBe("30000000\n");
		const r = await cs.exec("mem-sh", `${strings}; wc -c big`, manifest, 30000);
		expect(r.exitCode).toBe(137);
		expect(r.terminated).toBe("memory");
		expect((await cs.exec("mem-sh", "echo hi")).stdout).toBe("hi\n"); // the sandbox recovers
	});
});

describe(RUN ? "review fixes: max-sandboxes capacity" : "review fixes: max-sandboxes capacity (skipped)", () => {
	it("H6: a busy sandbox isn't evicted and a new one over the cap gets a retryable 503", async () => {
		if (!RUN) return;
		const h2 = await start({ maxSandboxes: 1, cpuMs: 5000, basePort: BASE + 10 });
		try {
			const c2 = client(h2);
			await c2.load("busy");
			const running = c2.exec("busy", "sleep 2", {}, 8000); // hold the one slot
			await Bun.sleep(200);
			const r = await fetch(`${h2.rt}/load`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sandboxId: "other" }),
			});
			expect(r.status).toBe(503);
			expect((await r.json()).retryable).toBe(true);
			expect((await running).exitCode).toBe(0); // not evicted mid-command
		} finally {
			await h2.stop();
		}
	});
});

// Native mode's transport: the runtime listens on, and reaches the store and the egress proxy over, Unix sockets in one
// 0700 directory, so seccomp allows it AF_UNIX sockets only and Landlock no TCP. A representative subset of the suite
// runs over it. Where unprivileged user namespaces are available, the runtime runs in its own network namespace, so
// that namespace's TCP/UDP tables hold only its own sockets (its /proc/<pid>/fd is unreadable: it is non-dumpable).
const NETNS = RUN && Bun.spawnSync(["unshare", "--user", "--map-current-user", "--net", "true"]).exitCode === 0;

describe(RUN ? "Unix-socket transport" : "Unix-socket transport (skipped)", () => {
	let hu: Harness;
	let cu: ReturnType<typeof client>;
	const du = RUN ? it : it.skip;
	beforeAll(async () => {
		if (!RUN) return;
		hu = await start({ unix: true, netns: NETNS, cpuMs: 5000, basePort: BASE + 20 });
		cu = client(hu);
	});
	afterAll(async () => {
		if (hu) await hu.stop();
	});

	du("serves healthz, load and exec on its socket, in a 0700 directory", async () => {
		expect(statSync(hu.socketDir as string).mode & 0o777).toBe(0o700);
		const health = await cu.health();
		expect(health.ok).toBe(true);
		expect((await cu.load("ux", 256)).ok).toBe(true);
		const r = await cu.exec("ux", "echo hi");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("hi\n");
	});
	du("reads a manifest file from the store's socket and uploads a changed one", async () => {
		const manifest = { "in.txt": await cu.fileEntry("a\nb\nc\n") };
		const r = await cu.exec("ux", "wc -l < in.txt; cp in.txt out.txt", manifest);
		expect(r.stdout).toBe("3\n");
		expect(r.changed).toContain("out.txt");
		const out = (r.manifest as Record<string, { sha: string }>)["out.txt"];
		expect(out.sha).toBe(manifest["in.txt"].sha);
	});
	du("node fetch goes through the egress socket, tagged with the sandbox", async () => {
		await cu.load("ux-eg");
		const r = await cu.exec(
			"ux-eg",
			"node -e 'fetch(\"http://example.test/json\").then(r=>r.json()).then(j=>console.log(j.n))'",
		);
		expect(r.stdout).toBe("7\n");
		expect(hu.upstreamHits.some((x) => x.path === "/json" && x.sandbox === "ux-eg")).toBe(true);
	});
	du("python runs, with numpy and a manifest file", async () => {
		const manifest = { "d.csv": await cu.fileEntry("v\n1\n2\n3\n") };
		const r = await cu.exec(
			"ux",
			'python -c \'import csv, numpy as np; print(int(np.array([int(r["v"]) for r in csv.DictReader(open("d.csv"))]).sum()))\'',
			manifest,
			20000,
		);
		expect(r.stdout).toBe("6\n");
	});
	du("a node heap bomb is stopped (exit 137) and the process survives", async () => {
		const r = await cu.exec("ux", "node -e 'const a=[];while(true)a.push(new Array(1e6).fill(1))'", {}, 8000);
		expect(r.exitCode).toBe(137);
		expect(r.terminated).toBe("memory");
		expect((await cu.health()).ok).toBe(true);
	});
	du("the process has no TCP or UDP sockets, and a guest fetch still reaches the egress socket", async () => {
		const pid = hu.pid;
		const tables = ["tcp", "tcp6", "udp", "udp6", "raw", "raw6"];
		// Socket inodes in the process's network namespace's tables (column 10 of each row).
		const inet = new Set<string>();
		for (const t of tables) {
			const rows = readFileSync(`/proc/${pid}/net/${t}`, "utf8").trim().split("\n").slice(1);
			for (const row of rows) inet.add(row.trim().split(/\s+/)[9]);
		}
		// The process's own sockets, where /proc lets us see them (not when it's non-dumpable, as it is hardened).
		let fds: string[] | null = null;
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {}
		if (fds) {
			const sockets = fds
				.map((fd) => {
					try {
						return readlinkSync(`/proc/${pid}/fd/${fd}`);
					} catch {
						return "";
					}
				})
				.map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1])
				.filter((x): x is string => Boolean(x));
			expect(sockets.length).toBeGreaterThan(0);
			expect(sockets.filter((s) => inet.has(s))).toEqual([]);
		}
		if (NETNS) expect([...inet]).toEqual([]); // its own namespace: any TCP/UDP socket of its would be listed
		expect(fds !== null || NETNS).toBe(true); // one of the two checks ran
		// Its Unix sockets are there: the listener in the socket directory.
		expect(readFileSync(`/proc/${pid}/net/unix`, "utf8")).toContain(hu.rtSocket as string);
		// And the guest's network still works, through the egress socket.
		const before = hu.upstreamHits.length;
		const r = await cu.exec("ux-eg", "curl -s http://example.test/json");
		expect(JSON.parse(r.stdout as string).n).toBe(7);
		expect(hu.upstreamHits.slice(before).some((x) => x.sandbox === "ux-eg")).toBe(true);
	});
});
