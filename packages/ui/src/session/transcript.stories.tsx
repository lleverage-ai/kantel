import type { TranscriptItem } from "@kantel/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { EXAMPLE_GENERATED_IMAGE } from "./fixture-generated-image.ts";
import { posterTurn, previewPoster } from "./fixture-presented-images.ts";
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
import { transcriptFrame, transcriptFrameTall, transcriptFrameTurn } from "./story-frames.ts";
import { Transcript } from "./transcript.tsx";

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
		<div className={transcriptFrame}>
			<Transcript items={session} />
		</div>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Transcript loading" intro="The first page has not arrived yet: skeleton turns in the column's shape.">
		<div className={transcriptFrame}>
			<Transcript items={[]} loading />
		</div>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Empty transcript" intro="A new session with nothing in it yet.">
		<div className={transcriptFrame}>
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
	const last = items.at(-1);
	const working = last?.kind === "assistant" && last.streaming;
	return (
		<Sheet
			title="Transcript streaming"
			intro="Under the prompt, Working for 30s; after a second of Thinking, an answer streams in a word every 60ms, about 400 words, and the header goes when it ends. Only the streaming row and the timer render; the list follows the end unless you scroll up, which brings up Scroll to end."
		>
			<div className={transcriptFrame}>
				<Transcript items={items} working={working} />
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
			intro="Not one of the required states: the turn before the answer's first word. Under the prompt, Working for 12s, timed from it and counting each second, with a divider; then the answer's own activity row, a brain and Thinking."
		>
			<div className={transcriptFrame}>
				<Transcript items={items} working />
			</div>
		</Sheet>
	);
}

export const Working: Story = () => <WorkingDemo />;

/** A message just sent: the session works on the turn, but nothing of the answer has arrived yet. */
function JustSentDemo() {
	const [items] = useState<TranscriptItem[]>(() => [
		...finishedTurn,
		{ ...user("js", "Now run the full suite and open a PR."), at: Date.now() - 2_000 },
	]);
	return (
		<Sheet
			title="Transcript just sent"
			intro="The turn has started (working) and no item of the answer has arrived. The working header goes under the message at once, and Thinking under it, so the reader sees the agent has the message before its first token."
		>
			<div className={transcriptFrame}>
				<Transcript items={items} working />
			</div>
		</Sheet>
	);
}

export const JustSent: Story = () => <JustSentDemo />;

/** Between steps of a turn: a call has finished, the next has not started, so the activity row says Thinking. */
function WorkingBetweenStepsDemo() {
	const [items] = useState<TranscriptItem[]>(() => [
		...finishedTurn,
		{ ...user("bs", "Now run the full suite and open a PR."), at: Date.now() - 41_000 },
		assistant("bs-a", "I'll run the whole suite first.", { secondsAgo: 40 }),
		tool("bs-t", "bash", "Ran pnpm test", { args: { command: "pnpm test" }, seconds: 31 }),
	]);
	return (
		<Sheet
			title="Transcript working between steps"
			intro="The turn is working with nothing streaming: a call has finished and the model is deciding what to do next. The header under the prompt keeps counting, and the turn ends with Thinking until the next call or word arrives."
		>
			<div className={transcriptFrame}>
				<Transcript items={items} working />
			</div>
		</Sheet>
	);
}

export const WorkingBetweenSteps: Story = () => <WorkingBetweenStepsDemo />;

const thought =
	"The user wants the full suite and a PR. The billing fix touched the retry path, so the idempotency tests are the ones most likely to fail. I should run everything rather than only the billing package, because the worker shares the queue client. If the suite passes I will push the branch and open the PR with a description of the double charge and how the key is reused on retry."
		.split(" ")
		.filter((word) => word !== "");

