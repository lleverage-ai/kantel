// Passkeys on the self-hosted gateway (#132), as on Cloudflare (apps/cloudflare/test/passkeys.test.ts): a person signed
// in by email registers a passkey at /v1/me/passkeys, then the approval API asks for it before an approval reaches the
// vault, and audits a missing or bad one. The passkeys are real (a software authenticator signing with WebCrypto).
import {
	type ApprovalView,
	type AuditEvent,
	type CallContext,
	type Decision,
	type MeResponse,
	ORGANISATION_HEADER,
	PASSKEY_CONFIRMATION_PATH,
	PASSKEY_REGISTRATION_PATH,
	PASSKEYS_PATH,
	type Passkey,
	type PasskeyChallenge,
	type PasskeyRegistrationOptions,
	type PasskeysResponse,
	passkeyRemovePath,
	passkeyResetPath,
} from "@kantel/contracts";
import { MemoryOtpMailer } from "@kantel/identity/otp";
import { createSoftwareAuthenticator } from "@kantel/identity/passkey/testing";
import { afterEach, describe, expect, test } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";

const ADMIN_EMAIL = "admin@harbour.localhost";
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/**
 * A gateway on the in-memory components, its admin signed in by email, and a secret request from an agent waiting for
 * them. Requests go to `requestOrigin`, the way the HTTP adapter builds their URLs; `publicOrigin` is KANTEL_PUBLIC_URL.
 */
