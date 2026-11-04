/**
 * Base image patching (experimental, KANTEL_IMAGE_PATCHING=experimental): the index of Kantel's base images that CI
 * publishes (.github/workflows/sandbox-image.yml), what each version's CVE scan found, and how far behind its channel a
 * digest is. Pure functions with no imports, so the workflow's scripts (tools/base-images) run them with Node's type
 * stripping, and the gateway reads the same shapes.
 *
 * The index is one JSON document, `index.json` on the `base-images` GitHub Release, with a Sigstore bundle beside it
 * (`index.json.sigstore.json`, `cosign sign-blob` keyless from the workflow). Each image has its channels (`stable`
 * names a digest) and its newest versions, newest first, each with the scan of it. A version is immutable: its digest
 * never changes, and a channel moves by naming another digest.
 */

/** The index's format; bumped on an incompatible change. */
export const BASE_IMAGE_INDEX_VERSION = 1;

/** How many versions of each image the index keeps; older ones still pull by digest, but count as this many behind. */
export const BASE_IMAGE_HISTORY = 30;

/** How many High and Critical findings a version's scan keeps in the index, most severe first. */
export const BASE_IMAGE_FINDINGS = 50;

export type ScanSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export const SCAN_SEVERITIES: readonly ScanSeverity[] = ["critical", "high", "medium", "low", "unknown"];

/** One vulnerability a scan found in an image. */
export interface ImageFinding {
	/** `CVE-2026-1234`, or the scanner's own ID where there is no CVE. */
	readonly id: string;
	readonly severity: ScanSeverity;
	/** The package it is in, such as `openssl` or `libssl3t64`. */
	readonly package: string;
	readonly installed: string;
	/** The version that fixes it, where one is out: the finding is fixable. */
	readonly fixed?: string;
	readonly title?: string;
}

/** What a CVE scan of one version found. */
export interface ImageScan {
	/** `trivy 0.68.1`. */
	readonly scanner: string;
	/** ISO 8601. */
	readonly scannedAt: string;
	/** Every finding, by severity. */
	readonly counts: { readonly [severity in ScanSeverity]: number };
	/** Critical and High findings with a fix out: what triggers an immediate rebuild. */
	readonly fixable: { readonly critical: number; readonly high: number };
	/** Critical and High findings, most severe first, at most `BASE_IMAGE_FINDINGS`. */
	readonly findings: readonly ImageFinding[];
}

/** Why a version was built. */
export type BuildReason = "daily" | "cve" | "manual" | "push";

/** One build of an image, published by its digest. */
export interface BaseImageVersion {
	/** Its tag, such as `2026.11.04.1`. */
	readonly version: string;
	/** `sha256:…`: the image's index (manifest list) digest, which pulls it. */
	readonly digest: string;
	/** ISO 8601. */
	readonly builtAt: string;
	/** The commit it was built from. */
	readonly commit?: string;
	readonly reason?: BuildReason;
	/** Signed with cosign, keyless, by the workflow. */
	readonly signed: boolean;
	/** The newest scan of it; absent until it has been scanned. */
	readonly scan?: ImageScan;
}

export interface BaseImageEntry {
	/** `sandbox`, `browser`, `isolate-host`, or `host` for the microVM host images (kernel, root file systems). */
	readonly name: string;
	/** Where it pulls from: `ghcr.io/lleverage-ai/kantel-sandbox`; for `host`, the release's download URL's parent. */
	readonly repository: string;
	/** Each channel's digest: `{"stable": "sha256:…"}`. */
	readonly channels: { readonly [channel: string]: string };
	/** Newest first, at most `BASE_IMAGE_HISTORY`. */
	readonly versions: readonly BaseImageVersion[];
}

export interface BaseImageIndex {
	readonly version: number;
	/** ISO 8601. */
	readonly generatedAt: string;
	readonly images: readonly BaseImageEntry[];
}

