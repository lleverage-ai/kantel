// What New template and Edit hold while a person types: one draft, read from a template and saved back as the input
// the API takes. Variables are rows of a name and a value, each value kept exactly as read or typed (line breaks,
// spaces at either end, `=` and quotes, or empty), so saving a template whose variables nobody touched sends them as
// they were, and editing one variable leaves the others alone. The base is one the deployment publishes: an image, a
// channel of it to follow, or a digest from that channel's history to pin. The image is that base, a Dockerfile built
// on it (`FROM $KANTEL_BASE`), or an image reference; the Dockerfile and reference are kept as typed while another kind
// is picked, so switching back loses nothing, and only the picked kind's is saved.

import type {
	EgressGrant,
	Template,
	TemplateBaseChannel,
	TemplateChange,
	TemplateImage,
	TemplateSpec,
} from "./compute-model.ts";
import { variableNameProblem } from "./egress-rules.ts";

/** The base a new template follows, and the one the API falls back to: published or not, every host has it. */
export const DEFAULT_TEMPLATE_BASE = { image: "kantel/sandbox", channel: "stable" } as const;

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * An image reference as the API takes one (`TEMPLATE_IMAGE_REF_PATTERN`): `[registry[:port]/]repository[:tag][@digest]`,
 * its repository lower case.
 */
const IMAGE_REF =
	/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

/** A Dockerfile a new one starts from: the template's base, then what it adds. */
export const DOCKERFILE_EXAMPLE =
	"ARG KANTEL_BASE\nFROM $KANTEL_BASE\nRUN apt-get update && apt-get install -y --no-install-recommends ripgrep jq\n";

/** The longest Dockerfile the API takes. */
const MAX_DOCKERFILE = 65_536;

/** One variable's row. `key` keeps a row's inputs with it as rows above it are added or removed. */
export interface TemplateVariableDraft {
	readonly key: number;
	readonly name: string;
	/** As typed: it may hold line breaks. */
	readonly value: string;
}

export interface TemplateDraft {
	readonly name: string;
	readonly description: string;
	/** What its machines boot: the base, a Dockerfile on it, or an image reference. */
	readonly imageKind: TemplateImage["kind"];
	readonly dockerfile: string;
	readonly imageRef: string;
	readonly baseImage: string;
	readonly baseMode: "channel" | "digest";
	/** The channel followed, or the one whose history the pinned digest is picked from. */
	readonly channel: string;
	readonly digest: string;
	readonly vcpus: string;
	readonly memory: string;
	readonly variables: readonly TemplateVariableDraft[];
	readonly setup: string;
	/** Allowed hosts, comma separated: the template's allow-only grants with no methods or paths. */
	readonly hosts: string;
}

export interface TemplateEditorInput {
	readonly name: string;
	readonly description: string;
	readonly spec: TemplateSpec;
}

let variableKeys = 0;

/** A variable's row, empty for Add variable. */
export function templateVariableDraft(name = "", value = ""): TemplateVariableDraft {
	variableKeys += 1;
	return { key: variableKeys, name, value };
}

const simpleGrant = (grant: EgressGrant) =>
	grant.action === "allow" && grant.methods.length === 0 && grant.paths.length === 0;

/** The editor's draft of `template`, or of a new one: one empty variable row when it has none. */
export function templateDraft(template?: Template): TemplateDraft {
	const spec = template?.spec;
	const env = Object.entries(spec?.env ?? {});
	return {
		name: template?.name ?? "",
		description: template?.description ?? "",
		imageKind: spec?.image.kind ?? "kantel-base",
		dockerfile: spec?.image.kind === "dockerfile" ? spec.image.dockerfile : "",
		imageRef: spec?.image.kind === "image" ? spec.image.ref : "",
		baseImage: spec?.base.image ?? DEFAULT_TEMPLATE_BASE.image,
		baseMode: spec?.base.digest === undefined ? "channel" : "digest",
		channel: spec?.base.channel ?? DEFAULT_TEMPLATE_BASE.channel,
		digest: spec?.base.digest ?? "",
		vcpus: String(spec?.vcpus ?? 2),
		memory: String(spec?.memoryMb ?? 4096),
		variables:
			env.length === 0 ? [templateVariableDraft()] : env.map(([name, value]) => templateVariableDraft(name, value)),
		setup: spec?.setup ?? "",
		hosts: (spec?.grants ?? [])
			.filter(simpleGrant)
			.map((grant) => grant.host)
			.join(", "),
	};
}

