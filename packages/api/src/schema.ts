/**
 * The public API's wire shapes as JSON Schema (TypeBox), each mirroring a type in `@harbour/contracts`. A schema with a
 * `title` is a named type: a component in the OpenAPI document and a named type in the SDK. `test/types.test.ts`
 * checks at compile time that each schema's static type and its contract type match, so the two can't drift.
 */
import Type from "typebox";

const id = (description: string) => Type.String({ minLength: 1, description });

export const Timestamp = Type.Integer({ description: "Epoch milliseconds, UTC." });

export const SessionStatus = Type.Union(
	[
		Type.Literal("idle"),
		Type.Literal("running"),
		Type.Literal("waiting"),
		Type.Literal("done"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	],
	{ title: "SessionStatus" },
);

export const Labels = Type.Record(Type.String(), Type.String(), {
	title: "Labels",
	description: 'Host labels, such as `{ docketTask: "TASK-3347" }`.',
});

export const Actor = Type.Union(
	[
		Type.Object({ kind: Type.Literal("human"), userId: Type.String() }),
		Type.Object({ kind: Type.Literal("service"), serviceId: Type.String(), keyId: Type.Optional(Type.String()) }),
		Type.Object({ kind: Type.Literal("agent"), agentId: Type.String(), sessionId: Type.String() }),
		Type.Object({ kind: Type.Literal("system"), component: Type.String() }),
	],
	{ title: "Actor", description: "Who acted: a person, a host app's API key, an agent or Harbour itself." },
);

export const SessionRecord = Type.Object(
	{
		id: id("The session's ID."),
		organisationId: Type.String(),
		projectId: Type.String(),
		agentId: Type.String({ description: "The agent profile the session runs." }),
		parentSessionId: Type.Optional(Type.String()),
		workspaceId: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		status: SessionStatus,
		labels: Labels,
		createdBy: Actor,
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "SessionRecord" },
);

export const CreateSessionBody = Type.Object(
	{
		projectId: id("The project the session runs in."),
		agentId: id("The agent profile it runs."),
		title: Type.Optional(Type.String()),
		labels: Type.Optional(Labels),
		workspaceId: Type.Optional(Type.String({ description: "An existing workspace to run in." })),
		parentSessionId: Type.Optional(
			Type.String({ description: "Creates a child session owned by this parent; aborting the parent aborts it." }),
		),
	},
	{ title: "CreateSessionBody" },
);

export const SessionPage = Type.Object(
	{
		items: Type.Array(SessionRecord),
		nextCursor: Type.Optional(Type.String({ description: "Present when more items follow." })),
	},
	{ title: "SessionPage" },
);

export const ListSessionsQuery = Type.Object(
	{
		projectId: Type.Optional(Type.String()),
		agentId: Type.Optional(Type.String()),
		status: Type.Optional(SessionStatus),
		parentSessionId: Type.Optional(Type.String()),
		label: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description:
					"Sessions with every one of these labels, each sent as `label.<key>=<value>`, such as `label.docketTask=TASK-3347`.",
			}),
		),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		cursor: Type.Optional(Type.String({ description: "A previous page's `nextCursor`." })),
	},
	{ title: "ListSessionsQuery" },
);

export const AbortSessionBody = Type.Object(
	{ reason: Type.Optional(Type.String({ description: "Recorded in the audit trail." })) },
	{ title: "AbortSessionBody" },
);

export const SessionPath = Type.Object({ sessionId: id("The session's ID.") });

export const ErrorCode = Type.Union(
	[
		Type.Literal("invalid"),
		Type.Literal("not_found"),
		Type.Literal("forbidden"),
		Type.Literal("conflict"),
		Type.Literal("expired"),
		Type.Literal("refused"),
		Type.Literal("exhausted"),
		Type.Literal("aborted"),
		Type.Literal("not_supported"),
		Type.Literal("unavailable"),
		Type.Literal("unauthenticated"),
	],
	{ title: "ErrorCode" },
);

