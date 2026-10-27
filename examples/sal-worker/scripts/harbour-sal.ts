/**
 * What a Harbour Sal worker is given for each of a set of tasks: imports the sal-memory bundle and the skill sources at
 * pinned refs once, then starts one session per task. Prints JSON on stdout, one entry per task, in the same shape as
 * `sal-local.ts` (plus the pins). Run with Node 24:
 *
 *   node examples/sal-worker/scripts/harbour-sal.ts --config parity.json
 *
 * The config names the memory clone and commit, the skill sources in Pi's order and the tasks:
 *   { "memory": { "repo": "...", "ref": "<commit>" },
 *     "skills": [ { "id": "pi-agent-skills", "dir": "/home/me/.pi/agent/skills" },
 *                 { "id": "agent-toolkit", "git": "...", "paths": ["skills"], "ref": "<commit>", "mode": "agents" } ],
 *     "tasks": [ { "task": "TASK-1", "brief": "<file>" } ], "now": "<ISO>" }
 * Paths are absolute or relative to the config file (`~` is not expanded). `mode` is Pi's search mode for the root
 * (default `pi`): `agents` for what Pi finds under `~/.agents/skills`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type DiscoveryMode, directorySkillSource, gitSkillSource, type SalSkillSource } from "../src/skill-sources.ts";
import { prepareSalWorker, type SalRecallLimits, startSalWorkerSession } from "../src/worker.ts";

interface ParityConfig {
	readonly memory: { readonly repo: string; readonly ref: string; readonly bundleDir?: string };
	readonly skills: readonly (
		| {
				readonly id: string;
				readonly git: string;
				readonly paths: readonly string[];
				readonly ref?: string;
				readonly mode?: DiscoveryMode;
		  }
		| { readonly id: string; readonly dir: string; readonly ref?: string; readonly mode?: DiscoveryMode }
	)[];
	readonly exclude?: readonly string[];
	readonly limits?: SalRecallLimits;
	readonly tasks: readonly { readonly task: string; readonly brief: string; readonly concepts?: readonly string[] }[];
	readonly now?: string;
}

const { values } = parseArgs({ options: { config: { type: "string" } } });
if (values.config === undefined) throw new Error("--config is required");
const configPath = resolve(values.config);
const base = dirname(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8")) as ParityConfig;
const now = config.now === undefined ? Date.now() : Date.parse(config.now);

const sources = config.skills.map((entry): { source: SalSkillSource; ref?: string } => {
	const source =
		"git" in entry
			? gitSkillSource({ id: entry.id, repo: resolve(base, entry.git), paths: entry.paths, mode: entry.mode ?? "pi" })
			: directorySkillSource({ id: entry.id, root: resolve(base, entry.dir), mode: entry.mode ?? "pi" });
	return entry.ref === undefined ? { source } : { source, ref: entry.ref };
});
const host = await prepareSalWorker({
	organisationId: "tom",
	memory: { ...config.memory, repo: resolve(base, config.memory.repo) },
	skills: sources,
	...(config.exclude === undefined ? {} : { exclude: config.exclude }),
	...(config.limits === undefined ? {} : { limits: config.limits }),
	now: () => now,
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const results = [];
for (const [index, entry] of config.tasks.entries()) {
	const session = await startSalWorkerSession(host, {
		sessionId: `parity-${index + 1}`,
		task: entry.task,
		brief: readFileSync(resolve(base, entry.brief), "utf8"),
		...(entry.concepts === undefined ? {} : { concepts: entry.concepts }),
	});
	results.push({
		task: entry.task,
		memoryRevision: host.space.snapshot?.ref ?? null,
		recall: {
			concepts: session.recall.manifest.map((item) => ({
				id: item.conceptId,
				reason: item.reason === "search" ? "match" : item.reason,
				version: item.version,
				snapshotRef: item.snapshotRef,
			})),
			skipped: session.recall.skipped.map((item) => ({ id: item.conceptId, reason: item.reason })),
			profileDropped: session.recall.profileOmitted,
			bytes: Buffer.byteLength(session.recall.text),
			text: session.recall.text,
		},
		skills: await Promise.all(
			session.revisions.map(async (revision) => ({
				name: revision.name,
				revision: revision.revision,
				source: revision.source,
				sha256: sha256(await host.skills.readFile(host.ctx, revision.skillId, revision.revision, "SKILL.md")),
				digest: revision.digest,
				files: revision.files.length,
			})),
		),
		skillsPrompt: session.skillsPrompt,
		pins: session.pins,
	});
}
process.stdout.write(
	`${JSON.stringify(
		{
			pinned: host.pinned,
			refusedConcepts: host.bundle.refused,
			conceptWarnings: host.bundle.warnings,
			published: {
				revisions: host.published.revisions.length,
				refused: host.published.refused,
				shadowed: host.published.shadowed,
				excluded: host.published.excluded,
			},
			problems: sources.flatMap(({ source }) =>
				source.last.problems.map((problem) => ({ source: source.id, ...problem })),
			),
			tasks: results,
		},
		null,
		"\t",
	)}\n`,
);
