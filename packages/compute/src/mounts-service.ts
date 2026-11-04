/**
 * Mounts' part of the compute service (experimental, `KANTEL_MOUNTS=experimental`): bundles, bucket sources, a
 * sandbox's mounts as its create names them, signed file URLs and archive extraction, and what a host asks for (a
 * bundle's tar, a bucket source's credentials) or reports (its mounts' statuses). `service.ts` makes one when the
 * deployment turned mounts on, and answers `not_supported` for all of it when not.
 */
import type { computeSchema, RouteHandlers, SignedInComputeRoutes } from "@kantel/api";
import {
	DEFAULT_FILE_URL_TTL_SECONDS,
	KantelError,
	mountCovering,
	mountPathsProblem,
	mountsTouching,
} from "@kantel/contracts";
import { actingAccount, type Principal, requireScope, roleIn } from "./auth.ts";
import {
	type BackendMount,
	type BackendMountStatus,
	MAX_UNSTREAMED_WRITE_BYTES,
	type SandboxBackend,
} from "./backend.ts";
import {
	DEFAULT_MAX_BUNDLE_BYTES,
	FILE_URL_PATH,
	type MountsOptions,
	type ResolvedBucketSource,
	type StagedBlob,
	type StoredBlob,
} from "./mounts.ts";
import { type Sealer, sealedAt } from "./secrets.ts";
import type {
	Collection,
	ComputeStore,
	DeleteClaim,
	StoredBucketSource,
	StoredBundle,
	StoredBundleBlob,
	StoredSandbox,
} from "./store.ts";
import { gunzipIfGzipped, TarCheck } from "./tar.ts";
import { randomId, randomSecret, randomSlug, resolvePath, sha256Hex } from "./util.ts";

/** The largest archive by default, in bytes of its files: 4 GiB. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
/** A part of a file read at a time when a backend can't stream it (`readFileStream`). */
const READ_PART_BYTES = 1024 * 1024;

type MountRoutes =
	| "createUploadUrl"
	| "createDownloadUrl"
	| "extractArchive"
	| "uploadBundle"
	| "listBundles"
	| "getBundle"
	| "deleteBundle"
	| "createBucketSource"
	| "listBucketSources"
	| "getBucketSource"
	| "deleteBucketSource";

export type MountHandlers = Pick<RouteHandlers<SignedInComputeRoutes, Principal>, MountRoutes>;

/** What the mounts part needs of the service. */
export interface MountsDeps {
	readonly store: ComputeStore;
	readonly backend: SandboxBackend;
	readonly options: MountsOptions;
	readonly now: () => number;
	readonly sealer: () => Sealer;
	/** The control plane's public URL, with no trailing slash, for a request. */
	readonly publicUrl: (request: Request) => string;
	/** The API's base path, such as `/v1`, with no trailing slash: where the file URL route is served. */
	readonly apiBasePath: string;
	/** The sandbox, if `principal` may use it with `scope` (`not_found` otherwise). */
	readonly sandboxFor: (
		principal: Principal,
		sandboxId: string,
		scope: computeSchema.ApiKeyScope,
	) => Promise<{ readonly sandbox: StoredSandbox }>;
	/** The sandbox once its queued work ends, refused (`conflict`) unless it is running. */
	readonly requireRunning: (principal: Principal, sandboxId: string) => Promise<StoredSandbox>;
}

/**
 * How long a delete's claim on a source (or on a bundle's bytes) holds off creates and uploads, should the delete never
 * finish because its gateway went away. A delete takes far less.
 */
const DELETE_CLAIM_MS = 60_000;
/** How long an upload's lease on a bundle's bytes keeps them, should it never let go. */
const BLOB_LEASE_MS = 5 * 60_000;
/** How long an upload waits for a removal of the same bytes to end before giving up. */
const BLOB_WAIT_MS = 30_000;
/** The generation a digest's bytes are first kept as (`StoredBundleBlob.generation`); 0 is from before there were any. */
const FIRST_GENERATION = 1;

/** A backend's refusal of a stream it can't make, as opposed to a stream that failed. */
const unsupported = (error: unknown) => error instanceof KantelError && error.code === "not_supported";

/**
 * `body` behind a stream that reads it only when it is read, and says whether it was: a backend that refuses before
 * reading any of it leaves `body` whole for another try.
 */
function untouched(body: ReadableStream<Uint8Array>) {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let touched = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				touched = true;
				reader ??= body.getReader();
				const next = await reader.read();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			cancel(reason) {
				touched = true;
				return (reader ?? body).cancel(reason);
			},
		},
		// Nothing read ahead: only a read pulls.
		{ highWaterMark: 0 },
	);
	return { stream, touched: () => touched };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A bundle record's ID: an account has a digest once. */
export const bundleKey = (accountId: string, digest: string) => `${accountId}/${digest}`;
const credentialsAad = (id: string) => sealedAt("bucketSources", id, "credentials");

