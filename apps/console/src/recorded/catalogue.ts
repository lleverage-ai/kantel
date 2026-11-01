// The console's recorded sessions: a few projects and a session in every state the sessions list shows, so the shell
// can be built and judged before the session API lands. Sessions written with `Recording` are made here at
// load, relative to `now`, so their ages read naturally; the two fixtures in fixtures/sessions are fetched when
// first needed. Nothing here is real work: the titles and transcripts are realistic stand-ins.

import { parseFixture, type ServerFrame } from "@kantel/protocol";
import type { ProjectSummary } from "../api/client.ts";
import { ONE_IMAGE, SIX_FILES, THREE_IMAGES } from "./attachments.ts";
import { Recording } from "./recording.ts";
import { POSTERS } from "./workspace.ts";

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
	/** Has no workspace, so its files say so. Every other recorded session has the stand-in one (workspace.ts). */
	readonly noWorkspace?: true;
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
		"The Linear API key the assistant's lookups use expires on Friday. Rotate it, update the connection and check the triage job still reads issues.",
	)
		.status("running")
		.wait(1400)
		.say("I'll check where the key is used before I touch it.")
		.tool({
			name: "grep",
			args: { pattern: "LINEAR_API_KEY", path: "deploy" },
			output: "deploy/compose/agent.env:4\ndeploy/agent/worker.yaml:31",
			ms: 600,
		})
		.tool({ name: "read", args: { path: "deploy/agent/worker.yaml" }, ms: 300, output: "env:\n  - LINEAR_API_KEY" })
		.wait(2200)
		.say(
			"Two places read it, both through Kantel's injection, so nothing holds the value itself. I need a new key from Linear, which means a write to `api.linear.app` with the admin scope. I've asked for it as a connection; once you approve, I'll create the key, swap the entry and run the triage job once to prove it.",
		)
		.wait(800)
		.card({
			type: "connection.approval",
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
			link: "https://harbour.local/connections/requests/prop-4821",
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
				"54  sandbox: gVisor KVM platform measurements\n53  docs: model connectors design\n52  ui: the design loop's harness",
			ms: 2100,
			tier: "container",
		})
		.wait(1800)
		.say(
			"Fourteen PRs merged this week, most of them sandbox and console work. The draft is in `notes/digest.md`: what shipped, what it unblocks, and the two questions still open.",
		)
		.tool({ name: "write", args: { path: "notes/digest.md" }, ms: 200, tier: "isolate" })
		.wait(600)
		.card({
			type: "question",
			questionId: "q-77",
			text: "Where should I post the digest?",
			options: ["#dev", "#releases", "Send it to me first"],
			status: "open",
		})
		.status("waiting");
	return r;
}

const shuffled = "pnpm --filter @kantel/ui vitest run --sequence.shuffle --repeat 50";

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
			"KVM is faster on every measure that matters here. Median cold start drops from 412 ms to 268 ms, and a `git status` on the seeded repo from 1.9 s to 0.7 s. The write-up and the raw numbers are in `notes/cold-start.md`.",
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

const chargeSource = `import { setTimeout as sleep } from "node:timers/promises";
import type { Charge, Gateway } from "./types.ts";

/** Charges a card once. Throws on any gateway error. */
export async function charge(gateway: Gateway, input: Charge): Promise<string> {
	const response = await gateway.post("/v1/charges", input);
	if (!response.ok) throw new Error(\`charge failed: \${response.status}\`);
	return (await response.json()).id;
}
`;

const retriesAnswer = [
	"Charges now retry on a `429` or a `5xx`, three times with jittered backoff, and never on a `4xx` that means the card was declined. The idempotency key is made once per charge, so a retry can't charge twice.",
	"",
	"```ts",
	"export async function charge(gateway: Gateway, input: Charge, attempts = 3): Promise<string> {",
	"\tconst key = crypto.randomUUID(); // one key for every attempt",
	"\tfor (let attempt = 1; ; attempt++) {",
	'\t\tconst response = await gateway.post("/v1/charges", input, { idempotencyKey: key });',
	"\t\tif (response.ok) return (await response.json()).id;",
	"\t\tif (!retryable(response.status) || attempt === attempts) throw new ChargeError(response.status);",
	"\t\tawait sleep(2 ** attempt * 100 + Math.random() * 50);",
	"\t}",
	"}",
	"```",
	"",
	"The new tests cover a retry that succeeds, one that gives up, and a decline that never retries:",
	"",
	"```bash",
	"pnpm vitest run src/billing --reporter=dot",
	"```",
	"",
	"The gateway's retry settings, if you want them in config later:",
	"",
	"```json",
	'{ "billing": { "retries": 3, "backoffMs": 100, "retryOn": [429, 500, 502, 503] } }',
	"```",
].join("\n");

