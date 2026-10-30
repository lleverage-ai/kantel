import type { ToolItem } from "@harbour/protocol";
import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { EXAMPLE_SCREENSHOT } from "./fixture-screenshot.ts";
import { finishedTurn, tool } from "./fixtures.ts";
import { ToolCallChip, ToolCallGroup } from "./tool-call.tsx";

export default { title: "Session/Tool call" } satisfies StoryDefault;

// Running calls start on the real clock, so their start time on hover reads as now.
const running = (item: ToolItem, secondsAgo = 12): ToolItem => ({ ...item, at: Date.now() - secondsAgo * 1000 });

const kinds: ToolItem[] = [
	tool("k1", "read", "Read src/billing/charge.ts", {
		args: { path: "src/billing/charge.ts" },
		output: "export async function charge(invoice) {\n  // 84 lines\n}",
		seconds: 0.2,
	}),
	tool("k2", "edit", "Edited src/billing/retry.ts", {
		args: { path: "src/billing/retry.ts", edits: [{ oldText: "attempt()", newText: "attempt(key)" }] },
		output: "Successfully replaced 1 block(s) in src/billing/retry.ts.",
		seconds: 0.1,
	}),
	tool("k3", "bash", "Ran pnpm test billing", {
		args: { command: "pnpm test billing" },
		output: " Test Files  2 passed\n      Tests  21 passed",
		seconds: 6.8,
	}),
	tool("k4", "grep", "Searched for retryCharge", {
		args: { pattern: "retryCharge", path: "src" },
		output: "src/billing/retry.ts:41\nsrc/billing/worker.ts:12",
		seconds: 0.4,
	}),
	tool("k5", "web_fetch", "Fetched the Stripe idempotency docs", {
		args: { url: "https://docs.stripe.com/api/idempotent_requests" },
		output: "Idempotent requests: the API supports idempotency for safely retrying requests.",
		seconds: 1.9,
	}),
	tool("k6", "vault_request", "Asked the vault for a Linear API key", {
		args: { host: "api.linear.app", methods: ["POST"] },
		output: "Waiting for approval",
		seconds: 64,
	}),
	tool("k7", "notify", "Sent a note to the billing channel", { args: { channel: "billing" }, seconds: 0.6 }),
];

const statuses: ToolItem[] = [
	running(
		tool("s1", "bash", "Running pnpm test", {
			status: "running",
			args: { command: "pnpm test" },
			output: " ✓ billing/charge.test.ts (13)\n ✓ billing/retry.test.ts (10)",
		}),
	),
	tool("s2", "bash", "Ran pnpm typecheck", {
		args: { command: "pnpm typecheck" },
		output: "Done in 8.2s",
		seconds: 8.2,
	}),
	tool("s3", "bash", "Ran pnpm migrate --env staging", {
		status: "error",
		args: { command: "pnpm migrate --env staging" },
		output: "error: connection to billing-staging refused",
		seconds: 3.2,
	}),
	tool("s4", "bash", "Ran pnpm migrate --env staging --retry", {
		status: "interrupted",
		args: { command: "pnpm migrate --env staging --retry" },
		seconds: 12,
	}),
];

export const Default: Story = () => (
	<Sheet
		title="Tool call"
		intro="Quiet work-log rows: an icon for the kind of call, the host's label and a chevron. Hover or focus a row for when it started; select it for its arguments and output."
	>
		<Section title="Kinds">
			<Column>
				<div>
					{kinds.map((item) => (
						<ToolCallChip key={item.id} item={item} />
					))}
				</div>
			</Column>
		</Section>
		<Section title="Statuses">
			<Column>
				<div>
					{statuses.map((item) => (
						<ToolCallChip key={item.id} item={item} />
					))}
				</div>
			</Column>
		</Section>
		<Section title="Open">
			<Column>
				<ToolCallChip item={kinds[2] as ToolItem} defaultOpen />
			</Column>
		</Section>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet
		title="Tool call running"
		intro="A call has no loading state of its own; the nearest is a call that is running: a spinner in place of its icon and its label at full strength."
	>
		<Column>
			<div>
				<ToolCallChip
					item={running(
						tool("l1", "bash", "Running pnpm install", { status: "running", args: { command: "pnpm install" } }),
						4,
					)}
				/>
				<ToolCallChip
					item={running(
						tool("l2", "read", "Reading invoices/tenant-12.json", {
							status: "running",
							args: { path: "invoices/tenant-12.json" },
						}),
						1,
					)}
					defaultOpen
				/>
			</div>
		</Column>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="Tool call with nothing to show" intro="No arguments and no output, finished and running, both open.">
		<Column>
			<div>
				<ToolCallChip item={tool("e1", "list_sessions", "Listed the open sessions", { seconds: 0.3 })} defaultOpen />
				<ToolCallChip item={running(tool("e2", "bash", "Running a command", { status: "running" }), 2)} defaultOpen />
			</div>
		</Column>
	</Sheet>
);

