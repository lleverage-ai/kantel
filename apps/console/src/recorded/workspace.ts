// A recorded session's workspace: a small, fixed set of files served in the page as the workspace read API would serve
// them (a directory's direct children, a file's bytes, 413 past the size limit), for the console's file browser
// before there is a host. Every recorded session shares it. Nothing here is real work: the files are stand-ins.

import type { WorkspaceEntry } from "@kantel/ui";
import { retriesChartBytes } from "@kantel/ui/workspace/image-fixture";
import type { WorkspaceFile, WorkspaceFiles, WorkspaceListing } from "../api/client.ts";
import { ApiError } from "../api/http.ts";

/** The read API's content limit: bigger files are refused (413), and the viewers say so. */
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();

const plan = `# Retry the billing sync

The nightly billing sync fails about once a week when the provider answers 503 during its own maintenance window.
This run makes the sync retry with backoff, and records each retry so the morning report can say what happened.

## Steps

- [x] Reproduce the failure against the provider's sandbox
- [x] Add \`retryWithBackoff\` in \`src/billing/retry.ts\`
- [ ] Record each retry in the audit log
- [ ] Hand back with the test run and a note for the release

## What retries

| Answer | Retried | Why |
| --- | --- | --- |
| 503 | Yes | The provider is down for maintenance |
| 429 | Yes, after \`Retry-After\` | Rate limited |
| 401 | No | The key is wrong; retrying won't help |

\`\`\`ts
await retryWithBackoff(() => sync(account), { attempts: 5, baseMs: 2_000 });
\`\`\`

See the [provider's status page][status] for the maintenance windows.

[status]: https://status.example.com
`;

const handback = `# Handback

The sync now retries a 503 or 429 up to five times, two seconds apart and doubling. Last night's run retried twice
and finished at 02:14.

Still open: the retries aren't in the audit log yet. That needs the audit sink in the billing worker, which is a
separate change.
`;

const retry = `export type RetryOptions = {
	readonly attempts: number;
	readonly baseMs: number;
	readonly sleep?: (ms: number) => Promise<void>;
};

const retryable = (status: number) => status === 503 || status === 429;

/** Calls \`task\` until it succeeds, waiting baseMs, then twice as long each time, between attempts. */
export async function retryWithBackoff<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	for (let attempt = 1; ; attempt++) {
		try {
			return await task();
		} catch (error) {
			const status = (error as { status?: number }).status ?? 0;
			if (attempt >= options.attempts || !retryable(status)) throw error;
			await sleep(options.baseMs * 2 ** (attempt - 1));
		}
	}
}
`;

const retryTest = `import { describe, expect, it } from "vitest";
import { retryWithBackoff } from "./retry.ts";

describe("retryWithBackoff", () => {
	it("retries a 503 and then succeeds", async () => {
		let calls = 0;
		const result = await retryWithBackoff(
			async () => {
				calls++;
				if (calls < 3) throw Object.assign(new Error("down"), { status: 503 });
				return "synced";
			},
			{ attempts: 5, baseMs: 1, sleep: async () => {} },
		);
		expect(result).toBe("synced");
		expect(calls).toBe(3);
	});
});
`;

const packageJson = `{
	"name": "billing-sync",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "vitest run"
	}
}
`;

const readme = `# billing-sync

The nightly job that copies invoices from the billing provider into the ledger.

Run the tests with \`pnpm test\`. The plan for this session is in \`notes/plan.md\`.
`;

/** A run log long enough that the file viewer shows its first lines and says how many it left out. */
const runLog = Array.from(
	{ length: 6200 },
	(_, line) =>
		`02:${String(Math.floor(line / 120) % 60).padStart(2, "0")}:${String(line % 60).padStart(2, "0")} sync account ${1000 + (line % 400)}: ${line % 97 === 0 ? "503, retrying" : "ok"}`,
).join("\n");

/** The first bytes of a PNG and no more: an image the browser can't decode, which the viewer says it can't show. */
const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

type Stored =
	| { readonly content: Uint8Array; readonly contentType: string; readonly version: number }
	/** Listed with its size, refused when read, as the read API refuses a file over its limit. */
	| { readonly size: number; readonly version: number };

