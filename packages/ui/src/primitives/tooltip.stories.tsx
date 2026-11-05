import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import { Button } from "./button.tsx";
import { HelpHint, Tooltip } from "./tooltip.tsx";

export default { title: "Primitives/Tooltip" } satisfies StoryDefault;

const long = "eval-runner-12-with-a-much-longer-name-than-the-column-has-room-for";

/** Hover or Tab to each: a button's purpose, a truncated name, a column's "?", figures, one shown at once. */
export const States: Story = () => (
	<Sheet
		title="Tooltip"
		intro="A few words on hover and keyboard focus, on the page's body so nothing clips it. Escape or a scroll hides it; a touch shows nothing."
	>
		<Section title="On hover and focus">
			<Row label="A button">
				<Tooltip content="Stops it and saves a snapshot">
					<Button size="sm">Stop</Button>
				</Tooltip>
			</Row>
			<Row label="Truncated text, only while it's cut short">
				<span className="flex w-48 flex-col gap-2">
					<Tooltip content={long} whenTruncated className="w-full">
						<span className="block truncate">{long}</span>
					</Tooltip>
					<Tooltip content="api-server" whenTruncated className="w-full">
						<span className="block truncate">api-server</span>
					</Tooltip>
				</span>
			</Row>
			<Row label="A column's ?">
				<span className="inline-flex items-center gap-1 text-sm text-muted">
					Stops in
					<HelpHint label="About stops in">When auto-stop stops it. Its page can push this back.</HelpHint>
				</span>
			</Row>
		</Section>
		<Section title="Shown">
			<Row label="Figures">
				<Tooltip
					defaultOpen
					content={
						<span className="flex flex-col gap-1 tabular-nums">
							<span>CPU 33%</span>
							<span>RAM 35% (5.5 of 16 GB)</span>
						</span>
					}
				>
					<span className="text-sm">Usage</span>
				</Tooltip>
			</Row>
		</Section>
	</Sheet>
);

/** On a phone: the same, and a tap shows nothing. */
export const Mobile: Story = () => <States />;
Mobile.meta = { width: 390 };
