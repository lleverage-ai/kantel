import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	createMemoryScenario,
	directory,
	FIXTURE_NOW,
	failingDecisions,
	failingSource,
	type MemoryScenario,
	pendingSource,
	placeholderSpace,
	SAMPLE_QUERY,
} from "./fixtures.ts";
import type { MemoryPageSource } from "./memory-model.ts";
import { MemoryPage, type MemoryView } from "./memory-page.tsx";

export default { title: "Memory/Memory page" } satisfies StoryDefault;

/** Story-only frame: as wide as the console gives the page beside its sidebar. */
const frame = "max-w-[calc(var(--hb-content-width)+var(--hb-sidebar-width)+var(--hb-step-12))]";

// Each story builds the team's space in a fresh in-memory store through its own propose and decide, so concepts,
// versions, history and recall come from the store's real calls. Approving or rejecting in a story writes to that store.

function ScenarioPage({
	view,
	open,
	status,
	search,
	recall,
	empty,
	brokenDecisions,
	readOnly,
	noProposals,
}: {
	view?: MemoryView;
	open?: string;
	status?: "active" | "superseded" | "forgotten";
	search?: string;
	recall?: { query: string; projects?: string; jobs?: string };
	empty?: boolean;
	brokenDecisions?: boolean;
	readOnly?: boolean;
	/** A source with reads only, no proposals, as the console's API source is until memory writes land. */
	noProposals?: boolean;
}) {
	const [scenario, setScenario] = useState<MemoryScenario>();
	useEffect(() => {
		let live = true;
		void createMemoryScenario(empty === true ? { empty } : {}).then((made) => {
			if (live) setScenario(made);
		});
		return () => {
			live = false;
		};
	}, [empty]);
	const made =
		scenario === undefined
			? pendingSource
			: brokenDecisions === true
				? failingDecisions(scenario.source)
				: readOnly === true
					? { ...scenario.source, propose: undefined }
					: scenario.source;
	const source: MemoryPageSource =
		noProposals === true
			? {
					listConcepts: made.listConcepts,
					getConcept: made.getConcept,
					search: made.search,
					recall: made.recall,
				}
			: made;
	return (
		<div className={frame}>
			<MemoryPage
				key={scenario === undefined ? "pending" : "ready"}
				source={source}
				spaces={[scenario?.space ?? placeholderSpace]}
				profile={scenario?.profile ?? []}
				directory={directory}
				now={FIXTURE_NOW}
				{...(view === undefined ? {} : { initialView: view })}
				{...(open === undefined ? {} : { initialSelected: open })}
				{...(status === undefined ? {} : { initialStatus: status })}
				{...(search === undefined ? {} : { initialSearch: search })}
				{...(recall === undefined ? {} : { initialRecall: recall })}
			/>
		</div>
	);
}

/** The team's active concepts by scope: Tom's own everywhere, then each project's, then one job's exception. */
export const Default: Story = () => <ScenarioPage />;

/** A learned concept, corrected once: its sources, its version and the two proposals that made it. */
export const ConceptWithHistory: Story = () => <ScenarioPage open="projects/harbour/vault-binding-codes" />;

/** Read-only: a source without `propose` offers no Correct or Forget, only the record. */
export const ReadOnlyConcept: Story = () => <ScenarioPage open="projects/harbour/vault-binding-codes" readOnly />;

/** Past its date for checking: recall ranks it lower and says it is stale. Correcting it is the check. */
export const StaleConcept: Story = () => <ScenarioPage open="projects/harbour/staging-jobs-retry" />;

/** A job's exception, with the rule it overrides a click away. */
export const JobException: Story = () => <ScenarioPage open="projects/harbour/release-freeze-exception" />;

/** Replaced by a newer rule: recall no longer shows it. */
export const Superseded: Story = () => <ScenarioPage status="superseded" open="projects/harbour/merge-after-review" />;

/** Forgotten, with the reason it was forgotten. */
export const Forgotten: Story = () => <ScenarioPage status="forgotten" open="projects/harbour/sandbox-on-fly" />;

/** Searching the space, best match first, with the snippet that matched. */
export const Search: Story = () => <ScenarioPage search="vault approval" />;

export const SearchNothing: Story = () => <ScenarioPage search="kubernetes" />;

/** Waiting for a person: approve or reject each. One nearly repeats a concept, so approving it would be refused. */
export const Proposals: Story = () => <ScenarioPage view="proposals" />;

/** Reads only, as the console's API source: no Proposals view, no Correct or Forget, and a concept shows no history. */
export const ReadsOnly: Story = () => <ScenarioPage noProposals open="projects/harbour/vault-binding-codes" />;

/** Approving fails: nothing is written and the proposal says so. */
export const DecisionError: Story = () => <ScenarioPage view="proposals" brokenDecisions />;

/**
 * What a Platform session would recall for a message about vault codes: the profile, the matches with their scores and
 * why each came.
 */
export const Recall: Story = () => (
	<ScenarioPage view="recall" recall={{ query: SAMPLE_QUERY, projects: "prj_platform" }} />
);

/** A job with an exception: recalling the merge rule brings the job's override along with it. */
export const RecallWithException: Story = () => (
	<ScenarioPage
		view="recall"
		recall={{ query: "merge the pull request once checks are green", projects: "prj_platform", jobs: "TASK-3700" }}
	/>
);

/** Without the project's scope, its concepts match but are left out, and the page says so. */
export const RecallOutOfScope: Story = () => <ScenarioPage view="recall" recall={{ query: SAMPLE_QUERY }} />;

export const RecallIdle: Story = () => <ScenarioPage view="recall" />;

export const Empty: Story = () => <ScenarioPage empty />;

export const EmptyProposals: Story = () => <ScenarioPage view="proposals" empty />;

export const Loading: Story = () => (
	<div className={frame}>
		<MemoryPage source={pendingSource} spaces={[placeholderSpace]} directory={directory} now={FIXTURE_NOW} />
	</div>
);

export const LoadError: Story = () => (
	<div className={frame}>
		<MemoryPage source={failingSource} spaces={[placeholderSpace]} directory={directory} now={FIXTURE_NOW} />
	</div>
);

/** On a phone the open concept replaces the list, with a way back. */
export const Mobile: Story = () => <ScenarioPage open="projects/harbour/vault-binding-codes" />;
Mobile.meta = { width: 420 };

export const MobileList: Story = () => <ScenarioPage />;
MobileList.meta = { width: 420 };

export const MobileProposals: Story = () => <ScenarioPage view="proposals" />;
MobileProposals.meta = { width: 420 };
