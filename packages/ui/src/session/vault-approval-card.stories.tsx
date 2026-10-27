import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import { FIXTURE_NOW, vaultCard } from "./fixtures.ts";
import { BindingCodePicker as Picker, VaultApprovalCard, VaultApprovalCardSkeleton } from "./vault-approval-card.tsx";

export default { title: "Session/Vault approval card" } satisfies StoryDefault;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const routeGrant = vaultCard({
	proposalId: "prop_R0ut",
	bindingCode: "HARBOR-62",
	what: "Access to the staging admin API",
	why: "To list the stuck invoice jobs and retry the three that failed overnight.",
	host: "admin.staging.lleverage.ai",
	methods: ["*"],
	pathPrefix: "/jobs",
	injectionTemplate: undefined,
	link: "https://vault.harbour.dev/p/prop_R0ut",
});

export const Default: Story = () => (
	<Sheet
		title="Vault approval card"
		intro="A pending request with the agent's proposed terms, said once above them. The binding code is the one thing to compare with the vault page before approving."
	>
		<Column>
			<VaultApprovalCard card={vaultCard()} now={FIXTURE_NOW} />
		</Column>
	</Sheet>
);

export const Proposed: Story = () => (
	<Sheet
		title="Vault approval card: proposed"
		intro="Fresh proposals, every term still the agent's. A write (POST) and a read (GET) look the same here; on the vault page the write asks the approver to pick the matching code, the read only shows it. With under two minutes left, the Lifetime term turns amber."
	>
		<Column>
			<VaultApprovalCard card={vaultCard()} now={FIXTURE_NOW} requester="Billing agent" />
			<VaultApprovalCard
				card={vaultCard({
					proposalId: "prop_R3ad",
					bindingCode: "MAPLE-17",
					what: "A read-only GitHub token",
					why: "To list last week's merged pull requests for the release notes.",
					host: "api.github.com",
					methods: ["GET"],
					pathPrefix: "/repos/harbour-dev/harbour",
					injectionTemplate: "Authorization: token {{secret}}",
					link: "https://vault.harbour.dev/p/prop_R3ad",
					expiresAt: FIXTURE_NOW + 9 * MINUTE + 12_000,
				})}
				now={FIXTURE_NOW}
				requester="Release notes schedule"
			/>
			<VaultApprovalCard
				card={vaultCard({
					proposalId: "prop_L4st",
					bindingCode: "STONE-73",
					what: "A Sentry token to read the last day's errors",
					why: "",
					host: "sentry.io",
					methods: ["GET"],
					pathPrefix: "/api/0/projects/harbour",
					injectionTemplate: "Authorization: Bearer {{secret}}",
					link: "https://vault.harbour.dev/p/prop_L4st",
					expiresAt: FIXTURE_NOW + 95_000,
				})}
				now={FIXTURE_NOW}
			/>
		</Column>
	</Sheet>
);

export const Approved: Story = () => (
	<Sheet
		title="Vault approval card: approved"
		intro="Once approved, the card folds to one quiet row with the binding code. Terms shows what was approved, under one line saying so."
	>
		<Column>
			<VaultApprovalCard
				card={vaultCard({ status: "approved", termsSource: "approved", expiresAt: FIXTURE_NOW + 30 * DAY })}
				now={FIXTURE_NOW}
			/>
		</Column>
	</Sheet>
);

export const ApprovedNarrowed: Story = () => (
	<Sheet
		title="Vault approval card: approved and narrowed"
		intro="The approver narrowed the agent's proposal (any method under / for 30 days) to POST under /graphql for a day. The settled card looks the same as a plain approval; Terms shows the narrowed terms that were approved."
	>
		<Column>
			<Section title="What the agent proposed">
				<VaultApprovalCard
					card={vaultCard({ methods: ["*"], pathPrefix: "/", expiresAt: FIXTURE_NOW + 30 * DAY })}
					now={FIXTURE_NOW}
				/>
			</Section>
			<Section title="What was approved">
				<VaultApprovalCard
					card={vaultCard({
						status: "approved",
						termsSource: "approved",
						methods: ["POST"],
						pathPrefix: "/graphql",
						expiresAt: FIXTURE_NOW + DAY,
					})}
					now={FIXTURE_NOW}
				/>
			</Section>
		</Column>
	</Sheet>
);