export const ErrorBody = Type.Object(
	{
		error: Type.Object({
			code: ErrorCode,
			message: Type.String(),
			details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
	},
	{ title: "ErrorBody", description: "Every error: the HarbourError's code and message." },
);

/**
 * Any JSON value: a host's namespaced `extensions`, which Harbour keeps and doesn't read. Its static type is `unknown`
 * rather than the contracts' recursive `JsonValue`, which the router's read-only mapping can't unfold.
 */
export const JsonValue = Type.Unknown({ title: "JsonValue", description: "Any JSON value." });

const Extensions = Type.Record(Type.String(), JsonValue, {
	description: "Namespaced host data Harbour keeps but doesn't read, such as Lleverage's `lleverage.workflows`.",
});

export const OwnerRef = Type.Union(
	[
		Type.Object({ kind: Type.Literal("platform") }),
		Type.Object({ kind: Type.Literal("organisation"), organisationId: Type.String() }),
		Type.Object({ kind: Type.Literal("project"), organisationId: Type.String(), projectId: Type.String() }),
		Type.Object({ kind: Type.Literal("user"), organisationId: Type.String(), userId: Type.String() }),
	],
	{ title: "OwnerRef", description: "Who owns a record: an organisation, a project, a user, or the platform." },
);

const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500 }));
const cursor = Type.Optional(Type.String({ description: "A previous page's `nextCursor`." }));
const nextCursor = Type.Optional(Type.String({ description: "Present when more items follow." }));

export const PageQuery = Type.Object({ limit, cursor }, { title: "PageQuery" });

// Skills (#12): Agent Skills packages and their immutable revisions.

const SourceRef = Type.Object(
	{
		sourceId: Type.String({ description: "The host's skill or memory source, such as `sal-skills`." }),
		ref: Type.String({ description: "Its ref: a commit or a version." }),
	},
	{ title: "SourceRef", description: "Where a host's adapter imported something from." },
);

export const SkillFile = Type.Object(
	{
		path: Type.String({ description: "A relative path inside the package, such as `SKILL.md` or `scripts/run.sh`." }),
		content: Type.String(),
	},
	{ title: "SkillFile" },
);

export const SkillPackage = Type.Object(
	{
		id: id("The skill's ID."),
		owner: OwnerRef,
		name: Type.String({ description: "Unique per owner: lowercase letters, digits and dashes." }),
		description: Type.String(),
		latestRevision: Type.Optional(Type.Integer({ description: "The newest published revision." })),
		draftDigest: Type.Optional(Type.String({ description: "Present while a draft is open." })),
		source: Type.Optional(SourceRef),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	},
	{ title: "SkillPackage" },
);

export const SkillRevision = Type.Object(
	{
		skillId: Type.String(),
		revision: Type.Integer({ minimum: 1, description: "1, 2, 3… per skill. A published revision never changes." }),
		digest: Type.String({ description: "Hex SHA-256 over the sorted paths and contents." }),
		name: Type.String(),
		description: Type.String(),
		files: Type.Array(Type.Object({ path: Type.String(), size: Type.Integer({ description: "Bytes, UTF-8." }) })),
		extensions: Type.Optional(Extensions),
		publishedBy: Actor,
		publishedAt: Timestamp,
		source: Type.Optional(SourceRef),
	},
	{ title: "SkillRevision" },
);

export const SkillListing = Type.Object(
	{
		skillId: Type.String(),
		name: Type.String(),
		description: Type.String(),
		revision: Type.Integer({ description: "The latest published revision." }),
		path: Type.String({ description: "Where a session finds it, such as `/skills/pr-review/SKILL.md`." }),
	},
	{ title: "SkillListing", description: "What a session is shown of a skill: enough to decide whether to read it." },
);

export const SkillListingPage = Type.Object(
	{ items: Type.Array(SkillListing), nextCursor },
	{ title: "SkillListingPage" },
);

export const SkillRevisionPage = Type.Object(
	{ items: Type.Array(SkillRevision), nextCursor },
	{ title: "SkillRevisionPage" },
);