/** A thought streams a word every 80ms, then the answer starts and the thought folds behind its disclosure. */
function ThinkingDemo() {
	const [items, setItems] = useState<TranscriptItem[]>(() => [
		...finishedTurn,
		{ ...user("tu", "Now run the full suite and open a PR."), at: Date.now() - 4_000 },
		assistant("ta", "", { streaming: true, secondsAgo: 1 }),
	]);
	useEffect(() => {
		let tick = 0;
		const timer = setInterval(() => {
			tick++;
			setItems((previous) => {
				const last = previous.at(-1);
				if (last?.kind !== "assistant") return previous;
				const next =
					tick <= thought.length
						? { ...last, thinking: `${last.thinking ?? ""}${tick === 1 ? "" : " "}${thought[tick - 1]}` }
						: {
								...last,
								text: `${last.text}${last.text === "" ? "" : " "}${streamed[tick - thought.length - 1] ?? ""}`,
							};
				return [...previous.slice(0, -1), next];
			});
			if (tick >= thought.length + 40) clearInterval(timer);
		}, 80);
		return () => clearInterval(timer);
	}, []);
	return (
		<Sheet
			title="Transcript thinking"
			intro="A thought streams live, its newest four lines under the brain and Thinking, so the reader watches the agent think. When the answer's first word arrives the thought folds behind Thought it through and the answer streams."
		>
			<div className={transcriptFrame}>
				<Transcript items={items} working />
			</div>
		</Sheet>
	);
}

export const Thinking: Story = () => <ThinkingDemo />;

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
		<div className={transcriptFrame}>
			<Transcript items={withCards} />
		</div>
	</Sheet>
);

const withFiles: TranscriptItem[] = [
	{
		...user("u-files", "Why do these disagree? The chart says 412 charges, the invoice 409.", 240),
		attachments: [
			{ id: "a1", name: "charges-per-hour.png", type: "image/png", size: 184_000, kind: "image" },
			{ id: "a2", name: "stripe-invoice-in_1Q2w3e.pdf", type: "application/pdf", size: 412_000, kind: "file" },
			{ id: "a3", name: "worker.log", type: "text/plain", size: 2_100_000, kind: "file" },
		],
	},
	assistant("a-files", "The invoice drops three refunded charges that the chart still counts.", {
		secondsAgo: 230,
	}),
	{
		...user("u-only", "", 120),
		attachments: [{ id: "a4", name: "export.csv", type: "text/csv", size: 8_400, kind: "file" }],
	},
];

export const WithAttachments: Story = () => (
	<Sheet
		title="Transcript with attached files"
		intro="The files sent with a message sit above its bubble as cards of one size, right-aligned and wrapping: an image's thumbnail when the host can read it back (the file type's icon until then, and here), the name cut short (whole on hover), the type and size. A message of files alone has no bubble."
	>
		<div className={transcriptFrame}>
			<Transcript items={withFiles} />
		</div>
	</Sheet>
);
WithAttachments.storyName = "With attachments";

export const PresentedImages: Story = () => (
	<Sheet
		title="Transcript with presented images"
		intro="A turn that made four posters and presented them. present_files renders in place (the tool renderer registry): its images as pictures, with no 'Presenting 4 files' row and no 'Worked for' group of its own. The image calls before it stay folded."
	>
		<div className={transcriptFrameTurn}>
			<Transcript items={posterTurn} previewImage={previewPoster} onOpenFile={() => {}} />
		</div>
	</Sheet>
);
PresentedImages.storyName = "With presented images";

export const PresentedImagesNoPreview: Story = () => (
	<Sheet
		title="Transcript with presented images, no previews"
		intro="The same turn with a host that can't read the images: each is a file's card with its icon, still with no row of its own."
	>
		<div className={transcriptFrameTurn}>
			<Transcript items={posterTurn} onOpenFile={() => {}} />
		</div>
	</Sheet>
);
PresentedImagesNoPreview.storyName = "With presented images, no previews";

export const ErrorState: Story = () => (
	<Sheet
		title="Transcript with errors"
		intro="The transcript's own error sits above the list. In the list, a failed and an interrupted call, then the host's error notice."
	>
		<div className={transcriptFrame}>
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
		<div className={transcriptFrameTall}>
			<Transcript items={longItems} />
		</div>
	</Sheet>
);

// Paging back through a long session, as the console does over the session API's history route: the latest page
// first, then a page before the oldest item shown each time the reader nears the top.
const history = longTranscript(500);
const PAGE = 40;
const noop = () => {};