const testLines = [
	" ✓ billing/charge.test.ts (13)",
	" ✓ billing/retry.test.ts (10)",
	" ✓ api/invoices.test.ts (42)",
	" ✓ api/customers.test.ts (18)",
	" ✓ worker/queue.test.ts (27)",
	" ✓ worker/schedule.test.ts (9)",
];

/** Output arrives a line every 300ms; after 40 lines the call finishes. */
function StreamingDemo() {
	const [item, setItem] = useState<ToolItem>(() =>
		running(tool("st1", "bash", "Running pnpm test", { status: "running", args: { command: "pnpm test" } }), 0),
	);
	useEffect(() => {
		let lines = 0;
		const timer = setInterval(() => {
			lines++;
			const done = lines >= 40;
			const line = testLines[lines % testLines.length] ?? "";
			setItem((previous) => {
				const output = previous.output === undefined ? line : `${previous.output}\n${line}`;
				return done
					? {
							...previous,
							label: "Ran pnpm test",
							status: "done",
							endedAt: Date.now(),
							output: `${output}\n\n Tests  640 passed`,
						}
					: { ...previous, output };
			});
			if (done) clearInterval(timer);
		}, 300);
		return () => clearInterval(timer);
	}, []);
	return (
		<Sheet
			title="Tool call streaming output"
			intro="A running call, open, its output growing as it arrives. Only this row renders on each line."
		>
			<Column>
				<ToolCallChip item={item} defaultOpen />
			</Column>
		</Sheet>
	);
}

export const Streaming: Story = () => <StreamingDemo />;

// Named ErrorState so the export does not shadow the global Error; Ladle shows it as "Error".
export const ErrorState: Story = () => (
	<Sheet
		title="Tool call failed"
		intro="A failed call keeps its label readable; the icon says it failed and the output is in the error tone. An interrupted call may have partly run."
	>
		<Column>
			<div>
				<ToolCallChip item={statuses[2] as ToolItem} defaultOpen />
				<ToolCallChip item={statuses[3] as ToolItem} defaultOpen />
			</div>
		</Column>
	</Sheet>
);
ErrorState.storyName = "Error";

const longOutput = Array.from(
	{ length: 300 },
	(_, index) =>
		`${String(index + 1).padStart(3, "0")}  tenant-${(index % 37) + 1}  exported ${(index * 7) % 113} invoices`,
).join("\n");

const longCommand =
	"node scripts/export-invoices.ts --all-tenants --format jsonl --out /tmp/exports/2026-10-27/invoices-all-tenants-deduplicated-with-idempotency-keys.jsonl --verbose --concurrency 8";

export const LongContent: Story = () => (
	<Sheet
		title="Tool call with long content"
		intro="A label that truncates, a command that wraps, 300 lines of output that scroll inside their block, and arguments with a long unbroken value."
	>
		<Column>
			<div>
				<ToolCallChip
					item={tool("lc1", "bash", `Ran ${longCommand}`, {
						args: { command: longCommand },
						output: longOutput,
						seconds: 74,
					})}
					defaultOpen
				/>
				<ToolCallChip
					item={tool("lc2", "web_fetch", "Fetched the signed export link", {
						args: {
							url: "https://storage.harbour.dev/exports/billing/2026-10-27/invoices.jsonl?signature=8f7a6c5e4d3b2a1908f7a6c5e4d3b2a198f7a6c5e4d3b2a1908f7a6c5e4d3b2a19",
							headers: { accept: "application/jsonl" },
						},
						output: "200 OK, 18.4 MB",
						seconds: 2.4,
					})}
					defaultOpen
				/>
			</div>
		</Column>
	</Sheet>
);