/** An empty index, for the first build. */
export const emptyIndex = (at: string): BaseImageIndex => ({
	version: BASE_IMAGE_INDEX_VERSION,
	generatedAt: at,
	images: [],
});

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const severityOf = (value: unknown): ScanSeverity => {
	const lower = typeof value === "string" ? value.toLowerCase() : "";
	return (SCAN_SEVERITIES as readonly string[]).includes(lower) ? (lower as ScanSeverity) : "unknown";
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Reads an index, refusing one of another format or with a malformed digest; unknown fields are dropped. */
export function parseIndex(raw: unknown): BaseImageIndex {
	if (!isObject(raw) || raw.version !== BASE_IMAGE_INDEX_VERSION || !Array.isArray(raw.images)) {
		throw new Error(`Not a base image index of version ${BASE_IMAGE_INDEX_VERSION}`);
	}
	const images = raw.images.map((image): BaseImageEntry => {
		if (!isObject(image) || typeof image.name !== "string" || typeof image.repository !== "string") {
			throw new Error("A base image needs a name and a repository");
		}
		const channels: { [channel: string]: string } = {};
		if (isObject(image.channels)) {
			for (const [channel, digest] of Object.entries(image.channels)) {
				if (typeof digest !== "string" || !DIGEST.test(digest)) throw new Error(`${image.name}: bad ${channel} digest`);
				channels[channel] = digest;
			}
		}
		const versions = (Array.isArray(image.versions) ? image.versions : []).map((entry): BaseImageVersion => {
			if (!isObject(entry) || typeof entry.version !== "string" || typeof entry.digest !== "string") {
				throw new Error(`${image.name}: a version needs a version and a digest`);
			}
			if (!DIGEST.test(entry.digest)) throw new Error(`${image.name} ${entry.version}: bad digest`);
			const scan = isObject(entry.scan) ? parseScan(entry.scan) : undefined;
			return {
				version: entry.version,
				digest: entry.digest,
				builtAt: typeof entry.builtAt === "string" ? entry.builtAt : new Date(0).toISOString(),
				...(typeof entry.commit === "string" ? { commit: entry.commit } : {}),
				...(typeof entry.reason === "string" && ["daily", "cve", "manual", "push"].includes(entry.reason)
					? { reason: entry.reason as BuildReason }
					: {}),
				signed: entry.signed === true,
				...(scan === undefined ? {} : { scan }),
			};
		});
		return { name: image.name, repository: image.repository, channels, versions };
	});
	return {
		version: BASE_IMAGE_INDEX_VERSION,
		generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date(0).toISOString(),
		images,
	};
}

function parseScan(raw: { readonly [key: string]: unknown }): ImageScan {
	const counts = isObject(raw.counts) ? raw.counts : {};
	const fixable = isObject(raw.fixable) ? raw.fixable : {};
	const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		scanner: typeof raw.scanner === "string" ? raw.scanner : "unknown",
		scannedAt: typeof raw.scannedAt === "string" ? raw.scannedAt : new Date(0).toISOString(),
		counts: {
			critical: number(counts.critical),
			high: number(counts.high),
			medium: number(counts.medium),
			low: number(counts.low),
			unknown: number(counts.unknown),
		},
		fixable: { critical: number(fixable.critical), high: number(fixable.high) },
		findings: (Array.isArray(raw.findings) ? raw.findings : []).filter(isObject).map((finding) => ({
			id: String(finding.id ?? "unknown"),
			severity: severityOf(finding.severity),
			package: String(finding.package ?? ""),
			installed: String(finding.installed ?? ""),
			...(typeof finding.fixed === "string" && finding.fixed !== "" ? { fixed: finding.fixed } : {}),
			...(typeof finding.title === "string" ? { title: finding.title } : {}),
		})),
	};
}

/**
 * A Trivy JSON report (`trivy image --format json`) summed up for the index: counts by severity, the fixable Critical
 * and High, and the Critical and High findings themselves (one per ID and package), most severe first.
 */
