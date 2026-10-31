import { describe, expect, it } from "vitest";
import {
	AUDIT_PATH,
	browserFromHash,
	CONNECTION_REQUESTS_PATH,
	CONNECTIONS_PATH,
	canonicalPath,
	connectionRequestPath,
	filesPath,
	KEYS_PATH,
	MEMBERS_PATH,
	memoryPath,
	modelsPath,
	NEW_SCHEDULE_PATH,
	newSessionPath,
	ORGANISATION_SCOPE,
	parseRoute,
	projectPath,
	RULES_PATH,
	SHARING_PATH,
	schedulesPath,
	sessionBrowserPath,
	sessionLinkPath,
	sessionPath,
	sessionTurnPath,
	skillsPath,
	toolServersPath,
} from "./router.ts";

describe("routes", () => {
	it("puts the organisation's sessions under /organisation, keyed by ORGANISATION_SCOPE", () => {
		const org = ORGANISATION_SCOPE;
		expect(projectPath(org)).toBe("/organisation");
		expect(newSessionPath(org)).toBe("/organisation/new");
		expect(sessionPath(org, "s-1")).toBe("/organisation/sessions/s-1");
		expect(parseRoute(projectPath(org))).toEqual({ name: "project", projectId: org });
		expect(parseRoute(newSessionPath(org))).toEqual({ name: "new-session", projectId: org });
		expect(parseRoute(sessionPath(org, "s-1"))).toEqual({ name: "session", projectId: org, sessionId: "s-1" });
		expect(parseRoute(filesPath(org, "s-1"))).toEqual({ name: "files", projectId: org, sessionId: "s-1" });
		expect(parseRoute(filesPath(org, "s-1", "src/a b.ts"))).toEqual({
			name: "files",
			projectId: org,
			sessionId: "s-1",
			path: "src/a b.ts",
		});
		// The key is never a project's: /projects/~organisation is no route.
		expect(parseRoute(`/projects/${encodeURIComponent(org)}`)).toMatchObject({ name: "not-found" });
		expect(parseRoute("/organisation/models")).toMatchObject({ name: "not-found" });
	});

	it("parses the skills and memory pages, with a skill or a concept open", () => {
		expect(parseRoute(skillsPath())).toEqual({ name: "skills" });
		expect(parseRoute(skillsPath("skl_1"))).toEqual({ name: "skills", skillId: "skl_1" });
		expect(parseRoute(memoryPath())).toEqual({ name: "memory" });
		// A concept's ID has slashes, and keeps them: Workers static assets redirect an encoded slash to a plain one.
		expect(memoryPath("projects/harbour/placement")).toBe("/memory/projects/harbour/placement");
		expect(parseRoute(memoryPath("projects/harbour/placement"))).toEqual({
			name: "memory",
			conceptId: "projects/harbour/placement",
		});
		expect(parseRoute("/memory/projects%2Fharbour%2Fplacement")).toEqual({
			name: "memory",
			conceptId: "projects/harbour/placement",
		});
		expect(parseRoute("/skills/a/b")).toMatchObject({ name: "not-found" });
	});

	it("parses the home page, a project and a session", () => {
		expect(parseRoute("/")).toEqual({ name: "home" });
		expect(parseRoute("/projects/sal")).toEqual({ name: "project", projectId: "sal" });
		expect(parseRoute("/projects/sal/")).toEqual({ name: "project", projectId: "sal" });
		expect(parseRoute("/projects/sal/sessions/s-1")).toEqual({ name: "session", projectId: "sal", sessionId: "s-1" });
	});

	it("parses a project's new session page", () => {
		expect(newSessionPath("my project")).toBe("/projects/my%20project/new");
		expect(parseRoute(newSessionPath("my project"))).toEqual({ name: "new-session", projectId: "my project" });
		expect(parseRoute(modelsPath("my project"))).toEqual({ name: "models", projectId: "my project" });
		expect(parseRoute("/projects/sal/new/extra")).toMatchObject({ name: "not-found" });
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

	it("puts a session's browser in the hash, as the audit log links one, and reads it back", () => {
		const path = sessionBrowserPath("sal", "s-1", "brs 1");
		expect(path).toBe("/projects/sal/sessions/s-1#browser=brs%201");
		const url = new URL(path, "https://harbour.test");
		expect(parseRoute(url.pathname)).toEqual({ name: "session", projectId: "sal", sessionId: "s-1" });
		expect(browserFromHash(url.hash)).toBe("brs 1");
		expect(browserFromHash("#turn=s-1%2F7")).toBeUndefined();
		expect(browserFromHash("")).toBeUndefined();
	});

	it("parses the connection request page, a connection request and the audit log", () => {
		expect(parseRoute(CONNECTION_REQUESTS_PATH)).toEqual({ name: "connection-requests" });
		expect(parseRoute(connectionRequestPath("proposal_1/x"))).toEqual({
			name: "connection-request",
			proposalId: "proposal_1/x",
		});
		// The vault's own link for a proposal opens it.
		expect(connectionRequestPath("proposal_1")).toBe("/connections/requests/proposal_1");
		expect(parseRoute(CONNECTIONS_PATH)).toEqual({ name: "connections" });
		expect(canonicalPath(connectionRequestPath("proposal_1"))).toBeUndefined();
		expect(parseRoute(AUDIT_PATH)).toEqual({ name: "audit" });
		expect(parseRoute("/audit/")).toEqual({ name: "audit" });
		expect(parseRoute(KEYS_PATH)).toEqual({ name: "keys" });
		expect(parseRoute("/keys/key_1")).toEqual({ name: "not-found", path: "/keys/key_1" });
		expect(parseRoute(MEMBERS_PATH)).toEqual({ name: "members" });
		expect(parseRoute("/members/usr_1")).toEqual({ name: "not-found", path: "/members/usr_1" });
		expect(parseRoute(SHARING_PATH)).toEqual({ name: "sharing" });
		expect(parseRoute("/sharing/share_1")).toEqual({ name: "not-found", path: "/sharing/share_1" });
		expect(parseRoute(CONNECTIONS_PATH)).toEqual({ name: "connections" });
		expect(parseRoute("/connections/github")).toEqual({ name: "not-found", path: "/connections/github" });
	});

	it("parses the organisation's tool servers and a project's", () => {
		expect(toolServersPath()).toBe("/tool-servers");
		expect(parseRoute(toolServersPath())).toEqual({ name: "tool-servers" });
		expect(parseRoute("/tool-servers/ts_1")).toEqual({ name: "not-found", path: "/tool-servers/ts_1" });
		expect(toolServersPath("my project")).toBe("/projects/my%20project/tool-servers");
		expect(parseRoute(toolServersPath("my project"))).toEqual({
			name: "project-tool-servers",
			projectId: "my project",
		});
		expect(parseRoute("/projects/sal/tool-servers/ts_1")).toMatchObject({ name: "not-found" });
		// The organisation's are at /tool-servers, not under its sessions' key.
		expect(parseRoute("/organisation/tool-servers")).toMatchObject({ name: "not-found" });
	});

	it("parses the schedules page, a new schedule and one schedule", () => {
		expect(parseRoute(schedulesPath())).toEqual({ name: "schedules" });
		expect(parseRoute(NEW_SCHEDULE_PATH)).toEqual({ name: "schedules", creating: true });
		expect(schedulesPath("sch_1/x")).toBe("/schedules/sch_1%2Fx");
		expect(parseRoute(schedulesPath("sch_1/x"))).toEqual({ name: "schedules", scheduleId: "sch_1/x" });
		expect(parseRoute("/schedules/sch_1/runs")).toMatchObject({ name: "not-found" });
	});

	it("parses the rules page, and nothing under it", () => {
		expect(RULES_PATH).toBe("/rules");
		expect(parseRoute(RULES_PATH)).toEqual({ name: "rules" });
		expect(parseRoute("/rules/")).toEqual({ name: "rules" });
		expect(parseRoute("/rules/rul_1")).toEqual({ name: "not-found", path: "/rules/rul_1" });
		expect(parseRoute("/projects/sal/rules")).toMatchObject({ name: "not-found" });
	});

	it("parses a session link that doesn't know its project", () => {
		expect(parseRoute(sessionLinkPath("s 1"))).toEqual({ name: "session-link", sessionId: "s 1" });
		expect(parseRoute("/sessions")).toMatchObject({ name: "not-found" });
	});

	it("parses a session's files and one file in them, mounts included", () => {
		expect(parseRoute(filesPath("sal", "s-1"))).toEqual({ name: "files", projectId: "sal", sessionId: "s-1" });
		for (const file of ["README.md", "src/billing/retry.ts", "/project/notes/plan.md", "a b?#.md"]) {
			const path = filesPath("sal", "s-1", file);
			expect(path.split("/")).toHaveLength(7);
			expect(parseRoute(path)).toEqual({ name: "files", projectId: "sal", sessionId: "s-1", path: file });
		}
	});

	it("opens the old vault page's links on the connection request page, and moves them there", () => {
		// What earlier consoles linked to and older proposals' links say (`/vault/proposals/<id>`), and the vault page.
		for (const [old, moved] of [
			["/vault", CONNECTION_REQUESTS_PATH],
			["/vault/", CONNECTION_REQUESTS_PATH],
			["/vault/proposals/proposal_1", "/connections/requests/proposal_1"],
			["/vault/requests/proposal_1", "/connections/requests/proposal_1"],
			["/vault/requests/p%2F1", "/connections/requests/p%2F1"],
		] as const) {
			expect(parseRoute(old), old).toEqual(parseRoute(moved));
			expect(canonicalPath(old), old).toBe(moved);
		}
		expect(canonicalPath("/vault/proposals")).toBeUndefined();
		expect(canonicalPath("/audit")).toBeUndefined();
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
			"/vault/proposals",
			"/vault/proposals/p-1/x",
			"/connections/requests/%E0",
			"/connections/requests/p-1/x",
			"/connections/other",
			"/audit/x",
			"/projects/sal/sessions/s-1/other",
			"/projects/sal/sessions/s-1/files/a/b",
			"/projects/sal/sessions/s-1/files/%E0",
		])
			expect(parseRoute(path)).toEqual({ name: "not-found", path });
	});
});
