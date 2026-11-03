// Kantel Connect, end to end through the compute API, the hosts service and its hub with fake kantel-hosts: a person
// enrols a host into their personal account or an organisation with a token the API mints, the host dials out and
// joins, and from then on only that account's sandboxes go on it. The deployment's shared hosts are what everyone
// else uses, and the routes answer `not_supported` while the switch is off.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender, type PersonIdentity } from "@kantel/compute";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	root: { userId: "usr_root", name: "Root", superAdmin: true },
	tom: { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	ann: { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
	bob: { userId: "usr_bob", name: "Bob", email: "bob@example.com" },
};

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

function setup(options: { connect?: boolean } = {}) {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	const api: ComputeApi = createComputeApi({
		backend: createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		}),
		authenticatePerson: async (request) =>
			PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
		connect: options.connect ?? true,
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	closers.push(
		() => service.close(),
		() => api.close(),
	);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	/** Joins a host with `token` and connects it, as `kantel-host join` and its daemon do. */
	const join = async (token: string) => {
		const { hostId } = await service.register({ token, facts: facts() });
		const host = new FakeHost(service, hostId);
		host.connect();
		return host;
	};
	return { service, api, join, root: client("root"), tom: client("tom"), ann: client("ann"), bob: client("bob") };
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

describe("Kantel Connect", () => {
	it("answers not_supported on every route while the switch is off, and leaves the operator's hosts alone", async () => {
		const { tom, root, join } = setup({ connect: false });
		expect((await failure(tom.createConnectEnrolment({}))).code).toBe("not_supported");
		expect((await failure(tom.listConnectHosts())).code).toBe("not_supported");
		expect((await failure(tom.getConnectHost("host_x"))).code).toBe("not_supported");
		expect((await failure(tom.updateConnectHost("host_x", { draining: true }))).code).toBe("not_supported");
		expect((await failure(tom.removeConnectHost("host_x"))).code).toBe("not_supported");
		// The super-admin's join tokens and shared hosts work as before.
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		expect(shared.sandboxes.has(sandbox.id)).toBe(true);
	});

	it("enrols a host into a person's own account, which alone runs its sandboxes there", async () => {
		const { tom, ann, root, join } = setup();
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);

		const enrolment = await tom.createConnectEnrolment({ name: "tom-laptop", labels: { gpu: "none" } });
		const me = await tom.getCaller();
		expect(enrolment.accountId).toBe(me.accountId);
		expect(enrolment.id).toMatch(/^enr_/);
		expect(enrolment.token).toMatch(/^kth_/);
		expect(enrolment.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.test --token ${enrolment.token}`,
		);
		const own = await join(enrolment.token);

		// Tom sees his host, belonging to his account; Ann sees none, and can't read his by its ID.
		const listed = (await tom.listConnectHosts()).items;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: own.hostId,
			name: "tom-laptop",
			state: "online",
			accountId: me.accountId,
			labels: { gpu: "none" },
		});
		expect((await ann.listConnectHosts()).items).toEqual([]);
		expect((await failure(ann.getConnectHost(own.hostId))).code).toBe("not_found");
		expect((await failure(ann.removeConnectHost(own.hostId))).code).toBe("not_found");
		// A shared host isn't anyone's to manage through Connect.
		expect((await failure(tom.getConnectHost(shared.hostId))).code).toBe("not_found");
		// The super-admin still sees every host, the account's included.
		expect((await root.listHosts()).items.map((host) => host.id).sort()).toEqual([own.hostId, shared.hostId].sort());

		// Tom's sandboxes go on his own host; Ann's never do.
		for (let i = 0; i < 3; i++) {
			const mine = await tom.createSandbox({ type: "microvm", wait: true });
			expect(own.sandboxes.has(mine.id)).toBe(true);
			const hers = await ann.createSandbox({ type: "microvm", wait: true });
			expect(shared.sandboxes.has(hers.id)).toBe(true);
			expect(own.sandboxes.has(hers.id)).toBe(false);
		}
		// Commands reach the sandbox through the host's outbound connection.
		const mine = await tom.createSandbox({ type: "microvm", wait: true });
		expect((await tom.runCommand(mine.id, { command: "echo hi" })).stdout).toBe("hi\n");

		// The token joined one host, once.
		await expect(join(enrolment.token)).rejects.toThrow(/unknown, used or expired/);
	});

	it("keeps another account's sandboxes off an account's host even with no shared host to fall back on", async () => {
		const { tom, ann, join } = setup();
		const own = await join((await tom.createConnectEnrolment({})).token);
		expect((await failure(ann.createSandbox({ type: "microvm" }))).code).toBe("unavailable");
		const mine = await tom.createSandbox({ type: "microvm", wait: true });
		expect(own.sandboxes.has(mine.id)).toBe(true);
	});

	it("falls back to the shared hosts while the account's own are drained, and removes a host", async () => {
		const { tom, root, join } = setup();
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);
		const own = await join((await tom.createConnectEnrolment({})).token);

		const drained = await tom.updateConnectHost(own.hostId, { draining: true, name: "renamed" });
		expect(drained).toMatchObject({ state: "draining", name: "renamed" });
		const elsewhere = await tom.createSandbox({ type: "microvm", wait: true });
		expect(shared.sandboxes.has(elsewhere.id)).toBe(true);

		await tom.updateConnectHost(own.hostId, { draining: false });
		const back = await tom.createSandbox({ type: "microvm", wait: true });
		expect(own.sandboxes.has(back.id)).toBe(true);

		const removed = await tom.removeConnectHost(own.hostId);
		expect(removed.state).toBe("revoked");
		expect(own.closedWith).toBeDefined();
		expect((await tom.listConnectHosts()).items.map((host) => [host.id, host.state])).toEqual([
			[own.hostId, "revoked"],
		]);
		expect((await failure(tom.updateConnectHost(own.hostId, { draining: true }))).code).toBe("conflict");
	});

	it("enrols into an organisation for its admins only, and its members share the host", async () => {
		const { tom, ann, bob, join } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });

		// A member may see the organisation's hosts but not enrol one; someone outside it may do neither.
		expect((await failure(ann.createConnectEnrolment({ account: org.id }))).code).toBe("forbidden");
		expect((await failure(bob.createConnectEnrolment({ account: org.id }))).code).toBe("forbidden");
		expect((await failure(bob.listConnectHosts({ account: org.id }))).code).toBe("forbidden");

		const enrolment = await tom.createConnectEnrolment({ account: org.id, name: "acme-box" });
		expect(enrolment.accountId).toBe(org.id);
		const host = await join(enrolment.token);
		expect((await ann.listConnectHosts({ account: org.id })).items.map((item) => item.id)).toEqual([host.hostId]);
		// Ann's personal account has no hosts; the organisation's isn't hers to use there.
		expect((await ann.listConnectHosts()).items).toEqual([]);
		expect((await failure(ann.createSandbox({ type: "microvm" }))).code).toBe("unavailable");
		// In the organisation, her sandboxes go on its host; a member can't drain or remove it.
		const sandbox = await ann.createSandbox({ type: "microvm", account: org.id, wait: true });
		expect(host.sandboxes.has(sandbox.id)).toBe(true);
		expect((await failure(ann.updateConnectHost(host.hostId, { draining: true }))).code).toBe("forbidden");
		expect((await failure(ann.removeConnectHost(host.hostId))).code).toBe("forbidden");
		expect((await failure(bob.getConnectHost(host.hostId))).code).toBe("not_found");
	});

	it("never places a sandbox with another owner on an account's host, whatever hosts the caller names", async () => {
		const { service, tom, join } = setup();
		const own = await join((await tom.createConnectEnrolment({})).token);
		await expect(
			service.sandboxes.create({ sandboxId: "sbx_other", tier: "microvm", owner: "acc_other", hostIds: [own.hostId] }),
		).rejects.toThrow();
		expect(own.sandboxes.has("sbx_other")).toBe(false);
	});
});
