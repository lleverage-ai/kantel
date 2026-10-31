import { createAuditQueryHandler } from "@harbour/audit/http";
import { createMemoryAuditStore } from "@harbour/audit/memory";
import {
	type AuditEvent,
	type AuthenticatedCaller,
	type Authenticator,
	HarbourError,
	isHarbourError,
	ORGANISATION_HEADER,
	systemContext,
} from "@harbour/contracts";
import { readAll, toQuery } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import {
	apiAudit,
	auditApiSource,
	readAuditPeople,
	readAuditScope,
	rememberRequests,
	sessionLink,
} from "./audit-http.ts";

const NOW = Date.UTC(2026, 9, 27, 12);

/** Tom, by a stand-in bearer token, in either organisation he belongs to. */
const authenticator: Authenticator = {
	async authenticate(request) {
		if (request.headers.get("authorization") !== "Bearer tom") throw new HarbourError("forbidden", "Who are you?");
		const organisationId = request.headers.get(ORGANISATION_HEADER) ?? "org_a";
		if (organisationId !== "org_a" && organisationId !== "org_b") throw new HarbourError("forbidden", "Not a member");
		const caller: AuthenticatedCaller = {
			actor: { kind: "human", userId: "usr_tom" },
			organisationId,
			method: "oidc",
		};
		return caller;
	},
};

async function served() {
	const store = createMemoryAuditStore({ clock: { now: () => NOW } });
	const event = (organisationId: string, index: number) => ({
		id: `e:${organisationId}:${index}`,
		at: NOW - (300 - index) * 1000,
		source: "vault" as const,
		type: index % 2 === 0 ? "vault.use.injected" : "session.created",
		actor: { kind: "system" as const, component: "vault" },
		organisationId,
		projectId: "prj_billing",
		// One use in ten is the Linear key's.
		...(index % 2 === 0 ? { data: { itemId: index % 10 === 0 ? "itm_linear" : "itm_github" } } : {}),
	});
	const created = (itemId: string, name: string, at: number) => ({
		id: `item:${itemId}`,
		at,
		source: "vault" as const,
		type: "vault.item.created",
		actor: { kind: "human" as const, userId: "usr_tom" },
		organisationId: "org_a",
		subject: { kind: "vault.item", id: itemId },
		data: { name, hosts: ["example.com"], hasValue: true },
	});
	await store.append(systemContext("test"), [
		created("itm_linear", "Linear API key", NOW - 400_000),
		created("itm_github", "GitHub token", NOW - 399_000),
	]);
	await store.append(
		systemContext("test"),
		Array.from({ length: 300 }, (_, index) => event("org_a", index)),
	);
	await store.append(
		systemContext("test"),
		Array.from({ length: 20 }, (_, index) => event("org_b", index)),
	);
	const handler = createAuditQueryHandler({ store, authenticator });
	const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;
	return { fetcher };
}

