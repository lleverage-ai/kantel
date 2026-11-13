/**
 * Pools: an account's hosts, or the deployment's shared hosts, in sets, each host in exactly one (`StoredHost.poolId`).
 * A pool is the boundary the mesh, sync and data keep to (docs/design/disk-store.md, "Pools"). Every owner (an account,
 * or the deployment for its shared hosts) has a default pool, made the first time it needs one, named `default`: where
 * a host joins, and a sandbox goes, naming no pool. The pools' routes, and what the rest of the service asks of them.
 */
import type { accountHostRoutes, computeSchema, hostRoutes, RouteHandlers, SignedInComputeRoutes } from "@kantel/api";
import { KantelError } from "@kantel/contracts";
import { actingAccount, type Principal, requireScope } from "./auth.ts";
import { type ComputeStore, OPERATOR_POOLS, type StoredHost, type StoredPool, UniqueViolation } from "./store.ts";
import { randomId } from "./util.ts";

/** The name of the pool an owner starts with. */
export const DEFAULT_POOL_NAME = "default";

/** The ID of an owner's first default pool: one ID, so gateways making it at once make one pool. */
export const firstPoolId = (owner: string): string => `pool_${owner}`;

/** Whose pools a host is in: its account's, or the deployment's for a shared host. */
export const poolOwnerOf = (host: { readonly accountId?: string }): string => host.accountId ?? OPERATOR_POOLS;

/** Of an owner's pools, its default: the one made so latest, else the oldest. */
export function defaultPoolOf(pools: readonly StoredPool[]): StoredPool | undefined {
	let chosen: StoredPool | undefined;
	for (const pool of pools) {
		if (chosen === undefined || (pool.defaultAt ?? -1) > (chosen.defaultAt ?? -1)) chosen = pool;
	}
	return chosen;
}

type PoolRoutes = Pick<
	typeof hostRoutes & typeof accountHostRoutes,
	| "listPools"
	| "createPool"
	| "updatePool"
	| "deletePool"
	| "listAccountPools"
	| "createAccountPool"
	| "updateAccountPool"
	| "deleteAccountPool"
>;

/** The handlers of the pool routes. */
export type PoolHandlers = Pick<RouteHandlers<SignedInComputeRoutes, Principal>, keyof PoolRoutes>;

export interface PoolServiceOptions {
	readonly store: ComputeStore;
	readonly now: () => number;
	/** Every host as it is now (the service's `ensureHosts`), for how many each pool holds and what may be deleted. */
	readonly hosts: () => Promise<readonly StoredHost[]>;
	/**
	 * A call set a pool's sync, on or off, changed or not: its hosts are brought into its mesh or taken out
	 * (`SandboxBackend.updatePool`). A rejection is answered `unavailable`, the sync kept. Absent, nothing is told.
	 */
	readonly syncChanged?: (poolId: string, sync: boolean) => Promise<void>;
	/** Refuses with `not_supported` while account hosts are off (`KANTEL_ACCOUNT_HOSTS`). */
	readonly requireAccountHosts: () => void;
	/** Does `work` once for the call's `Idempotency-Key` and request, answering a retry the first answer (the service's). */
	readonly once: <T>(
		principal: Principal,
		operation: string,
		input: { readonly params?: unknown; readonly body?: unknown; readonly idempotencyKey?: string },
		work: () => Promise<T>,
	) => Promise<T>;
}

export interface PoolService {
	readonly handlers: PoolHandlers;
	/** An owner's pools, oldest first, its default made first if it has none. */
	poolsOf(owner: string): Promise<StoredPool[]>;
	/** An owner's pool by ID or name; `not_found` for any other. */
	poolIn(owner: string, ref: string): Promise<StoredPool>;
	/** An owner's default pool, made if it has none. */
	defaultPool(owner: string): Promise<StoredPool>;
}