const finishedTools = finishedTurn.filter((item): item is ToolItem => item.kind === "tool");

const withFailure: ToolItem[] = [
	...finishedTools.slice(0, 2),
	tool("gf", "bash", "Ran pnpm test billing", {
		status: "error",
		args: { command: "pnpm test billing" },
		output: " ✗ billing/retry.test.ts (1 failed)",
		seconds: 5.1,
		secondsAgo: 402,
	}),
	...finishedTools.slice(3),
];

const liveTools: ToolItem[] = [
	tool("gl1", "read", "Read src/billing/charge.ts", { seconds: 0.2 }),
	tool("gl2", "grep", "Searched for retryCharge", { seconds: 0.4 }),
	running(
		tool("gl3", "bash", "Running pnpm test billing", { status: "running", args: { command: "pnpm test billing" } }),
	),
];

export const Group: Story = () => (
	<Sheet
		title="Tool call group"
		intro="Consecutive calls. A finished group, however small, collapses to how long the work took (the calls carry no duration of their own); a failed step stays visible under the summary. A live or running group shows every call."
	>
		<Section title="Collapsed">
			<Column>
				<ToolCallGroup items={finishedTools} />
			</Column>
		</Section>
		<Section title="Collapsed, with a failed step">
			<Column>
				<ToolCallGroup items={withFailure} />
			</Column>
		</Section>
		<Section title="Running">
			<Column>
				<ToolCallGroup items={liveTools} />
			</Column>
		</Section>
		<Section title="Live, all finished">
			<Column>
				<ToolCallGroup items={finishedTools} live />
			</Column>
		</Section>
		<Section title="One call, collapsed">
			<Column>
				<ToolCallGroup items={finishedTools.slice(0, 1)} />
			</Column>
		</Section>
	</Sheet>
);

const shot = { mimeType: "image/png", data: EXAMPLE_SCREENSHOT } as const;

const browsing: ToolItem[] = [
	tool("b1", "browser_request", "Asking for a browser", {
		args: { reason: "Look up what example.com says", sites: ["example.com"] },
		output: "Granted: a browser for example.com.",
		seconds: 9,
	}),
	{
		...tool("b2", "browser_open", "Opening example.com", {
			args: { url: "https://example.com" },
			output: "URL: https://example.com/\nTitle: Example Domain",
			seconds: 3.1,
		}),
		images: [shot],
	},
	{
		...tool("b3", "browser_act", "Reading the page", {
			args: { action: "look" },
			output: "URL: https://example.com/\nTitle: Example Domain\n\nThis domain is for use in documentation examples.",
			seconds: 0.8,
		}),
		images: [shot],
	},
];

export const Browser: Story = () => (
	<Sheet
		title="Browser calls with screenshots"
		intro="A browser call shows the page it left under its row, without opening it, so a person watches the browser move. Select a screenshot to open it full size. A folded group keeps the last one in view."
	>
		<Section title="Running">
			<Column>
				<ToolCallGroup
					items={[
						...browsing.slice(0, 2),
						running(
							tool("b4", "browser_act", "Clicking on the page", {
								status: "running",
								args: { action: "click", element: "3" },
							}),
							1,
						),
					]}
				/>
			</Column>
		</Section>
		<Section title="Collapsed">
			<Column>
				<ToolCallGroup items={browsing} />
			</Column>
		</Section>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Tool calls at 420px" intro="Rows, an open call and a collapsed group on a phone.">
		<Column>
			<div>
				{statuses.map((item) => (
					<ToolCallChip key={item.id} item={item} />
				))}
			</div>
			<ToolCallChip item={kinds[2] as ToolItem} defaultOpen />
			<ToolCallGroup items={withFailure} />
			<ToolCallGroup items={browsing} live />
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };
