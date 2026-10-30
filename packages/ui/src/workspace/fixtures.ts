// Fixtures for the workspace components' stories: a small project, a deep tree with long names, source files and
// notes. One set, so every story shows the same workspace. Listings are deliberately unsorted: the tree sorts them.

import type { DirectoryState, WorkspaceEntry } from "./workspace-model.ts";

const file = (path: string, size: number): WorkspaceEntry => ({ path, kind: "file", size, version: 4 });
const dir = (path: string): WorkspaceEntry => ({ path, kind: "directory", size: 0, version: 4 });
const ready = (...entries: WorkspaceEntry[]): DirectoryState => ({ status: "ready", entries });

/** A small project: source, docs, notes and a few root files, every directory listed. */
export const projectDirectories = new Map<string, DirectoryState>([
	[
		"",
		ready(
			file("README.md", 2_184),
			dir("src"),
			file("package.json", 912),
			dir("notes"),
			file(".gitignore", 64),
			dir("docs"),
			file("pnpm-lock.yaml", 184_320),
			file("logo.png", 48_211),
		),
	],
	[
		"src",
		ready(
			file("src/server.ts", 1_288),
			dir("src/billing"),
			file("src/app.ts", 3_410),
			file("src/index.ts", 212),
			file("src/step-10.ts", 840),
			file("src/step-2.ts", 812),
		),
	],
	[
		"src/billing",
		ready(
			file("src/billing/retry.ts", 2_960),
			file("src/billing/idempotency.ts", 1_744),
			file("src/billing/retry.test.ts", 4_102),
		),
	],
	["docs", ready(file("docs/architecture.md", 12_840), file("docs/runbook.md", 5_310))],
	["notes", ready(file("notes/release-notes.md", 3_220), file("notes/standup.md", 640), dir("notes/empty"))],
	["notes/empty", ready()],
]);

/** The same project with one directory still listing. */
export const projectWithLoadingDirectory = new Map<string, DirectoryState>([
	...projectDirectories,
	["src", { status: "loading" }],
]);

/** The same project with one directory that couldn't be listed. */
export const projectWithFailedDirectory = new Map<string, DirectoryState>([
	...projectDirectories,
	["docs", { status: "error", message: "Couldn't list this folder. The workspace didn't answer in time." }],
]);

export const rootLoading = new Map<string, DirectoryState>([["", { status: "loading" }]]);

export const rootFailed = new Map<string, DirectoryState>([
	["", { status: "error", message: "Couldn't load this workspace's files. You may no longer have access to it." }],
]);

export const rootEmpty = new Map<string, DirectoryState>([["", ready()]]);

const chain = [
	"packages",
	"packages/a-package-with-a-rather-long-name-for-the-sidebar",
	"packages/a-package-with-a-rather-long-name-for-the-sidebar/src",
	"packages/a-package-with-a-rather-long-name-for-the-sidebar/src/components",
	"packages/a-package-with-a-rather-long-name-for-the-sidebar/src/components/workspace-file-browser",
	"packages/a-package-with-a-rather-long-name-for-the-sidebar/src/components/workspace-file-browser/internal",
];

const longNames = [
	"index.ts",
	"use-the-workspace-read-api-to-list-a-directory-and-cache-the-result.ts",
	"README.md",
	"a-file-whose-name-goes-on-for-much-longer-than-any-sidebar-could-show.test.ts",
	"types.ts",
	"constants.ts",
	"format-bytes-for-people-who-do-not-think-in-kibibytes.ts",
	"helpers.ts",
];

const reportName = "generated-report-for-the-quarterly-billing-reconciliation-run";

/**
 * A deep tree: a mount at /project, six nested directories with long names, each with eight files, and forty files
 * at the root. The deepest listing is truncated. Every directory on the chain is expanded, and the mount.
 */
export function deepTree(): { directories: Map<string, DirectoryState>; expanded: Set<string> } {
	const directories = new Map<string, DirectoryState>();
	const rootFiles: WorkspaceEntry[] = [];
	for (let index = 0; index < 40; index++) {
		const name = index % 5 === 0 ? `${reportName}-${index + 1}.csv` : `file-${index + 1}.txt`;
		rootFiles.push(file(name, (index + 1) * 731));
	}
	directories.set("", ready(dir("/project"), dir("packages"), ...rootFiles));
	const project = ready(file("/project/README.md", 4_310), dir("/project/docs"), file("/project/package.json", 1_022));
	directories.set("/project", project);
	directories.set("/project/docs", ready(file("/project/docs/getting-started.md", 6_200)));
	chain.forEach((path, depth) => {
		const next = chain[depth + 1];
		const files = longNames.map((name, index) => file(`${path}/${name}`, (index + 3) * 1_337 * (depth + 1)));
		const listing: DirectoryState = {
			status: "ready",
			entries: next === undefined ? files : [dir(next), dir(`${path}/fixtures`), ...files],
			truncated: next === undefined,
		};
		directories.set(path, listing);
	});
	return { directories, expanded: new Set(["/project", ...chain]) };
}

