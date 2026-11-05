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
 *
 * Templates are each backend's own too: their runtimes are both backends' hosts', a build goes to the backend whose host
 * it names, and a template snapshot is answered by the backend its reference is of (`holdsSnapshot`).
 */
import { KantelError, placementError } from "@kantel/contracts";
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

/**
 * What a create made again is refused with when `primary` holds the sandbox but can't take it now: it stays placed on
 * one of the account's own hosts until that host says what it has, or the sandbox is deleted.
 */
export const HELD_ELSEWHERE =
	"It is placed on one of the account's own hosts, none of which may take it now; it stays there until that host " +
	"says whether it has it, or until it is deleted";

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
		throw placementError("unavailable", "host_unavailable", NOT_HELD);
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
			throw placementError(
				"unavailable",
				"host_unavailable",
				`It is on the deployment's shared hosts, none of which it may use now; it may use ${input.eligibleHosts.join(", ")}`,
			);
		}
		return { ...input, eligibleHosts };
	}

	/** Where a new sandbox goes: the backend its snapshot (or its template's) is on, else `primary` for any of its hosts. */
	async function placeNew(spec: SandboxSpec): Promise<{ backend: SandboxBackend; spec: SandboxSpec }> {
		const snapshot = spec.fromSnapshot ?? spec.template?.snapshot;
		if (snapshot !== undefined) {
			const backend = forRef(snapshot);
			return { backend, spec: await affine(backend, spec) };
		}
		const own = new Set((await primary.capabilities()).hosts.map((host) => host.id));
		const onPrimary = spec.eligibleHosts.filter((id) => own.has(id));
		if (onPrimary.length > 0) return { backend: primary, spec: { ...spec, eligibleHosts: onPrimary } };
		return { backend: fallback, spec: { ...spec, eligibleHosts: spec.eligibleHosts.filter((id) => !own.has(id)) } };
	}

	/** The backend a host is on: `primary` when it is one of its hosts, else `fallback`. */
	const forHost = async (hostId: string): Promise<SandboxBackend> =>
		(await primary.capabilities()).hosts.some((host) => host.id === hostId) ? primary : fallback;

	const hasTemplates = (backend: SandboxBackend) =>
		backend.templateRuntimes !== undefined &&
		backend.buildTemplate !== undefined &&
		backend.deleteTemplateSnapshot !== undefined;

	/** Template calls, when either backend has templates: absent, the routed backend has none either. */
	const templates: Pick<SandboxBackend, "templateRuntimes" | "buildTemplate" | "deleteTemplateSnapshot"> =
		hasTemplates(primary) || hasTemplates(fallback)
			? {
					async templateRuntimes() {
						const [first, second] = await Promise.all([
							hasTemplates(primary) ? primary.templateRuntimes?.() : [],
							hasTemplates(fallback) ? fallback.templateRuntimes?.() : [],
						]);
						return [...(first ?? []), ...(second ?? [])];
					},
					async buildTemplate(spec) {
						const backend = await forHost(spec.hostId);
						if (!hasTemplates(backend) || backend.buildTemplate === undefined) {
							throw new KantelError("not_supported", `The host ${spec.hostId} can't build templates`);
						}
						return backend.buildTemplate(spec);
					},
					async deleteTemplateSnapshot(bytes) {
						// Bytes its build never answered for are on the host it was built on.
						const backend = bytes.ref === undefined ? await forHost(bytes.hostId) : forRef(bytes.ref);
						await backend.deleteTemplateSnapshot?.(bytes);
					},
				}
			: {};

	/** A create made again for a sandbox `primary` holds: on `primary`'s eligible hosts, refused when it has none now. */
	async function heldBy(spec: SandboxSpec): Promise<SandboxSpec> {
		if (spec.fromSnapshot !== undefined && !options.holdsSnapshot(spec.fromSnapshot)) {
			throw new KantelError("conflict", HELD_ELSEWHERE);
		}
		const own = new Set((await primary.capabilities()).hosts.map((host) => host.id));
		const eligibleHosts = spec.eligibleHosts.filter((id) => own.has(id));
		if (eligibleHosts.length === 0) throw placementError("unavailable", "host_unavailable", HELD_ELSEWHERE);
		return { ...spec, eligibleHosts };
	}

	return {
		...templates,
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
			// One `primary` holds already is a create made again (its first went unanswered, and is kept placed there until
			// its host says): it stays with `primary`, whose own checks decide it (refused while unsettled or there, made
			// again once lost). It never goes to `fallback` too, which would leave two backends holding one ID.
			if (await options.holds(spec.sandboxId)) return primary.create(await heldBy(spec));
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
			return await backend.prepareRebase?.(id, await affine(backend, how));
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
		...(primary.placedOn === undefined && fallback.placedOn === undefined
			? {}
			: {
					// Where the backend holding it placed it, even while it boots there.
					async placedOn(id: string) {
						return ((await options.holds(id)) ? primary : fallback).placedOn?.(id);
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
