import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { createSharingScenario, directory, FIXTURE_NOW, PROJECTS } from "./fixtures.ts";
import type { SharingSource } from "./sharing-model.ts";
import { SharingPage } from "./sharing-page.tsx";

export default { title: "Sharing/Sharing page" } satisfies StoryDefault;

// Each story keeps its own source in the page, so granting, rejecting, revoking and withdrawing change what it lists.

function ScenarioPage({ projectId }: { projectId?: string }) {
	const [source] = useState(createSharingScenario);
	return (
		<SharingPage
			source={source}
			projects={PROJECTS}
			directory={directory}
			now={FIXTURE_NOW}
			{...(projectId === undefined ? {} : { initialProjectId: projectId })}
		/>
	);
}

/** The Support project: a request waiting on the viewer, two shares out and a workspace shared in. */
export const Support: Story = () => <ScenarioPage />;

/** The Billing project, which asked for edit on Support's skill. */
export const Billing: Story = () => <ScenarioPage projectId="proj_billing" />;

/** A source with nothing in it: no shares either way and no requests. Its writes have nothing to act on. */
const nothing: SharingSource = {
	listShares: async () => ({ items: [] }),
	listRequests: async () => ({ items: [] }),
	revokeShare: () => Promise.reject(new Error("No such share")),
	decideRequest: () => Promise.reject(new Error("No such request")),
	withdrawRequest: () => Promise.reject(new Error("No such request")),
};

/** A project with nothing shared and nothing asked: one empty state for the page, not four empty cards. */
export const NothingShared: Story = () => (
	<SharingPage source={nothing} projects={PROJECTS} directory={directory} now={FIXTURE_NOW} />
);
NothingShared.storyName = "Nothing shared";

/** Nobody to show sharing for yet. */
export const NoProject: Story = () => (
	<SharingPage source={createSharingScenario()} projects={[]} directory={directory} now={FIXTURE_NOW} />
);
