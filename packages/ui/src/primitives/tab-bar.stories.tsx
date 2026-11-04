import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { EnvironmentIcon, ProxyIcon, SandboxIcon, SettingsIcon, SnapshotIcon } from "./lucide.tsx";
import { TabBar } from "./tab-bar.tsx";

export default { title: "Primitives/Tab bar" } satisfies StoryDefault;

const PAGES = [
	{ id: "sandboxes", label: "Sandboxes", icon: <SandboxIcon /> },
	{ id: "snapshots", label: "Snapshots", icon: <SnapshotIcon /> },
	{ id: "environments", label: "Envs", icon: <EnvironmentIcon /> },
	{ id: "egress", label: "Egress", icon: <ProxyIcon /> },
	{ id: "settings", label: "Settings", icon: <SettingsIcon /> },
];

/** The console's five pages along the bottom of a phone; tap one to choose it. */
export const Phone: Story = () => {
	const [shown, setShown] = useState("sandboxes");
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the story keeps the links on the page; each is focusable.
		// biome-ignore lint/a11y/useKeyWithClickEvents: a link's Enter is a click.
		<div
			className="-m-(--kt-space-6) flex h-(--kt-popover-height) flex-col justify-end bg-canvas"
			onClick={(event) => {
				const id = (event.target as Element).closest("a")?.getAttribute("href")?.slice(1);
				if (id === undefined) return;
				event.preventDefault();
				setShown(id);
			}}
		>
			<TabBar
				label="Pages"
				items={PAGES.map((page) => ({ ...page, href: `#${page.id}`, selected: page.id === shown }))}
			/>
		</div>
	);
};
Phone.meta = { width: 390 };
