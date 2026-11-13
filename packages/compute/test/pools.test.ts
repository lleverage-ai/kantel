import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { BackendHost, SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { firstPoolId } from "../src/pools.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, createMemoryStore, joinTokenSpender, OPERATOR_POOLS } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const opened: ComputeApi[] = [];
const databases: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const database of databases.splice(0)) await database.close();
});

const STORES: readonly { readonly name: string; readonly make: () => Promise<ComputeStore> }[] = [
	{ name: "in memory", make: async () => createMemoryStore() },
	{
		name: "in SQL",
		make: async () => {
			const database = await pgliteDatabase.open();
			databases.push(database);
			await migrateComputeStore(database.driver);
			return createSqlComputeStore(database.driver);
		},
	},
];
const sqlTimeout = pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs };

/** A host change the backend was told of (`updateHost`). */
type Told = { readonly hostId: string } & Parameters<NonNullable<SandboxBackend["updateHost"]>>[1];

/**
 * The stub backend with more hosts beside its own (`extra`, read on every call), recording what it is told of hosts,
 * and keeping the pool it is told as a registry would.
 */
function hostsBackend(extra: () => readonly BackendHost[] = () => []) {
	const stub = createStubBackend();
	const told: Told[] = [];
	const registry = new Map<string, string>();
	const backend: SandboxBackend = {
		...stub,
		capabilities: async () => {
			const base = await stub.capabilities();
			const [template] = base.hosts;
			const hosts = template === undefined ? base.hosts : [...base.hosts, ...extra()];
			return {
				...base,
				hosts: hosts.map((host) => {
					const poolId = registry.get(host.id) ?? host.poolId;
					return poolId === undefined ? host : { ...host, poolId };
				}),
			};
		},
		updateHost: async (hostId, change) => {
			told.push({ hostId, ...change });
			if (change.poolId !== undefined) registry.set(hostId, change.poolId);
		},
	};
	return { backend, told, registry, stub };
}

