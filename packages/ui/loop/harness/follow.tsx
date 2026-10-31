// The follow scenario, for loop/follow.ts: a session's transcript with the composer docked, as the console shows it,
// and a live turn that streams the way the console's client delivers it, one batch every 100 ms: a thought, two
// tool calls, a second thought that folds when its answer starts, then a long answer, with the working row from send
// to settle. loop/follow.ts scrolls it with the wheel while it streams. Not one of the design loop's measured
// scenarios (loop/specs.ts names none for it).

import type { AssistantItem, ToolItem, TranscriptItem } from "@kantel/protocol";
import { useEffect, useState } from "react";
import { Composer } from "../../src/session/composer.tsx";
import { assistant, longTranscript, tool, user } from "../../src/session/fixtures.ts";
import { Transcript } from "../../src/session/transcript.tsx";

/** How often the stream delivers a batch, as the console's session client (tvdavies/harbour#148). */
const BATCH_MS = 100;

const prose =
	"I went through the retry path line by line and compared each branch with the ledger entries it writes. The worker shares the queue client with the API, so a retried job can reach the charge step twice when the first attempt times out after the provider has already accepted it. ".split(
		/(?<=\s)/,
	);
const words = (count: number, from = 0) => {
	let text = "";
	for (let i = 0; i < count; i++) text += prose[(from + i) % prose.length];
	return text;
};

type Follow = {
	/** Starts the live turn: `answerBatches` batches of answer after the thought and the calls. */
	start(answerBatches?: number): void;
	/** The turn has settled. */
	done: boolean;
};

declare global {
	interface Window {
		__follow?: Follow;
	}
}

const history: TranscriptItem[] = longTranscript(30);

export function FollowScenario() {
	const [items, setItems] = useState<TranscriptItem[]>(history);
	const [working, setWorking] = useState(false);
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const follow: Follow = {
			done: false,
			start(answerBatches = 300) {
				const now = Date.now();
				setWorking(true);
				setItems([
					...history,
					{ ...user("fu", "Find out why customers were charged twice and fix it."), at: now },
					{ ...assistant("fa1", "", { streaming: true }), at: now },
				]);
				let tick = 0;
				const update = (id: string, change: (item: TranscriptItem) => TranscriptItem) =>
					setItems((previous) => previous.map((item) => (item.id === id ? change(item) : item)));
				const append = (...more: TranscriptItem[]) => setItems((previous) => [...previous, ...more]);
				const call = (id: string, label: string): ToolItem => ({
					...tool(id, "bash", label, { status: "running", args: { command: label } }),
					at: Date.now(),
				});
				timer = setInterval(() => {
					tick++;
					if (tick <= 15) {
						// A thought streams.
						update("fa1", (item) => ({ ...item, thinking: words(tick * 6) }) as AssistantItem);
					} else if (tick === 16) {
						update(
							"fa1",
							(item) => ({ ...item, text: "I'll check the worker's logs first.", streaming: false }) as AssistantItem,
						);
						append(call("ft1", "rg retryCharge src"));
					} else if (tick === 20) {
						update(
							"ft1",
							(item) =>
								({ ...item, status: "done", endedAt: Date.now(), output: "src/billing/retry.ts:41" }) as ToolItem,
						);
						append(call("ft2", "pnpm test billing"));
					} else if (tick === 24) {
						update(
							"ft2",
							(item) => ({ ...item, status: "done", endedAt: Date.now(), output: "21 passed" }) as ToolItem,
						);
						append({ ...assistant("fa2", "", { streaming: true }), at: Date.now() });
					} else if (tick > 24 && tick <= 34) {
						// A second thought, which folds behind its disclosure when the answer starts.
						update("fa2", (item) => ({ ...item, thinking: words((tick - 24) * 8, 7) }) as AssistantItem);
					} else if (tick > 34 && tick <= 34 + answerBatches) {
						const n = tick - 34;
						// Paragraphs, so Markdown splits the answer into blocks as a real one does.
						let text = "";
						for (let i = 0; i < n; i++) text += `${words(6, i * 6)}${i % 8 === 7 ? "\n\n" : ""}`;
						update("fa2", (item) => ({ ...item, text }) as AssistantItem);
					} else if (tick > 34 + answerBatches) {
						update("fa2", (item) => ({ ...item, streaming: false }) as AssistantItem);
						setWorking(false);
						follow.done = true;
						clearInterval(timer);
					}
				}, BATCH_MS);
			},
		};
		window.__follow = follow;
		return () => clearInterval(timer);
	}, []);
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "calc(100vh - var(--kt-space-6) * 2)",
			}}
		>
			<Transcript
				items={items}
				working={working}
				dock={<Composer state={working ? "running" : "idle"} onSend={() => {}} onStop={() => {}} label="Message" />}
			/>
		</div>
	);
}
