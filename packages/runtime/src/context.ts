/**
 * A session's skills and memory (#12, M1-BE4 read side), as the runtime gives them to a session.
 *
 * - Skills: on the session's first prompt the runtime pins the skills the session may see (`pinForSession`, so later
 *   revisions reach only new sessions), asks the host to mount them (`/skills`, the `skills` mount source of
 *   `@harbour/workspace/mounts`) and lists the profile's skills through the host's renderer. A session forked from
 *   another (`branching.fork`) keeps its source's listing, in the copied `harbour.context` entry, so on its first
 *   prompt it pins nothing: it has the host mount the revisions its source pinned, once (#210).
 * - Memory: on the same first prompt it recalls over the profile's memory scopes (each a memory space ID) with the
 *   prompt's text as the query, rendered by the memory implementation's `RecallRenderer`; and every session with
 *   memory scopes gets the `memory_search` and `memory_read` tools (`memoryCapabilities`).
 *
 * Harbour adds no prompt of its own (#143): the listing is whatever the host's `render` returns (nothing without one),
 * and the recall is the deployment's renderer's text. What the session was given is one `harbour.context` entry placed
 * before the first prompt, with the text as a user message for the model and the pins and recall manifest as data, so
 * a restart, a retried prompt and a reopened session see exactly what the session saw, and the record says which
 * skill revisions and concept versions those were.
 */
import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import type {
	AgentProfile,
	CallContext,
	CapabilityInvocation,
	HostToolDefinition,
	HostToolHandler,
	HostToolResult,
	JsonValue,
	Memory,
	RecallRequest,
	SessionRecord,
	SessionSkillPin,
	SkillListing,
	Skills,
	SkillVisibility,
} from "@harbour/contracts";
import {
	MEMORY_READ_CAPABILITY,
	MEMORY_SEARCH_CAPABILITY,
	memoryCapabilities,
	memoryCapabilityHandler,
} from "@harbour/memory";
import { sessionSkillListings } from "@harbour/skills/sources";

/** The entry kind a session's skills and recall are placed as, before its first prompt. */
export const HARBOUR_CONTEXT_ENTRY = "harbour.context";

/** The data of a `harbour.context` entry: what the session was given, by revision and version. */
export interface HarbourContextEntryData {
	readonly skills: readonly { readonly skillId: string; readonly revision: number }[];
	readonly listed: readonly string[];
	readonly recall: readonly {
		readonly spaceId: string;
		readonly conceptId: string;
		readonly version: number;
		readonly reason: string;
		readonly snapshotRef?: string;
	}[];
}

export interface SessionSkillsOptions {
	readonly store: Pick<Skills, "pinForSession" | "getRevision">;
	/**
	 * The host's rendering of the skills a session lists (those the profile names, by skill ID or name), such as
	 * `renderSkillListings` from `@harbour/skills/sources` for Pi's `<available_skills>` block. Without it no listing
	 * reaches the prompt: the skills are still pinned and mounted.
	 */
	readonly render?: (listings: readonly SkillListing[], session: SessionRecord) => string | undefined;
	/** Which skills a session may see. Default: its own project's (and its organisation's and the platform's). */
	readonly visibility?: (session: SessionRecord) => SkillVisibility | Promise<SkillVisibility>;
	/**
	 * Mounts the pinned skills where the listings point, such as `workspaces.remount` of the session's workspace at
	 * `/skills` with `{ source: "skills", ref: session.id, version: skillsMountVersion(pins) }`. Called once, on the
	 * first prompt, after pinning. For a forked session `pins` are the revisions its source pinned, under the fork's
	 * session ID, so mount exactly those (by `version`): the fork's listing names them.
	 */
	readonly mount?: (session: SessionRecord, pins: readonly SessionSkillPin[]) => Promise<void>;
	/** Where the listings say skills are mounted. Default `/skills`. */
	readonly mountRoot?: string;
}

export interface SessionMemoryOptions {
	readonly store: Pick<Memory, "recall" | "search" | "getConcept">;
	/** The memory spaces a session reads. Default: the profile's `memoryScopes`, each a space ID. */
	readonly spaces?: (profile: AgentProfile, session: SessionRecord) => readonly string[];
	/** The rest of the recall request (scopes, profile, limits) for a session. Default: the memory's defaults. */
	readonly recall?: (
		session: SessionRecord,
		profile: AgentProfile,
	) => Omit<RecallRequest, "spaceIds" | "query"> | undefined;
	/** What `stale` means to the memory tools. Default the runtime's clock. */
	readonly now?: () => number;
}

/** The agent of a session, acting in it: skills, memory and their access checks see the session's own agent. */
export function sessionAgent(record: SessionRecord): CallContext {
	return {
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: record.organisationId,
		projectId: record.projectId,
	};
}

/** The memory spaces a session reads. */
export function memorySpacesOf(
	memory: SessionMemoryOptions | undefined,
	profile: AgentProfile,
	record: SessionRecord,
): readonly string[] {
	if (memory === undefined) return [];
	return memory.spaces?.(profile, record) ?? profile.memoryScopes;
}

/** Pi's names of the memory tools. */
export const MEMORY_TOOL_NAMES: { readonly [capability: string]: string } = {
	[MEMORY_SEARCH_CAPABILITY]: "memory_search",
	[MEMORY_READ_CAPABILITY]: "memory_read",
};

