import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import type { AuditEventInput, AuditSink, CallContext, SkillFile, Skills } from "@harbour/contracts";
import {
	createMemoryObjectBucket,
	createSqlSkills,
	migrateSkills,
	type ObjectBucket,
	type R2BucketLike,
	r2ObjectBucket,
} from "@harbour/skills/sql";
import type { SqlDriver } from "@harbour/sql";
import { postgresTransactionalDriver } from "@harbour/sql/postgres";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-a";
const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: ORG };
const service: CallContext = { actor: { kind: "service", serviceId: "sal-worker" }, organisationId: ORG };
const owner = { kind: "organisation", organisationId: ORG } as const;

function files(name: string, body: string): SkillFile[] {
	return [
		{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n` },
		{ path: "scripts/run.sh", content: `echo ${body}\n` },
	];
}

function recordingAudit(): AuditSink & { readonly events: AuditEventInput[] } {
	const events: AuditEventInput[] = [];
	return { events, append: async (_ctx, batch) => void events.push(...batch) };
}

/** Bodies in a directory, so a reopened store in a new process finds them. */
function directoryBucket(root: string): ObjectBucket {
	return {
		async get(key) {
			try {
				return new Uint8Array(readFileSync(join(root, key)));
			} catch {
				return undefined;
			}
		},
		async put(key, bytes) {
			mkdirSync(dirname(join(root, key)), { recursive: true });
			writeFileSync(join(root, key), bytes);
		},
	};
}

/** Publishes two revisions of `pr-review`, imports `release` and pins `session-1`; what a later store must still see. */
async function seed(skills: Skills) {
	const pkg = await skills.create(human, { owner, name: "pr-review", description: "Review PRs" });
	const one = await skills.saveDraft(human, pkg.id, { files: files("pr-review", "One.") });
	const first = await skills.publish(human, pkg.id, { expectedDigest: one.digest });
	const two = await skills.saveDraft(human, pkg.id, { files: files("pr-review", "Two.") });
	const second = await skills.publish(human, pkg.id, { expectedDigest: two.digest });
	const imported = await skills.importRevision(service, {
		owner,
		name: "release",
		description: "Cut a release",
		files: files("release", "From abc."),
		source: { sourceId: "sal-git", ref: "abc" },
		extensions: { "sal.trigger": { on: "tag" } },
	});
	const draft = await skills.saveDraft(human, pkg.id, { files: files("pr-review", "Draft.") });
	const pins = await skills.pinForSession(service, "session-1", {});
	return { pkg, first, second, imported, draft, pins };
}

/** What a store reopened over the same database and bucket must report, and that it carries on from there. */
async function checkAfterRestart(skills: Skills, seeded: Awaited<ReturnType<typeof seed>>) {
	const { pkg, first, second, imported, draft, pins } = seeded;
	expect(await skills.getRevision(human, pkg.id, 1)).toEqual(first);
	expect(await skills.getRevision(human, pkg.id, 2)).toEqual(second);
	expect(await skills.getRevision(human, imported.skillId, 1)).toEqual(imported);
	expect(await skills.readFile(human, pkg.id, 1, "SKILL.md")).toContain("One.");
	expect(await skills.readFile(human, pkg.id, 2, "scripts/run.sh")).toBe("echo Two.\n");
	expect((await skills.listRevisions(human, pkg.id)).items).toEqual([second, first]);
	const after = await skills.get(human, pkg.id);
	expect(after).toMatchObject({ latestRevision: 2, draftDigest: draft.digest });
	expect((await skills.readDraft(human, pkg.id)).find((file) => file.path === "SKILL.md")?.content).toContain("Draft.");
	expect(await skills.pinForSession(service, "session-1", {})).toEqual(pins);
	// An import of the same ref after the restart is still the same revision.
	expect(
		await skills.importRevision(service, {
			owner,
			name: "release",
			description: "Cut a release",
			files: files("release", "Changed."),
			source: { sourceId: "sal-git", ref: "abc" },
		}),
	).toEqual(imported);
	// Publishing the open draft carries on from revision 2, and only a new session sees it.
	const third = await skills.publish(human, pkg.id, { expectedDigest: draft.digest });
	expect(third.revision).toBe(3);
	expect(await skills.pinForSession(service, "session-1", {})).toEqual(pins);
	const fresh = await skills.pinForSession(service, "session-2", {});
	expect(fresh.find((pin) => pin.skillId === pkg.id)?.revision).toBe(3);
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

for (const kind of testDatabaseKinds()) {
	describe(`SQL skills on ${kind.name}`, () => {
		async function open(): Promise<SqlDriver> {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateSkills(database.driver);
			return database.driver;
		}

		it("keeps revisions, drafts and pins for a store opened again over the same database and bucket", async () => {
			const driver = await open();
			const objects = createMemoryObjectBucket();
			const seeded = await seed(createSqlSkills({ driver, objects }));
			// Migrating again is harmless, as a restart does.
			await migrateSkills(driver);
			await checkAfterRestart(createSqlSkills({ driver, objects }), seeded);
		});

		it("keeps file bodies in the bucket, once per content, under the owner's organisation", async () => {
			const driver = await open();
			const objects = createMemoryObjectBucket();
			const skills = createSqlSkills({ driver, objects, prefix: "harbour" });
			const pkg = await skills.create(human, { owner, name: "lint", description: "Lint" });
			const draft = await skills.saveDraft(human, pkg.id, { files: files("lint", "Same.") });
			await skills.publish(human, pkg.id, { expectedDigest: draft.digest });
			await skills.saveDraft(human, pkg.id, { files: files("lint", "Same.") });
			const keys = objects.keys();
			expect(keys).toHaveLength(2);
			for (const key of keys) expect(key).toMatch(/^harbour\/skills\/org\/org-a\/[0-9a-f]{64}$/);
			const rows = await driver.query<{ files: string }>("SELECT files FROM skill_revisions");
			expect(rows[0]!.files).not.toContain("Same.");
		});

		it("refuses to serve a body that is missing or does not match its hash", async () => {
			const driver = await open();
			const objects = createMemoryObjectBucket();
			const skills = createSqlSkills({ driver, objects });
			const pkg = await skills.create(human, { owner, name: "lint", description: "Lint" });
			const draft = await skills.saveDraft(human, pkg.id, { files: files("lint", "Body.") });
			await skills.publish(human, pkg.id, { expectedDigest: draft.digest });
			const [skillMd, script] = objects.keys();
			await objects.put(skillMd!, new TextEncoder().encode("tampered"));
			const lost = createSqlSkills({
				driver,
				objects: { get: async (key) => (key === script ? undefined : objects.get(key)), put: objects.put },
			});
			// One body was changed and the other lost; neither is served.
			for (const path of ["SKILL.md", "scripts/run.sh"]) {
				await expect(lost.readFile(human, pkg.id, 1, path)).rejects.toMatchObject({ code: "unavailable" });
			}
		});

		it("settles racing publishes, imports and pins from two stores on one database", async () => {
			const driver = await open();
			const objects = createMemoryObjectBucket();
			const audit = recordingAudit();
			const left = createSqlSkills({ driver, objects, audit });
			const right = createSqlSkills({ driver, objects, audit });
			const pkg = await left.create(human, { owner, name: "pr-review", description: "Review PRs" });
			const { digest } = await left.saveDraft(human, pkg.id, { files: files("pr-review", "One.") });
			const published = await Promise.all([
				left.publish(human, pkg.id, { expectedDigest: digest }),
				right.publish(human, pkg.id, { expectedDigest: digest }),
			]);
			expect(published[0]).toEqual(published[1]);
			expect((await left.listRevisions(human, pkg.id)).items).toHaveLength(1);

			const importOf = (skills: Skills, ref: string) =>
				skills.importRevision(service, {
					owner,
					name: "release",
					description: "Cut a release",
					files: files("release", ref),
					source: { sourceId: "sal-git", ref },
				});
			const sameRef = await Promise.all([importOf(left, "abc"), importOf(right, "abc")]);
			expect(sameRef[0]).toEqual(sameRef[1]);
			const otherRefs = await Promise.all([importOf(left, "def"), importOf(right, "ghi")]);
			expect(otherRefs.map((revision) => revision.revision).sort()).toEqual([2, 3]);
			const release = await left.get(human, sameRef[0].skillId);
			expect(release.latestRevision).toBe(3);

			const pins = await Promise.all([
				left.pinForSession(service, "session-1", {}),
				right.pinForSession(service, "session-1", {}),
			]);
			expect(pins[0]).toEqual(pins[1]);
			const types = audit.events.map((event) => event.type);
			expect(types.filter((type) => type === "skills.revision.published")).toHaveLength(4);
			expect(types.filter((type) => type === "skills.session.pinned")).toHaveLength(1);
		});

		it("publishes a draft that matches a revision another writer has since moved past", async () => {
			const driver = await open();
			const objects = createMemoryObjectBucket();
			const other = createSqlSkills({ driver, objects });
			const pkg = await other.create(human, { owner, name: "pr-review", description: "Review PRs" });
			const a = await other.saveDraft(human, pkg.id, { files: files("pr-review", "A.") });
			await other.publish(human, pkg.id, { expectedDigest: a.digest });
			// The publisher reads revision 1 (A) as latest; before it reads the draft, another writer imports B as
			// revision 2 and saves A again as a draft. Publishing that draft must make revision 3, not close it as unchanged.
			let pending: (() => Promise<unknown>) | undefined = async () => {
				await other.importRevision(service, {
					owner,
					name: "pr-review",
					description: "Review PRs",
					files: files("pr-review", "B."),
					source: { sourceId: "sal-git", ref: "b" },
				});
				await other.saveDraft(human, pkg.id, { files: files("pr-review", "A.") });
			};
			const gated: SqlDriver = {
				dialect: driver.dialect,
				batch: (statements) => driver.batch(statements),
				async query(text, params) {
					if (pending !== undefined && text.startsWith("SELECT seq, digest")) {
						const run = pending;
						pending = undefined;
						await run();
					}
					return driver.query(text, params);
				},
			};
			const published = await createSqlSkills({ driver: gated, objects }).publish(human, pkg.id, {
				expectedDigest: a.digest,
			});
			expect(pending).toBeUndefined();
			expect(published.revision).toBe(3);
			const after = await other.get(human, pkg.id);
			expect(after.latestRevision).toBe(3);
			expect(after.draftDigest).toBeUndefined();
			expect(await other.readFile(human, pkg.id, 3, "scripts/run.sh")).toBe("echo A.\n");
		});

		it("lists platform skills without scanning other organisations' packages", async () => {
			const driver = await open();
			if (driver.dialect !== "sqlite") return;
			// Catches the listing's own statement, then asks SQLite how it would run it.
			const seen: { text: string; params: readonly unknown[] }[] = [];
			const recording: SqlDriver = {
				dialect: driver.dialect,
				batch: (statements) => driver.batch(statements),
				query(text, params) {
					seen.push({ text, params: params ?? [] });
					return driver.query(text, params);
				},
			};
			await createSqlSkills({ driver: recording, objects: createMemoryObjectBucket() }).list(human, {});
			const listing = seen.find((statement) => statement.text.includes("owner_kind = 'platform'"));
			expect(listing).toBeDefined();
			const plan = await driver.query<{ detail: string }>(
				`EXPLAIN QUERY PLAN ${listing!.text}`,
				listing!.params as Parameters<SqlDriver["query"]>[1],
			);
			const details = plan.map((row) => String(row.detail));
			expect(details.some((detail) => /SCAN p\b/.test(detail) && !/USING/.test(detail))).toBe(false);
		});
	});
}

describe("SQL skills across a real restart", () => {
	it("keeps revisions and pins when node:sqlite closes and opens its file again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harbour-skills-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const objects = directoryBucket(join(dir, "objects"));
		const first = new DatabaseSync(join(dir, "skills.db"));
		await migrateSkills(syncSqliteDriver(first));
		const seeded = await seed(createSqlSkills({ driver: syncSqliteDriver(first), objects }));
		first.close();
		const second = new DatabaseSync(join(dir, "skills.db"));
		cleanups.push(() => second.close());
		await migrateSkills(syncSqliteDriver(second));
		await checkAfterRestart(createSqlSkills({ driver: syncSqliteDriver(second), objects }), seeded);
	});

	it("keeps revisions and pins when PGlite closes and opens its data directory again", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harbour-skills-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const objects = directoryBucket(join(dir, "objects"));
		const first = await PGlite.create(join(dir, "pg"));
		await migrateSkills(postgresTransactionalDriver(first));
		const seeded = await seed(createSqlSkills({ driver: postgresTransactionalDriver(first), objects }));
		await first.close();
		const second = await PGlite.create(join(dir, "pg"));
		cleanups.push(() => second.close());
		await checkAfterRestart(createSqlSkills({ driver: postgresTransactionalDriver(second), objects }), seeded);
	});

	it("keeps bodies in R2 through r2ObjectBucket", async () => {
		const miniflare = new Miniflare(
			convertV4MiniflareOptions({
				modules: true,
				script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
				compatibilityDate: "2026-10-01",
				r2Buckets: ["SKILLS"],
			}),
		);
		cleanups.push(() => miniflare.dispose());
		const objects = r2ObjectBucket((await miniflare.getR2Bucket("SKILLS")) as unknown as R2BucketLike);
		const database = new DatabaseSync(":memory:");
		cleanups.push(() => database.close());
		const driver = syncSqliteDriver(database);
		await migrateSkills(driver);
		const seeded = await seed(createSqlSkills({ driver, objects }));
		expect(await objects.get("skills/org/org-a/missing")).toBeUndefined();
		await checkAfterRestart(createSqlSkills({ driver, objects }), seeded);
	});
});
