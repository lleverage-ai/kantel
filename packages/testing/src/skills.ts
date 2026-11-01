/**
 * Conformance suite for `Skills` (packages/contracts/src/skills.ts). Every target registers it with a provider that
 * builds a fresh skills store on the suite's clock, audit sink and project access, mounted at the default `/skills`,
 * with the case's `SkillsSettings`.
 */
import type { CallContext, OwnerRef, SkillFile, SkillRevision, Skills, SkillsAuthority } from "@kantel/contracts";
import {
	actors,
	assertAccessDenied,
	type ConformanceAssertions,
	type ConformanceCase,
	type ConformanceDeps,
	type ConformanceOptions,
	type ConformanceRunner,
	contextFor,
	createDeps,
	createExpectAssertions,
	registerCases,
} from "./harness.ts";

export interface SkillsSubject {
	readonly skills: Skills;
}

/**
 * What a case asks the store to be built with, beyond the deps: only the `writes` cases set it, and a provider
 * registered with `writes: true` must pass it on.
 */
export interface SkillsSettings {
	readonly authority?: SkillsAuthority;
}

export type SkillsConformanceProvider = (
	deps: ConformanceDeps,
	use: (subject: SkillsSubject) => Promise<void>,
	settings: SkillsSettings,
) => Promise<void>;

export interface SkillsConformanceOptions extends ConformanceOptions {
	/** Runs the write cases that build the store with a stricter `SkillsAuthority`. Needs `projectAccess` too. */
	readonly writes?: boolean;
}

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";
const USER = "user-1";
const OTHER_USER = "user-2";
const HEX_DIGEST = /^[0-9a-f]{64}$/;

const human = contextFor(actors.human(USER), ORG, PROJECT);
const otherHuman = contextFor(actors.human(OTHER_USER), ORG, OTHER_PROJECT);
const service = contextFor(actors.service("atlas-supervisor", "key-1"), ORG);
const agent = contextFor(actors.agent("agent-1", "session-1"), ORG, PROJECT);
const harbour = contextFor(actors.system("skills-seed"), ORG);
const outsider = contextFor(actors.human("outsider-1"), OTHER_ORG);
const outsiderService = contextFor(actors.service("outsider-service"), OTHER_ORG);
/** An operator in the organisation, but only on another project. */
const stranger = contextFor(actors.human("user-3"), ORG, OTHER_PROJECT);
/** A viewer on the project. */
const viewer = contextFor(actors.human("user-4"), ORG, PROJECT);
/** An agent whose session belongs to another project. */
const otherProjectAgent = contextFor(actors.agent("agent-3", "session-other-project"), ORG, OTHER_PROJECT);
/** An admin across the organisation. */
const admin = contextFor(actors.human("admin-1"), ORG);
/** A user of the organisation with no role anywhere, who owns skills of their own. */
const solo = contextFor(actors.human("solo-1"), ORG);

/** The role bindings and agent sessions every case acts with. */
function seedTenancy(deps: ConformanceDeps): void {
	const tenancy = deps.tenancy;
	// Organisation-wide, so they may change the organisation's skills as well as the projects'.
	tenancy.bind(human.actor, ORG, "operator");
	tenancy.bind(service.actor, ORG, "operator");
	tenancy.bind(admin.actor, ORG, "admin");
	// On both projects only: changing the organisation's skills or another user's needs more.
	for (const projectId of [PROJECT, OTHER_PROJECT]) {
		tenancy.bind(otherHuman.actor, ORG, "operator", projectId);
	}
	tenancy.bind(stranger.actor, ORG, "operator", OTHER_PROJECT);
	tenancy.bind(viewer.actor, ORG, "viewer", PROJECT);
	tenancy.bind(outsider.actor, OTHER_ORG, "operator");
	tenancy.bind(outsiderService.actor, OTHER_ORG, "viewer");
	tenancy.session({ id: "session-1", organisationId: ORG, projectId: PROJECT, agentId: "agent-1" });
	tenancy.session({ id: "session-2", organisationId: ORG, projectId: PROJECT, agentId: "agent-2" });
	tenancy.session({ id: "session-9", organisationId: ORG, projectId: PROJECT, agentId: "agent-9" });
	tenancy.session({ id: "session-other-project", organisationId: ORG, projectId: OTHER_PROJECT, agentId: "agent-3" });
	tenancy.session({ id: "outsider-session", organisationId: OTHER_ORG, projectId: PROJECT, agentId: "agent-8" });
}

