import type { TranscriptItem } from "@harbour/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Sheet } from "../workbench/specimen.tsx";
import {
	assistant,
	browser,
	card,
	finishedTurn,
	liveTurn,
	longTranscript,
	notice,
	question,
	tool,
	user,
	vaultCard,
} from "./fixtures.ts";
import { Transcript } from "./transcript.tsx";
import "./stories.css";

export default { title: "Session/Transcript" } satisfies StoryDefault;

// Running calls are re-based on the real clock, so their elapsed time reads as seconds rather than the age of the
// fixture's fixed instant.
const rebase = (items: readonly TranscriptItem[]): TranscriptItem[] =>
	items.map((item) =>
		item.kind === "tool" && item.status === "running" ? { ...item, at: Date.now() - 30_000 } : item,
	);

const session: TranscriptItem[] = [...finishedTurn, ...rebase(liveTurn)];

export const Default: Story = () => (
	<Sheet
		title="Transcript"
		intro="A finished turn, its four calls collapsed to one summary, then a live turn: a command running and an answer streaming its first words."
	>
		<div className="hb-story-transcript-frame">
			<Transcript items={session} />
		</div>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Transcript loading" intro="The first page has not arrived yet: skeleton turns in the column's shape.">
		<div className="hb-story-transcript-frame">
			<Transcript items={[]} loading />
		</div>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Empty transcript" intro="A new session with nothing in it yet.">
		<div className="hb-story-transcript-frame">
			<Transcript items={[]} />
		</div>
	</Sheet>
);

const streamed =
	"The full suite passed: 1,284 tests in 41 files, with the two new retry tests among them. I pushed the branch fix/billing-idempotency and opened a pull request that explains the double charge, the idempotency key and how a retry now reuses it. The reviewers are the billing owners. Nothing else in the worker changed, and the migration is not needed because the key lives only in the request."
		.split(" ")
		.filter((word) => word !== "");

/** About 400 words, one every 60ms, after a second of the working row. */
function StreamingDemo() {
	// The prompt is re-based on the real clock, so the working row's timer reads "Working for 30s".
	const [items, setItems] = useState<TranscriptItem[]>(() => [
		...finishedTurn,
		{ ...user("su", "Now run the full suite and open a PR."), at: Date.now() - 30_000 },
		assistant("sa", "", { streaming: true, secondsAgo: 1 }),
	]);
	useEffect(() => {
		const total = 400;
		const wait = 16;
		let tick = 0;
		const timer = setInterval(() => {
			tick++;
			const words = tick - wait;
			if (words <= 0) return;
			const done = words >= total;
			const word = streamed[(words - 1) % streamed.length] ?? "";
			const breakHere = words % 55 === 0;
			setItems((previous) => {
				const last = previous.at(-1);
				if (last?.kind !== "assistant") return previous;
				const separator = last.text === "" ? "" : breakHere ? "\n\n" : " ";
				return [...previous.slice(0, -1), { ...last, text: `${last.text}${separator}${word}`, streaming: !done }];
			});
			if (done) clearInterval(timer);
		}, 60);
		return () => clearInterval(timer);
	}, []);
	return (
		<Sheet
			title="Transcript streaming"
			intro="After a second of Working for 30s, an answer streams in a word every 60ms, about 400 words. Only the streaming row renders; the list follows the end unless you scroll up, which brings up Scroll to end."
		>
			<div className="hb-story-transcript-frame">
				<Transcript items={items} />
			</div>
		</Sheet>
	);
}

export const Streaming: Story = () => <StreamingDemo />;

/** The turn's prompt was sent 12 seconds ago and the answer has no words yet. */
function WorkingDemo() {
	const [items] = useState<TranscriptItem[]>(() => [
		...finishedTurn,
		{ ...user("wu", "Now run the full suite and open a PR."), at: Date.now() - 12_000 },
		assistant("wa", "", { streaming: true, secondsAgo: 1 }),
	]);
	return (
		<Sheet
			title="Transcript working"
			intro="Not one of the required states: the turn before the answer's first word. The transcript ends with Working for 12s, timed from the prompt and counting each second."
		>
			<div className="hb-story-transcript-frame">
				<Transcript items={items} />
			</div>
		</Sheet>
	);
}

export const Working: Story = () => <WorkingDemo />;

const failed: TranscriptItem[] = [
	user("eu", "Run the billing migration against staging.", 120),
	tool("et1", "read", "Read migrations/0042_idempotency.sql", { args: { path: "migrations/0042_idempotency.sql" } }),
	tool("et2", "bash", "Ran pnpm migrate --env staging", {
		status: "error",
		args: { command: "pnpm migrate --env staging" },
		output: "error: connection to billing-staging refused (ECONNREFUSED 10.0.4.12:5432)",
		seconds: 3.2,
	}),
	tool("et3", "bash", "Ran pnpm migrate --env staging --retry", {
		status: "interrupted",
		args: { command: "pnpm migrate --env staging --retry" },
		seconds: 12,
	}),
	notice("en", "error", "The sandbox ran out of memory and the run stopped."),
];

