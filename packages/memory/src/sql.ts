/**
 * The durable `Memory`, on any `SqlDriver`: Postgres for the self-hosted target, D1 (or a Durable Object's SQLite) for
 * Cloudflare. It behaves as the in-memory memory in `./memory.ts` does, through the same rules (`./rules.ts`), and
 * passes the same suite.
 *
 * - Rows hold spaces (with the snapshot each was last imported from), concepts and proposals; a concept or proposal
 *   is one JSON column beside the columns it is looked up by. A concept a snapshot drops stays as a row that is no
 *   longer `held`, so its ID keeps the highest version it has had.
 * - Every change to a space's concepts or proposals' outcomes is one batch that first claims the space's next
 *   generation in `memory_space_writes` (`ON CONFLICT DO NOTHING`; its key is the space and the generation). Every
 *   other statement in the batch runs only if this writer's claim landed, so of two writers that read the same
 *   generation exactly one changes anything, and the other re-reads and tries again. That is the in-memory memory's
 *   one writer per space, across processes.
 * - Recall and search build Sal's in-process index (`./recall.ts`) from the named spaces' concepts, cached until a
 *   space's generation moves on, so the same query gives the same recall as the in-memory memory and a restart loses
 *   nothing but the cache.
 * - Lists bind as one JSON parameter, so no statement meets D1's 100-parameter cap.
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	type Concept,
	HarbourError,
	type Memory,
	type MemoryAuthority,
	type MemoryProposal,
	type MemorySpace,
	type OwnerRef,
	type ParaphraseCheck,
	type ProjectAccess,
	type RecallRenderer,
	systemClock,
} from "@harbour/contracts";
import { type SqlDialect, type SqlDriver, type SqlStatement, sql, sqlNumber, sqlOptionalString } from "@harbour/sql";
import { createRecallCorpus, defaultRecallRenderer, type RecallCorpus, recallFrom, searchFrom } from "./recall.ts";
import {
	applyWrite,
	assertOutcome,
	assertPending,
	assertRecallRequest,
	assertSearchRequest,
	assertSnapshot,
	authorityOf,
	bundleOf,
	byId,
	checkCreateSpace,
	checkWrite,
	decided,
	findDuplicate,
	forbidAgent,
	memoryAudit,
	paginate,
	proposalFor,
	recallCorpusOf,
	requireSpace,
	requireWrite,
	type SpaceState,
	snapshotConcepts,
} from "./rules.ts";

export interface SqlMemoryOptions {
	readonly driver: SqlDriver;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** As for the in-memory memory; every target passes one. */
	readonly access?: ProjectAccess;
	/** As for the in-memory memory: the role each write needs. Default `DEFAULT_MEMORY_AUTHORITY`. */
	readonly authority?: MemoryAuthority;
	/** As for the in-memory memory: a host's paraphrase check. */
	readonly paraphrase?: ParaphraseCheck;
	/** How recall renders its text and counts its byte budgets. Default `defaultRecallRenderer`. */
	readonly renderer?: RecallRenderer;
}

/** The tables and indexes, for `migrateMemory` or a target's own migrations. Every statement is idempotent. */
export function memorySchema(dialect: SqlDialect): readonly string[] {
	const key = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS memory_spaces (
			id TEXT PRIMARY KEY,
			organisation_id TEXT NOT NULL,
			owner TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at ${time} NOT NULL,
			snapshot_source_id TEXT,
			snapshot_ref TEXT,
			snapshot_imported_at ${time},
			imports INTEGER NOT NULL DEFAULT 0,
			generation INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS memory_space_writes (
			space_id TEXT NOT NULL,
			generation INTEGER NOT NULL,
			writer TEXT NOT NULL,
			PRIMARY KEY (space_id, generation)
		)`,
		`CREATE TABLE IF NOT EXISTS memory_concepts (
			space_id TEXT NOT NULL,
			id TEXT NOT NULL,
			version INTEGER NOT NULL,
			held INTEGER NOT NULL,
			status TEXT NOT NULL,
			concept TEXT NOT NULL,
			PRIMARY KEY (space_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS memory_proposals (
			seq ${key},
			id TEXT NOT NULL UNIQUE,
			organisation_id TEXT NOT NULL,
			space_id TEXT NOT NULL,
			status TEXT NOT NULL,
			proposal TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS memory_proposals_by_space ON memory_proposals (space_id, seq)",
	];
}

/** Creates the memory tables if they are missing. */
export async function migrateMemory(driver: SqlDriver): Promise<void> {
	await driver.batch(memorySchema(driver.dialect).map((text) => ({ sql: text })));
}

interface SpaceRow {
	readonly [column: string]: unknown;
	readonly id: unknown;
	readonly organisation_id: unknown;
	readonly owner: unknown;
	readonly name: unknown;
	readonly created_at: unknown;
	readonly snapshot_source_id: unknown;
	readonly snapshot_ref: unknown;
	readonly snapshot_imported_at: unknown;
	readonly imports: unknown;
	readonly generation: unknown;
}

/** A space as one generation of it was read. */
interface LoadedSpace {
	readonly organisationId: string;
	readonly space: MemorySpace;
	readonly imports: number;
	readonly generation: number;
}

const SPACE_COLUMNS =
	"id, organisation_id, owner, name, created_at, snapshot_source_id, snapshot_ref, snapshot_imported_at, imports, generation";

/** Writes one change attempts before giving up on a race it keeps losing. */
const MAX_ATTEMPTS = 16;
/** Concepts per statement in a snapshot import, so one bound parameter stays small. */
const CONCEPTS_PER_STATEMENT = 50;

function spaceFrom(row: SpaceRow): LoadedSpace {
	const sourceId = sqlOptionalString(row.snapshot_source_id);
	const space: MemorySpace = {
		id: String(row.id),
		owner: JSON.parse(String(row.owner)) as OwnerRef,
		name: String(row.name),
		createdAt: sqlNumber(row.created_at),
		...(sourceId === undefined
			? {}
			: {
					snapshot: {
						sourceId,
						ref: String(row.snapshot_ref),
						importedAt: sqlNumber(row.snapshot_imported_at),
					},
				}),
	};
	return {
		organisationId: String(row.organisation_id),
		space,
		imports: sqlNumber(row.imports),
		generation: sqlNumber(row.generation),
	};
}

/** `column` is one of the strings in the JSON list bound as one parameter. */
function inJsonList(dialect: SqlDialect, column: string): string {
	return dialect === "postgres"
		? `${column} IN (SELECT jsonb_array_elements_text(CAST(? AS jsonb)))`
		: `${column} IN (SELECT value FROM json_each(?))`;
}

/** The rows of a JSON list of `{ id, version, status, concept }` bound as one parameter. */
function jsonConcepts(dialect: SqlDialect): string {
	return dialect === "postgres"
		? `SELECT ?, e->>'id', CAST(e->>'version' AS INTEGER), 1, e->>'status', e->>'concept'
			FROM jsonb_array_elements(CAST(? AS jsonb)) AS e`
		: `SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.version'), 1, json_extract(value, '$.status'),
			json_extract(value, '$.concept') FROM json_each(?)`;
}

const UPSERT_CONCEPT =
	"ON CONFLICT (space_id, id) DO UPDATE SET version = excluded.version, held = excluded.held, status = excluded.status, concept = excluded.concept";

/**
 * The durable `Memory`. Call `migrateMemory(driver)` (or run `memorySchema`) once before using it. Every process
 * sharing the database sees the same spaces, and a restart keeps snapshots, concepts and proposals.
 */
export function createSqlMemory(options: SqlMemoryOptions): Memory {
	const { driver } = options;
	const clock = options.clock ?? systemClock;
	const access = options.access;
	const authority = authorityOf(options.authority);
	const audits = memoryAudit(options.audit, clock);
	const renderer = options.renderer ?? defaultRecallRenderer;
	/** The last recall index built, keyed by its spaces and their generations. */
	let cached: { readonly key: string; readonly corpus: RecallCorpus } | undefined;

	async function spaceFor(ctx: CallContext, spaceId: string): Promise<LoadedSpace> {
		const [row] =
			typeof spaceId === "string"
				? await driver.query<SpaceRow>(`SELECT ${SPACE_COLUMNS} FROM memory_spaces WHERE id = ?`, [spaceId])
				: [];
		const loaded = row === undefined ? undefined : spaceFrom(row);
		if (loaded === undefined || loaded.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No memory space ${spaceId}`);
		}
		return loaded;
	}

	/** Every concept the space holds, and every version an ID has had in it. */
	async function stateOf(spaceId: string): Promise<SpaceState> {
		const rows = await driver.query<{ id: unknown; version: unknown; held: unknown; concept: unknown }>(
			"SELECT id, version, held, concept FROM memory_concepts WHERE space_id = ?",
			[spaceId],
		);
		const concepts = new Map<string, Concept>();
		const versions = new Map<string, number>();
		for (const row of rows) {
			versions.set(String(row.id), sqlNumber(row.version));
			if (sqlNumber(row.held) === 1) concepts.set(String(row.id), JSON.parse(String(row.concept)) as Concept);
		}
		return { spaceId, concepts, versions };
	}

	async function heldConcepts(spaceId: string, status?: Concept["status"]): Promise<Concept[]> {
		const rows = await driver.query<{ concept: unknown }>(
			`SELECT concept FROM memory_concepts WHERE space_id = ? AND held = 1${status === undefined ? "" : " AND status = ?"}`,
			status === undefined ? [spaceId] : [spaceId, status],
		);
		return rows.map((row) => JSON.parse(String(row.concept)) as Concept).sort(byId);
	}

	/** Finds every named space before checking any, so a foreign one is `not_found` whatever its place. */
	async function readableSpaces(ctx: CallContext, spaceIds: readonly string[], operation: string) {
		if (!Array.isArray(spaceIds)) throw new HarbourError("invalid", "spaceIds must be a list");
		const named: LoadedSpace[] = [];
		for (const spaceId of new Set(spaceIds)) named.push(await spaceFor(ctx, spaceId));
		for (const loaded of named) await requireSpace(access, ctx, loaded.space, "viewer", operation);
		return named;
	}

	/**
	 * Every concept of the spaces, any status, by ID then space, indexed for recall and search. The spaces and their
	 * concepts are read in one statement, so the snapshot a manifest names is the one its concepts came from even when
	 * an import lands meanwhile, and the index is cached under the generations it was read at.
	 */
	async function corpusFor(named: readonly LoadedSpace[]): Promise<RecallCorpus> {
		const keyOf = (spaces: readonly LoadedSpace[]) =>
			spaces.map((loaded) => `${loaded.space.id}:${loaded.generation}`).join("\u0000");
		if (cached?.key === keyOf(named)) return cached.corpus;
		const rows =
			named.length === 0
				? []
				: await driver.query<SpaceRow & { readonly concept: unknown }>(
						`SELECT ${SPACE_COLUMNS.split(", ")
							.map((column) => `s.${column}`)
							.join(", ")}, c.concept
						FROM memory_spaces s LEFT JOIN memory_concepts c ON c.space_id = s.id AND c.held = 1
						WHERE ${inJsonList(driver.dialect, "s.id")}`,
						[JSON.stringify(named.map((loaded) => loaded.space.id))],
					);
		const read = new Map<string, { loaded: LoadedSpace; concepts: Concept[] }>();
		for (const row of rows) {
			const id = String(row.id);
			let entry = read.get(id);
			if (entry === undefined) {
				entry = { loaded: spaceFrom(row), concepts: [] };
				read.set(id, entry);
			}
			if (row.concept !== null && row.concept !== undefined) {
				entry.concepts.push(JSON.parse(String(row.concept)) as Concept);
			}
		}
		// Spaces are never deleted, so each named one is read; fall back to the first read if one somehow isn't.
		const spaces = named.map((loaded) => read.get(loaded.space.id) ?? { loaded, concepts: [] });
		const corpus = createRecallCorpus(
			recallCorpusOf(spaces.map(({ loaded, concepts }) => ({ space: loaded.space, concepts }))),
		);
		cached = { key: keyOf(spaces.map(({ loaded }) => loaded)), corpus };
		return corpus;
	}

	/**
	 * Runs `statements` as the space's next generation after `read`, if no other writer has taken it. The statements
	 * guard themselves with the `mine` clause and its parameters. Resolves whether this writer's change landed.
	 */
	async function commit(
		read: LoadedSpace,
		build: (mine: { readonly clause: string; readonly params: readonly (string | number)[] }) => SqlStatement[],
		space: { readonly snapshot?: MemorySpace["snapshot"]; readonly imports?: number } = {},
	): Promise<boolean> {
		const writer = crypto.randomUUID();
		const generation = read.generation + 1;
		const spaceId = read.space.id;
		const mine = {
			clause: "EXISTS (SELECT 1 FROM memory_space_writes WHERE space_id = ? AND generation = ? AND writer = ?)",
			params: [spaceId, generation, writer] as const,
		};
		const snapshot = space.snapshot;
		await driver.batch([
			sql(
				"INSERT INTO memory_space_writes (space_id, generation, writer) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
				spaceId,
				generation,
				writer,
			),
			sql(
				`UPDATE memory_spaces SET generation = ?${snapshot === undefined ? "" : ", snapshot_source_id = ?, snapshot_ref = ?, snapshot_imported_at = ?, imports = ?"}
				WHERE id = ? AND generation = ? AND ${mine.clause}`,
				generation,
				...(snapshot === undefined
					? []
					: [snapshot.sourceId, snapshot.ref, snapshot.importedAt, space.imports ?? read.imports]),
				spaceId,
				read.generation,
				...mine.params,
			),
			...build(mine),
		]);
		const [claim] = await driver.query<{ writer: unknown }>(
			"SELECT writer FROM memory_space_writes WHERE space_id = ? AND generation = ?",
			[spaceId, generation],
		);
		return claim !== undefined && String(claim.writer) === writer;
	}

	function upsertConcept(
		spaceId: string,
		concept: Concept,
		mine: { readonly clause: string; readonly params: readonly (string | number)[] },
	): SqlStatement {
		return sql(
			`INSERT INTO memory_concepts (space_id, id, version, held, status, concept)
			SELECT ?, ?, CAST(? AS INTEGER), 1, ?, ? WHERE ${mine.clause} ${UPSERT_CONCEPT}`,
			spaceId,
			concept.id,
			concept.version,
			concept.status,
			JSON.stringify(concept),
			...mine.params,
		);
	}

	function updateProposal(
		proposal: MemoryProposal,
		mine: { readonly clause: string; readonly params: readonly (string | number)[] },
	): SqlStatement {
		return sql(
			`UPDATE memory_proposals SET status = ?, proposal = ? WHERE id = ? AND status = 'pending' AND ${mine.clause}`,
			proposal.status,
			JSON.stringify(proposal),
			proposal.id,
			...mine.params,
		);
	}

	async function proposalRecord(
		ctx: CallContext,
		proposalId: string,
	): Promise<{ readonly organisationId: string; readonly proposal: MemoryProposal }> {
		const [row] =
			typeof proposalId === "string"
				? await driver.query<{ organisation_id: unknown; proposal: unknown }>(
						"SELECT organisation_id, proposal FROM memory_proposals WHERE id = ?",
						[proposalId],
					)
				: [];
		if (row === undefined || String(row.organisation_id) !== ctx.organisationId) {
			throw new HarbourError("not_found", `No memory proposal ${proposalId}`);
		}
		return { organisationId: String(row.organisation_id), proposal: JSON.parse(String(row.proposal)) };
	}

	return {
		async createSpace(ctx, input) {
			await checkCreateSpace(access, authority, ctx, input);
			const space: MemorySpace = {
				id: `space_${crypto.randomUUID()}`,
				owner: { ...input.owner },
				name: input.name,
				createdAt: clock.now(),
			};
			await driver.query(
				"INSERT INTO memory_spaces (id, organisation_id, owner, name, created_at) VALUES (?, ?, ?, ?, ?)",
				[space.id, ctx.organisationId, JSON.stringify(space.owner), space.name, space.createdAt],
			);
			await audits.spaceCreated(ctx, space);
			return space;
		},

		async getConcept(ctx, spaceId, conceptId) {
			const loaded = await spaceFor(ctx, spaceId);
			await requireSpace(access, ctx, loaded.space, "viewer", "memory.getConcept");
			const [row] = await driver.query<{ concept: unknown }>(
				"SELECT concept FROM memory_concepts WHERE space_id = ? AND id = ? AND held = 1",
				[spaceId, conceptId],
			);
			if (row === undefined) throw new HarbourError("not_found", `No concept ${conceptId}`);
			return JSON.parse(String(row.concept)) as Concept;
		},

		async listConcepts(ctx, spaceId, filter, page) {
			const loaded = await spaceFor(ctx, spaceId);
			await requireSpace(access, ctx, loaded.space, "viewer", "memory.listConcepts");
			return paginate(await heldConcepts(spaceId, filter?.status), page);
		},

		async recall(ctx, request) {
			assertRecallRequest(request);
			// One refused project space refuses the whole recall.
			const named = await readableSpaces(ctx, request.spaceIds, "memory.recall");
			return recallFrom(await corpusFor(named), request, renderer, clock.now());
		},

		async search(ctx, request) {
			assertSearchRequest(request);
			const named = await readableSpaces(ctx, request.spaceIds, "memory.search");
			return searchFrom(await corpusFor(named), request, clock.now());
		},

		async importSnapshot(ctx, spaceId, snapshot) {
			forbidAgent(ctx, "import a memory snapshot");
			const before = await spaceFor(ctx, spaceId);
			await requireWrite(access, ctx, before.space.owner, authority.importSnapshot, "memory.importSnapshot", {
				kind: "memory.space",
				id: spaceId,
			});
			assertSnapshot(snapshot);
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const read = await spaceFor(ctx, spaceId);
				const current = read.space.snapshot;
				if (current?.sourceId === snapshot.sourceId && current.ref === snapshot.ref) return read.space;
				const concepts = [...snapshotConcepts(await stateOf(spaceId), snapshot).values()];
				const imported: MemorySpace = {
					...read.space,
					snapshot: { sourceId: snapshot.sourceId, ref: snapshot.ref, importedAt: clock.now() },
				};
				const imports = read.imports + 1;
				const landed = await commit(
					read,
					(mine) => {
						const statements = [
							sql(`UPDATE memory_concepts SET held = 0 WHERE space_id = ? AND ${mine.clause}`, spaceId, ...mine.params),
						];
						for (let start = 0; start < concepts.length; start += CONCEPTS_PER_STATEMENT) {
							const chunk = concepts.slice(start, start + CONCEPTS_PER_STATEMENT).map((concept) => ({
								id: concept.id,
								version: concept.version,
								status: concept.status,
								concept: JSON.stringify(concept),
							}));
							statements.push(
								sql(
									`INSERT INTO memory_concepts (space_id, id, version, held, status, concept) ${jsonConcepts(driver.dialect)}
									WHERE ${mine.clause} ${UPSERT_CONCEPT}`,
									spaceId,
									JSON.stringify(chunk),
									...mine.params,
								),
							);
						}
						return statements;
					},
					{ ...(imported.snapshot === undefined ? {} : { snapshot: imported.snapshot }), imports },
				);
				if (landed) {
					await audits.snapshotImported(ctx, imported, imports, concepts.length);
					return imported;
				}
			}
			throw new HarbourError("conflict", `Memory space ${spaceId} kept changing while the snapshot was imported`);
		},

		async propose(ctx, spaceId, write) {
			const loaded = await spaceFor(ctx, spaceId);
			await requireWrite(access, ctx, loaded.space.owner, authority.propose, "memory.propose", {
				kind: "memory.space",
				id: spaceId,
			});
			const state = await stateOf(spaceId);
			checkWrite(ctx, state, write);
			const duplicate = await findDuplicate(state, write, options.paraphrase);
			const proposal = proposalFor(ctx, state, write, `memprop_${crypto.randomUUID()}`, clock.now(), duplicate);
			const insert = sql(
				"INSERT INTO memory_proposals (id, organisation_id, space_id, status, proposal) VALUES (?, ?, ?, ?, ?)",
				proposal.id,
				ctx.organisationId,
				spaceId,
				proposal.status,
				JSON.stringify(proposal),
			);
			// On Postgres the lock makes a space's proposals commit in `seq` order, so a reader paging by cursor never skips
			// one that commits late. SQLite and D1 run one write at a time anyway.
			await driver.batch(
				driver.dialect === "postgres"
					? [sql("SELECT pg_advisory_xact_lock(73162, hashtext(?))", spaceId), insert]
					: [insert],
			);
			await audits.proposed(ctx, proposal);
			return proposal;
		},

		async decide(ctx, proposalId, input) {
			forbidAgent(ctx, "apply or reject a memory proposal");
			const record = await proposalRecord(ctx, proposalId);
			assertOutcome(input.outcome);
			const before = await spaceFor(ctx, record.proposal.spaceId);
			await requireWrite(access, ctx, before.space.owner, authority.decide, "memory.decide", {
				kind: "memory.proposal",
				id: proposalId,
			});
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				// Read the generation first: whatever changed after it makes this attempt's claim fail.
				const read = await spaceFor(ctx, record.proposal.spaceId);
				const { proposal } = await proposalRecord(ctx, proposalId);
				// Checked after every await: another decision may have settled the proposal meanwhile.
				assertPending(proposal);
				if (input.outcome === "reject") {
					const rejected = decided(ctx, proposal, "rejected", clock.now(), input.note);
					if (await commit(read, (mine) => [updateProposal(rejected, mine)])) {
						await audits.rejected(ctx, rejected);
						return rejected;
					}
					continue;
				}
				const state = await stateOf(read.space.id);
				const { concept, changed } = applyWrite(state, proposal, clock.now());
				const applied = decided(ctx, proposal, "applied", clock.now(), input.note);
				const landed = await commit(read, (mine) => [
					...changed.map((each) => upsertConcept(read.space.id, each, mine)),
					updateProposal(applied, mine),
				]);
				if (landed) {
					await audits.applied(ctx, applied, concept);
					return applied;
				}
			}
			throw new HarbourError("conflict", `Memory space ${record.proposal.spaceId} kept changing during the decision`);
		},

		async listProposals(ctx, spaceId, filter, page) {
			await requireSpace(access, ctx, (await spaceFor(ctx, spaceId)).space, "viewer", "memory.listProposals");
			const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
			const after = page?.cursor === undefined ? undefined : Number(page.cursor);
			if (after !== undefined && (page?.cursor === "" || !Number.isInteger(after) || after < 0)) {
				throw new HarbourError("invalid", "Unknown page cursor");
			}
			const rows = await driver.query<{ seq: unknown; proposal: unknown }>(
				`SELECT seq, proposal FROM memory_proposals WHERE space_id = ?${filter?.status === undefined ? "" : " AND status = ?"}${after === undefined ? "" : " AND seq > ?"} ORDER BY seq LIMIT ?`,
				[
					spaceId,
					...(filter?.status === undefined ? [] : [filter.status]),
					...(after === undefined ? [] : [after]),
					limit + 1,
				],
			);
			const items = rows.slice(0, limit).map((row) => JSON.parse(String(row.proposal)) as MemoryProposal);
			const last = rows[limit - 1];
			return rows.length > limit && last !== undefined ? { items, nextCursor: String(sqlNumber(last.seq)) } : { items };
		},

		async exportBundle(ctx, spaceId) {
			const loaded = await spaceFor(ctx, spaceId);
			await requireSpace(access, ctx, loaded.space, "viewer", "memory.exportBundle");
			return bundleOf(loaded.space.name, await heldConcepts(spaceId));
		},
	};
}
