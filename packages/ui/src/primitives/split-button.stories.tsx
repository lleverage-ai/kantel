import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import { PlusIcon } from "./icons.tsx";
import { SplitButton } from "./split-button.tsx";

export default { title: "Primitives/Split button" } satisfies StoryDefault;

/** Counts what each half was pressed for, as the console's New does: make one at once, or open the options. */
function Counting(props: { size?: "sm" | "md"; variant?: "primary" | "secondary"; disabled?: boolean }) {
	const [made, setMade] = useState(0);
	const [opened, setOpened] = useState(0);
	return (
		<span className="flex items-center gap-3">
			<SplitButton
				label="New"
				icon={<PlusIcon size="sm" />}
				onClick={() => setMade((count) => count + 1)}
				moreLabel="New sandbox with options"
				onMore={() => setOpened((count) => count + 1)}
				{...props}
			/>
			<span className="text-sm text-muted">
				Made {made}, options {opened}
			</span>
		</span>
	);
}

/** Primary and secondary, small and medium, busy and disabled. */
export const States: Story = () => (
	<Sheet
		title="Split button"
		intro="An action done at once, with a caret beside it for the same action with choices: New makes a sandbox with the defaults, its caret opens New sandbox. Two buttons, each reachable by Tab and named on its own."
	>
		<Section title="Variants">
			<Row label="Primary">
				<Counting />
			</Row>
			<Row label="Primary, medium">
				<Counting size="md" />
			</Row>
			<Row label="Secondary">
				<Counting variant="secondary" />
			</Row>
			<Row label="Disabled">
				<Counting disabled />
			</Row>
		</Section>
	</Sheet>
);