const platform: OwnerRef = { kind: "platform" };
const organisation: OwnerRef = { kind: "organisation", organisationId: ORG };
const project: OwnerRef = { kind: "project", organisationId: ORG, projectId: PROJECT };
const otherProject: OwnerRef = { kind: "project", organisationId: ORG, projectId: OTHER_PROJECT };
const user: OwnerRef = { kind: "user", organisationId: ORG, userId: USER };
const otherUser: OwnerRef = { kind: "user", organisationId: ORG, userId: OTHER_USER };
const soloUser: OwnerRef = { kind: "user", organisationId: ORG, userId: "solo-1" };

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
	projectAccess?: boolean;
	writes?: boolean;
}): readonly ConformanceCase[] {
	const assert = options.assertions;
	const test = (
		name: string,
		body: (skills: Skills, deps: ConformanceDeps) => Promise<void>,
		settings: SkillsSettings = {},
	): ConformanceCase => ({
		name,
		run: async () => {
			const deps = createDeps();
			seedTenancy(deps);
			await options.provider(deps, (subject) => body(subject.skills, deps), settings);
		},
	});

	const cases: ConformanceCase[] = [
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

			const full = (await skills.list(human, { projectId: PROJECT, userId: USER })).items;
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

			const elsewhere = (await skills.list(outsiderService, { projectId: PROJECT, userId: USER })).items;
			assert.deepEqual(
				elsewhere.map((listing) => listing.name),
				["platform-only", "pr-review"],
				"another organisation sees only platform skills",
			);
			assert.strictEqual(elsewhere.find((listing) => listing.name === "platform-only")!.skillId, platformOnly.skillId);
		}),

		test("Pins are fixed per session: a later revision reaches only new sessions", async (skills, deps) => {
			const review = await publishNew(skills, human, project, "pr-review", "One.");
			const visibility = { projectId: PROJECT };
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
			const fresh = await skills.pinForSession(human, "session-2", { projectId: PROJECT, userId: USER });
			assert.deepEqual(
				[...fresh].sort((a, b) => a.skillId.localeCompare(b.skillId)),
				[
					{ sessionId: "session-2", skillId: review.skillId, revision: 2, pinnedAt: deps.clock.now() },
					{ sessionId: "session-2", skillId: deploy.skillId, revision: 1, pinnedAt: deps.clock.now() },
				].sort((a, b) => a.skillId.localeCompare(b.skillId)),
				"a new session pins the latest revisions",
			);
			assert.deepEqual(
				await skills.pinForSession(outsider, "outsider-session", {}),
				[],
				"another organisation's session pins none of these",
			);
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
				source: { sourceId: "atlas-git", ref: "abc" },
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
				source: { sourceId: "atlas-git", ref: "abc" },
				extensions: { "atlas.trigger": { on: "tag" } },
			};
			const first = await skills.importRevision(service, input);
			assert.strictEqual(first.revision, 1);
			assert.deepEqual(first.source, { sourceId: "atlas-git", ref: "abc" });
			assert.deepEqual(first.extensions, { "atlas.trigger": { on: "tag" } });
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
				source: { sourceId: "atlas-git", ref: "def" },
			});
			assert.strictEqual(next.skillId, first.skillId);
			assert.strictEqual(next.revision, 2);
			const pkg = await skills.get(human, first.skillId);
			assert.strictEqual(pkg.latestRevision, 2);
			assert.deepEqual(pkg.source, { sourceId: "atlas-git", ref: "def" });
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

		test("Only Kantel may create or change platform skills, and every organisation sees them", async (skills) => {
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
			const revision = await publishNew(skills, harbour, platform, "builtin", "Kantel's own.");
			assert.strictEqual((await skills.get(outsider, revision.skillId)).name, "builtin");
			assert.ok((await skills.readFile(outsider, revision.skillId, 1, "SKILL.md")).includes("Kantel's own."));
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
			assert.deepEqual((await skills.list(outsiderService, { projectId: PROJECT, userId: USER })).items, []);
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
	if (options.projectAccess !== true) return cases;

	const withAccess: ConformanceCase[] = [
		...cases,

		test("project access: an operator outside the project is refused for every change and read of its skills, and nothing changed", async (skills, deps) => {
			const first = await publishNew(skills, human, project, "pr-review", "One.");
			const id = first.skillId;
			const { digest } = await skills.saveDraft(human, id, { files: skillFiles("pr-review", "Draft in review.") });
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused("skills.create", skills.create(stranger, { owner: project, name: "planted", description: "No" }));
			await refused(
				"skills.saveDraft",
				skills.saveDraft(stranger, id, { files: skillFiles("pr-review", "Overwritten.") }),
			);
			await refused("skills.publish", skills.publish(stranger, id, { expectedDigest: digest }));
			await refused(
				"skills.importRevision",
				skills.importRevision(stranger, {
					owner: project,
					name: "pr-review",
					description: "Imported",
					files: skillFiles("pr-review", "Imported."),
					source: { sourceId: "git", ref: "abc" },
				}),
			);
			await refused("skills.get", skills.get(stranger, id));
			await refused("skills.readDraft", skills.readDraft(stranger, id));
			await refused("skills.getRevision", skills.getRevision(stranger, id, 1));
			await refused("skills.readFile", skills.readFile(stranger, id, 1, "SKILL.md"));
			await refused("skills.listRevisions", skills.listRevisions(stranger, id));
			await refused("skills.list", skills.list(stranger, { projectId: PROJECT }));
			await refused("skills.pinForSession", skills.pinForSession(stranger, "session-2", {}));
			await refused("skills.pinForSession", skills.pinForSession(stranger, "session-2", { projectId: OTHER_PROJECT }));

			// The session must belong to the project the visibility names, even for an operator on both.
			await assertAccessDenied(assert, deps, skills.pinForSession(human, "session-2", { projectId: OTHER_PROJECT }), {
				operation: "skills.pinForSession",
				message: "pinning a session under another project's visibility",
			});

			const pkg = await skills.get(human, id);
			assert.strictEqual(pkg.draftDigest, digest, "the draft is untouched");
			assert.strictEqual(pkg.latestRevision, 1, "nothing was published");
			assert.strictEqual(deps.audit.ofType("skills.package.created").length, 1, "nothing was created");
			assert.strictEqual(deps.audit.ofType("skills.session.pinned").length, 0, "nothing was pinned");
			await skills.publish(human, id, { expectedDigest: digest });
			const pins = await skills.pinForSession(human, "session-2", { projectId: PROJECT });
			assert.deepEqual(
				pins.map((pin) => pin.revision),
				[2],
				"the refused pin left the session unpinned",
			);
			const theirs = await skills.create(stranger, { owner: otherProject, name: "pr-review", description: "Theirs" });
			assert.strictEqual(theirs.name, "pr-review", "the operator still works in its own project");
		}),

		test("project access: a viewer on the project may read its skills but not change them", async (skills, deps) => {
			const first = await publishNew(skills, human, project, "pr-review", "One.");
			const id = first.skillId;
			const { digest } = await skills.saveDraft(human, id, { files: skillFiles("pr-review", "Draft in review.") });
			assert.strictEqual((await skills.get(viewer, id)).latestRevision, 1);
			assert.strictEqual((await skills.readDraft(viewer, id)).length, 2);
			assert.strictEqual((await skills.getRevision(viewer, id, 1)).digest, first.digest);
			assert.ok((await skills.readFile(viewer, id, 1, "SKILL.md")).includes("One."));
			assert.strictEqual((await skills.listRevisions(viewer, id)).items.length, 1);
			assert.deepEqual(
				(await skills.list(viewer, { projectId: PROJECT })).items.map((listing) => listing.skillId),
				[id],
			);
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused("skills.create", skills.create(viewer, { owner: project, name: "planted", description: "No" }));
			await refused("skills.saveDraft", skills.saveDraft(viewer, id, { files: skillFiles("pr-review", "Changed.") }));
			await refused("skills.publish", skills.publish(viewer, id, { expectedDigest: digest }));
			await refused(
				"skills.importRevision",
				skills.importRevision(viewer, {
					owner: project,
					name: "pr-review",
					description: "Imported",
					files: skillFiles("pr-review", "Imported."),
					source: { sourceId: "git", ref: "abc" },
				}),
			);
			await refused("skills.pinForSession", skills.pinForSession(viewer, "session-2", { projectId: PROJECT }));
			const pkg = await skills.get(human, id);
			assert.strictEqual(pkg.draftDigest, digest, "the draft is untouched");
			assert.strictEqual(pkg.latestRevision, 1, "nothing was published");
		}),

		test("project access: an agent whose session belongs to another project is refused, and nothing changed", async (skills, deps) => {
			const first = await publishNew(skills, human, project, "pr-review", "One.");
			const id = first.skillId;
			const { digest } = await skills.saveDraft(human, id, { files: skillFiles("pr-review", "Draft in review.") });
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused(
				"skills.saveDraft",
				skills.saveDraft(otherProjectAgent, id, { files: skillFiles("pr-review", "Overwritten.") }),
			);
			await refused("skills.get", skills.get(otherProjectAgent, id));
			await refused("skills.readDraft", skills.readDraft(otherProjectAgent, id));
			await refused("skills.getRevision", skills.getRevision(otherProjectAgent, id, 1));
			await refused("skills.readFile", skills.readFile(otherProjectAgent, id, 1, "SKILL.md"));
			await refused("skills.listRevisions", skills.listRevisions(otherProjectAgent, id));
			await refused("skills.list", skills.list(otherProjectAgent, { projectId: PROJECT }));
			await refused(
				"skills.pinForSession",
				skills.pinForSession(otherProjectAgent, "session-other-project", { projectId: PROJECT }),
			);
			// Naming this project's session is refused before the project check: an agent pins only its own session.
			await assert.rejectsWithCode(
				skills.pinForSession(otherProjectAgent, "session-1", { projectId: PROJECT }),
				"forbidden",
			);
			assert.strictEqual((await skills.get(human, id)).draftDigest, digest, "the draft is untouched");
			assert.strictEqual(deps.audit.ofType("skills.session.pinned").length, 0, "nothing was pinned");
			const theirs = await skills.create(human, { owner: otherProject, name: "theirs", description: "Theirs" });
			await skills.saveDraft(otherProjectAgent, theirs.id, { files: skillFiles("theirs", "In its own project.") });
			assert.strictEqual((await skills.readDraft(otherProjectAgent, theirs.id)).length, 2);
		}),

		test("project access: an agent whose session was closed is refused", async (skills, deps) => {
			const first = await publishNew(skills, human, project, "pr-review", "One.");
			const id = first.skillId;
			const { digest } = await skills.saveDraft(agent, id, { files: skillFiles("pr-review", "Before the close.") });
			deps.tenancy.close("session-1");
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused(
				"skills.saveDraft",
				skills.saveDraft(agent, id, { files: skillFiles("pr-review", "After the close.") }),
			);
			await refused("skills.get", skills.get(agent, id));
			await refused("skills.readDraft", skills.readDraft(agent, id));
			await refused("skills.readFile", skills.readFile(agent, id, 1, "SKILL.md"));
			await refused("skills.list", skills.list(agent, { projectId: PROJECT }));
			await refused("skills.pinForSession", skills.pinForSession(agent, "session-1", { projectId: PROJECT }));
			assert.strictEqual((await skills.get(human, id)).draftDigest, digest, "the draft is untouched");
			assert.strictEqual(deps.audit.ofType("skills.session.pinned").length, 0, "nothing was pinned");
		}),

		test("project access: lists without a project filter leave out another project's skills for an operator outside it", async (skills) => {
			await publishNew(skills, human, organisation, "deploy");
			await publishNew(skills, human, project, "project-only");
			await publishNew(skills, stranger, otherProject, "theirs");
			assert.deepEqual(
				(await skills.list(stranger, {})).items.map((listing) => listing.name),
				["deploy"],
			);
			assert.deepEqual(
				(await skills.list(stranger, { projectId: OTHER_PROJECT })).items.map((listing) => listing.name),
				["deploy", "theirs"],
			);
		}),

		test("project access: a visibility may name only the calling human's own user; services and Kantel may name any user, agents none", async (skills, deps) => {
			await publishNew(skills, human, user, "mine");
			const deniedBefore = deps.audit.ofType("access.denied").length;
			await assert.rejectsWithCode(skills.list(otherHuman, { userId: USER }), "forbidden", "another human's user");
			await assert.rejectsWithCode(skills.list(agent, { projectId: PROJECT, userId: USER }), "forbidden", "an agent");
			await assert.rejectsWithCode(
				skills.pinForSession(agent, "session-1", { projectId: PROJECT, userId: USER }),
				"forbidden",
				"an agent pinning with a user",
			);
			await assert.rejectsWithCode(
				skills.pinForSession(otherHuman, "session-2", { projectId: PROJECT, userId: USER }),
				"forbidden",
				"another human pinning with a user",
			);
			assert.strictEqual(
				deps.audit.ofType("access.denied").length,
				deniedBefore,
				"naming a user is not a project check, so it audits no access.denied",
			);
			assert.strictEqual(deps.audit.ofType("skills.session.pinned").length, 0, "nothing was pinned");
			for (const caller of [human, service, harbour]) {
				assert.deepEqual(
					(await skills.list(caller, { userId: USER })).items.map((listing) => listing.name),
					["mine"],
				);
			}
			const pinned = await skills.pinForSession(human, "session-2", { projectId: PROJECT, userId: USER });
			assert.strictEqual(pinned.length, 1, "the human pins its own user's skill");
		}),

		test("project access: an operator on the project and an agent in its own session still work on its skills", async (skills, deps) => {
			const pkg = await skills.create(human, { owner: project, name: "triage", description: "Triage issues" });
			const { digest } = await skills.saveDraft(agent, pkg.id, { files: skillFiles("triage", "Proposed.") });
			assert.strictEqual((await skills.readDraft(agent, pkg.id)).length, 2);
			const revision = await skills.publish(service, pkg.id, { expectedDigest: digest });
			assert.strictEqual((await skills.get(agent, pkg.id)).latestRevision, 1);
			assert.strictEqual((await skills.getRevision(agent, pkg.id, 1)).digest, revision.digest);
			assert.ok((await skills.readFile(agent, pkg.id, 1, "SKILL.md")).includes("Proposed."));
			assert.strictEqual((await skills.listRevisions(agent, pkg.id)).items.length, 1);
			assert.deepEqual(
				(await skills.list(agent, { projectId: PROJECT })).items.map((listing) => listing.name),
				["triage"],
			);
			const pins = await skills.pinForSession(agent, "session-1", { projectId: PROJECT });
			assert.deepEqual(
				pins.map((pin) => [pin.skillId, pin.revision]),
				[[pkg.id, 1]],
			);
			const imported = await skills.importRevision(service, {
				owner: project,
				name: "triage",
				description: "Triage issues",
				files: skillFiles("triage", "From commit abc."),
				source: { sourceId: "atlas-git", ref: "abc" },
			});
			assert.strictEqual(imported.revision, 2);
			assert.strictEqual(deps.audit.ofType("access.denied").length, 0, "nothing was refused");
		}),

		test("write authority: changing an organisation's skill needs a role across the organisation, not on one project, and reading it does not", async (skills, deps) => {
			const first = await publishNew(skills, human, organisation, "deploy", "One.");
			const id = first.skillId;
			const { digest } = await skills.saveDraft(human, id, { files: skillFiles("deploy", "Draft in review.") });
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			// The stranger is an operator, but only on another project.
			await refused(
				"skills.create",
				skills.create(stranger, { owner: organisation, name: "planted", description: "No" }),
			);
			await refused(
				"skills.saveDraft",
				skills.saveDraft(stranger, id, { files: skillFiles("deploy", "Overwritten.") }),
			);
			await refused("skills.publish", skills.publish(stranger, id, { expectedDigest: digest }));
			await refused(
				"skills.importRevision",
				skills.importRevision(stranger, {
					owner: organisation,
					name: "deploy",
					description: "Imported",
					files: skillFiles("deploy", "Imported."),
					source: { sourceId: "git", ref: "abc" },
				}),
			);
			const pkg = await skills.get(human, id);
			assert.strictEqual(pkg.draftDigest, digest, "the draft is untouched");
			assert.strictEqual(pkg.latestRevision, 1, "nothing was published or imported");
			assert.strictEqual(deps.audit.ofType("skills.package.created").length, 1, "nothing was created");
			assert.ok((await skills.readDraft(human, id)).some((file) => file.content.includes("Draft in review.")));

			// Reading the organisation's skills is still open to its members.
			assert.strictEqual((await skills.get(stranger, id)).latestRevision, 1);
			assert.strictEqual((await skills.readDraft(stranger, id)).length, 2);
			assert.strictEqual((await skills.getRevision(stranger, id, 1)).digest, first.digest);
			assert.ok((await skills.readFile(stranger, id, 1, "SKILL.md")).includes("One."));
			assert.strictEqual((await skills.listRevisions(stranger, id)).items.length, 1);
			// An organisation-wide operator may change it.
			assert.strictEqual((await skills.publish(human, id, { expectedDigest: digest })).revision, 2);
		}),

		test("write authority: a user changes their own skill without a role; anyone else needs one across the organisation", async (skills, deps) => {
			const first = await publishNew(skills, solo, soloUser, "notes", "Mine.");
			assert.strictEqual(first.revision, 1, "a user with no role publishes their own skill");
			const id = first.skillId;
			const { digest } = await skills.saveDraft(solo, id, { files: skillFiles("notes", "Second thoughts.") });
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			// The other human is an operator on both projects, but not across the organisation.
			await refused(
				"skills.create",
				skills.create(otherHuman, { owner: soloUser, name: "planted", description: "No" }),
			);
			await refused(
				"skills.saveDraft",
				skills.saveDraft(otherHuman, id, { files: skillFiles("notes", "Overwritten.") }),
			);
			await refused("skills.publish", skills.publish(otherHuman, id, { expectedDigest: digest }));
			await refused(
				"skills.importRevision",
				skills.importRevision(otherHuman, {
					owner: soloUser,
					name: "notes",
					description: "Imported",
					files: skillFiles("notes", "Imported."),
					source: { sourceId: "git", ref: "abc" },
				}),
			);
			// The user with no role may not change anyone else's skills either.
			await refused("skills.create", skills.create(solo, { owner: user, name: "planted", description: "No" }));
			const pkg = await skills.get(solo, id);
			assert.strictEqual(pkg.draftDigest, digest, "the draft is untouched");
			assert.strictEqual(pkg.latestRevision, 1, "nothing was published or imported");
			assert.strictEqual(deps.audit.ofType("skills.package.created").length, 1, "nothing was created");

			assert.strictEqual((await skills.publish(solo, id, { expectedDigest: digest })).revision, 2);
			const imported = await skills.importRevision(solo, {
				owner: soloUser,
				name: "notes",
				description: "Imported",
				files: skillFiles("notes", "From my own repo."),
				source: { sourceId: "git", ref: "def" },
			});
			assert.strictEqual(imported.revision, 3, "the user imports into their own skill");
			// An organisation-wide operator may change it too.
			const next = await skills.saveDraft(service, id, { files: skillFiles("notes", "Tidied by a service.") });
			assert.strictEqual((await skills.publish(service, id, { expectedDigest: next.digest })).revision, 4);
		}),

		test("write authority: an agent saves a draft to an organisation's skill only through its own open session, and still may not publish", async (skills, deps) => {
			const first = await publishNew(skills, human, organisation, "deploy", "One.");
			const id = first.skillId;
			// Any project's agent may propose a change to the organisation's skill.
			const { digest } = await skills.saveDraft(otherProjectAgent, id, {
				files: skillFiles("deploy", "Proposed by an agent."),
			});
			assert.strictEqual((await skills.get(human, id)).draftDigest, digest);
			await assert.rejectsWithCode(skills.publish(otherProjectAgent, id, { expectedDigest: digest }), "forbidden");
			deps.tenancy.close("session-other-project");
			const refused = (operation: string, call: Promise<unknown>) =>
				assertAccessDenied(assert, deps, call, { operation });
			await refused(
				"skills.saveDraft",
				skills.saveDraft(otherProjectAgent, id, { files: skillFiles("deploy", "After the close.") }),
			);
			const ghost = contextFor(actors.agent("agent-ghost", "session-unknown"), ORG);
			await refused("skills.saveDraft", skills.saveDraft(ghost, id, { files: skillFiles("deploy", "From nowhere.") }));
			const pkg = await skills.get(human, id);
			assert.strictEqual(pkg.draftDigest, digest, "only the open session's draft was kept");
			assert.strictEqual(pkg.latestRevision, 1, "nothing was published");
			assert.strictEqual((await skills.publish(human, id, { expectedDigest: digest })).revision, 2);
		}),
	];
	if (options.writes !== true) return withAccess;

	const strict: SkillsSettings = {
		authority: { create: "admin", saveDraft: "operator", publish: "admin", importRevision: "admin" },
	};

	return [
		...withAccess,

		test(
			"writes: a store's authority sets the role each change needs, and a user's own skills need none",
			async (skills, deps) => {
				const refused = (operation: string, call: Promise<unknown>) =>
					assertAccessDenied(assert, deps, call, { operation });
				await refused(
					"skills.create",
					skills.create(human, { owner: organisation, name: "deploy", description: "Deploy" }),
				);
				const team = await skills.create(admin, { owner: organisation, name: "deploy", description: "Deploy" });
				const { digest } = await skills.saveDraft(human, team.id, { files: skillFiles("deploy", "By an operator.") });
				await refused("skills.publish", skills.publish(human, team.id, { expectedDigest: digest }));
				await refused(
					"skills.importRevision",
					skills.importRevision(human, {
						owner: organisation,
						name: "deploy",
						description: "Imported",
						files: skillFiles("deploy", "Imported."),
						source: { sourceId: "git", ref: "abc" },
					}),
				);
				const before = await skills.get(admin, team.id);
				assert.strictEqual(before.latestRevision, undefined, "nothing was published or imported");
				assert.strictEqual(before.draftDigest, digest, "the draft is untouched");
				assert.strictEqual((await skills.publish(admin, team.id, { expectedDigest: digest })).revision, 1);

				// On a project's skill the role is on the project; an agent still saves as an operator.
				const own = await skills.create(admin, { owner: project, name: "triage", description: "Triage issues" });
				const proposed = await skills.saveDraft(agent, own.id, { files: skillFiles("triage", "Proposed.") });
				await refused("skills.publish", skills.publish(service, own.id, { expectedDigest: proposed.digest }));
				assert.strictEqual((await skills.get(admin, own.id)).latestRevision, undefined, "nothing was published");
				assert.strictEqual((await skills.publish(admin, own.id, { expectedDigest: proposed.digest })).revision, 1);

				// A user still changes their own skills without a role.
				assert.strictEqual((await publishNew(skills, solo, soloUser, "notes", "Mine.")).revision, 1);
			},
			strict,
		),

		test(
			"writes: an authority needing admin to save drafts shuts agents out, since an agent counts as an operator",
			async (skills, deps) => {
				const own = await skills.create(admin, { owner: project, name: "triage", description: "Triage issues" });
				const team = await skills.create(admin, { owner: organisation, name: "deploy", description: "Deploy" });
				for (const pkg of [own, team]) {
					await assertAccessDenied(
						assert,
						deps,
						skills.saveDraft(agent, pkg.id, { files: skillFiles(pkg.name, "Proposed.") }),
						{ operation: "skills.saveDraft", message: `an agent saving a draft of ${pkg.name}` },
					);
					assert.strictEqual((await skills.get(admin, pkg.id)).draftDigest, undefined, "no draft was saved");
				}
				const { digest } = await skills.saveDraft(admin, own.id, { files: skillFiles("triage", "By an admin.") });
				assert.strictEqual((await skills.get(admin, own.id)).draftDigest, digest);
			},
			{ authority: { create: "admin", saveDraft: "admin", publish: "admin", importRevision: "admin" } },
		),
	];
}

export function registerSkillsConformance(
	runner: ConformanceRunner,
	name: string,
	provider: SkillsConformanceProvider,
	options?: SkillsConformanceOptions,
): void {
	registerCases(
		runner,
		name,
		createSkillsConformance({
			assertions: createExpectAssertions(runner.expect),
			provider,
			...(options?.projectAccess === undefined ? {} : { projectAccess: options.projectAccess }),
			...(options?.writes === undefined ? {} : { writes: options.writes }),
		}),
	);
}
