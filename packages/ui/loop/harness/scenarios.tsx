// The loop's fixed scenarios, one per component in loop/specs.ts. Each mounts its component with checked-in
// fixtures and, in run(), plays a fixed sequence of data updates, one per frame, returning what changed, as an id
// (any component showing it) or `Component:id`: renders of anything else probed are wasted. Nothing here may change between a champion and its variants.

import type { AssistantItem, ToolItem, TranscriptItem } from "@harbour/protocol";
import { type ComponentType, useCallback, useState } from "react";
import { Composer, ComposerSendHint } from "../../src/session/composer.tsx";
import {
	assistant,
	FIXTURE_NOW,
	longTranscript,
	sessions as sampleSessions,
	tool,
	user,
	vaultCard,
} from "../../src/session/fixtures.ts";
import { SessionList } from "../../src/session/session-list.tsx";
import type { SessionSummary } from "../../src/session/session-model.ts";
import { ToolCallGroup } from "../../src/session/tool-call.tsx";
import { Transcript } from "../../src/session/transcript.tsx";
import { BindingCodePicker, VaultApprovalCard } from "../../src/session/vault-approval-card.tsx";
import { FollowScenario } from "./follow.tsx";

/** Resolves after the next frame has been produced: a rAF, then a task, so layout and paint have run. */
export function frame(): Promise<void> {
	return new Promise((resolve) =>
		requestAnimationFrame(() => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => resolve();
			channel.port2.postMessage(0);
		}),
	);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Marks the start of one update and the ids it may re-render (an id, or `Component:id`). Renders until the next
 * step are counted against this one, so a row re-rendered by another row's update counts as wasted.
 */
function step(changed: string[]) {
	(window as Window & { __hbStep?: (changed: string[]) => void }).__hbStep?.(changed);
}

export type Scenario = { Component: ComponentType; run(): Promise<{ changed: string[] }> };

/** A setter the mounted scenario hands out, so run() can drive it. */
function handle<T>() {
	let set: ((update: (value: T) => T) => void) | undefined;
	return {
		bind(setter: (update: (value: T) => T) => void) {
			set = setter;
		},
		update(update: (value: T) => T) {
			if (set === undefined) throw new Error("Scenario not mounted");
			set(update);
		},
	};
}

// 400 words of an answer, the same every run: prose with a list and a code block, so Markdown splits into blocks.
const words = (() => {
	const prose =
		"I checked each tenant's invoices against the ledger and voided the duplicates where both copies had the same number and amount. ";
	const list = "\n\n- tenant 4: two duplicates voided\n- tenant 9: one duplicate voided\n- tenant 12: none\n\n";
	const code = "\n\n```sh\nnode scripts/dedupe.ts --tenant 4 --dry-run\n```\n\n";
	const parts: string[] = [];
	for (let i = 0; parts.join(" ").split(/\s+/).length < 400; i++)
		parts.push(i % 5 === 2 ? list : i % 7 === 4 ? code : prose);
	return parts.join("").split(/(?<=\s)/);
})();

// Transcript: 300 earlier items, then an answer streams in 40 updates.
const transcript = handle<TranscriptItem[]>();
const STREAM_ID = "stream";
const transcriptStart: TranscriptItem[] = [
	...longTranscript(75),
	user("next", "Now summarise what changed across every tenant.", 5),
	assistant(STREAM_ID, "", { streaming: true, secondsAgo: 4 }),
];

function TranscriptScenario() {
	const [items, setItems] = useState(transcriptStart);
	transcript.bind(setItems);
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width: "100%",
				height: "calc(var(--hb-space-11) * 14)",
			}}
		>
			<Transcript items={items} />
		</div>
	);
}

async function runTranscript() {
	const batch = Math.ceil(words.length / 40);
	for (let i = 1; i <= 40; i++) {
		const text = words.slice(0, i * batch).join("");
		step([STREAM_ID]);
		transcript.update((items) => {
			const last = items[items.length - 1] as AssistantItem;
			return [...items.slice(0, -1), { ...last, text, streaming: i < 40 }];
		});
		await frame();
	}
	return { changed: [STREAM_ID] };
}

