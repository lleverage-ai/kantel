import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { ComputeConsole, type ComputePage, computePath } from "./compute-console.tsx";
import type { HostingMode } from "./compute-model.ts";
import { type ComputeFixtureOptions, createComputeFixtures, FIXTURE_NOW } from "./fixtures.ts";

export default { title: "Compute/Console" } satisfies StoryDefault;

// The whole console on sample data: every page in both modes, as the PR's screenshots show them. Each story keeps its
// own source and its own address, so the sidebar's links and the account switcher work inside the story.
function Scenario({
	page = "sandboxes",
	hosting = "self-hosted",
	account = "org_lleverage",
	options,
	narrow,
	sandboxId,
}: {
	page?: ComputePage;
	hosting?: HostingMode;
	account?: string;
	options?: ComputeFixtureOptions;
	/** The phone layout; by default it follows the story's width, as the console's does (max-width: 640px). */
	narrow?: boolean;
	sandboxId?: string;
}) {
	const [fits] = useState(() => window.matchMedia("(max-width: 640px)").matches);
	const [source] = useState(() => createComputeFixtures({ hosting, ...options }));
	const [path, setPath] = useState(() => computePath(page, "/compute", sandboxId));
	const [pathname = "/compute", search = ""] = path.split(/(?=\?)/);
	// The workbench pads every story; the console is a whole window, so it takes the padding back.
	return (
		<div className="-m-(--kt-space-9) max-sm:-m-(--kt-space-6)">
			<ComputeConsole
				source={source}
				pathname={pathname}
				search={search}
				navigate={setPath}
				now={FIXTURE_NOW}
				narrow={narrow ?? fits}
				sample
				initialAccountId={account}
			/>
		</div>
	);
}

export const Sandboxes: Story = () => <Scenario />;
export const SandboxesHosted: Story = () => <Scenario hosting="hosted" />;
export const Personal: Story = () => <Scenario account="acc_tom" />;
export const Snapshots: Story = () => <Scenario page="snapshots" />;
export const SnapshotsHosted: Story = () => <Scenario page="snapshots" hosting="hosted" />;
export const ApiKeys: Story = () => <Scenario page="keys" />;
export const ApiKeysHosted: Story = () => <Scenario page="keys" hosting="hosted" />;
export const Egress: Story = () => <Scenario page="egress" />;
export const EgressHosted: Story = () => <Scenario page="egress" hosting="hosted" />;
export const Webhooks: Story = () => <Scenario page="webhooks" />;
/** The account's environments: secrets and variables a sandbox starts with. */
export const Environments: Story = () => <Scenario page="environments" />;
export const WebhooksHosted: Story = () => <Scenario page="webhooks" hosting="hosted" />;
export const Telemetry: Story = () => <Scenario page="telemetry" />;
export const TelemetryHosted: Story = () => <Scenario page="telemetry" hosting="hosted" />;
export const Organisation: Story = () => <Scenario page="organisation" />;
export const OrganisationHosted: Story = () => <Scenario page="organisation" hosting="hosted" />;
export const Billing: Story = () => <Scenario page="billing" hosting="hosted" />;
/** Settings' Mounts, where the deployment has turned mounts on. */
export const Mounts: Story = () => <Scenario page="mounts" />;
/** Mounts off: no Mounts in Settings, and its address opens Sandboxes. */
export const MountsOff: Story = () => <Scenario page="mounts" options={{ noMounts: true }} />;
export const Hosts: Story = () => <Scenario page="hosts" />;
/** Admin's Install: the public URL, a default install's loopback until one is set here. */
export const Install: Story = () => <Scenario page="install" />;
/** A new install's first run: no host yet, so Sandboxes leads with adding one, its address loopback. */
export const FirstRun: Story = () => <Scenario options={{ noHosts: true }} />;
/** The first run where the deployment already has an address hosts can reach. */
export const FirstRunReachable: Story = () => (
	<Scenario options={{ noHosts: true, publicUrl: "https://kantel.example.com" }} />
);
/** The first run on a phone. */
export const MobileFirstRun: Story = () => <Scenario options={{ noHosts: true }} narrow />;
MobileFirstRun.meta = { width: 390 };
/** Admin's Install on a phone: Hosts and Install in a row over the page. */
export const MobileInstall: Story = () => <Scenario page="install" narrow />;
MobileInstall.meta = { width: 390 };
export const HostsHosted: Story = () => <Scenario page="hosts" hosting="hosted" />;
/** A member who isn't a super-admin has no Hosts. */
export const NotSuperAdmin: Story = () => <Scenario options={{ notSuperAdmin: true }} />;
/** One sandbox open on its overview. */
export const Sandbox: Story = () => <Scenario sandboxId="sbx_7f3k2m9qa1" />;
/** An account with nothing yet: no sandboxes, snapshots, keys, webhooks or hosts. */
export const Empty: Story = () => <Scenario options={{ empty: true }} />;
/** The first read still on its way. */
export const Loading: Story = () => <Scenario options={{ hang: true }} />;
export const Failed: Story = () => <Scenario options={{ fail: true }} />;
/** A phone: the top bar, the page and the five pages along the bottom. */
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 390 };
/** Settings on a phone: its pages in a row over the page. */
export const MobileSettings: Story = () => <Scenario page="keys" narrow />;
MobileSettings.meta = { width: 390 };
/** Egress on a phone: the log as two-line rows over the tab bar. */
export const MobileEgress: Story = () => <Scenario page="egress" narrow />;
MobileEgress.meta = { width: 390 };
/** Admin on a phone: a way back to the console, and no tab bar. */
export const MobileAdmin: Story = () => <Scenario page="hosts" narrow />;
MobileAdmin.meta = { width: 390 };
