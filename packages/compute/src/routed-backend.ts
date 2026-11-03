/**
 * Two backends as one: sandboxes on `primary` (the hosts that joined, such as an account's own with Kantel Connect) and
 * on `fallback` (such as the stub) side by side, each sandbox and snapshot answered by the backend that holds it.
 *
 * The compute service places a sandbox by choosing its eligible hosts from `capabilities()`, which lists both
 * backends' hosts: a create goes to `primary` when any eligible host is one of its own, and to `fallback` otherwise. A
 * hosted deployment uses it to run an account's sandboxes on the account's own hosts while every other account keeps
 * the stand-in it had.
 *
 * A sandbox or snapshot stays on the backend that holds it: enrolling a host changes where new sandboxes go, not where
 * existing disks are. The service's eligible hosts are for a fresh placement (an account's own hosts when it has
 * any), so a call `fallback` answers for something it already holds gets `fallback`'s shared hosts instead.
 */
import type { BackendCapabilities, BackendSize, Placement, SandboxBackend, SandboxSpec } from "./backend.ts";

export interface RoutedBackendOptions {
	readonly primary: SandboxBackend;
	readonly fallback: SandboxBackend;
	/** Whether `primary` holds the sandbox (it was placed there). */
	holds(sandboxId: string): Promise<boolean>;
	/** Whether a snapshot reference is `primary`'s. */
	holdsSnapshot(ref: string): boolean;
}

export function createRoutedBackend(options: RoutedBackendOptions): SandboxBackend {
	const { primary, fallback } = options;
	const on = async (sandboxId: string): Promise<SandboxBackend> =>
		(await options.holds(sandboxId)) ? primary : fallback;
	const forRef = (ref: string): SandboxBackend => (options.holdsSnapshot(ref) ? primary : fallback);

	/** `fallback`'s hosts any account may use: where what it already holds can run again. */
	const fallbackHosts = async (): Promise<string[]> =>
		(await fallback.capabilities()).hosts.filter((host) => host.accountId === undefined).map((host) => host.id);

	/** Eligibility for the backend that must answer: `fallback`'s own hosts there, the service's on `primary`. */
	async function affine<T extends { readonly eligibleHosts: readonly string[] }>(
		backend: SandboxBackend,
		input: T,
	): Promise<T> {
		return backend === fallback ? { ...input, eligibleHosts: await fallbackHosts() } : input;
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
			return placed.backend.create(placed.spec);
		},
		async start(id, boot) {
			const backend = await on(id);
			return backend.start(id, await affine(backend, boot));
		},
		stop: async (id, how) => (await on(id)).stop(id, how),
		async resume(id, boot) {
			const backend = await on(id);
			return backend.resume(id, await affine(backend, boot));
		},
		async fork(source, targets) {
			const backend = source.snapshot === undefined ? await on(source.sandboxId) : forRef(source.snapshot);
			return backend.fork(source, await Promise.all(targets.map((target) => affine(backend, target))));
		},
		async recover(id, boot) {
			const backend = await on(id);
			return backend.recover(id, await affine(backend, boot));
		},
		destroy: async (id) => (await on(id)).destroy(id),
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
		usage: async (id) => (await on(id)).usage(id),
		async updateEgress(id, egress) {
			await (await on(id)).updateEgress?.(id, egress);
		},
		async revokeHost(hostId) {
			await primary.revokeHost?.(hostId);
		},
		async updateHost(hostId, change) {
			await primary.updateHost?.(hostId, change);
		},
	};
}
