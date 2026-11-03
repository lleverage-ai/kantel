import { type CallContext, INVITES_PATH, inviteRevokePath, isKantelError } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityClient, createIdentityHandler, type IdentityClient } from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { githubProvider } from "@kantel/identity/oauth";
import { createMemorySessionStore, createSessions, kantelSessionProvider } from "@kantel/identity/sessions";
import { createSignInHandler } from "@kantel/identity/sign-in/http";
import { createFakeGitHub, signInWithGitHub } from "@kantel/identity/testing/github";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const ORIGIN = "http://kantel.test";

/**
 * Kantel: Ada administers it and Linus operates it. Sign-in is by GitHub (a fake), served in-process; every email
 * signed in with is a GitHub account whose verified email it is. `invites` configures the handler's invite links.
 */
async function world(invites: { link?: (request: Request) => string } = {}) {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const identity = createMemoryIdentity({ clock, audit });
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: "ada@kantel.test" });
	const kantel = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: kantel.id };
	const linus = await identity.createUser(admin, { name: "Linus Torvalds", email: "linus@kantel.test" });
	await identity.grantRole(admin, { principal: { kind: "user", userId: linus.id }, role: "operator" });

	const store = createMemorySessionStore();
	const github = createFakeGitHub();
	const authenticator = createAuthenticator({
		identity,
		providers: [kantelSessionProvider({ sessions: store, clock })],
	});
	const signInHandler = createSignInHandler({
		identity,
		sessions: createSessions({ identity, sessions: store, clock }),
		providers: [githubProvider(github)],
		clock,
	});
	const identityHandler = createIdentityHandler({ identity, authenticator, invites });
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/api/auth/") ? signInHandler(request) : identityHandler(request);
	};
	const clientWith = (headers: Record<string, string> = {}): IdentityClient =>
		createIdentityClient({ baseUrl: ORIGIN, fetch: serve, headers: () => headers });
	const ids = new Map<string, number>();
	const signIn = async (email: string) => {
		const login = email.split("@")[0] ?? "";
		if (!ids.has(login)) ids.set(login, ids.size + 1);
		github.account({ id: ids.get(login) ?? 0, login, emails: [{ email, verified: true, primary: true }] });
		const signedIn = await signInWithGitHub(serve, github, login);
		if (!signedIn.ok) throw new Error(`${email} could not sign in: ${signedIn.error}`);
		return { token: signedIn.token, client: clientWith({ authorization: `Bearer ${signedIn.token}` }) };
	};
	return { identity, audit, kantel, ada, linus, serve, signIn, admin };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be refused");
}

