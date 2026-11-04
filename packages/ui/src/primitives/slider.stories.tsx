import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import { SliderField } from "./slider.tsx";

export default { title: "Primitives/Slider field" } satisfies StoryDefault;

const megabytes = (value: number) => (value < 1024 ? `${value} MB` : `${value / 1024} GB`);

function Live({
	initial,
	...props
}: { initial: number } & Omit<Parameters<typeof SliderField>[0], "value" | "onChange">) {
	const [value, setValue] = useState(initial);
	return <SliderField {...props} value={value} onChange={setValue} />;
}

/** Every state: a plain range, marks, a hint, an error, disabled, one value only, and long words. */
export const States: Story = () => (
	<Sheet
		title="Slider field"
		intro="A number chosen along a range: a sandbox's vCPUs or memory. Arrow keys move it a step, Page Up and Down further, Home and End to the ends; the value shows beside the label."
	>
		<Section title="Interactive">
			<Row label="vCPUs, with presets marked">
				<Live
					label="vCPUs"
					initial={4}
					min={1}
					max={16}
					step={1}
					marks={[2, 4, 8]}
					format={(value) => `${value} vCPU`}
				/>
			</Row>
			<Row label="Memory with a hint">
				<Live
					label="Memory"
					initial={256}
					min={128}
					max={512}
					step={64}
					marks={[256]}
					format={megabytes}
					hint="Shared CPU: an isolate shares its account's VM's CPU."
				/>
			</Row>
		</Section>
		<Section title="States">
			<Row label="With an error">
				<Live
					label="Memory"
					initial={1024}
					min={512}
					max={8192}
					step={512}
					format={megabytes}
					error="No host has that much memory free."
				/>
			</Row>
			<Row label="Disabled">
				<Live label="vCPUs" initial={2} min={1} max={8} step={1} disabled format={(value) => `${value} vCPU`} />
			</Row>
			<Row label="One value only">
				<Live label="vCPUs" initial={1} min={1} max={1} step={1} format={(value) => `${value} vCPU`} />
			</Row>
			<Row label="Long label">
				<Live
					label="Memory each sandbox in this environment starts with"
					initial={2048}
					min={512}
					max={32768}
					step={512}
					format={megabytes}
				/>
			</Row>
		</Section>
	</Sheet>
);

/** At phone width. */
export const Mobile: Story = () => (
	<Live label="Memory" initial={8192} min={512} max={32768} step={512} marks={[4096, 8192, 16384]} format={megabytes} />
);
Mobile.meta = { width: 390 };
