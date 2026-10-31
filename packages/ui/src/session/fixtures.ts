// Fixtures for the session components' stories, tests and the design loop's scenarios. One set, so every story,
// test and measurement shows the same session. Times are relative to a fixed instant so screenshots are stable.

import type {
	AssistantItem,
	BrowserGrantCard,
	CardItem,
	NoticeItem,
	QuestionCard,
	ToolItem,
	TranscriptItem,
	UserItem,
	VaultApprovalCard,
} from "@kantel/protocol";
import type { SessionSummary } from "./session-model.ts";

/** The instant fixtures are relative to: 27 October 2026, 12:00 UTC. */
export const FIXTURE_NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const at = (secondsAgo: number): number => FIXTURE_NOW - secondsAgo * 1000;

export const user = (id: string, text: string, secondsAgo = 300): UserItem => ({
	kind: "user",
	id,
	at: at(secondsAgo),
	text,
	via: "prompt",
});

export const assistant = (
	id: string,
	text: string,
	options: { streaming?: boolean; thinking?: string; secondsAgo?: number } = {},
): AssistantItem => ({
	kind: "assistant",
	id,
	at: at(options.secondsAgo ?? 200),
	text,
	streaming: options.streaming ?? false,
	...(options.thinking === undefined ? {} : { thinking: options.thinking }),
});

export const tool = (
	id: string,
	name: string,
	label: string,
	options: { status?: ToolItem["status"]; args?: unknown; output?: string; seconds?: number; secondsAgo?: number } = {},
): ToolItem => {
	const started = at(options.secondsAgo ?? 250);
	const status = options.status ?? "done";
	return {
		kind: "tool",
		id,
		at: started,
		callId: `call-${id}`,
		name,
		label,
		status,
		...(options.args === undefined ? {} : { args: options.args }),
		...(options.output === undefined ? {} : { output: options.output }),
		...(status === "running" ? {} : { endedAt: started + (options.seconds ?? 1.4) * 1000 }),
	};
};

export const notice = (id: string, level: NoticeItem["level"], text: string): NoticeItem => ({
	kind: "notice",
	id,
	at: at(100),
	level,
	text,
});

export const vaultCard = (overrides: Partial<VaultApprovalCard> = {}): VaultApprovalCard => ({
	type: "vault.approval",
	proposalId: "prop_7Kq2",
	status: "pending",
	bindingCode: "RIVER-48",
	what: "A Linear API key",
	why: "To file the three bugs from last night's sweep as Linear issues in the Platform team.",
	host: "api.linear.app",
	methods: ["POST"],
	pathPrefix: "/graphql",
	injectionTemplate: "Authorization: Bearer {{secret}}",
	termsSource: "agent-proposed",
	expiresAt: FIXTURE_NOW + 14 * 60_000 + 59_000,
	link: "https://harbour.dev/connections/requests/prop_7Kq2",
	...overrides,
});

export const card = (id: string, value: CardItem["card"], secondsAgo = 60): CardItem => ({
	kind: "card",
	id,
	at: at(secondsAgo),
	card: value,
});

export const question = (overrides: Partial<QuestionCard> = {}): QuestionCard => ({
	type: "question",
	questionId: "q_1",
	text: "Which staging database should I use for the migration dry run?",
	options: [
		"billing-staging (Postgres 16)",
		"billing-staging-old (Postgres 14)",
		"A fresh copy from last night's backup",
	],
	status: "open",
	...overrides,
});

export const browser = (overrides: Partial<BrowserGrantCard> = {}): BrowserGrantCard => ({
	type: "browser.grant",
	requestId: "br_1",
	reason: "To check the staging dashboard shows the new invoice totals after the migration dry run.",
	status: "pending",
	...overrides,
});

const answer = `I found the cause. The billing worker retries a failed charge **without** checking whether the first attempt reached Stripe, so a timeout can charge a customer twice.

The fix is to send an idempotency key with every charge:

\`\`\`ts
await stripe.charges.create(charge, { idempotencyKey: \`charge-\${invoice.id}-\${attempt}\` });
\`\`\`

Changes:

1. \`src/billing/charge.ts\` sends the key.
2. \`src/billing/retry.ts\` reuses the key on retry instead of making a new one.
3. A test covers a timeout followed by a retry.

| Check | Result |
| --- | --- |
| Unit tests | 214 passed |
| Typecheck | Clean |`;