/** A short TypeScript module. */
export const sourceFile = [
	'import { createWorkspaceReadClient } from "@harbour/workspace/read-api";',
	"",
	"/** Retries a charge with the same idempotency key, so a retry never charges twice. */",
	"export async function retryCharge(charge: Charge, attempts = 3): Promise<Receipt> {",
	"\tlet lastError: unknown;",
	"\tfor (let attempt = 1; attempt <= attempts; attempt++) {",
	"\t\ttry {",
	"\t\t\treturn await billing.charge({ ...charge, idempotencyKey: charge.id });",
	"\t\t} catch (error) {",
	"\t\t\tif (!isRetryable(error)) throw error;",
	"\t\t\tlastError = error;",
	"\t\t\tawait wait(250 * 2 ** attempt);",
	"\t\t}",
	"\t}",
	"\tthrow lastError;",
	"}",
	"",
	"function isRetryable(error: unknown): boolean {",
	"\treturn error instanceof BillingError && (error.status === 429 || error.status >= 500);",
	"}",
	"",
	"const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
	"",
].join("\n");

const sentence =
	"the retry reuses the idempotency key so a second attempt after a timeout is recognised by the billing provider and answered with the first receipt instead of a new charge";
const words = sentence.split(" ");

/** About 600 lines, some of them far wider than the viewer. */
export const longSourceFile = Array.from({ length: 600 }, (_, index) => {
	const line = index + 1;
	if (line % 60 === 1) return `// Section ${Math.ceil(line / 60)}: generated fixtures for the billing retry tests`;
	if (line % 60 === 0) return "";
	if (line % 9 === 0) {
		const text = Array.from({ length: 40 }, (_, at) => words[(line + at) % words.length]).join(" ");
		return `export const case${line} = { id: "case-${line}", note: "${text}", attempts: ${line % 5}, retryable: ${line % 2 === 0} };`;
	}
	return `\tconst attempt${line} = await retryCharge({ id: "charge-${line}", amount: ${line * 100}, currency: "GBP" });`;
}).join("\n");

/** A short note. */
export const shortNote = [
	"# Release notes",
	"",
	"The billing worker now retries a failed charge with the **same idempotency key**, so a retry after a timeout can't charge twice.",
	"",
	"- Retries back off from half a second, three attempts at most.",
	"- Only timeouts and 5xx answers are retried.",
	"",
	"See `src/billing/retry.ts` for the change.",
].join("\n");

const section = (title: string, index: number): string[] => [
	`## ${title}`,
	"",
	`Step ${index} of the rollout. The worker reads its settings at start-up, so each step is a deploy, not a flag. Nothing here changes the database, and every step can be undone by deploying the previous build.`,
	"",
	"1. Deploy and run the billing suite.",
	"2. Watch the retry rate for an hour.",
	"   - Under 2% is normal.",
	"   - Over 5% means the provider is struggling: pause the rollout.",
	"3. Move on to the next step.",
	"",
];

/** A long note with headings, lists, code, a table and a quote. */
export const longNote = [
	"# Billing retry rollout",
	"",
	"How the idempotent retry ships, what to watch and how to undo it. Written for whoever is on call this week.",
	"",
	"> If anything looks wrong, stop and ask in the billing channel before moving on.",
	"",
	...["Staging", "Canary", "Half of the traffic", "Everyone"].flatMap((title, index) => section(title, index + 1)),
	"## Settings",
	"",
	"| Setting | Default | What it does |",
	"| --- | --- | --- |",
	"| `RETRY_ATTEMPTS` | 3 | How many times a charge is tried in all |",
	"| `RETRY_BASE_MS` | 500 | The first wait; each later wait doubles |",
	"| `RETRY_ON` | `timeout,5xx` | Which failures are retried |",
	"| `IDEMPOTENCY_TTL_HOURS` | 24 | How long the provider remembers a key, which bounds how late a retry may be |",
	"",
	"## The change",
	"",
	"```ts",
	sourceFile,
	"```",
	"",
	"## Undoing it",
	"",
	"Deploy the previous build. Charges already retried keep their receipts; nothing needs cleaning up.",
	"",
	"- [x] Staging",
	"- [x] Canary",
	"- [ ] Half of the traffic",
	"- [ ] Everyone",
].join("\n");
