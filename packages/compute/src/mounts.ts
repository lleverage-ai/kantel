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
 * A body a `BundleBlobStore` has taken in and checked, staged: kept as one generation of its digest or more (`keep`),
 * until it is let go (`discard`).
 */
export interface StagedBlob {
	readonly digest: string;
	readonly sizeBytes: number;
	/**
	 * Keeps the bytes as `generation` of the digest, which `open` and `delete` then name; bytes kept there already stay
	 * (they are the same bytes). May be called again, for another generation, until `discard`.
	 */
	keep(generation: number): Promise<void>;
	/** Lets the staged copy go; the generations it was kept as stay. */
	discard(): Promise<void>;
}

/**
 * Where bundles' tars are kept, by digest (`sha256:<hex>`) and generation: a directory self-hosted
 * (`@kantel/compute/bundles`'s `createDirBundleStore`), memory in tests.
 *
 * A generation is a whole number the compute plane picks for each upload, and the bundle record that upload publishes
 * owns it alone (`StoredBundle.generation`): an account has a digest once, so its bytes are kept once, and no record's
 * bytes are ever another's to remove. Generation 0 is where bytes were kept before there were generations.
 */
export interface BundleBlobStore {
	/**
	 * Streams `body` in, hashing it as it comes, and stages it. Rejects with `invalid` past `maxBytes`, or when the digest
	 * isn't `expectDigest`, keeping nothing.
	 */
	put(
		body: ReadableStream<Uint8Array>,
		options: { readonly maxBytes: number; readonly expectDigest?: string },
	): Promise<StagedBlob>;
	/** The bytes kept as `generation` of `digest`, or undefined. */
	open(digest: string, generation: number): Promise<StoredBlob | undefined>;
	/** Forgets the bytes kept as `generation` of `digest`; nothing stored is not an error. */
	delete(digest: string, generation: number): Promise<void>;
	/**
	 * Leaves `id` in the store, as `marked` then finds it: how a gateway tells that its store is the one the deployment's
	 * bundle records were kept in (`StoredSetting` `bundleStore`), as every gateway over one database must share it.
	 */
	mark(id: string): Promise<void>;
	/** Whether `mark` left `id` in this store. */
	marked(id: string): Promise<boolean>;
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
