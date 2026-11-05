/**
 * Templates (experimental, `KANTEL_TEMPLATES=experimental`): how a platform defines a microVM profile, versioned, and
 * the template snapshots built from each version, a cache of machines booted once with their setup run.
 *
 * A template snapshot is keyed by its cache key (`templateCacheKey`): the template's version, its base's digest, and the
 * guest kernel, Firecracker, vCPUs and memory it was built for. Its vCPUs and memory are the template's resources, the
 * shape its sandboxes ask for by default, which a fresh boot from it gets too. `reconcile` wants one per distinct runtime
 * among the hosts the template's account may use that can make that shape, builds each missing one in the background,
 * marks one no longer wanted `stale` (still used while its replacement builds) and discards it once a newer ready one
 * of the template's current rebuild exists for its runtime or host. A failed build isn't tried again until its key
 * changes or the template is rebuilt; one its host had no room for is tried again by the next reconcile. A create from a
 * template asks for one shape (`sandboxMachine`: the template's resources, or the create's own `resources` or size),
 * whichever way it starts: from its newest ready (or stale) snapshot for the same version, runtime, vCPUs and memory, on
 * the host that holds it (or, that host full, booting fresh on another), and otherwise booting fresh on a host that
 * can, where the backend boots the template's base image and runs its setup in the new machine. A shape other than the
 * template's has no snapshot, so it boots fresh.
 *
 * A template's image is Kantel's base (`kantel-base`) by default: a channel of a base image the deployment's
 * super-admin published (`publishTemplateBase`), or a digest one of that image's channels published, or the default
 * channel unpublished (each host's own sandbox image), which hosts pull by digest from their operator's registry and the
 * setup script customises in the machine. Or it is a custom image: a `dockerfile` (no build context; `FROM
 * $KANTEL_BASE` is the base) or an `image` reference. Only a host that builds custom images (`customImages`) builds
 * one, in an isolated build microVM whose sole way out is the sandbox egress proxy, under the template's grants and its
 * operator's registries, never on the host's Docker; it keeps the root filesystem made, and boots it for the
 * template's sandboxes there, which no other host can. Its key has its source (the Dockerfile's digest, or the
 * reference) from the claim, and the image's digest once the build named it (`key.imageDigest`, which `keyHash` then
 * covers; a reconcile wants the entry by the hash it was claimed under, `claimHash`). An entry is built once: a new
 * digest comes only with a new entry, of a new version or a rebuild, which builds or pulls the image again.
 *
 * Deleting a template, or its account, retires it: it is marked retired first (gone to every caller and build from
 * then), then every cache entry is thrown away and its versions go, and its record last, so a sweep finishes a
 * retirement cut short; a build still running when it went throws its result away.
 *
 * An entry's snapshot ID and host are its bytes' name: set when it is claimed, never changed once its build is asked
 * of its host, and never given to another build (a build whose gateway died is thrown away, and its key built again
 * as a new entry, `claim`). Thrown away, an entry is kept `deleting` until its host has deleted its bytes (by `ref`, or
 * by its ID when its build never answered, which may have made them all the same), and every sweep tries again
 * meanwhile, whether its template is still there or not. That is the one way any entry's bytes go, and the one way an
 * entry's record goes, once its bytes have and its template has too (`cleanUp`).
 *
 * Template snapshots are not user snapshots: they are kept in `store.templateSnapshots` and their bytes are deleted
 * with `backend.deleteTemplateSnapshot`. Nothing here reads or writes `store.snapshots` or calls `backend.deleteSnapshot`.
 */
import { computeSchema, type RouteHandlers, type SignedInComputeRoutes, type templateRoutes } from "@kantel/api";
import { isKantelError, KantelError, placementError } from "@kantel/contracts";
import { actingAccount, type Principal, requireScope, roleIn } from "./auth.ts";
import type {
	BackendEgress,
	BackendHost,
	BackendShape,
	BackendSize,
	BackendTemplateImage,
	SandboxBackend,
	SandboxTemplateBoot,
	TemplateRuntime,
} from "./backend.ts";
import { makesShape } from "./machine.ts";
import {
	type ComputeStore,
	type StoredTemplate,
	type StoredTemplateBase,
	type StoredTemplateSnapshot,
	type StoredTemplateVersion,
	UniqueViolation,
} from "./store.ts";
import { randomId, sha256Hex } from "./util.ts";

type TemplateSpec = computeSchema.TemplateSpec;
type CacheKey = computeSchema.TemplateCacheKey;
type Actor = StoredTemplate["createdBy"];
/** An egress grant as a body gives it. */
interface GrantInput {
	readonly id?: string;
	readonly action: "allow" | "deny";
	readonly host: string;
	readonly methods?: readonly string[];
	readonly paths?: readonly string[];
}
/** A spec as a body gives it, before `normaliseSpec`. */
interface SpecInput {
	readonly image?: Readonly<computeSchema.TemplateImage>;
	readonly base?: Readonly<computeSchema.TemplateBase>;
	readonly resources?: Readonly<computeSchema.TemplateResources>;
	readonly env?: { readonly [name: string]: string };
	readonly setup?: string;
	readonly network?: { readonly grants: readonly GrantInput[] };
}

/** The base a template follows when its spec names none. */
export const DEFAULT_TEMPLATE_BASE = { image: "kantel/sandbox", channel: "stable" } as const;
/** A template's image when its spec names none. */
const DEFAULT_TEMPLATE_IMAGE: computeSchema.TemplateImage = { kind: "kantel-base" };
/** The longest Dockerfile a template may give, as the API allows. */
const MAX_DOCKERFILE_LENGTH = 65_536;
/** A template's resources when its spec names none: the `default` size's. */
export const DEFAULT_TEMPLATE_RESOURCES = { vcpus: 2, memoryMb: 4096 } as const;
/** A base channel keeps this many digests in its history. */
export const MAX_TEMPLATE_BASE_HISTORY = 100;
/**
 * A build `queued` or `building` this long without this gateway working on it is taken to have died with its gateway,
 * and another may claim it again. It outlasts the longest a build may take, a custom image's (the hosts service's
 * `TEMPLATE_IMAGE_BUILD_TIMEOUT_MS`, 100 minutes), with a margin, so no gateway reclaims or deletes a build still
 * within its time.
 */
export const TEMPLATE_BUILD_LEASE_MS = 120 * 60_000;
/** A build its host had no room for (`exhausted`) is tried again by the first reconcile this long after. */
export const TEMPLATE_BUILD_RETRY_MS = 60_000;

/** What `KANTEL_TEMPLATES` being off answers. */
export const TEMPLATES_OFF = "Templates are off on this deployment (KANTEL_TEMPLATES)";

/** A cache key and the SHA-256 hex of its canonical JSON. */
export interface TemplateCacheKeyHash {
	readonly key: CacheKey;
	readonly keyHash: string;
}

/**
 * A template snapshot's cache key and its hash: the SHA-256 hex of the JSON of its parts in a fixed order
 * (`templateVersion`, `baseDigest`, a custom image's `source` and `imageDigest` when it has them, `kernel`,
 * `firecracker`, `vcpus`, `memoryMb`), so each part changes the hash and the same parts always hash the same. A
 * `kantel-base` template's key has no `source` or `imageDigest`, so it hashes as it always has.
 */
export async function templateCacheKey(parts: CacheKey): Promise<TemplateCacheKeyHash> {
	const key: CacheKey = {
		templateVersion: parts.templateVersion,
		baseDigest: parts.baseDigest,
		...(parts.source === undefined ? {} : { source: parts.source }),
		...(parts.imageDigest === undefined ? {} : { imageDigest: parts.imageDigest }),
		kernel: parts.kernel,
		firecracker: parts.firecracker,
		vcpus: parts.vcpus,
		memoryMb: parts.memoryMb,
	};
	return { key, keyHash: await sha256Hex(JSON.stringify(key)) };
}

/** A base channel's ID: `<image>:<channel>`. */
export const templateBaseId = (image: string, channel: string): string => `${image}:${channel}`;

/** A template version's ID: `<templateId>@<version>`, which is also its cache key's `templateVersion`. */
export const templateVersionId = (templateId: string, version: number): string => `${templateId}@${version}`;

/**
 * A template snapshot's ID: from its key, the template's rebuild count and the key's attempt in that rebuild, so two
 * gateways reconciling at once claim the same entry (one `insert` wins), a rebuild's entries are new ones, and so is a
 * build made again after one its gateway died with (`claim`), never meeting its bytes.
 */
