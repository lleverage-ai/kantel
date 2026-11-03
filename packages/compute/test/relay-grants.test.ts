// Who a relayed access was given to, and whether they still may use it: a key until it is revoked or expires, a
// person while their sign-in is live and they can see the sandbox, neither once the sandbox is gone. The grantee the
// API hands the backend names the caller, never their secret.
import { createKantelClient } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { decodeGrantee, encodeGrantee, type PersonIdentity } from "../src/auth.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup() {
	const live = new Set(["s-tom", "s-ann"]);
	const people: { readonly [token: string]: PersonIdentity } = {
		"tom-token": { userId: "usr_tom", name: "Tom", session: "s-tom" },
		"ann-token": { userId: "usr_ann", name: "Ann", session: "s-ann" },
	};
	let now = 1_800_000_000_000;
	const backend = createStubBackend();
	const granted: (string | undefined)[] = [];
	const openDesktop = backend.openDesktop.bind(backend);
	backend.openDesktop = (sandboxId, options) => {
		granted.push(options.grantee);
		return openDesktop(sandboxId, options);
	};
	const api = createComputeApi({
		backend,
		authenticatePerson: async (request) => people[request.headers.get("authorization")?.slice(7) ?? ""],
		sessionLive: async (session) => live.has(session),
		fetch: async () => new Response(null, { status: 204 }),
		now: () => now,
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: "http://compute.test/v1",
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return {
		api,
		live,
		granted,
		tom: client("tom-token"),
		ann: client("ann-token"),
		client,
		later: (ms: number) => {
			now += ms;
		},
	};
}

describe("relayed access grants", () => {
	it("name the caller to the backend: a person and their sign-in, or a key", async () => {
		const { tom, client, granted } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.openDesktop(sandbox.id, {});
		const key = await tom.createApiKey({ name: "agent", preset: "agent" });
		await client(key.secret).openDesktop(sandbox.id, {});
		expect(granted.map((text) => decodeGrantee(text ?? ""))).toEqual([
			{ kind: "person", userId: "usr_tom", session: "s-tom" },
			{ kind: "key", keyId: key.key.id },
		]);
		expect(granted.join("")).not.toContain(key.secret);
	});

	it("last for a key until it is revoked or expires", async () => {
		const { api, tom, later } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const revoked = await tom.createApiKey({ name: "a", preset: "agent" });
		const expiring = await tom.createApiKey({ name: "b", preset: "agent", expiresInDays: 1 });
		const asKey = (id: string) => JSON.stringify({ kind: "key", keyId: id });
		expect(await api.service.stillAllowed(asKey(revoked.key.id), sandbox.id)).toBe(true);
		await tom.revokeApiKey(revoked.key.id);
		expect(await api.service.stillAllowed(asKey(revoked.key.id), sandbox.id)).toBe(false);
		expect(await api.service.stillAllowed(asKey(expiring.key.id), sandbox.id)).toBe(true);
		later(25 * 3_600_000);
		expect(await api.service.stillAllowed(asKey(expiring.key.id), sandbox.id)).toBe(false);
		expect(await api.service.stillAllowed(asKey("key_never"), sandbox.id)).toBe(false);
	});

	it("last for a person while signed in and able to see the sandbox", async () => {
		const { api, tom, ann, live } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		const shared = await tom.createSandbox({ account: org.id, wait: true });
		const mine = await tom.createSandbox({ account: org.id, visibility: "private", wait: true });
		const annGrant = JSON.stringify({ kind: "person", userId: "usr_ann", session: "s-ann" });
		const tomGrant = JSON.stringify({ kind: "person", userId: "usr_tom", session: "s-tom" });
		expect(await api.service.stillAllowed(annGrant, shared.id)).toBe(true);
		// A private sandbox of Tom's was never Ann's to open.
		expect(await api.service.stillAllowed(annGrant, mine.id)).toBe(false);
		await tom.removeMember(org.id, "usr_ann");
		expect(await api.service.stillAllowed(annGrant, shared.id)).toBe(false);
		expect(await api.service.stillAllowed(tomGrant, shared.id)).toBe(true);
		live.delete("s-tom");
		expect(await api.service.stillAllowed(tomGrant, shared.id)).toBe(false);
	});

	it("end with the sandbox, and refuse anything that isn't a grantee", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const grant = JSON.stringify({ kind: "person", userId: "usr_tom", session: "s-tom" });
		expect(await api.service.stillAllowed(grant, sandbox.id)).toBe(true);
		for (const bad of ["", "{", "null", '{"kind":"key"}', '{"kind":"person","userId":1}', '{"kind":"admin"}']) {
			expect(await api.service.stillAllowed(bad, sandbox.id)).toBe(false);
		}
		await tom.stopSandbox(sandbox.id, { wait: true });
		await tom.deleteSandbox(sandbox.id);
		expect(await api.service.stillAllowed(grant, sandbox.id)).toBe(false);
		expect(await api.service.stillAllowed(undefined, sandbox.id)).toBe(true);
	});

	it("round-trip through encodeGrantee", () => {
		expect(
			decodeGrantee(
				encodeGrantee({ kind: "person", userId: "u", name: "U", superAdmin: false, personalAccountId: "a" }),
			),
		).toEqual({ kind: "person", userId: "u" });
	});
});
