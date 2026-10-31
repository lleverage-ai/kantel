/**
 * The durable `Skills`, on any `SqlDriver` (Postgres self-hosted, D1 or a Durable Object's SQLite on Cloudflare), with
 * file bodies in an object bucket (S3 or MinIO self-hosted, R2 on Cloudflare). It behaves as the in-memory store in
 * `./memory.ts` does, through the same rules (`./rules.ts`), and passes the same suite.
 *
 * - Rows hold packages, the open draft and who saved it (for the two-person rule), revisions and session pins. A draft's or revision's files are a JSON list of
 *   path, UTF-8 size and SHA-256 in one column; each body is an object keyed by its SHA-256 under its owner's
 *   organisation (`skills/org/<organisation>/<sha256>`, or `skills/platform/<sha256>`), written before the row that
 *   names it, so a committed row never names a missing body. Bodies are never rewritten or deleted, and a read checks
 *   the body against its hash.
 * - Revisions are only ever inserted. A publish or import inserts revision `latest + 1` with `ON CONFLICT DO NOTHING`
 *   and a writer token; only the writer whose row landed moves the package on (`… WHERE EXISTS` the token) and audits,
 *   and a loser re-reads and retries, so racing writers settle as the in-memory store's do. `(skill, source, ref)` is
 *   unique, so a ref imports once.
 * - A session's pins are a `skill_sessions` row (set once, by `ON CONFLICT DO NOTHING`) and one `skill_pins` row per
 *   pinned revision, written in one batch, so a restart keeps them and a session never sees a later revision.
 * - Lists bind as one JSON parameter, so no statement meets D1's 100-parameter cap.
 */
import {
	type Actor,
	type AuditSink,
	authorKey,
	type CallContext,
	type Clock,
	KantelError,
	type OwnerRef,
	type ProjectAccess,
	type SessionSkillPin,
	type SkillFile,
	type SkillListing,
	type SkillPackage,
	type SkillRevision,
	type Skills,
	type SkillsAuthority,
	type SkillVisibility,
	systemClock,
} from "@kantel/contracts";
import { type SqlDialect, type SqlDriver, type SqlRow, sql, sqlNumber, sqlOptionalString } from "@kantel/sql";
import { normaliseSkillPath, parseSkillFrontmatter, SKILL_MD, skillDigest, validateSkillName } from "./index.ts";
import {
	assertDescription,
	assertMayOwn,
	assertNotAuthor,
	authorityOf,
	checkImport,
	checkList,
	checkPin,
	chooseByName,
	deepFreeze,
	draftPermission,
	type Extensions,
	forbidAgent,
	ownerKey,
	ownerVisibleTo,
	paginate,
	prepareFiles,
	requireChange,
	requireUse,
	requireWrite,
	type Source,
	sharedSkills,
	skillsAudit,
	visibleOwner,
	withShared,
} from "./rules.ts";

/**
 * The object store file bodies live in: `get` resolves `undefined` for a missing key. The self-hosted target's S3
 * objects fit as they are; `r2ObjectBucket` adapts a Workers R2 binding.
 */
export interface ObjectBucket {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, bytes: Uint8Array): Promise<void>;
}

/** The part of a Workers `R2Bucket` `r2ObjectBucket` uses. */
export interface R2BucketLike {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: Uint8Array): Promise<unknown>;
}

/** An `ObjectBucket` over a Workers R2 binding (or Miniflare's). */
export function r2ObjectBucket(bucket: R2BucketLike): ObjectBucket {
	return {
		async get(key) {
			const object = await bucket.get(key);
			return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
		},
		async put(key, bytes) {
			await bucket.put(key, bytes);
		},
	};
}

/** An `ObjectBucket` in a map, for tests and single-process use. `keys()` lists what it holds. */
export function createMemoryObjectBucket(): ObjectBucket & { keys(): string[] } {
	const objects = new Map<string, Uint8Array>();
	return {
		async get(key) {
			const bytes = objects.get(key);
			return bytes === undefined ? undefined : bytes.slice();
		},
		async put(key, bytes) {
			objects.set(key, bytes.slice());
		},
		keys: () => [...objects.keys()].sort(),
	};
}

