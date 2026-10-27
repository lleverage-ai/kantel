import { actorMatches, assertValidAuditEvent, findSecret, matchesQuery, typeMatches } from "@harbour/audit";
import { type AuditEventInput, isHarbourError } from "@harbour/contracts";
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