/** What the editor's base fields offer for a draft, from the channels the deployment publishes. */
export interface TemplateBaseChoices {
	/** Every published image, the default one even before it publishes, and the draft's own. */
	readonly images: readonly string[];
	/** The draft's image's published channels, `stable` for the default image, and the one shown. */
	readonly channels: readonly string[];
	/**
	 * The channel the base fields show: the draft's, or, for a pinned digest the draft's channel never published, the
	 * first of the image's channels that did.
	 */
	readonly channel: string;
	/** What it publishes now; empty for a channel that hasn't published yet. */
	readonly current: string;
	/** Its digests to pin, newest first, with the draft's own; `publishedAt` absent for one it never published. */
	readonly digests: readonly { readonly digest: string; readonly publishedAt?: number }[];
}

const withFirst = (list: readonly string[], first: string): string[] =>
	first === "" || list.includes(first) ? [...list] : [first, ...list];

/** The base images, channels and digests the editor offers a draft: only what `bases` publishes, and what it holds. */
export function templateBaseChoices(draft: TemplateDraft, bases: readonly TemplateBaseChannel[]): TemplateBaseChoices {
	const pinned = draft.baseMode === "digest" && draft.digest !== "";
	const images = withFirst(
		withFirst([...new Set(bases.map((base) => base.image))], DEFAULT_TEMPLATE_BASE.image),
		draft.baseImage,
	);
	const own = bases.filter((base) => base.image === draft.baseImage);
	const holds = (base: TemplateBaseChannel) => base.history.some((release) => release.digest === draft.digest);
	const named = own.find((base) => base.channel === draft.channel);
	const shown = pinned && (named === undefined || !holds(named)) ? (own.find(holds) ?? named) : named;
	const channel = shown?.channel ?? draft.channel;
	const published = own.map((base) => base.channel);
	const channels = withFirst(
		draft.baseImage === DEFAULT_TEMPLATE_BASE.image ? withFirst(published, DEFAULT_TEMPLATE_BASE.channel) : published,
		channel,
	);
	const history = shown?.history ?? [];
	const digests =
		pinned && !history.some((release) => release.digest === draft.digest)
			? [{ digest: draft.digest }, ...history]
			: history;
	return { images, channels, channel, current: shown?.digest ?? "", digests };
}

/**
 * The draft with another base image, channel or way of following it picked. Another image follows its `stable` channel,
 * or its first; pinned, another image or channel pins that channel's current digest. Pinning keeps a digest already
 * picked; following shows the channel the pinned digest came from.
 */
export function templateBasePicked(
	draft: TemplateDraft,
	pick: { readonly image: string } | { readonly channel: string } | { readonly mode: TemplateDraft["baseMode"] },
	bases: readonly TemplateBaseChannel[],
): TemplateDraft {
	const current = (next: TemplateDraft): TemplateDraft =>
		next.baseMode === "digest" ? { ...next, digest: templateBaseChoices(next, bases).current } : next;
	if ("image" in pick) {
		const { channels } = templateBaseChoices({ ...draft, baseImage: pick.image, channel: "", digest: "" }, bases);
		const channel = channels.includes(DEFAULT_TEMPLATE_BASE.channel)
			? DEFAULT_TEMPLATE_BASE.channel
			: (channels[0] ?? "");
		return current({ ...draft, baseImage: pick.image, channel, digest: "" });
	}
	if ("channel" in pick) return current({ ...draft, channel: pick.channel, digest: "" });
	const moved = { ...draft, baseMode: pick.mode, channel: templateBaseChoices(draft, bases).channel };
	return moved.baseMode === "digest" && moved.digest === "" ? current(moved) : moved;
}

/**
 * What's wrong with each variable row's name, as the API checks it (letters, digits and underscores, not one Kantel
 * sets), or a name an earlier row has. A row with neither a name nor a value is left out, so it's never wrong.
 */
export function templateVariableProblems(variables: readonly TemplateVariableDraft[]): readonly (string | undefined)[] {
	const seen = new Set<string>();
	return variables.map(({ name, value }) => {
		if (name === "" && value === "") return undefined;
		const problem = variableNameProblem(name) ?? (seen.has(name) ? `There's already a ${name}.` : undefined);
		seen.add(name);
		return problem;
	});
}

/** The variables a draft's rows save: each name to its value exactly as typed, rows with neither left out. */
export function templateEnv(variables: readonly TemplateVariableDraft[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const { name, value } of variables) {
		if (name === "" && value === "") continue;
		env[name] = value;
	}
	return env;
}