export const RouteGrant: Story = () => (
	<Sheet
		title="Vault approval card: route grant"
		intro="A route grant lets the agent's requests through to a host without injecting a secret: no injection template, any method. The vault page always asks for the code on a route grant."
	>
		<Column>
			<VaultApprovalCard card={routeGrant} now={FIXTURE_NOW} />
			<VaultApprovalCard
				card={{ ...routeGrant, status: "approved", termsSource: "approved", expiresAt: FIXTURE_NOW + 7 * DAY }}
				now={FIXTURE_NOW}
			/>
		</Column>
	</Sheet>
);

export const Denied: Story = () => (
	<Sheet title="Vault approval card: denied" intro="A denied request folds to one row, in the error colour.">
		<Column>
			<VaultApprovalCard card={vaultCard({ status: "denied" })} now={FIXTURE_NOW} />
		</Column>
	</Sheet>
);

export const Expired: Story = () => (
	<Sheet
		title="Vault approval card: expired"
		intro="Nobody approved in time. With onAskAgain the card offers a new link; without it, it only says what happened. A pending card whose time runs out shows the same."
	>
		<Column>
			<VaultApprovalCard card={vaultCard({ status: "expired" })} now={FIXTURE_NOW} onAskAgain={() => {}} />
			<VaultApprovalCard card={vaultCard({ status: "expired" })} now={FIXTURE_NOW} />
			<VaultApprovalCard card={vaultCard({ expiresAt: FIXTURE_NOW - 1000 })} now={FIXTURE_NOW} onAskAgain={() => {}} />
		</Column>
	</Sheet>
);

export const Withdrawn: Story = () => (
	<Sheet
		title="Vault approval card: withdrawn"
		intro="The agent withdrew the request, usually because it found another way or the turn was stopped."
	>
		<Column>
			<VaultApprovalCard card={vaultCard({ status: "withdrawn" })} now={FIXTURE_NOW} />
		</Column>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet title="Vault approval card: loading" intro="The pending card's shape while the request loads.">
		<Column>
			<VaultApprovalCardSkeleton />
		</Column>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet
		title="Vault approval card: empty"
		intro="The nearest real empty state: a request with no injection template and no reason given. The card leaves out the why line and says nothing is injected."
	>
		<Column>
			<VaultApprovalCard card={vaultCard({ injectionTemplate: undefined, why: "" })} now={FIXTURE_NOW} />
		</Column>
	</Sheet>
);

const liveCard = () => vaultCard({ expiresAt: Date.now() + 125_000 });

function LiveLifetime() {
	const [card, setCard] = useState(liveCard);
	return (
		<Column>
			<VaultApprovalCard card={card} onAskAgain={() => setCard(liveCard())} />
			<Row>
				<Button size="xs" onClick={() => setCard(liveCard())}>
					Start again
				</Button>
			</Row>
		</Column>
	);
}

export const Streaming: Story = () => (
	<Sheet
		title="Vault approval card: live lifetime"
		intro="On the real clock, starting 2:05 before expiry: after five seconds the Lifetime term turns amber, and at zero the card folds to its expired row. The lifetime is said once, in the terms. The card ticks on the page's shared one-second clock only while pending."
	>
		<LiveLifetime />
	</Sheet>
);

// Named ErrorState so the export doesn't shadow the global Error; the workbench shows it as "Error".
export const ErrorState: Story = () => (
	<Sheet
		title="Vault approval card: error"
		intro="The session couldn't reach the vault to refresh the card. The card and its link stay usable; the notice sits under it."
	>
		<Column>
			<VaultApprovalCard card={vaultCard()} now={FIXTURE_NOW} />
			<Notice level="error">Couldn't reach the vault. The link still works.</Notice>
		</Column>
	</Sheet>
);
ErrorState.storyName = "Error";

