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
	narrow = false,
	sandboxId,
}: {
	page?: ComputePage;
	hosting?: HostingMode;
	account?: string;
	options?: ComputeFixtureOptions;
	narrow?: boolean;
	sandboxId?: string;
}) {
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
				narrow={narrow}
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
export const EgressProxy: Story = () => <Scenario page="proxy" />;
export const EgressProxyHosted: Story = () => <Scenario page="proxy" hosting="hosted" />;
export const Webhooks: Story = () => <Scenario page="webhooks" />;
export const WebhooksHosted: Story = () => <Scenario page="webhooks" hosting="hosted" />;
export const Telemetry: Story = () => <Scenario page="telemetry" />;
export const TelemetryHosted: Story = () => <Scenario page="telemetry" hosting="hosted" />;
export const Organisation: Story = () => <Scenario page="organisation" />;
export const OrganisationHosted: Story = () => <Scenario page="organisation" hosting="hosted" />;
export const Billing: Story = () => <Scenario page="billing" hosting="hosted" />;
export const Hosts: Story = () => <Scenario page="hosts" />;
export const HostsHosted: Story = () => <Scenario page="hosts" hosting="hosted" />;
/** A member who isn't a super-admin has no Hosts. */
export const NotSuperAdmin: Story = () => <Scenario options={{ notSuperAdmin: true }} />;
export const Failed: Story = () => <Scenario options={{ fail: true }} />;
export const Mobile: Story = () => <Scenario narrow />;
Mobile.meta = { width: 420 };