// Named ErrorState so the export does not shadow the global Error; Ladle shows it as "Error".
const withCards: TranscriptItem[] = [
	user("u-cards", "File the three bugs from last night's sweep in Linear, then check the staging dashboard.", 240),
	assistant("a-cards-1", "I need a Linear API key for that. I've asked the vault for one.", { secondsAgo: 200 }),
	// The transcript's cards read the real clock, so the request's expiry is re-based on it, like running calls.
	card("c-vault", vaultCard({ expiresAt: Date.now() + 14 * 60_000 }), 190),
	card("c-question", question(), 120),
	card("c-browser", browser(), 60),
];

export const WithCards: Story = () => (
	<Sheet
		title="Transcript with cards, read-only"
		intro="Without renderCard the cards show everything they say, with nothing to press: the vault request's terms and binding code, the question and its options, the browser request's reason."
	>
		<div className="hb-story-transcript-frame">
			<Transcript items={withCards} />
		</div>
	</Sheet>
);

export const ErrorState: Story = () => (
	<Sheet
		title="Transcript with errors"
		intro="The transcript's own error sits above the list. In the list, a failed and an interrupted call, then the host's error notice."
	>
		<div className="hb-story-transcript-frame">
			<Transcript items={failed} error="Lost the connection to the session. What you see may be out of date." />
		</div>
	</Sheet>
);
ErrorState.storyName = "Error";

const url =
	"https://storage.harbour.dev/exports/billing/2026-10-27/invoices-all-tenants-deduplicated-with-idempotency-keys-and-retry-history-final-final-v2.jsonl?signature=8f7a6c5e4d3b2a1908f7a6c5e4d3b2a19";

const longOutput = Array.from(
	{ length: 400 },
	(_, index) =>
		`[${String(index + 1).padStart(3, "0")}] tenant-${(index % 37) + 1}: exported ${(index * 7) % 113} invoices, ${index % 5} duplicates removed`,
).join("\n");

const longItems: TranscriptItem[] = [
	...longTranscript(300),
	user("lxu", `Export every tenant's invoices and give me the link. Last time it was ${url}`, 120),
	tool(
		"lxt",
		"bash",
		"Ran node scripts/export-invoices.ts --all-tenants --format jsonl --out /tmp/invoices-2026-10-27.jsonl --verbose",
		{
			args: {
				command:
					"node scripts/export-invoices.ts --all-tenants --format jsonl --out /tmp/invoices-2026-10-27.jsonl --verbose",
			},
			output: longOutput,
			seconds: 74,
			secondsAgo: 110,
		},
	),
	assistant("lxa", `The export is done: 400 batches, no errors. It is at ${url}\n\nThe link lasts seven days.`, {
		secondsAgo: 30,
	}),
];

export const LongContent: Story = () => (
	<Sheet
		title="Long transcript"
		intro="Three hundred finished turns (1,200 items, virtualised), then a call with 400 lines of output (open it) and a very long unbroken link, which wraps."
	>
		<div className="hb-story-transcript-frame hb-story-transcript-frame-tall">
			<Transcript items={longItems} />
		</div>
	</Sheet>
);

const history = longTranscript(60);
const PAGE = 40;

/** Starts on the last page; scrolling near the top loads the page before it, keeping your place. */
function OlderPagesDemo() {
	const [start, setStart] = useState(history.length - PAGE);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const onLoadOlder = useCallback(() => {
		if (timer.current !== undefined) return;
		setLoadingOlder(true);
		timer.current = setTimeout(() => {
			timer.current = undefined;
			setStart((value) => Math.max(0, value - PAGE));
			setLoadingOlder(false);
		}, 700);
	}, []);
	return (
		<Sheet
			title="Transcript paging"
			intro="Not one of the required states: the older-history path. Scroll up to load the previous page; the visible rows stay where they are."
		>
			<div className="hb-story-transcript-frame">
				<Transcript
					items={history.slice(start)}
					hasOlder={start > 0}
					loadingOlder={loadingOlder}
					onLoadOlder={onLoadOlder}
				/>
			</div>
		</Sheet>
	);
}

export const OlderPages: Story = () => <OlderPagesDemo />;

export const Mobile: Story = () => (
	<Sheet title="Transcript at 420px" intro="The default session on a phone.">
		<div className="hb-story-transcript-frame hb-story-transcript-frame-tall">
			<Transcript items={session} />
		</div>
	</Sheet>
);
Mobile.meta = { width: 420 };
