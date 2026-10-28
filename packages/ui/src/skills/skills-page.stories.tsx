import type { SkillVisibility } from "@harbour/contracts";
import { useEffect, useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import {
	BILLING_VISIBILITY,
	createSkillsScenario,
	directory,
	FIXTURE_NOW,
	failingFiles,
	failingPublish,
	failingSource,
	ownerChoices,
	pendingSource,
	projectChoices,
	type SkillsScenario,
} from "./fixtures.ts";
import { SkillsPage } from "./skills-page.tsx";
import "./stories.css";

export default { title: "Skills/Skills page" } satisfies StoryDefault;

// Each story publishes the fixture's skills into a fresh in-memory store, so the listing, the revisions and the files
// come from the store's real calls.

function ScenarioPage({
	open,
	visibility = BILLING_VISIBILITY,
	empty,
	brokenFiles,
	readOnly,
	creating,
	brokenPublish,
}: {
	open?: string;
	visibility?: SkillVisibility;
	empty?: boolean;
	brokenFiles?: boolean;
	readOnly?: boolean;
	creating?: boolean;
	brokenPublish?: boolean;
}) {
	const [scenario, setScenario] = useState<SkillsScenario>();
	useEffect(() => {
		let live = true;
		void createSkillsScenario(empty === true ? { empty } : {}).then((made) => {
			if (live) setScenario(made);
		});
		return () => {
			live = false;
		};
	}, [empty]);
	const source =
		scenario === undefined ? pendingSource : brokenFiles === true ? failingFiles(scenario.source) : scenario.source;
	const selected = open === undefined ? undefined : scenario?.ids[open];
	const author =
		scenario === undefined || readOnly === true
			? undefined
			: brokenPublish === true
				? failingPublish(scenario.author)
				: scenario.author;
	return (
		<div className="skills-story">
			<SkillsPage
				key={scenario === undefined ? "pending" : "ready"}
				source={source}
				visibility={visibility}
				projects={projectChoices}
				directory={directory}
				now={FIXTURE_NOW}
				{...(selected === undefined ? {} : { initialSelected: selected })}
				{...(author === undefined ? {} : { author, owners: ownerChoices })}
				initialCreating={creating === true}
			/>
		</div>
	);
}

/** What a session in Billing, opened by Tom, sees: his own, Billing's, the organisation's and the built-in skills. */
export const Default: Story = () => <ScenarioPage />;

/** A skill imported from Sal's skills repo, three revisions, its SKILL.md rendered with the frontmatter as fields. */
export const ImportedSkill: Story = () => <ScenarioPage open="pr-review" />;

/** A Billing skill whose latest revision carries Lleverage's host data. */
export const ProjectSkill: Story = () => <ScenarioPage open="stripe-reconcile" />;

/** Tom's own skill, with a newer draft open that sessions don't see yet. */
export const DraftOpen: Story = () => <ScenarioPage open="morning-brief" />;

/** Seen from Platform, whose own pr-review replaces the organisation's. */
export const SeenFromPlatform: Story = () => (
	<ScenarioPage visibility={{ projectId: "prj_platform", userId: "usr_tom" }} open="pr-review-platform" />
);

/** Without the authoring calls (an agent's view, or a host that only reads), the page has no New skill or Edit. */
export const ReadOnly: Story = () => <ScenarioPage open="pr-review" readOnly />;

/**
 * Writing a new skill. Publish it and it opens, with what sessions will get; a Billing session started after that
 * pins it.
 */
export const NewSkill: Story = () => <ScenarioPage creating />;

/** Publishing fails after the draft saved: the draft is kept and the person can try again. */
export const PublishError: Story = () => <ScenarioPage creating brokenPublish />;

export const NewSkillMobile: Story = () => <ScenarioPage creating />;
NewSkillMobile.meta = { width: 420 };

export const Loading: Story = () => (
	<div className="skills-story">
		<SkillsPage source={pendingSource} visibility={BILLING_VISIBILITY} directory={directory} now={FIXTURE_NOW} />
	</div>
);

export const Empty: Story = () => <ScenarioPage empty />;

export const LoadError: Story = () => (
	<div className="skills-story">
		<SkillsPage source={failingSource} visibility={BILLING_VISIBILITY} directory={directory} now={FIXTURE_NOW} />
	</div>
);

/** The skill reads, but its file doesn't. */
export const FileError: Story = () => <ScenarioPage open="pr-review" brokenFiles />;

/** On a phone the open skill replaces the list, with a way back. */
export const Mobile: Story = () => <ScenarioPage open="pr-review" />;
Mobile.meta = { width: 420 };

export const MobileList: Story = () => <ScenarioPage />;
MobileList.meta = { width: 420 };
