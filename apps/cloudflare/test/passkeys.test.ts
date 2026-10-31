// Passkeys on the Cloudflare deployment (#132), in Node: a person signed in with Access registers a passkey through the
// stack's gateway, then the approval API asks for it before an approval reaches the VaultDO. The passkeys are real
// (a software authenticator signing with WebCrypto), the identity and audit stores are SQL as D1 runs them
// (`node:sqlite`), and each vault call crosses to the VaultDO's portable core the way RPC carries it.
import { DatabaseSync } from "node:sqlite";
import {
	type ApprovalView,
	type AuditEvent,
	type CallContext,
	type Decision,
	type MeResponse,
	PASSKEY_CONFIRMATION_PATH,
	PASSKEY_REGISTRATION_PATH,
	PASSKEYS_PATH,
	type Passkey,
	type PasskeyChallenge,
	type PasskeyRegistrationOptions,
	type PasskeysResponse,
	passkeyRemovePath,
	passkeyResetPath,
	type SessionRecord,
} from "@harbour/contracts";
import { PASSKEY_BODY_LIMIT } from "@harbour/identity/passkey/http";
import { createSoftwareAuthenticator } from "@harbour/identity/passkey/testing";
import { createMockAccess } from "@harbour/identity/testing";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { seedDevVault } from "../src/dev-vault-seed.ts";
import { createGateway } from "../src/gateway.ts";
import { routeRequest, STACK_NAME } from "../src/route.ts";
import { createStack, DEFAULT_AGENT_ID } from "../src/stack.ts";
import { answerApprovalCall, approvalVaultOver, createVaultCore } from "../src/vault.ts";
import { objectStorage } from "./object-storage.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

