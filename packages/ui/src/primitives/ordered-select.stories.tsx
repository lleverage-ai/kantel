import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Row, Section, Sheet } from "../workbench/specimen.tsx";
import type { SelectOption } from "./controls.tsx";
import { OrderedSelectField } from "./ordered-select.tsx";

export default { title: "Primitives/Ordered select" } satisfies StoryDefault;

const ENVIRONMENTS: readonly SelectOption[] = [
	{ value: "env_backend", label: "backend-dev" },
	{ value: "env_evals", label: "evals" },
	{ value: "env_github", label: "lleverage-github" },
	{ value: "env_npm", label: "npm-publish" },
];

const HINT = "In this order: where two set the same variable, file or repository, the later one wins.";

/** One that keeps its own value, as a form does. */
function Picking({
	initial = [],
	options = ENVIRONMENTS,
	label = "Environments",
	...rest
}: {
	initial?: readonly string[];
	options?: readonly SelectOption[];
	label?: string;
	hint?: string;
	error?: string;
	max?: number;
	disabled?: boolean;
}) {
	const [value, setValue] = useState<readonly string[]>(initial);
	return (
		<div className="w-(--kt-card-width) max-w-full">
			<OrderedSelectField
				label={label}
				options={options}
				value={value}
				onChange={setValue}
				placeholder="Pick an environment"
				{...rest}
			/>
		</div>
	);
}

const LONG: readonly SelectOption[] = [
	{
		value: "env_long",
		label: "backend-dev-with-github-npm-openai-and-the-staging-database-for-the-nightly-migrations",
	},
	{ value: "env_github", label: "lleverage-github" },
];

/** Every state: none picked, several in order, every one picked, at the most allowed, an error, disabled, long names. */
export const States: Story = () => (
	<Sheet
		title="Ordered select"
		intro="A choice of several from a list, in the order they were picked: a new sandbox's environments, where the later one wins. Pick one and press Add (or Enter) to put it last; the cross takes one out."
	>
		<Section title="Interactive">
			<Row label="None picked">
				<Picking />
			</Row>
			<Row label="Several, in order">
				<Picking initial={["env_github", "env_backend"]} hint={HINT} />
			</Row>
		</Section>
		<Section title="States">
			<Row label="Every one picked">
				<Picking initial={ENVIRONMENTS.map((option) => option.value)} />
			</Row>
			<Row label="At the most allowed">
				<Picking initial={["env_backend", "env_evals"]} max={2} hint="Two at most." />
			</Row>
			<Row label="Error">
				<Picking initial={["env_evals"]} error="evals is gone. Take it out or pick another." />
			</Row>
			<Row label="Disabled">
				<Picking initial={["env_backend"]} disabled />
			</Row>
			<Row label="Nothing to pick">
				<Picking options={[]} hint="This account has no environments yet." />
			</Row>
			<Row label="Long content">
				<Picking options={LONG} initial={["env_long"]} />
			</Row>
		</Section>
	</Sheet>
);

/** At 420px. */
export const Mobile: Story = () => (
	<Sheet title="Ordered select at 420px">
		<Picking initial={["env_backend", "env_github"]} hint={HINT} />
		<Picking options={LONG} initial={["env_long"]} label="Long content" />
	</Sheet>
);
Mobile.meta = { width: 420 };
