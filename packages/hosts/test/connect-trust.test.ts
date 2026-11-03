// What an account's own host (Kantel Connect) is trusted with, and what it may report: anyone can enrol one, so it
// never gets the deployment's attribution key, and nothing it says about itself can break another account's
// placement or the host's own revocation.
import type { BackendEgress } from "@kantel/compute";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { parseHostFacts } from "../src/facts.ts";
import { createHostsApi } from "../src/http.ts";
import type { HostMessage } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore, createSqlHostStore, type HostRecord, migrateHosts } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const KEY = "the-deployment-attribution-key";
const EGRESS: BackendEgress = {
	defaultAction: "deny",
	allow: ["example.com"],
	deny: ["evil.test"],
	upstream: { url: "https://proxy.test", headers: { "x-account-secret": "s3cret" } },
	attribution: true,
};

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

/** A shared host the operator joined, and one enrolled into `acc_a`, both connected. */
async function setup() {
	const store = createMemoryHostStore();
	const service = createHostsService({ store, publicUrl: "https://kantel.test" });
	closers.push(() => service.close());
	const sharedToken = await service.createJoinToken({ name: "shared" });
	const shared = new FakeHost(service, (await service.register({ token: sharedToken.token, facts: facts() })).hostId);
	// Enrolments come from the compute API's join tokens; this one joins account acc_a.
	service.useJoinTokens({ spendJoinToken: async () => ({ id: "enr_a", labels: {}, accountId: "acc_a" }) });
	const own = new FakeHost(service, (await service.register({ token: "kth_enrolment", facts: facts() })).hostId);
	shared.connect();
	own.connect();
	await vi.waitFor(() => expect(shared.welcomed() && own.welcomed()).toBe(true));
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
		attributionKey: KEY,
	});
	return { service, store, backend, shared, own };
}

/** The egress of every call `host` was sent with `method`. */
const egressSent = (host: FakeHost, method: string) =>
	host.sent
		.filter((message: HostMessage) => message.type === "call" && message.method === method)
		.map((message) => (message.params as { egress?: Record<string, unknown> }).egress);

const spec = (sandboxId: string, accountId: string, eligibleHosts: string[]) => ({
	sandboxId,
	accountId,
	type: "microvm" as const,
	subdomain: sandboxId,
	env: {},
	eligibleHosts,
	egress: EGRESS,
});

