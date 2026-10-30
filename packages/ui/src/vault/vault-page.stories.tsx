import type { AuditEvent, Decision, DecisionInput } from "@harbour/contracts";
import { useCallback, useEffect, useState } from "react";
import { DAY } from "../primitives/format.ts";
import { Field, FieldList } from "../primitives/surface.tsx";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	createVaultScenario,
	FIXTURE_NOW,
	type FixtureState,
	people,
	type ScenarioOptions,
	VAULT_HOST,
	type VaultScenario,
} from "./fixtures.ts";
import type { GrantSummary } from "./load.ts";
import type { PasskeyCheck } from "./passkey.ts";
import { VaultPage, type VaultPageProps } from "./vault-page.tsx";
import { decisionRefusal, type VaultRequest, type Viewer } from "./vault-page-model.ts";

export default { title: "Vault/Vault page" } satisfies StoryDefault;

/** The page at the console's width, with the audit log under it in some stories. */
const frame =
	"flex max-w-[calc(var(--hb-content-width)_+_var(--hb-sidebar-width)_+_var(--hb-step-12)_*_2)] flex-col gap-8";

/** The workbench's passkey: a short pause, as a real prompt would take, then confirmed (or cancelled). */
const fakePasskey =
	(outcome: "confirmed" | "cancelled" = "confirmed"): PasskeyCheck =>
	() =>
		new Promise((resolve) => setTimeout(() => resolve(outcome), 600));

type Setup = (scenario: VaultScenario) => Promise<{
	proposalId: string;
	initial?: VaultPageProps["initial"];
	below?: (scenario: VaultScenario) => Promise<AuditEvent[]>;
}>;

/**
 * The page over a fresh in-memory vault: decisions, stops and refusals go through the vault, and the page reloads
 * after each, as a host would.
 */
function ScenarioPage({
	state,
	setup,
	viewer = people.tom,
	passkey = fakePasskey(),
	options,
}: {
	state?: FixtureState;
	setup?: Setup;
	viewer?: Viewer;
	/** `null`: a host with no passkeys yet, which approves on its sign-in alone. */
	passkey?: PasskeyCheck | null;
	options?: ScenarioOptions;
}) {
	const [scenario, setScenario] = useState<VaultScenario>();
	const [proposalId, setProposalId] = useState<string>();
	const [initial, setInitial] = useState<VaultPageProps["initial"]>();
	const [request, setRequest] = useState<VaultRequest>();
	const [grants, setGrants] = useState<GrantSummary[]>([]);
	const [error, setError] = useState<VaultPageProps["error"]>();
	const [audit, setAudit] = useState<AuditEvent[]>();
	const [below, setBelow] = useState<(scenario: VaultScenario) => Promise<AuditEvent[]>>();

	const reload = useCallback(
		async (target: VaultScenario, id: string) => {
			try {
				setRequest(await target.load(id, viewer));
			} catch (caught) {
				setError(
					decisionRefusal(caught).kind === "role"
						? { kind: "forbidden" }
						: { kind: "other", message: "Couldn't load the request." },
				);
			}
			setGrants(await target.grants(viewer).catch(() => []));
		},
		[viewer],
	);

	useEffect(() => {
		let live = true;
		void (async () => {
			const created = await createVaultScenario(options);
			const chosen =
				setup === undefined ? { proposalId: created.proposals[state ?? "proposed"] } : await setup(created);
			if (!live) return;
			setScenario(created);
			setProposalId(chosen.proposalId);
			setInitial(chosen.initial);
			if (chosen.below !== undefined) {
				const loadBelow = chosen.below;
				setBelow(() => loadBelow);
				setAudit(await loadBelow(created));
			}
			await reload(created, chosen.proposalId);
		})();
		return () => {
			live = false;
		};
	}, [state, setup, options, reload]);

	const ctx = scenario?.ctxFor(viewer);
	const onDecide = useCallback(
		async (input: DecisionInput): Promise<Decision> => {
			if (scenario === undefined || ctx === undefined) throw new globalThis.Error("Not loaded");
			try {
				const decision = await scenario.vault.decide(ctx, input);
				scenario.decisions.set(decision.id, decision);
				return decision;
			} finally {
				if (below !== undefined) setAudit(await below(scenario));
			}
		},
		[scenario, ctx, below],
	);
	const refresh = useCallback(() => {
		if (scenario !== undefined && proposalId !== undefined) void reload(scenario, proposalId);
	}, [scenario, proposalId, reload]);
	const onStop = useCallback(
		async (grantId: string) => {
			if (scenario === undefined || ctx === undefined) return;
			await scenario.vault.revokeGrant(ctx, grantId, "Stopped on the vault page");
			refresh();
		},
		[scenario, ctx, refresh],
	);

	return (
		<div className={frame}>
			<VaultPage
				viewer={viewer}
				vaultHost={VAULT_HOST}
				loading={request === undefined}
				{...(request === undefined ? {} : { request })}
				{...(error === undefined ? {} : { error })}
				{...(options?.live === true ? {} : { now: FIXTURE_NOW })}
				{...(initial === undefined ? {} : { initial })}
				onDecide={onDecide}
				onDecided={refresh}
				{...(passkey === null ? {} : { passkey })}
				grants={{
					grants,
					onStop,
					loading: scenario === undefined,
					...(request === undefined ? {} : { currentProposalId: request.proposal.id }),
				}}
			/>
			{audit === undefined ? null : <AuditRows events={audit} />}
		</div>
	);
}