describe("the audit log over the audit query API", () => {
	it("pages the view's query through the API, newest first, in the organisation it names", async () => {
		const { fetcher } = await served();
		const source = auditApiSource({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom" }),
		});
		const all = [];
		for await (const page of readAll(source, toQuery({ range: "all", kind: "credential-use" }, NOW), { pageSize: 40 }))
			all.push(...page);
		expect(all).toHaveLength(150);

		// The credential filter is the server's: only the Linear key's uses come back, each page full.
		const linear = await source.query(
			toQuery({ range: "all", kind: "credential-use", credential: "itm_linear" }, NOW),
			{ limit: 20 },
		);
		expect(linear.items).toHaveLength(20);
		expect(linear.items.every((event) => event.data?.itemId === "itm_linear")).toBe(true);
		expect(linear.nextCursor).toBeDefined();
		expect(all.every((event) => event.organisationId === "org_a" && event.type === "vault.use.injected")).toBe(true);
		expect(all[0]!.seq).toBeGreaterThan(all[1]!.seq);

		const other = await source.query(toQuery({ range: "all", kind: "all", organisationId: "org_b" }, NOW));
		expect(other.items).toHaveLength(20);
		expect(other.items.every((event) => event.organisationId === "org_b")).toBe(true);
	});

	it("replaces an organisation header the credentials carry, whatever its case", async () => {
		const { fetcher } = await served();
		const source = auditApiSource({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom", "Harbour-Organisation": "org_a" }),
		});
		const page = await source.query(toQuery({ range: "all", kind: "all", organisationId: "org_b" }, NOW));
		expect(page.items).toHaveLength(20);
		expect(page.items.every((event) => event.organisationId === "org_b")).toBe(true);
	});

	it("is the console's audit seam on the api source: credentials from the log, rows linked to session turns", async () => {
		const { fetcher } = await served();
		const audit = apiAudit({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom" }),
		});
		// The people and organisations are read when the log opens (`people`), not listed up front.
		expect(audit.choices).toEqual({});
		expect(audit.people).toBeDefined();
		expect(audit.scope).toBeDefined();
		expect(await audit.credentials?.()).toEqual([
			{ value: "itm_github", label: "GitHub token" },
			{ value: "itm_linear", label: "Linear API key" },
		]);
		// A tool call's row lands on the call; a message's, whose request isn't known, opens the session at its end.
		expect(audit.links.session?.("ses_1", "call_7", "prj_billing")).toBe(
			"/projects/prj_billing/sessions/ses_1#turn=call_7",
		);
		expect(audit.links.session?.("ses_1", "ses_1/4", "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1");
		expect(audit.links.session?.("ses_1", undefined, "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1");
		expect(audit.links.session?.("ses_1", "ses_1/4")).toBeUndefined();
		// Without the vault page there is nowhere to open a vault request.
		expect(audit.links.proposal).toBeUndefined();
		const page = await audit.source.query(toQuery({ range: "all", kind: "all" }, NOW), { limit: 5 });
		expect(page.items).toHaveLength(5);
		expect(page.nextCursor).toBeDefined();
	});

	it("links a message's row at the request it was sent with, which the transcript knows it by", async () => {
		const event = (id: string, subject: string, requestId?: string): AuditEvent => ({
			id,
			seq: 1,
			at: NOW,
			recordedAt: NOW,
			source: "session",
			type: "session.prompted",
			actor: { kind: "human", userId: "usr_tom" },
			organisationId: "org_a",
			sessionId: "ses_1",
			subject: { kind: "session.submission", id: subject },
			data: requestId === undefined ? { via: "prompt" } : { via: "prompt", requestId },
		});
		const { source, requestOf } = rememberRequests({
			query: async () => ({ items: [event("e1", "ses_1/4", "req_4"), event("e2", "ses_1/5")] }),
		});
		await source.query(toQuery({ range: "all", kind: "all" }, NOW));
		const link = sessionLink(requestOf);
		expect(link("ses_1", "ses_1/4", "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1#turn=req_4");
		expect(link("ses_1", "ses_1/5", "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1");
		expect(link("ses_1", "call_7", "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1#turn=call_7");
		expect(link("ses_1", "ses_1/4")).toBeUndefined();
	});

	it("reads the people of every organisation the viewer may read, by name, and the organisations to choose from", async () => {
		const asked: string[] = [];
		const people: Record<string, { userId: string; name: string }[]> = {
			org_a: [
				{ userId: "usr_tom", name: "Tom Davies" },
				{ userId: "usr_ada", name: "Ada Lovelace" },
			],
			org_b: [
				{ userId: "usr_tom", name: "Tom Davies" },
				{ userId: "usr_grace", name: "Grace Hopper" },
			],
		};
		const fetcher = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = new Request(input, init);
			const organisation = request.headers.get(ORGANISATION_HEADER) ?? undefined;
			const path = new URL(request.url).pathname;
			asked.push(`${path} ${organisation ?? "-"} ${request.headers.get("authorization")}`);
			if (path === "/v1/organisations") {
				return Response.json({
					items: [
						{ id: "org_a", name: "Acme" },
						{ id: "org_b", name: "Bluebird" },
					],
					current: "org_a",
				});
			}
			// Bluebird's people can't be read: Acme's still are.
			if (organisation === "org_b")
				return Response.json({ error: { code: "forbidden", message: "No" } }, { status: 403 });
			return Response.json({ items: people[organisation ?? "org_a"] });
		};
		const found = await readAuditPeople({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom" }),
		});
		expect(found).toEqual({
			actors: [
				{ value: "human:usr_ada", label: "Ada Lovelace" },
				{ value: "human:usr_tom", label: "Tom Davies" },
			],
			organisations: [
				{ value: "org_a", label: "Acme" },
				{ value: "org_b", label: "Bluebird" },
			],
		});
		expect(asked.sort()).toEqual([
			"/v1/members org_a Bearer tom",
			"/v1/members org_b Bearer tom",
			"/v1/organisations - Bearer tom",
		]);
	});

	it("reads the caller's own organisation's people when the organisations can't be read", async () => {
		const fetcher = async (input: Parameters<typeof fetch>[0]) => {
			const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
			if (path === "/v1/organisations") return new Response("", { status: 404 });
			return Response.json({ items: [{ userId: "usr_tom", name: "Tom Davies" }] });
		};
		const baseUrl = "https://harbour.test";
		expect(await readAuditPeople({ baseUrl, fetch: fetcher })).toEqual({
			actors: [{ value: "human:usr_tom", label: "Tom Davies" }],
		});
		const failing = async () => Response.json({ error: { code: "forbidden", message: "No" } }, { status: 403 });
		await expect(readAuditPeople({ baseUrl, fetch: failing })).rejects.toThrow();
	});

	it("links rows about a connection request to its page when the console has the connection request page", () => {
		const audit = apiAudit({ vaultRequests: true });
		expect(audit.links.proposal?.("prp_1/a")).toBe("/connections/requests/prp_1%2Fa");
		expect(audit.links.session?.("ses_1", undefined, "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1");
	});

	it("reads the projects, agents and sessions to filter by from the session API, every page", async () => {
		const seen: string[] = [];
		const session = (id: string, agentId: string, updatedAt: number, title?: string) => ({
			id,
			organisationId: "org_a",
			projectId: "prj_billing",
			agentId,
			status: "idle",
			labels: {},
			createdBy: { kind: "human", userId: "usr_tom" },
			createdAt: 0,
			updatedAt,
			...(title === undefined ? {} : { title }),
		});
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			seen.push(`${url.pathname}${url.search} ${new Headers(init?.headers).get("authorization")}`);
			const json = (body: unknown, status = 200) => Response.json(body, { status });
			switch (url.pathname) {
				case "/v1/projects":
					return json({
						items: [
							{ id: "prj_data", name: "Data" },
							{ id: "prj_billing", name: "Billing" },
						],
					});
				case "/v1/sessions":
					return url.searchParams.get("cursor") === null
						? json({ items: [session("ses_old", "agt_sweep", 1, "Overnight sweep")], nextCursor: "1" })
						: json({ items: [session("ses_new", "agt_triage", 2), session("ses_mid", "agt_sweep", 1.5, "Triage")] });
				case "/v1/profiles":
					return json({ items: [{ id: "agt_sweep", name: "Billing sweeper" }] });
				default:
					return json({ error: { code: "not_found", message: "No route" } }, 404);
			}
		}) as typeof fetch;
		const scope = await readAuditScope({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom" }),
		});
		expect(scope).toEqual({
			projects: [
				{ value: "prj_billing", label: "Billing" },
				{ value: "prj_data", label: "Data" },
			],
			// An agent no profile names shows by its ID.
			agents: [
				{ value: "agt_triage", label: "agt_triage" },
				{ value: "agt_sweep", label: "Billing sweeper" },
			],
			sessions: [
				{ value: "ses_new", label: "Untitled session ses_new" },
				{ value: "ses_mid", label: "Triage" },
				{ value: "ses_old", label: "Overnight sweep" },
			],
		});
		expect(seen).toContain("/v1/sessions?limit=200&cursor=1 Bearer tom");
	});

	it("reads the scope without agent names when profiles can't be read, and fails when sessions can't", async () => {
		const serve = (failing: string) =>
			(async (input: RequestInfo | URL) => {
				const { pathname } = new URL(String(input));
				if (pathname === failing)
					return Response.json({ error: { code: "forbidden", message: "No" } }, { status: 403 });
				if (pathname === "/v1/sessions") {
					return Response.json({ items: [{ id: "ses_1", agentId: "agt_1", projectId: "prj_1", updatedAt: 1 }] });
				}
				return Response.json({ items: [] });
			}) as typeof fetch;
		const scope = await readAuditScope({ baseUrl: "https://harbour.test", fetch: serve("/v1/profiles") });
		expect(scope.agents).toEqual([{ value: "agt_1", label: "agt_1" }]);
		await expect(readAuditScope({ baseUrl: "https://harbour.test", fetch: serve("/v1/sessions") })).rejects.toThrow(
			"403",
		);
	});

	it("passes the server's refusal through for an organisation the caller isn't in", async () => {
		const { fetcher } = await served();
		const source = auditApiSource({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom" }),
		});
		const error = await source
			.query(toQuery({ range: "all", kind: "all", organisationId: "org_c" }, NOW))
			.catch((caught: unknown) => caught);
		expect(isHarbourError(error)).toBe(true);
	});
});