async function setup(options: { readonly requestOrigin: string; readonly publicOrigin?: string }) {
	const components = createGatewayComponents();
	const seeded = await bootstrap(components, { organisation: "Test", project: "test", adminEmail: ADMIN_EMAIL });
	const mailer = new MemoryOtpMailer();
	const gateway = createGateway({
		components,
		mailer,
		...(options.publicOrigin === undefined ? {} : { publicOrigin: options.publicOrigin }),
	});
	closers.push(
		() => components.close(),
		() => gateway.close(),
	);

	const send = (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
		gateway.fetch(
			new Request(`${options.requestOrigin}${path}`, {
				headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
				...(init.body === undefined ? {} : { method: "POST", body: JSON.stringify(init.body) }),
			}),
		);
	expect((await send("/auth/otp/start", { body: { email: ADMIN_EMAIL } })).status).toBe(202);
	// The code is mailed after the answer, so a stranger's start takes as long as an invited person's.
	let code = mailer.lastCodeFor(ADMIN_EMAIL);
	for (let tries = 0; code === undefined && tries < 200; tries += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		code = mailer.lastCodeFor(ADMIN_EMAIL);
	}
	const verified = await send("/auth/otp/verify", { body: { email: ADMIN_EMAIL, code } });
	expect(verified.status).toBe(200);
	const { token } = (await verified.json()) as { token: string };
	const asAdmin = { authorization: `Bearer ${token}`, [ORGANISATION_HEADER]: seeded.organisationId };

	const call = async <T>(path: string, body?: unknown) => {
		const response = await send(path, { headers: asAdmin, ...(body === undefined ? {} : { body }) });
		const text = await response.text();
		return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
	};

	const key = await components.identity.authenticateApiKey(
		{ actor: { kind: "system", component: "test" }, organisationId: seeded.organisationId },
		seeded.apiKey,
	);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const session = await components.runtime.runtime.create(operator, { projectId: seeded.projectId, agentId: "echo" });
	const agent: CallContext = {
		actor: { kind: "agent", agentId: session.agentId, sessionId: session.id },
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const vault = components.vault;
	if (vault === undefined) throw new Error("the in-memory components have no vault");
	const propose = async () =>
		(
			await vault.propose(agent, {
				secret: {
					name: `linear-key-${crypto.randomUUID()}`,
					hosts: ["api.linear.app"],
					injection: { header: "Authorization", template: "Bearer {key}" },
				},
				route: { host: "api.linear.app", methods: ["GET", "POST"], pathPrefix: "/graphql" },
				lifetime: {},
				reason: "Paste the Linear key",
			})
		).id;

	const device = createSoftwareAuthenticator({ origin: options.publicOrigin ?? options.requestOrigin });
	const register = async () => {
		const registration = await call<PasskeyRegistrationOptions>(PASSKEY_REGISTRATION_PATH, {});
		expect(registration.status).toBe(200);
		const registered = await call<Passkey>(PASSKEYS_PATH, {
			response: await device.create(registration.body),
			name: "Laptop",
		});
		expect(registered.status).toBe(201);
		return registered.body;
	};
	const auditOf = async (type: string) =>
		(await call<{ items: AuditEvent[] }>(`/v1/audit/events?type=${encodeURIComponent(type)}`)).body.items;
	return { call, device, register, propose, auditOf };
}

describe("passkeys on the self-hosted gateway", () => {
	test("registers a passkey for the request's origin, audited", async () => {
		const { call, register, auditOf } = await setup({ requestOrigin: "http://localhost:58090" });
		expect((await call<PasskeysResponse>(PASSKEYS_PATH)).body).toEqual({ items: [], approvals: "registered" });
		const options = await call<PasskeyRegistrationOptions>(PASSKEY_REGISTRATION_PATH, {});
		expect(options.body.rp).toEqual({ id: "localhost", name: "Kantel" });
		const passkey = await register();
		expect(passkey).toMatchObject({ name: "Laptop", rpId: "localhost" });
		expect((await call<PasskeysResponse>(PASSKEYS_PATH)).body.items).toEqual([passkey]);
		expect(await auditOf("identity.passkey.registered")).toHaveLength(1);
	});

	test("approves on the sign-in and the code alone until the person registers a passkey", async () => {
		// On the approval API's routes (#324); the other tests here call its deprecated /v1/vault aliases.
		const { call, propose } = await setup({ requestOrigin: "http://localhost:58090" });
		expect((await call("/v1/connection-approvals/viewer")).body).toMatchObject({ passkeyRequired: false });
		const id = await propose();
		const view = await call<ApprovalView>(`/v1/connection-approvals/requests/${id}/approval`);
		const decided = await call<Decision>(`/v1/connection-approvals/requests/${id}/decision`, {
			outcome: "approve",
			termsHash: view.body.proposal.termsHash,
			pickedCode: view.body.proposal.bindingCode,
			secretValue: "pasted-test-value",
		});
		expect(decided.status).toBe(200);
	});

	test("then needs it behind a TLS proxy: refuses and audits a missing or spent assertion, approves a fresh one", async () => {
		// The HTTP adapter builds every request URL as `http:`; the passkey is the public origin's.
		const { call, register, device, propose, auditOf } = await setup({
			requestOrigin: "http://127.0.0.1:8080",
			publicOrigin: "https://harbour.example.com",
		});
		const passkey = await register();
		expect(passkey.rpId).toBe("harbour.example.com");
		expect((await call("/v1/vault/viewer")).body).toMatchObject({ passkeyRequired: true });

		const id = await propose();
		const view = await call<ApprovalView>(`/v1/vault/proposals/${id}/approval`);
		const { termsHash, bindingCode } = view.body.proposal;
		const narrowing = { methods: ["GET" as const] };
		const decision = { outcome: "approve", termsHash, pickedCode: bindingCode, narrowing, secretValue: "pasted" };
		const challenge = await call<PasskeyChallenge>(`/v1/vault/proposals/${id}/passkey-challenge`, {
			termsHash,
			narrowing,
		});
		expect(challenge.status).toBe(200);
		expect(challenge.body.rpId).toBe("harbour.example.com");
		const assertion = await device.get(challenge.body);

		const missing = await call<{ error: { code: string; passkey: string } }>(
			`/v1/vault/proposals/${id}/decision`,
			decision,
		);
		expect(missing.status).toBe(403);
		expect(missing.body.error).toMatchObject({ code: "refused", passkey: "missing" });
		const wider = await call<{ error: { passkey: string } }>(`/v1/vault/proposals/${id}/decision`, {
			...decision,
			narrowing: { methods: ["GET", "POST"] },
			passkeyAssertion: assertion,
		});
		expect(wider.body.error.passkey).toBe("binding");
		const replayed = await call<{ error: { passkey: string } }>(`/v1/vault/proposals/${id}/decision`, {
			...decision,
			passkeyAssertion: assertion,
		});
		expect(replayed.body.error.passkey).toBe("challenge");
		const refusals = await auditOf("connections.passkey.refused");
		expect(refusals.map((event) => event.data?.reason).sort()).toEqual(["binding", "challenge", "missing"]);
		// The old type still finds the rows on Postgres, for one release (#324).
		expect(await auditOf("vault.passkey.refused")).toEqual(refusals);
		expect(refusals[0]).toMatchObject({ source: "vault", subject: { kind: "vault.proposal", id } });

		const fresh = await call<PasskeyChallenge>(`/v1/vault/proposals/${id}/passkey-challenge`, { termsHash, narrowing });
		const approved = await call<Decision>(`/v1/vault/proposals/${id}/decision`, {
			...decision,
			passkeyAssertion: await device.get(fresh.body),
		});
		expect(approved.status).toBe(200);
	});

	test("needs a passkey to add or remove one, and lets the admin reset them, audited", async () => {
		const { call, register, device, auditOf } = await setup({ requestOrigin: "http://localhost:58090" });
		const first = await register();
		const another = async () =>
			device.create((await call<PasskeyRegistrationOptions>(PASSKEY_REGISTRATION_PATH, {})).body);

		const unconfirmed = await call<{ error: { passkey: string } }>(PASSKEYS_PATH, { response: await another() });
		expect(unconfirmed.status).toBe(422);
		expect(unconfirmed.body.error.passkey).toBe("missing");
		const forAdding = await call<PasskeyChallenge>(PASSKEY_CONFIRMATION_PATH, { change: "register" });
		const added = await call<Passkey>(PASSKEYS_PATH, {
			response: await another(),
			confirmation: await device.get(forAdding.body),
		});
		expect(added.status).toBe(201);
		expect((await call(passkeyRemovePath(first.id), {})).status).toBe(422);
		expect(await auditOf("identity.passkey.refused")).toHaveLength(2);

		// Lost them all: the admin (here, themselves) resets them, and a sign-in enrols a new one.
		const me = (await call<MeResponse>("/v1/me")).body;
		if (me.actor.kind !== "human") throw new Error("not signed in as a person");
		const reset = await call<{ removed: number }>(passkeyResetPath(me.actor.userId), {});
		expect(reset).toEqual({ status: 200, body: { removed: 2 } });
		expect((await call<PasskeysResponse>(PASSKEYS_PATH)).body.items).toEqual([]);
		expect(await auditOf("identity.passkey.reset")).toMatchObject([
			{ actor: me.actor, subject: { kind: "identity.user", id: me.actor.userId }, data: { removed: 2 } },
		]);
		await register();
	});
});