function setup(store: ComputeStore, backend: SandboxBackend, accountHosts = true) {
	const api = createComputeApi({
		store,
		accountHosts,
		backend,
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, tom: client("tom-token"), ann: client("ann-token"), root: client("root-token") };
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

/** A host like the stub's, by another ID, for an account's own when `accountId` is given. */
async function hostLike(id: string, accountId?: string): Promise<BackendHost> {
	const [template] = (await createStubBackend().capabilities()).hosts;
	if (template === undefined) throw new Error("The stub has no host");
	return { ...template, id, ...(accountId === undefined ? {} : { accountId }) };
}

describe.each(STORES)("pools, stored $name", sqlTimeout, ({ make }) => {
	it("puts the hosts from before pools into their owner's default pool, and creates go on as before", async () => {
		const store = await make();
		let own: BackendHost | undefined;
		const before = hostsBackend(() => (own === undefined ? [] : [own]));
		const first = setup(store, before.backend);
		const personal = (await first.ann.getCaller()).accountId;
		own = await hostLike("host_own", personal);
		// Both hosts' records as a control plane from before pools kept them: no pool, and none in the registry.
		await first.root.listHosts();
		await first.api.service.idle();
		await first.api.close();
		for (const id of [STUB_HOST_ID, "host_own"]) {
			await store.hosts.update(id, ({ poolId: _pool, ...rest }) => rest);
		}
		await store.pools.delete(firstPoolId(OPERATOR_POOLS));
		await store.pools.delete(firstPoolId(personal));

		// A gateway with pools.
		const { backend, told } = hostsBackend(() => (own === undefined ? [] : [own]));
		const { api, ann, root, tom } = setup(store, backend);
		const shared = (await root.listHosts()).items.find((host) => host.id === STUB_HOST_ID);
		expect(shared?.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		const [mine] = (await ann.listAccountHosts({})).items;
		expect(mine?.poolId).toBe(firstPoolId(personal));
		expect((await store.hosts.get("host_own"))?.poolId).toBe(firstPoolId(personal));

		// Each owner has its default pool, holding its hosts.
		expect((await root.listPools()).items).toEqual([
			expect.objectContaining({ id: firstPoolId(OPERATOR_POOLS), name: "default", default: true, hosts: 1 }),
		]);
		const [pool] = (await ann.listAccountPools({})).items;
		expect(pool).toMatchObject({ name: "default", accountId: personal, default: true, hosts: 1 });

		// The registry is told each host's pool, once.
		await api.service.idle();
		expect(told).toEqual(
			expect.arrayContaining([
				{ hostId: STUB_HOST_ID, poolId: firstPoolId(OPERATOR_POOLS) },
				{ hostId: "host_own", poolId: firstPoolId(personal) },
			]),
		);
		const count = told.length;
		await root.listHosts();
		await api.service.idle();
		expect(told).toHaveLength(count);

		// A create goes on the shared host, as it did.
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.state).toBe("running");
		expect((await store.sandboxes.get(sandbox.id))?.hostId).toBe(STUB_HOST_ID);
	});

	it("makes, renames, defaults and deletes pools, an empty one that isn't the default only", async () => {
		const store = await make();
		const { backend } = hostsBackend();
		const { root, tom } = setup(store, backend);
		expect((await failure(tom.listPools())).code).toBe("forbidden");

		const ci = await root.createPool({ name: "ci" });
		expect(ci).toMatchObject({ name: "ci", default: false, hosts: 0 });
		expect(ci).not.toHaveProperty("accountId");
		expect((await root.listPools()).items.map((pool) => pool.name)).toEqual(["default", "ci"]);
		expect((await failure(root.createPool({ name: "ci" }))).code).toBe("conflict");
		expect((await failure(root.createPool({ name: "Not A Name" }))).code).toBe("invalid");
		expect((await failure(root.updatePool(ci.id, { name: "default" }))).code).toBe("conflict");

		const renamed = await root.updatePool("ci", { name: "builds" });
		expect(renamed).toMatchObject({ id: ci.id, name: "builds" });

		// The default can't be deleted; another made the default, the old one can.
		const first = firstPoolId(OPERATOR_POOLS);
		expect((await failure(root.deletePool("default"))).code).toBe("conflict");
		expect(await root.updatePool("builds", { default: true })).toMatchObject({ default: true });
		expect((await root.listPools()).items.filter((pool) => pool.default).map((pool) => pool.id)).toEqual([ci.id]);
		// The shared host is in the first default: that pool isn't empty.
		const refused = await failure(root.deletePool(first));
		expect(refused.code).toBe("conflict");
		expect(refused.message).toContain("a host");
		expect((await failure(root.deletePool("builds"))).code).toBe("conflict");
		expect((await failure(root.deletePool("nowhere"))).code).toBe("not_found");

		await root.updatePool(first, { default: true });
		await root.deletePool("builds");
		expect((await root.listPools()).items.map((pool) => pool.name)).toEqual(["default"]);
	});

	it("keeps a pool's sync, off by default, and tells the backend when it is turned on or off", async () => {
		const store = await make();
		const { backend } = hostsBackend();
		const pools: { readonly poolId: string; readonly sync: boolean }[] = [];
		let refuse = false;
		const { api, root, tom } = setup(store, {
			...backend,
			updatePool: async (poolId, change) => {
				if (refuse) throw new Error("the registry is away");
				pools.push({ poolId, ...change });
			},
		});
		const ci = await root.createPool({ name: "ci" });
		expect(ci.sync).toBe(false);
		expect(await api.service.poolSync(ci.id)).toBe(false);
		const synced = await root.createPool({ name: "builds", sync: true });
		expect(synced.sync).toBe(true);
		expect(await api.service.poolSync(synced.id)).toBe(true);
		// A new pool has no hosts to tell.
		expect(pools).toEqual([]);

		expect(await root.updatePool("ci", { sync: true })).toMatchObject({ sync: true });
		expect(await api.service.poolSync(ci.id)).toBe(true);
		// A rename keeps it, and tells nothing.
		expect(await root.updatePool("ci", { name: "web" })).toMatchObject({ name: "web", sync: true });
		expect(await root.updatePool("web", { sync: false })).toMatchObject({ sync: false });
		expect(await api.service.poolSync(ci.id)).toBe(false);
		expect(pools).toEqual([
			{ poolId: ci.id, sync: true },
			{ poolId: ci.id, sync: false },
		]);
		// A telling that fails is answered so, the sync kept; the same call again tells them again.
		refuse = true;
		expect((await failure(root.updatePool("web", { sync: true }))).code).toBe("unavailable");
		expect(await api.service.poolSync(ci.id)).toBe(true);
		refuse = false;
		expect(await root.updatePool("web", { sync: true })).toMatchObject({ sync: true });
		expect(pools.at(-1)).toEqual({ poolId: ci.id, sync: true });
		expect((await root.listPools()).items.map((pool) => [pool.name, pool.sync])).toEqual([
			["default", false],
			["web", true],
			["builds", true],
		]);
		expect(await api.service.poolSync("pool_gone")).toBe(false);

		// An account's pools too.
		const own = await tom.createAccountPool({ name: "ci", sync: true });
		expect(own.sync).toBe(true);
		expect(await tom.updateAccountPool(own.id, { sync: false })).toMatchObject({ sync: false });
		expect(pools.at(-1)).toEqual({ poolId: own.id, sync: false });
	});

	it("keeps an account's pools to the account", async () => {
		const store = await make();
		const { backend } = hostsBackend();
		const { root, tom, ann } = setup(store, backend);
		const anns = await ann.createAccountPool({ name: "ci" });
		const personal = (await ann.getCaller()).accountId;
		expect(anns.accountId).toBe(personal);
		// Names are each owner's own.
		await tom.createAccountPool({ name: "ci" });
		await root.createPool({ name: "ci" });
		expect((await ann.listAccountPools({})).items.map((pool) => pool.name)).toEqual(["default", "ci"]);
		expect((await failure(tom.updateAccountPool(anns.id, { name: "mine" }))).code).toBe("not_found");
		expect((await failure(tom.deleteAccountPool(anns.id))).code).toBe("not_found");
		// The deployment's pools aren't an account's.
		const [operatorDefault] = (await root.listPools()).items;
		expect((await failure(ann.deleteAccountPool(operatorDefault?.id ?? ""))).code).toBe("not_found");
		expect(await ann.updateAccountPool("ci", { name: "builds" })).toMatchObject({ id: anns.id, name: "builds" });
		await ann.deleteAccountPool(anns.id);
		expect((await ann.listAccountPools({})).items.map((pool) => pool.name)).toEqual(["default"]);

		// Off with account hosts.
		const off = setup(store, backend, false);
		expect((await failure(off.ann.listAccountPools({}))).code).toBe("not_supported");
	});

	it("joins a host to the pool its token names", async () => {
		const store = await make();
		let joined: BackendHost | undefined;
		const { backend } = hostsBackend(() => (joined === undefined ? [] : [joined]));
		const { root } = setup(store, backend);
		const ci = await root.createPool({ name: "ci" });
		expect((await failure(root.createHostJoinToken({ pool: "nowhere" }))).code).toBe("not_found");
		await root.createHostJoinToken({ name: "builder", pool: "ci" });
		const [token] = await store.joinTokens.list({ name: "builder" });
		expect(token?.poolId).toBe(ci.id);
		const hash = token?.tokenHash ?? "";
		const spent = await joinTokenSpender(store).spendJoinToken(hash, "host_new", Date.now());
		expect(spent?.poolId).toBe(ci.id);

		// The registry may not keep it (an older one): the token says.
		joined = await hostLike("host_new");
		const listed = (await root.listHosts()).items.find((host) => host.id === "host_new");
		expect(listed?.poolId).toBe(ci.id);
		expect((await root.listPools()).items.find((pool) => pool.id === ci.id)?.hosts).toBe(1);
	});

	it("moves a drained host with no sandboxes to another pool, and no other", async () => {
		const store = await make();
		const { backend, told } = hostsBackend();
		const { root, tom } = setup(store, backend);
		const ci = await root.createPool({ name: "ci" });
		const sandbox = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		told.splice(0);

		// Not while it takes sandboxes, nor with another change, nor while it holds one.
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "ci" }))).code).toBe("conflict");
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "ci", draining: true }))).code).toBe("invalid");
		await root.updateHost(STUB_HOST_ID, { draining: true });
		const held = await failure(root.updateHost(STUB_HOST_ID, { pool: "ci" }));
		expect(held.code).toBe("conflict");
		expect(held.message).toContain("sandboxes");
		expect((await root.getHost(STUB_HOST_ID)).poolId).toBe(firstPoolId(OPERATOR_POOLS));

		// Drained and empty, it moves, here and in the registry, and stays draining until undrained.
		await tom.deleteSandbox(sandbox.id);
		const moved = await root.updateHost(STUB_HOST_ID, { pool: "ci" });
		expect(moved).toMatchObject({ state: "draining", poolId: ci.id });
		expect(told).toContainEqual({ hostId: STUB_HOST_ID, poolId: ci.id });
		expect((await root.listPools()).items.map((pool) => [pool.name, pool.hosts])).toEqual([
			["default", 0],
			["ci", 1],
		]);
		expect((await failure(root.deletePool("ci"))).code).toBe("conflict");
		expect((await root.updateHost(STUB_HOST_ID, { draining: false })).state).toBe("online");
		// Its own pool is no move; another account's pool isn't one of its owner's.
		expect((await root.updateHost(STUB_HOST_ID, { pool: "ci" })).poolId).toBe(ci.id);
		await tom.createAccountPool({ name: "mine" });
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "mine" }))).code).toBe("not_found");
	});

	it("doesn't move a host whose drain was ended (and made again) while its sandboxes were checked", async () => {
		const store = await make();
		const made = hostsBackend();
		let meanwhile: (() => Promise<unknown>) | undefined;
		const order: string[] = [];
		const backend: SandboxBackend = {
			...made.backend,
			hostHolds: async () => {
				const run = meanwhile;
				meanwhile = undefined;
				await run?.();
				return false;
			},
			updateHost: async (hostId, change) => {
				// An undrain ends the drain here before the registry takes sandboxes again.
				if (change.draining === false) order.push(`registry undrained, here ${(await store.hosts.get(hostId))?.state}`);
				await made.backend.updateHost?.(hostId, change);
			},
		};
		const { root } = setup(store, backend);
		const ci = await root.createPool({ name: "ci" });
		await root.updateHost(STUB_HOST_ID, { draining: true });
		// Undrained and drained again by another call while the move checks the host: the drain it checked under is gone.
		meanwhile = async () => {
			await root.updateHost(STUB_HOST_ID, { draining: false });
			await root.updateHost(STUB_HOST_ID, { draining: true });
		};
		const refused = await failure(root.updateHost(STUB_HOST_ID, { pool: "ci" }));
		expect(refused.code).toBe("conflict");
		expect(refused.message).toContain("undrained meanwhile");
		expect(order).toEqual(["registry undrained, here online"]);
		expect((await root.getHost(STUB_HOST_ID)).poolId).toBe(firstPoolId(OPERATOR_POOLS));
		// Uninterrupted, it moves; the drain's token never shows.
		const moved = await root.updateHost(STUB_HOST_ID, { pool: "ci" });
		expect(moved).toMatchObject({ state: "draining", poolId: ci.id });
		expect(moved).not.toHaveProperty("drainToken");
	});

	it("counts a create still under way on the host as holding it", async () => {
		const store = await make();
		const made = hostsBackend();
		let placing: string | undefined;
		const backend: SandboxBackend = {
			...made.backend,
			placedOn: async (sandboxId) => (sandboxId === placing ? STUB_HOST_ID : undefined),
		};
		const { root, tom } = setup(store, backend);
		await root.createPool({ name: "ci" });
		// A create the host is making, whose record doesn't name the host yet.
		const sandbox = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		await store.sandboxes.update(sandbox.id, ({ hostId: _host, ...rest }) => ({ ...rest, state: "starting" }));
		placing = sandbox.id;
		await root.updateHost(STUB_HOST_ID, { draining: true });
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "ci" }))).code).toBe("conflict");
		// One whose create was never answered, which its host may still have made, holds it too.
		await store.sandboxes.update(sandbox.id, (current) => ({ ...current, state: "error" }));
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "ci" }))).code).toBe("conflict");
		placing = undefined;
		await store.sandboxes.update(sandbox.id, (current) => ({ ...current, state: "deleted" }));
		expect((await root.updateHost(STUB_HOST_ID, { pool: "ci" })).state).toBe("draining");
	});

	it("puts a host whose pool has gone into its owner's default", async () => {
		const store = await make();
		let joined: BackendHost | undefined;
		const { backend } = hostsBackend(() => (joined === undefined ? [] : [joined]));
		const { root } = setup(store, backend);
		const ci = await root.createPool({ name: "ci" });
		// A token for ci, spent once ci has gone (a join that raced its delete).
		await root.createHostJoinToken({ name: "late", pool: "ci" });
		await root.deletePool("ci");
		const [token] = await store.joinTokens.list({ name: "late" });
		await joinTokenSpender(store).spendJoinToken(token?.tokenHash ?? "", "host_late", Date.now());
		joined = await hostLike("host_late");
		const late = (await root.listHosts()).items.find((host) => host.id === "host_late");
		expect(late?.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		// A host moved into a pool as it was deleted.
		await store.hosts.update(STUB_HOST_ID, (current) => ({ ...current, poolId: ci.id }));
		await root.listHosts();
		expect((await store.hosts.get(STUB_HOST_ID))?.poolId).toBe(firstPoolId(OPERATOR_POOLS));
	});

	it("keeps a host in a pool made after the pools were read, and makes no pools for an account that has gone", async () => {
		const store = await make();
		let stale: string | undefined;
		const made: string[] = [];
		const viewed: ComputeStore = {
			...store,
			pools: {
				...store.pools,
				insert: async (pool) => {
					made.push(pool.owner);
					return store.pools.insert(pool);
				},
				// A read of the pools from before one was made (another connection's).
				list: async (where) => (await store.pools.list(where)).filter((pool) => pool.id !== stale),
			},
		};
		let own: BackendHost | undefined;
		const { backend } = hostsBackend(() => (own === undefined ? [] : [own]));
		const { root, tom } = setup(viewed, backend);
		const ci = await root.createPool({ name: "ci" });
		await root.listHosts();
		await store.hosts.update(STUB_HOST_ID, (current) => ({ ...current, poolId: ci.id }));
		stale = ci.id;
		await root.listHosts();
		expect((await store.hosts.get(STUB_HOST_ID))?.poolId).toBe(ci.id);
		stale = undefined;

		// An organisation's host, the organisation deleted: its pools aren't made again on every read.
		const org = await tom.createOrganisation({ name: "Acme" });
		own = await hostLike("host_org", org.id);
		await root.listHosts();
		await tom.deleteOrganisation(org.id);
		made.splice(0);
		await root.listHosts();
		await root.listHosts();
		expect(made).not.toContain(org.id);
		expect(await store.pools.list({ owner: org.id })).toEqual([]);
	});

	it("tells the registry again where a move's call to it failed", async () => {
		const store = await make();
		const made = hostsBackend();
		let refuse = false;
		const backend: SandboxBackend = {
			...made.backend,
			updateHost: async (hostId, change) => {
				if (change.poolId !== undefined && change.draining === undefined && refuse) {
					refuse = false;
					throw new Error("the registry is away");
				}
				await made.backend.updateHost?.(hostId, change);
			},
		};
		const { api, root } = setup(store, backend);
		const ci = await root.createPool({ name: "ci" });
		await root.listHosts();
		await api.service.idle();
		expect(made.registry.get(STUB_HOST_ID)).toBe(firstPoolId(OPERATOR_POOLS));
		refuse = true;
		await root.updateHost(STUB_HOST_ID, { draining: true });
		expect((await root.updateHost(STUB_HOST_ID, { pool: "ci" })).poolId).toBe(ci.id);
		expect(made.registry.get(STUB_HOST_ID)).toBe(firstPoolId(OPERATOR_POOLS));
		// The next read, here or on any gateway, finds the registry's pool differs and tells it.
		await root.listHosts();
		await api.service.idle();
		expect(made.registry.get(STUB_HOST_ID)).toBe(ci.id);
	});

	it("places a sandbox in the deployment's pool it names, keeps its pool, and says which pool when none can take it", async () => {
		const store = await make();
		const { backend } = hostsBackend();
		const { root, tom } = setup(store, backend);
		await root.createPool({ name: "ci" });
		// Naming none: the deployment's default, as before pools, kept on the sandbox and its fork.
		const plain = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		expect(plain.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		expect((await store.sandboxes.get(plain.id))?.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		const named = await tom.createSandbox({ type: "microvm", pool: "default", wait: true });
		expect(named.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		// The empty pool can't take it: refused, saying which.
		const refused = await failure(tom.createSandbox({ type: "microvm", pool: "ci" }));
		expect(refused.code).toBe("unavailable");
		expect(refused.details).toMatchObject({ reason: "no_host" });
		expect(refused.message).toContain("pool ci");
		expect((await failure(tom.createSandbox({ type: "microvm", pool: "nowhere" }))).code).toBe("not_found");
	});

	it("keeps a sandbox from a snapshot to the snapshot's pool, and one whose pool has gone to none", async () => {
		const store = await make();
		const other = await hostLike("host_ci");
		const made = hostsBackend(() => [other]);
		const specs: { readonly sandboxId: string; readonly poolId?: string }[] = [];
		const backend: SandboxBackend = {
			...made.backend,
			create: async (spec) => {
				specs.push({ sandboxId: spec.sandboxId, ...(spec.poolId === undefined ? {} : { poolId: spec.poolId }) });
				return made.backend.create(spec);
			},
		};
		const { root, tom } = setup(store, backend);
		await root.createPool({ name: "ci" });
		// Another shared host, in ci.
		await root.listHosts();
		await root.updateHost("host_ci", { draining: true });
		await root.updateHost("host_ci", { pool: "ci" });
		await root.updateHost("host_ci", { draining: false });
		const source = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		const saved = await tom.saveSnapshot({ name: "golden", sandboxId: source.id });
		// Made from it, in its host's pool; naming another pool is refused, not left to run elsewhere later.
		const restored = await tom.createSandbox({ from: saved.id, autoStopMinutes: null, wait: true });
		expect(restored.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		// Its admission is kept to that pool too, as a fresh create's is.
		expect(specs.find((spec) => spec.sandboxId === restored.id)?.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		expect(specs.find((spec) => spec.sandboxId === source.id)?.poolId).toBe(firstPoolId(OPERATOR_POOLS));
		const elsewhere = await failure(tom.createSandbox({ from: saved.id, pool: "ci" }));
		expect(elsewhere.code).toBe("unavailable");
		expect(elsewhere.message).toContain("another pool");

		// Never placed, its pool gone: started again, it isn't placed in another.
		const lost = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		await tom.stopSandbox(lost.id);
		await store.sandboxes.update(lost.id, ({ hostId: _host, latestSnapshotId: _snap, ...rest }) => ({
			...rest,
			state: "error",
			poolId: "pool_gone",
		}));
		const refused = await failure(tom.startSandbox(lost.id));
		expect(refused.code).toBe("unavailable");
		expect(refused.message).toContain("pool_gone");
	});

	it("offers the shapes of the pool a create would go in", async () => {
		const store = await make();
		const big = {
			...(await hostLike("host_ci")),
			sizes: [{ name: "xlarge" as const, vcpus: 32, memoryMb: 65_536, diskGb: 100 }],
		};
		const { backend } = hostsBackend(() => [big]);
		const { root, tom } = setup(store, backend);
		await root.createPool({ name: "ci" });
		await root.listHosts();
		await root.updateHost("host_ci", { draining: true });
		await root.updateHost("host_ci", { pool: "ci" });
		await root.updateHost("host_ci", { draining: false });
		const names = (shapes: Awaited<ReturnType<typeof tom.getSandboxShapes>>) =>
			(shapes.microvm?.presets ?? []).map((preset) => preset.name);
		expect((await tom.getSandboxShapes()).microvm?.presets).not.toContainEqual(expect.objectContaining({ vcpus: 32 }));
		expect(names(await tom.getSandboxShapes({ pool: "ci" }))).toEqual(["xlarge"]);
	});

	it("deletes an account's pools with the account", async () => {
		const store = await make();
		const { backend } = hostsBackend();
		const { api, tom } = setup(store, backend);
		const org = await tom.createOrganisation({ name: "Acme" });
		await tom.createAccountPool({ account: org.id, name: "ci" });
		expect(await store.pools.list({ owner: org.id })).toHaveLength(2);
		await tom.deleteOrganisation(org.id);
		await api.service.idle();
		expect(await store.pools.list({ owner: org.id })).toEqual([]);
	});
});
