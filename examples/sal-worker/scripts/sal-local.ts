/**
 * What a local Sal worker is given for a task, from Sal's own code: run with Bun against an installed Sal release.
 * It calls Sal's `planPiSetup` and `assembleLaunchContext` for the worker role, as Sal's supervisor does before a worker
 * starts (src/docket/workspace.ts), with the memory checkout pointed at a pinned sal-memory clone. Reads only: the
 * recall index is in memory, and nothing is written to Sal's state. Prints JSON on stdout.
 *
 *   bun examples/sal-worker/scripts/sal-local.ts --sal ~/.local/share/sal/current --config ~/.config/sal/sal.json \
 *     --memory <sal-memory clone> --task TASK-1 --brief <file with the brief text> --workspace <dir> [--now <ISO>]
 *
 * The skills are what Pi itself loads for the worker: Pi's `loadSkills` over the paths Sal's runner hands it
 * (`piRunnerInputs`), filtered by the role's names and exclusions as the runner filters them. Sal's launch manifest is
 * reported beside them, since it can list a skill Pi does not load.
 *
 * Nothing from Sal is copied into Harbour: this imports the release given on the command line. Each skill's `digest` is
 * Harbour's `skillDigest` over the skill directory's UTF-8 files (hidden entries and node_modules left out; a skill
 * from a plain `.md` file is that file as `SKILL.md`), so the two sides compare whole packages, not only SKILL.md.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
const { piLaunchRecord, piRunnerInputs, planPiSetup } = await import(join(sal, "src/pi/setup.ts"));
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
const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
/** Harbour's `skillDigest` over a skill: SHA-256 of `path\0content\0` for each UTF-8 file, sorted by path. */
function treeDigest(file: string): { digest: string; files: number } {
	const files: { path: string; content: string }[] = [];
	if (basename(file) !== "SKILL.md") {
		const content = lenient.decode(readFileSync(file));
		return { digest: createHash("sha256").update(`SKILL.md\0${content}\0`).digest("hex"), files: 1 };
	}
	const root = dirname(file);
	// A directory already open further up is a symlink loop: not entered again.
	const walk = (dir: string, open: ReadonlySet<string> = new Set()) => {
		const real = realpathSync(dir);
		if (open.has(real)) return;
		const inside = new Set([...open, real]);
		for (const entry of readdirSync(dir).sort()) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			const path = join(dir, entry);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(path, { throwIfNoEntry: false });
			} catch {
				// A link Pi cannot follow (a loop): skipped, as the Harbour side skips it.
				continue;
			}
			if (stat?.isDirectory()) walk(path, inside);
			else if (path === file) {
				files.push({ path: "SKILL.md", content: lenient.decode(readFileSync(path)) });
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

/** What Pi loads for the worker, as Sal's runner asks: its paths, then the role's names and exclusions. */
const inputs = piRunnerInputs(setup, config);
const loaded = pi.loadSkills({
	cwd: workspace,
	agentDir: setup.agentDir,
	skillPaths: inputs.skillPaths,
	includeDefaults: false,
});
const allowed = inputs.skillNames === undefined ? null : new Set<string>(inputs.skillNames);
const excluded = new Set<string>(inputs.skillExclude ?? []);
type PiSkill = { name: string; description: string; filePath: string; disableModelInvocation: boolean };
const kept = (loaded.skills as PiSkill[]).filter(
	(skill) => (allowed === null || allowed.has(skill.name)) && !excluded.has(skill.name),
);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const skills = kept.map((skill) => ({
	name: skill.name,
	path: skill.filePath,
	sha256: sha256(skill.filePath),
	...treeDigest(skill.filePath),
	description: skill.description,
	disableModelInvocation: skill.disableModelInvocation,
}));
const loadedPaths = new Set((loaded.skills as PiSkill[]).map((skill) => resolve(skill.filePath)));
/** In Sal's manifest, but Pi does not load them, so the worker never sees them; with Pi's reason where it gives one. */
const notLoaded = launch.skills
	.filter((skill: { name: string; path: string }) => !excluded.has(skill.name) && !loadedPaths.has(resolve(skill.path)))
	.map((skill: { name: string; path: string }) => ({
		name: skill.name,
		path: skill.path,
		problem:
			(loaded.diagnostics as { message: string; path?: string }[])
				.find((diagnostic) => diagnostic.path !== undefined && resolve(diagnostic.path) === resolve(skill.path))
				?.message.split("\n")[0] ?? "not loaded by Pi",
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
			skillsPrompt: pi.formatSkillsForPrompt(kept).trimStart(),
		},
		null,
		"\t",
	)}\n`,
);