export function createPoolService(options: PoolServiceOptions): PoolService {
	const { store, now } = options;

	const nameTaken = (owner: string, name: string) =>
		new KantelError(
			"conflict",
			owner === OPERATOR_POOLS ? `The deployment has a pool named ${name}` : `The account has a pool named ${name}`,
		);

	/** Makes a write that may give a pool `name`: the store refuses a second of an owner's pools with it. */
	async function naming<T>(owner: string, name: string, write: () => Promise<T>): Promise<T> {
		try {
			return await write();
		} catch (error) {
			if (error instanceof UniqueViolation) throw nameTaken(owner, name);
			throw error;
		}
	}

	async function poolsOf(owner: string): Promise<StoredPool[]> {
		const pools = await store.pools.list({ owner });
		if (pools.length > 0) return pools;
		// Its first pool, the default: an insert of the one ID, which another gateway making it at once also tries. A pool
		// named `default` made meanwhile (a create, which makes this one first) is as good.
		const at = now();
		await store.pools
			.insert({ id: firstPoolId(owner), owner, name: DEFAULT_POOL_NAME, createdAt: at, defaultAt: at })
			.catch((error: unknown) => {
				if (!(error instanceof UniqueViolation)) throw error;
			});
		return store.pools.list({ owner });
	}

	async function defaultPool(owner: string): Promise<StoredPool> {
		const chosen = defaultPoolOf(await poolsOf(owner));
		if (chosen === undefined) throw new KantelError("unavailable", "The default pool couldn't be made; try again");
		return chosen;
	}

	async function poolIn(owner: string, ref: string): Promise<StoredPool> {
		const pools = await poolsOf(owner);
		const pool = pools.find((candidate) => candidate.id === ref) ?? pools.find((candidate) => candidate.name === ref);
		if (pool === undefined) throw new KantelError("not_found", `No pool named ${ref}`);
		return pool;
	}

	/** Pools as the API answers them, with how many hosts each holds now. */
	async function viewsOf(pools: readonly StoredPool[]): Promise<computeSchema.Pool[]> {
		const hosts = await options.hosts();
		const chosen = defaultPoolOf(pools);
		return pools.map((pool) => ({
			id: pool.id,
			name: pool.name,
			...(pool.owner === OPERATOR_POOLS ? {} : { accountId: pool.owner }),
			default: pool.id === chosen?.id,
			hosts: hosts.filter((host) => host.poolId === pool.id && host.state !== "revoked").length,
			sync: pool.sync === true,
			createdAt: pool.createdAt,
		}));
	}

	async function viewOf(pool: StoredPool): Promise<computeSchema.Pool> {
		const views = await viewsOf(await poolsOf(pool.owner));
		const view = views.find((candidate) => candidate.id === pool.id);
		if (view === undefined) throw new KantelError("not_found", "No such pool");
		return view;
	}

	async function create(owner: string, name: string, sync: boolean | undefined): Promise<computeSchema.Pool> {
		// The default first, so an owner's first pool made by hand is never its default by accident.
		await poolsOf(owner);
		// A new pool has no hosts, so no mesh to tell of its sync.
		const pool: StoredPool = {
			id: randomId("pool"),
			owner,
			name,
			createdAt: now(),
			...(sync === true ? { sync } : {}),
		};
		await naming(owner, name, () => store.pools.insert(pool));
		return viewOf(pool);
	}

	async function change(pool: StoredPool, body: computeSchema.UpdatePoolBody): Promise<computeSchema.Pool> {
		// Past every default the owner has had, so it is the default whatever the clocks of the gateways that made those.
		const latest = Math.max(now(), ...(await poolsOf(pool.owner)).map((other) => (other.defaultAt ?? 0) + 1));
		const changed = await naming(pool.owner, body.name ?? pool.name, () =>
			store.pools.update(pool.id, (current) => {
				const { sync: _was, ...rest } = current;
				const sync = body.sync ?? current.sync === true;
				return {
					...rest,
					...(body.name === undefined ? {} : { name: body.name }),
					...(body.default === true ? { defaultAt: latest } : {}),
					...(sync ? { sync: true } : {}),
				};
			}),
		);
		if (changed === undefined) throw new KantelError("not_found", "No such pool");
		// Its hosts are told once it is written, each reading the pool's sync as it is then, whenever a call sets it, changed
		// or not: a call whose telling failed is answered so, and the same call again tells them again.
		if (body.sync !== undefined && options.syncChanged !== undefined) {
			try {
				await options.syncChanged(pool.id, changed.sync === true);
			} catch (error) {
				throw new KantelError(
					"unavailable",
					`The pool's sync is saved, but its hosts couldn't all be told (${error instanceof Error ? error.message : String(error)}): try again`,
				);
			}
		}
		return viewOf(changed);
	}

	/** Deletes an empty pool that isn't its owner's default: `conflict` otherwise. */
	async function remove(pool: StoredPool): Promise<undefined> {
		if (defaultPoolOf(await poolsOf(pool.owner))?.id === pool.id) {
			throw new KantelError("conflict", `${pool.name} is the default pool: make another the default first`);
		}
		const held = (await options.hosts()).filter((host) => host.state !== "revoked" && host.poolId === pool.id);
		if (held.length > 0) {
			throw new KantelError(
				"conflict",
				`${pool.name} still has ${held.length === 1 ? "a host" : `${held.length} hosts`} in it: move them to another pool first`,
			);
		}
		// A host another gateway joins or moves to it meanwhile is in its owner's default once it has gone, as the next
		// read of the hosts puts it (`ensureHosts`); a pool made the default meanwhile hands the default back to the one
		// that was. Either way every host is in a pool that exists, and its owner has a default.
		await store.pools.delete(pool.id);
		return undefined;
	}

	/**
	 * One of an account's pools, for a caller who may act in the account with `scope`: by ID in any such account, by
	 * name in the caller's own. Another account's, and the deployment's, are `not_found`.
	 */
	async function accountPoolFor(
		principal: Principal,
		ref: string,
		scope: "account:read" | "account:admin",
	): Promise<StoredPool> {
		options.requireAccountHosts();
		const byId = await store.pools.get(ref);
		if (byId !== undefined && byId.owner !== OPERATOR_POOLS) {
			const acting = await actingAccount(store, principal, byId.owner).catch(() => undefined);
			if (acting !== undefined) {
				requireScope(principal, scope, acting.role);
				return byId;
			}
		}
		const { account, role } = await actingAccount(store, principal, undefined);
		requireScope(principal, scope, role);
		return poolIn(account.id, ref);
	}

	const handlers: PoolHandlers = {
		listPools: async (principal) => {
			requireScope(principal, "hosts:admin");
			return { items: await viewsOf(await poolsOf(OPERATOR_POOLS)) };
		},
		createPool: async (principal, { body, idempotencyKey }) => {
			requireScope(principal, "hosts:admin");
			return options.once(principal, "createPool", { body, idempotencyKey }, () =>
				create(OPERATOR_POOLS, body.name, body.sync),
			);
		},
		updatePool: async (principal, { params, body }) => {
			requireScope(principal, "hosts:admin");
			return change(await poolIn(OPERATOR_POOLS, params.poolId), body);
		},
		deletePool: async (principal, { params }) => {
			requireScope(principal, "hosts:admin");
			return remove(await poolIn(OPERATOR_POOLS, params.poolId));
		},
		listAccountPools: async (principal, { query }) => {
			options.requireAccountHosts();
			const { account, role } = await actingAccount(store, principal, query.account);
			requireScope(principal, "account:read", role);
			return { items: await viewsOf(await poolsOf(account.id)) };
		},
		createAccountPool: async (principal, { body, idempotencyKey }) => {
			options.requireAccountHosts();
			const { account, role } = await actingAccount(store, principal, body.account);
			requireScope(principal, "account:admin", role);
			return options.once(principal, "createAccountPool", { body, idempotencyKey }, () =>
				create(account.id, body.name, body.sync),
			);
		},
		updateAccountPool: async (principal, { params, body }) =>
			change(await accountPoolFor(principal, params.poolId, "account:admin"), body),
		deleteAccountPool: async (principal, { params }) =>
			remove(await accountPoolFor(principal, params.poolId, "account:admin")),
	};

	return { handlers, poolsOf, poolIn, defaultPool };
}