/** The binding-code refusals the vault audited, under the page, so the story shows the record a wrong pick leaves. */
function AuditRows({ events }: { events: AuditEvent[] }) {
	return (
		// border-0 first: border-dashed styles every side, and with preflight off the others would show at the browser's
		// medium width.
		<section
			className="flex flex-col gap-2.5 border-0 border-t border-dashed border-border-strong pt-4"
			aria-label="Audit log"
		>
			<h2 className="m-0 text-xs font-medium text-muted">Audit log: binding code refusals ({events.length})</h2>
			{events.map((event) => (
				<FieldList key={event.id}>
					<Field label="Type">
						<code className="hb-mono">{event.type}</code>
					</Field>
					<Field label="Who">{event.actor.kind === "human" ? event.actor.userId : event.actor.kind}</Field>
					<Field label="Picked">
						<code className="hb-mono">{String(event.data?.pickedCode ?? "")}</code>
					</Field>
				</FieldList>
			))}
		</section>
	);
}

export const Default: Story = () => <ScenarioPage state="proposed" />;

export const Proposed: Story = () => <ScenarioPage state="proposed" />;

const pendingSetup: Setup = async (scenario) => {
	const proposalId = scenario.proposals.pending;
	const request = await scenario.load(proposalId);
	return {
		proposalId,
		initial: { draft: { methods: ["POST"], ttlMs: DAY }, pickedCode: request.proposal.bindingCode },
	};
};
export const Pending: Story = () => <ScenarioPage setup={pendingSetup} />;

export const Read: Story = () => <ScenarioPage state="read" />;

export const RouteGrant: Story = () => <ScenarioPage state="route" />;

export const SecretPaste: Story = () => <ScenarioPage state="secret" />;

export const Approved: Story = () => <ScenarioPage state="approved" />;

export const ApprovedNarrowed: Story = () => <ScenarioPage state="narrowed" />;

export const Denied: Story = () => <ScenarioPage state="denied" />;

export const Expired: Story = () => <ScenarioPage state="expired" />;

export const Revoked: Story = () => <ScenarioPage state="revoked" />;

export const Withdrawn: Story = () => <ScenarioPage state="withdrawn" />;

const mismatches = async (scenario: VaultScenario) =>
	(await scenario.audit.query(scenario.ctxFor(people.tom), { type: "vault.binding_code.mismatch" })).items.slice();

/** A wrong pick already sent through the vault: the refusal on the picker, and the audit row it left. */
const wrongCodeSetup: Setup = async (scenario) => {
	const proposalId = scenario.proposals.proposed;
	const request = await scenario.load(proposalId);
	const wrong = request.codeChoices?.find((code) => code !== request.proposal.bindingCode);
	let refusal: ReturnType<typeof decisionRefusal> | undefined;
	try {
		await scenario.vault.decide(scenario.ctxFor(people.tom), {
			proposalId,
			outcome: "approve",
			termsHash: request.proposal.termsHash,
			...(wrong === undefined ? {} : { pickedCode: wrong }),
		});
	} catch (error) {
		refusal = decisionRefusal(error);
	}
	return { proposalId, initial: refusal === undefined ? {} : { refusal }, below: mismatches };
};
export const WrongCode: Story = () => <ScenarioPage setup={wrongCodeSetup} />;