const longCard = vaultCard({
	proposalId: "prop_L0ng",
	bindingCode: "WILLOWBROOK-4821-EXTENDED",
	what: "A Stripe restricted key for the billing reconciliation job that runs against every tenant's invoices in the European region",
	why: "To compare last month's Stripe charges with the invoices in the billing database for each of the 214 tenants, flag every charge that has no matching invoice or a different amount, and write the differences to a report the finance team reviews on Monday morning before the close.",
	host: "billing-reconciliation.eu-west-1.internal.payments.lleverage-production-services.example.com",
	methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
	pathPrefix: "/v1/reconciliation/tenants/all/invoices/2026-09/charges/with-refunds-and-disputes/including-archived",
	injectionTemplate:
		"Authorization: Bearer {{secret}}; X-Reconciliation-Scope: tenants=all; X-Request-Origin: harbour-agent-billing-reconciliation",
	link: "https://vault.harbour-self-hosted-for-a-company-with-a-long-domain.example.com/p/prop_L0ng",
});

export const LongContent: Story = () => (
	<Sheet
		title="Vault approval card: long content"
		intro="A very long what, why, host, path, template and binding code. Everything wraps inside the card; nothing overflows."
	>
		<Column>
			<VaultApprovalCard
				card={longCard}
				now={FIXTURE_NOW}
				requester="Billing reconciliation schedule for the EU region"
			/>
			<VaultApprovalCard card={{ ...longCard, status: "approved", termsSource: "approved" }} now={FIXTURE_NOW} />
			<VaultApprovalCard card={{ ...longCard, status: "expired" }} now={FIXTURE_NOW} onAskAgain={() => {}} />
		</Column>
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Vault approval card at 420px" intro="Under the card's width the actions stack and the code wraps.">
		<Column>
			<VaultApprovalCard card={vaultCard()} now={FIXTURE_NOW} />
			<VaultApprovalCard card={vaultCard({ status: "approved", termsSource: "approved" })} now={FIXTURE_NOW} />
			<VaultApprovalCard card={vaultCard({ status: "expired" })} now={FIXTURE_NOW} onAskAgain={() => {}} />
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };

const codes = ["MAPLE-17", "RIVER-48", "CEDAR-93", "STONE-25"];

function PickerDemo() {
	const [picked, setPicked] = useState<string | undefined>(undefined);
	return (
		<Column>
			<Picker codes={codes} value={picked} onPick={setPicked} />
			<Row>
				<Button variant="primary" disabled={picked === undefined}>
					Approve
				</Button>
				<Button>Deny</Button>
			</Row>
		</Column>
	);
}

function WrongPickDemo() {
	const [picked, setPicked] = useState<string | undefined>("MAPLE-17");
	const [error, setError] = useState<string | undefined>(
		"That code doesn't match the card. Check the code in the session and pick again.",
	);
	return (
		<Picker
			codes={codes}
			value={picked}
			onPick={(code) => {
				setPicked(code);
				setError(undefined);
			}}
			error={error}
		/>
	);
}

function PickedDemo() {
	const [picked, setPicked] = useState<string | undefined>("RIVER-48");
	return <Picker codes={codes} value={picked} onPick={setPicked} />;
}

export const BindingCodePicker: Story = () => (
	<Sheet
		title="Binding code picker"
		intro="On the vault page, for writes, route grants and secret pastes: the approver picks the code the card shows before Approve or Paste is enabled. The picker doesn't know the right code; the server checks it. Tab reaches the group, arrow keys move and pick."
	>
		<Section title="Idle, with Approve waiting on a pick">
			<PickerDemo />
		</Section>
		<Section title="Picked">
			<PickedDemo />
		</Section>
		<Section title="Wrong pick">
			<WrongPickDemo />
		</Section>
		<Section title="Disabled, while the approval is sent">
			<Picker codes={codes} value="RIVER-48" onPick={() => {}} disabled />
		</Section>
	</Sheet>
);