/** The memory tools as host tool definitions, under their Pi names. */
export const memoryToolDefinitions: readonly HostToolDefinition[] = memoryCapabilities.map((capability) => ({
	name: MEMORY_TOOL_NAMES[capability.name] ?? capability.name,
	description: capability.description,
	inputSchema: capability.inputSchema,
	replay: capability.replay,
}));

function outputText(output: JsonValue): string {
	if (typeof output === "string") return output;
	if (typeof output === "object" && output !== null && !Array.isArray(output)) {
		const text = (output as { readonly [key: string]: JsonValue }).text;
		if (typeof text === "string") return text;
	}
	return JSON.stringify(output);
}

/** Serves the memory tools for a session from its memory, as the session's agent. */
export function memoryToolHandler(
	memory: SessionMemoryOptions,
	spaceIds: readonly string[],
	now: () => number,
): HostToolHandler {
	const capability = memoryCapabilityHandler({
		memory: memory.store as Memory,
		spaceIds: () => spaceIds,
		now: memory.now ?? now,
	});
	const byTool = new Map(Object.entries(MEMORY_TOOL_NAMES).map(([name, tool]) => [tool, name]));
	return async (call, signal): Promise<HostToolResult> => {
		const invocation: CapabilityInvocation = {
			callId: call.callId,
			capability: byTool.get(call.tool) ?? call.tool,
			version: "1",
			args: call.args,
			organisationId: call.organisationId,
			projectId: call.projectId,
			sessionId: call.sessionId,
			agentId: call.agentId,
		};
		const result = await capability(invocation, signal);
		return {
			output: outputText(result.output),
			...(result.isError === true ? { isError: true } : {}),
			structured: result.output,
		};
	};
}

/** The session's `harbour.context` entry in a view, if it has one. */
export function contextEntryOf(entries: readonly EntryRecord[]): EntryRecord | undefined {
	return entries.find((entry) => entry.kind === HARBOUR_CONTEXT_ENTRY);
}

/** The skill revisions a `harbour.context` entry records as pinned, if it records any. */
export function contextSkillsOf(
	entry: EntryRecord | undefined,
): readonly { readonly skillId: string; readonly revision: number }[] | undefined {
	const skills = (entry?.data as Partial<HarbourContextEntryData> | undefined)?.skills;
	if (!Array.isArray(skills)) return undefined;
	return skills.filter(
		(pin): pin is { skillId: string; revision: number } =>
			typeof pin?.skillId === "string" && typeof pin.revision === "number",
	);
}

/**
 * What a session is given before its first prompt: the skill listing and the recall, as one entry, or undefined when
 * there is nothing to give (no skills or memory configured, or none that apply).
 */
export async function sessionContextEntry(options: {
	readonly record: SessionRecord;
	readonly profile: AgentProfile;
	readonly query: string;
	readonly skills: SessionSkillsOptions | undefined;
	readonly memory: SessionMemoryOptions | undefined;
	readonly now: number;
}): Promise<EntryDraft | undefined> {
	const { record, profile, skills, memory } = options;
	const ctx = sessionAgent(record);
	const parts: string[] = [];
	let pins: readonly SessionSkillPin[] = [];
	let listed: readonly SkillListing[] = [];
	if (skills !== undefined && profile.skills.length > 0) {
		const visibility = (await skills.visibility?.(record)) ?? { projectId: record.projectId };
		const pinned = await sessionSkillListings(
			skills.store as Skills,
			ctx,
			record.id,
			visibility,
			skills.mountRoot ?? "/skills",
		);
		pins = pinned.pins;
		const wanted = new Set(profile.skills);
		listed = pinned.listings.filter((listing) => wanted.has(listing.skillId) || wanted.has(listing.name));
		await skills.mount?.(record, pins);
		const text = skills.render?.(listed, record);
		if (text !== undefined && text !== "") parts.push(text);
	}
	let manifest: HarbourContextEntryData["recall"] = [];
	const spaceIds = memorySpacesOf(memory, profile, record);
	if (memory !== undefined && spaceIds.length > 0) {
		const recall = await memory.store.recall(ctx, {
			...memory.recall?.(record, profile),
			spaceIds,
			query: options.query,
		});
		if (recall.text !== "") parts.push(recall.text);
		manifest = recall.manifest.map((entry) => ({
			spaceId: entry.spaceId,
			conceptId: entry.conceptId,
			version: entry.version,
			reason: entry.reason,
			...(entry.snapshotRef === undefined ? {} : { snapshotRef: entry.snapshotRef }),
		}));
	}
	if (pins.length === 0 && manifest.length === 0 && parts.length === 0) return undefined;
	const data: HarbourContextEntryData = {
		skills: pins.map((pin) => ({ skillId: pin.skillId, revision: pin.revision })),
		listed: listed.map((listing) => listing.skillId),
		recall: manifest,
	};
	const text = parts.join("\n\n");
	return {
		kind: HARBOUR_CONTEXT_ENTRY,
		data: data as unknown as JsonValue as EntryDraft["data"],
		...(text === "" ? {} : { model: [{ role: "user", content: [{ type: "text", text }], timestamp: options.now }] }),
	};
}
