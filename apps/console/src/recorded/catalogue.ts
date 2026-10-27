// The console's recorded sessions: a few projects and a session in every state the sessions list shows, so the shell
// can be built and judged before the session API (M1-BE1) lands. Sessions written with `Recording` are made here at
// load, relative to `now`, so their ages read naturally; the two fixtures in fixtures/sessions are fetched when
// first needed. Nothing here is real work: the titles and transcripts are realistic stand-ins.

import { parseFixture, type ServerFrame } from "@harbour/protocol";
import type { ProjectSummary } from "../api/client.ts";
import { Recording } from "./recording.ts";

export type RecordedSession = {
	readonly id: string;
	readonly projectId: string;
	readonly branch?: string;
	/** Finished before the page loaded and not yet opened. */
	readonly unread?: boolean;
	/** Plays its live part as soon as the page loads, so it is working in the list. */
	readonly playOnLoad?: boolean;
	/** The frames, made or fetched. */
	readonly frames: () => Promise<readonly ServerFrame[]>;
	/** What the list shows before the frames are loaded, for sessions fetched when first opened. */
	readonly preview?: { readonly title: string; readonly updatedAt: number; readonly startedAt: number };
};

export type Catalogue = {
	readonly projects: readonly ProjectSummary[];
	readonly sessions: readonly RecordedSession[];
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Gives a fixture's frames another session id, so one recording can stand for a session in the catalogue. */
export function renameSession(frames: readonly ServerFrame[], sessionId: string): ServerFrame[] {
	return frames.map((frame): ServerFrame => {
		switch (frame.type) {
			case "hello":
				return { ...frame, sessionId };
			case "snapshot":
				return { ...frame, snapshot: { ...frame.snapshot, sessionId } };
			case "delta":
				return { ...frame, delta: { ...frame.delta, sessionId } };
			case "history":
				return { ...frame, page: { ...frame.page, sessionId } };
			default:
				return frame;
		}
	});
}

const made = (recording: Recording) => {
	const frames = recording.frames();
	return () => Promise.resolve(frames);
};

/** Waiting on an approval: the agent asked the vault for a key. */
function linearKey(now: number): Recording {
	const r = new Recording("s-linear-key", "Rotate the Linear API key", now - 26 * MINUTE);
	r.user(
		"The Linear API key Sal's lookups use expires on Friday. Rotate it, update the vault entry and check the triage job still reads issues.",
	)
		.status("running")
		.wait(1400)
		.say("I'll check where the key is used before I touch it.")
		.tool({
			name: "grep",
			args: { pattern: "LINEAR_API_KEY", path: "deploy" },
			output: "deploy/compose/sal.env:4\ndeploy/sal/worker.yaml:31",
			ms: 600,
		})
		.tool({ name: "read", args: { path: "deploy/sal/worker.yaml" }, ms: 300, output: "env:\n  - LINEAR_API_KEY" })
		.wait(2200)
		.say(
			"Two places read it, both through the vault's injection, so nothing holds the value itself. I need a new key from Linear, which means a write to `api.linear.app` with the admin scope. I've asked the vault for it; once you approve, I'll create the key, swap the entry and run the triage job once to prove it.",
		)
		.wait(800)
		.card({
			type: "vault.approval",
			proposalId: "prop-4821",
			status: "pending",
			bindingCode: "HX-42",
			what: "Create a Linear API key",
			why: "The current key expires on Friday and the triage job needs a replacement.",
			host: "api.linear.app",
			methods: ["POST"],
			pathPrefix: "/graphql",
			injectionTemplate: "Authorization: {{secret}}",
			termsSource: "agent-proposed",
			expiresAt: now + 34 * MINUTE,
			link: "https://vault.harbour.local/p/prop-4821",
		})
		.status("waiting");
	return r;
}

/** Waiting on an answer: the agent asked which channel to post to. */
function digest(now: number): Recording {
	const r = new Recording("s-digest", "Weekly delivery digest", now - 48 * MINUTE);
	r.user("Draft this week's delivery digest from the merged PRs and post it where the team will see it.")
		.status("running")
		.wait(900)
		.tool({
			name: "bash",
			args: { command: "gh pr list --state merged --search 'merged:>=2026-10-20' --limit 50" },
			output:
				"54  M0-SH1: gVisor KVM platform measurements\n53  docs: model connectors design\n52  UI-3: the design loop's harness",
			ms: 2100,
			tier: "container",
		})
		.wait(1800)
		.say(
			"Fourteen PRs merged this week, most of them M0 work on Harbour. The draft is in `notes/digest.md`: what shipped, what it unblocks, and the two open questions from the plan.",
		)
		.tool({ name: "write", args: { path: "notes/digest.md" }, ms: 200, tier: "isolate" })
		.wait(600)
		.card({
			type: "question",
			questionId: "q-77",
			text: "Where should I post the digest?",
			options: ["#dev-delta", "#harbour", "Send it to me first"],
			status: "open",
		})
		.status("waiting");
	return r;
}

const shuffled = "pnpm --filter @harbour/ui vitest run --sequence.shuffle --repeat 50";

/** Working: plays live for a few minutes after the page loads. */
function flakyTest(now: number): Recording {
	const r = new Recording("s-flaky", "Fix the flaky composer test", now - 7 * MINUTE);
	r.user(
		"composer-model.test.ts failed twice on main this morning and passed on retry. Find out why and fix it properly, not with a retry.",
	)
		.status("running")
		.wait(1200)
		.say("I'll start with the two failing runs' logs.")
		.tool({
			name: "bash",
			args: { command: "gh run list --workflow ci --branch main --status failure --limit 5" },
			ms: 1800,
			tier: "container",
			output: "18842  ci  main  failure  2h\n18839  ci  main  failure  3h",
		})
		.tool({
			name: "bash",
			args: { command: "gh run view 18842 --log-failed | tail -40" },
			ms: 2400,
			tier: "container",
			output:
				"FAIL packages/ui/src/session/composer-model.test.ts > shouldSend > a software keyboard's Enter is a new line\nAssertionError: expected true to be false",
		})
		.wait(2600)
		.say(
			"Both failures are the same case: a software keyboard's Enter. The test reads `matchMedia` through a stub that another test file replaces and never restores, so the result depends on which file the worker ran first.",
		)
		.live(now + 1000)
		.wait(1500)
		.tool({ name: "grep", args: { pattern: "matchMedia", path: "packages/ui/src" }, ms: 900 })
		.tool({ name: "read", args: { path: "packages/ui/src/session/composer.stories.tsx" }, ms: 400 })
		.wait(3000)
		.say(
			"Found it. `composer.stories.tsx` is imported by a story test that sets `window.matchMedia` at module scope. I'll move the stub into a `beforeEach` with a restore, and make the model test pass the pointer type in explicitly so it can't depend on the page.",
			{ chunks: 14, gap: 160 },
		)
		.tool({ name: "edit", args: { path: "packages/ui/src/session/composer-model.test.ts" }, ms: 700 })
		.tool({ name: "edit", args: { path: "packages/ui/src/session/composer.stories.tsx" }, ms: 600 })
		.wait(1200)
		.say("Now the test file on its own, then shuffled fifty times, which is what flushed it out on CI.", {
			chunks: 5,
		})
		.start({ name: "bash", args: { command: shuffled } })
		.wait(45_000)
		.finish({
			name: "bash",
			args: { command: shuffled },
			output: " Test Files  38 passed (38)\n      Tests  1900 passed (1900)\n   Duration  41.80s",
			tier: "container",
		})
		.wait(1800)
		.say(
			"Fifty shuffled runs, no failures. The fix is two small changes:\n\n1. `composer.stories.tsx` installs its `matchMedia` stub per story and restores it.\n2. `composer-model.test.ts` passes `coarse` to `shouldSend` directly instead of reading the page.\n\nI've pushed `fix/composer-flake` and opened the PR. Nothing else in the suite reads `matchMedia` at module scope.",
			{ chunks: 30, gap: 140 },
		)
		.status("idle");
	return r;
}

/** Done, unread: finished while nobody was looking. */
function gvisor(now: number): Recording {
	const r = new Recording("s-gvisor", "Measure gVisor on the KVM platform", now - 3 * HOUR);
	r.user("Re-run the sandbox cold-start measurements with runsc on the KVM platform and compare with ptrace.")
		.status("running")
		.wait(2000)
		.tool({ name: "bash", args: { command: "node scripts/measure.ts --runtime runsc-kvm --runs 40" }, ms: 94_000 })
		.tool({ name: "bash", args: { command: "node scripts/measure.ts --runtime runsc --runs 40" }, ms: 101_000 })
		.wait(4000)
		.say(
			"KVM is faster on every measure that matters here. Median cold start drops from 412 ms to 268 ms, and a `git status` on the seeded repo from 1.9 s to 0.7 s. The write-up and the raw numbers are in `docs/measurements/gvisor-kvm.md`.",
		)
		.status("idle");
	return r;
}

/** Failed: the run stopped on an error. */
function seedCache(now: number): Recording {
	const r = new Recording("s-seed", "Warm the seed cache for the brwsr repo", now - 5 * HOUR);
	r.user("Warm the seed cache for tvdavies/brwsr so the next worker starts in under ten seconds.")
		.status("running")
		.wait(1000)
		.tool({
			name: "bash",
			args: { command: "harbour seed warm --repo tvdavies/brwsr --depth 50" },
			ms: 12_000,
			status: "error",
			output: "error: object store unavailable (connection refused)",
		})
		.wait(800)
		.notice("error", "The model provider returned an error twice in a row, so the run stopped.", "model_error")
		.status("failed");
	return r;
}

/** Done and read: quiet in the list. */
function handback(now: number): Recording {
	const r = new Recording("s-handback", "Draft the M0 handback", now - 26 * HOUR);
	r.user("Summarise what M0 delivered, with the merged PRs, for the handback.")
		.status("running")
		.wait(1500)
		.say("M0 is done: the contracts, the console prototype, both spikes and the measurements all merged.")
		.status("idle");
	return r;
}

function fetchFixture(url: string, sessionId: string): () => Promise<readonly ServerFrame[]> {
	let loaded: Promise<readonly ServerFrame[]> | undefined;
	return () => {
		loaded ??= fetch(url)
			.then((response) => {
				if (!response.ok) throw new Error(`Could not load the recording (${response.status})`);
				return response.text();
			})
			.then((text) => renameSession(parseFixture(text), sessionId));
		return loaded;
	};
}

export type FixtureUrls = { readonly long: string; readonly small: string };

/** The catalogue at `now`. The two recorded fixtures are fetched from `urls` when first opened. */
export function createCatalogue(now: number, urls?: FixtureUrls): Catalogue {
	const sessions: RecordedSession[] = [
		{ id: "s-linear-key", projectId: "sal", frames: made(linearKey(now)) },
		{ id: "s-digest", projectId: "sal", frames: made(digest(now)) },
		{ id: "s-handback", projectId: "sal", frames: made(handback(now)) },
		{
			id: "s-flaky",
			projectId: "harbour",
			branch: "fix/composer-flake",
			playOnLoad: true,
			frames: made(flakyTest(now)),
		},
		{ id: "s-gvisor", projectId: "harbour", branch: "m0-sh1/gvisor-kvm", unread: true, frames: made(gvisor(now)) },
		{ id: "s-seed", projectId: "harbour", frames: made(seedCache(now)) },
	];
	if (urls !== undefined) {
		sessions.push(
			{
				id: "s-migration",
				projectId: "harbour",
				branch: "platform-migration",
				frames: fetchFixture(urls.long, "s-migration"),
				preview: { title: "Platform migration, long-running", startedAt: now - 30 * HOUR, updatedAt: now - 22 * HOUR },
			},
			{
				id: "s-release-notes",
				projectId: "sal",
				frames: fetchFixture(urls.small, "s-release-notes"),
				preview: { title: "Tidy the release notes", startedAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR },
			},
		);
	}
	return {
		projects: [
			{ id: "sal", name: "Sal" },
			{ id: "harbour", name: "Harbour" },
			{ id: "brwsr", name: "brwsr" },
		],
		sessions,
	};
}
