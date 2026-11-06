/**
 * Base image patching (experimental, KANTEL_IMAGE_PATCHING=experimental): how far behind its channel the base a sandbox
 * or snapshot is on, as the API answers it (`SandboxBase`), and the gateways' cached read of the index CI publishes
 * (`base-images.ts`).
 *
 * A sandbox's base is what its backend reported: a host images version (`host-images-20261104.812`) for a sandbox on a
 * host, as hosts report versions rather than digests, or a container image's `sha256:` digest. A running sandbox is
 * never patched underneath; this only says how far behind it is.
 */
import type { computeSchema } from "@kantel/api";
import type { SharedSnapshotBytes } from "./backend.ts";
import { type BaseImageIndex, freshness, parseIndex } from "./base-images.ts";
import type { BaseReports, SnapshotSizeReport } from "./service.ts";

/** The index's entry for the microVM host images (kernel and root file systems), which hosts report by version. */
export const HOST_BASE_IMAGE = "host";
/** The index's entry for the container tier's image, which is reported by digest. */
export const SANDBOX_BASE_IMAGE = "sandbox";

/** Where the gateways read the index by default: the `base-images` GitHub Release that CI publishes it to. */
export const DEFAULT_BASE_IMAGE_INDEX =
	"https://github.com/lleverage-ai/kantel/releases/download/base-images/index.json";

/** How long a gateway reuses an index it read. CI publishes at most a few times a day, so minutes behind is fine. */
export const BASE_IMAGE_INDEX_TTL_MS = 5 * 60_000;
/** How long a gateway reuses a failure to read it, so a GitHub outage isn't asked on every request. */
export const BASE_IMAGE_INDEX_FAILURE_TTL_MS = 60_000;
/**
 * How long one read of the index may take, its body included: sandbox calls and host welcomes wait on it, so an
 * endpoint that stalls fails (and is kept as a failure) rather than holding them up.
 */
export const BASE_IMAGE_INDEX_TIMEOUT_MS = 10_000;

/** The base image index, for the compute service: undefined `baseImages` (`ComputeServiceOptions`) is the feature off. */
export interface BaseImages {
	/** The index; rejects with why it couldn't be read, which the admin list answers as its `error`. */
	index(): Promise<BaseImageIndex | undefined>;
	/** Where it is read from, which the admin list shows. */
	readonly indexUrl: string;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * How far `base` (a version or a `sha256:` digest) of `image` is behind the `stable` channel, as the API answers it, or
 * undefined when the index has no such image or channel, so nothing is said rather than something wrong. A version the
 * index doesn't list (too old, or never published) is outdated by `BASE_IMAGE_HISTORY` or more versions.
 */
export function baseStatus(
	index: BaseImageIndex,
	image: string,
	base: string,
	now: number,
): computeSchema.SandboxBase | undefined {
	const entry = index.images.find((candidate) => candidate.name === image);
	if (entry === undefined) return undefined;
	const byDigest = DIGEST.test(base);
	const listed = byDigest
		? entry.versions.find((version) => version.digest === base)
		: entry.versions.find((version) => version.version === base);
	// A version the index no longer lists has no digest to go by: an empty one matches nothing, so it reads as unlisted.
	const digest = byDigest ? base : (listed?.digest ?? "");
	const fresh = freshness(index, image, digest, now);
	if (fresh === undefined) return undefined;
	const version = fresh.version ?? (byDigest ? undefined : base);
	return {
		image,
		...(version === undefined ? {} : { version }),
		outdated: fresh.outdated,
		...(fresh.latest === undefined ? {} : { latest: { version: fresh.latest.version, builtAt: fresh.latest.builtAt } }),
		...(fresh.behind === undefined ? {} : { behind: { days: fresh.behind.days, versions: fresh.behind.versions } }),
		...(fresh.security === true ? { security: true } : {}),
	};
}

/**
 * The host images Kantel wants hosts on (a host welcome's `images`): the version the index's `host` entry's `stable`
 * channel names, at its repository (the release's download URL's parent). Undefined when it has none.
 */
export function hostImageChannel(
	index: BaseImageIndex,
): { readonly channel: string; readonly version: string; readonly url: string } | undefined {
	const entry = index.images.find((candidate) => candidate.name === HOST_BASE_IMAGE);
	const head = entry?.channels.stable;
	const version = head === undefined ? undefined : entry?.versions.find((candidate) => candidate.digest === head);
	if (entry === undefined || version === undefined) return undefined;
	return { channel: "stable", version: version.version, url: entry.repository };
}

/** The index entry a reported base is under: a digest is a container image's, a version the host images'. */
export const baseImageOf = (base: string): string => (DIGEST.test(base) ? SANDBOX_BASE_IMAGE : HOST_BASE_IMAGE);

/**
 * The index at `url`, read with `fetch` and `parseIndex` and kept for `BASE_IMAGE_INDEX_TTL_MS`; a failure is kept for
 * `BASE_IMAGE_INDEX_FAILURE_TTL_MS` and rejects every read meanwhile. Reads that come while one is under way share it.
 * A read, body and all, that takes longer than `timeoutMs` (`BASE_IMAGE_INDEX_TIMEOUT_MS`) is aborted and fails.
 * The gateways make one (KANTEL_BASE_IMAGE_INDEX) and hand it to the compute API and the host welcome alike.
 */
export function baseImageIndexReader(options: {
	readonly url: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly timeoutMs?: number;
}): BaseImages {
	const timeoutMs = options.timeoutMs ?? BASE_IMAGE_INDEX_TIMEOUT_MS;
	// Called as a plain function: a Worker's fetch refuses to be called as another object's method.
	const get = options.fetch ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	let kept:
		| { readonly until: number; readonly index: BaseImageIndex }
		| { readonly until: number; readonly error: Error }
		| undefined;
	let reading: Promise<BaseImageIndex> | undefined;
	const transfer = async (signal: AbortSignal): Promise<unknown> => {
		const response = await get(options.url, { headers: { accept: "application/json" }, signal });
		if (!response.ok) throw new Error(`it answered ${response.status}`);
		return response.json();
	};
	const read = async (): Promise<BaseImageIndex> => {
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Raced as well as aborted, so a fetch that doesn't heed its signal can't hold the read either.
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				const error = new Error(`it took longer than ${timeoutMs / 1000}s`);
				abort.abort(error);
				reject(error);
			}, timeoutMs);
		});
		try {
			const index = parseIndex(await Promise.race([transfer(abort.signal), expired]));
			kept = { until: now() + BASE_IMAGE_INDEX_TTL_MS, index };
			return index;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const failure = new Error(`The base image index at ${options.url} couldn't be read: ${reason}`);
			kept = { until: now() + BASE_IMAGE_INDEX_FAILURE_TTL_MS, error: failure };
			throw failure;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	return {
		indexUrl: options.url,
		async index() {
			if (kept !== undefined && now() < kept.until) {
				if ("error" in kept) throw kept.error;
				return kept.index;
			}
			reading ??= read().finally(() => {
				reading = undefined;
			});
			return reading;
		},
	};
}

