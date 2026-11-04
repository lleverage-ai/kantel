import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import type { HostingMode } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";
import { SandboxPage, type SandboxView } from "./sandbox-page.tsx";
import type { FilesAt } from "./snapshot-files.tsx";

export default { title: "Compute/Sandbox page" } satisfies StoryDefault;

// Each story keeps its own source and view, so the tabs, Stop, Resume and the menu all work against the fixtures.
function Scenario({
	sandboxId = "sbx_7f3k2m9qa1",
	view = "overview",
	hosting = "self-hosted",
	options,
	narrow = false,
	menuOpen = false,
	local,
	e2e,
	filesAt,
	unavailable,
	usage = "live",
}: {
	sandboxId?: string;
	/** Where the Files tab opens, as the address would say. */
	filesAt?: FilesAt;
	view?: SandboxView;
	hosting?: HostingMode;
	options?: ComputeFixtureOptions;
	narrow?: boolean;
	menuOpen?: boolean;
	/** Served by `kantel console`: screens in tabs of their own. */
	local?: boolean;
	/** An end-to-end account; "pending" while the console is still checking its chain, which never answers here. */
	e2e?: boolean | "pending";
	/** Why Desktop and Browser can't open, as the console says it. */
	unavailable?: string;
	/** `live`: the sample's made-up usage every 5 seconds. `loading`: it never answers. `none`: no live source. */
	usage?: "live" | "loading" | "none";
}) {
	const [source] = useState(() => {
		const made = createComputeFixtures({ hosting, ...options });
		if (usage === "live") return made;
		const { usageSeries: _, ...rest } = made.sandboxes;
		return {
			...made,
			sandboxes: usage === "none" ? rest : { ...rest, usageSeries: () => new Promise<never>(() => {}) },
		};
	});
	const [sandboxes] = useState(() => {
		if (local !== true && e2e === undefined && unavailable === undefined) return source.sandboxes;
		return {
			...source.sandboxes,
			...(unavailable === undefined
				? {}
				: {
						access: async (id: string) => ({
							...(await source.sandboxes.access(id)),
							unavailable: { desktop: unavailable, browser: unavailable },
						}),
					}),
			...(local === true ? { screens: "tab" as const } : {}),
			endToEnd: () => (e2e === "pending" ? new Promise<boolean>(() => {}) : Promise.resolve(e2e === true)),
			// The host keeps no output end to end yet.
			history: async (id: string) => {
				const commands = await source.sandboxes.history(id);
				return e2e === true ? commands.map(({ output: _, ...command }) => command) : commands;
			},
		};
	});
	return (
		<SandboxPage
			source={sandboxes}
			snapshots={source.snapshots}
			egress={source.egress}
			hosting={hosting}
			sandboxId={sandboxId}
			initialView={view}
			href={(to) => `#${sandboxId}/${to}`}
			sandboxesHref="#sandboxes"
			environmentHref={(id) => `#environments/${id}`}
			now={FIXTURE_NOW}
			narrow={narrow}
			menuOpen={menuOpen}
			{...(filesAt === undefined ? {} : { filesAt })}
		/>
	);
}

/**
 * A running microVM: previews of its desktop and browser, SSH, ports, live CPU and memory, details and its read-only
 * mounts.
 */
export const Overview: Story = () => <Scenario />;

/** Its CPU and memory while their first readings load. */
export const UsageLoading: Story = () => <Scenario usage="loading" />;

/** Where the source has no live usage: its recent CPU as listed, and memory as a meter. */
export const NoLiveUsage: Story = () => <Scenario usage="none" />;

/** The same, for its mounts: a bundle and a bucket in place, and a bundle its host couldn't mount, with why. */
export const Mounts: Story = () => <Scenario />;

/** Another's mounts while one is still pending. */
export const MountsPending: Story = () => <Scenario sandboxId="sbx_4d8n1x7pe2" />;

/** Where the deployment hasn't turned mounts on: no Mounts at all. */
export const MountsOff: Story = () => <Scenario options={{ noMounts: true }} />;

/** Served by `kantel console`, which can't frame them: Browser, Desktop and the previews open each in a tab. */
export const LocalConsole: Story = () => <Scenario local />;

/** An end-to-end sandbox in `kantel console`: a failed command's output isn't shown yet, and says so. */
export const LocalEndToEndLogs: Story = () => <Scenario local e2e view="logs" />;

/** An end-to-end sandbox's Files in `kantel console`: one line, until the console reads them through the host. */
export const LocalEndToEndFiles: Story = () => <Scenario local e2e view="files" />;

/** The gateway's console, its browser a device in an end-to-end chain: screens in the console, files not yet. */
export const HostedEndToEndFiles: Story = () => <Scenario e2e view="files" />;

/** The gateway's console while it checks the chain: no files are read through the gateway until it knows. */
export const CheckingEndToEndFiles: Story = () => <Scenario e2e="pending" view="files" />;