/** Starts on the last page; scrolling near the top loads the page before it after `delayMs`, keeping your place. */
function PagingDemo({
	items,
	title,
	intro,
	delayMs = 700,
}: {
	items: readonly TranscriptItem[];
	title: string;
	intro: string;
	delayMs?: number;
}) {
	const [start, setStart] = useState(Math.max(0, items.length - PAGE));
	const [loadingOlder, setLoadingOlder] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const onLoadOlder = useCallback(() => {
		if (timer.current !== undefined) return;
		setLoadingOlder(true);
		timer.current = setTimeout(() => {
			timer.current = undefined;
			setLoadingOlder(false);
			setStart((value) => Math.max(0, value - PAGE));
		}, delayMs);
	}, [delayMs]);
	return (
		<Sheet title={title} intro={intro}>
			<div className={transcriptFrame}>
				<Transcript
					items={items.slice(start)}
					hasOlder={start > 0}
					loadingOlder={loadingOlder}
					onLoadOlder={onLoadOlder}
				/>
			</div>
		</Sheet>
	);
}

export const OlderPages: Story = () => (
	<PagingDemo
		items={history}
		title="Transcript paging"
		intro="A session of 500 turns (2,000 items) opens on its latest 40 items. Scroll up: each page before the oldest shown loads as you near the top, and the rows you are reading stay where they are. At the very top it says where the session starts."
	/>
);

export const OlderPagesMobile: Story = () => (
	<PagingDemo items={history} title="Transcript paging at 420px" intro="The same long session on a phone." />
);
OlderPagesMobile.meta = { width: 420 };

const lastPage = history.slice(-PAGE);

export const OlderPagesLoading: Story = () => (
	<Sheet
		title="Transcript loading an earlier page"
		intro="The reader has scrolled to the top of what is loaded; the page before it is on its way."
	>
		<div className={transcriptFrame}>
			<Transcript items={lastPage} hasOlder loadingOlder onLoadOlder={noop} />
		</div>
	</Sheet>
);

export const OlderPagesButton: Story = () => (
	<Sheet
		title="Transcript with earlier messages to load"
		intro="Over the oldest loaded row, Load earlier messages asks for the page before it: scrolling near the top asks by itself, and the line is there for a keyboard or a reader who stops short."
	>
		<div className={transcriptFrame}>
			<Transcript items={history.slice(-6)} hasOlder onLoadOlder={noop} />
		</div>
	</Sheet>
);

export const OlderPagesError: Story = () => (
	<Sheet title="Transcript after a failed page" intro="Loading the page before these failed; Try again asks for it.">
		<div className={transcriptFrame}>
			<Transcript items={lastPage} hasOlder olderError="Couldn't load earlier messages." onLoadOlder={noop} />
		</div>
	</Sheet>
);

/** A message the host sent at once and couldn't deliver: still where it was, with Try again and Edit. */
const unsent: TranscriptItem[] = [
	...finishedTurn,
	{ ...user("local:r1", "Now run the full suite and open a PR.", 20), requestId: "r1" },
];
const unsentDelivery = new Map([
	[
		"local:r1",
		{ state: "failed", reason: "Can't reach Kantel. Check your connection.", onRetry: noop, onEdit: noop } as const,
	],
]);

export const NotSent: Story = () => (
	<Sheet
		title="Transcript with a message that didn't send"
		intro="A message shows the moment it is sent (delivery). One the host couldn't take stays in place, and the line under it says so, with Try again and Edit, which puts the words back in the composer."
	>
		<div className={transcriptFrame}>
			<Transcript items={unsent} delivery={unsentDelivery} />
		</div>
	</Sheet>
);

// An image made with generate_image, which presents it, with the model that made it; an agent that still presents it
// again adds no second card. Then the answer.
const pogoPath = "images/a-man-on-a-pogo-stick-mhd0k2pq.jpg";
const pogoFile = {
	workspaceId: "ws_1",
	path: pogoPath,
	name: "a-man-on-a-pogo-stick-mhd0k2pq.jpg",
	mimeType: "image/jpeg",
	size: 2_340_000,
} as const;
const pogoArgs = { prompt: "A man bouncing on a pogo stick in a park at sunset, photo", aspect: "portrait" };
const imageTurn: TranscriptItem[] = [
	user("iu", "Make me an image of a man on a pogo stick", 60),
	{
		...tool("it1", "generate_image", "Making an image", {
			args: pogoArgs,
			output: `Made 1 image with gpt-image-2.5-flare.\nSaved in the session's files:\n${pogoPath}\nThe person sees it in the conversation already.`,
			seconds: 22,
			secondsAgo: 58,
		}),
		files: [{ ...pogoFile, model: "gpt-image-2.5-flare" }],
		images: [{ mimeType: "image/jpeg", data: EXAMPLE_GENERATED_IMAGE }],
	},
	{
		...tool("it2", "present_files", "Presenting a-man-on-a-pogo-stick-mhd0k2pq.jpg", {
			args: { filepaths: [pogoPath] },
			output: `Presented ${pogoPath}`,
			seconds: 0.3,
			secondsAgo: 35,
		}),
		files: [pogoFile],
	},
	assistant("ia", "Here's a man mid-bounce on a pogo stick in a park at sunset, in portrait.", { secondsAgo: 33 }),
];
const openNothing = () => {};

