/**
 * Read-only mounts (experimental, `KANTEL_MOUNTS=experimental`): the interfaces the rest of the compute plane and the
 * hosts' side use. A sandbox's create names its mounts (`computeSchema.Mount`); the service checks them, keeps them on
 * the sandbox with a status each, and hands them to the backend (`SandboxSpec.mounts`, `BootOptions.mounts`). The
 * backend's hosts fetch what they need by name, never with the spec:
 *
 * - a bundle's tar by digest, from the `BundleBlobStore` (`ComputeService.bundleForHost`; over HTTP at
 *   `GET /v1/hosts/bundles/{digest}?sandboxId=…` with the host's credential);
 * - a bucket source's settings and opened credentials by ID (`ComputeService.bucketSourceForHost`; `bucket.fetch`
 *   over the host's link).
 *
 * Both answer only the host the sandbox is on (or is being placed on, while it starts), and only for a source the
 * sandbox mounts, so a host learns nothing of another host's sandboxes.
 */

/** A bundle's bytes as stored. */
export interface StoredBlob {
	readonly sizeBytes: number;
	readonly body: ReadableStream<Uint8Array>;
}

/**
 * Where bundles' tars are kept, by digest (`sha256:<hex>`), once however many accounts upload the same bytes: a
 * directory self-hosted (`@kantel/compute/bundles`'s `createDirBundleStore`), memory in tests.
 */
export interface BundleBlobStore {
	/**
	 * Streams `body` in, hashing it as it comes, and keeps it under its digest; bytes it has already are kept once.
	 * Rejects with `invalid` past `maxBytes`, or when the digest isn't `expectDigest`, keeping nothing.
	 */
	put(
		body: ReadableStream<Uint8Array>,
		options: { readonly maxBytes: number; readonly expectDigest?: string },
	): Promise<{ readonly digest: string; readonly sizeBytes: number }>;
	/** The bytes stored under `digest`, or undefined. */
	open(digest: string): Promise<StoredBlob | undefined>;
	/** Forgets the bytes; nothing stored is not an error. */
	delete(digest: string): Promise<void>;
}

/** The largest bundle by default: 2 GiB. */
export const DEFAULT_MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;

/** Mounts' settings on a deployment that turned them on. */
export interface MountsOptions {
	readonly bundles: BundleBlobStore;
	/** Default `DEFAULT_MAX_BUNDLE_BYTES`. */
	readonly maxBundleBytes?: number;
	/** The largest archive `extractArchive` takes, in bytes of its files. Default 4 GiB. */
	readonly maxArchiveBytes?: number;
}

/** A bucket source as a host is given it: its settings and its credentials, opened. Never sent to a sandbox. */
export interface ResolvedBucketSource {
	readonly id: string;
	readonly provider: "s3" | "gcs";
	readonly bucket: string;
	readonly endpoint?: string;
	readonly region?: string;
	readonly credentials?:
		| { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
		| { readonly serviceAccountKey: string };
}

/** The path of a signed file URL, under the API's base path: `/v1/file-urls/{token}`. */
export const FILE_URL_PATH = "/file-urls";
