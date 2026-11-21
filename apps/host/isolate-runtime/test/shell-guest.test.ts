// The shell guest's own pieces, without the runtime: the parse-before-run check (guest/shell/prescan.js) over
// just-bash's real parse, the filesystem error wording, and the just-bash patches (patches/just-bash@3.6.0.patch,
// installed by bun, and guest/just-bash-patches.ts, applied here as the guest build applies it).

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JUST_BASH_BROWSER_BUNDLE, patchJustBashBrowser } from "../guest/just-bash-patches.ts";
import { describeFsError, readError } from "../guest/shell/fs-errors.js";
import { prescan } from "../guest/shell/prescan.js";
import { UNAVAILABLE } from "../guest/shell/unavailable.js";

// The patched bundle, as the guest runs it, for every just-bash import below.
Bun.plugin({
	name: "just-bash-patches",
	setup(build) {
		build.onLoad({ filter: JUST_BASH_BROWSER_BUNDLE }, (args) => ({
			contents: patchJustBashBrowser(readFileSync(args.path, "utf8")),
			loader: "js",
		}));
	},
});
const { Bash, InMemoryFs } = await import("just-bash/browser");

const names = new Map(UNAVAILABLE);
const lookup = (name: string) => (names.has(name) ? { command: name, reason: `${names.get(name)}.` } : undefined);
const bash = new Bash({ fs: new InMemoryFs({}) });
const refused = (command: string) => prescan(bash.transform(command).ast, lookup)?.command;

describe("parse before run", () => {
	it("refuses a plain command that ends on an unavailable program, before any of it runs", () => {
		for (const command of [
			"git status",
			"git --help",
			"tar -tf x.tar",
			"echo a >> f && git push",
			"echo a > f; git status",
			"mkdir out && touch out/x && npm install",
			"cat f | git apply",
			"git status && echo ok",
		]) {
			expect(refused(command), command).toBeDefined();
		}
	});
	it("runs any command it can't be sure would fail", () => {
		for (const command of [
			// Handled, skipped, or not the command's outcome.
			"git --version || echo ok",
			"true || git status",
			"true || git status && echo ok",
			"git status; echo done",
			"git log | head -1",
			"! git status",
			"git status &",
			"if git status; then echo y; fi",
			"{ git status; }",
			"(git status)",
			// Not that program, or not run.
			"command -v git",
			"git() { echo mine; }; git status",
			"env() { true; }; env git status",
			"/usr/bin/git status",
			"echo git",
			// Wrappers and their options.
			"env git status",
			"env git --help",
			"timeout 5 git --help",
			"env --help git",
			"xargs git < list",
			// Only known at run time, or able to change what runs.
			"bash -c 'git status'",
			"eval git status",
			'"$G" status',
			"echo $(git status)",
			"set -e; git status",
			"alias g=git; g status",
			"command exit 0; git status",
			"exit 0; git status",
			"PATH=/x git status",
			"export PATH=/workspace/bin; git status",
			"read PATH <<< /workspace/bin; git status",
			"cp x /usr/bin/git && git status",
			"cd .. && git status",
			// A program the isolate has.
			"node -e 1",
			"python -c 1",
		]) {
			expect(refused(command), command).toBeUndefined();
		}
	});
});

describe("filesystem errors", () => {
	it("words coded errors as bash does and leaves others alone", () => {
		expect(describeFsError(Object.assign(new Error("x"), { code: "EROFS", path: "/workspace/ro/a" }))).toBe(
			"bash: /workspace/ro/a: Read-only file system\n",
		);
		expect(describeFsError(Object.assign(new Error("x"), { code: "EFBIG", reason: "file too large (9 bytes)" }))).toBe(
			"bash: file too large (9 bytes)\n",
		);
		expect(describeFsError(new Error("something else"))).toBeUndefined();
	});
	it("turns the workspace's too-large read into EFBIG", () => {
		const e = readError(new Error("blob: file too large (9 bytes; the isolate reads at most 1)"));
		expect(e).toMatchObject({ code: "EFBIG", reason: "file too large (9 bytes; the isolate reads at most 1)" });
		// Any other failure of a file that exists is EIO, never one just-bash could take for a missing file.
		expect(readError(new Error("blob: No such file or directory (os error 2)"))).toMatchObject({ code: "EIO" });
	});
});

describe("the patched just-bash", () => {
	it("applies each patch exactly once", () => {
		const bundle = readFileSync(resolve(import.meta.dir, "../node_modules/just-bash/dist/bundle/browser.js"), "utf8");
		expect(bundle).toContain("__justBashReadFailure");
		expect(patchJustBashBrowser(bundle)).toContain("__justBashFsError");
	});
	it("reports a file too large as such, and never recreates one it couldn't read", async () => {
		const tooLarge = async () => {
			throw readError(new Error("blob: file too large (9 bytes; the isolate reads at most 1)"));
		};
		const fs = new InMemoryFs({ "/w/big": tooLarge, "/w/kept": tooLarge });
		await fs.mkdir("/w", { recursive: true });
		const shell = new Bash({ fs, cwd: "/w" });
		const r = await shell.exec("cat big; exec 3<> kept; echo after");
		expect(r.stderr).toContain("file too large (9 bytes; the isolate reads at most 1)");
		expect(r.stderr).not.toContain("No such file");
		expect(r.stdout).toBe("after\n");
		// `<>` opens a file read-write, creating it only when it is missing: one that failed to read isn't emptied.
		await expect(fs.readFile("/w/kept")).rejects.toMatchObject({ code: "EFBIG" });
	});
	it("never empties a file whose read failed with a missing-file message from the store", async () => {
		const storeDown = async () => {
			throw readError(new Error("blob: No such file or directory (os error 2)"));
		};
		const fs = new InMemoryFs({ "/w/kept": storeDown });
		await fs.mkdir("/w", { recursive: true });
		const r = await new Bash({ fs, cwd: "/w" }).exec("exec 3<> kept; echo after");
		expect(r.stdout).toBe("after\n");
		await expect(fs.readFile("/w/kept")).rejects.toMatchObject({ code: "EIO" });
	});
	it("fails only the command whose redirection meets a filesystem error", async () => {
		const fs = new InMemoryFs({});
		await fs.mkdir("/w/ro", { recursive: true });
		const writeFile = fs.writeFile.bind(fs);
		fs.writeFile = async (path: string, ...rest: unknown[]) => {
			if (String(path).startsWith("/w/ro/")) throw Object.assign(new Error("EROFS"), { code: "EROFS", path });
			return writeFile(path, ...(rest as [never]));
		};
		globalThis.__justBashFsError = describeFsError;
		const shell = new Bash({ fs, cwd: "/w" });
		const r = await shell.exec("echo x > ro/a; echo after");
		expect(r.stdout).toBe("after\n");
		expect(r.stderr).toContain("Read-only file system");
	});
});

declare global {
	var __justBashFsError: ((error: unknown) => string | undefined) | undefined;
}
