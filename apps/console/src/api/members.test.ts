// The members seam against the real thing: the identity and passkey routes over an in-memory directory, with people
// signed in through the email one-time PIN routes. An organisation admin lists the members and resets one person's
// passkeys; anyone else gets no page, and the route refuses them anyway.

import { type CallContext, isHarbourError, type RelyingParty } from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { createIdentityClient, createIdentityHandler } from "@harbour/identity/http";
import { createMemoryIdentity } from "@harbour/identity/memory";
import { createEmailOtp, createMemoryOtpStores, harbourSessionProvider, MemoryOtpMailer } from "@harbour/identity/otp";
import { createOtpHandler } from "@harbour/identity/otp/http";
import { createMemoryPasskeyStores, createPasskeys } from "@harbour/identity/passkey";
import { createPasskeyClient, createPasskeyHandler, isPasskeyPath } from "@harbour/identity/passkey/http";
import { createSoftwareAuthenticator } from "@harbour/identity/passkey/testing";
import { createMembersFlow } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import { apiMembers } from "./members.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "test" }, organisationId: "bootstrap" };
const ORIGIN = "https://harbour.test";
const RP: RelyingParty = { id: "harbour.test", name: "Harbour", origin: ORIGIN };

async function world() {
	const identity = createMemoryIdentity();
	const ada = await identity.createUser(bootstrap, { name: "Ada", email: "ada@harbour.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Harbour",
		admin: { kind: "user", userId: ada.id },
	});
	const asAda: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: organisation.id };
	const website = await identity.createProject(asAda, { name: "Website" });
	const lin = await identity.createUser(asAda, { name: "Lin", email: "lin@harbour.test" });
	await identity.grantRole(asAda, { principal: { kind: "user", userId: lin.id }, role: "operator" });
	const asLin: CallContext = { actor: { kind: "human", userId: lin.id }, organisationId: organisation.id };

	const passkeys = createPasskeys({ ...createMemoryPasskeyStores(), identity });
	// Lin has a passkey on her laptop.
	const laptop = createSoftwareAuthenticator({ origin: ORIGIN });
	await passkeys.register(asLin, await laptop.create(await passkeys.registrationOptions(asLin, RP)), "Laptop");

	const stores = createMemoryOtpStores();
	const mailer = new MemoryOtpMailer();
	const sending: Promise<unknown>[] = [];
	const otp = createOtpHandler({
		otp: createEmailOtp({ identity, ...stores, mailer, defer: (work) => sending.push(work) }),
	});
	const authenticator = createAuthenticator({ identity, providers: [harbourSessionProvider(stores)] });
	const routes = createIdentityHandler({ identity, authenticator });
	const passkeyRoutes = createPasskeyHandler({ passkeys, authenticator });
	const serve: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		if (path.startsWith("/auth/")) return otp(request);
		return isPasskeyPath(path) ? passkeyRoutes(request) : routes(request);
	};
	const signIn = async (email: string) => {
		const anonymous = createIdentityClient({ baseUrl: ORIGIN, fetch: serve });
		await anonymous.startOtp(email);
		await Promise.all(sending);
		const { token } = await anonymous.verifyOtp(email, mailer.lastCodeFor(email) ?? "");
		const headers = () => ({ authorization: `Bearer ${token}` });
		const client = createIdentityClient({ baseUrl: ORIGIN, fetch: serve, headers });
		const passkeyClient = createPasskeyClient({ baseUrl: ORIGIN, fetch: serve, headers });
		return { client, passkeyClient, me: await client.me() };
	};
	return { passkeys, signIn, asLin, ada, lin, website };
}

describe("the members page on the API", () => {
	it("lets an organisation admin reset a member's passkeys, so they can enrol again on a sign-in", async () => {
		const { passkeys, signIn, asLin, ada, lin } = await world();
		const admin = await signIn("ada@harbour.test");
		const members = apiMembers(admin.client, admin.passkeyClient, admin.me);
		expect(members?.viewer).toBe(ada.id);

		const flow = createMembersFlow({ api: members!.api });
		await flow.load();
		expect(flow.getState().members).toEqual([
			{ userId: ada.id, name: "Ada" },
			{ userId: lin.id, name: "Lin" },
		]);
		expect(await passkeys.list(asLin)).toHaveLength(1);

		flow.askReset(lin.id);
		await flow.reset();
		expect(flow.getState().done).toEqual({ userId: lin.id, removed: 1 });
		expect(await passkeys.list(asLin)).toEqual([]);
	});

	it("lets an organisation admin invite someone, who joins with the role when they sign in, and revoke an invite", async () => {
		const { signIn } = await world();
		const admin = await signIn("ada@harbour.test");
		const flow = createMembersFlow({ api: apiMembers(admin.client, admin.passkeyClient, admin.me)!.api });
		await flow.load();
		expect(flow.getState().invites).toEqual([]);

		flow.openInvite();
		await flow.invite({ email: "grace@harbour.test", role: "viewer" });
		const sent = flow.getState().inviting?.sent;
		expect(sent).toMatchObject({ invite: { email: "grace@harbour.test", role: "viewer" }, emailed: false });
		expect(sent?.link).toBe(`${ORIGIN}/`);
		flow.closeInvite();
		flow.openInvite();
		await flow.invite({ email: "linus@harbour.test", role: "operator" });
		flow.closeInvite();
		expect(flow.getState().invites?.map((invite) => invite.email)).toEqual([
			"grace@harbour.test",
			"linus@harbour.test",
		]);

		flow.openInvite();
		await flow.invite({ email: "Grace@harbour.test", role: "admin" });
		expect(flow.getState().inviting?.problem).toEqual({ kind: "conflict" });
		flow.closeInvite();

		const grace = await signIn("grace@harbour.test");
		expect(grace.me.roles).toEqual([{ role: "viewer" }]);
		const linus = flow.getState().invites?.find((invite) => invite.email === "linus@harbour.test");
		await flow.revokeInvite(linus!.id);
		await flow.load();
		expect(flow.getState().invites).toEqual([]);
		expect(flow.getState().members?.map((member) => member.name)).toEqual(["Ada", "grace", "Lin"]);
		await expect(signIn("linus@harbour.test")).rejects.toThrow();
	});

	it("gives anyone but an organisation admin no page, and the route refuses them", async () => {
		const { signIn, ada } = await world();
		const operator = await signIn("lin@harbour.test");
		expect(apiMembers(operator.client, operator.passkeyClient, operator.me)).toBeUndefined();
		const refused = await operator.passkeyClient.reset(ada.id).catch((error: unknown) => error);
		expect(isHarbourError(refused, "forbidden")).toBe(true);
		const invite = operator.client.createInvite({ email: "x@harbour.test", role: "admin" });
		expect(isHarbourError(await invite.catch((error: unknown) => error), "forbidden")).toBe(true);
	});
});