export const ListSkillsQuery = Type.Object(
	{
		projectId: Type.Optional(
			Type.String({ description: "Also list this project's skills. Needs the viewer role on it." }),
		),
		limit,
		cursor,
	},
	{ title: "ListSkillsQuery" },
);

export const SkillPath = Type.Object({ skillId: id("The skill's ID.") });

export const SkillRevisionPath = Type.Object({
	skillId: id("The skill's ID."),
	revision: Type.String({ pattern: "^[1-9][0-9]{0,8}$", description: "The revision number." }),
});

export const SkillFileQuery = Type.Object(
	{ path: Type.String({ minLength: 1, description: "The file's path in the package, such as `SKILL.md`." }) },
	{ title: "SkillFileQuery" },
);

export const SkillFileContent = Type.Object(
	{ path: Type.String(), content: Type.String() },
	{ title: "SkillFileContent", description: "One file of a revision, as UTF-8 text." },
);

export const ImportSkillBody = Type.Object(
	{
		owner: OwnerRef,
		name: Type.String({ minLength: 1 }),
		description: Type.String({ minLength: 1 }),
		files: Type.Array(SkillFile, { description: "Every file of the package, `SKILL.md` among them." }),
		source: SourceRef,
		extensions: Type.Optional(Extensions),
	},
	{ title: "ImportSkillBody" },
);

// Memory (#12): spaces of curated concepts, read by search and recall.

export const MemorySnapshotRef = Type.Object(
	{ sourceId: Type.String(), ref: Type.String(), importedAt: Timestamp },
	{ title: "MemorySnapshotRef", description: "Where a space's snapshot came from, and when it was imported." },
);

export const MemorySpace = Type.Object(
	{
		id: id("The space's ID."),
		owner: OwnerRef,
		name: Type.String(),
		createdAt: Timestamp,
		snapshot: Type.Optional(MemorySnapshotRef),
	},
	{ title: "MemorySpace" },
);

export const MemorySpacePage = Type.Object(
	{ items: Type.Array(MemorySpace), nextCursor },
	{ title: "MemorySpacePage" },
);

export const CreateMemorySpaceBody = Type.Object(
	{ owner: OwnerRef, name: Type.String({ minLength: 1 }) },
	{ title: "CreateMemorySpaceBody" },
);

export const ConceptScope = Type.Union(
	[
		Type.Object({ kind: Type.Literal("global") }),
		Type.Object({ kind: Type.Literal("project"), project: Type.String() }),
		Type.Object({ kind: Type.Literal("job"), job: Type.String() }),
	],
	{ title: "ConceptScope", description: "Where a concept applies. A `job` concept is an exception for one job." },
);

export const ConceptStatus = Type.Union(
	[Type.Literal("active"), Type.Literal("superseded"), Type.Literal("forgotten")],
	{ title: "ConceptStatus" },
);

const SetBy = Type.Union([Type.Literal("owner"), Type.Literal("learned")], {
	description: "`owner`: set by the space's owner. `learned`: from an approved agent proposal.",
});

const conceptFields = {
	id: Type.String({ minLength: 1, description: "A stable path, such as `projects/harbour/vault-binding-codes`." }),
	title: Type.String(),
	description: Type.Optional(Type.String()),
	statement: Type.String({ description: "The fact itself, short." }),
	scope: ConceptScope,
	sources: Type.Array(Type.String(), {
		description: "What backs it: URLs, `owner/repo@commit:path:lines`, ticket IDs.",
	}),
	staleAfter: Type.Optional(Type.Integer({ description: "After this, recall marks it stale (epoch milliseconds)." })),
	overrides: Type.Optional(Type.String({ description: "A job exception's general concept." })),
	extensions: Type.Optional(Extensions),
};

export const Concept = Type.Object(
	{
		spaceId: Type.String(),
		...conceptFields,
		tags: Type.Array(Type.String()),
		setBy: SetBy,
		version: Type.Integer({ description: "Increases with every change." }),
		status: ConceptStatus,
		supersededBy: Type.Optional(Type.String()),
		updatedAt: Timestamp,
	},
	{ title: "Concept" },
);

