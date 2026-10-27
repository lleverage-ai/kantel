import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway Git repository; `commit` writes files (text or bytes) and returns the commit SHA. */
export function tempRepo(): {
	readonly dir: string;
	commit(files: Record<string, string | Uint8Array | null>): string;
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
			for (const [path, content] of Object.entries(files)) {
				const full = join(dir, path);
				if (content === null) {
					rmSync(full, { force: true });
					continue;
				}
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, content);
			}
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
