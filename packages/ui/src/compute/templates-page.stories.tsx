import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW, LLEVERAGE } from "./fixtures.ts";
import { SandboxesPage } from "./sandboxes-page.tsx";
import { TemplatePage, TemplatesPage } from "./templates-page.tsx";

export default { title: "Compute/Templates page" } satisfies StoryDefault;

// Templates are experimental: a deployment shows them only with KANTEL_TEMPLATES=experimental. Each story keeps its own
// source, so making, editing and rebuilding a template change it, and its build finishes a few seconds later.
function useSource(options?: ComputeFixtureOptions) {
	const [source] = useState(() => createComputeFixtures({ templates: true, ...options }));
	const templates = source.templates;
	if (templates === undefined) throw new Error("The fixtures have no templates.");
	return { source, templates };
}

function List({ options, creating }: { options?: ComputeFixtureOptions; creating?: boolean }) {
	const { templates } = useSource(options);
	return (
		<TemplatesPage
			source={templates}
			account={LLEVERAGE}
			templateHref={(id) => `#${id}`}
			now={FIXTURE_NOW}
			{...(creating === undefined ? {} : { creating })}
		/>
	);
}

function One({ templateId, editing }: { templateId: string; editing?: boolean }) {
	const { templates } = useSource();
	return (
		<TemplatePage
			source={templates}
			templateId={templateId}
			accountId={LLEVERAGE.id}
			listHref="#templates"
			newSandboxHref={(id) => `#new-sandbox/${id}`}
			now={FIXTURE_NOW}
			{...(editing === undefined ? {} : { editing })}
		/>
	);
}

/** An organisation's templates: one ready, one building v2 over v1's stale snapshot, one pinned and behind, one failed. */
export const Default: Story = () => <List />;

/** No templates yet. */
export const Empty: Story = () => <List options={{ empty: true }} />;

/** New template: Kantel's base following its stable channel, or a digest pinned from a published channel. */
export const Creating: Story = () => <List creating />;

/** The list while it loads. */
export const Loading: Story = () => <List options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <List options={{ fail: true }} />;

/** python-data: ready, its snapshot built two hours ago from the stable base; its definition, cache and versions. */
export const Ready: Story = () => <One templateId="tpl_python" />;

/**
 * node-web: v2 builds in the background; v1's snapshot stays in the cache, stale, but only v2's restores, so new
 * sandboxes boot the image fresh until it's ready.
 */
export const Building: Story = () => <One templateId="tpl_node" />;

/** media-tools: a pinned base three releases behind its channel. */
export const PinnedBehind: Story = () => <One templateId="tpl_media" />;

/** rust-ci: its setup failed, so new sandboxes boot the image fresh; the end of the script's output. */
export const BuildFailed: Story = () => <One templateId="tpl_rust" />;

/** Edit python-data: saving makes v4. */
export const Editing: Story = () => <One templateId="tpl_python" editing />;

/** New sandbox with the template picker: python-data picked, its size and how it will start. */
export const NewSandboxPicker: Story = () => {
	const { source, templates } = useSource();
	return (
		<SandboxesPage
			source={source.sandboxes}
			snapshots={source.snapshots}
			account={LLEVERAGE}
			hosting="self-hosted"
			now={FIXTURE_NOW}
			environments={(accountId) => source.environments.list(accountId)}
			templates={(accountId) => templates.list(accountId)}
			template="tpl_python"
			creating
		/>
	);
};
