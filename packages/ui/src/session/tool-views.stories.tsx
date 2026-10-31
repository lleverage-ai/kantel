import type { ToolItem } from "@kantel/protocol";
import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { tool } from "./fixtures.ts";
import { ToolCallChip } from "./tool-call.tsx";

// The cards read, write, edit and bash calls open as (tool-views.tsx): a file in a code view, an edit as a diff, a
// command as an inline terminal. Every other tool keeps the generic Arguments and Output detail (tool-call.stories).

export default { title: "Session/Tool cards" } satisfies StoryDefault;

const ESC = "\u001b";

const script = `"""Release notes from merged pull requests, grouped by label."""

import argparse
import json
from collections import defaultdict
from datetime import date

SECTIONS = {"feature": "New", "fix": "Fixed", "docs": "Documentation"}


def group(prs: list[dict], since: date) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for pr in prs:
        if date.fromisoformat(pr["merged_at"][:10]) < since:
            continue
        labels = pr.get("labels") or ["other"]
        section = next((SECTIONS[l] for l in labels if l in SECTIONS), "Other")
        groups[section].append(pr)
    return groups


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--since", type=date.fromisoformat, required=True)
    args = parser.parse_args()
    with open(args.path, encoding="utf-8") as handle:
        print(json.dumps(group(json.load(handle), args.since), indent=2))
    return 0
`;

const running = (item: ToolItem): ToolItem => ({ ...item, at: Date.now() });

const verbs: Record<string, readonly [string, string]> = {
	read: ["Reading", "Read"],
	write: ["Writing", "Wrote"],
	edit: ["Editing", "Edited"],
	bash: ["Running", "Ran"],
};

/** A call with the label a host gives it (the cards make their own; the generic row shows this one). */
const card = (id: string, name: string, options: Parameters<typeof tool>[3] & { args: Record<string, unknown> }) => {
	const subject = name === "bash" ? String(options.args.command ?? "").split("\n")[0] : String(options.args.path ?? "");
	const [ongoing, done] = verbs[name] ?? ["Calling", "Called"];
	return tool(id, name, `${options.status === "running" ? ongoing : done} ${subject}`, options);
};

/** Grows `text` by `chars` every `gap` ms, then holds it; restarts when `text` changes. */
function useTyped(text: string, chars: number, gap: number): string {
	const [length, setLength] = useState(0);
	useEffect(() => {
		setLength(0);
		const timer = setInterval(() => {
			setLength((previous) => {
				if (previous >= text.length) clearInterval(timer);
				return Math.min(text.length, previous + chars);
			});
		}, gap);
		return () => clearInterval(timer);
	}, [text, chars, gap]);
	return text.slice(0, length);
}

function WriteStreaming() {
	const content = useTyped(script, 9, 30);
	const done = content.length === script.length;
	const item: ToolItem = done
		? card("w-live", "write", {
				args: { path: "notes/release_notes.py", content: script },
				output: "Successfully wrote to notes/release_notes.py",
				seconds: 0.1,
			})
		: {
				...running(card("w-live", "write", { status: "running", args: { path: "notes/release_notes.py", content } })),
				streaming: true,
			};
	return <ToolCallChip item={item} />;
}

const writes: ToolItem[] = [
	card("w1", "write", {
		args: { path: "src/billing/retry.ts", content: "export const MAX_ATTEMPTS = 3;\n" },
		output: "Successfully wrote to src/billing/retry.ts",
		seconds: 0.1,
	}),
	card("w2", "write", {
		status: "error",
		args: { path: "/etc/hosts", content: "127.0.0.1 billing.local\n" },
		output: "EACCES: permission denied, open '/etc/hosts'",
		seconds: 0.1,
	}),
];

export const Write: Story = () => (
	<Sheet
		title="Write"
		intro="The file as the model writes it: its path, a caret at the end, the window following the newest line. Then the tool's answer under it."
	>
		<Column>
			<Section title="Streaming in, then written">
				<WriteStreaming />
			</Section>
			<Section title="Written, and refused">
				{writes.map((item) => (
					<ToolCallChip key={item.id} item={item} />
				))}
			</Section>
		</Column>
	</Sheet>
);

const reads: ToolItem[] = [
	card("r1", "read", {
		args: { path: "data/prs.json", offset: 41, limit: 9 },
		output:
			'  {\n    "number": 312,\n    "title": "Console: show the model\'s cost per session",\n    "merged_at": "2026-10-24T16:02:11Z"\n  },\n  {\n    "number": 313,\n    "title": "Sandbox: keep the seed cache warm",\n    "labels": ["feature"],\n\n<harness>\n[info] 188 more lines in file. Use offset=50 to continue.\n</harness>',
		seconds: 0.2,
	}),
	card("r2", "read", { args: { path: "src/billing/charge.ts" }, output: script, seconds: 0.2 }),
	card("r3", "read", {
		status: "error",
		args: { path: "src/billing/refund.ts" },
		output: "ENOENT: no such file or directory, open 'src/billing/refund.ts'",
		seconds: 0.1,
	}),
];

export const Read: Story = () => (
	<Sheet
		title="Read"
		intro="Closed by default, as a read is context, not a change. Open, the lines it returned, numbered from where it started."
	>
		<Column>
			{reads.map((item) => (
				<ToolCallChip key={item.id} item={item} defaultOpen={item.id !== "r2"} />
			))}
		</Column>
	</Sheet>
);