export const templateSnapshotId = (keyHash: string, cacheEpoch: number, attempt = 0): string =>
	`tsn_${keyHash.slice(0, 24)}${cacheEpoch === 0 ? "" : `_${cacheEpoch}`}${attempt === 0 ? "" : `_a${attempt}`}`;

/** The rebuild count a template snapshot's ID was made with (`templateSnapshotId`). */
const cacheEpochOf = (snapshotId: string): number =>
	Number(/^tsn_[0-9a-f]{24}(?:_(\d+))?(?:_a\d+)?$/.exec(snapshotId)?.[1] ?? 0);

/** An image reference a template may name (`TEMPLATE_IMAGE_REF_PATTERN`). */
const IMAGE_REF = new RegExp(computeSchema.TEMPLATE_IMAGE_REF_PATTERN);

/** The digest an image reference pins (`…@sha256:<hex>`), if it pins one. */
const pinnedDigest = (ref: string): string | undefined => /@(sha256:[0-9a-f]{64})$/.exec(ref)?.[1];

/** A template's custom image as its cache key and `builtFrom` name it; undefined for `kantel-base`. */
interface CustomSource {
	readonly image: Exclude<computeSchema.TemplateImage, { kind: "kantel-base" }>;
	/** The key's `source`: `dockerfile:sha256:<hex>` or `image:<ref>`. */
	readonly source: string;
	/** The digest known before the build: a reference's pinned one. */
	readonly pinned?: string;
	readonly builtFrom: Pick<computeSchema.TemplateBuiltFrom, "source" | "dockerfileDigest" | "imageRef">;
}

async function customSource(image: computeSchema.TemplateImage | undefined): Promise<CustomSource | undefined> {
	if (image === undefined || image.kind === "kantel-base") return undefined;
	if (image.kind === "dockerfile") {
		const digest = `sha256:${await sha256Hex(image.dockerfile)}`;
		return { image, source: `dockerfile:${digest}`, builtFrom: { source: "dockerfile", dockerfileDigest: digest } };
	}
	const pinned = pinnedDigest(image.ref);
	return {
		image,
		source: `image:${image.ref}`,
		...(pinned === undefined ? {} : { pinned }),
		builtFrom: { source: "image", imageRef: image.ref },
	};
}

/** A custom image as a backend builds or boots it, in the scope of the template's version and rebuild. */
const backendImage = (
	image: CustomSource["image"],
	templateId: string,
	version: number,
	cacheEpoch: number,
): BackendTemplateImage => {
	const scope = `${templateVersionId(templateId, version)}#${cacheEpoch}`;
	return image.kind === "dockerfile"
		? { kind: "dockerfile", dockerfile: image.dockerfile, scope }
		: { kind: "image", ref: image.ref, scope };
};

/** The hash a reconcile wants an entry by: the one it was claimed under. */
const claimHashOf = (entry: StoredTemplateSnapshot): string => entry.claimHash ?? entry.keyHash;

/** What the cache is built for: each host's runtime, the hosts themselves, and the sizes the backend offers. */
interface Fleet {
	readonly runtimes: readonly TemplateRuntime[];
	readonly hosts: readonly BackendHost[];
	readonly sizes: readonly BackendSize[];
}

/** A base resolved for a build or a boot. */
interface ResolvedBase {
	/** The image's name, as the spec names it: what the backend is given as `baseImage`. */
	readonly image: string;
	readonly channel?: string;
	/** Empty while the default channel has no published digest: each host's own sandbox image. */
	readonly digest: string;
	readonly pinned: boolean;
}

/** A template snapshot as the API answers it: without its account or its bytes' reference. */
export const templateSnapshotView = (entry: StoredTemplateSnapshot): computeSchema.TemplateSnapshot => ({
	id: entry.id,
	templateId: entry.templateId,
	version: entry.version,
	key: { ...entry.key },
	keyHash: entry.keyHash,
	// Its bytes not yet deleted from its host is the cache's business: thrown away all the same.
	state: entry.state === "deleting" ? "discarded" : entry.state,
	...(entry.hostId === undefined ? {} : { hostId: entry.hostId }),
	builtFrom: { ...entry.builtFrom },
	startedAt: entry.startedAt,
	...(entry.readyAt === undefined ? {} : { readyAt: entry.readyAt }),
	...(entry.error === undefined ? {} : { error: entry.error }),
	...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
});

const baseChannelView = (base: StoredTemplateBase): computeSchema.TemplateBaseChannel => ({
	image: base.image,
	channel: base.channel,
	digest: base.digest,
	publishedAt: base.publishedAt,
	history: base.history.map((release) => ({ ...release })),
});

const copySpec = (spec: TemplateSpec): TemplateSpec => structuredClone(spec);

/** A spec as compared for a new version: its grants' IDs left out, which an edit that names none makes afresh. */
const specKey = (spec: TemplateSpec): string =>
	JSON.stringify({
		...spec,
		network: { grants: (spec.network?.grants ?? []).map(({ id: _id, ...grant }) => grant) },
	});

const newestFirst = <T>(items: readonly T[], at: (item: T) => number): T[] => [...items].sort((a, b) => at(b) - at(a));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The handlers of the template routes. */
export type TemplateHandlers = Pick<RouteHandlers<SignedInComputeRoutes, Principal>, keyof typeof templateRoutes>;

/** How a sandbox made from a template starts: what `createSandbox` gives the backend and records. */
/**
 * A sandbox's `image` for a template: for a base, `<image>@<digest>`, or the image's name alone with no digest
 * published; for a custom image, its reference (or `dockerfile`) at the digest its build made.
 */
export const templateBootImage = ({
	baseImage,
	baseDigest,
	image,
	imageDigest,
}: Pick<SandboxTemplateBoot, "baseImage" | "baseDigest" | "image" | "imageDigest">): string => {
	if (image !== undefined) {
		const name = image.kind === "dockerfile" ? "dockerfile" : image.ref.replace(/@sha256:[0-9a-f]{64}$/, "");
		return imageDigest === undefined ? name : `${name}@${imageDigest}`;
	}
	return baseDigest === "" ? baseImage : `${baseImage}@${baseDigest}`;
};

export interface TemplateStart {
	/**
	 * Every host the create may use that can boot templates: the snapshot's host first, when it has room (the backend
	 * pins `boot.snapshot` to it), else the others for a fresh boot.
	 */
	readonly eligibleHosts: readonly string[];
	readonly boot: SandboxTemplateBoot;
	readonly record: computeSchema.SandboxTemplate;
	/**
	 * The sandbox's `image` (`templateBootImage`): the base its snapshot was built from when it starts from one, else the
	 * base `boot` boots fresh.
	 */
	readonly image: string;
}

export interface TemplateServiceOptions {
	readonly store: ComputeStore;
	readonly backend: SandboxBackend;
	readonly now: () => number;
	/** `KANTEL_TEMPLATES=experimental`. Off, every template route and a create naming a template answer `not_supported`. */
	readonly enabled: boolean;
	/** Runs work in the background, tracked so the service's `idle()` waits for it. */
	readonly keepGoing: (work: Promise<unknown>) => void;
	/**
	 * The hosts an account's template may be built on: connected, not draining, running microVMs, which it may use (its
	 * own when it has any, else the shared ones `userId` may use). Empty when there are none.
	 */
	readonly buildHosts: (accountId: string, userId: string) => Promise<readonly string[]>;
	/** A build's egress: the account's proxy settings and the template's grants. */
	readonly buildEgress: (
		accountId: string,
		grants: readonly computeSchema.EgressGrant[],
	) => Promise<BackendEgress | undefined>;
	/** Checks grants as given, keeping their well-formed IDs and making the rest. */
	readonly normaliseGrants: (grants: readonly GrantInput[]) => computeSchema.EgressGrant[];
	/** Refuses a variable's name that isn't one, or is Kantel's own. */
	readonly checkVariableName: (name: string) => void;
	/** Refuses resources a microVM can't ask for (`checkShape`): a template's sandboxes ask for them. */
	readonly checkResources: (resources: computeSchema.TemplateResources) => void;
	readonly actorOf: (principal: Principal) => Actor;
	/** Does `work` once for the call's `Idempotency-Key` and request, answering a retry the first answer (the service's). */
	readonly once: <T>(
		principal: Principal,
		operation: string,
		input: { readonly params?: unknown; readonly body?: unknown; readonly idempotencyKey?: string },
		work: () => Promise<T>,
	) => Promise<T>;
}