/** Why a host didn't answer for a mount it was given: it predates mounts, or that kind of them. */
export const unanswered = (mount: computeSchema.Mount): string =>
	mount.source.kind === "bundle" ? "This host can't mount bundles yet" : "This host can't mount buckets yet";

/**
 * A sandbox's mounts once its backend placed it: each the status the backend answered for its path, or `failed` when
 * it answered none, so a backend that predates mounts never leaves one looking mounted.
 */
export function mountsAfter(
	mounts: readonly computeSchema.SandboxMount[] | undefined,
	reported: readonly BackendMountStatus[] | undefined,
): computeSchema.SandboxMount[] | undefined {
	if (mounts === undefined || mounts.length === 0) return undefined;
	const byPath = new Map((reported ?? []).map((status) => [status.path, status]));
	return mounts.map((mount) => {
		const status = byPath.get(mount.path);
		const { error: _old, ...rest } = mount;
		if (status === undefined) return { ...rest, status: "failed", error: unanswered(mount) };
		return { ...rest, status: status.status, ...(status.error === undefined ? {} : { error: status.error }) };
	});
}

/** A sandbox's mounts as its backend is given them: no statuses. */
export const backendMounts = (mounts: readonly computeSchema.SandboxMount[] | undefined): BackendMount[] | undefined =>
	mounts === undefined || mounts.length === 0
		? undefined
		: mounts.map((mount) => ({ path: mount.path, source: { ...mount.source } }));

/** The same mounts, all `pending` again, for a boot. */
export const pendingMounts = (
	mounts: readonly computeSchema.SandboxMount[] | undefined,
): computeSchema.SandboxMount[] | undefined =>
	mounts === undefined || mounts.length === 0
		? undefined
		: mounts.map((mount) => ({ path: mount.path, source: { ...mount.source }, status: "pending" }));

const mountsOfSource = (sandbox: StoredSandbox, matches: (source: computeSchema.MountSource) => boolean) =>
	sandbox.state !== "deleted" && (sandbox.mounts ?? []).some((mount) => matches(mount.source));

/**
 * A host's later word on a sandbox's mounts (`ComputeService.reportMounts`): each status replaces the one at its path.
 * Dropped unless the sandbox is on `hostId`; a path it doesn't mount is ignored.
 */
export async function reportMountStatuses(
	store: ComputeStore,
	hostId: string,
	sandboxId: string,
	reported: readonly BackendMountStatus[],
): Promise<void> {
	const byPath = new Map(reported.map((status) => [status.path, status]));
	await store.sandboxes.update(sandboxId, (current) => {
		if (current.hostId !== hostId || current.state === "deleted" || current.mounts === undefined) return undefined;
		let changed = false;
		const mounts = current.mounts.map((mount) => {
			const status = byPath.get(mount.path);
			if (
				status === undefined ||
				(status.status !== "pending" && status.status !== "ready" && status.status !== "failed")
			) {
				return mount;
			}
			changed = true;
			const { error: _old, ...rest } = mount;
			const error = typeof status.error === "string" ? status.error.slice(0, 1000) : undefined;
			return { ...rest, status: status.status, ...(error === undefined ? {} : { error }) };
		});
		return changed ? { ...current, mounts } : undefined;
	});
}

