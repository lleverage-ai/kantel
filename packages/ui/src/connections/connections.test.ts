import { describe, expect, it } from "vitest";
import { disconnectText } from "./connection-list.tsx";
import {
	clientTemplates,
	connectRoute,
	defaultOwner,
	detectKey,
	groupConnections,
	healthText,
	hostPatternError,
	mcpUrlError,
	needsAttention,
	ownerChoiceWarning,
	parseHosts,
	searchCatalogue,
	usageText,
	winningClient,
} from "./connections-model.ts";
import { CATALOGUE, CLIENTS, CONNECTIONS, createConnectionsScenario, MEMBER_VIEWER, VIEWER } from "./fixtures.ts";
import { inkOf } from "./provider-logo.tsx";

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

	it("names the server that revoked it for an MCP server added by hand, not the name someone gave it (#482)", () => {
		const mcp = {
			...connection("conn_github_tom"),
			id: "conn_mcp",
			templateId: "custom-mcp",
			name: "MCP example (deployed check)",
			kind: "mcp",
			mcp: { url: "https://example-server.modelcontextprotocol.io/mcp" },
		} as const;
		const { account: _account, ...unnamed } = mcp;
		expect(disconnectText(unnamed, { revoked: true })).toBe(
			"Disconnected MCP example (deployed check). example-server.modelcontextprotocol.io revoked the access too.",
		);
	});
});

describe("health (#328)", () => {
	const notion = CONNECTIONS.find((c) => c.health === "refresh_failing");
	if (notion === undefined) throw new Error("no refresh_failing fixture");
	const now = notion.retryAt === undefined ? 0 : notion.retryAt - 4 * 60_000;

	it("says a failing refresh is Kantel's to retry, and when", () => {
		expect(healthText(notion, now)).toBe(
			"Notion's token endpoint answered 503. Kantel tries again in 4m; nobody needs to do anything yet.",
		);
		expect(healthText({ ...notion, retryAt: now - 1 }, now)).toMatch(/Kantel is trying again/);
		expect(healthText({ ...notion, lastError: undefined as unknown as string }, now)).toMatch(
			/^Kantel couldn't refresh the token\. /,
		);
	});

	it("says a reconnect is needed even with no error from the gateway, and nothing for a healthy one", () => {
		const { lastError: _, ...bare } = { ...notion, health: "needs_reconnect" as const };
		expect(healthText(bare, now)).toBe("Notion stopped accepting Kantel's sign-in. Reconnect to sign in again.");
		expect(healthText({ ...notion, health: "healthy" }, now)).toBeUndefined();
	});

	it("doesn't count a failing refresh as needing someone", () => {
		expect(needsAttention([notion])).toBe(0);
		expect(needsAttention([{ ...notion, health: "needs_reconnect" }])).toBe(1);
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

describe("a logo's ink", () => {
	// A 4 by 4 logo: a mark of one colour in the middle four pixels, and `corner` everywhere else.
	const logo = (mark: [number, number, number], corner: [number, number, number, number] = [0, 0, 0, 0]) => {
		const pixels: number[] = [];
		for (let y = 0; y < 4; y++)
			for (let x = 0; x < 4; x++) pixels.push(...(x > 0 && x < 3 && y > 0 && y < 3 ? [...mark, 255] : corner));
		return pixels;
	};

	it("reads a dark mark on nothing as dark, and a light one as light", () => {
		expect(inkOf(logo([24, 23, 23]), 4)).toBe("dark");
		expect(inkOf(logo([54, 45, 89]), 4)).toBe("dark");
		expect(inkOf(logo([250, 250, 250]), 4)).toBe("light");
	});

	it("leaves a mark in middling colours, or a logo with a background of its own, as it is", () => {
		expect(inkOf(logo([94, 106, 210]), 4)).toBeUndefined();
		expect(inkOf(logo([24, 23, 23], [255, 255, 255, 255]), 4)).toBeUndefined();
		expect(
			inkOf(
				logo([0, 0, 0], [0, 0, 0, 0]).map(() => 0),
				4,
			),
		).toBeUndefined();
	});
});
