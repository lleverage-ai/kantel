import { createAuditQueryHandler } from "@harbour/audit/http";
import { createMemoryAuditStore } from "@harbour/audit/memory";
import {
	type AuthenticatedCaller,
	type Authenticator,
	HarbourError,
	isHarbourError,
	ORGANISATION_HEADER,
	systemContext,
} from "@harbour/contracts";
import { readAll, toQuery } from "@harbour/ui";
import { describe, expect, it } from "vitest";
import { apiAudit, auditApiSource } from "./audit-http.ts";

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
		// No identity API yet: no organisations or people to choose from.
		expect(audit.choices).toEqual({});
		expect(await audit.credentials?.()).toEqual([
			{ value: "itm_github", label: "GitHub token" },
			{ value: "itm_linear", label: "Linear API key" },
		]);
		expect(audit.links.session?.("ses_1", "ses_1/4", "prj_billing")).toBe(
			"/projects/prj_billing/sessions/ses_1#turn=ses_1%2F4",
		);
		expect(audit.links.session?.("ses_1", undefined, "prj_billing")).toBe("/projects/prj_billing/sessions/ses_1");
		expect(audit.links.session?.("ses_1", "ses_1/4")).toBeUndefined();
		expect(audit.links.proposal).toBeUndefined();
		const page = await audit.source.query(toQuery({ range: "all", kind: "all" }, NOW), { limit: 5 });
		expect(page.items).toHaveLength(5);
		expect(page.nextCursor).toBeDefined();
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