describe("POST /v1/invites", () => {
	it("invites by email with a role, answers the copyable link, and lists it as pending", async () => {
		const { signIn, kantel, ada } = await world();
		const { client } = await signIn("ada@kantel.test");
		const created = await client.createInvite({ email: " grace@kantel.test ", role: "viewer" });
		expect(created).toMatchObject({
			invite: {
				organisationId: kantel.id,
				email: "grace@kantel.test",
				role: "viewer",
				invitedBy: { kind: "human", userId: ada.id },
			},
			link: `${ORIGIN}/`,
		});
		expect(await client.listInvites()).toEqual([created.invite]);
	});

	it("links where the deployment says", async () => {
		const { signIn } = await world({ link: () => "https://kantel.example.com/" });
		const { client } = await signIn("ada@kantel.test");
		const created = await client.createInvite({ email: "grace@kantel.test", role: "operator" });
		expect(created.link).toBe("https://kantel.example.com/");
	});

	it("refuses anyone but an organisation admin", async () => {
		const { signIn } = await world();
		const { client } = await signIn("linus@kantel.test");
		const invite = refusal(client.createInvite({ email: "grace@kantel.test", role: "viewer" }));
		expect(await invite).toSatisfy((error) => isKantelError(error, "forbidden"));
		expect(await refusal(client.listInvites())).toSatisfy((error) => isKantelError(error, "forbidden"));
	});

	it("is a conflict for a pending invite or a member, and refuses a malformed body", async () => {
		const { signIn, serve, token } = await signInAda();
		const { client } = await signIn("ada@kantel.test");
		await client.createInvite({ email: "grace@kantel.test", role: "viewer" });
		const again = refusal(client.createInvite({ email: "GRACE@kantel.test", role: "admin" }));
		expect(await again).toSatisfy((error) => isKantelError(error, "conflict"));
		const member = refusal(client.createInvite({ email: "linus@kantel.test", role: "viewer" }));
		expect(await member).toSatisfy((error) => isKantelError(error, "conflict"));

		const post = (body: string, type = "application/json") =>
			serve(`${ORIGIN}${INVITES_PATH}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": type },
				body,
			});
		expect((await post(JSON.stringify({ email: "x@kantel.test", role: "viewer" }), "text/plain")).status).toBe(415);
		expect((await post(JSON.stringify({ email: "nobody", role: "viewer" }))).status).toBe(400);
		expect((await post(JSON.stringify({ email: "x@kantel.test", role: "owner" }))).status).toBe(400);
		expect((await post(JSON.stringify({ email: "x@kantel.test", role: "viewer", extra: 1 }))).status).toBe(400);
		expect((await post("[]")).status).toBe(400);
		expect((await serve(`${ORIGIN}${INVITES_PATH}`, { method: "POST" })).status).toBe(401);
		const deleted = await serve(`${ORIGIN}${INVITES_PATH}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(deleted.status).toBe(405);
	});
});

/** A world with Ada signed in, and her bearer token. */
async function signInAda() {
	const found = await world();
	const { token } = await found.signIn("ada@kantel.test");
	return { ...found, token };
}

describe("POST /v1/invites/:id/revoke", () => {
	it("revokes a pending invite once, for an admin only", async () => {
		const { signIn, serve, token } = await signInAda();
		const { client } = await signIn("ada@kantel.test");
		const { invite } = await client.createInvite({ email: "grace@kantel.test", role: "viewer" });

		const linus = await signIn("linus@kantel.test");
		expect(await refusal(linus.client.revokeInvite(invite.id))).toSatisfy((error) => isKantelError(error, "forbidden"));

		const withBody = await serve(`${ORIGIN}${inviteRevokePath(invite.id)}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ reason: "x" }),
		});
		expect(withBody.status).toBe(400);

		await client.revokeInvite(invite.id);
		expect(await client.listInvites()).toEqual([]);
		expect(await refusal(client.revokeInvite(invite.id))).toSatisfy((error) => isKantelError(error, "not_found"));
	});
});

describe("accepting an invite", () => {
	it("lets the invited person sign in with GitHub, and makes them a member with the role", async () => {
		const { signIn, kantel } = await world();
		const ada = await signIn("ada@kantel.test");
		const { invite } = await ada.client.createInvite({ email: "Grace@Kantel.test", role: "operator" });

		const grace = await signIn("grace@kantel.test");
		const me = await grace.client.me();
		expect(me).toMatchObject({
			name: "grace",
			// As they signed in with it, not as the admin typed it.
			email: "grace@kantel.test",
			organisationId: kantel.id,
			roles: [{ role: "operator" }],
		});
		expect((await ada.client.members()).map((member) => member.name)).toContain("grace");
		expect(await ada.client.listInvites()).toEqual([]);
		expect(await refusal(ada.client.revokeInvite(invite.id))).toSatisfy((error) => isKantelError(error, "not_found"));
	});

	it("lets nobody in once the invite is revoked", async () => {
		const { signIn } = await world();
		const ada = await signIn("ada@kantel.test");
		const { invite } = await ada.client.createInvite({ email: "grace@kantel.test", role: "operator" });
		await ada.client.revokeInvite(invite.id);
		await expect(signIn("grace@kantel.test")).rejects.toThrow();
	});
});
