// The guest package's shell over a filesystem of the embedder's own (not Kantel's manifest one): createShell takes any
// `ShellFilesystem` (guest/shell/index.js), runs the command over it, and saves through it.

import { describe, expect, it } from "bun:test";

// The guest reads the runtime's ops from Deno.core when it loads, as in an isolate. Only randomness (from the host's
// crypto: the guest replaces the global one with its own, which calls this op) and the host commands (`hostCommands`:
// their names, and a run answering as `hostReply` says) are reached here.
const random = crypto.getRandomValues.bind(crypto);
// The host's own, before the guest replaces the globals with its own (which call these ops).
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let hostCommands: string[] = [];
const hostRuns: { name: string; args: string[] }[] = [];
/** A host command's reply, as the runtime packs it: its meta's length, the meta, then the bytes it names. */
function hostReply(stdout: string, writes: { path: string; text: string }[] = []) {
	const enc = encoder;
	const chunks: Uint8Array[] = [];
	let at = 0;
	const add = (text: string) => {
		const bytes = enc.encode(text);
		chunks.push(bytes);
		at += bytes.length;
		return [at - bytes.length, bytes.length];
	};
	const meta = enc.encode(
		JSON.stringify({
			exitCode: 0,
			stdout: add(stdout),
			stderr: add(""),
			writes: writes.map((w) => ({ path: w.path, data: add(w.text) })),
			removes: [],
		}),
	);
	const out = new Uint8Array(4 + meta.length + at);
	new DataView(out.buffer).setUint32(0, meta.length);
	out.set(meta, 4);
	let p = 4 + meta.length;
	for (const c of chunks) {
		out.set(c, p);
		p += c.length;
	}
	return out;
}
const hostOps: Record<string, unknown> = {
	op_kt_random: (buf: Uint8Array) => random(buf),
	op_kt_encode: (text: string) => encoder.encode(text),
	op_kt_host_commands: () => JSON.stringify(hostCommands),
	op_kt_host_cancel: () => {},
	op_kt_host_command: async (meta: string) => {
		const { name, args } = JSON.parse(meta);
		hostRuns.push({ name, args });
		return hostReply(`${name} on the host: ${args.join(" ")}\n`, [{ path: `${name}.log`, text: "ran\n" }]);
	},
};
const ops = new Proxy({} as Record<string, unknown>, {
	get: (_, name) =>
		hostOps[String(name)] ??
		(() => {
			throw new Error(`no op ${String(name)} in this test`);
		}),
});
(globalThis as { Deno?: unknown }).Deno = {
	core: { ops, decode: (bytes: Uint8Array) => decoder.decode(bytes) },
};
const { InMemoryFs } = await import("just-bash/browser");
const { createShell } = await import("../guest/shell/index.js");

/** An embedder's filesystem: one in-memory tree kept between commands, saved by listing what is under /workspace. */
function keptFilesystem() {
	const fs = new InMemoryFs({ "/workspace/a.txt": "alpha\n" });
	const saves: string[][] = [];
	return {
		saves,
		open: async () => ({
			fs,
			childIndex: async () => ({}),
			unchanged: () => ({ manifest: {}, changed: [] }),
			finish: async () => {
				const paths = fs.getAllPaths().filter((p: string) => p.startsWith("/workspace/"));
				saves.push(paths);
				return { manifest: Object.fromEntries(paths.map((p: string) => [p, { kind: "kept" }])), changed: paths };
			},
		}),
	};
}

const run = async (shell: { exec(json: string): Promise<string> }, command: string) =>
	JSON.parse(await shell.exec(JSON.stringify({ command })));

describe("the guest package's shell", () => {
	it("runs over any filesystem and saves through it", async () => {
		const filesystem = keptFilesystem();
		const shell = createShell(ops, { filesystem });
		const r = await run(shell, "cat a.txt && echo bravo > b.txt && cat b.txt");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toBe("alpha\nbravo\n");
		expect(r.changed).toContain("/workspace/b.txt");
		// The same tree on the next command: the embedder's filesystem keeps it.
		expect((await run(shell, "cat b.txt")).stdout).toBe("bravo\n");
		expect(filesystem.saves).toHaveLength(2);
	});
	it("refuses before running, and saves nothing, when the command can't succeed", async () => {
		const filesystem = keptFilesystem();
		const r = await run(createShell(ops, { filesystem }), "echo c > c.txt && git push");
		expect(r).toMatchObject({ exitCode: 127, effects: "none", needsMicrovm: { command: "git" } });
		expect(filesystem.saves).toHaveLength(0);
	});
});