/** generate_image running: a placeholder the shape of the image to come, under its call, while the turn works. */
function MakingImageDemo({
	args,
	label = "Making an image",
}: {
	args: { readonly [key: string]: unknown };
	label?: string;
}) {
	const [items] = useState<TranscriptItem[]>(() => [
		{ ...user("mu", "Make me an image of a man on a pogo stick"), at: Date.now() - 9_000 },
		{
			...tool("mt1", "generate_image", label, { status: "running", args }),
			at: Date.now() - 7_000,
		},
	]);
	return (
		<div className={transcriptFrame}>
			<Transcript items={items} working />
		</div>
	);
}

// A turn of several steps: the agent's words between its calls, a thought, two runs of calls, then the answer.
const stepsTurn: TranscriptItem[] = [
	user("su1", "The billing worker charged two customers twice last night. Find out why and fix it.", 300),
	assistant("sa1", "I'll start with the charge path and how it retries.", {
		thinking: "A double charge after a timeout usually means a retry without an idempotency key.",
		secondsAgo: 296,
	}),
	tool("st1", "read", "Read src/billing/charge.ts", {
		args: { path: "src/billing/charge.ts" },
		seconds: 0.2,
		secondsAgo: 295,
	}),
	tool("st2", "grep", "Searched for retryCharge", { args: { pattern: "retryCharge" }, seconds: 0.4, secondsAgo: 290 }),
	assistant("sa2", "The retry makes a new charge without a key. Fixing it and running the tests.", { secondsAgo: 280 }),
	tool("st3", "edit", "Edited src/billing/retry.ts", {
		args: { path: "src/billing/retry.ts" },
		seconds: 0.1,
		secondsAgo: 270,
	}),
	tool("st4", "bash", "Ran pnpm test billing", {
		args: { command: "pnpm test billing" },
		seconds: 41,
		secondsAgo: 260,
	}),
	assistant(
		"sa3",
		"Found and fixed: the retry in `src/billing/retry.ts` made a new Stripe charge without an idempotency key, so a timeout could charge twice. It now reuses the first attempt's key, and the billing tests pass.",
		{ secondsAgo: 212 },
	),
];

export const FinishedTurn: Story = () => (
	<Sheet
		title="Transcript with a finished turn of several steps"
		intro="The agent's words between its calls, a thought and two runs of calls, folded under one Worked for line, closed by default; the answer under it. Open the line to see every step."
	>
		<div className={transcriptFrame}>
			<Transcript items={stepsTurn} />
		</div>
	</Sheet>
);
FinishedTurn.storyName = "Finished turn";

export const ImageGeneration: Story = () => (
	<Sheet
		title="Transcript with a generated image"
		intro="A finished turn that made an image with generate_image: its work folded, the image in view as a card with the model that made it, then the answer."
	>
		<div className={transcriptFrame}>
			<Transcript items={imageTurn} onOpenFile={openNothing} />
		</div>
	</Sheet>
);
ImageGeneration.storyName = "Image generation";

export const MakingAnImage: Story = () => (
	<Sheet
		title="Transcript making an image"
		intro="generate_image running in a working turn: a portrait placeholder, a light crossing it and its icon breathing (transform and opacity only)."
	>
		<MakingImageDemo args={pogoArgs} />
	</Sheet>
);
MakingAnImage.storyName = "Making an image";

export const MakingImages: Story = () => (
	<Sheet title="Transcript making two landscape images" intro="One placeholder for each image the call asked for.">
		<MakingImageDemo args={{ prompt: "A lighthouse at dusk", aspect: "landscape", count: 2 }} label="Making 2 images" />
	</Sheet>
);
MakingImages.storyName = "Making images";