/** A finished turn: a question, some work, an answer. */
export const finishedTurn: TranscriptItem[] = [
	user("u1", "The billing worker charged two customers twice last night. Find out why and fix it.", 420),
	tool("t1", "read", "Read src/billing/charge.ts", {
		args: { path: "src/billing/charge.ts" },
		output: "export async function charge(invoice) {\n  // 84 lines\n}",
		seconds: 0.2,
		secondsAgo: 410,
	}),
	tool("t2", "grep", "Searched for retryCharge", {
		args: { pattern: "retryCharge", path: "src" },
		output: "src/billing/retry.ts:41\nsrc/billing/worker.ts:12",
		seconds: 0.4,
		secondsAgo: 405,
	}),
	tool("t3", "bash", "Ran pnpm test billing", {
		args: { command: "pnpm test billing" },
		output:
			" ✓ billing/charge.test.ts (12)\n ✓ billing/retry.test.ts (9)\n\n Test Files  2 passed\n      Tests  21 passed",
		seconds: 6.8,
		secondsAgo: 400,
	}),
	tool("t4", "edit", "Edited src/billing/retry.ts", {
		args: { path: "src/billing/retry.ts" },
		output: "@@ -38,7 +38,9 @@",
		seconds: 0.1,
		secondsAgo: 360,
	}),
	assistant("a1", answer, {
		thinking: "The double charge points at a retry without idempotency. Check retry.ts first.",
		secondsAgo: 300,
	}),
];

/** A turn in progress: the agent is running a command and streaming its first words. */
export const liveTurn: TranscriptItem[] = [
	user("u2", "Now run the full suite and open a PR.", 60),
	tool("t5", "bash", "Ran pnpm typecheck", {
		args: { command: "pnpm typecheck" },
		output: "Done in 8.2s",
		seconds: 8.2,
		secondsAgo: 55,
	}),
	tool("t6", "bash", "Running pnpm test", {
		status: "running",
		args: { command: "pnpm test" },
		output: " ✓ billing/charge.test.ts (13)\n ✓ billing/retry.test.ts (10)\n ⠋ api/invoices.test.ts",
		secondsAgo: 30,
	}),
	assistant("a2", "The typecheck is clean. Running the full test suite now", { streaming: true, secondsAgo: 5 }),
];

/** Every card state, for the cards' stories. */
export const cards: TranscriptItem[] = [
	card("c1", vaultCard()),
	card("c2", question()),
	notice("n1", "warning", "The last command was interrupted and may have partly run."),
];

/** A long transcript of `turns` finished turns, for scroll, virtualisation and profiling. */
export function longTranscript(turns: number): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	for (let turn = 0; turn < turns; turn++) {
		const ago = (turns - turn) * 600;
		items.push(user(`lu${turn}`, `Step ${turn + 1}: check the next tenant's invoices and fix any duplicates.`, ago));
		items.push(
			tool(`lt${turn}a`, "read", `Read invoices/tenant-${turn + 1}.json`, { seconds: 0.2, secondsAgo: ago - 10 }),
		);
		items.push(
			tool(`lt${turn}b`, "bash", `Ran node scripts/dedupe.ts --tenant ${turn + 1}`, {
				seconds: 2.1,
				secondsAgo: ago - 20,
			}),
		);
		items.push(
			assistant(
				`la${turn}`,
				`Tenant ${turn + 1} had ${turn % 3} duplicate invoices. ${turn % 3 === 0 ? "Nothing to fix." : "I voided the duplicates and logged them in `dedupe.log`."}`,
				{ secondsAgo: ago - 30 },
			),
		);
	}
	return items;
}

export const sessions: SessionSummary[] = [
	{
		id: "s1",
		title: "Rotate the Linear API key",
		project: "sal",
		branch: "main",
		status: "waiting",
		needs: "approval",
		startedAt: at(900),
		updatedAt: at(60),
	},
	{
		id: "s2",
		title: "Which staging database for the dry run?",
		project: "harbour",
		branch: "ui/session-components",
		status: "waiting",
		needs: "answer",
		startedAt: at(1800),
		updatedAt: at(240),
	},
	{
		id: "s3",
		title: "Fix the billing worker's double charges",
		project: "lleverage",
		branch: "fix/billing-idempotency",
		status: "running",
		startedAt: at(200),
		updatedAt: at(2),
	},
	{
		id: "s4",
		title: "Nightly bug sweep",
		project: "sal",
		status: "failed",
		startedAt: at(30_000),
		updatedAt: at(28_000),
	},
	{
		id: "s5",
		title: "Summarise yesterday's customer calls and draft the follow-up emails for the three that asked for pricing",
		project: "lleverage",
		status: "done",
		unread: true,
		startedAt: at(9000),
		updatedAt: at(7200),
	},
	{
		id: "s6",
		title: "Upgrade Vite to 8.3",
		project: "harbour",
		branch: "deps/vite-8.3",
		status: "done",
		startedAt: at(200_000),
		updatedAt: at(190_000),
	},
];