/** The gateway's console with E2E off: the files that are in it now, as ever. */
export const NotEndToEndFiles: Story = () => <Scenario e2e={false} view="files" />;

/** The same on hosted Kantel, with its cost. */
export const Hosted: Story = () => <Scenario hosting="hosted" />;

/** ⋯ open: Fork, Save snapshot, Auto-stop, Restart on latest base and Delete. */
export const Menu: Story = () => <Scenario menuOpen />;

/**
 * On an outdated base with security fixes waiting: the notice with Restart on latest, and the base in Details. Restart
 * asks first, then the sandbox starts again on the latest.
 */
export const BaseOutdated: Story = () => <Scenario />;

/** A stopped one on an outdated base, with no security fixes waiting: amber. */
export const BaseOutdatedStopped: Story = () => <Scenario sandboxId="sbx_2q8w5e1rz4" />;

/** Logs: commands and what happened to it, newest first, the failed build open. */
export const Logs: Story = () => <Scenario view="logs" />;

/** Its egress log. */
export const Egress: Story = () => <Scenario view="egress" />;

/** Its snapshots. */
export const Snapshots: Story = () => <Scenario view="snapshots" />;

/** What's in it now. */
export const Files: Story = () => <Scenario view="files" />;

/** Its desktop, full size in the console. */
export const Desktop: Story = () => <Scenario view="desktop" />;

/** Its browser, full size in the console. */
export const Browser: Story = () => <Scenario view="browser" />;

/** Plain Alpine with Kantel's agent put in: no desktop or browser to offer, so none is; its Image section says so. */
export const NoDesktopImage: Story = () => <Scenario sandboxId="sbx_7c4x1n8ka2" />;

/** Debian with Docker and no desktop: Docker there, the screens not. */
export const DockerNoDesktopImage: Story = () => <Scenario sandboxId="sbx_2m6v9r3kd4" />;

/** The same on a phone. */
export const NoDesktopImagePhone: Story = () => <Scenario sandboxId="sbx_7c4x1n8ka2" narrow />;

/** Its address asks for a desktop the image doesn't have: Overview, never a frame onto an error. */
export const NoDesktopImageAskedForDesktop: Story = () => <Scenario sandboxId="sbx_7c4x1n8ka2" view="desktop" />;

/** Where Desktop and Browser can't open yet: disabled, with why, and no frame onto an error. */
export const ScreensUnavailable: Story = () => <Scenario unavailable="Not available here yet" />;

/** The same full size, reached from its address. */
export const DesktopUnavailable: Story = () => <Scenario unavailable="Not available here yet" view="desktop" />;

/** An end-to-end space: its E2E sessions don't carry the screens yet. */
export const ScreensNotEndToEnd: Story = () => <Scenario unavailable="Not end to end yet" />;

/** A stopped microVM: no previews, Resume, and its files from its last snapshot. */
export const Stopped: Story = () => <Scenario sandboxId="sbx_2q8w5e1rz4" />;

/** A stopped one's Files: its latest snapshot's. */
export const StoppedFiles: Story = () => <Scenario sandboxId="sbx_2q8w5e1rz4" view="files" />;

/** One that failed: what went wrong, and Recover. */
export const Failed: Story = () => <Scenario sandboxId="sbx_1o9p4a7se6" />;

/** An isolate: no desktop, browser or SSH. */
export const Isolate: Story = () => <Scenario sandboxId="sbx_9a2b6c4dq3" />;

/** An isolate's Files: its /workspace, its only files, where the crumbs start and Up stops. */
export const IsolateFiles: Story = () => <Scenario sandboxId="sbx_9a2b6c4dq3" view="files" />;

/** An isolate's Files from an address above /workspace (`?path=/`): clamped to /workspace, never refused. */
export const IsolateFilesFromRoot: Story = () => (
	<Scenario sandboxId="sbx_9a2b6c4dq3" view="files" filesAt={{ path: "" }} />
);

/** An isolate's folder that isn't there (an old link): a line and the way back to /workspace, not Try again. */
export const IsolateFilesGone: Story = () => (
	<Scenario sandboxId="sbx_9a2b6c4dq3" view="files" filesAt={{ path: "workspace/gone" }} />
);

/** An isolate's Files on a phone. */
export const MobileIsolateFiles: Story = () => <Scenario sandboxId="sbx_9a2b6c4dq3" view="files" narrow />;
MobileIsolateFiles.meta = { width: 390 };

/** While it loads. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;

/** When Kantel can't be reached. */
export const Unreachable: Story = () => <Scenario options={{ fail: true }} />;

/** On a phone: no previews, Stop in ⋯, the sections stacked, its mounts last. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };

/** A phone's Logs. */
export const MobileLogs: Story = () => <Scenario narrow view="logs" />;
MobileLogs.meta = { width: 390 };

/** A phone's desktop. */
export const MobileDesktop: Story = () => <Scenario narrow view="desktop" />;
MobileDesktop.meta = { width: 390 };