export const ConceptPage = Type.Object({ items: Type.Array(Concept), nextCursor }, { title: "ConceptPage" });

export const ListConceptsQuery = Type.Object(
	{ status: Type.Optional(ConceptStatus), limit, cursor },
	{ title: "ListConceptsQuery" },
);

export const MemorySpacePath = Type.Object({ spaceId: id("The space's ID.") });

export const ConceptPath = Type.Object({
	spaceId: id("The space's ID."),
	conceptId: id("The concept's ID, its slashes encoded (`projects%2Fharbour%2Fregion`)."),
});

export const SnapshotConcept = Type.Object(
	{
		...conceptFields,
		tags: Type.Optional(Type.Array(Type.String())),
		setBy: SetBy,
		status: ConceptStatus,
		supersededBy: Type.Optional(Type.String()),
		updatedAt: Timestamp,
	},
	{ title: "SnapshotConcept", description: "One concept as a host's source holds it." },
);

export const MemorySnapshot = Type.Object(
	{
		sourceId: Type.String({ minLength: 1 }),
		ref: Type.String({ minLength: 1 }),
		concepts: Type.Array(SnapshotConcept),
	},
	{ title: "MemorySnapshot", description: "A whole space's concepts at one ref of a source." },
);

const spaceIds = Type.Array(Type.String(), { minItems: 1, description: "The spaces to read." });

export const MemorySearchBody = Type.Object(
	{
		spaceIds,
		query: Type.String(),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Default 5." })),
		includeInactive: Type.Optional(
			Type.Boolean({ description: "Also list superseded and forgotten concepts, scoring a quarter." }),
		),
	},
	{ title: "MemorySearchBody" },
);

export const MemorySearchHit = Type.Object(
	{
		concept: Concept,
		score: Type.Number(),
		stale: Type.Boolean(),
		snippet: Type.String({ description: "The first statement line holding a term, cut to 160 characters." }),
	},
	{ title: "MemorySearchHit" },
);

export const MemorySearchResult = Type.Object({ hits: Type.Array(MemorySearchHit) }, { title: "MemorySearchResult" });

export const RecallBody = Type.Object(
	{
		spaceIds,
		query: Type.String({ description: "The task or message text to search by." }),
		scopes: Type.Optional(
			Type.Object({
				projects: Type.Optional(Type.Array(Type.String())),
				jobs: Type.Optional(Type.Array(Type.String())),
			}),
		),
		profile: Type.Optional(
			Type.Array(Type.String(), { description: "Concept IDs recalled whatever the query, within their own limits." }),
		),
		exclude: Type.Optional(Type.Array(Type.String(), { description: "Concept IDs never recalled." })),
		maxConcepts: Type.Optional(Type.Integer({ minimum: 0, description: "Default 5 search matches." })),
		maxBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Default 4096." })),
		maxProfileConcepts: Type.Optional(Type.Integer({ minimum: 0 })),
		maxProfileBytes: Type.Optional(Type.Integer({ minimum: 0, description: "Default 24576." })),
	},
	{ title: "RecallBody" },
);

export const RecallManifestEntry = Type.Object(
	{
		spaceId: Type.String(),
		conceptId: Type.String(),
		version: Type.Integer(),
		reason: Type.Union([Type.Literal("profile"), Type.Literal("search"), Type.Literal("exception")]),
		score: Type.Optional(Type.Number()),
		matched: Type.Optional(Type.Array(Type.String())),
		stale: Type.Boolean(),
		truncated: Type.Boolean(),
		snapshotRef: Type.Optional(Type.String()),
	},
	{ title: "RecallManifestEntry" },
);

export const Recall = Type.Object(
	{
		concepts: Type.Array(Concept),
		manifest: Type.Array(RecallManifestEntry, { description: "What was recalled and why, in the same order." }),
		text: Type.String({ description: "The recall as a prompt shows it." }),
		skipped: Type.Array(Type.Object({ conceptId: Type.String(), reason: Type.String() })),
		profileOmitted: Type.Array(Type.String()),
		truncated: Type.Boolean(),
	},
	{ title: "Recall" },
);
