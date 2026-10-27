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
	});
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

	it("is the console's audit seam on the api source, with no names or choices until identity has an API", async () => {
		const { fetcher } = await served();
		const audit = apiAudit({
			baseUrl: "https://harbour.test",
			fetch: fetcher,
			headers: () => ({ authorization: "Bearer tom" }),
		});
		expect(audit.choices).toEqual({});
		expect(audit.links).toEqual({});
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
