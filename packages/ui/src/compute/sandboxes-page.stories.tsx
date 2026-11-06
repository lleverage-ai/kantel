import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { DEFAULT_SANDBOX_SHAPES, type HostingMode, type SandboxShapes } from "./compute-model.ts";
import {
	type ComputeFixtureOptions,
	createComputeFixtures,
	FIXTURE_NOW,
	LLEVERAGE,
	PERSONAL,
	VIEWER,
} from "./fixtures.ts";
import type { SandboxFilters } from "./sandbox-filters.ts";
import { SandboxesPage } from "./sandboxes-page.tsx";

export default { title: "Compute/Sandboxes page" } satisfies StoryDefault;

// Each story keeps its own source, so New, Stop, Resume, Fork and Delete move its sandboxes through their states.
function Scenario({
	hosting = "self-hosted",
	options,
	personal = false,
	creating = false,
	narrow = false,
	noHosts = false,
	usage = "live",
	filters,
	metricsOf,
	shapes,
	olderGuest = false,
}: {
	/** Its sandboxes' guest agents are from before processes could be listed: the source answers none. */
	olderGuest?: boolean;
	filters?: SandboxFilters;
	metricsOf?: string;
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	personal?: boolean;
	creating?: boolean;
	narrow?: boolean;
	noHosts?: boolean;
	/** `live`: the sample's made-up CPU every 5 seconds. `loading`: it never answers. `none`: no live source. */
	usage?: "live" | "loading" | "none";
	/** What New sandbox's hosts offer, in place of the sample's. */
	shapes?: SandboxShapes;
}) {
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }));
	const [sandboxes] = useState(() => {
		const shaped =
			shapes === undefined ? source.sandboxes : { ...source.sandboxes, shapes: () => Promise.resolve(shapes) };
		const offered = olderGuest ? { ...shaped, processes: () => Promise.resolve(undefined) } : shaped;
		if (usage === "live") return offered;
		const { usageSeries: _, ...rest } = offered;
		const hang = () => new Promise<never>(() => {});
		return usage === "none" ? rest : { ...rest, usageSeries: hang, usageHistory: hang, processes: hang };
	});
	return (
		<SandboxesPage
			source={sandboxes}
			snapshots={source.snapshots}
			account={personal ? PERSONAL : LLEVERAGE}
			viewerId={VIEWER.id}
			hosting={hosting}
			now={FIXTURE_NOW}
			sandboxHref={(id, view) => `#sandbox/${id}${view === undefined || view === "overview" ? "" : `/${view}`}`}
			creating={creating}
			narrow={narrow}
			{...(filters === undefined ? {} : { initialFilters: filters })}
			{...(metricsOf === undefined ? {} : { metricsOf })}
			{...(noHosts ? { addHostHref: "#add-host" } : {})}
		/>
	);
}

/**
 * An organisation's sandboxes on a self-hosted Kantel: every state, both types, no cost column. Each row's Usage is
 * its CPU, RAM, disk and IO over the last 10 minutes; click one for its metrics. Hover a name for its pencil (rename),
 * an ID for its copy button, and a column's ? for what it means. Press New.
 */
export const SelfHosted: Story = () => <Scenario />;

/** Each running sandbox's usage while its first readings load. */
export const UsageLoading: Story = () => <Scenario usage="loading" />;

/** Where the source has no live usage: each running sandbox's recent CPU as listed, which doesn't move. */
export const NoLiveUsage: Story = () => <Scenario usage="none" />;

/** Searched and filtered: running microVMs with "dev" in their name, address or ID, and Clear filters. */
export const Filtered: Story = () => (
	<Scenario filters={{ state: "running", snapshot: "all", type: "microvm", search: "dev" }} />
);

/** Only the viewer's own: Created by You, the others' left out. Each row says who made it under when. */
export const CreatedByYou: Story = () => (
	<Scenario filters={{ state: "all", snapshot: "all", type: "all", creator: VIEWER.id, search: "" }} />
);

/** Filters that leave nothing: says so, and offers to clear them. */
export const NoMatch: Story = () => <Scenario filters={{ state: "error", snapshot: "day", type: "all", search: "" }} />;