export function createMounts(deps: MountsDeps) {
	const { store, backend, options, now } = deps;
	const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
	const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;

	/** How many of an account's sandboxes mount a source; a list passes its sandboxes, read once for all its items. */
	async function mountedBy(
		accountId: string,
		matches: (source: computeSchema.MountSource) => boolean,
		listed?: readonly StoredSandbox[],
	) {
		const sandboxes = listed ?? (await store.sandboxes.list({ accountId }));
		return sandboxes.filter((sandbox) => mountsOfSource(sandbox, matches)).length;
	}

	const bundleMatches = (digest: string) => (source: computeSchema.MountSource) =>
		source.kind === "bundle" && source.digest === digest;
	const bucketMatches = (id: string) => (source: computeSchema.MountSource) =>
		source.kind === "bucket" && source.bucketSourceId === id;

	const bundleView = async (
		bundle: StoredBundle,
		listed?: readonly StoredSandbox[],
	): Promise<computeSchema.Bundle> => ({
		digest: bundle.digest,
		accountId: bundle.accountId,
		sizeBytes: bundle.sizeBytes,
		mountedBy: await mountedBy(bundle.accountId, bundleMatches(bundle.digest), listed),
		createdAt: bundle.createdAt,
	});

	const bucketView = async (
		source: StoredBucketSource,
		listed?: readonly StoredSandbox[],
	): Promise<computeSchema.BucketSource> => ({
		id: source.id,
		accountId: source.accountId,
		name: source.name,
		provider: source.provider,
		bucket: source.bucket,
		...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
		...(source.region === undefined ? {} : { region: source.region }),
		hasCredentials: source.credentials !== undefined,
		mountedBy: await mountedBy(source.accountId, bucketMatches(source.id), listed),
		createdAt: source.createdAt,
	});

	async function bundleFor(
		principal: Principal,
		account: string | undefined,
		digest: string,
		scope: computeSchema.ApiKeyScope,
	) {
		const { account: acting, role } = await actingAccount(store, principal, account);
		requireScope(principal, scope, role);
		const bundle = await store.bundles.get(bundleKey(acting.id, digest));
		if (bundle === undefined) throw new KantelError("not_found", "No such bundle");
		return bundle;
	}

	async function bucketSourceFor(principal: Principal, id: string, scope: computeSchema.ApiKeyScope) {
		const source = await store.bucketSources.get(id);
		if (source === undefined) throw new KantelError("not_found", "No such bucket source");
		const role = await roleIn(store, principal, source.accountId);
		if (role === undefined) throw new KantelError("not_found", "No such bucket source");
		requireScope(principal, scope, role);
		return source;
	}

	/**
	 * A host may hear of a sandbox when it is on it, or, while it starts, when the backend's scheduler placed it there:
	 * the placement is recorded before the host is asked to boot it, so the host can fetch its mounts' sources during
	 * the boot, and no other host can, whoever's it is.
	 */
	async function hostMayServe(hostId: string, sandbox: StoredSandbox | undefined): Promise<boolean> {
		if (sandbox === undefined || sandbox.state === "deleted") return false;
		if (sandbox.state === "starting" && backend.placedOn !== undefined) {
			// Its stored host may be the one it ran on before a stop: the placement is where it is going now.
			const placed = await backend.placedOn(sandbox.id).catch(() => undefined);
			return placed !== undefined && placed === hostId;
		}
		return sandbox.hostId !== undefined && sandbox.hostId === hostId;
	}

	const claimed = (record: { readonly deleting?: DeleteClaim }) =>
		record.deleting !== undefined && now() - record.deleting.at < DELETE_CLAIM_MS;

	/**
	 * Deletes a source (a bundle record, a bucket source) unless a sandbox mounts it, without a create slipping in
	 * between: the delete first claims the record, then counts the sandboxes mounting it, while a create stores its
	 * sandbox first, then looks for a claim (`holdSources`). Whichever goes second sees the other, so either the delete
	 * counts the sandbox, or the create sees the claim and refuses. A create that finds the claim lapsed clears it before
	 * going on (`holdRecord`), and the delete removes the record only while its own claim is still on it, so a delete
	 * slow enough for its claim to lapse can't remove a source a create has since taken.
	 */
	async function deleteUnlessMounted<T extends { readonly id: string; readonly deleting?: DeleteClaim }>(
		collection: Collection<T>,
		record: T,
		using: () => Promise<number>,
		kind: string,
	): Promise<void> {
		const token = randomSlug(12);
		const started = now();
		const marked = await collection.update(record.id, (current) => {
			// Another delete's claim, still fresh: that one decides.
			if (claimed(current)) return undefined;
			return { ...current, deleting: { token, at: started } };
		});
		if (marked === undefined) {
			if ((await collection.get(record.id)) === undefined) throw new KantelError("not_found", `No such ${kind}`);
			throw new KantelError("conflict", `This ${kind} is being deleted already`);
		}
		const count = await using().catch(async (error: unknown) => {
			await unclaim(collection, record.id, token);
			throw error;
		});
		// A claim lapses (`claimed`) so a delete that died can't hold its record for ever; one this slow may have lapsed,
		// letting a create through uncounted, so it doesn't go on.
		if (now() - started > DELETE_CLAIM_MS / 2) {
			await unclaim(collection, record.id, token);
			throw new KantelError("unavailable", `Deleting this ${kind} took too long; try again`);
		}
		if (count > 0) {
			await unclaim(collection, record.id, token);
			throw new KantelError(
				"conflict",
				`${count} of the account's sandboxes mount this ${kind}; delete them first (a stopped one counts, as it mounts it again when it starts)`,
			);
		}
		if (!(await collection.deleteIf(record.id, (current) => current.deleting?.token === token))) {
			// Its claim lapsed and a create took the record over (or another delete went first): it stays.
			if ((await collection.get(record.id)) === undefined) throw new KantelError("not_found", `No such ${kind}`);
			throw new KantelError("unavailable", `Deleting this ${kind} took too long; try again`);
		}
	}

	/**
	 * A source as a sandbox now holding it sees it: `undefined` when it is gone or a delete's claim on it is fresh. A
	 * lapsed claim is cleared first, with nothing written between, so the delete that made it, should it still be going,
	 * finds its claim gone and leaves the record (`deleteUnlessMounted`).
	 */
	async function holdRecord<T extends { readonly id: string; readonly deleting?: DeleteClaim }>(
		collection: Collection<T>,
		id: string,
	): Promise<T | undefined> {
		const current = await collection.get(id);
		if (current === undefined || claimed(current)) return undefined;
		if (current.deleting === undefined) return current;
		return collection.update(id, (latest) => {
			if (claimed(latest)) return undefined;
			const { deleting: _lapsed, ...rest } = latest;
			return rest as T;
		});
	}

	async function unclaim<T extends { readonly id: string; readonly deleting?: DeleteClaim }>(
		collection: Collection<T>,
		id: string,
		token: string,
	): Promise<void> {
		await collection
			.update(id, (current) => {
				if (current.deleting?.token !== token) return undefined;
				const { deleting: _claim, ...rest } = current;
				return rest as T;
			})
			.catch(() => undefined);
	}

	/** The generation a digest's bytes are kept as now. */
	const generationOf = (row: StoredBundleBlob) => row.generation ?? 0;

	/**
	 * Leases a digest's bytes for an upload until it lets go (`releaseLease`), so they aren't removed while the upload
	 * publishes its record, keeping its staged copy as the generation the digest is on first: the bytes are there before
	 * the lease is. Waits out a removal under way (`removeBytesUnlessKept`). One whose claim lapsed (its delete died, or
	 * stalled) is taken over onto the next generation, which that delete's removal, should it land yet, never touches.
	 */
	async function leaseBytes(staged: StagedBlob): Promise<{ readonly lease: string; readonly generation: number }> {
		const { digest } = staged;
		const lease = randomSlug(12);
		const deadline = now() + BLOB_WAIT_MS;
		for (;;) {
			const current = await store.bundleBlobs.get(digest);
			if (current === undefined) {
				await staged.keep(FIRST_GENERATION);
				const row = { id: digest, generation: FIRST_GENERATION, leases: { [lease]: now() + BLOB_LEASE_MS } };
				if (await store.bundleBlobs.insert(row)) return { lease, generation: FIRST_GENERATION };
				continue;
			}
			if (claimed(current)) {
				if (now() > deadline) {
					throw new KantelError("unavailable", "This bundle's bytes are being removed; upload it again shortly");
				}
				await sleep(50);
				continue;
			}
			const was = generationOf(current);
			const generation = current.deleting === undefined ? was : was + 1;
			await staged.keep(generation);
			const written = await store.bundleBlobs.update(digest, (latest) => {
				// Changed since it was read (a claim, a generation): read again.
				if (claimed(latest) || generationOf(latest) !== was || latest.deleting?.token !== current.deleting?.token) {
					return undefined;
				}
				const at = now();
				const leases = Object.fromEntries(Object.entries(latest.leases).filter(([, until]) => until > at));
				const { deleting: _lapsed, ...rest } = latest;
				return { ...rest, generation, leases: { ...leases, [lease]: at + BLOB_LEASE_MS } };
			});
			if (written === undefined) continue;
			// Taken over: the generation the lapsed delete claimed is read by nothing now, whether or not it removes it.
			if (generation !== was) await options.bundles.delete(digest, was).catch(() => undefined);
			return { lease, generation };
		}
	}

	/**
	 * Renews an upload's lease once its record is published, answering whether it still held the bytes all along: a lease
	 * that lapsed meanwhile (a stalled publish) may have let a delete claim and remove them.
	 */
	async function stillLeased(digest: string, lease: string, generation: number): Promise<boolean> {
		const renewed = await store.bundleBlobs.update(digest, (current) => {
			if (current.leases[lease] === undefined || generationOf(current) !== generation) return undefined;
			return { ...current, leases: { ...current.leases, [lease]: now() + BLOB_LEASE_MS } };
		});
		return renewed !== undefined;
	}

	async function releaseLease(digest: string, lease: string): Promise<void> {
		await store.bundleBlobs
			.update(digest, (current) => {
				if (current.leases[lease] === undefined) return undefined;
				const { [lease]: _mine, ...leases } = current.leases;
				return { ...current, leases };
			})
			.catch(() => undefined);
	}

	/**
	 * Removes a bundle's bytes once no account has the digest, unless an upload holds them. It claims the bytes first,
	 * which an upload's lease refuses (and which holds off new leases), then looks for accounts' records: an upload
	 * publishes its record while holding its lease, so a record is either seen here or published after this claim was
	 * let go, by an upload that then confirms its lease held (`stillLeased`). It removes only the generation it claimed,
	 * and moves the digest on to the next once it has, so bytes kept again afterwards are never the ones it removes.
	 */
	async function removeBytesUnlessKept(digest: string): Promise<void> {
		const token = randomSlug(12);
		const claim = { token, at: now() };
		let held: number | undefined;
		for (let attempt = 0; attempt < 5 && held === undefined; attempt++) {
			if (await store.bundleBlobs.insert({ id: digest, generation: FIRST_GENERATION, leases: {}, deleting: claim })) {
				held = FIRST_GENERATION;
				break;
			}
			let kept = false;
			const written = await store.bundleBlobs.update(digest, (current) => {
				const at = now();
				// An upload holds them, or another delete is removing them.
				if (claimed(current) || Object.values(current.leases).some((until) => until > at)) {
					kept = true;
					return undefined;
				}
				return { ...current, leases: {}, deleting: claim };
			});
			if (kept) return;
			if (written !== undefined) held = generationOf(written);
		}
		if (held === undefined) return;
		const generation = held;
		let removed = false;
		try {
			if ((await store.bundles.list({ digest })).length === 0) {
				// Should its claim lapse first and an upload take over, the upload keeps the bytes as the next generation:
				// this one, landing however late, removes nothing that is read.
				await options.bundles.delete(digest, generation);
				removed = true;
			}
		} finally {
			// Only its own claim goes, and the row stays: had the claim lapsed, an upload's lease may be in it now, which a
			// delete of the row would drop. (One small row per digest ever removed; the next upload reuses it.)
			await store.bundleBlobs
				.update(digest, (current) => {
					if (current.deleting?.token !== token) return undefined;
					const { deleting: _mine, ...rest } = current;
					return removed && generationOf(current) === generation ? { ...rest, generation: generation + 1 } : rest;
				})
				.catch(() => undefined);
		}
	}

	/** A digest's bytes as kept now, read again should an upload move them on to a new generation as they're opened. */
	async function openBytes(digest: string): Promise<StoredBlob | undefined> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const row = await store.bundleBlobs.get(digest);
			const generation = row === undefined ? 0 : generationOf(row);
			const blob = await options.bundles.open(digest, generation);
			if (blob !== undefined) return blob;
			const after = await store.bundleBlobs.get(digest);
			if ((after === undefined ? 0 : generationOf(after)) === generation) return undefined;
		}
		return undefined;
	}

	/** Collects a body for a backend that can't stream one in, up to `MAX_UNSTREAMED_WRITE_BYTES`. */
	async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];
		let length = 0;
		for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
			length += chunk.length;
			if (length > MAX_UNSTREAMED_WRITE_BYTES) {
				throw new KantelError(
					"invalid",
					`This sandbox takes files of at most ${MAX_UNSTREAMED_WRITE_BYTES} bytes here`,
				);
			}
			chunks.push(chunk);
		}
		const bytes = new Uint8Array(length);
		let at = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, at);
			at += chunk.length;
		}
		return bytes;
	}

	async function writeStream(sandboxId: string, path: string, body: ReadableStream<Uint8Array>): Promise<number> {
		if (backend.writeFileStream !== undefined) {
			const lazy = untouched(body);
			try {
				return (await backend.writeFileStream(sandboxId, path, lazy.stream)).size;
			} catch (error) {
				// Only a refusal before any of the body was read is tried again the other way; a failed write isn't.
				if (!unsupported(error) || lazy.touched()) throw error;
			}
		}
		const bytes = await collect(body);
		await backend.writeFile(sandboxId, path, bytes);
		return bytes.length;
	}

	async function readStream(
		sandboxId: string,
		path: string,
	): Promise<{ size?: number; body: ReadableStream<Uint8Array> }> {
		if (backend.readFileStream !== undefined) {
			try {
				return await backend.readFileStream(sandboxId, path);
			} catch (error) {
				if (!unsupported(error)) throw error;
			}
		}
		// A part at a time; the first part read now, so a missing file is refused before the answer starts.
		const first = await backend.readFile(sandboxId, path, { offset: 0, length: READ_PART_BYTES });
		let offset = first.bytes.length;
		return {
			size: first.size,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					if (first.bytes.length > 0) controller.enqueue(first.bytes);
					if (offset >= first.size) controller.close();
				},
				async pull(controller) {
					const part = await backend.readFile(sandboxId, path, { offset, length: READ_PART_BYTES });
					if (part.bytes.length === 0) {
						controller.close();
						return;
					}
					controller.enqueue(part.bytes);
					offset += part.bytes.length;
					if (offset >= part.size) controller.close();
				},
			}),
		};
	}

	async function fileUrl(
		principal: Principal,
		sandboxId: string,
		body: { readonly path: string; readonly ttlSeconds?: number },
		method: "GET" | "PUT",
		request: Request,
	): Promise<computeSchema.FileUrl> {
		const { sandbox } = await deps.sandboxFor(principal, sandboxId, "files");
		const running = await deps.requireRunning(principal, sandbox.id);
		const path = resolvePath(body.path);
		if (path === "/") throw new KantelError("invalid", "A file URL is for a file, not /");
		if (method === "PUT") refuseUnderMount(running, path);
		const token = randomSecret("kfu_", 40);
		const at = now();
		const expiresAt = at + (body.ttlSeconds ?? DEFAULT_FILE_URL_TTL_SECONDS) * 1000;
		await store.fileUrls.put({
			id: await sha256Hex(token),
			sandboxId: running.id,
			accountId: running.accountId,
			path,
			method,
			expiresAt,
			createdAt: at,
		});
		// Spent ones go as new ones are made, so the collection stays small.
		void sweepFileUrls().catch(() => undefined);
		return {
			url: `${deps.publicUrl(request)}${deps.apiBasePath}${FILE_URL_PATH}/${token}`,
			method,
			path,
			expiresAt,
		};
	}

	async function sweepFileUrls(): Promise<void> {
		const at = now();
		for (const grant of await store.fileUrls.list()) {
			if (grant.expiresAt <= at) await store.fileUrls.delete(grant.id);
		}
	}

	function refuseUnderMount(sandbox: StoredSandbox, path: string): void {
		const mount = mountCovering(sandbox.mounts, path);
		if (mount !== undefined) {
			throw new KantelError("conflict", `${path} is in the read-only mount at ${mount.path}`);
		}
	}

	const handlers: MountHandlers = {
		createUploadUrl: (principal, { params, body }, request) =>
			fileUrl(principal, params.sandboxId, body, "PUT", request),

		createDownloadUrl: (principal, { params, body }, request) =>
			fileUrl(principal, params.sandboxId, body, "GET", request),

		extractArchive: async (principal, { params, query }, request) => {
			const { sandbox } = await deps.sandboxFor(principal, params.sandboxId, "files");
			const running = await deps.requireRunning(principal, sandbox.id);
			const target = resolvePath(query.path);
			const touching = mountsTouching(running.mounts, target);
			if (touching.length > 0) {
				throw new KantelError(
					"conflict",
					`${target} is in or over the read-only mount at ${touching.map((mount) => mount.path).join(", ")}`,
				);
			}
			if (request.body === null) throw new KantelError("invalid", "Send the archive as the request's body");
			if (backend.extractArchive === undefined) {
				throw new KantelError("not_supported", "This deployment's sandboxes can't extract archives");
			}
			// The tar goes to a file in the sandbox as it is checked; it is extracted only once all of it has passed.
			const check = new TarCheck({ maxBytes: maxArchiveBytes });
			const checked = (await gunzipIfGzipped(request.body)).pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						check.push(chunk);
						controller.enqueue(chunk);
					},
				}),
			);
			const staged = `/tmp/.kantel-archive-${randomSlug(12)}.tar`;
			const cleanUp = () => backend.deleteFile(running.id, staged).catch(() => undefined);
			let summary: ReturnType<TarCheck["end"]>;
			try {
				await writeStream(running.id, staged, checked);
				summary = check.end();
			} catch (error) {
				await cleanUp();
				throw error;
			}
			// Not with the sandbox's tar: a command runs its shell's startup files and environment, which a caller with
			// `files` alone could have written. The backend extracts it with its own code.
			try {
				await backend.extractArchive(running.id, staged, target);
			} catch (error) {
				await cleanUp();
				if (error instanceof KantelError && error.code !== "invalid") throw error;
				const detail = (error instanceof Error ? error.message : String(error)).trim().slice(0, 1000);
				throw new KantelError(
					"invalid",
					`The archive couldn't be extracted into ${target}${detail === "" ? "" : `: ${detail}`}`,
				);
			}
			return { path: target, ...summary };
		},

		uploadBundle: async (principal, { query }, request) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:write", role);
			if (request.body === null) throw new KantelError("invalid", "Send the bundle's tar as the request's body");
			const staged = await options.bundles.put(request.body, {
				maxBytes: maxBundleBytes,
				...(query.digest === undefined ? {} : { expectDigest: query.digest }),
			});
			const record: StoredBundle = {
				id: bundleKey(account.id, staged.digest),
				accountId: account.id,
				digest: staged.digest,
				sizeBytes: staged.sizeBytes,
				createdAt: now(),
				...(principal.userId === undefined ? {} : { createdBy: principal.userId }),
			};
			// The record is published under a lease on the bytes, kept before the lease is taken, so a delete of the digest's
			// last other record can't remove them meanwhile. Should the lease lapse before the record is in (a stalled
			// publish), a delete may have: the bytes are kept again, under a new lease, before the upload answers.
			let inserted = false;
			try {
				for (let attempt = 0; ; attempt++) {
					const { lease, generation } = await leaseBytes(staged);
					try {
						if (attempt === 0) inserted = await store.bundles.insert(record);
						if (await stillLeased(staged.digest, lease, generation)) break;
					} finally {
						await releaseLease(staged.digest, lease);
					}
					if (attempt >= 3) {
						throw new KantelError(
							"unavailable",
							"This bundle's bytes kept being removed as it was uploaded; upload it again",
						);
					}
				}
			} finally {
				await staged.discard().catch(() => undefined);
				// A delete of the digest's last record while the lease held the bytes left them for this upload; with no
				// record now (this upload's own deleted meanwhile, or its insert failed), nothing else will remove them.
				const records = await store.bundles.list({ digest: staged.digest }).catch(() => undefined);
				if (records?.length === 0) await removeBytesUnlessKept(staged.digest).catch(() => undefined);
			}
			if (inserted) return bundleView(record);
			// Uploaded again: the bundle it has already, as it was, with 200 rather than 201.
			const kept = await bundleView((await store.bundles.get(record.id)) ?? record);
			return new Response(JSON.stringify(kept), {
				status: 200,
				headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
			});
		},

		listBundles: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "sandboxes:read", role);
			const bundles = await store.bundles.list({ accountId: account.id });
			bundles.sort((a, b) => b.createdAt - a.createdAt);
			const sandboxes = await store.sandboxes.list({ accountId: account.id });
			return { items: await Promise.all(bundles.map((bundle) => bundleView(bundle, sandboxes))) };
		},

		getBundle: async (principal, { params, query }) =>
			bundleView(await bundleFor(principal, query.account, params.digest, "sandboxes:read")),

		deleteBundle: async (principal, { params, query }) => {
			const bundle = await bundleFor(principal, query.account, params.digest, "sandboxes:write");
			await deleteUnlessMounted(
				store.bundles,
				bundle,
				() => mountedBy(bundle.accountId, bundleMatches(bundle.digest)),
				"bundle",
			);
			// The bytes go once no account has the digest.
			await removeBytesUnlessKept(bundle.digest);
			return undefined;
		},

		createBucketSource: async (principal, { body }) => {
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			if (body.endpoint !== undefined) {
				let url: URL | undefined;
				try {
					url = new URL(body.endpoint);
				} catch {
					url = undefined;
				}
				if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
					throw new KantelError("invalid", "endpoint must be an http(s) URL");
				}
			}
			if (body.provider === "gcs" && body.credentials !== undefined && "serviceAccountKey" in body.credentials) {
				try {
					JSON.parse(body.credentials.serviceAccountKey);
				} catch {
					throw new KantelError("invalid", "serviceAccountKey must be the service account's JSON key");
				}
			}
			if (body.provider === "s3" && body.credentials !== undefined && "serviceAccountKey" in body.credentials) {
				throw new KantelError("invalid", "An S3 bucket source takes an access key, not a service account key");
			}
			const id = randomId("bks", 8);
			const credentials =
				body.credentials === undefined
					? undefined
					: await deps.sealer().seal(JSON.stringify(body.credentials), credentialsAad(id));
			const source: StoredBucketSource = {
				id,
				accountId: account.id,
				name: body.name,
				provider: body.provider,
				bucket: body.bucket,
				...(body.endpoint === undefined ? {} : { endpoint: body.endpoint }),
				...(body.region === undefined ? {} : { region: body.region }),
				...(credentials === undefined ? {} : { credentials }),
				createdAt: now(),
			};
			await store.bucketSources.put(source);
			return bucketView(source);
		},

		listBucketSources: async (principal, { query }) => {
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			const sources = await store.bucketSources.list({ accountId: account.id });
			const sandboxes = await store.sandboxes.list({ accountId: account.id });
			return { items: await Promise.all(sources.map((source) => bucketView(source, sandboxes))) };
		},

		getBucketSource: async (principal, { params }) =>
			bucketView(await bucketSourceFor(principal, params.bucketSourceId, "account:read")),

		deleteBucketSource: async (principal, { params }) => {
			const source = await bucketSourceFor(principal, params.bucketSourceId, "account:admin");
			await deleteUnlessMounted(
				store.bucketSources,
				source,
				() => mountedBy(source.accountId, bucketMatches(source.id)),
				"bucket source",
			);
			return undefined;
		},
	};

	return {
		handlers,

		/**
		 * A create's (or a fork's) mounts, checked: their paths, and that each source is the account's. microVMs only.
		 * Answers them `pending`, as the sandbox keeps them until its backend says.
		 */
		async checkCreate(
			accountId: string,
			type: computeSchema.SandboxType,
			mounts: readonly computeSchema.Mount[] | undefined,
		): Promise<computeSchema.SandboxMount[] | undefined> {
			if (mounts === undefined || mounts.length === 0) return undefined;
			if (type !== "microvm") {
				throw new KantelError(
					"not_supported",
					"Mounts are for microVMs: an isolate has no filesystem a host can mount into",
				);
			}
			const problem = mountPathsProblem(mounts.map((mount) => mount.path));
			if (problem !== undefined) throw new KantelError("invalid", problem);
			for (const mount of mounts) {
				if (mount.source.kind === "bundle") {
					const bundle = await store.bundles.get(bundleKey(accountId, mount.source.digest));
					if (bundle === undefined || claimed(bundle)) {
						throw new KantelError("not_found", `No bundle ${mount.source.digest} in the account (upload it first)`);
					}
				} else {
					const source = await store.bucketSources.get(mount.source.bucketSourceId);
					if (source === undefined || source.accountId !== accountId || claimed(source)) {
						throw new KantelError("not_found", `No bucket source ${mount.source.bucketSourceId} in the account`);
					}
					if (mount.source.prefix.startsWith("/")) {
						throw new KantelError("invalid", "A bucket mount's prefix is a key prefix: it doesn't start with /");
					}
				}
			}
			return pendingMounts(mounts.map((mount) => ({ ...mount, status: "pending" })));
		},

		/**
		 * Called once a sandbox mounting sources is stored (a create's, or a fork's), before it is booted: refuses
		 * (`conflict`) when one of its sources was deleted since `checkCreate`, or is being, so the caller forgets the
		 * sandbox. A delete counts the sandboxes mounting a source only after claiming it (`deleteUnlessMounted`), so a
		 * sandbox this lets through is one any later delete counts.
		 */
		async holdSources(sandbox: StoredSandbox): Promise<void> {
			for (const mount of sandbox.mounts ?? []) {
				if (mount.source.kind === "bundle") {
					const bundle = await holdRecord(store.bundles, bundleKey(sandbox.accountId, mount.source.digest));
					if (bundle === undefined) {
						throw new KantelError("conflict", `The bundle ${mount.source.digest} was deleted as the sandbox was made`);
					}
				} else {
					const source = await holdRecord(store.bucketSources, mount.source.bucketSourceId);
					if (source === undefined || source.accountId !== sandbox.accountId) {
						throw new KantelError(
							"conflict",
							`The bucket source ${mount.source.bucketSourceId} was deleted as the sandbox was made`,
						);
					}
				}
			}
		},

		async bundleForHost(hostId: string, sandboxId: string, digest: string): Promise<StoredBlob | undefined> {
			const sandbox = await store.sandboxes.get(sandboxId);
			if (!(await hostMayServe(hostId, sandbox)) || sandbox === undefined) return undefined;
			if (!mountsOfSource(sandbox, bundleMatches(digest))) return undefined;
			if ((await store.bundles.get(bundleKey(sandbox.accountId, digest))) === undefined) return undefined;
			return openBytes(digest);
		},

		async bucketSourceForHost(
			hostId: string,
			sandboxId: string,
			bucketSourceId: string,
		): Promise<ResolvedBucketSource | undefined> {
			const sandbox = await store.sandboxes.get(sandboxId);
			if (!(await hostMayServe(hostId, sandbox)) || sandbox === undefined) return undefined;
			if (!mountsOfSource(sandbox, bucketMatches(bucketSourceId))) return undefined;
			const source = await store.bucketSources.get(bucketSourceId);
			if (source === undefined || source.accountId !== sandbox.accountId) return undefined;
			let credentials: ResolvedBucketSource["credentials"];
			if (source.credentials !== undefined) {
				const text = await deps.sealer().openText(source.credentials, credentialsAad(source.id));
				credentials = JSON.parse(text) as ResolvedBucketSource["credentials"];
			}
			return {
				id: source.id,
				provider: source.provider,
				bucket: source.bucket,
				...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
				...(source.region === undefined ? {} : { region: source.region }),
				...(credentials === undefined ? {} : { credentials }),
			};
		},

		async serveFileUrl(token: string, request: Request): Promise<Response> {
			const grant = await store.fileUrls.get(await sha256Hex(token));
			if (grant === undefined || grant.expiresAt <= now()) {
				throw new KantelError("not_found", "This file URL is unknown or has expired");
			}
			const wants = request.method === "HEAD" ? "GET" : request.method;
			if (wants !== grant.method) {
				throw new KantelError("invalid", `This file URL is for ${grant.method === "GET" ? "GET (or HEAD)" : "PUT"}`);
			}
			const sandbox = await store.sandboxes.get(grant.sandboxId);
			if (sandbox === undefined || sandbox.state === "deleted") throw new KantelError("not_found", "No such sandbox");
			if (sandbox.state !== "running") {
				throw new KantelError("conflict", `The sandbox is ${sandbox.state}; it must be running (resume it first)`);
			}
			const headers = { "cache-control": "no-store" };
			if (grant.method === "PUT") {
				refuseUnderMount(sandbox, grant.path);
				if (request.body === null) throw new KantelError("invalid", "Send the file as the request's body");
				const size = await writeStream(sandbox.id, grant.path, request.body);
				return new Response(JSON.stringify({ path: grant.path, size }), {
					status: 200,
					headers: { ...headers, "content-type": "application/json; charset=utf-8" },
				});
			}
			const file = await readStream(sandbox.id, grant.path);
			const name = grant.path.slice(grant.path.lastIndexOf("/") + 1);
			const out: Record<string, string> = {
				...headers,
				"content-type": "application/octet-stream",
				"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
				...(file.size === undefined ? {} : { "content-length": String(file.size) }),
			};
			if (request.method === "HEAD") {
				await file.body.cancel().catch(() => undefined);
				return new Response(null, { status: 200, headers: out });
			}
			return new Response(file.body, { status: 200, headers: out });
		},
	};
}

export type Mounts = ReturnType<typeof createMounts>;
