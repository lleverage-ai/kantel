// Harbour's public API: the TypeScript SDK. Generated from packages/api/src/routes.ts by
// `pnpm --filter @harbour/api generate`; don't edit it by hand. CI fails while it is stale.

// Types

export interface AbortSessionBody {
	/** Recorded in the audit trail. */
	readonly reason?: string;
}

/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
export type Actor =
	| {
			readonly kind: "human";
			readonly userId: string;
	  }
	| {
			readonly kind: "service";
			readonly serviceId: string;
			readonly keyId?: string;
	  }
	| {
			readonly kind: "agent";
			readonly agentId: string;
			readonly sessionId: string;
	  }
	| {
			readonly kind: "system";
			readonly component: string;
	  };

export interface Concept {
	readonly spaceId: string;
	/** A stable path, such as `projects/harbour/vault-binding-codes`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	/** Where a concept applies. A `job` concept is an exception for one job. */
	readonly scope: ConceptScope;
	/** What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs. */
	readonly sources: readonly string[];
	/** After this, recall marks it stale (epoch milliseconds). */
	readonly staleAfter?: number;
	/** A job exception's general concept. */
	readonly overrides?: string;
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	readonly tags: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	/** Increases with every change. */
	readonly version: number;
	readonly status: ConceptStatus;
	readonly supersededBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface ConceptPage {
	readonly items: readonly Concept[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** Where a concept applies. A `job` concept is an exception for one job. */
export type ConceptScope =
	| {
			readonly kind: "global";
	  }
	| {
			readonly kind: "project";
			readonly project: string;
	  }
	| {
			readonly kind: "job";
			readonly job: string;
	  };

export type ConceptStatus = "active" | "superseded" | "forgotten";

export interface CreateMemorySpaceBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
}

export interface CreateSessionBody {
	/** The project the session runs in. */
	readonly projectId: string;
	/** The agent profile it runs. */
	readonly agentId: string;
	readonly title?: string;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels?: Labels;
	/** An existing workspace to run in. */
	readonly workspaceId?: string;
	/** Creates a child session owned by this parent; aborting the parent aborts it. */
	readonly parentSessionId?: string;
}

export interface ImportSkillBody {
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
	readonly description: string;
	/** Every file of the package, `SKILL.md` among them. */
	readonly files: readonly SkillFile[];
	/** Where a host's adapter imported something from. */
	readonly source: SourceRef;
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
}

/** Any JSON value. */
export type JsonValue = unknown;

/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
export interface Labels {
	readonly [key: string]: string;
}

export interface ListConceptsQuery {
	readonly status?: ConceptStatus;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSessionsQuery {
	readonly projectId?: string;
	readonly agentId?: string;
	readonly status?: SessionStatus;
	readonly parentSessionId?: string;
	/** Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`. */
	readonly label?: {
		readonly [key: string]: string;
	};
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface ListSkillsQuery {
	/** Also list this project's skills. Needs the viewer role on it. */
	readonly projectId?: string;
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface MemorySearchBody {
	/** The spaces to read. */
	readonly spaceIds: readonly string[];
	readonly query: string;
	/** Default 5. */
	readonly limit?: number;
	/** Also list superseded and forgotten concepts, scoring a quarter. */
	readonly includeInactive?: boolean;
}

export interface MemorySearchHit {
	readonly concept: Concept;
	readonly score: number;
	readonly stale: boolean;
	/** The first statement line holding a term, cut to 160 characters. */
	readonly snippet: string;
}

export interface MemorySearchResult {
	readonly hits: readonly MemorySearchHit[];
}

/** A whole space's concepts at one ref of a source. */
export interface MemorySnapshot {
	readonly sourceId: string;
	readonly ref: string;
	readonly concepts: readonly SnapshotConcept[];
}

/** Where a space's snapshot came from, and when it was imported. */
export interface MemorySnapshotRef {
	readonly sourceId: string;
	readonly ref: string;
	/** Epoch milliseconds, UTC. */
	readonly importedAt: number;
}

export interface MemorySpace {
	/** The space's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	readonly name: string;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Where a space's snapshot came from, and when it was imported. */
	readonly snapshot?: MemorySnapshotRef;
}

export interface MemorySpacePage {
	readonly items: readonly MemorySpace[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** Who owns a record: an organisation, a project, a user, or the platform. */
export type OwnerRef =
	| {
			readonly kind: "platform";
	  }
	| {
			readonly kind: "organisation";
			readonly organisationId: string;
	  }
	| {
			readonly kind: "project";
			readonly organisationId: string;
			readonly projectId: string;
	  }
	| {
			readonly kind: "user";
			readonly organisationId: string;
			readonly userId: string;
	  };

export interface PageQuery {
	readonly limit?: number;
	/** A previous page's `nextCursor`. */
	readonly cursor?: string;
}

export interface Recall {
	readonly concepts: readonly Concept[];
	/** What was recalled and why, in the same order. */
	readonly manifest: readonly RecallManifestEntry[];
	/** The recall as a prompt shows it. */
	readonly text: string;
	readonly skipped: readonly {
		readonly conceptId: string;
		readonly reason: string;
	}[];
	readonly profileOmitted: readonly string[];
	readonly truncated: boolean;
}

export interface RecallBody {
	/** The spaces to read. */
	readonly spaceIds: readonly string[];
	/** The task or message text to search by. */
	readonly query: string;
	readonly scopes?: {
		readonly projects?: readonly string[];
		readonly jobs?: readonly string[];
	};
	/** Concept IDs recalled whatever the query, within their own limits. */
	readonly profile?: readonly string[];
	/** Concept IDs never recalled. */
	readonly exclude?: readonly string[];
	/** Default 5 search matches. */
	readonly maxConcepts?: number;
	/** Default 4096. */
	readonly maxBytes?: number;
	readonly maxProfileConcepts?: number;
	/** Default 24576. */
	readonly maxProfileBytes?: number;
}

export interface RecallManifestEntry {
	readonly spaceId: string;
	readonly conceptId: string;
	readonly version: number;
	readonly reason: "profile" | "search" | "exception";
	readonly score?: number;
	readonly matched?: readonly string[];
	readonly stale: boolean;
	readonly truncated: boolean;
	readonly snapshotRef?: string;
}

export interface SessionPage {
	readonly items: readonly SessionRecord[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SessionRecord {
	/** The session's ID. */
	readonly id: string;
	readonly organisationId: string;
	readonly projectId: string;
	/** The agent profile the session runs. */
	readonly agentId: string;
	readonly parentSessionId?: string;
	readonly workspaceId?: string;
	readonly title?: string;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: Labels;
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly createdBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export type SessionStatus = "idle" | "running" | "waiting" | "done" | "failed" | "cancelled";

export interface SkillFile {
	/** A relative path inside the package, such as `SKILL.md` or `scripts/run.sh`. */
	readonly path: string;
	readonly content: string;
}

/** One file of a revision, as UTF-8 text. */
export interface SkillFileContent {
	readonly path: string;
	readonly content: string;
}

export interface SkillFileQuery {
	/** The file's path in the package, such as `SKILL.md`. */
	readonly path: string;
}

/** What a session is shown of a skill: enough to decide whether to read it. */
export interface SkillListing {
	readonly skillId: string;
	readonly name: string;
	readonly description: string;
	/** The latest published revision. */
	readonly revision: number;
	/** Where a session finds it, such as `/skills/pr-review/SKILL.md`. */
	readonly path: string;
}

export interface SkillListingPage {
	readonly items: readonly SkillListing[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

export interface SkillPackage {
	/** The skill's ID. */
	readonly id: string;
	/** Who owns a record: an organisation, a project, a user, or the platform. */
	readonly owner: OwnerRef;
	/** Unique per owner: lowercase letters, digits and dashes. */
	readonly name: string;
	readonly description: string;
	/** The newest published revision. */
	readonly latestRevision?: number;
	/** Present while a draft is open. */
	readonly draftDigest?: string;
	/** Where a host's adapter imported something from. */
	readonly source?: SourceRef;
	/** Epoch milliseconds, UTC. */
	readonly createdAt: number;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

export interface SkillRevision {
	readonly skillId: string;
	/** 1, 2, 3… per skill. A published revision never changes. */
	readonly revision: number;
	/** Hex SHA-256 over the sorted paths and contents. */
	readonly digest: string;
	readonly name: string;
	readonly description: string;
	readonly files: readonly {
		readonly path: string;
		/** Bytes, UTF-8. */
		readonly size: number;
	}[];
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	/** Who acted: a person, a host app's API key, an agent or Harbour itself. */
	readonly publishedBy: Actor;
	/** Epoch milliseconds, UTC. */
	readonly publishedAt: number;
	/** Where a host's adapter imported something from. */
	readonly source?: SourceRef;
}

export interface SkillRevisionPage {
	readonly items: readonly SkillRevision[];
	/** Present when more items follow. */
	readonly nextCursor?: string;
}

/** One concept as a host's source holds it. */
export interface SnapshotConcept {
	/** A stable path, such as `projects/harbour/vault-binding-codes`. */
	readonly id: string;
	readonly title: string;
	readonly description?: string;
	/** The fact itself, short. */
	readonly statement: string;
	/** Where a concept applies. A `job` concept is an exception for one job. */
	readonly scope: ConceptScope;
	/** What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs. */
	readonly sources: readonly string[];
	/** After this, recall marks it stale (epoch milliseconds). */
	readonly staleAfter?: number;
	/** A job exception's general concept. */
	readonly overrides?: string;
	/** Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`. */
	readonly extensions?: {
		readonly [key: string]: JsonValue;
	};
	readonly tags?: readonly string[];
	/** `owner`: set by the space's owner. `learned`: from an approved agent proposal. */
	readonly setBy: "owner" | "learned";
	readonly status: ConceptStatus;
	readonly supersededBy?: string;
	/** Epoch milliseconds, UTC. */
	readonly updatedAt: number;
}

/** Where a host's adapter imported something from. */
export interface SourceRef {
	/** The host's skill or memory source, such as `sal-skills`. */
	readonly sourceId: string;
	/** Its ref: a commit or a version. */
	readonly ref: string;
}

// Runtime

// The SDK's runtime, copied into `generated/sdk.ts` as it is, so the SDK is one file with no imports. Keep it free of
// imports and of anything but `fetch`.

export interface HarbourClientOptions {
	/** The API's base URL with its version, such as `https://harbour.example/v1`, or `/v1` on the same origin. */
	readonly baseUrl: string;
	/**
	 * The bearer for every call: a host app's API key (`hbr_…`), or a function that gives one per call. Absent when the
	 * browser is signed in another way, such as Cloudflare Access's cookie.
	 */
	readonly token?: string | (() => string | undefined | Promise<string | undefined>);
	/** More headers for every call. */
	readonly headers?: () => { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	/** Default the global `fetch`. */
	readonly fetch?: typeof fetch;
}

/** Per call. */
export interface CallOptions {
	readonly signal?: AbortSignal;
	/** Sent as `harbour-request-id`, which correlates the call in Harbour's audit trail. */
	readonly requestId?: string;
	readonly headers?: { readonly [name: string]: string };
}

/** An error Harbour answered with: its HarbourError code (or `unauthenticated`), message and HTTP status. */
export class HarbourApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: { readonly [key: string]: unknown };
	constructor(status: number, code: string, message: string, details?: { readonly [key: string]: unknown }) {
		super(message);
		this.name = "HarbourApiError";
		this.status = status;
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

/** One call, as the generated methods describe it. */
export interface ApiCall {
	readonly method: string;
	/** Relative to the base URL, with path parameters already encoded. */
	readonly path: string;
	/** Query parameters; a record value, such as `label`, is sent as `label.<key>=<value>`. */
	readonly query?: object;
	readonly body?: unknown;
	readonly headers?: { readonly [name: string]: string | undefined };
}

const queryString = (query: object | undefined): string => {
	if (query === undefined) return "";
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			// A record, such as `label`: `label.<key>=<value>`.
			for (const [key, item] of Object.entries(value as { [key: string]: unknown })) {
				if (item !== undefined) params.append(`${name}.${key}`, String(item));
			}
		} else params.append(name, String(value));
	}
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
};

async function errorOf(response: Response): Promise<HarbourApiError> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
	const code =
		typeof error?.code === "string" ? error.code : response.status === 401 ? "unauthenticated" : "unavailable";
	const message = typeof error?.message === "string" ? error.message : `Harbour answered ${response.status}`;
	const details =
		typeof error?.details === "object" && error.details !== null
			? (error.details as { [key: string]: unknown })
			: undefined;
	return new HarbourApiError(response.status, code, message, details);
}

/** Sends one call and reads its JSON answer; a 204 resolves undefined. Rejects with a `HarbourApiError`. */
export async function send<T>(options: HarbourClientOptions, call: ApiCall, callOptions: CallOptions = {}): Promise<T> {
	const headers: { [name: string]: string } = { accept: "application/json" };
	Object.assign(headers, (await options.headers?.()) ?? {});
	const token = typeof options.token === "function" ? await options.token() : options.token;
	if (token !== undefined) headers.authorization = `Bearer ${token}`;
	if (call.body !== undefined) headers["content-type"] = "application/json";
	if (callOptions.requestId !== undefined) headers["harbour-request-id"] = callOptions.requestId;
	for (const [name, value] of Object.entries(call.headers ?? {})) if (value !== undefined) headers[name] = value;
	Object.assign(headers, callOptions.headers ?? {});
	const doFetch = options.fetch ?? fetch;
	const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}${call.path}${queryString(call.query)}`, {
		method: call.method,
		headers,
		...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
		...(callOptions.signal === undefined ? {} : { signal: callOptions.signal }),
	});
	if (!response.ok) throw await errorOf(response);
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

// Client

/** Harbour's public API, one method per route. */
export interface HarbourClient {
	/** Create a session. Starts a session of an agent profile in a project. Needs the operator role on the project. `POST /sessions` */
	createSession(body: CreateSessionBody, options?: CallOptions): Promise<SessionRecord>;
	/** List sessions. The sessions the caller may see, newest first, a page at a time. `GET /sessions` */
	listSessions(query?: ListSessionsQuery, options?: CallOptions): Promise<SessionPage>;
	/** Get a session. `GET /sessions/{sessionId}` */
	getSession(sessionId: string, options?: CallOptions): Promise<SessionRecord>;
	/** Close a session. Ends the session for good: its sandbox leases, browser sessions and grants end. Closing a closed session does nothing. `POST /sessions/{sessionId}/close` */
	closeSession(sessionId: string, options?: CallOptions): Promise<void>;
	/** Abort a session's run. Stops what the session is doing now. The session stays open and takes new messages. `POST /sessions/{sessionId}/abort` */
	abortSession(sessionId: string, body?: AbortSessionBody, options?: CallOptions): Promise<void>;
	/** List skills. The published skills the caller sees, by name: the platform's, the organisation's, the project's named by `projectId` and, for a person, their own. Never another project's or another person's. `GET /skills` */
	listSkills(query?: ListSkillsQuery, options?: CallOptions): Promise<SkillListingPage>;
	/** Get a skill. `GET /skills/{skillId}` */
	getSkill(skillId: string, options?: CallOptions): Promise<SkillPackage>;
	/** List a skill's revisions. `GET /skills/{skillId}/revisions` */
	listSkillRevisions(skillId: string, query?: PageQuery, options?: CallOptions): Promise<SkillRevisionPage>;
	/** Get a revision. A published revision: its digest, its files' paths and sizes, who published it and where it came from. `GET /skills/{skillId}/revisions/{revision}` */
	getSkillRevision(skillId: string, revision: string, options?: CallOptions): Promise<SkillRevision>;
	/** Read a file of a revision. One file of a published revision, such as its `SKILL.md`, by its path in the package. `GET /skills/{skillId}/revisions/{revision}/file` */
	readSkillFile(
		skillId: string,
		revision: string,
		query: SkillFileQuery,
		options?: CallOptions,
	): Promise<SkillFileContent>;
	/** Import a skill from a host's source. A host adapter's publish path: creates the skill if needed and publishes the files as its next revision, once per `source` (`sourceId` and `ref`); files identical to the latest revision publish nothing. People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role. `POST /skills/import` */
	importSkill(body: ImportSkillBody, options?: CallOptions): Promise<SkillRevision>;
	/** List memory spaces. The spaces the caller may read, oldest first: the organisation's, a project's to those who may view it, and a person's own. A person never sees another person's space. `GET /memory/spaces` */
	listMemorySpaces(query?: PageQuery, options?: CallOptions): Promise<MemorySpacePage>;
	/** Create a memory space. People and API keys only, never an agent; a deployment may ask for more, such as the organisation's admin role. `POST /memory/spaces` */
	createMemorySpace(body: CreateMemorySpaceBody, options?: CallOptions): Promise<MemorySpace>;
	/** List a space's concepts. By ID, every status unless `status` names one. `GET /memory/spaces/{spaceId}/concepts` */
	listConcepts(spaceId: string, query?: ListConceptsQuery, options?: CallOptions): Promise<ConceptPage>;
	/** Get a concept. `GET /memory/spaces/{spaceId}/concepts/{conceptId}` */
	getConcept(spaceId: string, conceptId: string, options?: CallOptions): Promise<Concept>;
	/** Search memory. Keyword search over the named spaces' concepts, best first, as a person browsing them would. `POST /memory/search` */
	searchMemory(body: MemorySearchBody, options?: CallOptions): Promise<MemorySearchResult>;
	/** Recall memory for a task. What a session would be given for this query: the profile, the best matches (BM25) and their exceptions, rendered, with a manifest of what was recalled and why. `POST /memory/recall` */
	recallMemory(body: RecallBody, options?: CallOptions): Promise<Recall>;
	/** Load a snapshot into a space. A host adapter's load path: the space's concepts become the snapshot's, recorded with its source and ref, so every recall names what it read. People and API keys only; a deployment may ask for more. `POST /memory/spaces/{spaceId}/snapshot` */
	importMemorySnapshot(spaceId: string, body: MemorySnapshot, options?: CallOptions): Promise<MemorySpace>;
}

/** A client for Harbour's public API over `fetch`. */
export function createHarbourClient(options: HarbourClientOptions): HarbourClient {
	return {
		createSession: (body, callOptions) => send(options, { method: "POST", path: "/sessions", body }, callOptions),
		listSessions: (query, callOptions) => send(options, { method: "GET", path: "/sessions", query }, callOptions),
		getSession: (sessionId, callOptions) =>
			send(options, { method: "GET", path: `/sessions/${encodeURIComponent(sessionId)}` }, callOptions),
		closeSession: (sessionId, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/close` }, callOptions),
		abortSession: (sessionId, body = {}, callOptions) =>
			send(options, { method: "POST", path: `/sessions/${encodeURIComponent(sessionId)}/abort`, body }, callOptions),
		listSkills: (query, callOptions) => send(options, { method: "GET", path: "/skills", query }, callOptions),
		getSkill: (skillId, callOptions) =>
			send(options, { method: "GET", path: `/skills/${encodeURIComponent(skillId)}` }, callOptions),
		listSkillRevisions: (skillId, query, callOptions) =>
			send(options, { method: "GET", path: `/skills/${encodeURIComponent(skillId)}/revisions`, query }, callOptions),
		getSkillRevision: (skillId, revision, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revision)}` },
				callOptions,
			),
		readSkillFile: (skillId, revision, query, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revision)}/file`,
					query,
				},
				callOptions,
			),
		importSkill: (body, callOptions) => send(options, { method: "POST", path: "/skills/import", body }, callOptions),
		listMemorySpaces: (query, callOptions) =>
			send(options, { method: "GET", path: "/memory/spaces", query }, callOptions),
		createMemorySpace: (body, callOptions) =>
			send(options, { method: "POST", path: "/memory/spaces", body }, callOptions),
		listConcepts: (spaceId, query, callOptions) =>
			send(
				options,
				{ method: "GET", path: `/memory/spaces/${encodeURIComponent(spaceId)}/concepts`, query },
				callOptions,
			),
		getConcept: (spaceId, conceptId, callOptions) =>
			send(
				options,
				{
					method: "GET",
					path: `/memory/spaces/${encodeURIComponent(spaceId)}/concepts/${encodeURIComponent(conceptId)}`,
				},
				callOptions,
			),
		searchMemory: (body, callOptions) => send(options, { method: "POST", path: "/memory/search", body }, callOptions),
		recallMemory: (body, callOptions) => send(options, { method: "POST", path: "/memory/recall", body }, callOptions),
		importMemorySnapshot: (spaceId, body, callOptions) =>
			send(
				options,
				{ method: "POST", path: `/memory/spaces/${encodeURIComponent(spaceId)}/snapshot`, body },
				callOptions,
			),
	};
}