/** Approve with any pick: a wrong one is refused by the vault and shows up in the audit rows below. */
const tryItSetup: Setup = async (scenario) => ({ proposalId: scenario.proposals.route, below: mismatches });
export const TryTheCode: Story = () => <ScenarioPage setup={tryItSetup} />;

export const PasskeyCancelled: Story = () => <ScenarioPage state="read" passkey={fakePasskey("cancelled")} />;

/** A host with no passkeys yet, such as the Cloudflare deployment today: Approve rests on the Access sign-in. */
export const NoPasskey: Story = () => <ScenarioPage state="route" passkey={null} />;

export const ForwardedLink: Story = () => <ScenarioPage state="proposed" viewer={people.alex} />;

export const ForwardedWithoutRole: Story = () => <ScenarioPage state="proposed" viewer={people.dean} />;

export const NoAccess: Story = () => <ScenarioPage state="proposed" viewer={people.bethan} />;

/** A request for Tom's own (personal) item, which only Tom decides. */
export const PersonalItem: Story = () => <ScenarioPage state="personal" />;

/** The same request on a project operator's screen: read-only, as it isn't their credential. */
export const PersonalItemForwarded: Story = () => <ScenarioPage state="personal" viewer={people.alex} />;

const noop = async () => {
	throw new globalThis.Error("The workbench has no vault here");
};

export const Loading: Story = () => (
	<div className={frame}>
		<VaultPage
			viewer={people.tom}
			vaultHost={VAULT_HOST}
			loading
			now={FIXTURE_NOW}
			onDecide={noop}
			passkey={fakePasskey()}
			grants={{ grants: [], onStop: noop, loading: true }}
		/>
	</div>
);

export const Empty: Story = () => (
	<div className={frame}>
		<VaultPage
			viewer={people.tom}
			vaultHost={VAULT_HOST}
			now={FIXTURE_NOW}
			onDecide={noop}
			passkey={fakePasskey()}
			grants={{ grants: [], onStop: noop }}
		/>
	</div>
);

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => (
	<div className={frame}>
		<VaultPage
			viewer={people.tom}
			vaultHost={VAULT_HOST}
			now={FIXTURE_NOW}
			error={{ kind: "other", message: "Couldn't reach the vault. The request is still waiting; nothing has changed." }}
			onRetry={() => {}}
			onDecide={noop}
			passkey={fakePasskey()}
			grants={{ grants: [], onStop: noop, error: "Couldn't load your active grants." }}
		/>
	</div>
);

const longSetup: Setup = async (scenario) => {
	scenario.clock.set(FIXTURE_NOW - 30_000);
	const proposal = await scenario.propose("ses_ops", {
		itemId: (await scenario.load(scenario.proposals.route)).proposal.terms.itemId!,
		route: {
			host: "admin.staging.harbour.dev",
			methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
			pathPrefix: "/jobs/queues/invoice-reconciliation-nightly-eu-west-1/partitions/0000000000000000000017/retry",
		},
		lifetime: { ttlMs: 30 * DAY },
		reason:
			"To work through the reconciliation queue that backed up after last night's deploy: list every stuck partition, retry each one that failed with a timeout, and mark the ones that failed twice so a person can look at them in the morning. The queue had 4,312 jobs at 06:00 and grows by about 200 an hour while it's stuck.",
	});
	scenario.clock.set(FIXTURE_NOW);
	return { proposalId: proposal.id };
};
export const LongContent: Story = () => <ScenarioPage setup={longSetup} />;

export const Mobile: Story = () => <ScenarioPage setup={pendingSetup} />;
Mobile.meta = { width: 420 };

export const MobileSettled: Story = () => <ScenarioPage state="narrowed" />;
MobileSettled.meta = { width: 420 };

const liveOptions: ScenarioOptions = { base: Date.now() - 12 * 60_000 - 55_000, live: true };
const liveSetup: Setup = async (scenario) => ({ proposalId: scenario.proposals.proposed });
/** The real clock: the countdown ticks, turns amber under two minutes, and the page settles as expired at zero. */
export const Streaming: Story = () => <ScenarioPage setup={liveSetup} options={liveOptions} />;
