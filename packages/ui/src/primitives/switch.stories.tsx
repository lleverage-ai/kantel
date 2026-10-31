import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import { Switch } from "./switch.tsx";

export default { title: "Primitives/Switch" } satisfies StoryDefault;

/** A switch that saves for a moment after each change, as one bound to an API does. */
function Saving({ initial, label, hint }: { initial: boolean; label: string; hint?: string }) {
	const [checked, setChecked] = useState(initial);
	const [busy, setBusy] = useState(false);
	return (
		<Switch
			label={label}
			checked={checked}
			busy={busy}
			{...(hint === undefined ? {} : { hint })}
			onChange={(next) => {
				setBusy(true);
				setTimeout(() => {
					setChecked(next);
					setBusy(false);
				}, 900);
			}}
		/>
	);
}

const noop = () => {};

/** Every state: off, on, saving, disabled, with a hint, a hidden label and long words. */
export const States: Story = () => (
	<Sheet
		title="Switch"
		intro="An on/off setting that applies the moment it changes, with no Save button: a tool server's tool, enabled or not. Space or Enter toggles it, and so does a click on its label."
	>
		<Section title="Interactive">
			<Row label="Saves for a moment">
				<Saving initial label="Enable slack_search" />
				<Saving initial={false} label="Enable drive_search" />
			</Row>
		</Section>
		<Section title="States">
			<Row label="Off and on">
				<Switch label="Off" checked={false} onChange={noop} />
				<Switch label="On" checked onChange={noop} />
			</Row>
			<Row label="Saving">
				<Switch label="Turning on" checked busy onChange={noop} />
				<Switch label="Turning off" checked={false} busy onChange={noop} />
			</Row>
			<Row label="Disabled">
				<Switch label="Off, disabled" checked={false} disabled onChange={noop} />
				<Switch label="On, disabled" checked disabled onChange={noop} />
			</Row>
			<Row label="With a hint">
				<Saving initial label="Offer to new sessions" hint="Running sessions keep the tools they started with." />
			</Row>
			<Row label="Hidden label">
				<Switch label="Enable memory_search" hideLabel checked onChange={noop} />
			</Row>
			<Row label="Long content">
				<div className="w-56">
					<Switch
						label="Enable search_engineering_handbook_sections_by_heading_text for every new session in the project"
						checked={false}
						onChange={noop}
					/>
				</div>
			</Row>
		</Section>
	</Sheet>
);

/** At 420px. */
export const Mobile: Story = () => (
	<Sheet title="Switch at 420px">
		<Saving initial label="Enable slack_search" hint="Applies to new sessions." />
		<Switch label="Enable drive_search" checked={false} onChange={noop} />
	</Sheet>
);
Mobile.meta = { width: 420 };
