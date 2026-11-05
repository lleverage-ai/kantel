// An account's own hosts, end to end through the compute API, the hosts service and its hub with fake kantel-hosts: a
// person adds a host to their personal account or an organisation with a token the API mints, the host dials out and
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

function setup(options: { accountHosts?: boolean } = {}) {
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
		accountHosts: options.accountHosts ?? true,
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

describe("Account hosts", () => {
	it("answers not_supported on every route while the switch is off, and leaves the operator's hosts alone", async () => {
		const { tom, root, join } = setup({ accountHosts: false });
		expect((await failure(tom.createAccountJoinToken({}))).code).toBe("not_supported");
		expect((await failure(tom.listAccountHosts())).code).toBe("not_supported");
		expect((await failure(tom.getAccountHost("host_x"))).code).toBe("not_supported");
		expect((await failure(tom.updateAccountHost("host_x", { draining: true }))).code).toBe("not_supported");
		expect((await failure(tom.removeAccountHost("host_x"))).code).toBe("not_supported");
		// The super-admin's join tokens and shared hosts work as before.
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		expect(shared.sandboxes.has(sandbox.id)).toBe(true);
	});

	it("adds a host to a person's own account, which alone runs its sandboxes there", async () => {
		const { tom, ann, root, join } = setup();
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);

		const joinToken = await tom.createAccountJoinToken({ name: "tom-laptop", labels: { gpu: "none" } });
		const me = await tom.getCaller();
		expect(joinToken.accountId).toBe(me.accountId);
		expect(joinToken.id).toMatch(/^enr_/);
		expect(joinToken.token).toMatch(/^kth_/);
		expect(joinToken.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.test --token ${joinToken.token}`,
		);
		const own = await join(joinToken.token);

		// Tom sees his host, belonging to his account; Ann sees none, and can't read his by its ID.
		const listed = (await tom.listAccountHosts()).items;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: own.hostId,
			name: "tom-laptop",
			state: "online",
			accountId: me.accountId,
			labels: { gpu: "none" },
		});
		expect((await ann.listAccountHosts()).items).toEqual([]);
		expect((await failure(ann.getAccountHost(own.hostId))).code).toBe("not_found");
		expect((await failure(ann.removeAccountHost(own.hostId))).code).toBe("not_found");
		// A shared host isn't anyone's to manage as one of their own.
		expect((await failure(tom.getAccountHost(shared.hostId))).code).toBe("not_found");
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
		await expect(join(joinToken.token)).rejects.toThrow(/unknown, used or expired/);
	});

	it("keeps another account's sandboxes off an account's host even with no shared host to fall back on", async () => {
		const { tom, ann, join } = setup();
		const own = await join((await tom.createAccountJoinToken({})).token);
		expect((await failure(ann.createSandbox({ type: "microvm" }))).code).toBe("unavailable");
		const mine = await tom.createSandbox({ type: "microvm", wait: true });
		expect(own.sandboxes.has(mine.id)).toBe(true);
	});

	it("falls back to the shared hosts while the account's own are drained, and removes a host", async () => {
		const { tom, root, join } = setup();
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);
		const own = await join((await tom.createAccountJoinToken({})).token);

		const drained = await tom.updateAccountHost(own.hostId, { draining: true, name: "renamed" });
		expect(drained).toMatchObject({ state: "draining", name: "renamed" });
		const elsewhere = await tom.createSandbox({ type: "microvm", wait: true });
		expect(shared.sandboxes.has(elsewhere.id)).toBe(true);

		await tom.updateAccountHost(own.hostId, { draining: false });
		const back = await tom.createSandbox({ type: "microvm", wait: true });
		expect(own.sandboxes.has(back.id)).toBe(true);

		const removed = await tom.removeAccountHost(own.hostId);
		expect(removed.state).toBe("revoked");
		expect(own.closedWith).toBeDefined();
		expect((await tom.listAccountHosts()).items.map((host) => [host.id, host.state])).toEqual([
			[own.hostId, "revoked"],
		]);
		expect((await failure(tom.updateAccountHost(own.hostId, { draining: true }))).code).toBe("conflict");
	});

	it("adds a host to an organisation for its admins only, and its members share the host", async () => {
		const { tom, ann, bob, join } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });

		// A member may see the organisation's hosts but not add one; someone outside it may do neither.
		expect((await failure(ann.createAccountJoinToken({ account: org.id }))).code).toBe("forbidden");
		expect((await failure(bob.createAccountJoinToken({ account: org.id }))).code).toBe("forbidden");
		expect((await failure(bob.listAccountHosts({ account: org.id }))).code).toBe("forbidden");

		const joinToken = await tom.createAccountJoinToken({ account: org.id, name: "acme-box" });
		expect(joinToken.accountId).toBe(org.id);
		const host = await join(joinToken.token);
		expect((await ann.listAccountHosts({ account: org.id })).items.map((item) => item.id)).toEqual([host.hostId]);
		// Ann's personal account has no hosts; the organisation's isn't hers to use there.
		expect((await ann.listAccountHosts()).items).toEqual([]);
		expect((await failure(ann.createSandbox({ type: "microvm" }))).code).toBe("unavailable");
		// In the organisation, her sandboxes go on its host; a member can't drain or remove it.
		const sandbox = await ann.createSandbox({ type: "microvm", account: org.id, wait: true });
		expect(host.sandboxes.has(sandbox.id)).toBe(true);
		expect((await failure(ann.updateAccountHost(host.hostId, { draining: true }))).code).toBe("forbidden");
		expect((await failure(ann.removeAccountHost(host.hostId))).code).toBe("forbidden");
		expect((await failure(bob.getAccountHost(host.hostId))).code).toBe("not_found");
	});

	it("puts a sandbox on the host its create names, and shows its host to whoever may know that host", async () => {
		const { tom, ann, root, join } = setup();
		const shared = await join((await root.createHostJoinToken({ name: "shared" })).token);
		const first = await join((await tom.createAccountJoinToken({ name: "tom-one" })).token);
		const second = await join((await tom.createAccountJoinToken({ name: "tom-two" })).token);

		// By name and by ID, each lands where it was told to, whichever host placement would have picked.
		for (const [ref, host] of [
			["tom-one", first],
			["tom-two", second],
			[first.hostId, first],
			[second.hostId, second],
		] as const) {
			const sandbox = await tom.createSandbox({ type: "microvm", host: ref, wait: true });
			expect(host.sandboxes.has(sandbox.id)).toBe(true);
			// Its own account's host: shown to Tom, with its name.
			expect(await tom.getSandbox(sandbox.id)).toMatchObject({
				hostId: host.hostId,
				hostName: host === first ? "tom-one" : "tom-two",
			});
		}
		// Listed by host, by name or ID.
		const onFirst = (await tom.listSandboxes({ host: "tom-one" })).items;
		expect(onFirst).toHaveLength(2);
		expect(onFirst.every((sandbox) => sandbox.hostId === first.hostId && sandbox.hostName === "tom-one")).toBe(true);
		expect((await tom.listSandboxes({ host: second.hostId })).items).toHaveLength(2);

		// A shared host, or another account's, isn't Tom's to name: not_found, so it isn't given away.
		expect((await failure(tom.createSandbox({ type: "microvm", host: shared.hostId }))).code).toBe("not_found");
		expect((await failure(ann.createSandbox({ type: "microvm", host: first.hostId }))).code).toBe("not_found");
		expect((await failure(ann.listSandboxes({ host: first.hostId }))).code).toBe("not_found");
		// Ann's sandbox on the shared host: its host isn't shown to her.
		const hers = await ann.createSandbox({ type: "microvm", wait: true });
		expect(shared.sandboxes.has(hers.id)).toBe(true);
		expect((await ann.getSandbox(hers.id)).hostId).toBeUndefined();
		expect((await ann.listSandboxes()).items[0]?.hostName).toBeUndefined();

		// The super-admin may name a shared host, and is shown it.
		const rootOwn = await root.createSandbox({ type: "microvm", host: "shared", wait: true });
		expect(shared.sandboxes.has(rootOwn.id)).toBe(true);
		expect(await root.getSandbox(rootOwn.id)).toMatchObject({ hostId: shared.hostId, hostName: "shared" });

		// From a snapshot, only the host holding it may be named: another is refused before anything is made.
		const source = await tom.createSandbox({ type: "microvm", host: "tom-one", wait: true });
		const saved = await tom.saveSnapshot({ name: "on-one", sandboxId: source.id });
		const before = (await tom.listSandboxes({ all: true })).items.length;
		const elsewhere = await failure(tom.createSandbox({ type: "microvm", from: saved.id, host: "tom-two" }));
		expect(elsewhere).toMatchObject({ code: "unavailable", reason: "host_unavailable" });
		expect(elsewhere.message).toContain("tom-one");
		expect((await tom.listSandboxes({ all: true })).items).toHaveLength(before);
		const there = await tom.createSandbox({ type: "microvm", from: saved.id, host: "tom-one", wait: true });
		expect(first.sandboxes.has(there.id)).toBe(true);

		// The shapes a sandbox pinned to a host may be come from that host; one Tom may not name is not_found.
		expect((await tom.getSandboxShapes({ host: "tom-one" })).microvm).toBeDefined();
		expect((await failure(tom.getSandboxShapes({ host: shared.hostId }))).code).toBe("not_found");
		expect((await root.getSandboxShapes({ host: "shared" })).microvm).toBeDefined();

		// A named host that can't take it now is refused as that host, not placed elsewhere.
		await tom.updateAccountHost(first.hostId, { draining: true });
		const refused = await failure(tom.createSandbox({ type: "microvm", host: "tom-one" }));
		expect(refused).toMatchObject({ code: "unavailable", reason: "host_unavailable" });
		expect(refused.message).toContain("tom-one");

		// Two hosts of one name: the name is ambiguous, the ID isn't.
		await tom.updateAccountHost(second.hostId, { name: "tom-one" });
		expect((await failure(tom.createSandbox({ type: "microvm", host: "tom-one" }))).code).toBe("invalid");
		const byId = await tom.createSandbox({ type: "microvm", host: second.hostId, wait: true });
		expect(second.sandboxes.has(byId.id)).toBe(true);
	});

	it("never places a sandbox with another owner on an account's host, whatever hosts the caller names", async () => {
		const { service, tom, join } = setup();
		const own = await join((await tom.createAccountJoinToken({})).token);
		await expect(
			service.sandboxes.create({ sandboxId: "sbx_other", tier: "microvm", owner: "acc_other", hostIds: [own.hostId] }),
		).rejects.toThrow();
		expect(own.sandboxes.has("sbx_other")).toBe(false);
	});
});
