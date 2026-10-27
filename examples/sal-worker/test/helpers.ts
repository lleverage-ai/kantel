import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A file to write: text, bytes, a symlink to `link`, or null to delete. */
export type FixtureFile = string | Uint8Array | { readonly link: string } | null;

/** Writes `files` under `dir`. */
export function writeFixture(dir: string, files: Record<string, FixtureFile>): void {
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path);
		if (content === null) {
			rmSync(full, { force: true });
			continue;
		}
		mkdirSync(dirname(full), { recursive: true });
		if (typeof content === "object" && "link" in content) symlinkSync(content.link, full);
		else writeFileSync(full, content);
	}
}

/** A throwaway Git repository; `commit` writes files (text, bytes or symlinks) and returns the commit SHA. */
export function tempRepo(): {
	readonly dir: string;
	commit(files: Record<string, FixtureFile>): string;
	remove(): void;
} {
	const dir = mkdtempSync(join(tmpdir(), "harbour-sal-worker-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
			encoding: "utf8",
		}).trim();
	git("init", "-q", "-b", "main");
	return {
		dir,
		commit(files) {
			writeFixture(dir, files);
			git("add", "-A");
			git("commit", "-q", "--allow-empty", "-m", "change");
			return git("rev-parse", "HEAD");
		},
		remove() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** A Sal concept file as sal-memory writes them: JSON values in YAML frontmatter, then the body. */
export function conceptFile(fields: Record<string, unknown>, body: string): string {
	const lines = Object.entries({ type: "Fact", status: "stable", ...fields }).map(
		([key, value]) => `${key}: ${JSON.stringify(value)}`,
	);
	return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

export function source(resource: string) {
	return { id: "s1", resource, title: "Owner instruction", author: "human:tom", last_modified: "2026-10-01T00:00:00Z" };
}
