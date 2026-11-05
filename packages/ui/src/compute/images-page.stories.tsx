import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { BaseImagesOverview, BaseImagesSource } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";
import { ImagesPage } from "./images-page.tsx";

export default { title: "Compute/Images page" } satisfies StoryDefault;

// Each story keeps its own source; `change` rewrites what the fixtures' overview answers.
function Scenario({
	options,
	change,
	open,
}: {
	options?: ComputeFixtureOptions;
	change?: (overview: BaseImagesOverview) => BaseImagesOverview;
	open?: readonly string[];
}) {
	const [source] = useState((): BaseImagesSource => {
		const images = createComputeFixtures(options).images as BaseImagesSource;
		return change === undefined ? images : { overview: async () => change(await images.overview()) };
	});
	return <ImagesPage source={source} now={FIXTURE_NOW} {...(open === undefined ? {} : { open })} />;
}

/**
 * The four base images: sandbox just rebuilt for a CVE, browser's scan finding a fixable Critical, the rest clean;
 * node-22 rebuilding, python-3.13 pinned behind, browser-agent current.
 */
export const Default: Story = () => <Scenario />;

/** The browser image open: its findings, the worst first, and its recent versions. */
export const Findings: Story = () => <Scenario open={["browser"]} />;

/** While it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The error state: the image index can't be reached, and Kantel says so with nothing to list. */
export const IndexError: Story = () => (
	<Scenario
		change={(overview) => ({
			images: [],
			templates: [],
			indexUrl: overview.indexUrl,
			error: "images.kantel.example.com answered 503",
		})}
	/>
);

/** When Kantel itself can't be reached. */
export const Unreachable: Story = () => <Scenario options={{ fail: true }} />;

/** Base images, and no templates yet. */
export const EmptyTemplates: Story = () => <Scenario change={(overview) => ({ ...overview, templates: [] })} />;

/** On a phone, with the browser image's findings open. */
export const Mobile: Story = () => <Scenario open={["browser"]} />;
Mobile.meta = { width: 420 };
