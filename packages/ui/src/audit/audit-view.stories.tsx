import { createMemoryAuditStore } from "@kantel/audit/memory";
import { systemContext } from "@kantel/contracts";
import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { type AuditFilters, type AuditSource, eventItemId } from "./audit-model.ts";
import { AuditView, type AuditViewProps } from "./audit-view.tsx";
import {
	type AuditScenario,
	choices,
	createAuditScenario,
	directory,
	emptySource,
	FIXTURE_NOW,
	failingSource,
	generateEvents,
	links,
	ORGANISATION,
	pendingSource,
} from "./fixtures.ts";

export default { title: "Audit/Audit view" } satisfies StoryDefault;

/** Story-only frame: the width the console gives the view beside its sidebar. */
const frame = "max-w-[calc(var(--kt-content-width)+var(--kt-sidebar-width))]";

// Each story builds its own in-memory store from the generated fixture, so filters, paging and export run against
// the store's real query and cursors.

function ScenarioView({
	count = 4000,
	options,
	filters,
	extra,
	setup,
}: {
	count?: number;
	options?: Parameters<typeof createAuditScenario>[1];
	filters?: AuditFilters;
	extra?: Partial<AuditViewProps>;
	setup?: (scenario: AuditScenario) => () => void;
}) {
	const [scenario, setScenario] = useState<AuditScenario>();
	useEffect(() => {
		let live = true;
		void createAuditScenario(count, options).then((made) => {
			if (live) setScenario(made);
		});
		return () => {
			live = false;
		};
	}, [count, options]);
	useEffect(() => (scenario === undefined || setup === undefined ? undefined : setup(scenario)), [scenario, setup]);
	return (
		<div className={frame}>
			<AuditView
				source={scenario?.source ?? pendingSource}
				directory={directory}
				links={links}
				choices={choices}
				now={FIXTURE_NOW}
				onExport={(_jsonl, name, total) => console.info(`Exported ${total} events to ${name}`)}
				{...(filters === undefined ? {} : { initialFilters: filters })}
				{...extra}
			/>
		</div>
	);
}

/** The last 24 hours of a few thousand events. */
export const Default: Story = () => <ScenarioView />;

/** The definition of done: which sessions used the Linear key yesterday, and who approved it. */
const linearYesterday: AuditFilters = { range: "yesterday", kind: "credential-use", credential: "itm_linear" };
export const LinearKeyYesterday: Story = () => <ScenarioView filters={linearYesterday} />;

const approvals: AuditFilters = { range: "week", kind: "approval" };
export const Approvals: Story = () => <ScenarioView filters={approvals} />;

const refused: AuditFilters = { range: "month", kind: "access" };
export const RefusedAccess: Story = () => <ScenarioView filters={refused} />;

const oneProject: AuditFilters = { range: "week", kind: "sandbox", projectId: "prj_platform" };
export const SandboxInOneProject: Story = () => <ScenarioView filters={oneProject} />;

const byPerson: AuditFilters = { range: "day", kind: "all", actor: "human:usr_alex" };
export const ByPerson: Story = () => <ScenarioView filters={byPerson} />;

/** One browser session's history, as "This browser's history" on an event opens it: its ID, and the way back. */
const oneBrowser: AuditFilters = { range: "all", kind: "all", browserSession: "brs_7f3a9c2e41d8" };
export const OneBrowser: Story = () => <ScenarioView filters={oneBrowser} />;

/** One long, wide event with every row field, and an expanded detail. */
const longSource: AuditSource = {
	async query() {
		return {
			items: [
				{
					id: "fx:long:1",
					seq: 99_812,
					recordedAt: FIXTURE_NOW - 60_000,
					at: FIXTURE_NOW - 60_000,
					source: "vault",
					type: "vault.use.denied",
					actor: {
						kind: "agent",
						agentId: "agt_etl",
						sessionId: "ses_extremely_long_session_identifier_that_does_not_wrap_nicely_0001",
					},
					organisationId: ORGANISATION,
					projectId: "prj_data",
					agentId: "agt_etl",
					sessionId: "ses_extremely_long_session_identifier_that_does_not_wrap_nicely_0001",
					subject: { kind: "vault.use", id: "use_7f3a" },
					data: {
						method: "POST",
						host: "admin.staging.harbour.dev",
						path: "/jobs/queues/invoice-reconciliation-nightly-eu-west-1/partitions/0000000000000000000017/retry",
						itemId: "itm_staging",
						reason:
							"The path is outside every grant on this credential: the grant covers /jobs and below on GET only, and this request was a POST to a deeper queue path that nobody approved.",
					},
				},
			],
		};
	},
};
export const LongContent: Story = () => (
	<div className={frame}>
		<AuditView source={longSource} directory={directory} links={links} choices={choices} now={FIXTURE_NOW} />
	</div>
);

