import { type CallContext, INVITES_PATH, inviteRevokePath, isKantelError } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityClient, createIdentityHandler, type IdentityClient } from "@kantel/identity/http";
import { type InviteMailer, MemoryInviteMailer } from "@kantel/identity/invites";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createEmailOtp, createMemoryOtpStores, kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const ORIGIN = "http://harbour.test";

const mailed = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Kantel: Ada administers it and Linus operates it. Sign-in is by email one-time PIN, served in-process; `invites`
 * configures the handler's invite mail.
 */
async function world(invites: { mailer?: InviteMailer; link?: (request: Request) => string } = {}) {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const identity = createMemoryIdentity({ clock, audit });
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: "ada@harbour.test" });
	const harbour = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: harbour.id };
	const linus = await identity.createUser(admin, { name: "Linus Torvalds", email: "linus@harbour.test" });
	await identity.grantRole(admin, { principal: { kind: "user", userId: linus.id }, role: "operator" });

	const stores = createMemoryOtpStores();
	const codes = new MemoryOtpMailer();
	const otp = createEmailOtp({ identity, ...stores, mailer: codes, clock });
	const authenticator = createAuthenticator({ identity, providers: [kantelSessionProvider({ ...stores, clock })] });
	const otpHandler = createOtpHandler({ otp });
	const identityHandler = createIdentityHandler({ identity, authenticator, invites });
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/auth/") ? otpHandler(request) : identityHandler(request);
	};
	const clientWith = (headers: Record<string, string> = {}): IdentityClient =>
		createIdentityClient({ baseUrl: ORIGIN, fetch: serve, headers: () => headers });
	const signIn = async (email: string) => {
		const anonymous = clientWith();
		await anonymous.startOtp(email);
		await mailed();
		const code = codes.lastCodeFor(email);
		if (code === undefined) throw new Error(`no code was sent to ${email}`);
		const session = await anonymous.verifyOtp(email, code);
		return { token: session.token, client: clientWith({ authorization: `Bearer ${session.token}` }) };
	};
	return { identity, audit, harbour, ada, linus, serve, signIn, admin };
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
		const { signIn, harbour, ada } = await world();
		const { client } = await signIn("ada@harbour.test");
		const created = await client.createInvite({ email: " grace@harbour.test ", role: "viewer" });
		expect(created).toMatchObject({
			invite: {
				organisationId: harbour.id,
				email: "grace@harbour.test",
				role: "viewer",
				invitedBy: { kind: "human", userId: ada.id },
			},
			link: `${ORIGIN}/`,
			emailed: false,
		});
		expect(await client.listInvites()).toEqual([created.invite]);
	});

	it("emails the invite when the deployment has mail, linking where it says", async () => {
		const mailer = new MemoryInviteMailer();
		const { signIn } = await world({ mailer, link: () => "https://harbour.example.com/" });
		const { client } = await signIn("ada@harbour.test");
		const created = await client.createInvite({ email: "grace@harbour.test", role: "operator" });
		expect(created.emailed).toBe(true);
		expect(created.link).toBe("https://harbour.example.com/");
		expect(mailer.sent).toEqual([
			{
				to: "grace@harbour.test",
				organisation: "Kantel",
				invitedBy: "Ada Lovelace",
				link: "https://harbour.example.com/",
				expiresAt: created.invite.expiresAt,
			},
		]);
	});

	it("keeps the invite when the email fails, for the admin to send the link", async () => {
		const failing: InviteMailer = { sendInvite: async () => Promise.reject(new Error("relay down")) };
		const { signIn } = await world({ mailer: failing });
		const { client } = await signIn("ada@harbour.test");
		const created = await client.createInvite({ email: "grace@harbour.test", role: "viewer" });
		expect(created.emailed).toBe(false);
		expect(await client.listInvites()).toEqual([created.invite]);
	});

	it("refuses anyone but an organisation admin", async () => {
		const { signIn } = await world();
		const { client } = await signIn("linus@harbour.test");
		const invite = refusal(client.createInvite({ email: "grace@harbour.test", role: "viewer" }));
		expect(await invite).toSatisfy((error) => isKantelError(error, "forbidden"));
		expect(await refusal(client.listInvites())).toSatisfy((error) => isKantelError(error, "forbidden"));
	});

	it("is a conflict for a pending invite or a member, and refuses a malformed body", async () => {
		const { signIn, serve, token } = await signInAda();
		const { client } = await signIn("ada@harbour.test");
		await client.createInvite({ email: "grace@harbour.test", role: "viewer" });
		const again = refusal(client.createInvite({ email: "GRACE@harbour.test", role: "admin" }));
		expect(await again).toSatisfy((error) => isKantelError(error, "conflict"));
		const member = refusal(client.createInvite({ email: "linus@harbour.test", role: "viewer" }));
		expect(await member).toSatisfy((error) => isKantelError(error, "conflict"));

		const post = (body: string, type = "application/json") =>
			serve(`${ORIGIN}${INVITES_PATH}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": type },
				body,
			});
		expect((await post(JSON.stringify({ email: "x@harbour.test", role: "viewer" }), "text/plain")).status).toBe(415);
		expect((await post(JSON.stringify({ email: "nobody", role: "viewer" }))).status).toBe(400);
		expect((await post(JSON.stringify({ email: "x@harbour.test", role: "owner" }))).status).toBe(400);
		expect((await post(JSON.stringify({ email: "x@harbour.test", role: "viewer", extra: 1 }))).status).toBe(400);
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
	const { token } = await found.signIn("ada@harbour.test");
	return { ...found, token };
}

describe("POST /v1/invites/:id/revoke", () => {
	it("revokes a pending invite once, for an admin only", async () => {
		const { signIn, serve, token } = await signInAda();
		const { client } = await signIn("ada@harbour.test");
		const { invite } = await client.createInvite({ email: "grace@harbour.test", role: "viewer" });

		const linus = await signIn("linus@harbour.test");
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
	it("lets the invited person sign in by email one-time PIN, and makes them a member with the role", async () => {
		const { signIn, harbour } = await world();
		const ada = await signIn("ada@harbour.test");
		const { invite } = await ada.client.createInvite({ email: "Grace@Harbour.test", role: "operator" });

		const grace = await signIn("grace@harbour.test");
		const me = await grace.client.me();
		expect(me).toMatchObject({
			name: "grace",
			// As they signed in with it, not as the admin typed it.
			email: "grace@harbour.test",
			organisationId: harbour.id,
			roles: [{ role: "operator" }],
		});
		expect((await ada.client.members()).map((member) => member.name)).toContain("grace");
		expect(await ada.client.listInvites()).toEqual([]);
		expect(await refusal(ada.client.revokeInvite(invite.id))).toSatisfy((error) => isKantelError(error, "not_found"));
	});

	it("lets nobody in once the invite is revoked", async () => {
		const { signIn } = await world();
		const ada = await signIn("ada@harbour.test");
		const { invite } = await ada.client.createInvite({ email: "grace@harbour.test", role: "operator" });
		await ada.client.revokeInvite(invite.id);
		await expect(signIn("grace@harbour.test")).rejects.toThrow();
	});
});
