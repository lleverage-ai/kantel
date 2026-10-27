import type { BrowserGrantCard as BrowserGrantCardData, QuestionCard as QuestionCardData } from "@harbour/protocol";
import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Elapsed } from "../primitives/time.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import { BrowserGrantCard } from "./browser-grant-card.tsx";
import { question } from "./fixtures.ts";
import { QuestionCard } from "./question-card.tsx";

export default { title: "Session/Question and browser cards" } satisfies StoryDefault;

// fixtures.ts has no browser grant yet; this one is local until it does.
const browser = (overrides: Partial<BrowserGrantCardData> = {}): BrowserGrantCardData => ({
	type: "browser.grant",
	requestId: "br_1",
	reason: "To check the staging dashboard shows the new invoice totals after the migration dry run.",
	status: "pending",
	...overrides,
});

const longQuestion = question({
	text: "The billing-staging database has 41 tenants, but the migration plan in docs/migrations/2026-10-billing.md only lists 38 of them, and three of the missing ones (acme-eu, northwind-legacy and globex-test) still have open invoices from September. Should I include them in the dry run, leave them out and list them in the PR, or stop and wait until someone confirms which tenants are in scope?",
	options: [
		"Include all 41 tenants in the dry run, and flag the three that aren't in the plan in the PR description",
		"Run only the 38 tenants in the plan and list the other three, with their open invoice counts, in the PR",
		"Stop here and wait until someone on the billing team confirms which tenants are in scope for this migration",
	],
});

function QuestionDemo({ initial, busyFor = 0 }: { initial: QuestionCardData; busyFor?: number }) {
	const [card, setCard] = useState(initial);
	const [busy, setBusy] = useState(false);
	return (
		<Column>
			<QuestionCard
				card={card}
				busy={busy}
				onAnswer={(answer) => {
					if (busyFor === 0) {
						setCard({ ...card, status: "answered", answer });
						return;
					}
					setBusy(true);
					setTimeout(() => {
						setBusy(false);
						setCard({ ...card, status: "answered", answer });
					}, busyFor);
				}}
			/>
			{card.status === "open" ? null : (
				<Row>
					<Button size="xs" onClick={() => setCard(initial)}>
						Ask again
					</Button>
				</Row>
			)}
		</Column>
	);
}

function BrowserDemo({ initial }: { initial: BrowserGrantCardData }) {
	const [card, setCard] = useState(initial);
	return (
		<Column>
			<BrowserGrantCard
				card={card}
				onGrant={() => setCard({ ...card, status: "granted" })}
				onDeny={() => setCard({ ...card, status: "denied" })}
			/>
			{card.status === "pending" ? null : (
				<Row>
					<Button size="xs" onClick={() => setCard(initial)}>
						Ask again
					</Button>
				</Row>
			)}
		</Column>
	);
}

export const Default: Story = () => (
	<Sheet
		title="Question and browser cards"
		intro="Every state of both cards. Open cards ask for a decision; settled ones fold to one quiet line. The open ones work: answer or decide, then ask again."
	>
		<Section title="Question, open">
			<QuestionDemo initial={question()} />
		</Section>
		<Section title="Question, answered">
			<Column>
				<QuestionCard card={question({ status: "answered", answer: "billing-staging (Postgres 16)" })} />
			</Column>
		</Section>
		<Section title="Question, withdrawn">
			<Column>
				<QuestionCard card={question({ status: "withdrawn" })} />
			</Column>
		</Section>
		<Section title="Question, no options">
			<QuestionDemo initial={question({ text: "What should the PR be called?", options: [] })} />
		</Section>
		<Section title="Browser, pending">
			<BrowserDemo initial={browser()} />
		</Section>
		<Section title="Browser, allowed">
			<Column>
				<BrowserGrantCard card={browser({ status: "granted" })} />
			</Column>
		</Section>
		<Section title="Browser, declined">
			<Column>
				<BrowserGrantCard card={browser({ status: "denied" })} />
			</Column>
		</Section>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet
		title="Cards, sending the decision"
		intro="Busy: the button pressed shows a spinner until the host confirms. The first question takes a second to answer, to show it."
	>
		<Section title="Question, answer on its way">
			<QuestionDemo initial={question()} busyFor={1200} />
		</Section>
		<Section title="Question, busy">
			<Column>
				<QuestionCard card={question()} busy onAnswer={() => {}} />
			</Column>
		</Section>
		<Section title="Browser, busy">
			<Column>
				<BrowserGrantCard card={browser()} busy onGrant={() => {}} onDeny={() => {}} />
			</Column>
		</Section>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet
		title="Question with no options"
		intro="With no options there is just the text field, labelled Your answer. Answer is disabled until something is typed."
	>
		<QuestionDemo initial={question({ text: "What should the PR be called?", options: [] })} />
		<QuestionDemo initial={question({ text: "What should the PR be called?", options: undefined })} />
	</Sheet>
);

const started = Date.now() - 200_000;

export const Streaming: Story = () => (
	<Sheet
		title="Question while the agent works"
		intro="An open question doesn't stop the agent: it carries on with what it can and uses the answer when it comes."
	>
		<Column>
			<Row>
				<StatusLabel status="working">
					Working for <Elapsed since={started} />
				</StatusLabel>
			</Row>
			<QuestionDemo initial={question()} />
		</Column>
	</Sheet>
);

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => (
	<Sheet
		title="Cards, decision failed"
		intro="If the answer or decision doesn't reach the host, the card stays open with a notice above it, so you can try again."
	>
		<Column>
			<Notice level="error">Couldn't send your answer. Check the connection and try again.</Notice>
			<QuestionDemo initial={question()} />
			<Notice level="error">Couldn't send your decision. Try again.</Notice>
			<BrowserDemo initial={browser()} />
		</Column>
	</Sheet>
);

export const LongContent: Story = () => (
	<Sheet
		title="Cards, long content"
		intro="Long questions, options and reasons wrap; settled lines truncate, with the full text on hover."
	>
		<QuestionDemo initial={longQuestion} />
		<Column>
			<QuestionCard card={{ ...longQuestion, status: "answered", answer: longQuestion.options?.[1] ?? "" }} />
		</Column>
		<BrowserDemo
			initial={browser({
				reason:
					"To sign in to the Stripe dashboard with the test account, open the payments for the three tenants that were double charged last night, and check that each one now shows a single charge and a refund for the duplicate, since the API doesn't expose the refund's dashboard status.",
			})}
		/>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Cards at 420px" intro="On a phone the options get the touch height and the buttons share the row.">
		<QuestionDemo initial={question()} />
		<BrowserDemo initial={browser()} />
		<Column>
			<QuestionCard card={question({ status: "answered", answer: "A fresh copy from last night's backup" })} />
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };
