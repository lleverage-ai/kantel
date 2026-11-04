/**
 * Two backends as one: sandboxes on `primary` (the hosts that joined, such as an account's own hosts) and
 * on `fallback` (such as the stub) side by side, each sandbox and snapshot answered by the backend that holds it.
 *
 * The compute service places a sandbox by choosing its eligible hosts from `capabilities()`, which lists both
 * backends' hosts: a create goes to `primary` when any eligible host is one of its own, and to `fallback` otherwise. A
 * hosted deployment uses it to run an account's sandboxes on the account's own hosts while every other account keeps
 * the stand-in it had.
 *
 * A sandbox or snapshot stays on the backend that holds it: adding a host changes where new sandboxes go, not where
 * existing disks are. For those calls the service passes every qualifying host the account may use (online, the
 * type, the labels), and the backend that answers gets the ones among them that are its own. A sandbox neither holds
 * (its create failed, say) isn't sent to `fallback` to be answered as if it were there: it is refused (`NOT_HELD`), and
 * the service makes it again with `create`, which places it as any new sandbox.
 */
import { KantelError } from "@kantel/contracts";
import type { BackendCapabilities, BackendSize, Placement, SandboxBackend, SandboxSpec } from "./backend.ts";

export interface RoutedBackendOptions {
	readonly primary: SandboxBackend;
	readonly fallback: SandboxBackend;
	/** Whether `primary` holds the sandbox (it was placed there). */
	holds(sandboxId: string): Promise<boolean>;
	/**
	 * Whether `fallback` holds a sandbox `primary` doesn't (its placement there is recorded). Absent, it is taken to hold
	 * every such sandbox. One `fallback` has just made here is taken as held before then, so the calls of its boot (its
	 * egress, sent before it is recorded as running) reach it.
	 */
	fallbackHolds?(sandboxId: string): Promise<boolean>;
	/** Whether a snapshot reference is `primary`'s. */
	holdsSnapshot(ref: string): boolean;
}

/** What a call for a sandbox neither backend holds is refused with. */
export const NOT_HELD =
	"No backend holds this sandbox: it isn't on one of the account's own hosts or on the deployment's shared hosts " +
	"(it was never placed, if its create failed)";

export function createRoutedBackend(options: RoutedBackendOptions): SandboxBackend {
	const { primary, fallback, fallbackHolds } = options;
	/** Sandboxes `fallback` made here whose placement `fallbackHolds` doesn't see yet; each goes once it does. */
	const madeOnFallback = new Set<string>();
	const made = (backend: SandboxBackend, sandboxIds: readonly string[]) => {
		if (backend === fallback && fallbackHolds !== undefined) for (const id of sandboxIds) madeOnFallback.add(id);
	};
	/** The backend that holds the sandbox, refused when neither does. */
	const on = async (sandboxId: string): Promise<SandboxBackend> => {
		if (await options.holds(sandboxId)) return primary;
		if (fallbackHolds === undefined) return fallback;
		if (await fallbackHolds(sandboxId)) {
			madeOnFallback.delete(sandboxId);
			return fallback;
		}
		if (madeOnFallback.has(sandboxId)) return fallback;
		throw new KantelError("unavailable", NOT_HELD);
	};
	const forRef = (ref: string): SandboxBackend => (options.holdsSnapshot(ref) ? primary : fallback);

	/**
	 * The service's eligible hosts narrowed to `backend`'s own: the constraints kept, the disk's backend respected. On
	 * `fallback`, none left is refused here, saying which hosts it may use (`primary` says which host its disk is on).
	 */
	async function affine<T extends { readonly eligibleHosts: readonly string[] }>(
		backend: SandboxBackend,
		input: T,
	): Promise<T> {
		const own = new Set((await backend.capabilities()).hosts.map((host) => host.id));
		const eligibleHosts = input.eligibleHosts.filter((id) => own.has(id));
		if (backend === fallback && eligibleHosts.length === 0 && input.eligibleHosts.length > 0) {
			throw new KantelError(
				"unavailable",
				`It is on the deployment's shared hosts, none of which it may use now; it may use ${input.eligibleHosts.join(", ")}`,
			);
		}
		return { ...input, eligibleHosts };
	}

	/** Where a new sandbox goes: the backend its snapshot is on, else `primary` for any of its hosts. */
	async function placeNew(spec: SandboxSpec): Promise<{ backend: SandboxBackend; spec: SandboxSpec }> {
		if (spec.fromSnapshot !== undefined) {
			const backend = forRef(spec.fromSnapshot);
			return { backend, spec: await affine(backend, spec) };
		}
		const own = new Set((await primary.capabilities()).hosts.map((host) => host.id));
		const onPrimary = spec.eligibleHosts.filter((id) => own.has(id));
		if (onPrimary.length > 0) return { backend: primary, spec: { ...spec, eligibleHosts: onPrimary } };
		return { backend: fallback, spec: { ...spec, eligibleHosts: spec.eligibleHosts.filter((id) => !own.has(id)) } };
	}

	return {
		async capabilities(): Promise<BackendCapabilities> {
			const [first, second] = await Promise.all([primary.capabilities(), fallback.capabilities()]);
			const sizes = new Map<string, BackendSize>();
			for (const size of [...first.sizes, ...second.sizes]) if (!sizes.has(size.name)) sizes.set(size.name, size);
			return {
				types: [...new Set([...first.types, ...second.types])],
				sizes: [...sizes.values()],
				hosts: [...first.hosts, ...second.hosts],
			};
		},
		async create(spec): Promise<Placement> {
			const placed = await placeNew(spec);
			const placement = await placed.backend.create(placed.spec);
			made(placed.backend, [spec.sandboxId]);
			return placement;
		},
		async start(id, boot) {
			const backend = await on(id);
			return backend.start(id, await affine(backend, boot));
		},
		async prepareRebase(id, how) {
			// The backend that holds it checks, among its own hosts; one with no versioned images has nothing to check.
			const backend = await on(id);
			await backend.prepareRebase?.(id, await affine(backend, how));
		},
		stop: async (id, how) => (await on(id)).stop(id, how),
		async resume(id, boot) {
			const backend = await on(id);
			return backend.resume(id, await affine(backend, boot));
		},
		async fork(source, targets) {
			const backend = source.snapshot === undefined ? await on(source.sandboxId) : forRef(source.snapshot);
			const placements = await backend.fork(
				source,
				await Promise.all(targets.map((target) => affine(backend, target))),
			);
			made(
				backend,
				targets.map((target) => target.sandboxId),
			);
			return placements;
		},
		async recover(id, boot) {
			const backend = await on(id);
			return backend.recover(id, await affine(backend, boot));
		},
		// A sandbox neither holds has nothing to destroy: `fallback` answers it, as it answers one it lost.
		async destroy(id) {
			madeOnFallback.delete(id);
			return ((await options.holds(id)) ? primary : fallback).destroy(id);
		},
		exec: async (id, request) => (await on(id)).exec(id, request),
		readFile: async (id, path, range) => (await on(id)).readFile(id, path, range),
		writeFile: async (id, path, content, mode) => (await on(id)).writeFile(id, path, content, mode),
		deleteFile: async (id, path) => (await on(id)).deleteFile(id, path),
		listFiles: async (id, path) => (await on(id)).listFiles(id, path),
		takeSnapshot: async (id) => (await on(id)).takeSnapshot(id),
		listSnapshotFiles: (ref, path) => forRef(ref).listSnapshotFiles(ref, path),
		readSnapshotFile: (ref, path) => forRef(ref).readSnapshotFile(ref, path),
		deleteSnapshot: (ref) => forRef(ref).deleteSnapshot(ref),
		exposePort: async (id, port, how) => (await on(id)).exposePort(id, port, how),
		hidePort: async (id, port) => (await on(id)).hidePort(id, port),
		openSsh: async (id, how) => (await on(id)).openSsh(id, how),
		openDesktop: async (id, how) => (await on(id)).openDesktop(id, how),
		openBrowser: async (id, how) => (await on(id)).openBrowser(id, how),
		async openE2E(id, how) {
			const backend = await on(id);
			if (backend.openE2E === undefined) {
				throw new KantelError("not_supported", "This sandbox isn't on a host that E2E sessions reach");
			}
			return backend.openE2E(id, how);
		},
		usage: async (id) => (await on(id)).usage(id),
		...(primary.usageReports === undefined && fallback.usageReports === undefined
			? {}
			: {
					async usageReports(since: number, until: number) {
						const [first, second] = await Promise.all([
							primary.usageReports?.(since, until) ?? [],
							fallback.usageReports?.(since, until) ?? [],
						]);
						return [...first, ...second].sort((a, b) => a.at - b.at);
					},
				}),
		async updateEgress(id, egress, revision) {
			await (await on(id)).updateEgress?.(id, egress, revision);
		},
		async revokeHost(hostId) {
			await primary.revokeHost?.(hostId);
		},
		async updateHost(hostId, change) {
			await primary.updateHost?.(hostId, change);
		},
	};
}
