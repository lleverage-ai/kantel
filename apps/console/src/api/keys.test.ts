// The console's API keys seam against identity's real routes, in process: the key routes and `/v1/me`
// (`@kantel/identity/http`) over an in-memory directory, with people signed in by email code.
import type { CallContext } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createIdentityHandler } from "@kantel/identity/http";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { createEmailOtp, createMemoryOtpStores, kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { createApiKeysFlow } from "@kantel/ui";
import { describe, expect, it } from "vitest";
import { createConsoleIdentity, memoryTokens } from "./identity.ts";
import { apiKeys } from "./keys.ts";

const bootstrap: CallContext = { actor: { kind: "system", component: "test" }, organisationId: "bootstrap" };
const ORIGIN = "https://kantel.test";

async function world() {
	const identity = createMemoryIdentity();
	const ada = await identity.createUser(bootstrap, { name: "Ada", email: "ada@kantel.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Kantel",
		admin: { kind: "user", userId: ada.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: ada.id }, organisationId: organisation.id };
	const website = await identity.createProject(admin, { name: "Website" });
	for (const [email, role] of [
		["lin@kantel.test", "operator"],
		["grace@kantel.test", "viewer"],
	] as const) {
		const user = await identity.createUser(admin, { name: email, email });
		await identity.grantRole(admin, { principal: { kind: "user", userId: user.id }, role, projectId: website.id });
	}
	const stores = createMemoryOtpStores();
	const mailer = new MemoryOtpMailer();
	const sending: Promise<unknown>[] = [];
	const otpRoutes = createOtpHandler({
		otp: createEmailOtp({ identity, ...stores, mailer, defer: (work) => sending.push(work) }),
	});
	const routes = createIdentityHandler({
		identity,
		authenticator: createAuthenticator({ identity, providers: [kantelSessionProvider(stores)] }),
		signIn: ["email_otp"],
	});
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		return new URL(request.url).pathname.startsWith("/auth/") ? otpRoutes(request) : routes(request);
	};
	/** Boots the console as `email`: its identity and what `/v1/me` said. */
	const bootAs = async (email: string) => {
		const consoleIdentity = createConsoleIdentity({ baseUrl: ORIGIN, fetch, tokens: memoryTokens() });
		const signIn = await consoleIdentity.boot();
		if (signIn.kind !== "sign-in") throw new Error("expected to be asked to sign in");
		await signIn.api.start(email);
		await Promise.all(sending.splice(0));
		await signIn.api.verify(email, mailer.lastCodeFor(email) ?? "");
		const booted = await consoleIdentity.boot();
		if (booted.kind !== "signed-in") throw new Error("expected to be signed in");
		return { client: consoleIdentity.client, me: booted.me };
	};
	return { bootAs, website, fetch };
}

describe("the console's API keys seam", () => {
	it("is there for an admin, who issues and revokes a key through it", async () => {
		const { bootAs, website, fetch } = await world();
		const ada = await bootAs("ada@kantel.test");
		const keys = apiKeys(ada.client, ada.me);
		if (keys === undefined) throw new Error("expected the keys page for an admin");
		const flow = createApiKeysFlow({ api: keys.api, projects: () => [{ id: website.id, name: "Website" }] });
		flow.openCreate();
		flow.editDraft({ name: "Deploys" });
		await flow.create();
		const issued = flow.getState().issued;
		if (issued === undefined) throw new Error("expected a key");
		const asKey = () => fetch(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${issued.secret}` } });
		expect((await asKey()).status).toBe(200);
		flow.dismissSecret();
		flow.askRevoke(issued.key.id);
		await flow.revoke();
		expect((await asKey()).status).toBe(401);
	});

	it("is there for an operator, with their roles to say they administer nothing, and not for a viewer", async () => {
		const { bootAs, website } = await world();
		const lin = await bootAs("lin@kantel.test");
		expect(apiKeys(lin.client, lin.me)?.roles).toEqual([{ projectId: website.id, role: "operator" }]);
		expect(await apiKeys(lin.client, lin.me)?.api.list()).toEqual([]);
		const grace = await bootAs("grace@kantel.test");
		expect(apiKeys(grace.client, grace.me)).toBeUndefined();
	});
});
