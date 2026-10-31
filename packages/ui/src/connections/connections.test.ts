import { describe, expect, it } from "vitest";
import { disconnectText } from "./connection-list.tsx";
import {
	clientTemplates,
	connectRoute,
	defaultOwner,
	detectKey,
	groupConnections,
	hostPatternError,
	mcpUrlError,
	ownerChoiceWarning,
	parseHosts,
	searchCatalogue,
	usageText,
	winningClient,
} from "./connections-model.ts";
import { CATALOGUE, CLIENTS, CONNECTIONS, createConnectionsScenario, MEMBER_VIEWER, VIEWER } from "./fixtures.ts";

const byId = (id: string) => {
	const found = CATALOGUE.find((t) => t.id === id);
	if (found === undefined) throw new Error(`no ${id}`);
	return found;
};

describe("disconnectText (#329)", () => {
	const connection = (id: string) => {
		const found = CONNECTIONS.find((c) => c.id === id);
		if (found === undefined) throw new Error(`no ${id}`);
		return found;
	};

	it("says what the provider did, and where to finish the job when it didn't revoke", () => {
		const github = connection("conn_github_tom");
		expect(disconnectText(github, { revoked: true })).toBe(
			"Disconnected GitHub (tvdavies). GitHub revoked the access too.",
		);
		const gmail = connection("conn_gmail_tom");
		expect(
			disconnectText(gmail, {
				revoked: false,
				revokeUrl: "https://myaccount.google.com/connections",
				reason: "The provider refused the revocation (temporarily_unavailable).",
			}),
		).toBe(
			"Disconnected Gmail (tom@acme.com) here and deleted its credential, but Gmail didn't revoke the access (The provider refused the revocation (temporarily_unavailable)). Remove its access at https://myaccount.google.com/connections.",
		);
		const slack = connection("conn_slack_org");
		expect(disconnectText(slack, { revoked: "unsupported", revokeUrl: "https://slack.com/apps/manage" })).toBe(
			"Disconnected Slack (Acme workspace). Kantel deleted its credential, but Slack gives apps no way to revoke access, so remove it at https://slack.com/apps/manage too.",
		);
		expect(disconnectText(connection("conn_stripe_billing"), { revoked: "unsupported" })).toMatch(
			/deleted the key, but it still works at Stripe until you revoke it there/,
		);
		expect(disconnectText(connection("conn_linear_support"), { revoked: "none" })).toMatch(/nothing to revoke/);
		expect(disconnectText(github, { revoked: "unknown" })).toMatch(/remove its access in GitHub's settings too/);
	});
});

describe("searchCatalogue", () => {
	it("ranks a name match above a summary match", () => {
		const found = searchCatalogue(CATALOGUE, "git");
		expect(found.slice(0, 2).map((t) => t.id)).toEqual(["github", "gitlab"]);
	});

	it("needs every word to match", () => {
		expect(searchCatalogue(CATALOGUE, "google calendar").map((t) => t.id)).toEqual(["google-calendar"]);
		expect(searchCatalogue(CATALOGUE, "github zzz")).toEqual([]);
	});

	it("filters by category", () => {
		const found = searchCatalogue(CATALOGUE, "", "Finance");
		expect(found.length).toBeGreaterThan(0);
		expect(found.every((t) => t.category === "Finance")).toBe(true);
	});
});

describe("connectRoute", () => {
	it("is one click with a client or an MCP server, needs a client without one, and a key otherwise", () => {
		expect(connectRoute(byId("github"))).toBe("one_click");
		expect(connectRoute(byId("linear"))).toBe("one_click");
		expect(connectRoute(byId("salesforce"))).toBe("needs_client");
		expect(connectRoute(byId("stripe"))).toBe("key");
	});
});

describe("detectKey", () => {
	it("suggests the template whose longest prefix matches", () => {
		expect(detectKey(CATALOGUE, "github_pat_11ABCDEFG0123456789")?.shape.label).toBe("a GitHub fine-grained token");
		expect(detectKey(CATALOGUE, "rk_live_abcdef123456")?.template.id).toBe("stripe");
	});

	it("suggests nothing for a short or unknown key", () => {
		expect(detectKey(CATALOGUE, "ghp_")).toBeUndefined();
		expect(detectKey(CATALOGUE, "zz-not-a-known-key-shape")).toBeUndefined();
	});
});

describe("validation", () => {
	it("takes only https MCP URLs without credentials", () => {
		expect(mcpUrlError("https://mcp.example.com/mcp")).toBeUndefined();
		expect(mcpUrlError("http://mcp.example.com/mcp")).toMatch(/https/);
		expect(mcpUrlError("https://me:pw@mcp.example.com")).toMatch(/credentials/);
		expect(mcpUrlError("not a url")).toMatch(/isn't a URL/);
	});

	it("takes hosts and wildcards, not paths or plain http", () => {
		expect(hostPatternError("api.example.com")).toBeUndefined();
		expect(hostPatternError("*.example.com")).toBeUndefined();
		expect(hostPatternError("http://api.example.com")).toMatch(/http/);
		expect(hostPatternError("api.example.com/v1")).toMatch(/path/);
		expect(parseHosts("https://api.example.com, *.example.com\nfoo.io")).toEqual([
			"api.example.com",
			"*.example.com",
			"foo.io",
		]);
	});
});

describe("ownership", () => {
	it("says where each kind of connection may be used", () => {
		expect(usageText({ owner: { kind: "user", organisationId: "org_acme", userId: VIEWER.userId } }, VIEWER)).toBe(
			`Personal to ${VIEWER.name}, only in sessions acting as ${VIEWER.name}.`,
		);
		expect(
			usageText({ owner: { kind: "project", organisationId: "org_acme", projectId: "proj_support" } }, VIEWER),
		).toBe("Shared with the Support project: its agents can use it.");
	});

	it("groups the viewer's own first and the organisation's last", () => {
		const groups = groupConnections(CONNECTIONS, VIEWER);
		expect(groups[0]?.title).toBe("Yours");
		expect(groups.at(-1)?.key).toBe("organisation");
		// Two GitHub connections, each in its own group.
		const github = groups.flatMap((g) => g.connections.filter((c) => c.templateId === "github").map(() => g.key));
		expect(new Set(github).size).toBe(github.length);
	});
});

describe("clientTemplates", () => {
	it("offers OAuth APIs and OAuth MCP servers, not key-only services", () => {
		const ids = clientTemplates(CATALOGUE).map((t) => t.id);
		expect(ids).toContain("github");
		expect(ids).toContain("linear");
		expect(ids).toContain("notion");
		expect(ids).not.toContain("openai");
	});

	it("leaves out a server that needs no sign-in, which has nothing to register", () => {
		expect(byId("deepwiki").open).toBe(true);
		expect(clientTemplates(CATALOGUE).map((t) => t.id)).not.toContain("deepwiki");
		expect(connectRoute(byId("deepwiki"))).toBe("one_click");
	});
});

describe("who a new connection is for", () => {
	it("starts on the project open, else the first project, else just the viewer", () => {
		expect(defaultOwner({ ...VIEWER, projectId: "proj_billing" })).toEqual({
			kind: "project",
			projectId: "proj_billing",
		});
		expect(defaultOwner(VIEWER)).toEqual({ kind: "project", projectId: "proj_support" });
		expect(defaultOwner({ ...VIEWER, projectId: "proj_gone" })).toEqual({ kind: "project", projectId: "proj_support" });
		expect(defaultOwner({ ...VIEWER, projects: [] })).toEqual({ kind: "user" });
	});

	it("warns about just me only where the deployment says sessions are its projects'", () => {
		expect(ownerChoiceWarning({ kind: "user" }, { ...VIEWER, personal: false })).toContain("Agents can't use this");
		expect(ownerChoiceWarning({ kind: "user" }, { ...VIEWER, personal: true })).toBeUndefined();
		expect(ownerChoiceWarning({ kind: "user" }, VIEWER)).toBeUndefined();
		expect(
			ownerChoiceWarning({ kind: "project", projectId: "proj_support" }, { ...VIEWER, personal: false }),
		).toBeUndefined();
	});
});

describe("winningClient", () => {
	it("prefers the narrowest enabled client", () => {
		expect(winningClient(CLIENTS, "github")?.tier).toBe("organisation");
		const disabled = CLIENTS.map((c) => (c.tier === "organisation" ? { ...c, disabled: true } : c));
		expect(winningClient(disabled, "github")?.tier).toBe("deployment");
	});
});

describe("the fixture source", () => {
	it("keeps only a key's last four characters", async () => {
		const source = createConnectionsScenario({ delay: 0 });
		const { connection } = await source.connectKey({
			templateId: "stripe",
			owner: { kind: "user" },
			key: "rk_live_secretvalue1234",
		});
		expect(connection.key).toEqual({ set: true, last4: "1234" });
		expect(JSON.stringify(await source.connections())).not.toContain("secretvalue");
	});

	it("won't delete a client connections are pinned to", async () => {
		const source = createConnectionsScenario({ delay: 0 }, MEMBER_VIEWER);
		const pinned = CLIENTS.find((c) => c.pinnedConnections > 0);
		if (pinned === undefined) throw new Error("no pinned client");
		await expect(source.deleteClient(pinned.id)).rejects.toThrow(/pinned/);
	});
});