const edit = {
	path: "notes/release_notes.py",
	edits: [
		{
			oldText: '        for label in pr["labels"]:\n            groups[SECTIONS.get(label, "Other")].append(pr)',
			newText:
				'        labels = pr.get("labels") or ["other"]\n        section = next((SECTIONS[l] for l in labels if l in SECTIONS), "Other")\n        groups[section].append(pr)',
		},
		{ oldText: "    return 0\n", newText: "    return 0 if groups else 1\n" },
	],
};

function EditStreaming() {
	const newText = edit.edits[0]?.newText ?? "";
	const typed = useTyped(newText, 6, 40);
	const done = typed.length === newText.length;
	const item: ToolItem = done
		? card("e-live", "edit", {
				args: edit,
				output: "Successfully replaced 2 block(s) in notes/release_notes.py.",
				seconds: 0.2,
			})
		: {
				...running(
					card("e-live", "edit", {
						status: "running",
						args: { path: edit.path, edits: [{ oldText: edit.edits[0]?.oldText, newText: typed }] },
					}),
				),
				streaming: true,
			};
	return <ToolCallChip item={item} />;
}

export const Edit: Story = () => (
	<Sheet title="Edit" intro="Each replacement as a diff: removed lines, then added ones, highlighted for the file.">
		<Column>
			<Section title="Streaming in, then applied">
				<EditStreaming />
			</Section>
			<Section title="Failed">
				<ToolCallChip
					item={card("e2", "edit", {
						status: "error",
						args: { path: "src/billing/retry.ts", edits: [{ oldText: "attempt()", newText: "attempt(key)" }] },
						output: "Could not find the exact text in src/billing/retry.ts. The old text must match exactly.",
						seconds: 0.1,
					})}
				/>
			</Section>
		</Column>
	</Sheet>
);

const pytest = `${ESC}[32m........${ESC}[0m${ESC}[32m [100%]${ESC}[0m\n${ESC}[32m${ESC}[1m8 passed${ESC}[0m${ESC}[32m in 0.41s${ESC}[0m`;

const commands: ToolItem[] = [
	card("b1", "bash", {
		args: { command: "python -m pytest notes -q --color=yes" },
		output: pytest,
		seconds: 1.2,
	}),
	card("b2", "bash", {
		status: "error",
		args: { command: "python notes/release_notes.py data/prs.json --since 2026-10-23" },
		output:
			'Traceback (most recent call last):\n  File "notes/release_notes.py", line 26, in group\n    for label in pr["labels"]:\nKeyError: \'labels\'\n\n<harness>\n[error] Command exited with code 1\n</harness>',
		seconds: 0.4,
	}),
	card("b3", "bash", {
		status: "error",
		args: { command: "pnpm vitest run --watch" },
		output: " RUN  v4.1.0\n\n<harness>\n[error] Command timed out after 120 seconds\n</harness>",
		seconds: 120,
	}),
	card("b4", "bash", {
		args: { command: "for i in 1 2 3; do\n  curl -s https://example.com/health\ndone" },
		output: "ok\nok\nok",
		seconds: 0.9,
	}),
];

const progress = [
	"collecting ... ",
	`${ESC}[32m..${ESC}[0m`,
	`${ESC}[32m....${ESC}[0m`,
	`${ESC}[32m..${ESC}[0m [100%]\n`,
];

function BashStreaming() {
	const command = "python -m pytest notes -q --color=yes";
	const typed = useTyped(command, 3, 40);
	const [pieces, setPieces] = useState(0);
	const typing = typed.length < command.length;
	useEffect(() => {
		if (typing) return;
		const timer = setInterval(() => setPieces((count) => Math.min(progress.length + 1, count + 1)), 500);
		return () => clearInterval(timer);
	}, [typing]);
	if (pieces > progress.length) {
		return <ToolCallChip item={card("b-live", "bash", { args: { command }, output: pytest, seconds: 2.1 })} />;
	}
	const item: ToolItem = {
		...running(
			card("b-live", "bash", {
				status: "running",
				args: { command: typed },
				...(pieces === 0 ? {} : { output: progress.slice(0, pieces).join("") }),
			}),
		),
		...(typing ? { streaming: true } : {}),
	};
	return <ToolCallChip item={item} />;
}

export const Mobile: Story = () => (
	<Sheet
		title="Tool cards at 420px"
		intro="Long lines scroll sideways inside the card; the gutter stays put and the header wraps."
	>
		<Column>
			<ToolCallChip item={writes[0] as ToolItem} />
			<ToolCallChip item={reads[0] as ToolItem} defaultOpen />
			<ToolCallChip item={card("m-edit", "edit", { args: edit, output: "Successfully replaced 2 block(s)." })} />
			<ToolCallChip item={commands[1] as ToolItem} />
		</Column>
	</Sheet>
);

export const Bash: Story = () => (
	<Sheet
		title="Bash"
		intro="An inline terminal: the command after its prompt, then what it printed, ANSI colours honoured. A non-zero exit, a timeout or an interruption is a badge, not a harness tag in the output."
	>
		<Column>
			<Section title="Typed, run, finished">
				<BashStreaming />
			</Section>
			<Section title="Finished">
				{commands.map((item) => (
					<ToolCallChip key={item.id} item={item} />
				))}
			</Section>
			<Section title="Interrupted">
				<ToolCallChip
					item={card("b5", "bash", {
						status: "interrupted",
						args: { command: "pnpm migrate --env staging" },
						output: "Applying 0042_charges_idempotency_key...",
						seconds: 12,
					})}
				/>
			</Section>
		</Column>
	</Sheet>
);
