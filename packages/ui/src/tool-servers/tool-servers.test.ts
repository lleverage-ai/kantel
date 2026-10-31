import { describe, expect, it } from "vitest";
import {
	createToolServersScenario,
	DOCS_SERVER,
	FIXTURE_NOW,
	LONG_TOOL_NAME,
	ORGANISATION,
	PROJECTS,
	SAL_SERVER,
	toolsView,
	WAREHOUSE_SERVER,
} from "./fixtures.ts";
import {
	latencyText,
	olderTokens,
	statsText,
	TUNNEL_LOOPBACK_URL,
	tokenUsedText,
	toolCountText,
	toolServerScopeText,
	toolServerState,
	toolServerStatusText,
	tunnelCommand,
} from "./tool-servers-model.ts";

const HOUR = 3_600_000;

describe("toolServerStatusText", () => {
	it("says connected, offline with when it was last seen, or not connected yet", () => {
		expect(toolServerStatusText(SAL_SERVER.connection, FIXTURE_NOW)).toBe("Connected");
		expect(toolServerStatusText(DOCS_SERVER.connection, FIXTURE_NOW)).toBe("Offline, last seen 2h ago");
		expect(toolServerStatusText(WAREHOUSE_SERVER.connection, FIXTURE_NOW)).toBe("Not connected yet");
		expect(toolServerStatusText({ status: "offline", lastSeenAt: FIXTURE_NOW - 10_000 }, FIXTURE_NOW)).toBe(
			"Offline, last seen just now",
		);
	});

	it("tells a server that has connected before from one that never has", () => {
		expect(toolServerState(SAL_SERVER.connection)).toBe("connected");
		expect(toolServerState(DOCS_SERVER.connection)).toBe("offline");
		expect(toolServerState({ status: "offline", connectedAt: FIXTURE_NOW - HOUR })).toBe("offline");
		expect(toolServerState(WAREHOUSE_SERVER.connection)).toBe("never");
	});
});

describe("tunnelCommand", () => {
	it("runs a stdio server after --, with the origin, the server and the token", () => {
		expect(tunnelCommand("https://harbour.example.com/", "ts_1", "hbt_abc", "stdio")).toBe(
			"npx @kantel/tunnel --harbour https://harbour.example.com --server ts_1 --token hbt_abc -- <your stdio MCP server command>",
		);
	});

	it("points at a loopback Streamable HTTP server with --url", () => {
		expect(tunnelCommand("https://harbour.example.com", "ts_1", "hbt_abc", "url")).toBe(
			`npx @kantel/tunnel --harbour https://harbour.example.com --server ts_1 --token hbt_abc --url ${TUNNEL_LOOPBACK_URL}`,
		);
	});
});

describe("the list's words", () => {
	it("names the scope: the organisation, or the project", () => {
		expect(toolServerScopeText(DOCS_SERVER, ORGANISATION, PROJECTS)).toBe("Acme");
		expect(toolServerScopeText(SAL_SERVER, ORGANISATION, PROJECTS)).toBe("Sal project");
		expect(toolServerScopeText({ projectId: "proj_gone" }, ORGANISATION, PROJECTS)).toBe("proj_gone project");
	});

	it("counts tools, and says when there are none to count yet", () => {
		expect(toolCountText(SAL_SERVER)).toBe("6 tools");
		expect(toolCountText(WAREHOUSE_SERVER)).toBe("No tools yet");
	});

	it("gives a day's calls with their median", () => {
		expect(statsText({ calls24h: 142, p50Ms: 184 })).toBe("142 calls, p50 184 ms");
		expect(statsText({ calls24h: 1 })).toBe("1 call");
		expect(statsText({ calls24h: 0 })).toBe("No calls in the last day");
		expect(statsText(undefined)).toBeUndefined();
		expect(latencyText(1840)).toBe("1.8 s");
		expect(latencyText(30_000)).toBe("30 s");
	});
});

describe("tokens", () => {
	const token = {
		id: "tst_1",
		toolServerId: "ts_1",
		prefix: "hbt_abcd",
		createdBy: { kind: "system", component: "test" },
	} as const;

	it("says when one was last used", () => {
		expect(tokenUsedText({ ...token, createdAt: 0 }, FIXTURE_NOW)).toBe("Never used");
		expect(tokenUsedText({ ...token, createdAt: 0, lastUsedAt: FIXTURE_NOW - 3 * HOUR }, FIXTURE_NOW)).toBe(
			"Last used 3h ago",
		);
	});

	it("leaves the new token out of the ones a rotation replaces", () => {
		const older = { ...token, createdAt: 0 };
		const newer = { ...token, id: "tst_2", createdAt: 1 };
		expect(olderTokens([older, newer], "tst_2")).toEqual([older]);
	});
});

describe("the fixtures' tools view", () => {
	it("marks disabled tools, names them as the model sees them and says why one can't be offered", () => {
		const sal = toolsView(SAL_SERVER).tools;
		expect(sal.find((tool) => tool.name === "drive_search")?.enabled).toBe(false);
		expect(sal.find((tool) => tool.name === "slack_search")?.modelName).toBe("sal__slack_search");
		expect(new Set(sal.map((tool) => tool.replay))).toEqual(new Set(["safe", "unsafe"]));
		const long = toolsView(DOCS_SERVER).tools.find((tool) => tool.name === LONG_TOOL_NAME);
		expect(long?.unavailableReason).toMatch(/at most 50/);
	});

	it("adds a server with its first token, and toggles, rotates and removes", async () => {
		const source = createToolServersScenario({ delay: 0 });
		await expect(source.create({ name: "Bad Name", transport: "tunnel" })).rejects.toThrow(/lower-case/);
		const made = await source.create({ name: "billing", transport: "tunnel", projectId: "proj_support" });
		expect(made.token?.secret).toMatch(/^hbt_/);
		expect(made.token?.token.prefix).toBe(made.token?.secret.slice(0, 8));
		expect((await source.list({ projectId: "proj_sal" })).map((server) => server.name)).not.toContain("billing");

		await source.setToolEnabled(SAL_SERVER.id, "drive_search", true);
		expect((await source.tools(SAL_SERVER.id)).tools.every((tool) => tool.enabled)).toBe(true);

		const rotated = await source.createToken(SAL_SERVER.id);
		expect((await source.listTokens(SAL_SERVER.id)).length).toBe(2);
		for (const old of olderTokens(await source.listTokens(SAL_SERVER.id), rotated.token.id))
			await source.revokeToken(SAL_SERVER.id, old.id);
		expect((await source.listTokens(SAL_SERVER.id)).map((t) => t.id)).toEqual([rotated.token.id]);

		await source.remove(made.server.id);
		expect((await source.list()).map((server) => server.name)).toEqual(["docs-search", "sal", "warehouse"]);
	});
});
