/**
 * A Sal worker's skills and memory on Harbour: Sal's memory bundle imported as a snapshot at a pinned commit, its skill
 * sources published at pinned refs, and per session the pinned skill listing and the recall a Sal worker gets for its
 * brief. Uses the in-memory reference stores; a target passes its own `Memory` and `Skills`.
 */
import type {
	CallContext,
	Memory,
	MemorySpace,
	MountSource,
	OwnerRef,
	Recall,
	SessionSkillPin,
	SkillListing,
	SkillRevision,
	Skills,
} from "@harbour/contracts";
import { createMemoryMemory } from "@harbour/memory/memory";
import { createMemorySkills } from "@harbour/skills/memory";
import { createSkillsMountSource } from "@harbour/skills/mount";
import { renderSkillListings, sessionSkillListings, syncSkillSources } from "@harbour/skills/sources";
import { readTree, resolveCommit } from "./git.ts";
import { type OkfSnapshot, okfSnapshot, salExtension } from "./okf.ts";
import { salRecallRenderer } from "./recall-renderer.ts";
import { type SalSkillSource, salSkillExtensions } from "./skill-sources.ts";

/** The skills Sal leaves out of a worker's set (tvdavies/sal `src/worker/sandbox.ts`
 * `WORKER_EXCLUDED_SKILLS`): they act as the owner or need tools a worker lacks. */
export const SAL_WORKER_EXCLUDED_SKILLS: readonly string[] = [
	"slack",
	"gog",
	"meeting-notes",
	"lleverage-browser-access",
	"chrome-browser",
	"built-in-browser",
	"computer-use",
];

/** Sal's default `memory.maxSelectedConcepts`. */
export const SAL_MAX_SELECTED_CONCEPTS = 5;

/** Sal's recall limits for a worker, unless its configuration sets others. */
export interface SalRecallLimits {
	readonly maxConcepts: number;
	readonly maxBytes: number;
	readonly maxProfileConcepts: number | null;
	readonly maxProfileBytes: number;
}

export const SAL_DEFAULT_RECALL_LIMITS: SalRecallLimits = {
	maxConcepts: 5,
	maxBytes: 4096,
	maxProfileConcepts: null,
	maxProfileBytes: 24_576,
};

export interface SalWorkerInput {
	readonly organisationId: string;
	/** The sal-memory clone, the commit to pin and the bundle directory in it (Sal's `memory.bundleDir`). */
	readonly memory: { readonly repo: string; readonly ref: string; readonly bundleDir?: string };
	/** In Pi's order: on a name more than one offers, the first wins. Each with the ref to pin, or its current one. */
	readonly skills: readonly { readonly source: SalSkillSource; readonly ref?: string }[];
	readonly exclude?: readonly string[];
	readonly limits?: SalRecallLimits;
	/** The sandbox path skills are mounted at. */
	readonly mountRoot?: string;
	readonly now?: () => number;
	/** Bring your own stores; default the in-memory reference ones. */
	readonly stores?: { readonly memory: Memory; readonly skills: Skills };
}

export interface SalWorkerHost {
	readonly memory: Memory;
	readonly skills: Skills;
	readonly space: MemorySpace;
	readonly bundle: OkfSnapshot;
	/** Every source and the ref it was published at. */
	readonly pinned: readonly { readonly sourceId: string; readonly ref: string }[];
	readonly published: Awaited<ReturnType<typeof syncSkillSources>>;
	readonly limits: SalRecallLimits;
	readonly ctx: CallContext;
	/** The `skills` mount source to give the workspaces: a session mounts `/skills` with its session ID as the ref. */
	readonly skillsMount: MountSource;
}

/** As Sal reads a concept file (Node's `utf8`): a bad byte becomes U+FFFD and fails only that concept's parse. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Imports the bundle and publishes the skills, each at its pinned ref. */
export async function prepareSalWorker(input: SalWorkerInput): Promise<SalWorkerHost> {
	const now = input.now ?? Date.now;
	const clock = { now };
	const memory = input.stores?.memory ?? createMemoryMemory({ clock, renderer: salRecallRenderer() });
	const skills =
		input.stores?.skills ??
		createMemorySkills({ clock, ...(input.mountRoot === undefined ? {} : { mountRoot: input.mountRoot }) });
	const ctx: CallContext = {
		actor: { kind: "service", serviceId: "sal-worker" },
		organisationId: input.organisationId,
	};
	const owner: OwnerRef = { kind: "organisation", organisationId: input.organisationId };

	const commit = resolveCommit(input.memory.repo, input.memory.ref);
	const bundleDir = (input.memory.bundleDir ?? "knowledge").replace(/\/+$/, "");
	const files = readTree(input.memory.repo, commit, [bundleDir])
		.files.filter((file) => file.path.endsWith(".md"))
		.map((file) => ({ path: file.path.slice(bundleDir.length + 1), text: decoder.decode(file.bytes) }));
	const bundle = okfSnapshot(files, { sourceId: "sal-memory", ref: commit });
	const space = await memory.createSpace(ctx, { owner, name: "Sal memory" });
	const imported = await memory.importSnapshot(ctx, space.id, bundle.snapshot);

	const sources = input.skills.map(({ source, ref }) => ({ source, ref: ref ?? source.pin() }));
	const bySource = new Map(input.skills.map(({ source }) => [source.id, source]));
	const published = await syncSkillSources(skills, ctx, {
		sources,
		owner,
		exclude: input.exclude ?? SAL_WORKER_EXCLUDED_SKILLS,
		extensions: ({ name, sourceId }) => {
			const found = bySource.get(sourceId)?.last.skills.find((skill) => skill.name === name);
			return found === undefined ? undefined : salSkillExtensions(found);
		},
	});
	return {
		memory,
		skills,
		space: imported,
		bundle,
		pinned: [
			{ sourceId: "sal-memory", ref: commit },
			...sources.map(({ source, ref }) => ({ sourceId: source.id, ref })),
		],
		published,
		limits: input.limits ?? SAL_DEFAULT_RECALL_LIMITS,
		ctx,
		skillsMount: createSkillsMountSource(skills, { visibility: () => ({}) }),
	};
}