/**
 * api-server's metrics: CPU, RAM, disk and IO now, the four over the last hour (24h and 1w in the heading), a legend
 * that hides a line, a reading under the pointer, and its busiest processes, each read again every few seconds.
 */
export const Metrics: Story = () => <Scenario metricsOf="sbx_7f3k2m9qa1" />;

/** A desktop sandbox's metrics: Chrome and the stream at the top of its processes. */
export const MetricsDesktop: Story = () => <Scenario metricsOf="sbx_4d8n1x7pe2" />;

/**
 * On an older host that measures CPU and memory alone: Disk and IO say they aren't measured, the legend greys them,
 * the chart has the hour it keeps live, and it can't list processes.
 */
export const MetricsOlderHost: Story = () => (
	<Scenario options={{ metrics: "cpu-memory" }} metricsOf="sbx_7f3k2m9qa1" />
);

/** On a current host, but the sandbox's guest agent is from before processes could be listed: it says so. */
export const MetricsOlderGuest: Story = () => <Scenario olderGuest metricsOf="sbx_7f3k2m9qa1" />;

/** An isolate's metrics: CPU and memory; disk, IO and its processes aren't measured for an isolate. */
export const MetricsIsolate: Story = () => <Scenario metricsOf="sbx_9a2b6c4dq3" />;

/** A stopped sandbox's metrics: its history up to when it stopped, and no processes. */
export const MetricsStopped: Story = () => <Scenario metricsOf="sbx_2q8w5e1rz4" />;

/** The metrics while they load. */
export const MetricsLoading: Story = () => <Scenario usage="loading" metricsOf="sbx_7f3k2m9qa1" />;

/** The metrics dialog on a phone. */
export const MetricsMobile: Story = () => <Scenario narrow metricsOf="sbx_7f3k2m9qa1" />;
MetricsMobile.meta = { width: 390 };

/** The same on hosted Kantel, with each sandbox's cost this period. */
export const Hosted: Story = () => <Scenario hosting="hosted" />;

/** A personal account's own sandboxes. */
export const Personal: Story = () => <Scenario personal />;

/**
 * Sandboxes on an outdated base image: api-server's has security fixes waiting (red), render-farm's doesn't (amber).
 * Each badge's tooltip has the versions; ⋯ has Restart on latest base.
 */
export const BaseOutdated: Story = () => <Scenario />;

/**
 * New's caret: New sandbox, open, with its vCPU, memory and disk sliders. Choose Isolate for its memory slider. Pick a
 * saved snapshot in Start from: the disk slider goes, as a sandbox made from a snapshot keeps its disk.
 */
export const Create: Story = () => <Scenario creating />;

/** New sandbox on hosted Kantel: the price follows the vCPUs and memory chosen; the disk isn't priced. */
export const CreateHosted: Story = () => <Scenario hosting="hosted" creating />;

// Older hosts: none takes a disk off its presets.
const { diskGb: _disk, ...noDisk } = DEFAULT_SANDBOX_SHAPES.microvm;

/** New sandbox where the hosts make any vCPUs and memory but no disk off their presets: no disk slider. */
export const CreateNoDisk: Story = () => <Scenario creating shapes={{ ...DEFAULT_SANDBOX_SHAPES, microvm: noDisk }} />;

/** New sandbox where the hosts make only their named sizes: a Size list, each size with its own disk. */
export const CreatePresetsOnly: Story = () => (
	<Scenario creating shapes={{ ...DEFAULT_SANDBOX_SHAPES, microvm: { ...noDisk, custom: false } }} />
);

/** New sandbox on a phone. */
export const CreateMobile: Story = () => <Scenario creating narrow />;
CreateMobile.meta = { width: 390 };

/** No sandboxes yet. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;

/** No host anywhere yet: no New, and the way to add one. */
export const NoHosts: Story = () => <Scenario options={{ empty: true }} noHosts />;

/** The list while it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** The list when Kantel can't be reached. */
export const Failed: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: a row for each, its CPU beside its state. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };
