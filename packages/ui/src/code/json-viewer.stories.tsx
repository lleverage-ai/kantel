import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Section, Sheet } from "../workbench/specimen.tsx";
import { JsonViewer } from "./json-viewer.tsx";

export default { title: "Code/JSON viewer" } satisfies StoryDefault;

// A GitHub search's answer, cut to two pull requests (session 3430cd86's), and a list longer than a page.

const search = {
	total_count: 295,
	incomplete_results: false,
	items: [
		{
			html_url: "https://github.com/tvdavies/agent-toolkit/pull/61",
			number: 61,
			title: "initiative-review-deck: fit the glance and projects slides to more than seven projects",
			state: "closed",
			draft: false,
			user: { login: "tvdavies", site_admin: false },
			labels: [],
			created_at: "2026-10-29T20:11:29Z",
			pull_request: { merged_at: "2026-10-29T22:44:20Z" },
		},
		{
			html_url: "https://github.com/tvdavies/agent-toolkit/pull/60",
			number: 60,
			title: "prod-health: recurring slots for a burst at the same local time each weekday (experimental)",
			state: "closed",
			draft: false,
			user: { login: "tvdavies", site_admin: false },
			labels: [],
			created_at: "2026-10-27T11:02:13Z",
			pull_request: { merged_at: null },
		},
	],
};

const repos = Array.from({ length: 140 }, (_, index) => ({
	full_name: `tvdavies/repo-${index + 1}`,
	private: index % 3 === 0,
}));

export const Folded: Story = () => (
	<Sheet
		title="JSON viewer"
		intro="A JSON value as a tree, open at its first level and folded under it. Each fold is a button that says what it holds; strings, numbers, booleans and null in their syntax colours."
	>
		<Column>
			<Section title="A search's answer, as it opens">
				<JsonViewer value={search} label="The response" />
			</Section>
			<Section title="Opened two levels">
				<JsonViewer value={search} openDepth={3} label="The response" />
			</Section>
			<Section title="Scalars and empty values">
				<JsonViewer value={{ text: "tvdavies", count: 0, ok: true, missing: null, list: [], map: {} }} />
			</Section>
		</Column>
	</Sheet>
);

export const LongList: Story = () => (
	<Sheet
		title="JSON viewer: a long list"
		intro="An array or object shows its first hundred entries, then a button for the rest."
	>
		<Column>
			<JsonViewer value={repos} openDepth={1} label="Repositories" />
		</Column>
	</Sheet>
);
LongList.storyName = "Long list";
