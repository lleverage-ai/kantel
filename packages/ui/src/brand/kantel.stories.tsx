import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import { KantelLockup, KantelMark, KantelWordmark } from "./kantel.tsx";

export default { title: "Brand" } satisfies StoryDefault;

/** Every piece of the artwork at the sizes the console uses, in the theme's ink. Switch theme to see the other ink. */
export const Kantel: Story = () => (
	<Sheet
		title="Kantel"
		intro="The approved mark and wordmark, drawn from their outlines in --kt-brand-ink (white on a dark theme, grey 900 on a light one) with the fulcrum in --kt-brand-fulcrum."
	>
		<Section title="Lockups">
			<Row label="Sidebar head, --kt-brand-sm">
				<KantelLockup className="h-(--kt-brand-sm)" title="Kantel" />
			</Row>
			<Row label="Sign-in, endorsed, --kt-brand-md">
				<KantelLockup endorsed className="h-(--kt-brand-md)" title="Kantel, by Lleverage" />
			</Row>
		</Section>
		<Section title="Mark and wordmark">
			<Row label="Mark, --kt-brand-mark">
				<KantelMark className="h-(--kt-brand-mark)" title="Kantel" />
			</Row>
			<Row label="Wordmark">
				<KantelWordmark className="h-(--kt-brand-md)" title="Kantel" />
			</Row>
		</Section>
	</Sheet>
);
