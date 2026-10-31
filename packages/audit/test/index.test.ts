import { actorMatches, assertValidAuditEvent, findSecret, matchesQuery, typeMatches } from "@harbour/audit";
import {
	type AuditEventInput,
	auditTypeAliases,
	currentAuditType,
	isHarbourError,
	RENAMED_VAULT_AUDIT_TYPES,
} from "@harbour/contracts";
import { describe, expect, it } from "vitest";

const event: AuditEventInput = {
	id: "evt-1",
	at: 1_000,
	source: "vault",
	type: "vault.proposal.created",
	actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
	organisationId: "org-a",
	projectId: "proj-1",
	sessionId: "session-1",
	agentId: "agent-1",
	subject: { kind: "vault.proposal", id: "proposal-1" },
	data: { route: { host: "api.github.com", methods: ["GET"] } },
};

describe("typeMatches", () => {
	it("treats a type ending in a dot as a prefix and anything else as exact", () => {
		expect(typeMatches("vault.proposal.created", "vault.")).toBe(true);
		expect(typeMatches("vaults.custom", "vault.")).toBe(false);
		expect(typeMatches("vault.proposal.created", "vault.proposal")).toBe(false);
		expect(typeMatches("vault.proposal.created", "vault.proposal.created")).toBe(true);
	});

	it("lets an old vault type or prefix match the new type it was renamed to (#324), and not the other way", () => {
		expect(typeMatches("connections.request.created", "vault.proposal.created")).toBe(true);
		expect(typeMatches("connections.request.created", "vault.proposal.")).toBe(true);
		expect(typeMatches("connections.request.created", "vault.")).toBe(true);
		expect(typeMatches("connections.egress.injected", "vault.use.")).toBe(true);
		expect(typeMatches("connections.egress.injected", "vault.decision.")).toBe(false);
		expect(typeMatches("connections.request.created", "vault.proposal")).toBe(false);
		expect(typeMatches("vault.proposal.created", "connections.request.created")).toBe(false);
		expect(typeMatches("vault.proposal.created", "connections.")).toBe(false);
		// The connections package's own events are no old type's new name.
		expect(typeMatches("connections.use.denied", "vault.")).toBe(false);
	});
});

describe("the vault audit types under their Connections names (#324)", () => {
	const old = Object.keys(RENAMED_VAULT_AUDIT_TYPES);
	const renamed = Object.values(RENAMED_VAULT_AUDIT_TYPES);

	it("renames every old type once, to a distinct connections type", () => {
		expect(old).toHaveLength(16);
		expect(old.every((type) => type.startsWith("vault."))).toBe(true);
		expect(renamed.every((type) => type.startsWith("connections."))).toBe(true);
		expect(new Set(renamed).size).toBe(renamed.length);
	});

	it("keeps clear of the connections package's own families", () => {
		const own = ["connections.connection.", "connections.client.", "connections.connect.", "connections.use."];
		for (const type of renamed)
			expect(
				own.some((prefix) => type.startsWith(prefix)),
				type,
			).toBe(false);
	});

	it("reads an old type as its new name and leaves every other type alone", () => {
		for (const type of old)
			expect(currentAuditType(type)).toBe(RENAMED_VAULT_AUDIT_TYPES[type as keyof typeof RENAMED_VAULT_AUDIT_TYPES]);
		expect(currentAuditType("connections.egress.injected")).toBe("connections.egress.injected");
		expect(currentAuditType("session.created")).toBe("session.created");
		expect(currentAuditType("toString")).toBe("toString");
		expect(currentAuditType("vault.custom.noted")).toBe("vault.custom.noted");
	});

	it("aliases an old exact type to one new type, an old prefix to every new type under it, and nothing else", () => {
		expect(auditTypeAliases("vault.decision.approved")).toEqual(["connections.decision.approved"]);
		expect(auditTypeAliases("vault.use.")).toEqual(["connections.egress.injected", "connections.egress.denied"]);
		expect([...auditTypeAliases("vault.")].sort()).toEqual([...renamed].sort());
		expect(auditTypeAliases("connections.")).toEqual([]);
		expect(auditTypeAliases("vault.custom.noted")).toEqual([]);
		expect(auditTypeAliases("vault.decision")).toEqual([]);
	});
});

