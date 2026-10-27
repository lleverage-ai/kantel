/**
 * Conformance suite for `Skills` (packages/contracts/src/skills.ts). Every target registers it with a provider that
 * builds a fresh skills store on the suite's clock and audit sink, mounted at the default `/skills`.
 */
import type { CallContext, OwnerRef, SkillFile, SkillRevision, Skills } from "@harbour/contracts";
import {
	actors,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface SkillsSubject {
	readonly skills: Skills;
}

export type SkillsConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: SkillsSubject) => Promise<void>,
) => Promise<void>;

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";
const USER = "user-1";
const OTHER_USER = "user-2";
const HEX_DIGEST = /^[0-9a-f]{64}$/;

const human = contextFor(actors.human(USER), ORG, PROJECT);
const otherHuman = contextFor(actors.human(OTHER_USER), ORG, OTHER_PROJECT);
const service = contextFor(actors.service("sal-supervisor", "key-1"), ORG);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG, PROJECT);
const harbour = contextFor(actors.system("skills-seed"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);

const platform: OwnerRef = { kind: "platform" };
const organisation: OwnerRef = { kind: "organisation", organisationId: ORG };
const project: OwnerRef = { kind: "project", organisationId: ORG, projectId: PROJECT };
const otherProject: OwnerRef = { kind: "project", organisationId: ORG, projectId: OTHER_PROJECT };
const user: OwnerRef = { kind: "user", organisationId: ORG, userId: USER };
const otherUser: OwnerRef = { kind: "user", organisationId: ORG, userId: OTHER_USER };

function skillFiles(name: string, body: string, extra: readonly SkillFile[] = []): SkillFile[] {
	return [
		{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n` },
		{ path: "scripts/run.sh", content: `echo ${body}\n` },
		...extra,
	];
}

/** Creates a skill and publishes its first revision. */
async function publishNew(
	skills: Skills,
	ctx: CallContext,
	owner: OwnerRef,
	name: string,
	body = "Do the thing.",
): Promise<SkillRevision> {
	const pkg = await skills.create(ctx, { owner, name, description: `${name} skill` });
	const { digest } = await skills.saveDraft(ctx, pkg.id, { files: skillFiles(name, body) });
	return skills.publish(ctx, pkg.id, { expectedDigest: digest });
}

/** Publishes the next revision of an existing skill. */
async function publishNext(skills: Skills, ctx: CallContext, skillId: string, body: string): Promise<SkillRevision> {
	const { digest } = await skills.saveDraft(ctx, skillId, { files: skillFiles("next", body) });
	return skills.publish(ctx, skillId, { expectedDigest: digest });
}

function sortedKeys(value: object): string[] {
	return Object.keys(value).sort();
}

export function createSkillsConformance(options: {
	assertions: ConformanceAssertions;
	provider: SkillsConformanceProvider;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (name: string, body: (skills: Skills, deps: ConformanceDeps) => Promise<void>): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			await options.provider(deps, (subject) => body(subject.skills, deps));
		},
	});

	return [
		test("A published revision never changes when later drafts are saved and published", async (skills) => {
			const pkg = await skills.create(human, { owner: project, name: "pr-review", description: "Review PRs" });
			const files = skillFiles("pr-review", "Version one.");
			const { digest } = await skills.saveDraft(human, pkg.id, { files });
			// Changing the caller's objects after saving changes neither the draft nor what gets published.
			(files[0] as { content: string }).content = "tampered";
			files.push({ path: "late.md", content: "late" });
			const first = await skills.publish(human, pkg.id, { expectedDigest: digest });
			assert.strictEqual(first.revision, 1);
			assert.strictEqual(first.digest, digest);
			const snapshot = JSON.parse(JSON.stringify(first));
			const firstSkillMd = await skills.readFile(human, pkg.id, 1, "SKILL.md");
			assert.ok(firstSkillMd.includes("Version one."), "revision 1 holds the saved SKILL.md");
			await assert.rejectsWithCode(skills.readFile(human, pkg.id, 1, "late.md"), "not_found");

			// Changing a returned revision must not reach the stored one; a frozen revision refuses, which is as good.
			try {
				(first as { digest: string }).digest = "0".repeat(64);
			} catch {}
			try {
				(first.files as { path: string; size: number }[]).push({ path: "evil.sh", size: 1 });
			} catch {}
			const second = await publishNext(skills, human, pkg.id, "Version two.");
			assert.strictEqual(second.revision, 2);
			assert.ok(second.digest !== snapshot.digest, "the new revision has its own digest");
			await skills.saveDraft(human, pkg.id, { files: skillFiles("pr-review", "An unpublished draft.") });

			assert.deepEqual(await skills.getRevision(human, pkg.id, 1), snapshot, "revision 1 is as it was published");
			assert.strictEqual(await skills.readFile(human, pkg.id, 1, "SKILL.md"), firstSkillMd);
			assert.ok((await skills.readFile(human, pkg.id, 2, "SKILL.md")).includes("Version two."));
		}),

		test("Publishing needs the digest of the reviewed draft", async (skills) => {
			const pkg = await skills.create(human, { owner: organisation, name: "deploy", description: "Deploy" });
			await assert.rejectsWithCode(
				skills.publish(human, pkg.id, { expectedDigest: "0".repeat(64) }),
				"conflict",
				"there is no draft to publish",
			);
			const reviewed = await skills.saveDraft(human, pkg.id, { files: skillFiles("deploy", "Reviewed.") });
			assert.ok(HEX_DIGEST.test(reviewed.digest), "a digest is hex SHA-256");
			assert.strictEqual((await skills.get(human, pkg.id)).draftDigest, reviewed.digest);
			const changed = await skills.saveDraft(agent, pkg.id, { files: skillFiles("deploy", "Changed after review.") });
			assert.ok(changed.digest !== reviewed.digest);
			await assert.rejectsWithCode(
				skills.publish(human, pkg.id, { expectedDigest: reviewed.digest }),
				"conflict",
				"the draft changed after review",
			);
			assert.strictEqual((await skills.listRevisions(human, pkg.id)).items.length, 0, "nothing was published");
			const revision = await skills.publish(human, pkg.id, { expectedDigest: changed.digest });
			assert.strictEqual(revision.digest, changed.digest);
			assert.ok((await skills.readFile(human, pkg.id, 1, "SKILL.md")).includes("Changed after review."));
		}),

		test("An agent may save a draft but may not create, publish or import a skill", async (skills, deps) => {
			await assert.rejectsWithCode(
				skills.create(agent, { owner: project, name: "agent-made", description: "No" }),
				"forbidden",
			);
			const pkg = await skills.create(human, { owner: project, name: "triage", description: "Triage issues" });
			const { digest } = await skills.saveDraft(agent, pkg.id, {
				files: skillFiles("triage", "Proposed by an agent."),
			});
			assert.strictEqual((await skills.readDraft(agent, pkg.id)).length, 2, "the agent can read its draft back");
			await assert.rejectsWithCode(skills.publish(agent, pkg.id, { expectedDigest: digest }), "forbidden");
			await assert.rejectsWithCode(
				skills.importRevision(agent, {
					owner: project,
					name: "triage",
					description: "Triage issues",
					files: skillFiles("triage", "Imported by an agent."),
					source: { sourceId: "git", ref: "abc" },
				}),
				"forbidden",
			);
			assert.strictEqual((await skills.listRevisions(human, pkg.id)).items.length, 0, "the agent published nothing");
			const revision = await skills.publish(human, pkg.id, { expectedDigest: digest });
			assert.strictEqual(revision.revision, 1, "a human publishes what the agent proposed");
			assert.partialDeepEqual(deps.audit.ofType("skills.package.created"), [
				{ actor: human.actor, subject: { kind: "skills.skill", id: pkg.id } },
			]);
			const saved = deps.audit.ofType("skills.draft.saved");
			assert.partialDeepEqual(saved, [{ actor: agent.actor, subject: { id: pkg.id }, data: { digest } }]);
			assert.ok(!JSON.stringify(saved).includes("Proposed by an agent."), "audit never holds file contents");
			const other = await skills.saveDraft(human, pkg.id, { files: skillFiles("triage", "Second thoughts.") });
			await skills.saveDraft(agent, pkg.id, { files: skillFiles("triage", "Proposed by an agent.") });
			const all = deps.audit.ofType("skills.draft.saved");
			assert.strictEqual(all.length, 3, "going back to an earlier draft is audited again");
			assert.partialDeepEqual(all, [
				{ data: { digest } },
				{ actor: human.actor, data: { digest: other.digest } },
				{ actor: agent.actor, data: { digest } },
			]);
		}),

		test("Publishing a draft identical to the latest revision creates no new revision", async (skills, deps) => {
			const first = await publishNew(skills, human, organisation, "lint", "Run the linter.");
			const reordered = skillFiles("lint", "Run the linter.").reverse();
			const { digest } = await skills.saveDraft(human, first.skillId, { files: reordered });
			assert.strictEqual(digest, first.digest, "the digest does not depend on file order");
			deps.clock.advance(60_000);
			const again = await skills.publish(service, first.skillId, { expectedDigest: digest });
			assert.deepEqual(again, first, "the latest revision comes back unchanged");
			assert.strictEqual((await skills.listRevisions(human, first.skillId)).items.length, 1);
			assert.strictEqual(deps.audit.ofType("skills.revision.published").length, 1);
			const pkg = await skills.get(human, first.skillId);
			assert.strictEqual(pkg.latestRevision, 1);
			assert.strictEqual(pkg.draftDigest, undefined, "the draft is closed");
		}),

		test("A draft without SKILL.md or with a path outside the package is invalid", async (skills) => {
			const pkg = await skills.create(human, { owner: project, name: "paths", description: "Paths" });
			const skillMd: SkillFile = { path: "SKILL.md", content: "---\nname: paths\n---\n" };
			const bad: readonly (readonly SkillFile[])[] = [
				[],
				[{ path: "README.md", content: "no SKILL.md" }],
				[{ path: "docs/SKILL.md", content: "not at the root" }],
				[skillMd, { path: "../x", content: "escape" }],
				[skillMd, { path: "/abs", content: "absolute" }],
				[skillMd, { path: "scripts/../../x", content: "escape" }],
				[skillMd, { path: "scripts//run.sh", content: "empty segment" }],
				[skillMd, { path: "./SKILL.md", content: "the same path twice" }],
			];
			for (const files of bad) {
				await assert.rejectsWithCode(
					skills.saveDraft(human, pkg.id, { files }),
					"invalid",
					`refuses ${JSON.stringify(files.map((file) => file.path))}`,
				);
			}
			assert.strictEqual((await skills.get(human, pkg.id)).draftDigest, undefined, "no draft was saved");
			const { digest } = await skills.saveDraft(human, pkg.id, {
				files: [skillMd, { path: "./scripts/run.sh", content: "echo ok" }],
			});
			assert.deepEqual(
				(await skills.readDraft(human, pkg.id)).map((file) => file.path).sort(),
				["SKILL.md", "scripts/run.sh"],
				"paths are stored normalised",
			);
			await skills.publish(human, pkg.id, { expectedDigest: digest });
			assert.strictEqual(await skills.readFile(human, pkg.id, 1, "scripts/run.sh"), "echo ok");
		}),

		test("A session lists platform, organisation, its project's and its user's skills, never another project's or user's, and the most specific owner wins a name clash", async (skills) => {
			await publishNew(skills, harbour, platform, "pr-review", "Platform.");
			const platformOnly = await publishNew(skills, harbour, platform, "platform-only");
			const orgReview = await publishNew(skills, human, organisation, "pr-review", "Organisation.");
			const projectReview = await publishNew(skills, human, project, "pr-review", "Project.");
			const userReview = await publishNew(skills, human, user, "pr-review", "User.");
			await publishNew(skills, human, organisation, "deploy");
			await publishNew(skills, human, project, "project-only");
			await publishNew(skills, human, user, "user-only");
			await publishNew(skills, otherHuman, otherProject, "other-project-only");
			await publishNew(skills, otherHuman, otherUser, "other-user-only");
			await publishNew(skills, otherHuman, otherProject, "user-only", "Another project's clash.");
			await skills.create(human, { owner: organisation, name: "unpublished", description: "Never published" });

			const full = (await skills.list(agent, { projectId: PROJECT, userId: USER })).items;
			assert.deepEqual(
				full.map((listing) => listing.name),
				["deploy", "platform-only", "pr-review", "project-only", "user-only"],
			);
			const review = full.find((listing) => listing.name === "pr-review")!;
			assert.strictEqual(review.skillId, userReview.skillId, "the user's skill wins");
			assert.strictEqual(review.path, "/skills/pr-review/SKILL.md");
			assert.strictEqual(review.revision, 1);
			assert.strictEqual(review.description, "pr-review skill");

			const projectOnly = (await skills.list(agent, { projectId: PROJECT })).items;
			assert.deepEqual(
				projectOnly.map((listing) => listing.name),
				["deploy", "platform-only", "pr-review", "project-only"],
			);
			assert.strictEqual(projectOnly.find((listing) => listing.name === "pr-review")!.skillId, projectReview.skillId);

			const organisationOnly = (await skills.list(human, {})).items;
			assert.deepEqual(
				organisationOnly.map((listing) => listing.name),
				["deploy", "platform-only", "pr-review"],
			);
			assert.strictEqual(organisationOnly.find((listing) => listing.name === "pr-review")!.skillId, orgReview.skillId);

			const elsewhere = (await skills.list(outsider, { projectId: PROJECT, userId: USER })).items;
			assert.deepEqual(
				elsewhere.map((listing) => listing.name),
				["platform-only", "pr-review"],
				"another organisation sees only platform skills",
			);
			assert.strictEqual(elsewhere.find((listing) => listing.name === "platform-only")!.skillId, platformOnly.skillId);
		}),

		test("Pins are fixed per session: a later revision reaches only new sessions", async (skills, deps) => {
			const review = await publishNew(skills, human, project, "pr-review", "One.");
			const visibility = { projectId: PROJECT, userId: USER };
			const pinned = await skills.pinForSession(agent, "session-1", visibility);
			assert.deepEqual(pinned, [
				{ sessionId: "session-1", skillId: review.skillId, revision: 1, pinnedAt: deps.clock.now() },
			]);
			deps.clock.advance(60_000);
			await publishNext(skills, human, review.skillId, "Two.");
			const deploy = await publishNew(skills, human, organisation, "deploy");
			assert.deepEqual(
				await skills.pinForSession(agent, "session-1", visibility),
				pinned,
				"the session keeps its pins",
			);
			assert.deepEqual(await skills.pinForSession(human, "session-1", {}), pinned, "whatever the later visibility");
			const fresh = await skills.pinForSession(human, "session-2", visibility);
			assert.deepEqual(
				[...fresh].sort((a, b) => a.skillId.localeCompare(b.skillId)),
				[
					{ sessionId: "session-2", skillId: review.skillId, revision: 2, pinnedAt: deps.clock.now() },
					{ sessionId: "session-2", skillId: deploy.skillId, revision: 1, pinnedAt: deps.clock.now() },
				].sort((a, b) => a.skillId.localeCompare(b.skillId)),
				"a new session pins the latest revisions",
			);
			assert.deepEqual(await skills.pinForSession(outsider, "session-1", {}), [], "pins are per organisation");
			const pinEvents = deps.audit.ofType("skills.session.pinned");
			assert.strictEqual(pinEvents.length, 3, "each session's first pin is audited once");
			assert.partialDeepEqual(pinEvents[0], { actor: agent.actor, sessionId: "session-1" });
		}),

		test("An import leaves an open draft open", async (skills) => {
			const pkg = await skills.create(human, { owner: project, name: "release", description: "Cut a release" });
			const { digest } = await skills.saveDraft(human, pkg.id, { files: skillFiles("release", "Draft in review.") });
			const imported = await skills.importRevision(service, {
				owner: project,
				name: "release",
				description: "Cut a release",
				files: skillFiles("release", "From commit abc."),
				source: { sourceId: "sal-git", ref: "abc" },
			});
			assert.strictEqual(imported.skillId, pkg.id);
			const after = await skills.get(human, pkg.id);
			assert.strictEqual(after.draftDigest, digest, "get still shows the open draft");
			assert.ok((await skills.readDraft(human, pkg.id)).some((file) => file.content.includes("Draft in review.")));
			const published = await skills.publish(human, pkg.id, { expectedDigest: digest });
			assert.strictEqual(published.revision, 2, "publishing the draft makes the next revision");
			assert.strictEqual((await skills.get(human, pkg.id)).draftDigest, undefined, "publishing closes the draft");
		}),

		test("An agent may pin skills only for its own session", async (skills) => {
			await publishNew(skills, human, project, "pr-review");
			await assert.rejectsWithCode(skills.pinForSession(agent, "session-9", { projectId: PROJECT }), "forbidden");
			assert.strictEqual(
				(await skills.pinForSession(human, "session-9", {})).length,
				0,
				"the refused call pinned nothing for that session",
			);
		}),

		test("Imports are idempotent by source and ref, and a new ref publishes a new revision", async (skills, deps) => {
			const input = {
				owner: project,
				name: "release",
				description: "Cut a release",
				files: skillFiles("release", "From commit abc."),
				source: { sourceId: "sal-git", ref: "abc" },
				extensions: { "sal.trigger": { on: "tag" } },
			};
			const first = await skills.importRevision(service, input);
			assert.strictEqual(first.revision, 1);
			assert.deepEqual(first.source, { sourceId: "sal-git", ref: "abc" });
			assert.deepEqual(first.extensions, { "sal.trigger": { on: "tag" } });
			const again = await skills.importRevision(service, {
				...input,
				files: skillFiles("release", "Different files."),
			});
			assert.deepEqual(again, first, "the same source and ref return the same revision");
			assert.ok((await skills.readFile(human, first.skillId, 1, "SKILL.md")).includes("From commit abc."));

			const sibling = await skills.importRevision(service, {
				...input,
				name: "hotfix",
				files: skillFiles("hotfix", "Also at abc."),
			});
			assert.ok(sibling.skillId !== first.skillId, "another skill at the same ref is its own package");
			assert.strictEqual(sibling.revision, 1);

			const next = await skills.importRevision(human, {
				...input,
				files: skillFiles("release", "From commit def."),
				source: { sourceId: "sal-git", ref: "def" },
			});
			assert.strictEqual(next.skillId, first.skillId);
			assert.strictEqual(next.revision, 2);
			const pkg = await skills.get(human, first.skillId);
			assert.strictEqual(pkg.latestRevision, 2);
			assert.deepEqual(pkg.source, { sourceId: "sal-git", ref: "def" });
			assert.strictEqual((await skills.listRevisions(human, first.skillId)).items.length, 2);
			assert.strictEqual(deps.audit.ofType("skills.revision.published").length, 3, "each new revision is audited once");
		}),

		test("Names are unique per owner, and the same name under another owner is fine", async (skills) => {
			const created = await skills.create(human, { owner: organisation, name: "deploy", description: "Deploy" });
			await assert.rejectsWithCode(
				skills.create(service, { owner: organisation, name: "deploy", description: "Again" }),
				"conflict",
			);
			const imported = await skills.importRevision(service, {
				owner: organisation,
				name: "deploy",
				description: "Imported",
				files: [{ path: "SKILL.md", content: "x" }],
				source: { sourceId: "git", ref: "abc" },
			});
			assert.strictEqual(imported.skillId, created.id, "an import publishes into the owner's package of that name");
			await skills.create(human, { owner: project, name: "deploy", description: "Project deploy" });
			await skills.create(human, { owner: otherProject, name: "deploy", description: "Other project deploy" });
			await skills.create(human, { owner: user, name: "deploy", description: "User deploy" });
			await skills.create(harbour, { owner: platform, name: "deploy", description: "Platform deploy" });
			await skills.create(outsider, {
				owner: { kind: "organisation", organisationId: OTHER_ORG },
				name: "deploy",
				description: "Another organisation's deploy",
			});
			for (const name of ["", "Deploy", "deploy_now", "deploy now", "a".repeat(65)]) {
				await assert.rejectsWithCode(
					skills.create(human, { owner: organisation, name, description: "Bad" }),
					"invalid",
					`refuses the name ${JSON.stringify(name)}`,
				);
			}
			await skills.create(human, { owner: organisation, name: `a-1${"b".repeat(61)}`, description: "64 characters" });
		}),

		test("Only Harbour may create or change platform skills, and every organisation sees them", async (skills) => {
			await assert.rejectsWithCode(
				skills.create(human, { owner: platform, name: "builtin", description: "Built in" }),
				"forbidden",
			);
			await assert.rejectsWithCode(
				skills.importRevision(service, {
					owner: platform,
					name: "builtin",
					description: "Built in",
					files: skillFiles("builtin", "x"),
					source: { sourceId: "git", ref: "abc" },
				}),
				"forbidden",
			);
			const revision = await publishNew(skills, harbour, platform, "builtin", "Harbour's own.");
			assert.strictEqual((await skills.get(outsider, revision.skillId)).name, "builtin");
			assert.ok((await skills.readFile(outsider, revision.skillId, 1, "SKILL.md")).includes("Harbour's own."));
			await assert.rejectsWithCode(
				skills.saveDraft(human, revision.skillId, { files: skillFiles("builtin", "Hijacked.") }),
				"forbidden",
			);
			await assert.rejectsWithCode(
				skills.saveDraft(agent, revision.skillId, { files: skillFiles("builtin", "Hijacked.") }),
				"forbidden",
			);
			await assert.rejectsWithCode(
				skills.publish(outsider, revision.skillId, { expectedDigest: revision.digest }),
				"forbidden",
			);
			assert.strictEqual((await skills.get(human, revision.skillId)).draftDigest, undefined);
		}),

		test("Another organisation's skills are not found and never listed", async (skills) => {
			const revision = await publishNew(skills, human, organisation, "deploy");
			const id = revision.skillId;
			await skills.saveDraft(human, id, { files: skillFiles("deploy", "Draft.") });
			await assert.rejectsWithCode(skills.get(outsider, id), "not_found");
			await assert.rejectsWithCode(skills.readDraft(outsider, id), "not_found");
			await assert.rejectsWithCode(
				skills.saveDraft(outsider, id, { files: skillFiles("deploy", "Overwritten.") }),
				"not_found",
			);
			await assert.rejectsWithCode(skills.publish(outsider, id, { expectedDigest: revision.digest }), "not_found");
			await assert.rejectsWithCode(skills.getRevision(outsider, id, 1), "not_found");
			await assert.rejectsWithCode(skills.readFile(outsider, id, 1, "SKILL.md"), "not_found");
			await assert.rejectsWithCode(skills.listRevisions(outsider, id), "not_found");
			await assert.rejectsWithCode(
				skills.create(outsider, { owner: organisation, name: "planted", description: "In another organisation" }),
				"invalid",
			);
			assert.deepEqual((await skills.list(outsider, { projectId: PROJECT, userId: USER })).items, []);
			assert.deepEqual(await skills.pinForSession(outsider, "outsider-session", { projectId: PROJECT }), []);
			assert.ok((await skills.readDraft(human, id)).length > 0, "the owner's draft is untouched");
		}),

		test("Revisions record who published them and when, and listRevisions pages newest first", async (skills, deps) => {
			const start = deps.clock.now();
			const first = await publishNew(skills, human, project, "pr-review", "One.");
			deps.clock.advance(1_000);
			const second = await publishNext(skills, service, first.skillId, "Two.");
			deps.clock.advance(1_000);
			const third = await publishNext(skills, otherHuman, first.skillId, "Three.");
			assert.deepEqual(
				[first, second, third].map((revision) => [revision.revision, revision.publishedBy, revision.publishedAt]),
				[
					[1, human.actor, start],
					[2, service.actor, start + 1_000],
					[3, otherHuman.actor, start + 2_000],
				],
			);
			const page = await skills.listRevisions(human, first.skillId, { limit: 2 });
			assert.deepEqual(
				page.items.map((revision) => revision.revision),
				[3, 2],
			);
			assert.ok(page.nextCursor !== undefined, "a second page follows");
			const rest = await skills.listRevisions(human, first.skillId, { limit: 2, cursor: page.nextCursor! });
			assert.deepEqual(rest.items, [first]);
			assert.strictEqual(rest.nextCursor, undefined);
			const published = deps.audit.ofType("skills.revision.published");
			assert.strictEqual(published.length, 3);
			assert.partialDeepEqual(published[1], {
				source: "skills",
				actor: service.actor,
				organisationId: ORG,
				at: start + 1_000,
				subject: { id: first.skillId },
			});
		}),

		test("A skill grants nothing: a revision and its listing expose only their documented keys", async (skills) => {
			const revision = await publishNew(skills, human, project, "pr-review", "Review.");
			assert.deepEqual(sortedKeys(revision), [
				"description",
				"digest",
				"files",
				"name",
				"publishedAt",
				"publishedBy",
				"revision",
				"skillId",
			]);
			for (const file of revision.files) assert.deepEqual(sortedKeys(file), ["path", "size"]);
			const skillMd = await skills.readFile(human, revision.skillId, 1, "SKILL.md");
			assert.strictEqual(
				revision.files.find((file) => file.path === "SKILL.md")!.size,
				new TextEncoder().encode(skillMd).length,
				"a file's size is its UTF-8 length",
			);
			const [listing] = (await skills.list(agent, { projectId: PROJECT })).items;
			assert.deepEqual(sortedKeys(listing!), ["description", "name", "path", "revision", "skillId"]);
		}),
	];
}

export function registerSkillsConformance(
	runner: ConformanceRunner,
	name: string,
	provider: SkillsConformanceProvider,
): void {
	registerCases(runner, name, createSkillsConformance({ assertions: createExpectAssertions(runner.expect), provider }));
}