// Tool group: 12 calls, the last running; its output grows 10 times, then it finishes.
const toolGroup = handle<ToolItem[]>();
const LAST_TOOL = "g12";
const toolsStart: ToolItem[] = Array.from({ length: 12 }, (_, i) =>
	i < 11
		? tool(`g${i + 1}`, i % 3 === 0 ? "read" : "bash", `Ran step ${i + 1} of the tenant migration`, {
				seconds: 0.4 + i / 10,
				secondsAgo: 120 - i * 8,
			})
		: tool(LAST_TOOL, "bash", "Running node scripts/migrate.ts --all", { status: "running", secondsAgo: 20 }),
);

function ToolGroupScenario() {
	const [items, setItems] = useState(toolsStart);
	toolGroup.bind(setItems);
	return <ToolCallGroup items={items} live />;
}

async function runToolGroup() {
	for (let i = 1; i <= 11; i++) {
		const done = i === 11;
		step([LAST_TOOL]);
		toolGroup.update((items) => {
			const last = items[items.length - 1] as ToolItem;
			const output = Array.from({ length: i * 4 }, (_, line) => `migrated tenant ${line + 1}`).join("\n");
			return [
				...items.slice(0, -1),
				{
					...last,
					output,
					...(done
						? { status: "done" as const, endedAt: FIXTURE_NOW, label: "Ran node scripts/migrate.ts --all" }
						: {}),
				},
			];
		});
		await frame();
	}
	return { changed: [LAST_TOOL] };
}

// Composer: idle with a send hint. Its measures come from typing, so run() changes nothing.
function ComposerScenario() {
	return (
		<div style={{ maxWidth: "calc(var(--hb-space-11) * 20)" }}>
			<Composer state="idle" onSend={() => {}} footer={<ComposerSendHint />} label="Message" />
		</div>
	);
}

// Session list: 200 sessions; one changes at a time, 20 times.
const list = handle<SessionSummary[]>();
const listStart: SessionSummary[] = Array.from({ length: 200 }, (_, i) => {
	const base = sampleSessions[i % sampleSessions.length] as SessionSummary;
	return { ...base, id: `s${i}`, title: `${base.title} (${i + 1})` };
});

function SessionListScenario() {
	const [items, setItems] = useState(listStart);
	const [selected, setSelected] = useState("s0");
	list.bind(setItems);
	const onSelect = useCallback((id: string) => setSelected(id), []);
	return (
		<div style={{ width: "calc(var(--hb-space-11) * 8)" }}>
			<SessionList sessions={items} selectedId={selected} onSelect={onSelect} />
		</div>
	);
}

async function runSessionList() {
	const changed: string[] = [];
	for (let i = 0; i < 20; i++) {
		const id = `s${i * 7}`;
		changed.push(id);
		step([id]);
		list.update((items) =>
			items.map((session) =>
				session.id !== id
					? session
					: i % 2 === 0
						? { ...session, title: `${session.title}, renamed` }
						: { ...session, status: session.status === "running" ? "idle" : "running", unread: false },
			),
		);
		await frame();
	}
	return { changed };
}

// Vault card: a pending card on the clock for five seconds, beside the vault page's code picker.
const pending = vaultCard({ expiresAt: Date.now() + 14 * 60_000 + 30_000 });
const codes = ["RIVER-48", "MAPLE-12", "STONE-73", "CEDAR-05"];

function VaultScenario() {
	const [code, setCode] = useState<string | undefined>(undefined);
	return (
		<div style={{ maxWidth: "calc(var(--hb-space-11) * 14)", display: "grid", gap: "var(--hb-space-6)" }}>
			<VaultApprovalCard card={pending} />
			<BindingCodePicker codes={codes} value={code} onPick={setCode} />
		</div>
	);
}

// Five seconds of a pending card. The card says how long is left only in the Lifetime term ("15 minutes left"),
// which changes once a minute, so nothing on it needs to change here: every render in these five seconds is waste.
async function runVault() {
	step([]);
	await wait(5_000);
	return { changed: [] };
}

export const scenarios: Record<string, Scenario> = {
	transcript: { Component: TranscriptScenario, run: runTranscript },
	"tool-group": { Component: ToolGroupScenario, run: runToolGroup },
	composer: { Component: ComposerScenario, run: async () => ({ changed: [] }) },
	"session-list": { Component: SessionListScenario, run: runSessionList },
	"vault-card": { Component: VaultScenario, run: runVault },
	// Not measured: loop/follow.ts drives it with the wheel while it streams (follow.tsx).
	follow: { Component: FollowScenario, run: async () => ({ changed: [] }) },
};
