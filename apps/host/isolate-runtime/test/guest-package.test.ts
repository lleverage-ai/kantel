// The guest package's shell over a filesystem of the embedder's own (not Kantel's manifest one): createShell takes any
// `ShellFilesystem` (guest/shell/index.js), runs the command over it, and saves through it.

import { describe, expect, it } from "bun:test";

// The guest reads the runtime's ops from Deno.core when it loads, as in an isolate. Only randomness (from the host's
// crypto: the guest replaces the global one with its own, which calls this op) and the host commands' names (none)
// are reached here.
const random = crypto.getRandomValues.bind(crypto);
const ops = new Proxy({} as Record<string, unknown>, {
	get: (_, name) =>
		name === "op_kt_random"
			? (buf: Uint8Array) => random(buf)
			: name === "op_kt_host_commands"
				? () => "[]"
				: () => {
						throw new Error(`no op ${String(name)} in this test`);
					},
});
(globalThis as { Deno?: unknown }).Deno = { core: { ops } };
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
