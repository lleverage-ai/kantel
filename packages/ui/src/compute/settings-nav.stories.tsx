import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { SettingsFrame } from "./settings-nav.tsx";

export default { title: "Compute/Settings navigation" } satisfies StoryDefault;

const ITEMS = [
	{ id: "general", label: "General", href: "#general", selected: true },
	{ id: "keys", label: "API keys", href: "#keys" },
	{ id: "webhooks", label: "Webhooks", href: "#webhooks" },
	{ id: "telemetry", label: "OpenTelemetry", href: "#telemetry" },
];

const Page = () => (
	<div className="flex flex-col gap-2">
		<h1 className="m-0 text-lg font-strong">General</h1>
		<p className="m-0 text-sm text-muted">The settings page shown.</p>
	</div>
);

/** Beside the page on a wide screen. */
export const Wide: Story = () => (
	<SettingsFrame items={ITEMS}>
		<Page />
	</SettingsFrame>
);

/** In a row over the page on a phone, scrolling sideways when it doesn't fit. */
export const Phone: Story = () => (
	<SettingsFrame items={ITEMS} narrow>
		<Page />
	</SettingsFrame>
);
Phone.meta = { width: 390 };
