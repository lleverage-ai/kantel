// Personal access tokens (`kpt_…`): a person's own credential, acting in every account they belong to with their role
// there, capped by its scopes and the accounts it names, and refused by an organisation that blocks them.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createMemoryStore } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup() {
	let clock = Date.now();
	const store = createMemoryStore();
	const api = createComputeApi({
		backend: createStubBackend(),
		store,
		now: () => clock,
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string | undefined) =>
		createKantelClient({
			baseUrl: BASE_URL,
			...(token === undefined ? {} : { token }),
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return {
		store,
		client,
		tom: client("tom-token"),
		ann: client("ann-token"),
		root: client("root-token"),
		advance: (ms: number) => {
			clock += ms;
		},
	};
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

const DAY_MS = 24 * 3_600_000;

describe("personal access tokens", () => {
	it("act as their person in every account they belong to, which a key can't", async () => {
		const { client, tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const issued = await tom.createPersonalToken({ name: "laptop" });
		expect(issued.secret).toMatch(/^kpt_/);
		expect(issued.token).toMatchObject({ name: "laptop", prefix: issued.secret.slice(0, 8) });
		expect(issued.token.expiresAt - issued.token.createdAt).toBe(90 * DAY_MS);
		expect(issued.token.scopes).toBeUndefined();

		const pat = client(issued.secret);
		const caller = await pat.getCaller();
		expect(caller.user?.id).toBe("usr_tom");
		expect(caller.personalToken).toMatchObject({ id: issued.token.id, name: "laptop" });
		expect(caller.accounts.map((account) => account.id)).toContain(org.id);

		// One token, both accounts: the personal one by default, the organisation when named.
		const mine = await pat.createSandbox({ wait: true });
		const theirs = await pat.createSandbox({ account: org.id, wait: true });
		expect(mine.accountId).toBe(caller.accountId);
		expect(theirs.accountId).toBe(org.id);
		expect(theirs.createdBy).toMatchObject({ kind: "user", id: "usr_tom" });
		expect((await pat.listSandboxes({ account: org.id, mine: true })).items.map((item) => item.id)).toEqual([
			theirs.id,
		]);

		// A key can't reach the organisation from the personal account.
		const key = await tom.createApiKey({ name: "k", preset: "admin" });
		expect((await failure(client(key.secret).listSandboxes({ account: org.id }))).code).toBe("forbidden");

		// Someone else's account stays out of reach.
		expect((await failure(pat.listSandboxes({ account: (await ann.getCaller()).accountId }))).code).toBe("forbidden");
	});

	it("follow their person's role, and lose an organisation when they leave it", async () => {
		const { client, tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		const pat = client((await ann.createPersonalToken({ name: "ann" })).secret);
		await pat.createSandbox({ account: org.id, wait: true });
		// A member can't manage the organisation's keys, with a token or without.
		expect((await failure(pat.createApiKey({ account: org.id, name: "x", preset: "agent" }))).code).toBe("forbidden");
		await tom.removeMember(org.id, "usr_ann");
		expect((await failure(pat.listSandboxes({ account: org.id }))).code).toBe("forbidden");
		expect((await pat.listAccounts()).items.map((account) => account.id)).not.toContain(org.id);
	});

	it("hold to their scopes and accounts", async () => {
		const { client, tom } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const reader = client((await tom.createPersonalToken({ name: "reader", preset: "read-only" })).secret);
		await reader.listSandboxes({ account: org.id });
		expect((await failure(reader.createSandbox({}))).message).toContain("lacks the sandboxes:write scope");

		const orgOnly = await tom.createPersonalToken({ name: "acme", accounts: [org.id] });
		const scoped = client(orgOnly.secret);
		// Its one account is where it acts by default.
		const caller = await scoped.getCaller();
		expect(caller.accountId).toBe(org.id);
		expect(caller.accounts.map((account) => account.id)).toEqual([org.id]);
		expect((await scoped.createSandbox({ wait: true })).accountId).toBe(org.id);
		const personal = (await tom.getCaller()).accountId;
		expect((await failure(scoped.listSandboxes({ account: personal }))).message).toContain("personal account");
		// Nor may it reach past them: no new organisation, and no token for more than it has.
		expect((await failure(scoped.createOrganisation({ name: "Other" }))).code).toBe("forbidden");
		expect((await failure(scoped.createPersonalToken({ name: "wider", accounts: [personal] }))).code).toBe("forbidden");
		expect((await failure(reader.createPersonalToken({ name: "wider" }))).code).toBe("forbidden");
		const narrower = await reader.createPersonalToken({ name: "narrower", scopes: ["sandboxes:read"] });
		expect(narrower.token.scopes).toEqual(["sandboxes:read"]);
		// Nor for longer than it lasts.
		expect(narrower.token.expiresAt).toBeLessThanOrEqual(orgOnly.token.expiresAt);

		expect((await failure(tom.createPersonalToken({ name: "x", accounts: ["acc_nope"] }))).code).toBe("forbidden");
		expect((await failure(tom.createPersonalToken({ name: "x", scopes: ["hosts:admin"] }))).code).toBe("invalid");
		expect((await failure(tom.createPersonalToken({ name: "x", expiresInDays: 400 }))).code).toBe("invalid");
	});

	it("never act as a super-admin, approve a device's sign-in or delete their person's account", async () => {
		const { client, root, tom } = setup();
		const pat = client((await root.createPersonalToken({ name: "root" })).secret);
		expect((await pat.getCaller()).superAdmin).toBe(false);
		expect((await failure(pat.listHosts())).code).toBe("forbidden");

		const device = client(undefined);
		const started = await device.startDeviceLogin({ personal: true });
		const tomPat = client((await tom.createPersonalToken({ name: "t" })).secret);
		expect((await failure(tomPat.approveDeviceLogin(started.userCode, {}))).message).toContain("console");
		expect((await failure(tomPat.deleteCaller())).message).toContain("console");
	});

	it("are refused by an organisation that blocks them, which only an admin may set", async () => {
		const { client, tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		const pat = client((await tom.createPersonalToken({ name: "t" })).secret);
		expect((await tom.getAccount(org.id)).personalTokens).toBe("allowed");
		expect((await failure(ann.updateAccount(org.id, { personalTokens: "blocked" }))).code).toBe("forbidden");
		await tom.updateAccount(org.id, { personalTokens: "blocked" });
		const refused = await failure(pat.listSandboxes({ account: org.id }));
		expect(refused.code).toBe("forbidden");
		expect(refused.message).toContain("doesn't allow personal access tokens");
		expect((await pat.listAccounts()).items.map((account) => account.id)).not.toContain(org.id);
		// Their own personal account is still theirs.
		await pat.listSandboxes({});
		const personal = (await tom.getCaller()).accountId;
		expect((await failure(tom.updateAccount(personal, { personalTokens: "blocked" }))).code).toBe("invalid");
		await tom.updateAccount(org.id, { personalTokens: "allowed" });
		await pat.listSandboxes({ account: org.id });
	});

	it("are listed and revoked by their person, a token revoking itself", async () => {
		const { client, tom, ann, advance } = setup();
		const first = await tom.createPersonalToken({ name: "one" });
		advance(1000);
		const second = await tom.createPersonalToken({ name: "two" });
		expect((await tom.listPersonalTokens()).items.map((token) => token.name)).toEqual(["two", "one"]);
		expect((await ann.listPersonalTokens()).items).toEqual([]);
		expect((await failure(ann.revokePersonalToken(first.token.id))).code).toBe("not_found");
		const key = await tom.createApiKey({ name: "k", preset: "admin" });
		expect((await failure(client(key.secret).listPersonalTokens())).code).toBe("forbidden");

		const self = client(second.secret);
		expect((await self.revokePersonalToken(second.token.id)).revokedAt).toBeTypeOf("number");
		expect((await failure(self.getCaller())).status).toBe(401);
		await client(first.secret).getCaller();
		await tom.revokePersonalToken(first.token.id);
		expect((await failure(client(first.secret).getCaller())).status).toBe(401);
	});

	it("stop working when they expire", async () => {
		const { client, tom, advance } = setup();
		const issued = await tom.createPersonalToken({ name: "short", expiresInDays: 1 });
		const pat = client(issued.secret);
		await pat.getCaller();
		advance(DAY_MS);
		expect((await failure(pat.getCaller())).status).toBe(401);
	});

	it("record when they were last used", async () => {
		const { client, tom } = setup();
		const issued = await tom.createPersonalToken({ name: "used" });
		await client(issued.secret).getCaller();
		await new Promise((done) => setTimeout(done, 10));
		const [listed] = (await tom.listPersonalTokens()).items;
		expect(listed?.lastUsedAt).toBeTypeOf("number");
	});

	it("are revoked with their person's account", async () => {
		const { client, ann } = setup();
		const pat = client((await ann.createPersonalToken({ name: "ann" })).secret);
		await pat.getCaller();
		await ann.deleteCaller();
		expect((await failure(pat.getCaller())).status).toBe(401);
	});
});

describe("personal access tokens, what they can't reach around", () => {
	it("never get an answer kept for their person's other credentials under the same idempotency key", async () => {
		const { client, tom } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const key = "same-key";
		const broad = await tom.createPersonalToken({ name: "automation" }, { idempotencyKey: key });
		const narrow = client((await tom.createPersonalToken({ name: "narrow", accounts: [org.id] })).secret);
		const again = await narrow.createPersonalToken({ name: "automation" }, { idempotencyKey: key });
		expect(again.secret).not.toBe(broad.secret);
		expect(again.token.accounts).toEqual([org.id]);
		// Its own retry gets its own answer.
		expect((await narrow.createPersonalToken({ name: "automation" }, { idempotencyKey: key })).secret).toBe(
			again.secret,
		);
	});

	it("leave an organisation only with account:admin when they hold scopes", async () => {
		const { client, tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "member" })).code ?? "" });
		const reader = client((await ann.createPersonalToken({ name: "r", preset: "read-only" })).secret);
		expect((await failure(reader.removeMember(org.id, "usr_ann"))).code).toBe("forbidden");
		// A token with no scopes leaves as its person may.
		const full = client((await ann.createPersonalToken({ name: "f" })).secret);
		await full.removeMember(org.id, "usr_ann");
		expect((await ann.listAccounts()).items.map((account) => account.id)).not.toContain(org.id);
	});

	it("don't join an organisation that blocks them", async () => {
		const { client, tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		await tom.updateAccount(org.id, { personalTokens: "blocked" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		const pat = client((await ann.createPersonalToken({ name: "a" })).secret);
		expect((await failure(pat.joinOrganisation({ code: invite.code ?? "" }))).message).toContain(
			"doesn't allow personal access tokens",
		);
		// The invite is still there for the console.
		await ann.joinOrganisation({ code: invite.code ?? "" });
	});
});

describe("device sign-in for a personal token", () => {
	it("keeps the secret for the next poll while the approved token isn't there to read", async () => {
		const { client, store, tom } = setup();
		const device = client(undefined);
		const started = await device.startDeviceLogin({ personal: true });
		await tom.approveDeviceLogin(started.userCode, {});
		const [token] = await store.personalTokens.list({ userId: "usr_tom" });
		if (token === undefined) throw new Error("no token was stored");
		// As if the poll ran between the approval and the token's write.
		await store.personalTokens.delete(token.id);
		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "pending" });
		await store.personalTokens.put(token);
		const approved = await device.pollDeviceLogin({ deviceCode: started.deviceCode });
		expect(approved.token?.token.id).toBe(token.id);
	});

	it("gives the device a personal token any member may approve, limited as the approver says", async () => {
		const { client, tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		const device = client(undefined);
		const started = await device.startDeviceLogin({ clientName: "kantel on laptop", personal: true });
		expect(await ann.getDeviceLogin(started.userCode)).toMatchObject({ personal: true, state: "pending" });
		// A member, not an admin, approves it: the token acts with their role.
		await ann.approveDeviceLogin(started.userCode, { accounts: [org.id] });
		const approved = await device.pollDeviceLogin({ deviceCode: started.deviceCode });
		expect(approved.state).toBe("approved");
		expect(approved.issued).toBeUndefined();
		expect(approved.token?.secret).toMatch(/^kpt_/);
		expect(approved.token?.token).toMatchObject({ name: "kantel on laptop", accounts: [org.id] });
		const caller = await client(approved.token?.secret).getCaller();
		expect(caller).toMatchObject({ accountId: org.id, user: { id: "usr_ann" } });
		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "expired" });
	});

	it("still gives a device from before personal tokens an API key", async () => {
		const { client, tom } = setup();
		const device = client(undefined);
		const started = await device.startDeviceLogin({});
		await tom.approveDeviceLogin(started.userCode, {});
		const approved = await device.pollDeviceLogin({ deviceCode: started.deviceCode });
		expect(approved.issued?.secret).toMatch(/^ksk_/);
		expect(approved.token).toBeUndefined();
	});
});