/** What's wrong with a draft, field by field, and whether it can be saved. */
export function templateDraftProblems(draft: TemplateDraft): {
	readonly name?: string;
	readonly dockerfile?: string;
	readonly imageRef?: string;
	readonly variables: readonly (string | undefined)[];
	readonly ready: boolean;
} {
	const name = draft.name === "" || NAME.test(draft.name) ? undefined : "Use lowercase letters, digits and dashes.";
	const variables = templateVariableProblems(draft.variables);
	const ref = draft.imageRef.trim();
	const dockerfile =
		draft.imageKind !== "dockerfile" || draft.dockerfile.length <= MAX_DOCKERFILE
			? undefined
			: `At most ${MAX_DOCKERFILE.toLocaleString("en-GB")} characters.`;
	const imageRef =
		draft.imageKind !== "image" || ref === "" || (IMAGE_REF.test(ref) && ref.length <= 512)
			? undefined
			: "Not an image reference: registry/repository:tag or @sha256:…, the repository in lowercase.";
	const imageReady =
		draft.imageKind === "dockerfile"
			? draft.dockerfile.trim() !== "" && dockerfile === undefined
			: draft.imageKind === "image"
				? ref !== "" && imageRef === undefined
				: true;
	const ready =
		draft.name !== "" &&
		name === undefined &&
		variables.every((problem) => problem === undefined) &&
		imageReady &&
		// An image reference doesn't use the base, whose fields it hides: it saves the default when they're incomplete.
		(draft.imageKind === "image" || baseComplete(draft));
	return {
		...(name === undefined ? {} : { name }),
		...(dockerfile === undefined ? {} : { dockerfile }),
		...(imageRef === undefined ? {} : { imageRef }),
		variables,
		ready,
	};
}

/** The draft's base fields name a whole base: an image, and the channel it follows or the digest it pins. */
const baseComplete = (draft: TemplateDraft): boolean =>
	draft.baseImage !== "" && (draft.baseMode === "channel" ? draft.channel !== "" : draft.digest !== "");

/**
 * The base a draft saves: its fields', or, for an image reference (which hides them, and doesn't use the base) whose
 * fields are incomplete, the default, so a base picked half-way never keeps it from saving. The fields keep what was
 * typed, for switching back.
 */
function templateBaseOf(draft: TemplateDraft): TemplateSpec["base"] {
	if (draft.imageKind === "image" && !baseComplete(draft)) return { ...DEFAULT_TEMPLATE_BASE };
	return draft.baseMode === "channel"
		? { image: draft.baseImage, channel: draft.channel }
		: { image: draft.baseImage, digest: draft.digest };
}

/** The image a draft saves: only the picked kind's Dockerfile or reference. */
function templateImageOf(draft: TemplateDraft): TemplateImage {
	if (draft.imageKind === "dockerfile") return { kind: "dockerfile", dockerfile: draft.dockerfile };
	if (draft.imageKind === "image") return { kind: "image", ref: draft.imageRef.trim() };
	return { kind: "kantel-base" };
}

let grantCount = 0;

/** A template's allow-only hosts from a comma or space separated list, keeping its other grants as they are. */
function grantsFrom(text: string, kept: readonly EgressGrant[]): EgressGrant[] {
	const hosts = text
		.split(/[\s,]+/)
		.map((host) => host.trim().toLowerCase())
		.filter((host) => host !== "");
	const others = kept.filter((grant) => !simpleGrant(grant));
	const existing = new Map(kept.filter(simpleGrant).map((grant) => [grant.host, grant]));
	return [
		...[...new Set(hosts)].map((host) => {
			grantCount += 1;
			return (
				existing.get(host) ?? { id: `grt_new_${grantCount}`, action: "allow" as const, host, methods: [], paths: [] }
			);
		}),
		...others,
	];
}

/** What saving a draft sends: `kept` are the template's grants as read, so those the hosts field doesn't show stay. */
export function templateEditorInput(draft: TemplateDraft, kept: readonly EgressGrant[]): TemplateEditorInput {
	return {
		name: draft.name,
		description: draft.description.trim(),
		spec: {
			image: templateImageOf(draft),
			base: templateBaseOf(draft),
			vcpus: Number(draft.vcpus),
			memoryMb: Number(draft.memory),
			env: templateEnv(draft.variables),
			...(draft.setup.trim() === "" ? {} : { setup: draft.setup }),
			grants: grantsFrom(draft.hosts, kept),
		},
	};
}

/**
 * What saving Edit's draft sends: only what the person changed from the template as Edit read it. A definition, name
 * or description left as it was isn't sent, so it can't put back an older one over a change made meanwhile, and a
 * name or description alone makes no new version.
 */
export function templateEditorChange(template: Template, draft: TemplateDraft): TemplateChange {
	const kept = template.spec.grants;
	const read = templateEditorInput(templateDraft(template), kept);
	const typed = templateEditorInput(draft, kept);
	return {
		...(typed.name === read.name ? {} : { name: typed.name }),
		...(typed.description === read.description ? {} : { description: typed.description }),
		...(JSON.stringify(typed.spec) === JSON.stringify(read.spec) ? {} : { spec: typed.spec }),
	};
}