describe("an account's own host", () => {
	it("never receives the deployment's attribution key, on any path; shared hosts still do", async () => {
		const { backend, shared, own } = await setup();
		await backend.create(spec("sbx_own", "acc_a", [own.hostId]));
		await backend.create(spec("sbx_shared", "acc_b", [shared.hostId]));
		// Start, resume and recover: the fake host refuses them, but what it was sent is what counts.
		for (const [id, on] of [
			["sbx_own", own.hostId],
			["sbx_shared", shared.hostId],
		] as const) {
			const how = { env: {}, eligibleHosts: [on], egress: EGRESS };
			await backend.start(id, how).catch(() => undefined);
			await backend.resume(id, how).catch(() => undefined);
			await backend.recover(id, how).catch(() => undefined);
			await backend.updateEgress?.(id, EGRESS).catch(() => undefined);
		}
		await backend.fork({ sandboxId: "sbx_own" }, [spec("sbx_own_fork", "acc_a", [own.hostId])]);
		await backend.fork({ sandboxId: "sbx_shared" }, [spec("sbx_shared_fork", "acc_b", [shared.hostId])]);

		const rules = {
			mode: "proxy",
			allow: ["example.com"],
			deny: ["evil.test"],
			defaultDeny: true,
			upstream: "https://proxy.test",
			headers: { "x-account-secret": "s3cret" },
		};
		for (const method of ["sandbox.create", "sandbox.start", "sandbox.resume", "sandbox.fork", "sandbox.egress"]) {
			const toOwn = egressSent(own, method);
			const toShared = egressSent(shared, method);
			expect(toOwn.length, method).toBeGreaterThan(0);
			expect(toShared.length, method).toBeGreaterThan(0);
			// The account's rules and upstream reach its host; the key doesn't.
			for (const egress of toOwn) expect(egress, method).toEqual(rules);
			for (const egress of toShared) expect(egress, method).toEqual({ ...rules, attributionKey: KEY });
		}
		expect(JSON.stringify(own.sent)).not.toContain(KEY);
	});

	it("is refused a malformed report at registration and at hello, and a valid one still counts", async () => {
		const { service, backend } = await setup();
		const api = createHostsApi({ hosts: service, authorizeAdmin: async () => undefined });
		const register = (body: object) =>
			api.fetch(
				new Request("https://kantel.test/v1/hosts/register", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		for (const bad of [{ tiers: {} }, { ...facts(), sizes: [{ name: "x", vcpus: "2" }] }, { ...facts(), cpus: -1 }]) {
			const refused = await register({ token: "kth_enrolment", facts: bad });
			expect(refused?.status).toBe(400);
		}
		// Absent facts, and Go's nulls for empty lists, still register.
		expect((await register({ token: "kth_enrolment" }))?.status).toBe(201);
		const nulls = { ...facts(), tiers: null, sizes: null, labels: null };
		expect((await register({ token: "kth_enrolment", facts: nulls }))?.status).toBe(201);
		expect(parseHostFacts({ ...facts(), tiers: ["microvm", "gpu"] })).toMatchObject({
			ok: true,
			value: { tiers: ["microvm"] },
		});

		// A hello with malformed facts is refused (4002) and nothing it said is kept.
		const { hostId } = await service.register({ token: "kth_enrolment", facts: facts() });
		let closed: number | undefined;
		const connection = service.hub.accept(hostId, {
			sendText: () => undefined,
			sendBinary: () => undefined,
			close: (code) => {
				closed = code;
			},
		});
		connection.receive(
			JSON.stringify({
				type: "hello",
				hello: { hostId, facts: { ...facts(), tiers: {} }, sandboxes: [], capacity: { freeMemoryMiB: 1 } },
			}),
		);
		await vi.waitFor(() => expect(closed).toBe(4002));
		expect((await service.get(hostId)).tiers).toEqual(["microvm", "isolate"]);
		// Capabilities still aggregate every host.
		expect([...(await backend.capabilities()).types].sort()).toEqual(["isolate", "microvm"]);
	});

	it("can't break placement or its own revocation with a malformed report kept from before", async () => {
		const { service, store, backend, own, shared } = await setup();
		const record = await store.getHost(own.hostId);
		if (record === undefined) throw new Error("no host");
		await store.putHost({ ...record, facts: { tiers: {} } as never, capacity: { warm: 3 } as never });

		const capabilities = await backend.capabilities();
		expect(capabilities.hosts.map((host) => host.id).sort()).toEqual([own.hostId, shared.hostId].sort());
		// Another account still gets a sandbox; the bad host counts as offering nothing.
		const placed = await backend.create(spec("sbx_b", "acc_b", [shared.hostId, own.hostId]));
		expect(placed.hostId).toBe(shared.hostId);
		expect((await service.get(own.hostId)).tiers).toEqual([]);
		expect((await service.revoke(own.hostId)).state).toBe("revoked");
	});

	it("boots a disk only on its own host, and only when the service named that host eligible", async () => {
		const { backend, own, shared } = await setup();
		await backend.create(spec("sbx_on_shared", "acc_a", [shared.hostId]));
		const how = (eligibleHosts: string[]) => ({ env: {}, eligibleHosts, egress: EGRESS });
		const sentStarts = () => egressSent(shared, "sandbox.start").length;
		// Its host isn't in the list (only the account's own is): refused, and the shared host is never asked.
		for (const boot of [backend.start, backend.resume, backend.recover]) {
			await expect(boot("sbx_on_shared", how([own.hostId]))).rejects.toMatchObject({ code: "unavailable" });
		}
		expect(sentStarts()).toBe(0);
		await expect(
			backend.fork({ sandboxId: "sbx_on_shared" }, [spec("sbx_fork", "acc_a", [own.hostId])]),
		).rejects.toMatchObject({ code: "unavailable" });
		await expect(
			backend.create({ ...spec("sbx_from", "acc_a", [own.hostId]), fromSnapshot: `${shared.hostId}/snap_1` }),
		).rejects.toMatchObject({ code: "unavailable" });
		// Named (the account may use shared hosts): it is asked, where the disk is.
		await backend.start("sbx_on_shared", how([own.hostId, shared.hostId])).catch(() => undefined);
		expect(sentStarts()).toBe(1);
	});
});

describe("a host's revocation", () => {
	it("isn't undone by a heartbeat that read the host before it was revoked", async () => {
		const { service, store, own } = await setup();
		const stale = await store.getHost(own.hostId);
		if (stale === undefined) throw new Error("no host");
		await service.revoke(own.hostId);
		// The heartbeat's write lands after the revocation, over the record it read before.
		await store.putHost({ ...stale, lastSeenAt: (stale.lastSeenAt ?? 0) + 1 });
		expect((await store.getHost(own.hostId))?.revoked).toBe(true);
		expect((await service.get(own.hostId)).state).toBe("revoked");
	});

	for (const kind of testDatabaseKinds()) {
		it(`sticks in SQL (${kind.name}) when an older record is written over it`, async () => {
			const db = await kind.open();
			closers.push(() => void db.close());
			await migrateHosts(db.driver);
			const store = createSqlHostStore(db.driver);
			const host: HostRecord = {
				id: "host_1",
				name: "box",
				credentialHash: "hash_1",
				labels: { note: '"revoked":true' },
				joinedAt: 1,
				lastSeenAt: 1,
				revoked: false,
				draining: false,
			};
			await store.insertHost(host);
			// A label that reads like the flag doesn't make a live host count as revoked.
			await store.putHost({ ...host, name: "renamed" });
			expect(await store.getHost("host_1")).toMatchObject({ name: "renamed", revoked: false });
			await store.putHost({ ...host, revoked: true });
			await store.putHost({ ...host, lastSeenAt: 2 });
			expect(await store.getHost("host_1")).toMatchObject({ lastSeenAt: 2, revoked: true });
			expect((await store.hostByCredential("hash_1"))?.revoked).toBe(true);
		});
	}
});