export const Loading: Story = () => (
	<div className={frame}>
		<AuditView source={pendingSource} directory={directory} links={links} choices={choices} now={FIXTURE_NOW} />
	</div>
);

export const Empty: Story = () => (
	<div className={frame}>
		<AuditView source={emptySource} directory={directory} links={links} choices={choices} now={FIXTURE_NOW} />
	</div>
);

const nothingMatches: AuditFilters = { range: "hour", kind: "identity", credential: "itm_slack" };
export const EmptyFiltered: Story = () => <ScenarioView filters={nothingMatches} />;

/**
 * The Linear key was last used weeks ago, behind 6,000 other events. The store filters by credential, so its first
 * page is the key's own events, however far back they are.
 */
const sparseSource: AuditSource = (() => {
	const store = createMemoryAuditStore({ clock: { now: () => FIXTURE_NOW } });
	const events = generateEvents(8000).sort((a, b) => a.at - b.at);
	const recent = events
		.slice(-6000)
		.filter((event) => eventItemId({ ...event, seq: 0, recordedAt: event.at }) !== "itm_linear");
	const ready = store.append(systemContext("fixture"), [...events.slice(0, -6000), ...recent]);
	const viewer = { actor: { kind: "human", userId: "usr_tom" }, organisationId: ORGANISATION } as const;
	return {
		async query({ organisationId: _organisationId, ...query }, page) {
			await ready;
			return store.query(viewer, query, page);
		},
	};
})();
const linearAllTime: AuditFilters = { range: "all", kind: "all", credential: "itm_linear" };
export const SparseMatches: Story = () => (
	<div className={frame}>
		<AuditView
			source={sparseSource}
			directory={directory}
			links={links}
			choices={choices}
			now={FIXTURE_NOW}
			initialFilters={linearAllTime}
		/>
	</div>
);

// biome-ignore lint/suspicious/noShadowRestrictedNames: every component's error state is the story named Error.
export const Error: Story = () => (
	<div className={frame}>
		<AuditView source={failingSource} directory={directory} links={links} choices={choices} now={FIXTURE_NOW} />
	</div>
);

/** The first page reads; the next one fails, and the foot of the list offers to try again. */
const failSecond = { failAfter: 1 };
export const PageError: Story = () => (
	<ScenarioView options={failSecond} extra={{ initialFilters: { range: "all", kind: "all" } }} />
);

/** A hundred thousand events over 30 days: the list mounts only the rows near the viewport. */
export const Large: Story = () => <ScenarioView count={100_000} filters={{ range: "all", kind: "all" }} />;

/** New events arrive every two seconds; the view counts them above the list rather than moving the rows. */
const addEvents = (scenario: AuditScenario) => {
	let serial = 0;
	const timer = setInterval(() => {
		serial += 1;
		void scenario.store.append(systemContext("fixture"), [
			{
				id: `fx:live:${serial}`,
				at: FIXTURE_NOW - 1000 + serial,
				source: "session",
				type: "session.tool.started",
				actor: { kind: "agent", agentId: "agt_ops", sessionId: "ses_1" },
				organisationId: ORGANISATION,
				projectId: "prj_platform",
				agentId: "agt_ops",
				sessionId: "ses_1",
				subject: { kind: "session.tool", id: `call_live_${serial}` },
				data: { hostId: "host_1", tool: "bash" },
			},
		]);
	}, 2000);
	return () => clearInterval(timer);
};
export const Streaming: Story = () => <ScenarioView setup={addEvents} extra={{ pollMs: 1000 }} />;

export const Mobile: Story = () => <ScenarioView filters={linearYesterday} />;
Mobile.meta = { width: 420 };

export const MobileTimeline: Story = () => <ScenarioView />;
MobileTimeline.meta = { width: 420 };