/**
 * KANTEL_IMAGE_PATCHING: `experimental` turns image patching on; unset, empty or `off` leaves it off. Anything else is a
 * mistake worth stopping for, so a typo can't leave it off unnoticed (as KANTEL_ACCOUNT_HOSTS is read).
 */
export function imagePatchingSwitch(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase() ?? "";
	if (value === "" || value === "off") return false;
	if (value === "experimental") return true;
	throw new Error("KANTEL_IMAGE_PATCHING is `experimental` or `off`");
}

/** KANTEL_BASE_IMAGE_INDEX, or `DEFAULT_BASE_IMAGE_INDEX`: an http(s) URL. */
export function baseImageIndexUrl(raw: string | undefined): string {
	const value = raw?.trim() ?? "";
	if (value === "") return DEFAULT_BASE_IMAGE_INDEX;
	if (!/^https?:\/\/\S+$/.test(value)) throw new Error("KANTEL_BASE_IMAGE_INDEX is an http(s) URL");
	return value;
}

/** What a gateway's hosts link (`HostComputeLink`) needs of the compute service for its hosts' snapshot reports. */
export interface HostSnapshotReporting {
	recordBases(hostId: string, reports: BaseReports): Promise<void>;
	recordSnapshotSizes(
		hostId: string,
		sizes: readonly SnapshotSizeReport[],
		shared?: readonly SharedSnapshotBytes[],
	): Promise<void>;
}

/**
 * The parts of a gateway's hosts link that pass on what hosts report of their snapshots: their sizes on the disk,
 * always, and with image patching on (`baseImages`, the gateway's cached read of the index), the images hosts should
 * be on and the bases they report. Both gateways build their link with it, so neither leaves the sizes behind the
 * image patching switch.
 */
export function hostSnapshotLinks(
	service: HostSnapshotReporting,
	baseImages: { index(): Promise<BaseImageIndex | undefined> } | undefined,
) {
	return {
		recordSnapshotSizes: (
			hostId: string,
			sizes: readonly SnapshotSizeReport[],
			shared?: readonly SharedSnapshotBytes[],
		) => service.recordSnapshotSizes(hostId, sizes, shared),
		...(baseImages === undefined
			? {}
			: {
					images: async () => {
						const index = await baseImages.index();
						return index === undefined ? undefined : hostImageChannel(index);
					},
					recordBases: (hostId: string, reports: BaseReports) => service.recordBases(hostId, reports),
				}),
	};
}