export interface SalWorkerSession {
	readonly pins: readonly SessionSkillPin[];
	readonly listings: readonly SkillListing[];
	readonly revisions: readonly SkillRevision[];
	/** Pi's `<available_skills>` block: the listings less those Pi keeps out of the prompt. */
	readonly skillsPrompt: string;
	readonly recall: Recall;
}

/** What one worker session is given: its pinned skills and the recall for its brief. */
export async function startSalWorkerSession(
	host: SalWorkerHost,
	input: {
		readonly sessionId: string;
		/** The Docket task, such as `TASK-12`: its exceptions are recalled. */
		readonly task?: string;
		readonly brief: string;
		/**
		 * Concepts the brief names (Sal's `concepts`). Sal selects them, and their exceptions for this task, ahead of recall,
		 * so none of those is recalled again.
		 */
		readonly concepts?: readonly string[];
		/** Sal's `memory.maxSelectedConcepts`: how many named concepts and exceptions it selects (default 5). */
		readonly maxSelected?: number;
	},
): Promise<SalWorkerSession> {
	const { pins, listings, revisions } = await sessionSkillListings(host.skills, host.ctx, input.sessionId, {});
	const shown = listings.filter((_, index) => {
		const sal = revisions[index]?.extensions?.sal as { disableModelInvocation?: boolean } | undefined;
		return sal?.disableModelInvocation !== true;
	});
	const task = input.task;
	const jobs =
		task === undefined
			? []
			: task.startsWith("docket:")
				? [task, task.slice("docket:".length)]
				: [task, `docket:${task}`];
	const recall = await host.memory.recall(host.ctx, {
		spaceIds: [host.space.id],
		query: input.brief,
		scopes: { projects: host.bundle.projects, jobs },
		profile: host.bundle.profile,
		exclude: selectedConcepts(
			host.bundle,
			input.concepts ?? [],
			task ?? null,
			input.maxSelected ?? SAL_MAX_SELECTED_CONCEPTS,
		),
		maxConcepts: host.limits.maxConcepts,
		maxBytes: host.limits.maxBytes,
		...(host.limits.maxProfileConcepts === null ? {} : { maxProfileConcepts: host.limits.maxProfileConcepts }),
		maxProfileBytes: host.limits.maxProfileBytes,
	});
	return { pins, listings, revisions, skillsPrompt: renderSkillListings(shown), recall };
}

/** Sal's `jobMatches`: an exception's `applies_to` names the task, with or without `docket:`. */
function jobMatches(appliesTo: string | null, job: string): boolean {
	if (appliesTo === null) return false;
	return appliesTo === job || appliesTo === `docket:${job}` || `docket:${appliesTo}` === job;
}

/**
 * The concepts Sal selects for the brief's named ones (tvdavies/sal `src/context/assemble.ts`): each that exists, is
 * active and is not another job's exception, with the exceptions to it for this task, up to `maxSelected` in all.
 */
export function selectedConcepts(
	bundle: OkfSnapshot,
	requested: readonly string[],
	task: string | null,
	maxSelected: number,
): string[] {
	const byId = new Map(bundle.snapshot.concepts.map((concept) => [concept.id, concept]));
	const selected: string[] = [];
	const add = (id: string): boolean => {
		if (selected.includes(id)) return true;
		if (selected.length >= maxSelected) return false;
		selected.push(id);
		return true;
	};
	for (const id of new Set(requested)) {
		const concept = byId.get(id);
		if (concept === undefined || concept.status !== "active") continue;
		const appliesTo = salExtension(concept)?.appliesTo ?? null;
		if (appliesTo !== null && (task === null || !jobMatches(appliesTo, task))) continue;
		if (!add(id)) continue;
		if (task === null) continue;
		for (const exception of bundle.snapshot.concepts) {
			const sal = salExtension(exception);
			if (exception.status === "active" && exception.overrides === id && jobMatches(sal?.appliesTo ?? null, task)) {
				add(exception.id);
			}
		}
	}
	return selected;
}
