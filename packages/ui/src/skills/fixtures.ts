// The skills page's fixtures: an in-memory `Skills` (from @kantel/skills) holding built-in, organisation, project and
// personal skills, published over the weeks before FIXTURE_NOW through the store's own create, saveDraft, publish and
// importRevision, so revisions, digests and listings are what the real store made.

import type { CallContext, Clock, SkillFile, Skills, SkillVisibility } from "@kantel/contracts";
import { createMemorySkills } from "@kantel/skills/memory";
import { directory } from "../audit/fixtures.ts";
import { DAY, HOUR } from "../primitives/format.ts";
import { FIXTURE_NOW } from "../session/fixtures.ts";
import {
	bindSkills,
	bindSkillsAuthor,
	type OwnerChoice,
	type SkillsAuthor,
	type SkillsSource,
} from "./skills-model.ts";

export { directory, FIXTURE_NOW };

export const ORGANISATION = "org_harbour";
export const VIEWER = "usr_tom";

const TOM: CallContext = { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION };
const ALEX: CallContext = { actor: { kind: "human", userId: "usr_alex" }, organisationId: ORGANISATION };
const SYNC: CallContext = { actor: { kind: "service", serviceId: "skills-sync" }, organisationId: ORGANISATION };
const HARBOUR: CallContext = { actor: { kind: "system", component: "skills" }, organisationId: ORGANISATION };

/** What a session in the Billing project, opened by Tom, sees. */
export const BILLING_VISIBILITY: SkillVisibility = { projectId: "prj_billing", userId: VIEWER };

export const projectChoices = [
	{ value: "prj_billing", label: "Billing" },
	{ value: "prj_platform", label: "Platform" },
	{ value: "prj_web", label: "Website" },
];

/** Where Tom, in Billing, may put a new skill: himself, Billing's sessions or the whole organisation. */
export const ownerChoices: readonly OwnerChoice[] = [
	{ label: "Yours", owner: { kind: "user", organisationId: ORGANISATION, userId: VIEWER } },
	{ label: "Billing project", owner: { kind: "project", organisationId: ORGANISATION, projectId: "prj_billing" } },
	{ label: "Organisation", owner: { kind: "organisation", organisationId: ORGANISATION } },
];