/** Done and read, with code: a file read, an edit and a test run, and an answer with fenced code in three languages. */
function retries(now: number): Recording {
	const r = new Recording("s-retries", "Retry failed charges in the billing client", now - 50 * MINUTE);
	r.user("Make `charge()` in the billing client retry transient gateway errors, without ever charging twice.")
		.status("running")
		.wait(1200)
		.tool({ name: "read", args: { path: "src/billing/charge.ts" }, ms: 300, output: chargeSource })
		.tool({
			name: "edit",
			args: {
				path: "src/billing/charge.ts",
				oldText: "export async function charge(gateway: Gateway, input: Charge)",
				newText: "export async function charge(gateway: Gateway, input: Charge, attempts = 3)",
			},
			ms: 400,
			output: "Edited src/billing/charge.ts: 1 replacement",
		})
		.tool({
			name: "bash",
			args: { command: "pnpm vitest run src/billing --reporter=dot" },
			ms: 6_400,
			output: "✓ src/billing/charge.test.ts (7 tests) 41ms\n\nTest Files  1 passed (1)\n     Tests  7 passed (7)",
		})
		.wait(1500)
		.say(retriesAnswer)
		.status("idle");
	return r;
}

const posterAnswer = [
	"I generated 4 new poster iterations. They all came from the same model, `gpt-image-2.5-flare`, because the image tool has no model option. They differ in style, not in model. I haven't looked at the images myself, since they were too large to preview, so I can't say how well they match your references or whether the text came out right.",
	"",
	'1. **Isometric flat vector.** Navy and orange, with flying documents and delivery drones. It\'s closest to your "Back office" poster.',
	"2. **Retro screen-print.** A 1960s travel-poster look with halftone grain, a logistics hub and an orange moon.",
	'3. **Bauhaus geometric.** A block tower labelled READS / DECIDES / LEARNS / ACTS, with the tagline "Nobody clocked in. Everything got done."',
	"4. **Neon-noir cinematic.** A wide night view of a warehouse with robot arms and forklifts, and rain reflections on the ground.",
].join("\n");

/**
 * Done, with a turn to judge the console's spacing by: prose, a run of calls, a thought, a call presenting four
 * images as file cards, and a closing answer with a list. A subagent's card in the turn before.
 */
function posters(now: number): Recording {
	const r = new Recording("s-posters", "Poster ideas for the Back office launch", now - 40 * MINUTE);
	const image = (prompt: string, ms: number) => ({
		name: "generate_image",
		args: { prompt },
		label: "Generated an image",
		ms,
		output: "Saved the image to out/",
	});
	r.user("Find a few references for a launch poster for Back office: logistics, automation, a bit playful.")
		.status("running")
		.wait(1200)
		.say("I'll have a subagent gather references while I read the brief.")
		.tool({
			name: "subagent",
			args: {
				title: "Gather poster references",
				task: "Find six to eight poster references for a logistics automation launch: isometric, retro print, Bauhaus and cinematic styles.",
			},
			ms: 42_000,
			output:
				"Found seven references across four styles: two isometric explainers, a 1960s travel poster series, a Bauhaus exhibition set and a neon-noir film poster. Links and notes are in out/references.md.",
		})
		.wait(1500)
		.say(
			"The subagent found seven references across four styles. The isometric and retro ones fit the playful brief best; the cinematic one is the outlier, but worth a try.",
		)
		.status("idle")
		.wait(4 * MINUTE)
		.user("Make four posters from those, and use a different image model this time.")
		.status("running")
		.wait(1400)
		.say(
			"I can't choose the image model, because this tool has no model parameter. I'll generate 4 distinct variations with it instead, each taking a different stylistic direction on the theme.",
		)
		.tool(image("Isometric flat vector poster, navy and orange, flying documents and delivery drones", 7_000))
		.tool(image("Retro 1960s screen-print travel poster, halftone grain, logistics hub, orange moon", 8_000))
		.tool(image("Minimalist geometric Bauhaus poster, a block tower labelled READS DECIDES LEARNS ACTS", 7_000))
		.tool(image("Cinematic neon-noir illustration, wide night view of a warehouse with robot arms", 8_000))
		.wait(800)
		.say("", { thinking: "All four are saved under out/. I'll present them together so they open in the panel." })
		.tool({
			name: "present_files",
			args: { paths: POSTERS.map((name) => `out/${name}`) },
			label: "Presenting 4 files",
			ms: 200,
			output: "Presented 4 files",
			files: POSTERS.map((name) => ({
				workspaceId: "ws-s-posters",
				path: `out/${name}`,
				name,
				mimeType: "image/png",
				size: 1_400_000,
			})),
		})
		.wait(1200)
		.say(posterAnswer)
		.status("idle");
	return r;
}

