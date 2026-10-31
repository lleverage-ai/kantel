import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { CallContext } from "@kantel/contracts";
import { routeTool } from "@kantel/sandbox";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import {
	createIsolateNodeCommand,
	ISOLATE_NODE_ROUTES,
	type IsolateNodeOptions,
	NODE_VERSION,
} from "@kantel/sandbox/isolate-node";
import { createTieredSandboxes } from "@kantel/sandbox/tiered";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { beforeAll, describe, expect, it } from "vitest";
import { SimulatedContainer } from "./backends.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };

/** The engine, compiled once, as a Worker imports it. */
let wasmModule: WebAssembly.Module;
beforeAll(async () => {
	const path = createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
	const wasm = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<WebAssembly.Module> } })
		.WebAssembly;
	wasmModule = await wasm.compile(await readFile(path));
});

async function setUp(files: Record<string, string> = {}, limits: Partial<IsolateNodeOptions> = {}) {
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
	const record = await workspaces.create(ctx, {
		owner: { kind: "organisation", organisationId: "org-1" },
		seed: { name: "s", sources: [{ kind: "files", files }] },
	});
	const node = createIsolateNodeCommand({ wasmModule, ...limits });
	const sandboxes = createTieredSandboxes({
		workspaces,
		isolate: createInProcessIsolateBackend(workspaces, { commands: [node] }),
		container: new SimulatedContainer(workspaces),
		routes: ISOLATE_NODE_ROUTES,
	});
	const run = (command: string) =>
		sandboxes.run(ctx, { sessionId: "sess-1", workspaceId: record.id, tool: "bash", request: { command } });
	return { workspaces, record, run };
}

describe("node in the isolate tier", () => {
	it("routes node to the isolate, and everything else as before", () => {
		expect(routeTool(ISOLATE_NODE_ROUTES, "bash", "node a.js")).toBe("isolate");
		expect(routeTool(ISOLATE_NODE_ROUTES, "bash", "cd src && node a.js")).toBe("isolate");
		expect(routeTool(ISOLATE_NODE_ROUTES, "bash", "npm test")).toBe("container");
		expect(routeTool(ISOLATE_NODE_ROUTES, "bash", "python3 a.py")).toBe("container");
	});

	it("runs a workspace script with its arguments, and its output feeds the shell", async () => {
		const { run, workspaces, record } = await setUp({
			"fib.js": [
				"const n = Number(process.argv[2] ?? 10);",
				"const fib = [0, 1];",
				"while (fib.length < n) fib.push(fib.at(-1) + fib.at(-2));",
				"console.log(fib.join(' '));",
				"console.log({ n, last: fib.at(-1), ok: true }, [1, 'two']);",
				"console.error('done');",
			].join("\n"),
		});
		const result = await run("node fib.js 8");
		expect(result).toMatchObject({ tier: "isolate", exitCode: 0, stderr: "done\n" });
		expect(result.stdout).toBe("0 1 1 2 3 5 8 13\n{ n: 8, last: 13, ok: true } [ 1, 'two' ]\n");
		const piped = await run(
			"node fib.js 5 2>/dev/null | head -n 1 | tr ' ' '\\n' | tail -n 1 > last.txt && cat last.txt",
		);
		expect(piped).toMatchObject({ exitCode: 0, stdout: "3\n" });
		const saved = await workspaces.read(ctx, record.id, "last.txt");
		expect(new TextDecoder().decode(saved.content)).toBe("3\n");
	});

	it("evaluates and prints, runs promises, and exits with the script's code", async () => {
		const { run } = await setUp();
		expect(await run("node -p '6 * 7'")).toMatchObject({ exitCode: 0, stdout: "42\n" });
		expect(await run(`node -e 'Promise.resolve(2).then((n) => console.log("then", n))'`)).toMatchObject({
			exitCode: 0,
			stdout: "then 2\n",
		});
		expect(await run(`node -e 'console.log("a"); process.exit(3); console.log("b")'`)).toMatchObject({
			exitCode: 3,
			stdout: "a\n",
		});
		expect(await run("node --version")).toMatchObject({ exitCode: 0, stdout: `${NODE_VERSION}\n` });
	});

	it("reports an uncaught error, a rejected promise and a missing script as Node does, with exit 1", async () => {
		const { run } = await setUp({ "bad.js": "function go() { throw new TypeError('nope'); }\ngo();\n" });
		const thrown = await run("node bad.js");
		expect(thrown.exitCode).toBe(1);
		expect(thrown.stderr).toContain("TypeError: nope");
		expect(thrown.stderr).toContain("go");
		const rejected = await run(`node -e '(async () => { throw new Error("later"); })()'`);
		expect(rejected).toMatchObject({ exitCode: 1 });
		expect(rejected.stderr).toContain("Error: later");
		expect(await run("node missing.js")).toMatchObject({
			exitCode: 1,
			stderr: "node: Cannot find module '/workspace/missing.js'\n",
		});
		const required = await run(`node -e 'require("fs")'`);
		expect(required.exitCode).toBe(1);
		expect(required.stderr).toContain("without Node's modules");
	});

	it("stops a busy loop, a memory hog and a flood of output, and the next run starts fresh", async () => {
		const { run } = await setUp({}, { maxInterrupts: 50, maxOutputBytes: 1000 });
		const loop = await run("node -e 'for (;;) {}'");
		expect(loop).toMatchObject({ exitCode: 124 });
		expect(loop.stderr).toContain("CPU budget");
		for (const hog of [
			`node -e 'const a = []; for (;;) a.push("x".repeat(1e5) + a.length)'`,
			`node -e 'const a = []; for (;;) a.push({ i: a.length })'`,
		]) {
			const result = await (await setUp()).run(hog);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/memory/);
		}
		const flood = await run(`node -e 'for (let i = 0; i < 1000; i++) console.log("line", i)'`);
		expect(flood.stdout.length).toBe(1000);
		expect(flood.stderr).toContain("output stopped at 1000 bytes");
		expect(await run(`node -e 'console.log(typeof globalThis.a)'`)).toMatchObject({
			exitCode: 0,
			stdout: "undefined\n",
		});
	});

	it("refuses a script over its size limit", async () => {
		const { run } = await setUp({ "big.js": `// ${"x".repeat(200)}\n` }, { maxScriptBytes: 100 });
		expect(await run("node big.js")).toMatchObject({ exitCode: 1 });
	});
});