const skillMd = (name: string, description: string, body: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

const PR_REVIEW_V1 = skillMd(
	"pr-review",
	"Review a pull request for correctness, security and tests. Use for review this PR or check before merge.",
	`
# PR review

Read the diff and the linked issue, then review it.

1. Check that the change does what the issue asks.
2. Look for security problems: secrets, injection, missing auth checks.
3. Check the tests cover the change.

Write the review as a list of findings, most important first.
`,
);

const PR_REVIEW_V3 = skillMd(
	"pr-review",
	"Review a pull request for correctness, security, conventions and tests, with explicit verification. Use for review this PR, code review or check before merge.",
	`
# PR review

Read the diff, the linked issue and the repository's own instructions (AGENTS.md or CLAUDE.md) before reviewing.

## Steps

1. Check that the change does what the issue asks, and nothing else.
2. Look for security problems: secrets, injection, missing auth checks, unsafe deserialisation.
3. Check the repository's conventions: naming, error handling, logging.
4. Run the tests the change touches with \`scripts/run-tests.sh\`, and say which you ran.

## Writing it up

- Lead with what blocks the merge, then what should change, then nits.
- Quote the line you mean, with its path and line number.
- Say what you couldn't verify.

See [references/checklist.md](references/checklist.md) for the full checklist.
`,
);

const CHECKLIST = `# Review checklist

- [ ] The change matches the issue
- [ ] No secrets in code, config or tests
- [ ] Errors are handled where they happen
- [ ] New code has tests, and they fail without the change
- [ ] Docs and changelog updated when behaviour changes
`;

const RUN_TESTS = `#!/usr/bin/env bash
# Runs the tests for the files a pull request touches.
set -euo pipefail
base="\${1:-origin/main}"
changed=$(git diff --name-only "$base"...HEAD)
echo "Changed files:"
echo "$changed"
pnpm vitest run --changed "$base"
`;

const files = (...entries: [string, string][]): SkillFile[] => entries.map(([path, content]) => ({ path, content }));

export interface SkillsScenario {
	/** The store itself, for what the page doesn't do, such as pinning a session's skills. */
	readonly store: Skills;
	readonly source: SkillsSource;
	/** Tom's writes. */
	readonly author: SkillsAuthor;
	/** Skill IDs by name. */
	readonly ids: Readonly<Record<string, string>>;
}

/** Builds the store and publishes the fixture's skills. `empty` publishes nothing. */
export async function createSkillsScenario(options: { readonly empty?: boolean } = {}): Promise<SkillsScenario> {
	let now = FIXTURE_NOW - 40 * DAY;
	const clock: Clock = { now: () => now };
	const store = createMemorySkills({ clock });
	const ids: Record<string, string> = {};
	const source = bindSkills(store, TOM);
	const author = bindSkillsAuthor(store, TOM);
	if (options.empty === true) return { store, source, author, ids };

	/** Creates a package and publishes each set of files as a revision, a few days apart. */
	const publish = async (
		by: CallContext,
		owner: Parameters<typeof store.create>[1]["owner"],
		name: string,
		description: string,
		revisions: readonly { files: SkillFile[] }[],
		gap = 5 * DAY,
	) => {
		const pkg = await store.create(by, { owner, name, description });
		ids[name === "pr-review" && owner.kind === "project" ? "pr-review-platform" : name] = pkg.id;
		for (const revision of revisions) {
			const { digest } = await store.saveDraft(by, pkg.id, { files: revision.files });
			await store.publish(by, pkg.id, { expectedDigest: digest });
			now += gap;
		}
		return pkg.id;
	};

	// Built in: every organisation sees these.
	await publish(HARBOUR, { kind: "platform" }, "web-screenshot", "Take a full-page screenshot of a public web page.", [
		{
			files: files([
				"SKILL.md",
				skillMd(
					"web-screenshot",
					"Take a full-page screenshot of a public web page and read it as an image. Use when a page's look matters.",
					"# Web screenshot\n\nOpen the page in the sandbox's browser, wait for it to settle and save a full-page PNG.\n",
				),
			]),
		},
	]);
	await publish(HARBOUR, { kind: "platform" }, "file-upload", "Upload a file and return a link to it.", [
		{
			files: files([
				"SKILL.md",
				skillMd(
					"file-upload",
					"Upload a local file (a screenshot, a log, a report) and return a permanent link to share.",
					"# File upload\n\nUpload the file with the host's file tool and give back the link it returns.\n",
				),
			]),
		},
	]);

	// The organisation's: pr-review imported from the team's skills repo, three revisions.
	const org = { kind: "organisation" as const, organisationId: ORGANISATION };
	const imports = [
		{ ref: "4f2c1e9b7a0d3c5e8f1a2b3c4d5e6f7a8b9c0d1e", content: PR_REVIEW_V1, extra: [] as [string, string][] },
		{
			ref: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
			content: PR_REVIEW_V1.replace(
				"3. Check the tests cover the change.",
				"3. Run the tests and check they cover the change.",
			),
			extra: [["references/checklist.md", CHECKLIST]] as [string, string][],
		},
		{
			ref: "c0ffee1234567890abcdef1234567890abcdef12",
			content: PR_REVIEW_V3,
			extra: [
				["references/checklist.md", CHECKLIST],
				["scripts/run-tests.sh", RUN_TESTS],
			] as [string, string][],
		},
	];
	for (const [index, { ref, content, extra }] of imports.entries()) {
		const revision = await store.importRevision(SYNC, {
			owner: org,
			name: "pr-review",
			description: "Review a pull request for correctness, security and tests.",
			files: files(["SKILL.md", content], ...extra),
			source: { sourceId: "team-skills", ref },
			...(index === 2 ? { extensions: { sal: { reviewers: ["cerbie"], minimumModel: "opus" } } } : {}),
		});
		ids["pr-review"] = revision.skillId;
		now += 9 * DAY;
	}
	now = FIXTURE_NOW - 30 * DAY;
	await publish(ALEX, org, "writing-for-humans", "Write PR comments, tickets and messages people want to read.", [
		{
			files: files([
				"SKILL.md",
				skillMd(
					"writing-for-humans",
					"Write PR comments, ticket updates and messages plainly. Use before posting anything people read.",
					"# Writing for humans\n\nSay the answer first. Cut what the reader already knows. One idea per paragraph.\n",
				),
			]),
		},
		{
			files: files([
				"SKILL.md",
				skillMd(
					"writing-for-humans",
					"Write PR comments, ticket updates and messages plainly. Use before posting anything people read.",
					'# Writing for humans\n\nSay the answer first. Cut what the reader already knows. One idea per paragraph.\n\n## Don\'t\n\n- Open with a greeting.\n- Say "we" for work you did.\n- Leave a link bare when a short label would read better.\n',
				),
			]),
		},
	]);

	// Billing's: one with Lleverage host data on its revision.
	now = FIXTURE_NOW - 12 * DAY;
	const billing = { kind: "project" as const, organisationId: ORGANISATION, projectId: "prj_billing" };
	const reconcile = await store.create(TOM, {
		owner: billing,
		name: "stripe-reconcile",
		description: "Match Stripe invoices to customer records and list the mismatches.",
	});
	ids["stripe-reconcile"] = reconcile.id;
	for (const [index, body] of [
		"# Reconcile Stripe invoices\n\nList last month's invoices with the Stripe skill's script and match each to a customer by email.\n",
		"# Reconcile Stripe invoices\n\nList last month's invoices with `scripts/invoices.ts` and match each to a customer by its Stripe customer ID, then by email.\n\nWrite the mismatches to `notes/reconcile/<month>.md`, one line each with the invoice, the amount and why it didn't match.\n",
	].entries()) {
		const { digest } = await store.saveDraft(TOM, reconcile.id, {
			files: files(
				[
					"SKILL.md",
					skillMd(
						"stripe-reconcile",
						"Match last month's Stripe invoices to customer records and list the mismatches. Use at month end.",
						body,
					),
				],
				[
					"scripts/invoices.ts",
					'import Stripe from "stripe";\n\nconst stripe = new Stripe(process.env.STRIPE_KEY ?? "");\nconst month = process.argv[2];\nconsole.log(JSON.stringify(await stripe.invoices.list({ limit: 100 }), null, 2));\nconsole.error("Listed invoices for", month);\n',
				],
			),
		});
		await store.publish(TOM, reconcile.id, {
			expectedDigest: digest,
			...(index === 1 ? { extensions: { lleverage: { workflows: ["wf_month_end"], integrations: ["stripe"] } } } : {}),
		});
		now += 4 * DAY;
	}

	// Platform's own pr-review, which a session in Platform sees instead of the organisation's.
	now = FIXTURE_NOW - 6 * DAY;
	await publish(
		ALEX,
		{ kind: "project", organisationId: ORGANISATION, projectId: "prj_platform" },
		"pr-review",
		"Review a Platform pull request, with the deploy checks.",
		[
			{
				files: files([
					"SKILL.md",
					skillMd(
						"pr-review",
						"Review a Platform pull request: the organisation's review, plus the deploy and migration checks.",
						"# Platform PR review\n\nDo the organisation's review, then check migrations run both ways and the deploy order is safe.\n",
					),
				]),
			},
		],
	);

	// Tom's own, with a newer draft open.
	now = FIXTURE_NOW - 3 * DAY;
	const brief = await publish(
		TOM,
		{ kind: "user", organisationId: ORGANISATION, userId: VIEWER },
		"morning-brief",
		"Tom's morning brief: overnight sessions, approvals and checks.",
		[
			{
				files: files([
					"SKILL.md",
					skillMd(
						"morning-brief",
						"Summarise last night's sessions, the approvals waiting on Tom and any check that raised a finding.",
						"# Morning brief\n\n- Sessions that finished overnight, one line each.\n- Approvals waiting, oldest first.\n- Checks that raised a finding, with the finding.\n",
					),
				]),
			},
		],
		2 * HOUR,
	);
	await store.saveDraft(TOM, brief, {
		files: files([
			"SKILL.md",
			skillMd(
				"morning-brief",
				"Summarise last night's sessions, the approvals waiting on Tom and any check that raised a finding.",
				"# Morning brief\n\nAs before, plus pull requests waiting on Tom's review.\n",
			),
		]),
	});

	// A draft nobody has published: no session sees it, so the list doesn't either.
	const runbook = await store.create(ALEX, {
		owner: org,
		name: "incident-runbook",
		description: "Steps for an incident.",
	});
	await store.saveDraft(ALEX, runbook.id, {
		files: files(["SKILL.md", skillMd("incident-runbook", "Steps for an incident.", "# Incident runbook\n\nTo do.\n")]),
	});

	now = FIXTURE_NOW;
	return { store, source, author, ids };
}

export const pendingSource: SkillsSource = {
	list: () => new Promise(() => undefined),
	get: () => new Promise(() => undefined),
	listRevisions: () => new Promise(() => undefined),
	getRevision: () => new Promise(() => undefined),
	readFile: () => new Promise(() => undefined),
};

const unavailable = () => Promise.reject(new Error("Kantel is unavailable"));

export const failingSource: SkillsSource = {
	list: unavailable,
	get: unavailable,
	listRevisions: unavailable,
	getRevision: unavailable,
	readFile: unavailable,
};

/** The scenario's writes with publishing failing, for the editor's error state. */
export function failingPublish(author: SkillsAuthor): SkillsAuthor {
	return { ...author, publish: unavailable };
}

/** The scenario's source with file reads failing, for the file's error state. */
export function failingFiles(source: SkillsSource): SkillsSource {
	return { ...source, readFile: unavailable };
}
