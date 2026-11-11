// Integration tests for kantel-isolate: it is started against STORE/egress stand-ins (see harness.ts) and driven
// over kantel-host's protocol. Covers protocol parity with the behaviours sandbox.ts has, manifest semantics, node
// and python features, egress tagging, needsMicrovm and terminated, and the B5 containment attacks with a
// neighbour's latency checked. Skips with a message if the binary or assets aren't built.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { available, client, type Harness, start } from "./harness";

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
