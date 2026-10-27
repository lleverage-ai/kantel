/**
 * What a local Sal worker is given for a task, from Sal's own code: run with Bun against an installed Sal release.
 * It calls Sal's `planPiSetup` and `assembleLaunchContext` for the worker role, as Sal's supervisor does before a worker
 * starts (src/docket/workspace.ts), with the memory checkout pointed at a pinned sal-memory clone. Reads only: the
 * recall index is in memory, and nothing is written to Sal's state. Prints JSON on stdout.
 *
 *   bun examples/sal-worker/scripts/sal-local.ts --sal ~/.local/share/sal/current --config ~/.config/sal/sal.json \
 *     --memory <sal-memory clone> --task TASK-1 --brief <file with the brief text> --workspace <dir> [--now <ISO>]
 *
 * Nothing from Sal is copied into Harbour: this imports the release given on the command line. Each skill's `digest` is
 * Harbour's `skillDigest` over the skill directory's UTF-8 files (hidden entries and node_modules left out), so the two
 * sides compare whole packages, not only SKILL.md.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		sal: { type: "string" },
		config: { type: "string" },
		memory: { type: "string" },
		task: { type: "string" },
		brief: { type: "string" },
		workspace: { type: "string" },
		now: { type: "string" },
		// Sal's state directory: only where an isolated Pi setup would keep its agent directory.
		state: { type: "string", default: join(homedir(), ".local/state/sal") },
		concepts: { type: "string", default: "" },
	},
});
for (const key of ["sal", "config", "memory", "task", "brief", "workspace"] as const) {
	if (values[key] === undefined) throw new Error(`--${key} is required`);
}
const sal = resolve(values.sal!);
const { parseRuntimeConfig } = await import(join(sal, "src/runtime-config.ts"));
const { piLaunchRecord, planPiSetup } = await import(join(sal, "src/pi/setup.ts"));
const { assembleLaunchContext } = await import(join(sal, "src/context/assemble.ts"));
const pi = await import(join(sal, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"));

const configPath = resolve(values.config!);
const raw = JSON.parse(readFileSync(configPath, "utf8"));
// The pinned clone instead of the live checkout; nothing else changes.
raw.memory = { ...raw.memory, checkout: resolve(values.memory!) };
const config = parseRuntimeConfig(raw, { path: configPath });
const workspace = resolve(values.workspace!);
const setup = await planPiSetup(config.pi, "worker", {
	isolatedAgentDir: join(resolve(values.state!), "pi-agent"),
	cwd: workspace,
});
const now = values.now === undefined ? new Date() : new Date(values.now);
const launch = assembleLaunchContext(
	config,
	{
		role: "worker",
		workspace,
		task: values.task,
		concepts: values.concepts === "" ? [] : values.concepts!.split(","),
		recall: { message: readFileSync(resolve(values.brief!), "utf8") },
		pi: piLaunchRecord(setup),
		skillFiles: setup.skills.map((skill: { path: string }) => skill.path),
	},
	{ now: () => now },
);

const fatal = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Harbour's `skillDigest` over a skill directory: SHA-256 of `path\0content\0` for each UTF-8 file, sorted by path. */
function treeDigest(root: string): { digest: string; files: number } {
	const files: { path: string; content: string }[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir).sort()) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			const path = join(dir, entry);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory()) {
				if (readdirSync(path).includes("SKILL.md")) continue;
				walk(path);
			} else if (stat?.isFile()) {
				try {
					files.push({ path: relative(root, path).split(sep).join("/"), content: fatal.decode(readFileSync(path)) });
				} catch {
					// Binary: Harbour leaves it out of the package too.
				}
			}
		}
	};
	walk(root);
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const text = files.map((file) => `${file.path}\0${file.content}\0`).join("");
	return { digest: createHash("sha256").update(text).digest("hex"), files: files.length };
}

/** Sal's manifest lists a skill by its own name check; Pi loads it only when its YAML parses and has a description. */
const all = launch.skills.map((skill: { name: string; path: string; sha256: string }) => {
	let frontmatter: Record<string, unknown> = {};
	let problem: string | null = null;
	try {
		frontmatter = pi.parseFrontmatter(readFileSync(skill.path, "utf8")).frontmatter;
	} catch (error) {
		problem = `frontmatter: ${(error as Error).message.split("\n")[0]}`;
	}
	const description = frontmatter.description;
	if (problem === null && (typeof description !== "string" || description.trim() === "")) problem = "no description";
	return {
		name: skill.name,
		path: skill.path,
		sha256: skill.sha256,
		...treeDigest(dirname(skill.path)),
		description,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		problem,
	};
});
const skills = all.filter((skill: { problem: string | null }) => skill.problem === null);
const notLoaded = all
	.filter((skill: { problem: string | null }) => skill.problem !== null)
	.map((skill: { name: string; path: string; problem: string }) => ({
		name: skill.name,
		path: skill.path,
		problem: skill.problem,
	}));
const recall = launch.recall;
process.stdout.write(
	`${JSON.stringify(
		{
			memoryRevision: launch.manifest.memory.revision,
			selected: launch.manifest.memory.selected.map((concept: { id: string }) => concept.id),
			limits: recall.record.limits,
			recall: {
				concepts: recall.record.concepts.map((concept: { id: string; reason: string; sha256: string }) => ({
					id: concept.id,
					reason: concept.reason,
					sha256: concept.sha256,
				})),
				skipped: recall.record.skipped,
				profileDropped: recall.record.profileDropped ?? [],
				bytes: recall.record.bytes,
				text: recall.text,
			},
			skills,
			// In Sal's manifest, but Pi does not load them, so the worker never sees them.
			notLoaded,
			// Pi's own rendering of what the model is shown, from Pi's loader fields.
			skillsPrompt: pi
				.formatSkillsForPrompt(
					skills.map((skill: { name: string; description: string; path: string; disableModelInvocation: boolean }) => ({
						name: skill.name,
						description: skill.description,
						filePath: skill.path,
						disableModelInvocation: skill.disableModelInvocation,
					})),
				)
				.trimStart(),
		},
		null,
		"\t",
	)}\n`,
);