export function summariseTrivy(report: unknown, scanner: string, scannedAt: string): ImageScan {
	const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
	const fixable = { critical: 0, high: 0 };
	const findings: ImageFinding[] = [];
	const seen = new Set<string>();
	const results = isObject(report) && Array.isArray(report.Results) ? report.Results : [];
	for (const result of results) {
		if (!isObject(result) || !Array.isArray(result.Vulnerabilities)) continue;
		for (const vuln of result.Vulnerabilities) {
			if (!isObject(vuln)) continue;
			const id = String(vuln.VulnerabilityID ?? "unknown");
			const pkg = String(vuln.PkgName ?? "");
			// Trivy lists one vulnerability once per package and target; an image's layers can repeat a package.
			const key = `${id} ${pkg} ${String(vuln.InstalledVersion ?? "")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const severity = severityOf(vuln.Severity);
			counts[severity] += 1;
			const fixed = typeof vuln.FixedVersion === "string" && vuln.FixedVersion !== "" ? vuln.FixedVersion : undefined;
			if (fixed !== undefined && (severity === "critical" || severity === "high")) fixable[severity] += 1;
			if (severity === "critical" || severity === "high") {
				findings.push({
					id,
					severity,
					package: pkg,
					installed: String(vuln.InstalledVersion ?? ""),
					...(fixed === undefined ? {} : { fixed }),
					...(typeof vuln.Title === "string" ? { title: vuln.Title } : {}),
				});
			}
		}
	}
	const rank = (finding: ImageFinding) =>
		(finding.severity === "critical" ? 0 : 2) + (finding.fixed === undefined ? 1 : 0);
	findings.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id) || a.package.localeCompare(b.package));
	return { scanner, scannedAt, counts, fixable, findings: findings.slice(0, BASE_IMAGE_FINDINGS) };
}

/** Whether a scan calls for an immediate rebuild: a Critical or High finding with a fix out. */
export const needsRebuild = (scan: ImageScan | undefined): boolean =>
	scan !== undefined && scan.fixable.critical + scan.fixable.high > 0;

/** A build to record: the image's new version, and the channels to move to it. */
export interface PublishedBuild {
	readonly name: string;
	readonly repository: string;
	readonly version: BaseImageVersion;
	/** The channels that now name this version's digest; usually `["stable"]`. */
	readonly channels: readonly string[];
}

/**
 * The index with a build recorded: its version first in its image's list (replacing one of the same digest, so a
 * re-run keeps one entry), the list cut to `BASE_IMAGE_HISTORY`, and its channels moved to its digest.
 */
export function recordBuild(index: BaseImageIndex, build: PublishedBuild, at: string): BaseImageIndex {
	const existing = index.images.find((image) => image.name === build.name);
	const versions = [build.version, ...(existing?.versions ?? []).filter((v) => v.digest !== build.version.digest)];
	const channels = { ...(existing?.channels ?? {}) };
	for (const channel of build.channels) channels[channel] = build.version.digest;
	const entry: BaseImageEntry = {
		name: build.name,
		repository: build.repository,
		channels,
		versions: versions.slice(0, BASE_IMAGE_HISTORY),
	};
	const images = existing === undefined
		? [...index.images, entry].sort((a, b) => a.name.localeCompare(b.name))
		: index.images.map((image) => (image.name === build.name ? entry : image));
	return { version: BASE_IMAGE_INDEX_VERSION, generatedAt: at, images };
}

/** The index with a fresh scan recorded on one version (a rescan of what a channel names, with a newer database). */
export function recordScan(
	index: BaseImageIndex,
	name: string,
	digest: string,
	scan: ImageScan,
	at: string,
): BaseImageIndex {
	return {
		version: BASE_IMAGE_INDEX_VERSION,
		generatedAt: at,
		images: index.images.map((image) =>
			image.name !== name
				? image
				: { ...image, versions: image.versions.map((v) => (v.digest === digest ? { ...v, scan } : v)) },
		),
	};
}

/** How far a digest is behind what its channel names now. */
export interface BaseFreshness {
	readonly image: string;
	readonly channel: string;
	/** The digest it was built from or boots on. */
	readonly digest: string;
	/** Its version, where the index still lists it. */
	readonly version?: string;
	/** Not what the channel names now. */
	readonly outdated: boolean;
	/** What the channel names now. */
	readonly latest?: { readonly version: string; readonly digest: string; readonly builtAt: string };
	/**
	 * How far behind: whole days from when the next version out was built (when this one was first superseded) to `now`,
	 * and how many versions are newer. A digest the index no longer lists is `BASE_IMAGE_HISTORY` or more versions behind.
	 */
	readonly behind?: { readonly days: number; readonly versions: number };
	/** A newer version fixes Critical or High findings this one has. */
	readonly security?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far `digest` of `name` is behind `channel` (default `stable`). Undefined when the index has no such image or
 * channel, so a caller says nothing rather than something wrong.
 */
export function freshness(
	index: BaseImageIndex,
	name: string,
	digest: string,
	now: number,
	channel = "stable",
): BaseFreshness | undefined {
	const image = index.images.find((entry) => entry.name === name);
	const head = image?.channels[channel];
	if (image === undefined || head === undefined) return undefined;
	const headAt = image.versions.findIndex((v) => v.digest === head);
	const latest = headAt === -1 ? undefined : image.versions[headAt];
	const latestRef =
		latest === undefined ? undefined : { version: latest.version, digest: latest.digest, builtAt: latest.builtAt };
	const at = image.versions.findIndex((v) => v.digest === digest);
	const own = at === -1 ? undefined : image.versions[at];
	if (digest === head) {
		return {
			image: name,
			channel,
			digest,
			...(own === undefined ? {} : { version: own.version }),
			outdated: false,
			...(latestRef === undefined ? {} : { latest: latestRef }),
		};
	}
	const start = headAt === -1 ? 0 : headAt;
	const versions = at === -1 ? Math.max(BASE_IMAGE_HISTORY, image.versions.length - start) : Math.max(1, at - start);
	// Superseded when the version after it was built; unknown (no longer listed): the oldest one listed.
	const next = at === -1 ? image.versions.at(-1) : image.versions[at - 1];
	const since = next === undefined ? Number.NaN : Date.parse(next.builtAt);
	const days = Number.isNaN(since) ? 0 : Math.max(0, Math.floor((now - since) / DAY_MS));
	const ownFindings = own?.scan === undefined ? undefined : own.scan.fixable.critical + own.scan.fixable.high;
	const newer = image.versions.slice(start, at === -1 ? undefined : at);
	const security =
		ownFindings !== undefined &&
		ownFindings > 0 &&
		latest?.scan !== undefined &&
		latest.scan.fixable.critical + latest.scan.fixable.high < ownFindings &&
		newer.length > 0;
	return {
		image: name,
		channel,
		digest,
		...(own === undefined ? {} : { version: own.version }),
		outdated: true,
		...(latestRef === undefined ? {} : { latest: latestRef }),
		behind: { days, versions },
		...(security ? { security } : {}),
	};
}
