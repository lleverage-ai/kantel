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

	it("moves a host to another pool once it has drained", async () => {
		const store = await make();
		const { backend, told } = hostsBackend();
		const { api: served, root, tom } = setup(store, backend);
		const ci = await root.createPool({ name: "ci" });
		const sandbox = await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		told.splice(0);

		// Holding a sandbox, it drains first: no new sandboxes, still in its pool.
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "ci", draining: false }))).code).toBe("invalid");
		const moving = await root.updateHost(STUB_HOST_ID, { pool: "ci" });
		expect(moving).toMatchObject({ state: "draining", poolId: firstPoolId(OPERATOR_POOLS), movingTo: ci.id });
		expect(told).toEqual([{ hostId: STUB_HOST_ID, draining: true }]);
		expect((await failure(tom.createSandbox({ type: "microvm" }))).code).toBe("unavailable");
		expect((await root.getHost(STUB_HOST_ID)).movingTo).toBe(ci.id);
		// A pool with a host moving to it isn't deleted.
		expect((await failure(root.deletePool("ci"))).code).toBe("conflict");

		// Its last sandbox gone, it joins the pool and takes sandboxes again.
		await tom.deleteSandbox(sandbox.id);
		await served.service.idle();
		await root.listHosts();
		await served.service.idle();
		const moved = await root.getHost(STUB_HOST_ID);
		expect(moved).toMatchObject({ state: "online", poolId: ci.id });
		expect(moved).not.toHaveProperty("movingTo");
		expect(told).toContainEqual({ hostId: STUB_HOST_ID, poolId: ci.id, draining: false });
		expect((await root.listPools()).items.map((pool) => [pool.name, pool.hosts])).toEqual([
			["default", 0],
			["ci", 1],
		]);

		// With nothing on it, a move is at once.
		const back = await root.updateHost(STUB_HOST_ID, { pool: "default" });
		expect(back).toMatchObject({ state: "online", poolId: firstPoolId(OPERATOR_POOLS) });
		expect(back).not.toHaveProperty("movingTo");
	});

	it("cancels a move by naming the host's own pool, leaving it draining", async () => {
		const store = await make();
		const { backend } = hostsBackend();
		const { root, tom } = setup(store, backend);
		await root.createPool({ name: "ci" });
		await tom.createSandbox({ type: "microvm", autoStopMinutes: null, wait: true });
		await root.updateHost(STUB_HOST_ID, { pool: "ci" });
		const cancelled = await root.updateHost(STUB_HOST_ID, { pool: "default" });
		expect(cancelled).toMatchObject({ state: "draining", poolId: firstPoolId(OPERATOR_POOLS) });
		expect(cancelled).not.toHaveProperty("movingTo");
		// Another account's pool isn't the host's to move to.
		await tom.createAccountPool({ name: "mine" });
		expect((await failure(root.updateHost(STUB_HOST_ID, { pool: "mine" }))).code).toBe("not_found");
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
