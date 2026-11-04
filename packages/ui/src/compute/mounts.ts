// Words for read-only mounts (compute console, experimental), shared by a sandbox's Mounts and the Mounts page: a
// bundle's digest shortened for a row, each status's colour and label, how many sandboxes mount something, and why it
// can't be deleted yet. Kept apart from the pages so the tests read them without rendering anything.

import type { Status } from "../tokens/tokens.ts";
import type { BucketProvider, MountSource, MountStatus } from "./compute-model.ts";

/**
 * A digest shortened for a row, its algorithm kept: `sha256:3f2a…9c01`. One too short to shorten, or not a digest at
 * all, as it is.
 */
export function shortDigest(digest: string): string {
	const at = digest.indexOf(":");
	const algorithm = at === -1 ? "" : digest.slice(0, at + 1);
	const hex = digest.slice(at + 1);
	return hex.length <= 12 ? digest : `${algorithm}${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/** The status colour each mount status shows in: in progress while pending, done when ready, an error when failed. */
export const MOUNT_STATUS_STATUS: Readonly<Record<MountStatus, Status>> = {
	pending: "working",
	ready: "done",
	failed: "error",
};

export const MOUNT_STATUS_LABELS: Readonly<Record<MountStatus, string>> = {
	pending: "Pending",
	ready: "Ready",
	failed: "Failed",
};

export const MOUNT_KIND_LABELS: Readonly<Record<MountSource["kind"], string>> = {
	bundle: "Bundle",
	bucket: "Bucket",
};

export const BUCKET_PROVIDER_LABELS: Readonly<Record<BucketProvider, string>> = {
	s3: "S3",
	gcs: "GCS",
};

/** "1 sandbox", "2 sandboxes"; undefined for none, which a table shows as a dash. */
export function mountedByText(count: number): string | undefined {
	if (count <= 0) return undefined;
	return `${count.toLocaleString("en-GB")} ${count === 1 ? "sandbox" : "sandboxes"}`;
}

/**
 * Why a bundle or bucket source can't be deleted yet, as Kantel refuses it (`conflict`): "Mounted by 2 sandboxes;
 * delete them first". Undefined while nothing mounts it.
 */
export function inUseText(count: number): string | undefined {
	const sandboxes = mountedByText(count);
	if (sandboxes === undefined) return undefined;
	return `Mounted by ${sandboxes}; delete ${count === 1 ? "it" : "them"} first`;
}

/** Where a bucket mount's files are: `bucket/prefix` where the bucket is known, else the prefix; nothing for neither. */
export function bucketPathText(bucket: string | undefined, prefix: string): string | undefined {
	if (bucket === undefined) return prefix === "" ? undefined : prefix;
	return `${bucket}/${prefix}`;
}

/** An endpoint's host, `acct.r2.cloudflarestorage.com`, or the endpoint as it is where it isn't a URL. */
export function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).host || endpoint;
	} catch {
		return endpoint;
	}
}

/**
 * Where a bucket is, under its name: its endpoint's host and its region, as either is set: "acct.r2.cloudflarestorage.com,
 * region auto", "Region eu-west-1". Undefined for neither.
 */
export function bucketWhereText(endpoint: string | undefined, region: string | undefined): string | undefined {
	const host = endpoint === undefined || endpoint === "" ? undefined : endpointHost(endpoint);
	const hasRegion = region !== undefined && region !== "";
	if (host === undefined) return hasRegion ? `Region ${region}` : undefined;
	return hasRegion ? `${host}, region ${region}` : host;
}

/** What a bucket source's credentials are: set (never shown), or none, for a public bucket. */
export const credentialsText = (hasCredentials: boolean): string => (hasCredentials ? "Set" : "None (public)");
