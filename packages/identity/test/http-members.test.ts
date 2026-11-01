import { type CallContext, isKantelError, ORGANISATION_HEADER } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import {
	createIdentityClient,
	createIdentityHandler,
	type IdentityClient,
	MEMBERS_PATH,
	ORGANISATIONS_PATH,
} from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createEmailOtp, createMemoryOtpStores, kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { ManualClock } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const ORIGIN = "http://harbour.test";

const mailed = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Two organisations. Kantel: Ada administers it, Grace views Billing only, Linus operates Website only, and a host
 * app's key operates on Website. Lighthouse: Ada administers it too, alone. The identity and OTP routes are served
 * in-process.
 */
async function world() {
	const clock = new ManualClock();
	const identity = createMemoryIdentity({ clock });
	const ada = await identity.createUser(bootstrap, { name: "Ada Lovelace", email: "ada@harbour.test" });
	const harbour = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const lighthouse = await identity.createOrganisation(bootstrap, {
		name: "Lighthouse",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: harbour.id };
	const website = await identity.createProject(admin, { name: "Website" });
	const billing = await identity.createProject(admin, { name: "Billing" });
	const grace = await identity.createUser(admin, { name: "Grace Hopper", email: "grace@harbour.test" });
	await identity.grantRole(admin, {
		principal: { kind: "user", userId: grace.id },
		role: "viewer",
		projectId: billing.id,
	});
	const linus = await identity.createUser(admin, { name: "Linus Torvalds", email: "linus@harbour.test" });
	await identity.grantRole(admin, {
		principal: { kind: "user", userId: linus.id },
		role: "operator",
		projectId: website.id,
	});
	const service = await identity.createServiceIdentity(admin, { name: "Atlas" });
	const key = await identity.issueApiKey(admin, { serviceId: service.id, projectIds: [website.id], role: "operator" });

	const stores = createMemoryOtpStores();
	const mailer = new MemoryOtpMailer();
	const otp = createEmailOtp({ identity, ...stores, mailer, clock });
	const authenticator = createAuthenticator({ identity, providers: [kantelSessionProvider({ ...stores, clock })] });
	const otpHandler = createOtpHandler({ otp });
	const identityHandler = createIdentityHandler({ identity, authenticator });
	const serve = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/auth/") ? otpHandler(request) : identityHandler(request);
	};
	const clientWith = (headers: Record<string, string> = {}): IdentityClient =>
		createIdentityClient({ baseUrl: ORIGIN, fetch: serve, headers: () => headers });
	const signIn = async (email: string, headers: Record<string, string> = {}) => {
		const anonymous = clientWith();
		await anonymous.startOtp(email);
		await mailed();
		const code = mailer.lastCodeFor(email);
		if (code === undefined) throw new Error(`no code was sent to ${email}`);
		const session = await anonymous.verifyOtp(email, code);
		return { token: session.token, client: clientWith({ authorization: `Bearer ${session.token}`, ...headers }) };
	};
	return { identity, harbour, lighthouse, ada, grace, linus, key, serve, clientWith, signIn };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to be refused");
}

describe("GET /v1/organisations", () => {
	it("lists every organisation a person may act in without their naming one, by name", async () => {
		const { signIn, harbour, lighthouse } = await world();
		const { client } = await signIn("ada@harbour.test");
		// Ada is in two organisations: any other call needs her to name one.
		expect(await refusal(client.me())).toSatisfy((error) => isKantelError(error, "forbidden"));
		expect(await client.organisations()).toEqual({
			items: [
				{ id: harbour.id, name: "Kantel" },
				{ id: lighthouse.id, name: "Lighthouse" },
			],
		});
	});

	it("puts the organisation the call names first, as current", async () => {
		const { signIn, harbour, lighthouse } = await world();
		const { client } = await signIn("ada@harbour.test", { [ORGANISATION_HEADER]: lighthouse.id });
		expect(await client.organisations()).toEqual({
			items: [
				{ id: lighthouse.id, name: "Lighthouse" },
				{ id: harbour.id, name: "Kantel" },
			],
			current: lighthouse.id,
		});
	});

	it("refuses an organisation the person may not act in, as every call does", async () => {
		const { signIn } = await world();
		const { client } = await signIn("ada@harbour.test", { [ORGANISATION_HEADER]: "org_elsewhere" });
		const error = await refusal(client.organisations());
		expect(isKantelError(error, "forbidden")).toBe(true);
		expect((error as { details?: unknown }).details).toEqual({ authentication: "organisation" });
	});

	it("names a person's only organisation as current, and a key's own", async () => {
		const { signIn, clientWith, harbour, key } = await world();
		const { client } = await signIn("grace@harbour.test");
		expect(await client.organisations()).toEqual({ items: [{ id: harbour.id, name: "Kantel" }], current: harbour.id });
		const app = clientWith({ authorization: `Bearer ${key.secret}` });
		expect(await app.organisations()).toEqual({ items: [{ id: harbour.id, name: "Kantel" }], current: harbour.id });
	});

	it("is 401 without credentials, refuses parameters and takes GET only", async () => {
		const { serve, signIn } = await world();
		expect((await serve(`${ORIGIN}${ORGANISATIONS_PATH}`)).status).toBe(401);
		const { token } = await signIn("grace@harbour.test");
		const authorization = `Bearer ${token}`;
		expect((await serve(`${ORIGIN}${ORGANISATIONS_PATH}?limit=1`, { headers: { authorization } })).status).toBe(400);
		expect((await serve(`${ORIGIN}${ORGANISATIONS_PATH}`, { method: "POST", headers: { authorization } })).status).toBe(
			405,
		);
	});
});

describe("GET /v1/members", () => {
	it("names everyone bound in the organisation for a member of it, by name and never by email", async () => {
		const { signIn, ada, grace, linus, harbour } = await world();
		const { client } = await signIn("ada@harbour.test", { [ORGANISATION_HEADER]: harbour.id });
		const members = await client.members();
		expect(members).toEqual([
			{ userId: ada.id, name: "Ada Lovelace" },
			{ userId: grace.id, name: "Grace Hopper" },
			{ userId: linus.id, name: "Linus Torvalds" },
		]);
		expect(JSON.stringify(members)).not.toContain("@");
	});

	it("names only the people bound to their projects for someone with project roles only", async () => {
		const { signIn, grace } = await world();
		const { client } = await signIn("grace@harbour.test");
		// Grace views Billing: she sees who is bound to it, not Website's operator.
		expect(await client.members()).toEqual([{ userId: grace.id, name: "Grace Hopper" }]);
	});

	it("lists each organisation's own people", async () => {
		const { signIn, ada, lighthouse } = await world();
		const { client } = await signIn("ada@harbour.test", { [ORGANISATION_HEADER]: lighthouse.id });
		expect(await client.members()).toEqual([{ userId: ada.id, name: "Ada Lovelace" }]);
	});

	it("is 401 without credentials and refuses parameters", async () => {
		const { serve, signIn } = await world();
		expect((await serve(`${ORIGIN}${MEMBERS_PATH}`)).status).toBe(401);
		const { token } = await signIn("grace@harbour.test");
		expect(
			(await serve(`${ORIGIN}${MEMBERS_PATH}?q=a`, { headers: { authorization: `Bearer ${token}` } })).status,
		).toBe(400);
	});
});