export interface SqlSkillsOptions {
	readonly driver: SqlDriver;
	/** Where file bodies live. */
	readonly objects: ObjectBucket;
	/** Prepended to every object key, so several stores share one bucket apart. */
	readonly prefix?: string;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** As for the in-memory store; every target passes one. */
	readonly access?: ProjectAccess;
	/** The role each change needs, as for the in-memory store. Default `DEFAULT_SKILLS_AUTHORITY`. */
	readonly authority?: SkillsAuthority;
	/** Where skills are mounted in the sandbox; a listing's path is `<mountRoot>/<name>/SKILL.md`. Default `/skills`. */
	readonly mountRoot?: string;
}

/** The tables and indexes, for `migrateSkills` or a target's own migrations. Every statement is idempotent. */
export function skillsSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS skill_packages (
			id TEXT PRIMARY KEY,
			owner_key TEXT NOT NULL,
			owner_kind TEXT NOT NULL,
			organisation_id TEXT,
			project_id TEXT,
			user_id TEXT,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			latest_revision INTEGER NOT NULL DEFAULT 0,
			source_id TEXT,
			source_ref TEXT,
			draft_saves INTEGER NOT NULL DEFAULT 0,
			created_at ${time} NOT NULL,
			updated_at ${time} NOT NULL,
			UNIQUE (owner_key, name)
		)`,
		"CREATE INDEX IF NOT EXISTS skill_packages_by_organisation ON skill_packages (organisation_id, owner_kind)",
		// Lists find platform skills through this one, so they never scan other organisations' packages.
		"CREATE INDEX IF NOT EXISTS skill_packages_by_kind ON skill_packages (owner_kind, latest_revision)",
		`CREATE TABLE IF NOT EXISTS skill_drafts (
			skill_id TEXT PRIMARY KEY,
			seq INTEGER NOT NULL,
			digest TEXT NOT NULL,
			description TEXT NOT NULL,
			files TEXT NOT NULL
		)`,
		// Who saved the open draft (`authorKey`), with their latest save's number; a publish removes those it covers.
		`CREATE TABLE IF NOT EXISTS skill_draft_authors (
			skill_id TEXT NOT NULL,
			author TEXT NOT NULL,
			seq INTEGER NOT NULL,
			PRIMARY KEY (skill_id, author)
		)`,
		`CREATE TABLE IF NOT EXISTS skill_revisions (
			skill_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			digest TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			files TEXT NOT NULL,
			extensions TEXT,
			published_by TEXT NOT NULL,
			published_at ${time} NOT NULL,
			source_id TEXT,
			source_ref TEXT,
			writer TEXT NOT NULL,
			PRIMARY KEY (skill_id, revision)
		)`,
		"CREATE UNIQUE INDEX IF NOT EXISTS skill_revisions_by_source ON skill_revisions (skill_id, source_id, source_ref) WHERE source_id IS NOT NULL",
		`CREATE TABLE IF NOT EXISTS skill_sessions (
			organisation_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			pinned_at ${time} NOT NULL,
			writer TEXT NOT NULL,
			PRIMARY KEY (organisation_id, session_id)
		)`,
		`CREATE TABLE IF NOT EXISTS skill_pins (
			organisation_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			position INTEGER NOT NULL,
			skill_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			PRIMARY KEY (organisation_id, session_id, position)
		)`,
		"CREATE INDEX IF NOT EXISTS skill_pins_by_revision ON skill_pins (skill_id, revision)",
	];
}

/** Creates the skills tables if they are missing. */
export async function migrateSkills(driver: SqlDriver): Promise<void> {
	await driver.batch(skillsSchema(driver.dialect).map((text) => ({ sql: text })));
}

/** A file as a row names it: its body is the object keyed by `sha256`. */
interface StoredFile {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

interface PackageRow extends SqlRow {
	readonly id: unknown;
	readonly owner_kind: unknown;
	readonly organisation_id: unknown;
	readonly project_id: unknown;
	readonly user_id: unknown;
	readonly name: unknown;
	readonly description: unknown;
	readonly latest_revision: unknown;
	readonly source_id: unknown;
	readonly source_ref: unknown;
	readonly created_at: unknown;
	readonly updated_at: unknown;
	readonly draft_digest: unknown;
}

interface RevisionRow extends SqlRow {
	readonly skill_id: unknown;
	readonly revision: unknown;
	readonly digest: unknown;
	readonly name: unknown;
	readonly description: unknown;
	readonly files: unknown;
	readonly extensions: unknown;
	readonly published_by: unknown;
	readonly published_at: unknown;
	readonly source_id: unknown;
	readonly source_ref: unknown;
	readonly writer: unknown;
}

interface DraftRow extends SqlRow {
	readonly seq: unknown;
	readonly digest: unknown;
	readonly description: unknown;
	readonly files: unknown;
}

const PACKAGE_COLUMNS =
	"p.id, p.owner_kind, p.organisation_id, p.project_id, p.user_id, p.name, p.description, p.latest_revision, p.source_id, p.source_ref, p.created_at, p.updated_at, d.digest AS draft_digest";
const REVISION_COLUMNS =
	"skill_id, revision, digest, name, description, files, extensions, published_by, published_at, source_id, source_ref, writer";

/** Attempts a publish or import makes before giving up on a race it keeps losing. */
const MAX_ATTEMPTS = 8;
/** Object store requests in flight at once for one call. */
const OBJECT_BATCH = 16;

function ownerFrom(row: PackageRow): OwnerRef {
	const organisationId = String(row.organisation_id);
	switch (String(row.owner_kind)) {
		case "platform":
			return { kind: "platform" };
		case "organisation":
			return { kind: "organisation", organisationId };
		case "project":
			return { kind: "project", organisationId, projectId: String(row.project_id) };
		case "user":
			return { kind: "user", organisationId, userId: String(row.user_id) };
		default:
			throw new Error(`Unknown skill owner kind ${String(row.owner_kind)}`);
	}
}

function ownerColumns(owner: OwnerRef): [string, string | null, string | null, string | null] {
	switch (owner.kind) {
		case "platform":
			return ["platform", null, null, null];
		case "organisation":
			return ["organisation", owner.organisationId, null, null];
		case "project":
			return ["project", owner.organisationId, owner.projectId, null];
		case "user":
			return ["user", owner.organisationId, null, owner.userId];
	}
}

function packageFrom(row: PackageRow): SkillPackage {
	const latest = sqlNumber(row.latest_revision);
	const draftDigest = sqlOptionalString(row.draft_digest);
	const sourceId = sqlOptionalString(row.source_id);
	return {
		id: String(row.id),
		owner: ownerFrom(row),
		name: String(row.name),
		description: String(row.description),
		...(latest > 0 ? { latestRevision: latest } : {}),
		...(draftDigest === undefined ? {} : { draftDigest }),
		...(sourceId === undefined ? {} : { source: { sourceId, ref: String(row.source_ref) } }),
		createdAt: sqlNumber(row.created_at),
		updatedAt: sqlNumber(row.updated_at),
	};
}

function filesFrom(column: unknown): StoredFile[] {
	return JSON.parse(String(column)) as StoredFile[];
}

function revisionFrom(row: RevisionRow): SkillRevision {
	const extensions = sqlOptionalString(row.extensions);
	const sourceId = sqlOptionalString(row.source_id);
	return deepFreeze({
		skillId: String(row.skill_id),
		revision: sqlNumber(row.revision),
		digest: String(row.digest),
		name: String(row.name),
		description: String(row.description),
		files: filesFrom(row.files).map((file) => ({ path: file.path, size: file.size })),
		...(extensions === undefined ? {} : { extensions: JSON.parse(extensions) as Extensions }),
		publishedBy: JSON.parse(String(row.published_by)) as Actor,
		publishedAt: sqlNumber(row.published_at),
		...(sourceId === undefined ? {} : { source: { sourceId, ref: String(row.source_ref) } }),
	});
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The pin rows of a JSON list bound as one parameter, each with its place in the list. */
function jsonPins(dialect: SqlDialect): string {
	return dialect === "postgres"
		? `SELECT ?, ?, CAST(p.ordinality AS INTEGER) - 1, p.value->>'skillId', CAST(p.value->>'revision' AS INTEGER)
			FROM jsonb_array_elements(CAST(? AS jsonb)) WITH ORDINALITY AS p(value, ordinality)`
		: `SELECT ?, ?, CAST(key AS INTEGER), json_extract(value, '$.skillId'), json_extract(value, '$.revision')
			FROM json_each(?)`;
}

/**
 * The durable `Skills`. Call `migrateSkills(driver)` (or run `skillsSchema`) once before using it. Every process
 * sharing the database and the bucket sees the same skills, and a restart keeps revisions and pins.
 */
export function createSqlSkills(options: SqlSkillsOptions): Skills {
	const { driver, objects } = options;
	const clock = options.clock ?? systemClock;
	const access = options.access;
	const authority = authorityOf(options.authority);
	const audits = skillsAudit(options.audit, clock);
	const mountRoot = (options.mountRoot ?? "/skills").replace(/\/+$/, "");
	const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
	const encoder = new TextEncoder();
	// `ignoreBOM` spelled out: Workers' types require it.
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

	function bodyKey(owner: OwnerRef, sha256: string): string {
		const scope = owner.kind === "platform" ? "platform" : `org/${encodeURIComponent(owner.organisationId)}`;
		const key = `skills/${scope}/${sha256}`;
		return prefix === "" ? key : `${prefix}/${key}`;
	}

	/** Writes each file's body and returns the files as rows name them. */
	async function storeFiles(owner: OwnerRef, files: readonly SkillFile[]): Promise<StoredFile[]> {
		const stored: StoredFile[] = [];
		for (let start = 0; start < files.length; start += OBJECT_BATCH) {
			const chunk = files.slice(start, start + OBJECT_BATCH);
			stored.push(
				...(await Promise.all(
					chunk.map(async (file) => {
						const bytes = encoder.encode(file.content);
						const sha256 = await sha256Hex(bytes);
						await objects.put(bodyKey(owner, sha256), bytes);
						return { path: file.path, size: bytes.length, sha256 };
					}),
				)),
			);
		}
		return stored;
	}

	async function readBody(owner: OwnerRef, file: StoredFile): Promise<string> {
		const bytes = await objects.get(bodyKey(owner, file.sha256));
		if (bytes === undefined || (await sha256Hex(bytes)) !== file.sha256) {
			throw new KantelError("unavailable", `The body of ${file.path} is missing from the object store`);
		}
		return decoder.decode(bytes);
	}

	async function packageRow(skillId: string): Promise<PackageRow | undefined> {
		const [row] = await driver.query<PackageRow>(
			`SELECT ${PACKAGE_COLUMNS} FROM skill_packages p LEFT JOIN skill_drafts d ON d.skill_id = p.id WHERE p.id = ?`,
			[skillId],
		);
		return row;
	}

	/** The package, if the caller's organisation may see it; `not_found` otherwise. */
	async function skillFor(ctx: CallContext, skillId: string): Promise<SkillPackage> {
		const row = typeof skillId === "string" ? await packageRow(skillId) : undefined;
		if (row !== undefined) {
			const pkg = packageFrom(row);
			if (ownerVisibleTo(ctx, pkg.owner)) return pkg;
		}
		throw new KantelError("not_found", `No skill ${skillId}`);
	}

	async function draftOf(skillId: string): Promise<DraftRow | undefined> {
		const [row] = await driver.query<DraftRow>(
			"SELECT seq, digest, description, files FROM skill_drafts WHERE skill_id = ?",
			[skillId],
		);
		return row;
	}

	async function revisionRow(skillId: string, revision: number): Promise<RevisionRow | undefined> {
		if (!Number.isInteger(revision) || revision < 1) return undefined;
		const [row] = await driver.query<RevisionRow>(
			`SELECT ${REVISION_COLUMNS} FROM skill_revisions WHERE skill_id = ? AND revision = ?`,
			[skillId, revision],
		);
		return row;
	}

	async function revisionFor(skillId: string, revision: number): Promise<RevisionRow> {
		const row = await revisionRow(skillId, revision);
		if (row === undefined) throw new KantelError("not_found", `No revision ${revision} of skill ${skillId}`);
		return row;
	}

	/** Creates a package row; `false` when the owner already has one of that name. */
	async function insertPackage(id: string, owner: OwnerRef, name: string, description: string): Promise<boolean> {
		const now = clock.now();
		const inserted = await driver.query(
			`INSERT INTO skill_packages (id, owner_key, owner_kind, organisation_id, project_id, user_id, name, description, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
			[id, ownerKey(owner), ...ownerColumns(owner), name, description, now, now],
		);
		return inserted.length > 0;
	}

	/**
	 * Inserts revision `revision` and, if this writer's row is the one that landed, moves the package on to it. Resolves
	 * the revision this writer recorded, or `undefined` when another writer took that number (or that source and ref).
	 */
	async function recordRevision(
		ctx: CallContext,
		pkg: SkillPackage,
		revision: number,
		input: {
			readonly files: readonly StoredFile[];
			readonly digest: string;
			readonly description: string;
			readonly extensions?: Extensions;
			readonly source?: Source;
			/** The draft this publishes, closed in the same batch. */
			readonly draftSeq?: number;
		},
	): Promise<SkillRevision | undefined> {
		const writer = crypto.randomUUID();
		const now = clock.now();
		const mine = "EXISTS (SELECT 1 FROM skill_revisions WHERE skill_id = ? AND revision = ? AND writer = ?)";
		await driver.batch([
			sql(
				`INSERT INTO skill_revisions (${REVISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				pkg.id,
				revision,
				input.digest,
				pkg.name,
				input.description,
				JSON.stringify(input.files),
				input.extensions === undefined ? null : JSON.stringify(input.extensions),
				JSON.stringify(ctx.actor),
				now,
				input.source?.sourceId ?? null,
				input.source?.ref ?? null,
				writer,
			),
			sql(
				`UPDATE skill_packages SET latest_revision = ?, description = ?, source_id = COALESCE(?, source_id),
					source_ref = COALESCE(?, source_ref), updated_at = ? WHERE id = ? AND ${mine}`,
				revision,
				input.description,
				input.source?.sourceId ?? null,
				input.source?.ref ?? null,
				now,
				pkg.id,
				pkg.id,
				revision,
				writer,
			),
			...(input.draftSeq === undefined
				? []
				: [
						sql(
							`DELETE FROM skill_drafts WHERE skill_id = ? AND seq = ? AND ${mine}`,
							pkg.id,
							input.draftSeq,
							pkg.id,
							revision,
							writer,
						),
						sql(
							`DELETE FROM skill_draft_authors WHERE skill_id = ? AND seq <= ? AND ${mine}`,
							pkg.id,
							input.draftSeq,
							pkg.id,
							revision,
							writer,
						),
					]),
		]);
		const row = await revisionRow(pkg.id, revision);
		return row !== undefined && String(row.writer) === writer ? revisionFrom(row) : undefined;
	}

	async function visibleListings(
		ctx: CallContext,
		visibility: SkillVisibility,
		sessionId?: string,
	): Promise<SkillListing[]> {
		const visible = await ownListings(ctx, visibility);
		const found = await sharedSkills(
			access,
			ctx,
			visibility,
			async (skillId) => {
				const row = await packageRow(skillId);
				if (row === undefined) return undefined;
				const pkg = packageFrom(row);
				return {
					skillId,
					owner: pkg.owner,
					name: pkg.name,
					...(pkg.latestRevision === undefined ? {} : { latestRevision: pkg.latestRevision }),
				};
			},
			sessionId,
		);
		const shared: SkillListing[] = [];
		for (const skill of found) {
			const row = await revisionFor(skill.skillId, skill.revision);
			shared.push({
				skillId: skill.skillId,
				name: skill.name,
				description: String(row.description),
				revision: skill.revision,
				path: `${mountRoot}/${skill.name}/${SKILL_MD}`,
			});
		}
		return withShared(visible, shared);
	}

	async function ownListings(ctx: CallContext, visibility: SkillVisibility): Promise<SkillListing[]> {
		const rows = await driver.query<
			PackageRow & { readonly revision: unknown; readonly revision_description: unknown }
		>(
			`SELECT p.id, p.owner_kind, p.organisation_id, p.project_id, p.user_id, p.name, r.revision,
				r.description AS revision_description
			FROM skill_packages p JOIN skill_revisions r ON r.skill_id = p.id AND r.revision = p.latest_revision
			WHERE p.latest_revision > 0 AND (p.owner_kind = 'platform' OR (p.organisation_id = ? AND (
				p.owner_kind = 'organisation' OR (p.owner_kind = 'project' AND p.project_id = ?)
				OR (p.owner_kind = 'user' AND p.user_id = ?))))`,
			[ctx.organisationId, visibility.projectId ?? null, visibility.userId ?? null],
		);
		const candidates = rows
			.map((row) => ({ owner: ownerFrom(row), name: String(row.name), row }))
			.filter((candidate) => visibleOwner(ctx, visibility, candidate.owner));
		return chooseByName(candidates).map(({ name, row }) => ({
			skillId: String(row.id),
			name,
			description: String(row.revision_description),
			revision: sqlNumber(row.revision),
			path: `${mountRoot}/${name}/${SKILL_MD}`,
		}));
	}

	async function pinsOf(ctx: CallContext, sessionId: string): Promise<readonly SessionSkillPin[] | undefined> {
		const [session] = await driver.query<{ pinned_at: unknown }>(
			"SELECT pinned_at FROM skill_sessions WHERE organisation_id = ? AND session_id = ?",
			[ctx.organisationId, sessionId],
		);
		if (session === undefined) return undefined;
		const pinnedAt = sqlNumber(session.pinned_at);
		const rows = await driver.query<{ skill_id: unknown; revision: unknown }>(
			"SELECT skill_id, revision FROM skill_pins WHERE organisation_id = ? AND session_id = ? ORDER BY position",
			[ctx.organisationId, sessionId],
		);
		return deepFreeze(
			rows.map((row) => ({ sessionId, skillId: String(row.skill_id), revision: sqlNumber(row.revision), pinnedAt })),
		);
	}

	return {
		async create(ctx, input) {
			forbidAgent(ctx, "create skills");
			assertMayOwn(ctx, input.owner);
			await requireWrite(access, ctx, input.owner, authority.create, "skills.create");
			validateSkillName(input.name);
			assertDescription(input.description);
			const id = `skill_${crypto.randomUUID()}`;
			if (!(await insertPackage(id, input.owner, input.name, input.description))) {
				throw new KantelError("conflict", `The owner already has a skill named ${input.name}`);
			}
			const pkg = await skillFor(ctx, id);
			await audits.created(ctx, pkg);
			return pkg;
		},

		async get(ctx, skillId) {
			const pkg = await skillFor(ctx, skillId);
			await requireUse(access, ctx, pkg.owner, "skills.get", skillId);
			return pkg;
		},

		async saveDraft(ctx, skillId, input) {
			const before = await skillFor(ctx, skillId);
			assertMayOwn(ctx, before.owner);
			await requireChange(
				access,
				ctx,
				before.owner,
				draftPermission(ctx),
				authority.saveDraft,
				"skills.saveDraft",
				skillId,
			);
			if (input.description !== undefined) assertDescription(input.description);
			const files = prepareFiles(input.files);
			const digest = await skillDigest(files);
			const stored = await storeFiles(before.owner, files);
			// The save's number orders racing saves: the latest one wins, as in the in-memory store.
			const [counted] = await driver.query<{ draft_saves: unknown; description: unknown; name: unknown }>(
				"UPDATE skill_packages SET draft_saves = draft_saves + 1, updated_at = ? WHERE id = ? RETURNING draft_saves, description, name",
				[clock.now(), skillId],
			);
			if (counted === undefined) throw new KantelError("not_found", `No skill ${skillId}`);
			const seq = sqlNumber(counted.draft_saves);
			const skillMd = files.find((file) => file.path === SKILL_MD)!.content;
			const description =
				input.description ?? parseSkillFrontmatter(skillMd).description ?? String(counted.description);
			await driver.batch([
				sql(
					`INSERT INTO skill_drafts (skill_id, seq, digest, description, files) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (skill_id) DO UPDATE SET seq = excluded.seq, digest = excluded.digest,
						description = excluded.description, files = excluded.files
					WHERE skill_drafts.seq < excluded.seq`,
					skillId,
					seq,
					digest,
					description,
					JSON.stringify(stored),
				),
				sql(
					`INSERT INTO skill_draft_authors (skill_id, author, seq) VALUES (?, ?, ?)
					ON CONFLICT (skill_id, author) DO UPDATE SET seq = excluded.seq WHERE skill_draft_authors.seq < excluded.seq`,
					skillId,
					authorKey(ctx.actor),
					seq,
				),
			]);
			await audits.draftSaved(ctx, { skillId, name: String(counted.name), digest, files: files.length }, seq);
			return { digest };
		},

		async readDraft(ctx, skillId) {
			const pkg = await skillFor(ctx, skillId);
			assertMayOwn(ctx, pkg.owner);
			await requireUse(access, ctx, pkg.owner, "skills.readDraft", skillId);
			const draft = await draftOf(skillId);
			if (draft === undefined) throw new KantelError("not_found", `Skill ${skillId} has no open draft`);
			const files = filesFrom(draft.files);
			const contents = await Promise.all(files.map((file) => readBody(pkg.owner, file)));
			return Object.freeze(files.map((file, index) => Object.freeze({ path: file.path, content: contents[index]! })));
		},

		async publish(ctx, skillId, input) {
			forbidAgent(ctx, "publish skills");
			const before = await skillFor(ctx, skillId);
			assertMayOwn(ctx, before.owner);
			// Publishing needs `approve`: the `SkillsAuthority.publish` role on the owner, an approver binding or share.
			const policy = await requireChange(
				access,
				ctx,
				before.owner,
				"approve",
				authority.publish,
				"skills.publish",
				skillId,
			);
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				// Re-read after the access check, and again after losing a race.
				const pkg = await skillFor(ctx, skillId);
				const draft = await draftOf(skillId);
				const latestRow = pkg.latestRevision === undefined ? undefined : await revisionRow(skillId, pkg.latestRevision);
				const latest = latestRow === undefined ? undefined : revisionFrom(latestRow);
				if (draft === undefined) {
					// A retried publish finds its draft already published.
					if (latest !== undefined && latest.digest === input.expectedDigest) return latest;
					throw new KantelError("conflict", `Skill ${skillId} has no open draft to publish`);
				}
				const digest = String(draft.digest);
				if (digest !== input.expectedDigest) {
					throw new KantelError("conflict", "The draft changed since it was reviewed", { digest });
				}
				const seq = sqlNumber(draft.seq);
				if (policy.twoPersonRule) {
					const authors = await driver.query<{ author: unknown }>(
						"SELECT author FROM skill_draft_authors WHERE skill_id = ? AND seq <= ?",
						[skillId, seq],
					);
					assertNotAuthor(
						policy,
						ctx,
						authors.map((row) => String(row.author)),
					);
				}
				if (latest !== undefined && latest.digest === digest) {
					// Closes the draft only while `latest` is still the package's latest: if another writer moved the package on
					// since it was read, the draft is no longer unchanged from it, so re-read and publish it instead.
					const closed = await driver.query(
						`DELETE FROM skill_drafts WHERE skill_id = ? AND seq = ?
						AND EXISTS (SELECT 1 FROM skill_packages WHERE id = ? AND latest_revision = ?) RETURNING seq`,
						[skillId, seq, skillId, latest.revision],
					);
					if (closed.length === 0) continue;
					await driver.batch([
						sql("UPDATE skill_packages SET updated_at = ? WHERE id = ?", clock.now(), skillId),
						sql("DELETE FROM skill_draft_authors WHERE skill_id = ? AND seq <= ?", skillId, seq),
					]);
					return latest;
				}
				const revision = await recordRevision(ctx, pkg, (pkg.latestRevision ?? 0) + 1, {
					files: filesFrom(draft.files),
					digest,
					description: String(draft.description),
					draftSeq: seq,
					...(input.extensions === undefined ? {} : { extensions: input.extensions }),
				});
				if (revision !== undefined) {
					await audits.published(ctx, revision);
					return revision;
				}
			}
			throw new KantelError("conflict", `Skill ${skillId} kept changing while it was published`);
		},

		async getRevision(ctx, skillId, revision) {
			const pkg = await skillFor(ctx, skillId);
			await requireUse(access, ctx, pkg.owner, "skills.getRevision", skillId, revision);
			return revisionFrom(await revisionFor(skillId, revision));
		},

		async readFile(ctx, skillId, revision, path) {
			const pkg = await skillFor(ctx, skillId);
			await requireUse(access, ctx, pkg.owner, "skills.readFile", skillId, revision);
			const row = await revisionFor(skillId, revision);
			const wanted = normaliseSkillPath(path);
			const file = filesFrom(row.files).find((candidate) => candidate.path === wanted);
			if (file === undefined) throw new KantelError("not_found", `No ${path} in revision ${revision}`);
			return readBody(pkg.owner, file);
		},

		async listRevisions(ctx, skillId, page) {
			const pkg = await skillFor(ctx, skillId);
			await requireUse(access, ctx, pkg.owner, "skills.listRevisions", skillId);
			const limit = Math.max(1, Math.min(page?.limit ?? 100, 500));
			const before = page?.cursor === undefined ? undefined : Number(page.cursor);
			if (before !== undefined && (!Number.isInteger(before) || before < 1 || page?.cursor === "")) {
				throw new KantelError("invalid", "Unknown page cursor");
			}
			const rows = await driver.query<RevisionRow>(
				`SELECT ${REVISION_COLUMNS} FROM skill_revisions WHERE skill_id = ?${before === undefined ? "" : " AND revision < ?"}
				ORDER BY revision DESC LIMIT ?`,
				[skillId, ...(before === undefined ? [] : [before]), limit + 1],
			);
			const items = rows.slice(0, limit).map(revisionFrom);
			const last = items.at(-1);
			return rows.length > limit && last !== undefined ? { items, nextCursor: String(last.revision) } : { items };
		},

		async list(ctx, visibility, page) {
			await checkList(access, ctx, visibility);
			return paginate(await visibleListings(ctx, visibility), page);
		},

		async pinForSession(ctx, sessionId, visibility) {
			await checkPin(access, ctx, sessionId, visibility);
			const existing = await pinsOf(ctx, sessionId);
			if (existing !== undefined) return existing;
			const listings = await visibleListings(ctx, visibility, sessionId);
			const pinnedAt = clock.now();
			const writer = crypto.randomUUID();
			await driver.batch([
				sql(
					"INSERT INTO skill_sessions (organisation_id, session_id, pinned_at, writer) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
					ctx.organisationId,
					sessionId,
					pinnedAt,
					writer,
				),
				sql(
					`INSERT INTO skill_pins (organisation_id, session_id, position, skill_id, revision) ${jsonPins(driver.dialect)}
					WHERE EXISTS (SELECT 1 FROM skill_sessions WHERE organisation_id = ? AND session_id = ? AND writer = ?)`,
					ctx.organisationId,
					sessionId,
					JSON.stringify(listings.map((listing) => ({ skillId: listing.skillId, revision: listing.revision }))),
					ctx.organisationId,
					sessionId,
					writer,
				),
			]);
			const [session] = await driver.query<{ writer: unknown }>(
				"SELECT writer FROM skill_sessions WHERE organisation_id = ? AND session_id = ?",
				[ctx.organisationId, sessionId],
			);
			const pinned = (await pinsOf(ctx, sessionId)) ?? [];
			// A session pinned at once by another caller keeps that caller's pins, audited by it.
			if (session !== undefined && String(session.writer) === writer) {
				await audits.pinned(ctx, sessionId, pinned, pinnedAt);
			}
			return pinned;
		},

		async importRevision(ctx, input) {
			await checkImport(access, authority, ctx, input, validateSkillName);
			const files = prepareFiles(input.files);
			const digest = await skillDigest(files);
			const stored = await storeFiles(input.owner, files);
			const key = ownerKey(input.owner);
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const [found] = await driver.query<{ id: unknown }>(
					"SELECT id FROM skill_packages WHERE owner_key = ? AND name = ?",
					[key, input.name],
				);
				const skillId = found === undefined ? `skill_${crypto.randomUUID()}` : String(found.id);
				// Racing imports may both create the package; the loser publishes into the winner's.
				if (found === undefined && !(await insertPackage(skillId, input.owner, input.name, input.description))) {
					continue;
				}
				const imported = async () => {
					const [row] = await driver.query<RevisionRow>(
						`SELECT ${REVISION_COLUMNS} FROM skill_revisions WHERE skill_id = ? AND source_id = ? AND source_ref = ?`,
						[skillId, input.source.sourceId, input.source.ref],
					);
					return row === undefined ? undefined : revisionFrom(row);
				};
				const existing = await imported();
				if (existing !== undefined) return existing;
				const pkg = (await packageRow(skillId)) as PackageRow;
				const revision = await recordRevision(ctx, packageFrom(pkg), sqlNumber(pkg.latest_revision) + 1, {
					files: stored,
					digest,
					description: input.description,
					source: input.source,
					...(input.extensions === undefined ? {} : { extensions: input.extensions }),
				});
				if (revision !== undefined) {
					await audits.published(ctx, revision);
					return revision;
				}
				// Another import of this ref may have landed first; if not, another revision took the number.
				const raced = await imported();
				if (raced !== undefined) return raced;
			}
			throw new KantelError("conflict", `Skill ${input.name} kept changing while it was imported`);
		},
	};
}
