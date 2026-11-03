import { type CallContext, externalSubjectOf, GITHUB_ISSUER } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { signedInPerson } from "@kantel/identity/principal";
import {
	createMemorySessionStore,
	createSessions,
	DEFAULT_SESSION_TTL_MILLISECONDS,
	hashSessionToken,
	isSessionToken,
	kantelSessionProvider,
} from "@kantel/identity/sessions";
import { ManualClock, RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };
const github = (subject: string, email = "ada@example.test") =>
	({ issuer: GITHUB_ISSUER, subject, email, emailVerified: true, name: "Ada" }) as const;

async function harness() {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const identity = createMemoryIdentity({ clock, audit });
	const founder = await identity.createUser(bootstrap, {
		name: "Founder",
		email: "founder@example.test",
		externalSubject: externalSubjectOf(GITHUB_ISSUER, "1"),
	});
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Org",
		admin: { kind: "user", userId: founder.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
	const ada = await identity.createUser(admin, {
		name: "Ada",
		email: "ada@example.test",
		externalSubject: externalSubjectOf(GITHUB_ISSUER, "2"),
	});
	await identity.grantRole(admin, { principal: { kind: "user", userId: ada.id }, role: "viewer" });
	const store = createMemorySessionStore();
	const sessions = createSessions({ identity, sessions: store, clock, audit });
	const authenticator = createAuthenticator({
		identity,
		providers: [kantelSessionProvider({ sessions: store, clock })],
	});
	const bearer = (token: string) =>
		new Request("https://kantel.test/v1/me", { headers: { authorization: `Bearer ${token}` } });
	return { clock, audit, identity, founder, ada, organisation, store, sessions, authenticator, bearer };
}

describe("Kantel sessions", () => {
	it("start a kts_ session the authenticator accepts, and stop accepting it once ended", async () => {
		const { identity, sessions, authenticator, bearer, ada, organisation, audit } = await harness();
		const external = github("2");
		const started = await sessions.start(external, await identity.signIn(bootstrap, external));
		expect(isSessionToken(started.token)).toBe(true);
		expect(started.token.startsWith("kts_")).toBe(true);
		const caller = await authenticator.authenticate(bearer(started.token));
		expect(caller).toMatchObject({ method: "harbour_session", actor: { kind: "human", userId: ada.id } });
		expect(caller.organisationId).toBe(organisation.id);
		expect(audit.events.map((event) => event.type)).toContain("identity.session.started");

		await sessions.end(started.token);
		await expect(authenticator.authenticate(bearer(started.token))).rejects.toThrow();
		expect(audit.events.map((event) => event.type)).toContain("identity.session.ended");
	});

	it("expire after the session lifetime", async () => {
		const { identity, sessions, authenticator, bearer, clock } = await harness();
		const external = github("2");
		const started = await sessions.start(external, await identity.signIn(bootstrap, external));
		clock.advance(DEFAULT_SESSION_TTL_MILLISECONDS + 1);
		await expect(authenticator.authenticate(bearer(started.token))).rejects.toThrow();
	});

	it("keep only the token's hash", async () => {
		const { identity, sessions, store, clock } = await harness();
		const external = github("2");
		const started = await sessions.start(external, await identity.signIn(bootstrap, external));
		const found = await store.find(await hashSessionToken(started.token), clock.now());
		expect(found?.tokenHash).not.toBe(started.token);
		expect(JSON.stringify(found)).not.toContain(started.token);
	});
});

describe("signedInPerson", () => {
	it("is the person, their name and email, and whether they administer the organisation", async () => {
		const { identity, sessions, authenticator, bearer, founder, ada } = await harness();
		const asAda = await sessions.start(github("2"), await identity.signIn(bootstrap, github("2")));
		const asFounder = await sessions.start(
			github("1", "founder@example.test"),
			await identity.signIn(bootstrap, github("1", "founder@example.test")),
		);
		const adaPerson = await signedInPerson(authenticator, identity, bearer(asAda.token));
		expect(adaPerson).toMatchObject({
			userId: ada.id,
			name: "Ada",
			email: "ada@example.test",
			method: "harbour_session",
			admin: false,
			session: await hashSessionToken(asAda.token),
		});
		expect(await signedInPerson(authenticator, identity, bearer(asFounder.token))).toMatchObject({
			userId: founder.id,
			admin: true,
		});
	});

	it("is undefined without a sign-in or with one that doesn't verify", async () => {
		const { identity, authenticator, bearer } = await harness();
		expect(await signedInPerson(authenticator, identity, new Request("https://kantel.test/"))).toBeUndefined();
		expect(await signedInPerson(authenticator, identity, bearer("kts_nope"))).toBeUndefined();
	});
});