export interface TemplateService {
	readonly handlers: TemplateHandlers;
	/** Refuses with `not_supported` while templates are off, or the backend has none. */
	requireTemplates(): void;
	/** Whether templates are on with a backend that has them. */
	readonly enabled: boolean;
	/** The template a create names in an account, by ID or name: `not_found` when there's none. */
	templateIn(accountId: string, ref: string): Promise<StoredTemplate>;
	/**
	 * How a sandbox made from `template` asking for `shape` (`sandboxMachine`: the template's resources, else the
	 * create's own) starts: from the newest ready (or stale) snapshot for its version, that shape's vCPUs and memory and a
	 * runtime one of `eligibleHosts` has, on that host (a fresh boot on another of them when it has no room); else a
	 * fresh boot on any of them. A shape with a disk restores a snapshot only on `restoreOn`, where given: the hosts that
	 * grow a snapshot's disk to the one asked for, or boot fresh where it is bigger (a host from before disks were chosen
	 * would copy the snapshot's disk as it is).
	 */
	startFor(
		template: StoredTemplate,
		options: {
			readonly shape: BackendShape;
			readonly eligibleHosts: readonly string[];
			readonly restoreOn?: readonly string[];
		},
	): Promise<TemplateStart>;
	/**
	 * Reconciles every template's cache: what the sweep runs, which notices hosts' runtimes changing, and tries again the
	 * template snapshot deletions still `deleting`. A call while a pass is under way joins it.
	 */
	reconcileAll(): Promise<void>;
	/**
	 * Retires every template of an account being deleted: their records, versions and cache entries (their bytes through
	 * `deleteTemplateSnapshot`, never a user snapshot's). Whether templates are on or not, so none are left behind.
	 */
	retireAccount(accountId: string): Promise<void>;
	/** Makes `digest` a base channel's current one, and rebuilds the templates following it. */
	publishTemplateBase(input: computeSchema.PublishTemplateBaseBody): Promise<computeSchema.TemplateBaseChannel>;
}

