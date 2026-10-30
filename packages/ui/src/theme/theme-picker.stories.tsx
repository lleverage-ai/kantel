import type { TranscriptItem } from "@harbour/protocol";
import { useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { assistant, tool, user } from "../session/fixtures.ts";
import { Transcript } from "../session/transcript.tsx";
import { parseTheme } from "../tokens/theme-schema.ts";
import { builtinThemes } from "../tokens/themes/index.ts";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Section, Sheet } from "../workbench/specimen.tsx";
import { createThemeController, type ThemeController } from "./controller.ts";
import { createThemeRegistry } from "./registry.ts";
import { ThemePicker, type ThemePickerProps } from "./theme-picker.tsx";

/** A transcript under the picker, in a 480px frame. */
const frame = "mt-3 flex h-120 w-full flex-col overflow-hidden rounded-panel border border-border bg-canvas";

export default { title: "Theme/Theme picker" } satisfies StoryDefault;

const answer = [
	"Charges now retry on a `429` or a `5xx`, three times, with one idempotency key for every attempt:",
	"",
	"```ts",
	"export async function charge(gateway: Gateway, input: Charge, attempts = 3): Promise<string> {",
	"\tconst key = crypto.randomUUID(); // one key for every attempt",
	"\tfor (let attempt = 1; ; attempt++) {",
	'\t\tconst response = await gateway.post("/v1/charges", input, { idempotencyKey: key });',
	"\t\tif (response.ok) return (await response.json()).id;",
	"\t\tawait sleep(2 ** attempt * 100);",
	"\t}",
	"}",
	"```",
].join("\n");

const session: TranscriptItem[] = [
	user("u1", "Make `charge()` retry transient gateway errors, without ever charging twice."),
	tool("t1", "read", "Read src/billing/charge.ts", {
		args: { path: "src/billing/charge.ts" },
		output:
			'import type { Charge, Gateway } from "./types.ts";\n\nexport async function charge(gateway: Gateway, input: Charge) {}\n',
	}),
	assistant("a1", answer),
];

const NONE: readonly unknown[] = [];

/** A controller of its own that remembers nothing, so a story never changes the workbench's remembered theme. */
function useStoryController(extra: readonly unknown[] = NONE): ThemeController {
	const [controller] = useState(() => {
		const registry = createThemeRegistry();
		for (const theme of extra) registry.register(theme);
		const memory = new Map<string, string>();
		return createThemeController({
			registry,
			storage: { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => void memory.set(key, value) },
		});
	});
	useEffect(() => () => controller.dispose(), [controller]);
	return controller;
}

function Picker(props: Partial<ThemePickerProps> & { extra?: readonly unknown[] }) {
	const controller = useStoryController(props.extra);
	const [open, setOpen] = useState(true);
	return (
		<>
			<Button onClick={() => setOpen(true)}>Choose a theme</Button>
			<ThemePicker
				open={open}
				onClose={() => setOpen(false)}
				controller={controller}
				{...(props.defaultQuery === undefined ? {} : { defaultQuery: props.defaultQuery })}
			/>
		</>
	);
}

export const Default: Story = () => (
	<Sheet
		title="Theme picker"
		intro="Ctrl+K T (⌘K T) or the palette button by who is signed in. Arrow keys preview each theme on the whole page as you move, Enter keeps it, Escape puts yours back."
	>
		<Picker />
		<div className={frame}>
			<Transcript items={session} />
		</div>
	</Sheet>
);

/** Every built-in theme side by side: a session with code, and the status colours. */
export const Themes: Story = () => (
	<Sheet title="Themes" intro="Every built-in theme, each in its own colours. Code follows the theme's syntax palette.">
		<div className="grid grid-cols-[repeat(auto-fill,minmax(calc(var(--hb-space-11)*9),1fr))] gap-3">
			{builtinThemes.map((theme) => (
				<section
					key={theme.id}
					data-hb-theme={theme.id}
					className="hb-app flex min-w-0 flex-col gap-2.5 rounded-panel border border-border bg-canvas p-3"
				>
					<h2 className="m-0 text-md font-medium text-fg">{theme.name}</h2>
					<div className="flex flex-wrap gap-2.5">
						<StatusLabel status="working" />
						<StatusLabel status="waiting" />
						<StatusLabel status="approval" />
						<StatusLabel status="done" />
						<StatusLabel status="error" />
					</div>
					<Transcript items={[assistant(`a-${theme.id}`, answer)]} />
				</section>
			))}
		</div>
	</Sheet>
);

export const Loading: Story = () => (
	<Sheet
		title="Code before the highlighter loads"
		intro="The highlighter is its own chunk, loaded the first time code asks for it. Until then code is plain, in the theme's code colour; then every block highlights in one render."
	>
		<pre className="m-0 rounded-sm bg-code-surface px-3 py-2.5 font-mono text-sm">
			<code className="hb-syntax">{'const response = await gateway.post("/v1/charges", input);'}</code>
		</pre>
	</Sheet>
);

export const Empty: Story = () => (
	<Sheet title="No theme matches" intro="A search that matches nothing says so; Escape still puts yours back.">
		<Picker defaultQuery="neon" />
	</Sheet>
);

const streaming: TranscriptItem[] = [
	user("su", "Show me the retry loop."),
	assistant("sa", answer.slice(0, answer.indexOf("await sleep")), { streaming: true, secondsAgo: 2 }),
];

export const Streaming: Story = () => (
	<Sheet
		title="A code block streaming in"
		intro="An open fence highlights as it grows. Switching theme mid-stream restyles it without highlighting again."
	>
		<Picker />
		<div className={frame}>
			<Transcript items={streaming} />
		</div>
	</Sheet>
);

const broken = {
	id: "custom-broken",
	name: "Broken",
	kind: "dark",
	tokens: { canvas: "red;} body{display:none", text: 12 },
};

export const ErrorState: Story = () => {
	const { problems } = parseTheme(broken);
	return (
		<Sheet
			title="A custom theme with problems"
			intro="A theme from data is checked against the schema. A bad value is dropped and the token falls back to Harbour's; a bad shape is refused."
		>
			<Section title="What the registry says">
				<Notice level="error">{problems.map((problem) => `${problem.path}: ${problem.message}`).join(". ")}</Notice>
			</Section>
			<Section title="Registered anyway, with Harbour's colours where it had none">
				<Picker extra={[broken]} defaultQuery="broken" />
			</Section>
		</Sheet>
	);
};
ErrorState.storyName = "Error";

const many = Array.from({ length: 14 }, (_, i) => ({
	id: `custom-${i + 1}`,
	name: `A person's own theme with a long name, number ${i + 1}`,
	kind: i % 2 === 0 ? "dark" : "light",
	// Each takes its accent from a built-in theme's, so the swatches differ.
	tokens: { accent: builtinThemes[i % builtinThemes.length]?.tokens.accent },
}));

export const LongContent: Story = () => (
	<Sheet
		title="Many themes"
		intro="Fourteen custom themes after the built-in ones: the list scrolls and long names truncate."
	>
		<Picker extra={many} />
	</Sheet>
);

export const Mobile: Story = () => (
	<Sheet title="Theme picker at 420px" intro="The palette fills the width, less the page's margin.">
		<Picker />
	</Sheet>
);
Mobile.meta = { width: 420 };