// Tom's report of 30 Oct 2026, as a turn: a file written, a run of it that failed (exit 2), the agent's words, a run that
// worked, a subagent it handed a check to, then the answer. Its work folds under one "Worked for" line.
const helloContent = 'def main() -> None:\n    print("Hello, world!")\n\n\nif __name__ == "__main__":\n    main()\n';
const helloTurn: TranscriptItem[] = [
	user("hu", "Write a hello world in Python and run it", 90),
	tool("hw", "write", "Wrote hello.py", {
		args: { path: "hello.py", content: helloContent },
		output: "Successfully wrote 87 bytes to hello.py",
		seconds: 0.1,
		secondsAgo: 86,
	}),
	tool("hb1", "bash", "Ran python3 hello.py", {
		status: "error",
		args: { command: "python3 hello.py" },
		output:
			"python3: can't open file '/workspace/hello.py': [Errno 2] No such file or directory\n\n<harness>\n[error] Command exited with code 2\n</harness>",
		seconds: 0.3,
		secondsAgo: 84,
	}),
	assistant("ha1", "The file went somewhere else; checking where it is.", { secondsAgo: 82 }),
	tool("hb2", "bash", "Ran ls; python3 hello.py", {
		args: { command: "ls; python3 hello.py" },
		output: "hello.py\nHello, world!",
		seconds: 0.4,
		secondsAgo: 80,
	}),
	tool("hs", "subagent", "Subagent: Review hello.py", {
		args: { title: "Review hello.py", task: "Review hello.py for style and say whether it follows PEP 8." },
		output: "hello.py follows PEP 8: a main() guarded by __name__, four-space indents and two blank lines before it.",
		seconds: 9,
		secondsAgo: 78,
	}),
	assistant(
		"ha2",
		"`hello.py` prints **Hello, world!**. The first run looked in the wrong folder; the second ran it from the workspace. A subagent checked it against PEP 8.",
		{ secondsAgo: 67 },
	),
];

// The same turn with nothing failing: the first run works, so there is nothing to look into.
const helloClean: TranscriptItem[] = [
	...helloTurn.filter((item) => item.id !== "hb1" && item.id !== "ha1" && item.id !== "ha2"),
	assistant("ha2", "`hello.py` prints **Hello, world!**. A subagent checked it against PEP 8.", { secondsAgo: 67 }),
];

export const WorkingSections: Story = () => (
	<Sheet
		title="Transcript with a failed step and a subagent"
		intro="A finished turn whose work folds under its Worked for line: an editor card for the file it wrote, a terminal for each command (the first failed, exit 2), and a subagent. The line says only how long the turn took, never how many steps. Closed, it hides every step, the failed one too, and shows an alert mark in the error colour (A step failed, for a screen reader); with nothing failed there is no mark. The subagent stays in view, out of the fold. Open, the cards sit in line with their rows, not indented."
	>
		<Section title="A step failed">
			<div className={transcriptFrameTall}>
				<Transcript items={helloTurn} />
			</div>
		</Section>
		<Section title="Every step worked">
			<div className={transcriptFrame}>
				<Transcript items={helloClean} />
			</div>
		</Section>
	</Sheet>
);
WorkingSections.storyName = "Working sections";

// The same work in a turn that ended without an answer: no fold, so its calls collapse to their own group's line.
const helloUnanswered: TranscriptItem[] = helloTurn.filter((item) => item.id !== "ha2" && item.id !== "ha1");

const helloUnansweredClean: TranscriptItem[] = helloClean.filter((item) => item.id !== "ha2");

export const UnansweredGroup: Story = () => (
	<Sheet
		title="Transcript with a collapsed group holding a failed call"
		intro="A turn that stopped without an answer isn't folded; its calls collapse to one Worked for group, which says how long they took and no step count. Closed, the group hides its failed call too and shows only an alert mark in the error colour; with nothing failed there is no mark."
	>
		<Section title="A step failed">
			<div className={transcriptFrame}>
				<Transcript items={helloUnanswered} />
			</div>
		</Section>
		<Section title="Every step worked">
			<div className={transcriptFrame}>
				<Transcript items={helloUnansweredClean} />
			</div>
		</Section>
	</Sheet>
);
UnansweredGroup.storyName = "Unanswered group";

export const Mobile: Story = () => (
	<Sheet title="Transcript at 420px" intro="The default session on a phone.">
		<div className={transcriptFrameTall}>
			<Transcript items={session} />
		</div>
	</Sheet>
);
Mobile.meta = { width: 420 };