/** The templates, their versions, their snapshot cache and the base channels, over the store and the backend. */
export function createTemplateService(options: TemplateServiceOptions): TemplateService {
	const { store, backend, now } = options;
	const supported =
		options.enabled &&
		backend.templateRuntimes !== undefined &&
		backend.buildTemplate !== undefined &&
		backend.deleteTemplateSnapshot !== undefined;

	const requireTemplates = () => {
		if (!options.enabled) throw new KantelError("not_supported", TEMPLATES_OFF);
		if (!supported) throw new KantelError("not_supported", "This deployment's hosts can't build templates");
	};

	/** Each template's reconciles and its retirement, one after another on this gateway. */
	const chains = new Map<string, Promise<void>>();
	/** The template snapshots this gateway is building now, whose lease it holds. */
	const building = new Set<string>();

	const runtimes = async (): Promise<TemplateRuntime[]> => (await backend.templateRuntimes?.()) ?? [];

	/** What the cache is built for: each host's runtime, the hosts, and the sizes offered. */
	const fleet = async (): Promise<Fleet> => {
		const [all, capabilities] = await Promise.all([runtimes(), backend.capabilities()]);
		return { runtimes: all, hosts: capabilities.hosts, sizes: capabilities.sizes };
	};

	/**
	 * The runtimes a template is built for, as `shape`: one per distinct kernel and Firecracker among the hosts it may
	 * use, each on a host that can make that shape (`makesShape`, as a create of it is placed), which alone can build it.
	 * A custom image's are only hosts that build custom images (`customImages`).
	 */
	async function runtimesFor(template: StoredTemplate, given: Fleet, shape: BackendShape): Promise<TemplateRuntime[]> {
		const distinct = new Map<string, TemplateRuntime>();
		for (const runtime of await eligibleRuntimes(template, given, shape)) {
			const key = JSON.stringify([runtime.kernel, runtime.firecracker]);
			if (!distinct.has(key)) distinct.set(key, runtime);
		}
		return [...distinct.values()];
	}

	/**
	 * Every host a template's builds may use now, with its runtime: connected with a runtime, one the template's account
	 * may build on, making its shape, and building custom images when its image is one. `runtimesFor` is one a runtime.
	 */
	async function eligibleRuntimes(
		template: StoredTemplate,
		given: Fleet,
		shape: BackendShape,
	): Promise<TemplateRuntime[]> {
		const hosts = new Set(await options.buildHosts(template.accountId, template.ownerUserId));
		const custom = (template.spec.image ?? DEFAULT_TEMPLATE_IMAGE).kind !== "kantel-base";
		return given.runtimes.filter((runtime) => {
			if (!hosts.has(runtime.hostId)) return false;
			if (custom && runtime.customImages !== true) return false;
			const host = given.hosts.find((each) => each.id === runtime.hostId);
			return host !== undefined && makesShape(host, given.sizes, shape);
		});
	}

	async function resolveBase(spec: TemplateSpec): Promise<ResolvedBase> {
		const base = spec.base ?? DEFAULT_TEMPLATE_BASE;
		if ("digest" in base) return { image: base.image, digest: base.digest, pinned: true };
		const channel = await store.templateBases.get(templateBaseId(base.image, base.channel));
		return { image: base.image, channel: base.channel, digest: channel?.digest ?? "", pinned: false };
	}

	/**
	 * Refuses (`invalid`) a base the deployment hasn't published: a channel must be published, unless it is the default
	 * one (each host's own sandbox image until it publishes a digest); a pinned digest must be in the history of one of
	 * its image's published channels.
	 */
	async function checkBase(base: computeSchema.TemplateBase): Promise<void> {
		if ("channel" in base) {
			const isDefault = base.image === DEFAULT_TEMPLATE_BASE.image && base.channel === DEFAULT_TEMPLATE_BASE.channel;
			if (isDefault || (await store.templateBases.get(templateBaseId(base.image, base.channel))) !== undefined) return;
			throw new KantelError(
				"invalid",
				`This deployment publishes no channel ${base.channel} of the base image ${base.image}`,
			);
		}
		const channels = await store.templateBases.list({ image: base.image });
		if (channels.some((channel) => channel.history.some((release) => release.digest === base.digest))) return;
		throw new KantelError(
			"invalid",
			`No channel of the base image ${base.image} on this deployment has published ${base.digest}`,
		);
	}

	/** How far a pinned base is behind its channel: the first channel of its image (`stable` first) that published it. */
	async function behindOf(spec: TemplateSpec): Promise<computeSchema.TemplateBehind | undefined> {
		const base = spec.base;
		if (base === undefined || !("digest" in base)) return undefined;
		const channels = (await store.templateBases.list({ image: base.image })).sort(
			(a, b) =>
				Number(b.channel === DEFAULT_TEMPLATE_BASE.channel) - Number(a.channel === DEFAULT_TEMPLATE_BASE.channel),
		);
		for (const channel of channels) {
			const index = channel.history.findIndex((release) => release.digest === base.digest);
			if (index < 0) continue;
			const next = channel.history[index - 1];
			if (next === undefined) return undefined;
			return { releases: index, since: next.publishedAt, latestDigest: channel.digest };
		}
		return undefined;
	}

	/** Whether an entry has been thrown away: `discarded`, or `deleting` its bytes. */
	const thrownAway = (entry: StoredTemplateSnapshot) => entry.state === "discarded" || entry.state === "deleting";

	/**
	 * An entry thrown away: `deleting` while it may have bytes on a host (built, at `ref`; or its build begun there, which
	 * may have made them under its ID however it ended, a timed-out one too, or may be making them still), else
	 * `discarded` (never built, or `queued`: never begun, or refused by its host for want of room before it began,
	 * `exhausted`). One still building leaves its bytes to its build's end (`buildLeaseEnds`).
	 */
	const throwAway = (current: StoredTemplateSnapshot): StoredTemplateSnapshot => {
		if (current.ref === undefined && (current.hostId === undefined || current.state === "queued")) {
			return { ...current, state: "discarded" };
		}
		return {
			...current,
			state: "deleting",
			...(current.state === "building" ? { buildLeaseEnds: current.startedAt + TEMPLATE_BUILD_LEASE_MS } : {}),
		};
	};

	/**
	 * Cleans up after an entry thrown away, the one way any template snapshot's bytes go and the one way an entry's record
	 * goes. `deleting`, its bytes are deleted from its host (by `ref`, or by its ID there when it has none); done (or its
	 * host gone for good, `not_found`), it is `discarded`; failed, it stays `deleting`, and the next sweep
	 * (`reconcileAll`) tries again, so no bytes are left with nothing pointing at them. `discarded` (its bytes gone, or it
	 * never had any) with its template gone, its record goes. Each write is made only over the entry as it was read.
	 */
	async function cleanUp(entry: StoredTemplateSnapshot | undefined): Promise<void> {
		let cleaned = entry;
		if (cleaned?.state === "deleting") {
			// Its build may be running still, and deletes its bytes when it ends (`discardBuilt`); a host deletes none while
			// it does. Its lease lapsed, its gateway is taken to have died with it, and they are deleted here.
			if (cleaned.buildLeaseEnds !== undefined && cleaned.buildLeaseEnds > now()) return;
			const { id, ref, hostId, startedAt } = cleaned;
			if (hostId !== undefined) {
				try {
					await backend.deleteTemplateSnapshot?.({ snapshotId: id, hostId, ...(ref === undefined ? {} : { ref }) });
				} catch (error) {
					if (!isKantelError(error, "not_found")) return;
				}
			}
			cleaned = await store.templateSnapshots.update(id, (current) => {
				if (current.state !== "deleting" || current.ref !== ref || current.startedAt !== startedAt) return undefined;
				const { ref: _deleted, ...rest } = current;
				return { ...rest, state: "discarded" };
			});
		}
		// Checked after the write, so a retirement either sees it discarded (and cleans it up) or has begun before this.
		if (cleaned?.state !== "discarded" || (await stillThere(cleaned.templateId))) return;
		const { startedAt } = cleaned;
		await store.templateSnapshots.deleteIf(
			cleaned.id,
			(current) => current.state === "discarded" && current.startedAt === startedAt,
		);
	}

	/**
	 * Throws an entry away while `when` holds of it (by default, while it hasn't been), then cleans up after it
	 * (`cleanUp`), as it is now whether this threw it away or not.
	 */
	async function discard(
		entry: StoredTemplateSnapshot,
		when: (current: StoredTemplateSnapshot) => boolean = (current) => !thrownAway(current),
	): Promise<void> {
		const changed = await store.templateSnapshots.update(entry.id, (current) =>
			when(current) ? throwAway(current) : undefined,
		);
		await cleanUp(changed ?? (await store.templateSnapshots.get(entry.id)));
	}

	/**
	 * Sets an entry aside for a rebuild: a usable one (`ready`) goes stale, its bytes kept and still used until one of
	 * the rebuild's is ready for its runtime or host (`reconcileNow`); any other is thrown away (its bytes, if it may have
	 * any, deleted), a failed one too, so it is tried again, and one still building throws its result away when it
	 * finishes.
	 */
	async function setAside(entry: StoredTemplateSnapshot): Promise<void> {
		const changed = await store.templateSnapshots.update(entry.id, (current) =>
			thrownAway(current) || current.state === "stale"
				? undefined
				: current.state === "ready"
					? { ...current, state: "stale" }
					: throwAway(current),
		);
		if (changed !== undefined) await cleanUp(changed);
	}

	/**
	 * Lets a build's result go that nothing will use (a rebuild or a reconcile set its entry aside, or its template was
	 * retired, while it built): its entry, or one written again for it when the retirement took that, holds it `deleting`
	 * until its bytes are gone. A build that failed (`built` absent) is held the same way, by its ID on its host, which may
	 * have made them all the same (its answer timed out, say). No other build is ever given its entry's ID (`claim`), so
	 * whatever is under it on its host is this build's.
	 */
	async function discardBuilt(entry: StoredTemplateSnapshot, built?: { ref: string }): Promise<void> {
		// Its build has ended: nothing is left to wait for (`buildLeaseEnds`).
		const held = ({ buildLeaseEnds: _ended, ...current }: StoredTemplateSnapshot): StoredTemplateSnapshot => ({
			...current,
			state: "deleting",
			...(built === undefined ? {} : { ref: built.ref }),
		});
		const marked =
			(await store.templateSnapshots.update(entry.id, (current) =>
				current.startedAt === entry.startedAt &&
				(current.state === "building" ||
					current.state === "discarded" ||
					(current.state === "deleting" &&
						(current.buildLeaseEnds !== undefined || (built !== undefined && current.ref !== built.ref))))
					? held(current)
					: undefined,
			)) ??
			((await store.templateSnapshots.get(entry.id)) === undefined &&
			(await store.templateSnapshots.insert(held({ ...entry, state: "deleting" })))
				? held(entry)
				: undefined);
		if (marked !== undefined) await cleanUp(marked);
	}

	/** Tries again to delete the bytes of every entry still `deleting` (`cleanUp`), of any template, gone or not. */
	async function retryDeletions(): Promise<void> {
		for (const entry of await store.templateSnapshots.list({ state: "deleting" })) await cleanUp(entry);
	}

	/** A template that is there to callers: not retired (`retiredAt`), its retirement finished or not. */
	const live = (template: StoredTemplate | undefined): StoredTemplate | undefined =>
		template?.retiredAt === undefined ? template : undefined;

	/** Whether a template is still there (`live`): a build of one retired since it was claimed throws its result away. */
	const stillThere = async (templateId: string) => live(await store.templates.get(templateId)) !== undefined;

	/**
	 * Builds a claimed entry as `shape`, in the background: `queued` → `building` → `ready` or `failed`, then
	 * reconciles again. A host with no room for it (`exhausted`, as the backend answers a host's `capacity` refusal too)
	 * leaves it `queued` and deferred, for a later reconcile to try again.
	 */
	async function build(
		template: StoredTemplate,
		entry: StoredTemplateSnapshot,
		base: ResolvedBase,
		runtime: TemplateRuntime,
		shape: BackendShape,
		custom: CustomSource | undefined,
	): Promise<void> {
		const ours = (current: StoredTemplateSnapshot, state: StoredTemplateSnapshot["state"]) =>
			current.state === state && current.startedAt === entry.startedAt;
		building.add(entry.id);
		try {
			if (!(await stillThere(template.id))) {
				// Never started: it has no bytes, and its record goes.
				await discard(entry, (current) => ours(current, "queued"));
				return;
			}
			const started = await store.templateSnapshots.update(entry.id, (current) =>
				ours(current, "queued") ? { ...current, state: "building" } : undefined,
			);
			if (started === undefined) return;
			const { spec } = template;
			try {
				const egress = await options.buildEgress(
					template.accountId,
					options.normaliseGrants(spec.network?.grants ?? []),
				);
				const built = await (backend.buildTemplate as NonNullable<SandboxBackend["buildTemplate"]>)({
					snapshotId: entry.id,
					accountId: template.accountId,
					templateId: template.id,
					version: template.version,
					baseImage: base.image,
					baseDigest: base.digest,
					// The template's resources, which the key has: what its sandboxes ask for, and a fresh boot of them gets too.
					shape: { vcpus: shape.vcpus, memoryMb: shape.memoryMb },
					env: { ...spec.env },
					...(spec.setup === undefined ? {} : { setup: spec.setup }),
					...(custom === undefined
						? {}
						: { image: backendImage(custom.image, template.id, entry.version, cacheEpochOf(entry.id)) }),
					...(egress === undefined ? {} : { egress }),
					keyHash: entry.keyHash,
					hostId: runtime.hostId,
				});
				// A custom image's key covers the digest its build made (or resolved), which its host must name, and a pinned
				// reference's must be the one it pins; without them the build failed (its bytes, deleted by its ID on its host once
				// it is set aside, never used).
				let customKey: TemplateCacheKeyHash | undefined;
				if (custom !== undefined) {
					const digest = built.imageDigest;
					if (digest === undefined || built.rootfsKey === undefined) {
						throw new KantelError("unavailable", "The host didn't say which image it built; upgrade its kantel-host");
					}
					if (custom.pinned !== undefined && digest !== custom.pinned) {
						throw new KantelError(
							"invalid",
							`The image pulled is ${digest}, not the ${custom.pinned} its reference pins`,
						);
					}
					customKey = await templateCacheKey({ ...entry.key, imageDigest: digest });
				}
				// Retired while it built (on any gateway): its result and its entry go.
				const kept = await stillThere(template.id);
				const ready = !kept
					? undefined
					: await store.templateSnapshots.update(entry.id, (current) =>
							ours(current, "building")
								? {
										...current,
										state: "ready",
										ref: built.ref,
										sizeBytes: built.sizeBytes,
										readyAt: now(),
										builtFrom: {
											...current.builtFrom,
											...(built.imageDigest === undefined ? {} : { imageDigest: built.imageDigest }),
										},
										...(customKey === undefined
											? {}
											: {
													key: customKey.key,
													keyHash: customKey.keyHash,
													claimHash: claimHashOf(current),
													...(built.rootfsKey === undefined ? {} : { rootfsKey: built.rootfsKey }),
												}),
									}
								: undefined,
						);
				// Thrown away while it built (a rebuild, the template deleted): so are its bytes.
				if (ready === undefined) await discardBuilt(entry, built);
			} catch (error) {
				const exhausted = isKantelError(error, "exhausted");
				// A failed one keeps its host: its bytes, if its build made them after all, are deleted by its ID there. One its
				// host had no room for made none, and may be claimed again for any host.
				const ended = await store.templateSnapshots.update(entry.id, (current) =>
					!ours(current, "building")
						? undefined
						: exhausted
							? { ...current, state: "queued", deferred: now() }
							: { ...current, state: "failed", error: messageOf(error) },
				);
				// Thrown away while it built: whatever it may have left on its host goes.
				if (ended === undefined) await discardBuilt(entry);
			}
		} finally {
			building.delete(entry.id);
		}
		// The entries it replaces go now it is ready.
		await reconcile(template.id);
	}

	/**
	 * Claims a wanted key's entry, and starts its build as `shape` when this gateway got it. Its attempts are tried in
	 * turn (`templateSnapshotId`): one thrown away is passed over, never claimed again; one missing is made; one `queued`
	 * (which has no bytes) whose lease lapsed, or deferred long enough, is claimed again in place. One `building` whose
	 * lease lapsed is taken to have died with its gateway: it is thrown away (its bytes, which its host may have made or
	 * be making, deleted by its ID there) and the key's next attempt claimed, so its ID and host stay its bytes' name.
	 *
	 * A custom image is only on the host that built it, and nothing boots it elsewhere (`startCustom`), so a ready or
	 * stale one whose host can't serve the template now (`servedBy` false: disconnected, draining, no longer one the
	 * account may use) doesn't satisfy its key: it is set aside (stale, its ID and host kept for its bytes, replaced and
	 * deleted once the next attempt is ready) and the next attempt claimed on an eligible host. A Kantel base's entry is
	 * kept whatever its host: a create boots its base fresh on another.
	 */
	async function claim(
		template: StoredTemplate,
		base: ResolvedBase,
		runtime: TemplateRuntime,
		wanted: TemplateCacheKeyHash,
		shape: BackendShape,
		custom: CustomSource | undefined,
		servedBy: (entry: StoredTemplateSnapshot) => boolean,
	): Promise<void> {
		const at = now();
		const fresh = (id: string): StoredTemplateSnapshot => ({
			id,
			accountId: template.accountId,
			templateId: template.id,
			version: template.version,
			key: wanted.key,
			keyHash: wanted.keyHash,
			state: "queued",
			hostId: runtime.hostId,
			builtFrom: {
				baseImage: base.image,
				...(base.channel === undefined ? {} : { channel: base.channel }),
				baseDigest: base.digest,
				pinned: base.pinned,
				...custom?.builtFrom,
				kernel: runtime.kernel,
				firecracker: runtime.firecracker,
			},
			startedAt: at,
		});
		const leaseLapsed = (current: StoredTemplateSnapshot) => current.startedAt + TEMPLATE_BUILD_LEASE_MS <= at;
		const reclaimable = (current: StoredTemplateSnapshot) =>
			current.state === "queued" &&
			!building.has(current.id) &&
			(leaseLapsed(current) || (current.deferred !== undefined && current.deferred + TEMPLATE_BUILD_RETRY_MS <= at));
		const abandoned = (current: StoredTemplateSnapshot) =>
			current.state === "building" && !building.has(current.id) && leaseLapsed(current);
		for (let attempt = 0; ; ) {
			const id = templateSnapshotId(wanted.keyHash, template.cacheEpoch, attempt);
			const existing = await store.templateSnapshots.get(id);
			let claimed: StoredTemplateSnapshot | undefined;
			if (existing === undefined) {
				const made = fresh(id);
				claimed = (await store.templateSnapshots.insert(made)) ? made : undefined;
			} else if (thrownAway(existing)) {
				attempt += 1;
				continue;
			} else if (
				custom !== undefined &&
				(existing.state === "ready" || existing.state === "stale") &&
				!servedBy(existing)
			) {
				// A custom image on a host that can't serve it: kept for its bytes, and built again on one that can.
				if (existing.state === "ready") await setAside(existing);
				attempt += 1;
				continue;
			} else if (existing.state === "stale") {
				// Wanted again (a host back on its old runtime): ready as it is.
				await store.templateSnapshots.update(id, (current) =>
					current.state === "stale" ? { ...current, state: "ready" } : undefined,
				);
			} else if (reclaimable(existing)) {
				claimed = await store.templateSnapshots.update(id, (current) =>
					reclaimable(current) && current.startedAt === existing.startedAt ? fresh(id) : undefined,
				);
			} else if (abandoned(existing)) {
				// Looked at again: thrown away now (by this or another gateway), or its build's answer came meanwhile.
				await discard(existing, (current) => abandoned(current) && current.startedAt === existing.startedAt);
				continue;
			}
			if (claimed !== undefined) options.keepGoing(build(template, claimed, base, runtime, shape, custom));
			return;
		}
	}

	async function reconcileNow(templateId: string, given?: Fleet): Promise<void> {
		const template = await store.templates.get(templateId);
		if (template === undefined) return;
		// Retiring (a retirement cut short), or its account deleted: nothing more is built for it, and what is left of it
		// goes.
		if (template.retiredAt !== undefined || (await store.accounts.get(template.accountId)) === undefined) {
			await retireNow(template.id);
			return;
		}
		const resources = template.spec.resources ?? DEFAULT_TEMPLATE_RESOURCES;
		const shape: BackendShape = { vcpus: resources.vcpus, memoryMb: resources.memoryMb };
		const hosts = given ?? (await fleet());
		const [base, hostRuntimes, eligible, custom] = await Promise.all([
			resolveBase(template.spec),
			runtimesFor(template, hosts, shape),
			eligibleRuntimes(template, hosts, shape),
			customSource(template.spec.image),
		]);
		// Whether an entry's host may serve creates from it now, on the runtime it was built for.
		const servedBy = (entry: StoredTemplateSnapshot) =>
			eligible.some(
				(runtime) =>
					runtime.hostId === entry.hostId &&
					runtime.kernel === entry.key.kernel &&
					runtime.firecracker === entry.key.firecracker,
			);
		// By each wanted key's hash (a custom image's as it is claimed, before its build names its digest); none while no
		// host can make its shape.
		const wanted = new Map<string, { runtime: TemplateRuntime; key: TemplateCacheKeyHash }>();
		for (const runtime of hostRuntimes) {
			const key = await templateCacheKey({
				templateVersion: templateVersionId(template.id, template.version),
				// An image reference doesn't use the base, so a base release never builds it again (a rebuild does).
				baseDigest: custom?.image.kind === "image" ? "" : base.digest,
				...(custom === undefined ? {} : { source: custom.source }),
				...(custom?.pinned === undefined ? {} : { imageDigest: custom.pinned }),
				kernel: runtime.kernel,
				firecracker: runtime.firecracker,
				vcpus: shape.vcpus,
				memoryMb: shape.memoryMb,
			});
			wanted.set(key.keyHash, { runtime, key });
		}
		// An entry of a wanted key in the template's current rebuild, whichever attempt.
		const wantedNow = (entry: StoredTemplateSnapshot) =>
			wanted.has(claimHashOf(entry)) && cacheEpochOf(entry.id) === template.cacheEpoch;
		// What is no longer wanted (another key, or an earlier rebuild's) is set aside: one ready goes stale, still used
		// until its replacement is ready; one queued, building or failed is thrown away (a build of it under way throws its
		// result away; a failed one's bytes, which its host may have made after all, are deleted by its ID), as nothing
		// would claim it again.
		for (const entry of await store.templateSnapshots.list({ templateId })) {
			if (wantedNow(entry)) continue;
			// Of a version or rebuild newer than the template as read here (an edit or rebuild on another gateway since): its
			// own reconcile's.
			if (entry.version > template.version || cacheEpochOf(entry.id) > template.cacheEpoch) continue;
			if (
				entry.state === "ready" ||
				entry.state === "queued" ||
				entry.state === "building" ||
				entry.state === "failed"
			) {
				await setAside(entry);
			}
		}
		for (const each of wanted.values()) await claim(template, base, each.runtime, each.key, shape, custom, servedBy);
		// A stale entry goes once a ready one wanted now (of this rebuild, so never itself) has replaced it: on its
		// runtime, or its host.
		const entries = await store.templateSnapshots.list({ templateId });
		const replacements = entries.filter((entry) => entry.state === "ready" && wantedNow(entry));
		for (const entry of entries) {
			if (entry.state !== "stale") continue;
			const replaced = replacements.some(
				(ready) =>
					ready.hostId === entry.hostId ||
					(ready.key.kernel === entry.key.kernel && ready.key.firecracker === entry.key.firecracker),
			);
			if (replaced) await discard(entry);
		}
	}

	/** Runs a template's work after whatever of it is under way on this gateway. */
	function queue(templateId: string, work: () => Promise<void>): Promise<void> {
		const previous = chains.get(templateId) ?? Promise.resolve();
		const next = previous.then(work);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		chains.set(templateId, settled);
		void settled.then(() => {
			if (chains.get(templateId) === settled) chains.delete(templateId);
		});
		return next;
	}

	/** Reconciles a template's cache after whatever reconcile of it is under way on this gateway. */
	const reconcile = (templateId: string, given?: Fleet): Promise<void> =>
		queue(templateId, () => reconcileNow(templateId, given));

	/**
	 * Retires a template: marks it retired first (`retiredAt`), so it is gone to every caller and no build of it publishes
	 * a result from then on (`build`), then throws away every cache entry (`cleanUp`: an entry kept `deleting` until its
	 * bytes are gone, whatever becomes of the template, and its record gone after) and deletes every version, and its
	 * record last. Cut short, it is finished by the next sweep's reconcile of the record, still there and marked; one
	 * left with a cache entry claimed meanwhile (by a reconcile that read it before the mark) is too. Its sandboxes keep
	 * running, as they were made.
	 */
	async function retireNow(templateId: string): Promise<void> {
		const at = now();
		await store.templates.update(templateId, (current) =>
			current.retiredAt === undefined ? { ...current, retiredAt: at } : undefined,
		);
		for (const entry of await store.templateSnapshots.list({ templateId })) await discard(entry);
		for (const version of await store.templateVersions.list({ templateId })) {
			await store.templateVersions.delete(version.id);
		}
		const left = await store.templateSnapshots.list({ templateId });
		if (left.every((entry) => entry.state === "deleting")) {
			await store.templates.deleteIf(templateId, (current) => current.retiredAt !== undefined);
		}
	}

	const retire = (template: StoredTemplate): Promise<void> => queue(template.id, () => retireNow(template.id));

	const nameTaken = (name: string) => new KantelError("conflict", `The account has a template named ${name}`);

	/**
	 * Makes a write that may give a template `name`. The store refuses one that would give a second template of the
	 * account the name (`UniqueViolation`, a unique index in SQL), in the write itself, so a create or rename on any
	 * gateway never commits a name another holds. The refusal is `conflict`.
	 */
	async function naming<T>(name: string, write: () => Promise<T>): Promise<T> {
		try {
			return await write();
		} catch (error) {
			if (error instanceof UniqueViolation) throw nameTaken(name);
			throw error;
		}
	}

	/** A template's build as the API answers it. */
	async function buildStatus(template: StoredTemplate): Promise<computeSchema.TemplateBuildStatus> {
		const entries = (await store.templateSnapshots.list({ templateId: template.id })).filter(
			(entry) => !thrownAway(entry),
		);
		const byStart = (entry: StoredTemplateSnapshot) => entry.startedAt;
		const usable = newestFirst(
			entries.filter((entry) => entry.state === "ready" || entry.state === "stale"),
			(entry) => entry.readyAt ?? entry.startedAt,
		);
		const ready = usable.find((entry) => entry.state === "ready") ?? usable[0];
		const [inProgress] = newestFirst(
			entries.filter((entry) => entry.state === "queued" || entry.state === "building"),
			byStart,
		);
		const [failed] = newestFirst(
			entries.filter((entry) => entry.state === "failed"),
			byStart,
		);
		const failedLast = failed !== undefined && (ready === undefined || failed.startedAt > ready.startedAt);
		const state: computeSchema.TemplateBuildStatus["state"] =
			inProgress !== undefined
				? "building"
				: failedLast
					? "failed"
					: ready === undefined
						? "none"
						: ready.state === "ready"
							? "ready"
							: "stale";
		const behind = await behindOf(template.spec);
		return {
			state,
			...(ready === undefined ? {} : { ready: templateSnapshotView(ready) }),
			...(inProgress === undefined ? {} : { building: templateSnapshotView(inProgress) }),
			...(failedLast && failed?.error !== undefined ? { error: failed.error } : {}),
			...(behind === undefined ? {} : { behind }),
		};
	}

	async function templateView(template: StoredTemplate): Promise<computeSchema.Template> {
		const [build, sandboxes] = await Promise.all([
			buildStatus(template),
			store.sandboxes.list({ accountId: template.accountId }),
		]);
		return {
			id: template.id,
			accountId: template.accountId,
			name: template.name,
			...(template.description === undefined ? {} : { description: template.description }),
			version: template.version,
			spec: copySpec(template.spec),
			build,
			sandboxCount: sandboxes.filter((sandbox) => sandbox.template?.id === template.id && sandbox.state !== "deleted")
				.length,
			createdAt: template.createdAt,
			updatedAt: template.updatedAt,
			createdBy: { ...template.createdBy },
		};
	}

	/**
	 * A template's image as given, checked: a Dockerfile that isn't blank and isn't too long, or an image reference of the
	 * API's form (`TEMPLATE_IMAGE_REF_PATTERN`, which the route checks too), lower case where OCI requires it.
	 */
	function normaliseImage(given: Readonly<computeSchema.TemplateImage>): computeSchema.TemplateImage {
		switch (given.kind) {
			case "kantel-base":
				return { kind: "kantel-base" };
			case "dockerfile": {
				if (given.dockerfile.trim() === "") throw new KantelError("invalid", "A template's Dockerfile is empty");
				if (given.dockerfile.length > MAX_DOCKERFILE_LENGTH) {
					throw new KantelError("invalid", `A template's Dockerfile is at most ${MAX_DOCKERFILE_LENGTH} characters`);
				}
				return { kind: "dockerfile", dockerfile: given.dockerfile };
			}
			case "image": {
				const ref = given.ref.trim();
				if (!IMAGE_REF.test(ref) || ref.length > 512) {
					throw new KantelError("invalid", `${JSON.stringify(given.ref)} isn't an image reference`);
				}
				return { kind: "image", ref };
			}
			default:
				throw new KantelError("invalid", "A template's image is kantel-base, a dockerfile or an image reference");
		}
	}

	/** A spec as given, checked, with every default filled in, in one order. */
	function normaliseSpec(input: SpecInput): TemplateSpec {
		const image = normaliseImage(input.image ?? DEFAULT_TEMPLATE_IMAGE);
		const given = input.base ?? DEFAULT_TEMPLATE_BASE;
		if ("digest" in given && "channel" in given) {
			throw new KantelError("invalid", "A template's base follows a channel or pins a digest, not both");
		}
		const base: computeSchema.TemplateBase =
			"digest" in given ? { image: given.image, digest: given.digest } : { image: given.image, channel: given.channel };
		const env: { [name: string]: string } = {};
		for (const [name, value] of Object.entries(input.env ?? {})) {
			options.checkVariableName(name);
			env[name] = value;
		}
		const resources = input.resources ?? DEFAULT_TEMPLATE_RESOURCES;
		options.checkResources(resources);
		return {
			image,
			base,
			resources: { vcpus: resources.vcpus, memoryMb: resources.memoryMb },
			env,
			...(input.setup === undefined || input.setup.trim() === "" ? {} : { setup: input.setup }),
			network: { grants: options.normaliseGrants(input.network?.grants ?? []) },
		};
	}

	/** A template the caller may act on with `scope`; `not_found` when it doesn't exist or isn't in their accounts. */
	async function templateFor(
		principal: Principal,
		templateId: string,
		scope: computeSchema.ApiKeyScope,
	): Promise<StoredTemplate> {
		requireTemplates();
		const template = live(await store.templates.get(templateId));
		const role = template === undefined ? undefined : await roleIn(store, principal, template.accountId);
		if (template === undefined || role === undefined) throw new KantelError("not_found", "No such template");
		requireScope(principal, scope, role);
		return template;
	}

	async function templateIn(accountId: string, ref: string): Promise<StoredTemplate> {
		requireTemplates();
		const byId = live(await store.templates.get(ref));
		if (byId !== undefined && byId.accountId === accountId) return byId;
		const [byName] = (await store.templates.list({ accountId, name: ref })).filter((each) => live(each) !== undefined);
		if (byName === undefined) throw new KantelError("not_found", `No such template ${ref}`);
		return byName;
	}

	async function publishTemplateBase(
		input: computeSchema.PublishTemplateBaseBody,
	): Promise<computeSchema.TemplateBaseChannel> {
		requireTemplates();
		const id = templateBaseId(input.image, input.channel);
		let published: StoredTemplateBase | undefined;
		for (;;) {
			const at = now();
			const existing = await store.templateBases.get(id);
			if (existing === undefined) {
				const made: StoredTemplateBase = {
					id,
					image: input.image,
					channel: input.channel,
					digest: input.digest,
					publishedAt: at,
					history: [{ digest: input.digest, publishedAt: at }],
				};
				if (await store.templateBases.insert(made)) published = made;
				else continue;
			} else if (existing.digest === input.digest) {
				return baseChannelView(existing);
			} else {
				published = await store.templateBases.update(id, (current) =>
					current.digest === input.digest
						? undefined
						: {
								...current,
								digest: input.digest,
								publishedAt: at,
								history: [
									{ digest: input.digest, publishedAt: at },
									...current.history.filter((release) => release.digest !== input.digest),
								].slice(0, MAX_TEMPLATE_BASE_HISTORY),
							},
				);
				if (published === undefined) continue;
			}
			break;
		}
		// Every template following the channel has a new key now: their rebuilds start in the background.
		const all = await fleet();
		for (const template of await store.templates.list()) {
			const base = template.spec.base ?? DEFAULT_TEMPLATE_BASE;
			if ("channel" in base && base.image === input.image && base.channel === input.channel) {
				await reconcile(template.id, all);
			}
		}
		return baseChannelView(published);
	}

	async function startFor(
		template: StoredTemplate,
		start: {
			readonly shape: BackendShape;
			readonly eligibleHosts: readonly string[];
			readonly restoreOn?: readonly string[];
		},
	): Promise<TemplateStart> {
		const { spec } = template;
		const { shape } = start;
		// Where its snapshots may be restored: with a disk asked for, only on a host that gives it that disk from one.
		const restores = (hostId: string): boolean =>
			shape.diskGb === undefined || start.restoreOn === undefined || start.restoreOn.includes(hostId);
		const [base, allRuntimes, entries] = await Promise.all([
			resolveBase(spec),
			runtimes(),
			store.templateSnapshots.list({ templateId: template.id }),
		]);
		const custom = (spec.image ?? DEFAULT_TEMPLATE_IMAGE).kind !== "kantel-base";
		// Only hosts that can boot templates (a host from before them would boot the default image instead); a custom
		// image's, only hosts that build them.
		const hostRuntimes = custom ? allRuntimes.filter((runtime) => runtime.customImages === true) : allRuntimes;
		const booting = new Set(hostRuntimes.map((runtime) => runtime.hostId));
		const eligible = start.eligibleHosts.filter((hostId) => booting.has(hostId));
		if (eligible.length === 0) {
			throw placementError(
				"not_supported",
				"no_host_for_template",
				custom
					? "No host this sandbox may use builds templates' custom images; switch a host's templateBuilder on"
					: "No host this sandbox may use can boot templates; upgrade its kantel-host",
			);
		}
		if (custom) return startCustom(template, start.shape, base, hostRuntimes, entries, eligible, restores);
		// A snapshot is the machine it was built as: only one built as this sandbox's shape will do, so a restore and a
		// fresh boot give it the same machine.
		const [snapshot] = newestFirst(
			entries.filter(
				(entry) =>
					(entry.state === "ready" || entry.state === "stale") &&
					entry.ref !== undefined &&
					entry.version === template.version &&
					entry.key.vcpus === shape.vcpus &&
					entry.key.memoryMb === shape.memoryMb &&
					entry.hostId !== undefined &&
					eligible.includes(entry.hostId) &&
					restores(entry.hostId) &&
					hostRuntimes.some(
						(runtime) =>
							runtime.hostId === entry.hostId &&
							runtime.kernel === entry.key.kernel &&
							runtime.firecracker === entry.key.firecracker,
					),
			),
			(entry) => entry.readyAt ?? entry.startedAt,
		);
		const boot: SandboxTemplateBoot = {
			baseImage: base.image,
			baseDigest: base.digest,
			...(spec.setup === undefined ? {} : { setup: spec.setup }),
			...(snapshot?.ref === undefined ? {} : { snapshot: snapshot.ref }),
		};
		// What it starts on: the base its snapshot was built from (a stale one's may be a release behind the channel), or the
		// resolved base a fresh boot boots. A snapshot that can't be restored boots fresh, and records `templateBootImage`.
		const image =
			snapshot === undefined
				? templateBootImage(boot)
				: templateBootImage({ baseImage: snapshot.builtFrom.baseImage, baseDigest: snapshot.builtFrom.baseDigest });
		return {
			eligibleHosts: eligible,
			boot,
			record: {
				id: template.id,
				name: template.name,
				version: template.version,
				...(snapshot === undefined ? {} : { snapshotId: snapshot.id }),
				start: snapshot === undefined ? "boot" : "snapshot",
			},
			image,
		};
	}

	/**
	 * How a sandbox made from a template with a custom image starts. A host boots one only from the root filesystem a
	 * build there made, so the create goes only to the hosts holding the image of the template's version its newest usable
	 * entry was built from (a rebuild's new image once one of its entries is ready): from that entry's snapshot when it was
	 * built as this shape, on its host, else booting that image fresh on one of them. None yet: `unavailable`, for trying
	 * again once a build is ready.
	 */
	async function startCustom(
		template: StoredTemplate,
		shape: BackendShape,
		base: ResolvedBase,
		hostRuntimes: readonly TemplateRuntime[],
		entries: readonly StoredTemplateSnapshot[],
		eligibleHosts: readonly string[],
		restores: (hostId: string) => boolean,
	): Promise<TemplateStart> {
		const { spec } = template;
		const image = spec.image as CustomSource["image"];
		const onRuntime = (entry: StoredTemplateSnapshot) =>
			hostRuntimes.some(
				(runtime) =>
					runtime.hostId === entry.hostId &&
					runtime.kernel === entry.key.kernel &&
					runtime.firecracker === entry.key.firecracker,
			);
		const usable = newestFirst(
			entries.filter(
				(entry) =>
					(entry.state === "ready" || entry.state === "stale") &&
					entry.ref !== undefined &&
					entry.rootfsKey !== undefined &&
					entry.key.imageDigest !== undefined &&
					entry.version === template.version &&
					entry.hostId !== undefined &&
					eligibleHosts.includes(entry.hostId) &&
					onRuntime(entry),
			),
			(entry) => (entry.state === "ready" ? 1 : 0) * 1e15 + (entry.readyAt ?? entry.startedAt),
		);
		const [newest] = usable;
		if (newest?.rootfsKey === undefined) {
			const message =
				"The template's image isn't built yet on a host this sandbox may use; try again once its build is ready";
			// Built, but only on hosts it may not use now: those hosts are the reason. Not built anywhere yet is no placement's.
			const heldElsewhere = entries.some(
				(entry) =>
					(entry.state === "ready" || entry.state === "stale") &&
					entry.rootfsKey !== undefined &&
					entry.version === template.version &&
					entry.hostId !== undefined &&
					!eligibleHosts.includes(entry.hostId),
			);
			throw heldElsewhere
				? placementError("unavailable", "host_unavailable", message)
				: new KantelError("unavailable", message);
		}
		// The image that entry was built from, on each host holding it: its root filesystem, and the digest the key covers.
		const same = usable.filter(
			(entry) => entry.rootfsKey === newest.rootfsKey && entry.key.imageDigest === newest.key.imageDigest,
		);
		const snapshot = same.find(
			(entry) =>
				entry.key.vcpus === shape.vcpus &&
				entry.key.memoryMb === shape.memoryMb &&
				entry.hostId !== undefined &&
				restores(entry.hostId),
		);
		const holding = [...new Set(same.map((entry) => entry.hostId as string))];
		// The snapshot's host first, then the others holding the image.
		const eligible =
			snapshot?.hostId === undefined ? holding : [snapshot.hostId, ...holding.filter((id) => id !== snapshot.hostId)];
		const boot: SandboxTemplateBoot = {
			baseImage: base.image,
			baseDigest: base.digest,
			image: backendImage(image, template.id, newest.version, cacheEpochOf(newest.id)),
			rootfsKey: newest.rootfsKey,
			...(newest.key.imageDigest === undefined ? {} : { imageDigest: newest.key.imageDigest }),
			...(spec.setup === undefined ? {} : { setup: spec.setup }),
			...(snapshot?.ref === undefined ? {} : { snapshot: snapshot.ref }),
		};
		return {
			eligibleHosts: eligible,
			boot,
			record: {
				id: template.id,
				name: template.name,
				version: template.version,
				...(snapshot === undefined ? {} : { snapshotId: snapshot.id }),
				start: snapshot === undefined ? "boot" : "snapshot",
			},
			image: templateBootImage(boot),
		};
	}

	/** The pass of `reconcileAll` under way, which another call joins rather than starting a second. */
	let reconciling: Promise<void> | undefined;
	function reconcileAll(): Promise<void> {
		if (!supported) return Promise.resolve();
		reconciling ??= (async () => {
			const all = await fleet();
			for (const template of await store.templates.list()) await reconcile(template.id, all);
			await retryDeletions();
		})().finally(() => {
			reconciling = undefined;
		});
		return reconciling;
	}

	const handlers: TemplateHandlers = {
		listTemplates: async (principal, { query }) => {
			requireTemplates();
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			let templates = (await store.templates.list({ accountId: account.id })).filter(
				(template) => live(template) !== undefined,
			);
			const digest = query.baseDigest;
			if (digest !== undefined) {
				const built = new Set(
					(await store.templateSnapshots.list({ accountId: account.id }))
						.filter((entry) => !thrownAway(entry) && entry.builtFrom.baseDigest === digest)
						.map((entry) => entry.templateId),
				);
				templates = templates.filter((template) => {
					const base = template.spec.base;
					return built.has(template.id) || (base !== undefined && "digest" in base && base.digest === digest);
				});
			}
			return { items: await Promise.all(templates.map(templateView)) };
		},

		createTemplate: async (principal, { body, idempotencyKey }) => {
			requireTemplates();
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			// Its name is the account's only once: a retry would be `conflict`, though the first call made it.
			return options.once(principal, "createTemplate", { body, idempotencyKey }, async () => {
				const spec = normaliseSpec(body.spec);
				await checkBase(spec.base ?? DEFAULT_TEMPLATE_BASE);
				const at = now();
				const id = randomId("tpl", 8);
				const createdBy = options.actorOf(principal);
				const template: StoredTemplate = {
					id,
					accountId: account.id,
					name: body.name,
					...(body.description === undefined || body.description === "" ? {} : { description: body.description }),
					version: 1,
					spec,
					cacheEpoch: 0,
					ownerUserId: principal.userId,
					createdAt: at,
					updatedAt: at,
					createdBy,
				};
				const version: StoredTemplateVersion = {
					id: templateVersionId(id, 1),
					templateId: id,
					version: 1,
					spec: copySpec(spec),
					createdAt: at,
					createdBy,
				};
				if (!(await naming(body.name, () => store.templateWrites.insert(template, version)))) {
					throw new KantelError("conflict", "A template with that ID exists");
				}
				await reconcile(id);
				return templateView(template);
			});
		},

		getTemplate: async (principal, { params }) =>
			templateView(await templateFor(principal, params.templateId, "account:read")),

		updateTemplate: async (principal, { params, body }) => {
			const template = await templateFor(principal, params.templateId, "account:admin");
			const spec = body.spec === undefined ? undefined : normaliseSpec(body.spec);
			// A base it already has stays allowed, a pinned digest its channels' histories have since dropped too.
			const base = spec?.base ?? DEFAULT_TEMPLATE_BASE;
			if (spec !== undefined && JSON.stringify(base) !== JSON.stringify(template.spec.base ?? DEFAULT_TEMPLATE_BASE)) {
				await checkBase(base);
			}
			const at = now();
			const createdBy = options.actorOf(principal);
			let versioned = false;
			// A new spec makes a version, written with the template (`templateWrites`); an unchanged one makes none.
			const changed = await naming(body.name ?? template.name, () =>
				store.templateWrites.update(template.id, (current) => {
					if (current.retiredAt !== undefined) return undefined;
					const { description: _kept, ...rest } = current;
					const description = body.description === undefined ? current.description : body.description;
					versioned = spec !== undefined && specKey(spec) !== specKey(current.spec);
					const next: StoredTemplate = {
						...rest,
						name: body.name ?? current.name,
						...(description === undefined || description === "" ? {} : { description }),
						...(versioned && spec !== undefined ? { version: current.version + 1, spec } : {}),
						updatedAt: Math.max(at, current.updatedAt + 1),
					};
					if (!versioned) return { template: next };
					const version: StoredTemplateVersion = {
						id: templateVersionId(next.id, next.version),
						templateId: next.id,
						version: next.version,
						spec: copySpec(next.spec),
						createdAt: at,
						createdBy,
					};
					return { template: next, version };
				}),
			);
			if (changed === undefined) throw new KantelError("not_found", "No such template");
			if (versioned) await reconcile(changed.id);
			return templateView(changed);
		},

		deleteTemplate: async (principal, { params }) => {
			const template = await templateFor(principal, params.templateId, "account:admin");
			await retire(template);
			return undefined;
		},

		listTemplateVersions: async (principal, { params }) => {
			const template = await templateFor(principal, params.templateId, "account:read");
			const versions = await store.templateVersions.list({ templateId: template.id });
			return {
				items: newestFirst(versions, (version) => version.version).map((version) => ({
					version: version.version,
					spec: copySpec(version.spec),
					createdAt: version.createdAt,
					createdBy: { ...version.createdBy },
				})),
			};
		},

		listTemplateSnapshots: async (principal, { params }) => {
			const template = await templateFor(principal, params.templateId, "account:read");
			const entries = await store.templateSnapshots.list({ templateId: template.id });
			return { items: newestFirst(entries, (entry) => entry.startedAt).map(templateSnapshotView) };
		},

		rebuildTemplate: async (principal, { params, idempotencyKey }) => {
			const template = await templateFor(principal, params.templateId, "account:admin");
			// A retry would start another epoch, setting aside the builds the first one started: with the key it answers that.
			return options.once(principal, "rebuildTemplate", { params, idempotencyKey }, async () => {
				// A new epoch first, so the builds it starts are new entries, never the ones set aside.
				const bumped = await store.templates.update(template.id, (current) =>
					current.retiredAt === undefined ? { ...current, cacheEpoch: current.cacheEpoch + 1 } : undefined,
				);
				if (bumped === undefined) throw new KantelError("not_found", "No such template");
				// Its ready snapshots stay usable, stale, until the rebuild's replace them; the rest are thrown away.
				for (const entry of await store.templateSnapshots.list({ templateId: template.id })) {
					// One of the new epoch's (or a later one's), claimed meanwhile by another reconcile, is the rebuild's own.
					if (cacheEpochOf(entry.id) < bumped.cacheEpoch) await setAside(entry);
				}
				await reconcile(template.id);
				return templateView(bumped);
			});
		},

		listTemplateBases: async () => {
			requireTemplates();
			return { items: (await store.templateBases.list()).map(baseChannelView) };
		},

		publishTemplateBase: async (principal, { body }) => {
			requireTemplates();
			requireScope(principal, "hosts:admin");
			return publishTemplateBase(body);
		},
	};

	return {
		handlers,
		requireTemplates,
		enabled: supported,
		templateIn,
		startFor,
		reconcileAll,
		async retireAccount(accountId) {
			for (const template of await store.templates.list({ accountId })) await retire(template);
		},
		publishTemplateBase,
	};
}
