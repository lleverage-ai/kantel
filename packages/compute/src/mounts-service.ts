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
	type StoredBlob,
} from "./mounts.ts";
import { type Sealer, sealedAt } from "./secrets.ts";
import type { ComputeStore, StoredBucketSource, StoredBundle, StoredHost, StoredSandbox } from "./store.ts";
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
	/** The sandbox, if `principal` may use it with `scope` (`not_found` otherwise). */
	readonly sandboxFor: (
		principal: Principal,
		sandboxId: string,
		scope: computeSchema.ApiKeyScope,
	) => Promise<{ readonly sandbox: StoredSandbox }>;
	/** The sandbox once its queued work ends, refused (`conflict`) unless it is running. */
	readonly requireRunning: (principal: Principal, sandboxId: string) => Promise<StoredSandbox>;
	/** The hosts the service knows. */
	readonly hosts: () => Promise<readonly StoredHost[]>;
}

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

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

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

	async function mountedBy(accountId: string, matches: (source: computeSchema.MountSource) => boolean) {
		const sandboxes = await store.sandboxes.list({ accountId });
		return sandboxes.filter((sandbox) => mountsOfSource(sandbox, matches)).length;
	}

	const bundleMatches = (digest: string) => (source: computeSchema.MountSource) =>
		source.kind === "bundle" && source.digest === digest;
	const bucketMatches = (id: string) => (source: computeSchema.MountSource) =>
		source.kind === "bucket" && source.bucketSourceId === id;

	const bundleView = async (bundle: StoredBundle): Promise<computeSchema.Bundle> => ({
		digest: bundle.digest,
		accountId: bundle.accountId,
		sizeBytes: bundle.sizeBytes,
		mountedBy: await mountedBy(bundle.accountId, bundleMatches(bundle.digest)),
		createdAt: bundle.createdAt,
	});

	const bucketView = async (source: StoredBucketSource): Promise<computeSchema.BucketSource> => ({
		id: source.id,
		accountId: source.accountId,
		name: source.name,
		provider: source.provider,
		bucket: source.bucket,
		...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
		...(source.region === undefined ? {} : { region: source.region }),
		hasCredentials: source.credentials !== undefined,
		mountedBy: await mountedBy(source.accountId, bucketMatches(source.id)),
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

	/** A host may hear of a sandbox when it is on it, or (starting, not placed yet) when it may run the account's. */
	async function hostMayServe(hostId: string, sandbox: StoredSandbox | undefined): Promise<boolean> {
		if (sandbox === undefined || sandbox.state === "deleted") return false;
		if (sandbox.hostId === hostId) return true;
		if (sandbox.state !== "starting" || sandbox.hostId !== undefined) return false;
		const host = (await deps.hosts()).find((known) => known.id === hostId);
		return host !== undefined && (host.accountId === undefined || host.accountId === sandbox.accountId);
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
		if (backend.writeFileStream !== undefined) return (await backend.writeFileStream(sandboxId, path, body)).size;
		const bytes = await collect(body);
		await backend.writeFile(sandboxId, path, bytes);
		return bytes.length;
	}

	async function readStream(
		sandboxId: string,
		path: string,
	): Promise<{ size?: number; body: ReadableStream<Uint8Array> }> {
		if (backend.readFileStream !== undefined) return backend.readFileStream(sandboxId, path);
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
		return { url: `${deps.publicUrl(request)}/v1${FILE_URL_PATH}/${token}`, method, path, expiresAt };
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
			const result = await backend.exec(running.id, {
				command: `mkdir -p -- ${quote(target)} && tar -x -p -f ${quote(staged)} -C ${quote(target)}; code=$?; rm -f -- ${quote(staged)}; exit $code`,
				timeoutMs: 30 * 60_000,
			});
			if (result.exitCode !== 0 || result.timedOut) {
				await cleanUp();
				const detail = (result.stderr || result.stdout).trim().slice(0, 1000);
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
			const stored = await options.bundles.put(request.body, {
				maxBytes: maxBundleBytes,
				...(query.digest === undefined ? {} : { expectDigest: query.digest }),
			});
			const record: StoredBundle = {
				id: bundleKey(account.id, stored.digest),
				accountId: account.id,
				digest: stored.digest,
				sizeBytes: stored.sizeBytes,
				createdAt: now(),
				...(principal.userId === undefined ? {} : { createdBy: principal.userId }),
			};
			if (await store.bundles.insert(record)) return bundleView(record);
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
			return { items: await Promise.all(bundles.map(bundleView)) };
		},

		getBundle: async (principal, { params, query }) =>
			bundleView(await bundleFor(principal, query.account, params.digest, "sandboxes:read")),

		deleteBundle: async (principal, { params, query }) => {
			const bundle = await bundleFor(principal, query.account, params.digest, "sandboxes:write");
			const using = await mountedBy(bundle.accountId, bundleMatches(bundle.digest));
			if (using > 0) {
				throw new KantelError(
					"conflict",
					`${using} of the account's sandboxes mount this bundle; delete them first (a stopped one counts, as it mounts it again when it starts)`,
				);
			}
			await store.bundles.delete(bundle.id);
			// The bytes go once no account has the digest.
			const others = await store.bundles.list({ digest: bundle.digest });
			if (others.length === 0) await options.bundles.delete(bundle.digest);
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
			return { items: await Promise.all(sources.map(bucketView)) };
		},

		getBucketSource: async (principal, { params }) =>
			bucketView(await bucketSourceFor(principal, params.bucketSourceId, "account:read")),

		deleteBucketSource: async (principal, { params }) => {
			const source = await bucketSourceFor(principal, params.bucketSourceId, "account:admin");
			const using = await mountedBy(source.accountId, bucketMatches(source.id));
			if (using > 0) {
				throw new KantelError(
					"conflict",
					`${using} of the account's sandboxes mount this bucket source; delete them first (a stopped one counts, as it mounts it again when it starts)`,
				);
			}
			await store.bucketSources.delete(source.id);
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
					if ((await store.bundles.get(bundleKey(accountId, mount.source.digest))) === undefined) {
						throw new KantelError("not_found", `No bundle ${mount.source.digest} in the account (upload it first)`);
					}
				} else {
					const source = await store.bucketSources.get(mount.source.bucketSourceId);
					if (source === undefined || source.accountId !== accountId) {
						throw new KantelError("not_found", `No bucket source ${mount.source.bucketSourceId} in the account`);
					}
					if (mount.source.prefix.startsWith("/")) {
						throw new KantelError("invalid", "A bucket mount's prefix is a key prefix: it doesn't start with /");
					}
				}
			}
			return pendingMounts(mounts.map((mount) => ({ ...mount, status: "pending" })));
		},

		async bundleForHost(hostId: string, sandboxId: string, digest: string): Promise<StoredBlob | undefined> {
			const sandbox = await store.sandboxes.get(sandboxId);
			if (!(await hostMayServe(hostId, sandbox)) || sandbox === undefined) return undefined;
			if (!mountsOfSource(sandbox, bundleMatches(digest))) return undefined;
			if ((await store.bundles.get(bundleKey(sandbox.accountId, digest))) === undefined) return undefined;
			return options.bundles.open(digest);
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
