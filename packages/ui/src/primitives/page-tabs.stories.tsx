import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { PageTabs } from "./page-tabs.tsx";

export default { title: "Primitives/Page tabs" } satisfies StoryDefault;

const TABS = [
	{ id: "log", label: "Log" },
	{ id: "rules", label: "Rules", count: 9 },
	{ id: "settings", label: "Settings" },
];

const SANDBOX_TABS = [
	{ id: "overview", label: "Overview" },
	{ id: "logs", label: "Logs" },
	{ id: "egress", label: "Egress", count: 9 },
	{ id: "snapshots", label: "Snapshots", count: 4 },
	{ id: "files", label: "Files" },
];

function Scenario({
	initial = "log",
	label = "Egress",
	tabs = TABS,
}: {
	initial?: string;
	label?: string;
	tabs?: typeof TABS;
}) {
	const [shown, setShown] = useState(initial);
	return (
		<div className="flex flex-col gap-4">
			<PageTabs
				label={label}
				tabs={tabs.map((each) => ({ ...each, href: `#${each.id}`, selected: each.id === shown }))}
				onSelect={setShown}
			/>
			<p className="m-0 text-sm text-muted">Showing {shown}.</p>
		</div>
	);
}

/** Egress's three views; choose one to show it. */
export const Default: Story = () => <Scenario />;

/** The middle one shown, with its count. */
export const Rules: Story = () => <Scenario initial="rules" />;

/** On a phone: the same row, scrolling sideways if it has to. */
export const Phone: Story = () => <Scenario />;
Phone.meta = { width: 390 };

/** A sandbox's five sections under its header. */
export const Sandbox: Story = () => <Scenario initial="overview" label="api-server" tabs={SANDBOX_TABS} />;

/** A sandbox's sections on a phone, where they scroll sideways. */
export const SandboxPhone: Story = () => <Scenario initial="overview" label="api-server" tabs={SANDBOX_TABS} />;
SandboxPhone.meta = { width: 390 };