/** The images the poster session presents (catalogue.ts), under `out/`. */
export const POSTERS = [
	"poster-illustration-dark-navy-background-with-mvv1x9uw.png",
	"retro-1960s-screen-print-travel-poster-mvv1xc4c.png",
	"minimalist-geometric-bauhaus-style-poster-a-mvv1x3f7.png",
	"cinematic-neon-noir-illustration-wide-night-mvv1x677.png",
] as const;

const text = (value: string, contentType = "text/plain; charset=utf-8", version = 3): Stored => ({
	content: encoder.encode(value),
	contentType,
	version,
});

const FILES: ReadonlyMap<string, Stored> = new Map<string, Stored>([
	["README.md", text(readme, "text/markdown; charset=utf-8", 1)],
	["package.json", text(packageJson, "application/json", 1)],
	["notes/plan.md", text(plan, "text/markdown; charset=utf-8", 4)],
	["notes/handback.md", text(handback, "text/markdown; charset=utf-8", 6)],
	["notes/empty.md", text("", "text/markdown; charset=utf-8", 2)],
	["notes/retries-per-night.png", { content: retriesChartBytes(), contentType: "image/png", version: 6 }],
	["src/billing/retry.ts", text(retry, "text/plain; charset=utf-8", 3)],
	["src/billing/retry.test.ts", text(retryTest, "text/plain; charset=utf-8", 3)],
	["logs/sync-2026-10-27.log", text(runLog, "text/plain; charset=utf-8", 5)],
	["assets/logo.png", { content: logo, contentType: "image/png", version: 1 }],
	["assets/ledger-export.csv", { size: 48 * 1024 * 1024, version: 5 }],
	// The poster session's images (catalogue.ts): stand-ins, each the same chart.
	...POSTERS.map((name): [string, Stored] => [
		`out/${name}`,
		{ content: retriesChartBytes(), contentType: "image/png", version: 1 },
	]),
]);

const sizeOf = (stored: Stored) => ("content" in stored ? stored.content.byteLength : stored.size);

/** A directory's direct children: its files, and the directories on the way to deeper ones. */
function listing(directory: string): readonly WorkspaceEntry[] | undefined {
	const prefix = directory === "" ? "" : `${directory}/`;
	const entries = new Map<string, WorkspaceEntry>();
	for (const [path, stored] of FILES) {
		if (!path.startsWith(prefix)) continue;
		const [name, ...deeper] = path.slice(prefix.length).split("/");
		if (name === undefined) continue;
		const child = `${prefix}${name}`;
		if (deeper.length > 0) entries.set(child, { path: child, kind: "directory", size: 0 });
		else entries.set(child, { path: child, kind: "file", size: sizeOf(stored), version: stored.version });
	}
	return entries.size === 0 && directory !== "" ? undefined : [...entries.values()];
}

export type RecordedWorkspaceOptions = {
	/** How long each read takes, so the loading states show. Default 120 ms. */
	delayMs?: number;
};

export function recordedWorkspace(id: string, options: RecordedWorkspaceOptions = {}): WorkspaceFiles {
	const delayMs = options.delayMs ?? 120;
	const wait = (signal: AbortSignal | undefined) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, delayMs);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(signal.reason);
			});
		});

	return {
		id,
		async list(path, signal): Promise<WorkspaceListing> {
			await wait(signal);
			const entries = listing(path);
			if (entries === undefined) throw new ApiError("not_found", `${path} isn't in this workspace.`);
			return { entries, truncated: false };
		},
		async read(path, signal): Promise<WorkspaceFile> {
			await wait(signal);
			const stored = FILES.get(path);
			if (stored === undefined) throw new ApiError("not_found", `${path} isn't in this workspace.`);
			if (!("content" in stored) || stored.content.byteLength > MAX_CONTENT_BYTES) {
				throw new ApiError("too_large", "This file is too large to show here.");
			}
			return { content: stored.content, contentType: stored.contentType, version: stored.version };
		},
	};
}
