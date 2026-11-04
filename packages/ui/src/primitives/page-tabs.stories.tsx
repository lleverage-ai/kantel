import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { PageTabs } from "./page-tabs.tsx";

export default { title: "Primitives/Page tabs" } satisfies StoryDefault;

const TABS = [
	{ id: "log", label: "Log" },
	{ id: "rules", label: "Rules", count: 9 },
	{ id: "settings", label: "Settings" },
];

function Scenario({ initial = "log" }: { initial?: string }) {
	const [shown, setShown] = useState(initial);
	return (
		<div className="flex flex-col gap-4">
			<PageTabs
				label="Egress"
				tabs={TABS.map((each) => ({ ...each, href: `#${each.id}`, selected: each.id === shown }))}
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