const releaseScript = `"""Release notes from merged pull requests, grouped by label."""

import argparse
import json
import sys
from collections import defaultdict
from datetime import date

SECTIONS = {
    "feature": "New",
    "fix": "Fixed",
    "docs": "Documentation",
}


def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def group(prs: list[dict], since: date) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for pr in prs:
        if date.fromisoformat(pr["merged_at"][:10]) < since:
            continue
        for label in pr["labels"]:
            groups[SECTIONS.get(label, "Other")].append(pr)
    return groups


def render(groups: dict[str, list[dict]]) -> str:
    lines = []
    for section in [*SECTIONS.values(), "Other"]:
        if not groups.get(section):
            continue
        lines.append(f"## {section}\\n")
        lines += [f"- {pr['title']} (#{pr['number']})" for pr in groups[section]]
        lines.append("")
    return "\\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--since", type=date.fromisoformat, required=True)
    args = parser.parse_args()
    print(render(group(load(args.path), args.since)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

const ESC = "\u001b";

/** Done: writes a script as you watch, runs it, fixes it and runs it again. Its tool calls open as cards. */
function releaseNotesScript(now: number): Recording {
	const r = new Recording("s-script", "Script the release notes", now - 12 * MINUTE);
	const run = "python notes/release_notes.py data/prs.json --since 2026-10-23";
	r.user("Write a script that turns last week's merged PRs into release notes grouped by label, then run it.")
		.status("running")
		.live(now + 1000)
		.wait(900)
		.say("I'll write the script first, then run it on the export in `data/prs.json`.", { chunks: 4 })
		.tool({
			name: "write",
			args: { path: "notes/release_notes.py", content: releaseScript },
			write: { chars: 14, gap: 45 },
			ms: 150,
			output: "Successfully wrote to notes/release_notes.py",
			tier: "isolate",
		})
		.tool({
			name: "bash",
			args: { command: run },
			write: { chars: 12, gap: 40 },
			ms: 1400,
			status: "error",
			tier: "container",
			output:
				'Traceback (most recent call last):\n  File "notes/release_notes.py", line 52, in <module>\n    sys.exit(main())\n  File "notes/release_notes.py", line 47, in main\n    print(render(group(load(args.path), args.since)))\n  File "notes/release_notes.py", line 26, in group\n    for label in pr["labels"]:\nKeyError: \'labels\'\n\n<harness>\n[error] Command exited with code 1\n</harness>',
		})
		.wait(1200)
		.say("Some pull requests have no `labels` key at all. I'll look at one.", { chunks: 3 })
		.tool({
			name: "read",
			args: { path: "data/prs.json", offset: 41, limit: 9 },
			ms: 200,
			output:
				'  {\n    "number": 312,\n    "title": "Console: show the model\'s cost per session",\n    "merged_at": "2026-10-24T16:02:11Z"\n  },\n  {\n    "number": 313,\n    "title": "Sandbox: keep the seed cache warm",\n    "labels": ["feature"],\n\n<harness>\n[info] 188 more lines in file. Use offset=50 to continue.\n</harness>',
		})
		.wait(900)
		.tool({
			name: "edit",
			args: {
				path: "notes/release_notes.py",
				edits: [
					{
						oldText: '        for label in pr["labels"]:\n            groups[SECTIONS.get(label, "Other")].append(pr)',
						newText:
							'        labels = pr.get("labels") or ["other"]\n        section = next((SECTIONS[label] for label in labels if label in SECTIONS), "Other")\n        groups[section].append(pr)',
					},
				],
			},
			write: { chars: 10, gap: 40 },
			ms: 300,
			output: "Successfully replaced 1 block(s) in notes/release_notes.py.",
		})
		.tool({
			name: "bash",
			args: { command: `python -m pytest notes -q --color=yes && ${run}` },
			write: { chars: 12, gap: 40 },
			ms: 2600,
			tier: "container",
			progress: [
				`${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m`,
				`${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m`,
				`${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m [100%]${ESC}[0m\n`,
			],
			output: `${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m.${ESC}[0m${ESC}[32m [100%]${ESC}[0m\n${ESC}[32m${ESC}[1m8 passed${ESC}[0m${ESC}[32m in 0.41s${ESC}[0m\n## New\n\n- Sandbox: keep the seed cache warm (#313)\n- Console: tool calls as code, diffs and terminals (#318)\n\n## Fixed\n\n- Vault: refuse an expired grant at the proxy (#309)\n\n## Other\n\n- Console: show the model's cost per session (#312)\n`,
		})
		.wait(1500)
		.say(
			"The notes are ready. The script now files a pull request with no labels under *Other* instead of failing, and the tests cover that case.",
			{ chunks: 8 },
		)
		.status("idle");
	return r;
}

/** Done and read: quiet in the list. */
function handback(now: number): Recording {
	const r = new Recording("s-handback", "Draft the release handback", now - 26 * HOUR);
	r.user("Summarise what the first release delivered, with the merged PRs, for the handback.")
		.status("running")
		.wait(1500)
		.say(
			"The first release is done: the contracts, the console prototype, both spikes and the measurements all merged.",
		)
		.status("idle");
	return r;
}

/** Done: messages sent with one, three and six files, the cards above their bubbles. */
function officeTheme(now: number): Recording {
	const r = new Recording("s-attachments", "Iterate on the back office artwork", now - 3 * HOUR);
	r.user("What do you make of this one for the campaign's header?", "prompt", ONE_IMAGE)
		.status("running")
		.wait(1200)
		.say("It reads well at a glance: the lit windows carry the 'working while you sleep' idea without any people.")
		.status("idle")
		.wait(60_000)
		.user("Generate 4 new iterations on this theme using different image gen models", "prompt", THREE_IMAGES)
		.status("running")
		.wait(1500)
		.say("I'll keep the night palette and the empty desks, and try each model on the same prompt.")
		.status("idle")
		.wait(60_000)
		.user("Here's the brief, the pricing and the config. Fold them in.", "prompt", SIX_FILES)
		.status("running")
		.wait(1500)
		.say("Got them. The brief rules out people, so I've dropped the variant with a night guard.")
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
		{ id: "s-linear-key", projectId: "research", frames: made(linearKey(now)) },
		{ id: "s-digest", projectId: "research", noWorkspace: true, frames: made(digest(now)) },
		{ id: "s-handback", projectId: "research", frames: made(handback(now)) },
		{
			id: "s-flaky",
			projectId: "harbour",
			branch: "fix/composer-flake",
			playOnLoad: true,
			frames: made(flakyTest(now)),
		},
		{ id: "s-gvisor", projectId: "harbour", branch: "gvisor-kvm", unread: true, frames: made(gvisor(now)) },
		{ id: "s-seed", projectId: "harbour", frames: made(seedCache(now)) },
		{ id: "s-retries", projectId: "harbour", branch: "billing-retries", frames: made(retries(now)) },
		{ id: "s-attachments", projectId: "harbour", frames: made(officeTheme(now)) },
		{ id: "s-posters", projectId: "harbour", frames: made(posters(now)) },
		{ id: "s-script", projectId: "research", frames: made(releaseNotesScript(now)) },
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
				projectId: "research",
				frames: fetchFixture(urls.small, "s-release-notes"),
				preview: { title: "Tidy the release notes", startedAt: now - 2 * HOUR, updatedAt: now - 2 * HOUR },
			},
		);
	}
	return {
		projects: [
			{ id: "research", name: "Research" },
			{ id: "harbour", name: "Kantel" },
			{ id: "brwsr", name: "brwsr" },
		],
		sessions,
	};
}
