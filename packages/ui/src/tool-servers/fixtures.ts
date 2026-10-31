// Fixtures for the Tool servers page: an organisation's servers in each state (Sal's connected project server, an
// offline one, one that has never connected), and an in-memory source that adds, changes and removes them the way
// `/v1/tool-servers` will, with a short delay on each call. Stories and the console's recorded mode use them; no
// token here is real.

import {
	type Actor,
	type CreatedToolServer,
	type IssuedToolServerToken,
	replayOf,
	type ToolServer,
	type ToolServerToken,
	type ToolServerTool,
	type ToolServerToolAnnotations,
	type ToolServerTools,
	TUNNEL_TOKEN_PREFIX,
	toolServerModelName,
	toolServerModelNameProblem,
	toolServerNameProblem,
} from "@harbour/contracts";
import type { ToolServerCall, ToolServerProject, ToolServerStats, ToolServersSource } from "./tool-servers-model.ts";

export const FIXTURE_NOW = Date.UTC(2026, 9, 30, 14, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ORGANISATION = "Acme";
const ORGANISATION_ID = "org_acme";
export const PROJECTS: readonly ToolServerProject[] = [
	{ id: "proj_sal", name: "Sal" },
	{ id: "proj_support", name: "Support" },
];
/** Harbour's address, as the tunnel command names it. */
export const ORIGIN = "https://harbour.example.com";

const TOM: Actor = { kind: "human", userId: "usr_tom" };

const tool = (
	name: string,
	description: string,
	annotations: ToolServerToolAnnotations,
	properties: Record<string, { type: string }> = {},
): ToolServerTool => ({
	name,
	description,
	inputSchema: { type: "object", properties, required: Object.keys(properties).slice(0, 1) },
	annotations,
	replay: replayOf(annotations),
});

const READ_ONLY: ToolServerToolAnnotations = { readOnlyHint: true };

const SAL_TOOLS: readonly ToolServerTool[] = [
	tool(
		"task_outcome",
		"Record the outcome of the current research task: a summary, the sources used and whether it is finished.\nCall it once, at the end of the task.",
		{ title: "Task outcome", destructiveHint: false },
		{ summary: { type: "string" }, sources: { type: "array" }, done: { type: "boolean" } },
	),
	tool(
		"slack_search",
		"Search Slack messages the Sal workspace can see. Supports from:, in:, before: and after: filters.",
		READ_ONLY,
		{ query: { type: "string" } },
	),
	tool("slack_thread", "Read a Slack thread in full, by channel ID and the parent message's ts.", READ_ONLY, {
		channel: { type: "string" },
		ts: { type: "string" },
	}),
	tool("drive_search", "Search Google Drive for documents by title and content.", READ_ONLY, {
		query: { type: "string" },
	}),
	tool(
		"drive_read_doc",
		"Read a Google Doc as Markdown. Documents longer than 50,000 characters are cut, and say so at the end.",
		READ_ONLY,
		{ documentId: { type: "string" } },
	),
	tool("memory_search", "Search Sal's notes from earlier runs, newest first.", READ_ONLY, {
		query: { type: "string" },
	}),
];

/** A tool whose name, with its server's, is longer than a model may be given: its view says why. */
export const LONG_TOOL_NAME = "search_engineering_handbook_sections_by_heading_text";

const DOCS_TOOLS: readonly ToolServerTool[] = [
	tool(
		"search_docs",
		"Full-text search over the product documentation. Returns titles, URLs and a snippet.",
		READ_ONLY,
		{ query: { type: "string" } },
	),
	tool("get_page", "Fetch one documentation page as Markdown, by URL.", READ_ONLY, { url: { type: "string" } }),
	tool(LONG_TOOL_NAME, "Search the engineering handbook by section heading.", READ_ONLY, {
		heading: { type: "string" },
	}),
];

const snapshot = (tools: readonly ToolServerTool[], takenAt: number, hash: string) => ({ tools, hash, takenAt });

export const SAL_SERVER: ToolServer = {
	id: "ts_01sal",
	organisationId: ORGANISATION_ID,
	projectId: "proj_sal",
	name: "sal",
	description: "Sal's worker: its research tools, served for each run.",
	transport: "tunnel",
	snapshot: snapshot(
		SAL_TOOLS,
		FIXTURE_NOW - 3 * HOUR,
		"sha256:5f0c2a9be31d4c7a8e61f4b2d09a7c3e5b18f62d4a90c7e1b3d5f8a2c6e4b170",
	),
	disabledTools: ["drive_search"],
	connection: {
		status: "connected",
		connectedAt: FIXTURE_NOW - 3 * HOUR,
		lastSeenAt: FIXTURE_NOW - MINUTE,
		serverInfo: { name: "sal-worker", version: "0.14.2" },
	},
	createdBy: TOM,
	createdAt: FIXTURE_NOW - 12 * DAY,
	updatedAt: FIXTURE_NOW - 2 * DAY,
};

export const DOCS_SERVER: ToolServer = {
	id: "ts_02docs",
	organisationId: ORGANISATION_ID,
	name: "docs-search",
	transport: "tunnel",
	snapshot: snapshot(
		DOCS_TOOLS,
		FIXTURE_NOW - 6 * DAY,
		"sha256:a41e7d03c95b2f68e1d4a7c0b38f5e29d6a1c4b7e08f3d52a9c6e1b4d7f0a382",
	),
	disabledTools: [],
	connection: {
		status: "offline",
		lastSeenAt: FIXTURE_NOW - 2 * HOUR,
		serverInfo: { name: "docs-search-mcp", version: "1.3.0" },
	},
	createdBy: TOM,
	createdAt: FIXTURE_NOW - 20 * DAY,
	updatedAt: FIXTURE_NOW - 6 * DAY,
};

export const WAREHOUSE_SERVER: ToolServer = {
	id: "ts_03warehouse",
	organisationId: ORGANISATION_ID,
	name: "warehouse",
	description: "Read-only queries against the analytics warehouse.",
	transport: "tunnel",
	disabledTools: [],
	connection: { status: "offline" },
	createdBy: TOM,
	createdAt: FIXTURE_NOW - DAY,
	updatedAt: FIXTURE_NOW - DAY,
};

export const SERVERS: readonly ToolServer[] = [SAL_SERVER, DOCS_SERVER, WAREHOUSE_SERVER];

const token = (
	id: string,
	toolServerId: string,
	prefix: string,
	createdAt: number,
	lastUsedAt?: number,
): ToolServerToken => ({
	id,
	toolServerId,
	prefix,
	createdBy: TOM,
	createdAt,
	...(lastUsedAt === undefined ? {} : { lastUsedAt }),
});

export const TOKENS: readonly ToolServerToken[] = [
	token("tst_01sal", SAL_SERVER.id, "hbt_7k2q", FIXTURE_NOW - 12 * DAY, FIXTURE_NOW - 3 * HOUR),
	token("tst_02docs", DOCS_SERVER.id, "hbt_m4xa", FIXTURE_NOW - 20 * DAY, FIXTURE_NOW - 2 * HOUR),
	token("tst_03warehouse", WAREHOUSE_SERVER.id, "hbt_c9vd", FIXTURE_NOW - DAY),
];

export const STATS: Readonly<Record<string, ToolServerStats>> = {
	[SAL_SERVER.id]: { calls24h: 142, p50Ms: 184 },
	[DOCS_SERVER.id]: { calls24h: 37, p50Ms: 412 },
	[WAREHOUSE_SERVER.id]: { calls24h: 0 },
};

const call = (
	n: number,
	tool: string,
	sessionTitle: string | undefined,
	ago: number,
	durationMs: number | undefined,
	outcome: ToolServerCall["outcome"],
): ToolServerCall => ({
	callId: `call_${n}`,
	sessionId: `ses_${100 + Math.floor((n - 1) / 2)}`,
	...(sessionTitle === undefined ? {} : { sessionTitle }),
	tool,
	startedAt: FIXTURE_NOW - ago,
	...(durationMs === undefined ? {} : { durationMs }),
	outcome,
});

export const CALLS: Readonly<Record<string, readonly ToolServerCall[]>> = {
	[SAL_SERVER.id]: [
		call(1, "slack_search", "What did the platform team decide about the EU region?", 2 * MINUTE, undefined, "ok"),
		call(2, "slack_thread", "What did the platform team decide about the EU region?", 3 * MINUTE, 164, "ok"),
		call(3, "drive_read_doc", "Summarise the Q3 planning doc for the board", 26 * MINUTE, 1840, "ok"),
		call(4, "memory_search", "Summarise the Q3 planning doc for the board", 27 * MINUTE, 92, "ok"),
		call(5, "task_outcome", "Find the owners of the billing alerts", 58 * MINUTE, 210, "ok"),
		call(6, "slack_search", "Find the owners of the billing alerts", 61 * MINUTE, 30_000, "error"),
	],
	[DOCS_SERVER.id]: [
		call(7, "search_docs", "Draft a reply about SSO setup", 2 * HOUR + 4 * MINUTE, undefined, "offline"),
		call(8, "get_page", undefined, 2 * HOUR + 30 * MINUTE, 388, "ok"),
		call(9, "search_docs", undefined, 2 * HOUR + 31 * MINUTE, 431, "ok"),
	],
};

/** The tools a server's snapshot lists, with what's enabled and the name the model sees, as the API's tools read. */
export function toolsView(server: ToolServer): ToolServerTools {
	return {
		toolServerId: server.id,
		...(server.snapshot === undefined ? {} : { hash: server.snapshot.hash, takenAt: server.snapshot.takenAt }),
		tools: (server.snapshot?.tools ?? []).map((entry) => {
			const unavailableReason = toolServerModelNameProblem(server.name, entry.name);
			return {
				...entry,
				enabled: !server.disabledTools.includes(entry.name),
				modelName: toolServerModelName(server.name, entry.name),
				...(unavailableReason === undefined ? {} : { unavailableReason }),
			};
		}),
	};
}

export interface ToolServersScenarioOptions {
	readonly servers?: readonly ToolServer[];
	readonly tokens?: readonly ToolServerToken[];
	/** Milliseconds each call takes. */
	readonly delay?: number;
	/** Reads never settle: the loading state. */
	readonly hang?: boolean;
	/** Reads fail: the error state. */
	readonly fail?: boolean;
	/** Only a server's tools fail to read. */
	readonly failTools?: boolean;
	/** Without the day's calls and latency. */
	readonly noStats?: boolean;
	/** Where Open in audit goes. Default `/audit?toolServer=<id>`. */
	readonly auditHref?: (id: string) => string;
}

/** A tunnel token's secret, shaped as the API makes one: the prefix and 32 more characters. Fake, the same each run. */
function fakeSecret(seed: number): string {
	const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let state = (2_166_136_261 ^ seed) >>> 0;
	let out = "";
	for (let index = 0; index < 32; index++) {
		state = Math.imul(state ^ (state >>> 13), 16_777_619) >>> 0;
		out += alphabet[state % alphabet.length];
	}
	return `${TUNNEL_TOKEN_PREFIX}${out}`;
}

/** A token just made, for the one-time reveal's stories. */
export function issuedToken(toolServerId: string, seed = 1): IssuedToolServerToken {
	const secret = fakeSecret(seed);
	return { token: token(`tst_new${seed}`, toolServerId, secret.slice(0, 8), FIXTURE_NOW), secret };
}

/** A server just added, with its first token, for the TokenIssued story. */
export const CREATED: CreatedToolServer = {
	server: { ...WAREHOUSE_SERVER, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW },
	token: issuedToken(WAREHOUSE_SERVER.id),
};

/**
 * An in-memory source with the page's whole flow: a server is added with its first token, tools turn on and off,
 * tokens are made and revoked, and a server is removed with its tokens. Each scenario has its own copy of the records.
 */
export function createToolServersScenario(options: ToolServersScenarioOptions = {}): ToolServersSource {
	let servers = [...(options.servers ?? SERVERS)];
	let tokens = [...(options.tokens ?? TOKENS)];
	const delay = options.delay ?? 250;
	let counter = 0;

	const wait = <T>(value: () => T, fails = options.fail === true): Promise<T> =>
		options.hang === true
			? new Promise<T>(() => {})
			: new Promise<T>((resolve, reject) =>
					setTimeout(() => {
						if (fails) {
							reject(new Error("Couldn't reach Harbour"));
							return;
						}
						try {
							resolve(value());
						} catch (error) {
							reject(error);
						}
					}, delay),
				);

	const find = (id: string): ToolServer => {
		const server = servers.find((candidate) => candidate.id === id);
		if (server === undefined) throw new Error("There's no such tool server.");
		return server;
	};
	const mint = (toolServerId: string): IssuedToolServerToken => {
		counter += 1;
		const issued = issuedToken(toolServerId, counter + 100);
		const made = { ...issued.token, id: `tst_${toolServerId}_${counter}` };
		tokens = [...tokens, made];
		return { token: made, secret: issued.secret };
	};

	const source: ToolServersSource = {
		list: (filter) =>
			wait(() =>
				servers
					.filter(
						(server) =>
							filter?.projectId === undefined ||
							server.projectId === undefined ||
							server.projectId === filter.projectId,
					)
					.sort((a, b) => a.name.localeCompare(b.name)),
			),
		create: (input) =>
			wait(() => {
				const problem = toolServerNameProblem(input.name);
				if (problem !== undefined) throw new Error(problem);
				if (servers.some((server) => server.name === input.name))
					throw new Error(`There's already a tool server called ${input.name} in ${ORGANISATION}.`);
				if (input.transport !== "tunnel") throw new Error("Only tunnel servers can be added for now.");
				counter += 1;
				const server: ToolServer = {
					id: `ts_${String(counter).padStart(2, "0")}${input.name.replace(/-/g, "")}`,
					organisationId: ORGANISATION_ID,
					...(input.projectId === undefined ? {} : { projectId: input.projectId }),
					name: input.name,
					...(input.description === undefined ? {} : { description: input.description }),
					transport: input.transport,
					disabledTools: [],
					connection: { status: "offline" },
					createdBy: TOM,
					createdAt: FIXTURE_NOW,
					updatedAt: FIXTURE_NOW,
				};
				servers = [...servers, server];
				return { server, token: mint(server.id) };
			}),
		get: (id) => wait(() => find(id)),
		tools: (id) => wait(() => toolsView(find(id)), options.fail === true || options.failTools === true),
		setToolEnabled: (id, name, enabled) =>
			wait(() => {
				const server = find(id);
				const others = server.disabledTools.filter((disabled) => disabled !== name);
				const next = { ...server, disabledTools: enabled ? others : [...others, name] };
				servers = servers.map((candidate) => (candidate.id === id ? next : candidate));
			}),
		createToken: (id) =>
			wait(() => {
				find(id);
				return mint(id);
			}),
		listTokens: (id) => wait(() => tokens.filter((candidate) => candidate.toolServerId === id)),
		revokeToken: (id, tokenId) =>
			wait(() => {
				tokens = tokens.filter((candidate) => !(candidate.toolServerId === id && candidate.id === tokenId));
			}),
		remove: (id) =>
			wait(() => {
				find(id);
				servers = servers.filter((candidate) => candidate.id !== id);
				tokens = tokens.filter((candidate) => candidate.toolServerId !== id);
			}),
		recentCalls: (id) => wait(() => CALLS[id] ?? []),
		auditHref: options.auditHref ?? ((id) => `/audit?toolServer=${encodeURIComponent(id)}`),
	};
	if (options.noStats === true) return source;
	return {
		...source,
		stats: (ids) => wait(() => Object.fromEntries(ids.map((id) => [id, STATS[id] ?? { calls24h: 0 }]))),
	};
}
