import { describe, expect, it } from "vitest";
import { AUDIT_PATH, parseRoute, projectPath, sessionPath, VAULT_PATH, vaultRequestPath } from "./router.ts";

describe("routes", () => {
	it("parses the home page, a project and a session", () => {
		expect(parseRoute("/")).toEqual({ name: "home" });
		expect(parseRoute("/projects/sal")).toEqual({ name: "project", projectId: "sal" });
		expect(parseRoute("/projects/sal/")).toEqual({ name: "project", projectId: "sal" });
		expect(parseRoute("/projects/sal/sessions/s-1")).toEqual({ name: "session", projectId: "sal", sessionId: "s-1" });
	});

	it("round-trips ids that need encoding", () => {
		const path = sessionPath("my project", "s/1?x");
		expect(path).toBe("/projects/my%20project/sessions/s%2F1%3Fx");
		expect(parseRoute(path)).toEqual({ name: "session", projectId: "my project", sessionId: "s/1?x" });
		expect(parseRoute(projectPath("a b"))).toEqual({ name: "project", projectId: "a b" });
	});

	it("parses the vault page, a vault request and the audit log", () => {
		expect(parseRoute(VAULT_PATH)).toEqual({ name: "vault" });
		expect(parseRoute(vaultRequestPath("proposal_1/x"))).toEqual({ name: "vault-request", proposalId: "proposal_1/x" });
		expect(parseRoute(AUDIT_PATH)).toEqual({ name: "audit" });
		expect(parseRoute("/audit/")).toEqual({ name: "audit" });
	});

	it("says anything else is not found", () => {
		for (const path of [
			"/projects",
			"/projects/sal/sessions",
			"/projects/sal/other/x",
			"/elsewhere",
			"/projects/%E0",
			"/vault/requests",
			"/vault/other/x",
			"/vault/requests/%E0",
			"/audit/x",
		])
			expect(parseRoute(path)).toEqual({ name: "not-found", path });
	});
});
