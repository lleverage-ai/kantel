import { createAuditClient, createAuditQueryHandler } from "@kantel/audit/http";
import { createMemoryAuditStore } from "@kantel/audit/memory";
import {
	AUDIT_EVENT_PATH,
	AUDIT_EVENTS_PATH,
	type AuditEventInput,
	type AuditQuery,
	auditQueryFromSearchParams,
	auditQueryToSearchParams,
	type CallContext,
	createProjectAccess,
	isKantelError,
	KantelError,
	systemContext,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createMemoryIdentity } from "@kantel/identity/memory";
import { ManualClock } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

describe("audit query search parameters", () => {
	const queries: AuditQuery[] = [
		{},
		{ projectId: "p", sessionId: "s", agentId: "a" },
		{ actor: { kind: "human", userId: "u:1" } },
		{ actor: { kind: "service", serviceId: "svc" } },
		{ actor: { kind: "service", serviceId: "svc", keyId: "key" } },
		{ actor: { kind: "agent", agentId: "ag", sessionId: "s" } },
		{ actor: { kind: "system", component: "vault" } },
		{ source: "vault", type: "vault.", subject: { kind: "vault.proposal", id: "x&y=z" } },
		{ from: 0, to: 1_800_000_000_000, newestFirst: true },
		{ itemId: "item/linear key", grantId: "grant&1", type: "vault.use." },
		{ types: ["vault.policy.", "capability.grant."] },
		{ types: ["session.created"], type: "session." },
	];
	it("round-trips every query field and the page", () => {
		for (const query of queries) {
			const params = new URLSearchParams(auditQueryToSearchParams(query, { limit: 50, cursor: "12" }).toString());
			expect(auditQueryFromSearchParams(params)).toEqual({ query, page: { limit: 50, cursor: "12" } });
		}
		expect(auditQueryFromSearchParams(new URLSearchParams(""))).toEqual({ query: {}, page: {} });
	});

	it("rejects unknown, repeated, half or malformed parameters as invalid", () => {
		for (const search of [
			"bogus=1",
			"projectId=a&projectId=b",
			"projectId=",
			"actorKind=human",
			"actorId=u",
			"actorKind=robot&actorId=x",
			"actorKind=agent&actorId=x",
			"actorKind=human&actorId=u&actorKeyId=k",
			"actorKind=human&actorId=u&actorSessionId=s",
			"actorKeyId=k",
			"subjectKind=k",
			"itemId=",
			"types=",
			"types=vault.,,session.",
			"types=vault.&types=session.",
			"grantId=a&grantId=b",
			"from=yesterday",
			"to=1.5",
			"limit=0",
			"order=sideways",
		]) {
			let error: unknown;
			try {
				auditQueryFromSearchParams(new URLSearchParams(search));
			} catch (caught) {
				error = caught;
			}
			expect(isKantelError(error, "invalid"), search).toBe(true);
		}
	});
});

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };

async function setup() {
	const clock = new ManualClock();
	const identity = createMemoryIdentity({ clock });
	const founder = await identity.createUser(bootstrap, { name: "Founder" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Org",
		admin: { kind: "user", userId: founder.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
	const alpha = await identity.createProject(admin, { name: "alpha" });
	const beta = await identity.createProject(admin, { name: "beta" });
	const service = await identity.createServiceIdentity(admin, { name: "host" });
	const alphaKey = await identity.issueApiKey(admin, { serviceId: service.id, projectIds: [alpha.id], role: "viewer" });
	const access = createProjectAccess({
		identity,
		sessions: {
			async get() {
				throw new KantelError("not_found", "no sessions here");
			},
		},
	});
	const store = createMemoryAuditStore({ clock, access });
	const event = (id: string, projectId: string, at: number): AuditEventInput => ({
		id,
		at,
		source: "vault",
		type: "vault.use.injected",
		actor: { kind: "system", component: "vault" },
		organisationId: organisation.id,
		projectId,
		// Odd uses are the Linear key's, through one grant; even ones another item's.
		data: at % 2 === 1 ? { itemId: "item-linear", grantId: "grant-1" } : { itemId: "item-github" },
	});
	const events = [
		...Array.from({ length: 5 }, (_, i) => event(`vault:use:alpha/${i}`, alpha.id, clock.now() + i)),
		...Array.from({ length: 3 }, (_, i) => event(`vault:use:beta/${i}`, beta.id, clock.now() + i)),
	];
	await store.append(systemContext("vault"), events);
	const handler = createAuditQueryHandler({ store, authenticator: createAuthenticator({ identity }) });
	const client = (secret?: string) =>
		createAuditClient({
			baseUrl: "https://kantel.test/",
			fetch: async (input, init) => handler(new Request(input, init)),
			...(secret === undefined ? {} : { headers: () => ({ authorization: `Bearer ${secret}` }) }),
		});
	return { alpha, beta, alphaKey, handler, client, store, event };
}

describe("the audit query API", () => {
	it("pages a project's rows for a key scoped to it, and refuses another project", async () => {
		const { alpha, beta, alphaKey, client } = await setup();
		const api = client(alphaKey.secret);
		const first = await api.query({ projectId: alpha.id }, { limit: 3 });
		expect(first.items.map((row) => row.id)).toEqual(["vault:use:alpha/0", "vault:use:alpha/1", "vault:use:alpha/2"]);
		expect(first.nextCursor).toBeDefined();
		const second = await api.query({ projectId: alpha.id }, { limit: 3, ...{ cursor: first.nextCursor } });
		expect(second.items.map((row) => row.id)).toEqual(["vault:use:alpha/3", "vault:use:alpha/4"]);
		expect(second.nextCursor).toBeUndefined();

		const unscoped = await api.query({ newestFirst: true });
		expect(unscoped.items.map((row) => row.projectId)).toEqual(Array(5).fill(alpha.id));

		await expect(api.query({ projectId: beta.id })).rejects.toMatchObject({ code: "forbidden" });
		await expect(api.get("vault:use:beta/0")).rejects.toMatchObject({ code: "forbidden" });
		expect((await api.get("vault:use:alpha/0")).id).toBe("vault:use:alpha/0");
		await expect(api.get("missing")).rejects.toMatchObject({ code: "not_found" });
	});

	it("filters by vault item and grant on the server", async () => {
		const { alpha, alphaKey, client } = await setup();
		const api = client(alphaKey.secret);
		const linear = await api.query({ itemId: "item-linear", newestFirst: true });
		const expected = (await api.query({ newestFirst: true })).items
			.filter((row) => row.data?.itemId === "item-linear")
			.map((row) => row.id);
		expect(expected.length).toBeGreaterThan(0);
		expect(linear.items.map((row) => row.id)).toEqual(expected);
		const grant = await api.query({ grantId: "grant-1", projectId: alpha.id }, { limit: 1 });
		expect(grant.items.map((row) => row.data?.grantId)).toEqual(["grant-1"]);
		expect(grant.nextCursor === undefined).toBe(expected.length === 1);
		expect((await api.query({ grantId: "grant-2" })).items).toEqual([]);
	});

	it("answers 401 without credentials, 400 for a bad query, 404 and 405 for bad routes", async () => {
		const { alphaKey, handler, client } = await setup();
		await expect(client().query()).rejects.toMatchObject({ code: "forbidden", details: { authentication: "invalid" } });
		const auth = { authorization: `Bearer ${alphaKey.secret}` };

		const missing = await handler(new Request(`https://kantel.test${AUDIT_EVENTS_PATH}`));
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toContain("Bearer");

		const bad = await handler(new Request(`https://kantel.test${AUDIT_EVENTS_PATH}?limit=x`, { headers: auth }));
		expect(bad.status).toBe(400);
		expect(await bad.json()).toMatchObject({ error: { code: "invalid" } });

		expect((await handler(new Request("https://kantel.test/v1/other", { headers: auth }))).status).toBe(404);
		const nested = await handler(new Request(`https://kantel.test${AUDIT_EVENTS_PATH}/a/b`, { headers: auth }));
		expect(nested.status).toBe(404);
		const post = await handler(
			new Request(`https://kantel.test${AUDIT_EVENTS_PATH}`, { method: "POST", headers: auth, body: "{}" }),
		);
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET");
	});

	it("reads events whose ids are dot segments or hold a slash, and refuses an empty id", async () => {
		const { alpha, alphaKey, client, store, event, handler } = await setup();
		await store.append(systemContext("vault"), [
			event(".", alpha.id, 1),
			event("..", alpha.id, 2),
			event("a/b?c", alpha.id, 3),
		]);
		const api = client(alphaKey.secret);
		for (const id of [".", "..", "a/b?c"]) expect((await api.get(id)).id).toBe(id);
		await expect(api.get("")).rejects.toMatchObject({ code: "invalid" });
		const auth = { authorization: `Bearer ${alphaKey.secret}` };
		for (const search of ["", "?id=", "?id=x&id=y", "?id=x&limit=1"]) {
			const response = await handler(
				new Request(`https://kantel.test${AUDIT_EVENT_PATH}${search}`, { headers: auth }),
			);
			expect(response.status, search).toBe(400);
		}
	});

	it("keeps every error code the server sends", async () => {
		for (const code of ["aborted", "expired", "refused", "exhausted", "conflict", "not_supported"] as const) {
			const handler = createAuditQueryHandler({
				store: {
					async query() {
						throw new KantelError(code, "nope");
					},
					async get() {
						throw new KantelError(code, "nope");
					},
				},
				authenticator: {
					async authenticate() {
						return { method: "api_key", actor: { kind: "service", serviceId: "s" }, organisationId: "o" };
					},
				},
			});
			const api = createAuditClient({
				baseUrl: "https://kantel.test",
				fetch: async (input, init) => handler(new Request(input, init)),
			});
			await expect(api.query(), code).rejects.toMatchObject({ code });
			await expect(api.get("x"), code).rejects.toMatchObject({ code });
		}
	});

	it("hides internal errors", async () => {
		const handler = createAuditQueryHandler({
			store: {
				async query() {
					throw new Error("connection string with password");
				},
				async get() {
					throw new Error("x");
				},
			},
			authenticator: {
				async authenticate() {
					return { method: "api_key", actor: { kind: "service", serviceId: "s" }, organisationId: "o" };
				},
			},
		});
		const response = await handler(new Request(`https://kantel.test${AUDIT_EVENTS_PATH}`));
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("password");
	});
});
