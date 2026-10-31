import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import { KantelLockup, KantelMark, KantelWordmark } from "./kantel.tsx";

export default { title: "Brand" } satisfies StoryDefault;

/** Every piece of the artwork at the sizes the console uses, in the theme's ink. Switch theme to see the other ink. */
export const Kantel: Story = () => (
	<Sheet
		title="Kantel"
		intro="The approved mark and wordmark, drawn from their outlines in --hb-brand-ink (white on a dark theme, grey 900 on a light one) with the fulcrum in --hb-brand-fulcrum."
	>
		<Section title="Lockups">
			<Row label="Sidebar head, --hb-brand-sm">
				<KantelLockup className="h-(--hb-brand-sm)" title="Kantel" />
			</Row>
			<Row label="Sign-in, endorsed, --hb-brand-md">
				<KantelLockup endorsed className="h-(--hb-brand-md)" title="Kantel, by Lleverage" />
			</Row>
		</Section>
		<Section title="Mark and wordmark">
			<Row label="Mark, --hb-brand-mark">
				<KantelMark className="h-(--hb-brand-mark)" title="Kantel" />
			</Row>
			<Row label="Wordmark">
				<KantelWordmark className="h-(--hb-brand-md)" title="Kantel" />
			</Row>
		</Section>
	</Sheet>
);