type Shell = { host(name: string, args?: string[]): Promise<{ exitCode: number; stdout: Uint8Array }> };
type Ctx = { fs: { writeFile(path: string, data: string): Promise<void> }; cwd: string };

describe("the embedder's own guest commands", () => {
	it("run in the shell, their changes saved by the command's one save, with no way to commit of their own", async () => {
		hostCommands = [];
		const filesystem = keptFilesystem();
		let given: string[] = [];
		const greet = {
			name: "greet",
			run: async (args: string[], ctx: Ctx, shell: Shell) => {
				given = Object.keys(shell);
				await ctx.fs.writeFile(`${ctx.cwd}/greeted.txt`, `${args[0]}\n`);
				return { stdout: `hello ${args[0]}\n`, stderr: "", exitCode: 0 };
			},
		};
		const r = await run(createShell(ops, { filesystem, commands: [greet] }), "greet bob && cat greeted.txt");
		expect(r).toMatchObject({ exitCode: 0, stdout: "hello bob\nbob\n" });
		expect(r.changed).toContain("/workspace/greeted.txt");
		expect(filesystem.saves).toHaveLength(1);
		expect(given).toEqual(["host"]);
	});

	it("front a host command of the same name with override, its writes applied to the shell's files", async () => {
		hostCommands = ["rg", "duckdb"];
		hostRuns.length = 0;
		const filesystem = keptFilesystem();
		const rg = {
			name: "rg",
			override: true,
			run: async (args: string[], _ctx: Ctx, shell: Shell) => {
				const done = await shell.host("rg", ["--json", ...args]);
				return { stdout: `front-end: ${new TextDecoder().decode(done.stdout)}`, stderr: "", exitCode: done.exitCode };
			},
		};
		const r = await run(createShell(ops, { filesystem, commands: [rg] }), "rg needle && cat rg.log");
		expect(r).toMatchObject({ exitCode: 0, stdout: "front-end: rg on the host: --json needle\nran\n" });
		expect(hostRuns).toEqual([{ name: "rg", args: ["--json", "needle"] }]);
		expect(r.changed).toContain("/workspace/rg.log");
		// Without override, a clash with a host command is an error for every command, not a silent replacement.
		const duckdb = { name: "duckdb", run: rg.run };
		const clashing = createShell(ops, { filesystem, commands: [duckdb] });
		await expect(clashing.exec(JSON.stringify({ command: "echo hi" }))).rejects.toThrow("duckdb is a host command");
	});

	it("replace a built-in only with override, and take a name the isolate lacks without it", async () => {
		hostCommands = [];
		const mine = { name: "cat", run: async () => ({ stdout: "mine\n", stderr: "", exitCode: 0 }) };
		expect(() => createShell(ops, { filesystem: keptFilesystem(), commands: [mine] })).toThrow(
			"the shell has a cat command",
		);
		const twice = { name: "twice", run: mine.run };
		expect(() => createShell(ops, { filesystem: keptFilesystem(), commands: [twice, twice] })).toThrow(
			"two commands named twice",
		);
		const replaced = createShell(ops, { filesystem: keptFilesystem(), commands: [{ ...mine, override: true }] });
		expect((await run(replaced, "cat a.txt")).stdout).toBe("mine\n");
		// A replaced plain command may do anything, so what follows it isn't refused before it runs.
		const after = await run(replaced, "cat a.txt && git status");
		expect(after).toMatchObject({ exitCode: 127, stdout: "mine\n", needsMicrovm: { command: "git" } });
		expect(after.effects).not.toBe("none");
		// What the interpreter runs itself can't be replaced, override or not.
		for (const override of [false, true]) {
			expect(() =>
				createShell(ops, { filesystem: keptFilesystem(), commands: [{ ...mine, name: "cd", override }] }),
			).toThrow("cd is the shell's own");
		}
		// A just-bash command this shell answers with a stub (it lacks it) is the embedder's to take.
		const html = { ...mine, name: "html-to-markdown" };
		expect(
			(await run(createShell(ops, { filesystem: keptFilesystem(), commands: [html] }), "html-to-markdown")).stdout,
		).toBe("mine\n");
		const git = { name: "git", run: async () => ({ stdout: "my git\n", stderr: "", exitCode: 0 }) };
		const r = await run(createShell(ops, { filesystem: keptFilesystem(), commands: [git] }), "git status");
		expect(r).toMatchObject({ exitCode: 0, stdout: "my git\n" });
		expect(r.needsMicrovm).toBeUndefined();
	});
});