describe("actorMatches", () => {
	it("compares by kind and ID", () => {
		expect(actorMatches({ kind: "human", userId: "u" }, { kind: "human", userId: "u" })).toBe(true);
		expect(actorMatches({ kind: "human", userId: "u" }, { kind: "system", component: "u" })).toBe(false);
		expect(
			actorMatches({ kind: "agent", agentId: "a", sessionId: "s1" }, { kind: "agent", agentId: "a", sessionId: "s2" }),
		).toBe(false);
		expect(actorMatches({ kind: "system", component: "x" }, { kind: "system", component: "x" })).toBe(true);
	});

	it("ignores a service's key unless the query names one", () => {
		const actual = { kind: "service", serviceId: "svc", keyId: "k1" } as const;
		expect(actorMatches(actual, { kind: "service", serviceId: "svc" })).toBe(true);
		expect(actorMatches(actual, { kind: "service", serviceId: "svc", keyId: "k1" })).toBe(true);
		expect(actorMatches(actual, { kind: "service", serviceId: "svc", keyId: "k2" })).toBe(false);
		expect(
			actorMatches({ kind: "service", serviceId: "svc" }, { kind: "service", serviceId: "svc", keyId: "k1" }),
		).toBe(false);
	});
});

describe("matchesQuery", () => {
	it("matches when every given field matches", () => {
		expect(matchesQuery(event, {})).toBe(true);
		expect(
			matchesQuery(event, {
				projectId: "proj-1",
				sessionId: "session-1",
				agentId: "agent-1",
				actor: { kind: "agent", agentId: "agent-1", sessionId: "session-1" },
				source: "vault",
				type: "vault.",
				subject: { kind: "vault.proposal", id: "proposal-1" },
				from: 1_000,
				to: 1_001,
			}),
		).toBe(true);
		expect(matchesQuery(event, { projectId: "proj-2" })).toBe(false);
		expect(matchesQuery(event, { subject: { kind: "vault.grant", id: "proposal-1" } })).toBe(false);
	});

	it("treats from as inclusive and to as exclusive", () => {
		expect(matchesQuery(event, { from: 1_000 })).toBe(true);
		expect(matchesQuery(event, { from: 1_001 })).toBe(false);
		expect(matchesQuery(event, { to: 1_000 })).toBe(false);
		expect(matchesQuery(event, { to: 1_001 })).toBe(true);
	});
});

describe("findSecret", () => {
	it("searches every string and key in data, and nothing outside it", () => {
		expect(findSecret(event, ["github"])).toBe(true);
		expect(findSecret(event, ["GET"])).toBe(true);
		expect(findSecret(event, ["host"])).toBe(true);
		expect(findSecret(event, ["proposal-1"])).toBe(false);
		expect(findSecret(event, [""])).toBe(false);
		expect(findSecret({ ...event, data: undefined }, ["github"])).toBe(false);
	});
});

describe("assertValidAuditEvent", () => {
	it("refuses an event without an actor or with an unknown source", () => {
		const { actor: _actor, ...withoutActor } = event;
		for (const bad of [
			withoutActor,
			{ ...event, source: "nowhere" },
			{ ...event, type: "vault." },
			{ ...event, at: Number.POSITIVE_INFINITY },
		]) {
			let caught: unknown;
			try {
				assertValidAuditEvent(bad as AuditEventInput);
			} catch (error) {
				caught = error;
			}
			expect(isHarbourError(caught, "invalid")).toBe(true);
		}
		expect(() => assertValidAuditEvent(event)).not.toThrow();
	});
});