async function setup() {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		HARBOUR_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		HARBOUR_ACCESS_AUD: AUD,
		HARBOUR_ADMIN_EMAIL: ADMIN,
	});
	let core: ReturnType<typeof createVaultCore> | undefined;
	const vault = approvalVaultOver(async (method, ctx, args) =>
		structuredClone(await answerApprovalCall(() => core!.vault, method, structuredClone(ctx), structuredClone(args))),
	);
	const sql = syncSqliteDriver(new DatabaseSync(":memory:"));
	const stack = await createStack({ config, accessFetch: mock.fetch, vault, storage: { sql } });
	core = createVaultCore({
		...objectStorage(new DatabaseSync(":memory:")),
		audit: stack.audit,
		vars: { HARBOUR_VAULT_KEY: KEY },
	});
	const gateway = createGateway(stack);

	const session = (title: string) =>
		stack.runtime.runtime.create(stack.admin, { projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, title });
	const agentIn = (record: SessionRecord): CallContext => ({
		actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
		organisationId: stack.organisation.id,
		projectId: stack.project.id,
	});
	const release = agentIn(await session("Ship the 0.4 release"));
	const seeded = await seedDevVault(core.vault, {
		admin: stack.admin,
		agents: {
			release,
			linear: agentIn(await session("Keep the triage queue moving")),
			billing: agentIn(await session("Check the month's payouts")),
		},
	});

	const call = async <T>(path: string, body?: unknown) => {
		const headers: Record<string, string> = {
			"cf-access-jwt-assertion": await mock.sign({ sub: `access-${ADMIN}`, email: ADMIN }),
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		const response = await gateway.fetch(
			new Request(`${BASE}${path}`, {
				headers,
				...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
	};
	const device = createSoftwareAuthenticator({ origin: BASE });
	const register = async () => {
		const options = await call<PasskeyRegistrationOptions>(PASSKEY_REGISTRATION_PATH, {});
		expect(options.status).toBe(200);
		const registered = await call<Passkey>(PASSKEYS_PATH, {
			response: await device.create(options.body),
			name: "Laptop",
		});
		expect(registered.status).toBe(201);
		return registered.body;
	};
	const auditOf = async (type: string): Promise<AuditEvent[]> =>
		(await stack.audit.query(stack.admin, { type }, { limit: 500 })).items as AuditEvent[];
	return { stack, core, release, call, device, register, seeded, auditOf };
}

describe("passkeys on Cloudflare", () => {
	it("registers a passkey on the gateway's host, in D1 with identity, audited", async () => {
		const { call, register, auditOf } = await setup();
		const before = await call<PasskeysResponse>(PASSKEYS_PATH);
		expect(before.body).toEqual({ items: [], approvals: "registered" });
		const options = await call<PasskeyRegistrationOptions>(PASSKEY_REGISTRATION_PATH, {});
		expect(options.body.rp).toEqual({ id: "harbour.test", name: "Harbour" });
		const passkey = await register();
		expect(passkey).toMatchObject({ name: "Laptop", rpId: "harbour.test" });
		expect((await call<PasskeysResponse>(PASSKEYS_PATH)).body.items).toEqual([passkey]);
		expect(await auditOf("identity.passkey.registered")).toHaveLength(1);
	});

	it("approves on the sign-in and the code alone until the person registers a passkey", async () => {
		const { call, seeded } = await setup();
		expect((await call("/v1/vault/viewer")).body).toMatchObject({ passkeyRequired: false });
		const id = seeded.proposals.route;
		const view = await call<ApprovalView>(`/v1/vault/proposals/${id}/approval`);
		const decided = await call<Decision>(`/v1/vault/proposals/${id}/decision`, {
			outcome: "approve",
			termsHash: view.body.proposal.termsHash,
			pickedCode: view.body.proposal.bindingCode,
		});
		expect(decided.status).toBe(200);
	});

	it("then needs it: approves with an assertion bound to the terms and narrowing, once", async () => {
		const { call, register, device, seeded, auditOf } = await setup();
		await register();
		expect((await call("/v1/vault/viewer")).body).toMatchObject({ passkeyRequired: true });
		const id = seeded.proposals.route;
		const view = await call<ApprovalView>(`/v1/vault/proposals/${id}/approval`);
		const { termsHash, bindingCode } = view.body.proposal;
		const narrowing = { methods: ["GET" as const], ttlMs: 30 * 60_000 };
		const challenge = await call<PasskeyChallenge>(`/v1/vault/proposals/${id}/passkey-challenge`, {
			termsHash,
			narrowing,
		});
		expect(challenge.status).toBe(200);
		expect(challenge.body.rpId).toBe("harbour.test");
		const assertion = await device.get(challenge.body);
		const decision = { outcome: "approve", termsHash, pickedCode: bindingCode, narrowing };

		// Without it: refused, audited, and the request stays pending.
		const missing = await call<{ error: { code: string; passkey: string } }>(
			`/v1/vault/proposals/${id}/decision`,
			decision,
		);
		expect(missing.status).toBe(403);
		expect(missing.body.error).toMatchObject({ code: "refused", passkey: "missing" });

		// For a wider narrowing than the one it signed: refused, and its challenge spent.
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
		expect(refusals[0]).toMatchObject({ source: "vault", subject: { kind: "vault.proposal", id } });

		// A fresh challenge, signed: approved with the narrowed terms.
		const fresh = await call<PasskeyChallenge>(`/v1/vault/proposals/${id}/passkey-challenge`, {
			termsHash,
			narrowing,
		});
		const approved = await call<Decision>(`/v1/vault/proposals/${id}/decision`, {
			...decision,
			passkeyAssertion: await device.get(fresh.body),
		});
		expect(approved.status).toBe(200);
		expect(approved.body.effectiveTerms?.route?.methods).toEqual(["GET"]);
	});

	it("needs a passkey to add or remove one, and lets the admin reset them, audited", async () => {
		const { call, register, device, auditOf } = await setup();
		const first = await register();
		const another = async () =>
			device.create((await call<PasskeyRegistrationOptions>(PASSKEY_REGISTRATION_PATH, {})).body);

		const unconfirmed = await call<{ error: { passkey: string } }>(PASSKEYS_PATH, { response: await another() });
		expect(unconfirmed.status).toBe(422);
		expect(unconfirmed.body.error.passkey).toBe("missing");
		const forAdding = await call<PasskeyChallenge>(PASSKEY_CONFIRMATION_PATH, { change: "register" });
		expect(forAdding.body.rpId).toBe("harbour.test");
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
		expect((await call("/v1/vault/viewer")).body).toMatchObject({ passkeyRequired: false });
		expect(await auditOf("identity.passkey.reset")).toMatchObject([
			{ actor: me.actor, subject: { kind: "identity.user", id: me.actor.userId }, data: { removed: 2 } },
		]);
		await register();
	});

	it("binds a paste to its secret request: the action is the proposal's, not the caller's", async () => {
		const { call, register, device, core, release } = await setup();
		await register();
		const injection = { header: "Authorization", template: "Bearer {key}" };
		const { id } = await core.vault.propose(release, {
			secret: { name: "linear-key", hosts: ["api.linear.app"], injection },
			route: { host: "api.linear.app", methods: ["POST"], pathPrefix: "/graphql" },
			lifetime: {},
			reason: "Paste the Linear key",
		});
		const view = await call<ApprovalView>(`/v1/vault/proposals/${id}/approval`);
		const challenge = await call<PasskeyChallenge>(`/v1/vault/proposals/${id}/passkey-challenge`, {
			termsHash: view.body.proposal.termsHash,
		});
		const decided = await call<Decision>(`/v1/vault/proposals/${id}/decision`, {
			outcome: "approve",
			termsHash: view.body.proposal.termsHash,
			pickedCode: view.body.proposal.bindingCode,
			secretValue: "pasted-test-value",
			passkeyAssertion: await device.get(challenge.body),
		});
		expect(decided.status).toBe(200);
	});

	it("reads a passkey POST's body in the Worker before the stack, up to its limit", async () => {
		const seen: string[] = [];
		const stack = {
			idFromName: (name: string) => name,
			get: (name: string) => ({
				fetch: async (request: Request) => {
					seen.push(`${name} ${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
					return new Response(null, { status: 204 });
				},
			}),
		};
		const unused = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null) }) };
		const env = { STACK: stack, VAULTS: unused, ASSETS: { fetch: async () => new Response(null) } };
		const post = (path: string, body: string) =>
			routeRequest(new Request(`${BASE}${path}`, { method: "POST", body }), env);
		expect((await post(PASSKEY_REGISTRATION_PATH, "{}")).status).toBe(204);
		expect(seen).toEqual([`${STACK_NAME} POST ${PASSKEY_REGISTRATION_PATH} {}`]);
		expect((await post(PASSKEYS_PATH, "x".repeat(PASSKEY_BODY_LIMIT + 1))).status).toBe(413);
		expect(seen).toHaveLength(1);
	});
});
