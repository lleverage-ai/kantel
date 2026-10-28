import { describe, expect, it } from "vitest";
import {
	AUDIT_PATH,
	filesPath,
	parseRoute,
	projectPath,
	sessionPath,
	sessionTurnPath,
	VAULT_PATH,
	vaultRequestPath,
} from "./router.ts";

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

	it("puts a session's turn in the hash, so the path is still the session's", () => {
		const path = sessionTurnPath("sal", "s-1", "s-1/7");
		expect(path).toBe("/projects/sal/sessions/s-1#turn=s-1%2F7");
		const url = new URL(path, "https://harbour.test");
		expect(parseRoute(url.pathname)).toEqual({ name: "session", projectId: "sal", sessionId: "s-1" });
		expect(decodeURIComponent(url.hash.slice("#turn=".length))).toBe("s-1/7");
		expect(sessionTurnPath("sal", "s-1")).toBe(sessionPath("sal", "s-1"));
	});

	it("parses the vault page, a vault request and the audit log", () => {
		expect(parseRoute(VAULT_PATH)).toEqual({ name: "vault" });
		expect(parseRoute(vaultRequestPath("proposal_1/x"))).toEqual({ name: "vault-request", proposalId: "proposal_1/x" });
		expect(parseRoute(AUDIT_PATH)).toEqual({ name: "audit" });
		expect(parseRoute("/audit/")).toEqual({ name: "audit" });
	});

	it("parses a session's files and one file in them, mounts included", () => {
		expect(parseRoute(filesPath("sal", "s-1"))).toEqual({ name: "files", projectId: "sal", sessionId: "s-1" });
		for (const file of ["README.md", "src/billing/retry.ts", "/project/notes/plan.md", "a b?#.md"]) {
			const path = filesPath("sal", "s-1", file);
			expect(path.split("/")).toHaveLength(7);
			expect(parseRoute(path)).toEqual({ name: "files", projectId: "sal", sessionId: "s-1", path: file });
		}
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
			"/projects/sal/sessions/s-1/other",
			"/projects/sal/sessions/s-1/files/a/b",
			"/projects/sal/sessions/s-1/files/%E0",
		])
			expect(parseRoute(path)).toEqual({ name: "not-found", path });
	});
});
