import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Button } from "./button.tsx";
import { SegmentedControl, SelectField, TextAreaField, TextField } from "./controls.tsx";
import { FormActions, FormField, FormGrid, FormLayout, FormSection, PageHeader } from "./form-layout.tsx";
import { PlusIcon } from "./icons.tsx";
import { Badge } from "./status.tsx";
import { Notice, Panel } from "./surface.tsx";

export default { title: "Primitives / Form layout" } satisfies StoryDefault;

const ZONES = [
	{ value: "Europe/London", label: "Europe/London" },
	{ value: "America/Argentina/Buenos_Aires", label: "America/Argentina/Buenos Aires" },
];

function ScheduleLikeForm({ errors = false }: { errors?: boolean }) {
	const [kind, setKind] = useState<"task" | "check">("task");
	const [when, setWhen] = useState<"repeat" | "once">("repeat");
	return (
		<Panel header="New schedule">
			<FormLayout>
				<FormSection title="What runs">
					<FormField id="story-kind" label="Kind" hint="Starts a session with an agent and sends it your prompt.">
						<SegmentedControl
							label="Kind"
							value={kind}
							onChange={setKind}
							options={[
								{ value: "task", label: "Task" },
								{ value: "check", label: "Check" },
							]}
						/>
					</FormField>
					<TextField
						label="Title"
						defaultValue={errors ? "" : "Triage new issues"}
						{...(errors ? { error: "Give it a title." } : {})}
					/>
					<TextAreaField label="Prompt" rows={4} hint="Sent exactly as written." />
				</FormSection>
				<FormSection title="When" description="When it runs, in its own time zone.">
					<SegmentedControl
						label="When"
						value={when}
						onChange={setWhen}
						options={[
							{ value: "repeat", label: "Repeats" },
							{ value: "once", label: "Once" },
						]}
					/>
					<FormGrid>
						<SelectField
							label="Every"
							options={[
								{ value: "minutes", label: "Minutes" },
								{ value: "day", label: "Day" },
							]}
						/>
						<TextField
							label="Minutes apart"
							type="number"
							defaultValue="30"
							{...(errors ? { error: "A whole number of minutes, at least 1." } : {})}
						/>
						<TextField label="At" type="time" defaultValue="09:00" />
					</FormGrid>
					<FormGrid>
						<SelectField label="Time zone" options={ZONES} />
						<TextField label="Stop after" type="number" placeholder="No limit" hint="Runs, in all." />
					</FormGrid>
				</FormSection>
				{errors ? <Notice level="error">Couldn't save the schedule. Try again.</Notice> : null}
				<FormActions
					end={
						<Button variant="danger" size="sm">
							End schedule
						</Button>
					}
				>
					<Button variant="primary" size="sm">
						Save changes
					</Button>
					<Button variant="ghost" size="sm">
						Cancel
					</Button>
				</FormActions>
			</FormLayout>
		</Panel>
	);
}

/** A config page: the header, then a form at the reading width. */
export const Page: Story = () => (
	<div style={{ display: "flex", flexDirection: "column", gap: "var(--kt-space-8)", padding: "var(--kt-space-9)" }}>
		<PageHeader
			title="Schedules"
			lede="What runs on its own: reminders, tasks, summaries, checks and programs, with when each runs next."
			actions={
				<Button variant="primary" icon={<PlusIcon size="sm" />}>
					New schedule
				</Button>
			}
		/>
		<div style={{ maxWidth: "var(--kt-content-width)" }}>
			<ScheduleLikeForm />
		</div>
	</div>
);

export const Errors: Story = () => (
	<div style={{ maxWidth: "var(--kt-content-width)", padding: "var(--kt-space-9)" }}>
		<ScheduleLikeForm errors />
	</div>
);

/** Settings rows: the label and its tag beside the value or control, on two tracks. */
export const InlineRows: Story = () => (
	<div style={{ maxWidth: "var(--kt-content-width)", padding: "var(--kt-space-9)" }}>
		<FormLayout>
			<FormSection title="Terms" description="Narrow any of them before you approve.">
				<FormField id="story-host" label="Host" layout="inline">
					<code className="kt-mono">api.linear.app</code>
				</FormField>
				<TextField
					label="Path"
					layout="inline"
					mono
					extra={<Badge tone="accent">Narrowed</Badge>}
					defaultValue="/graphql/issues"
					hint="This path and below. The agent asked for /graphql."
				/>
				<TextField
					label="Uses"
					layout="inline"
					width="short"
					extra={<Badge>Proposed</Badge>}
					placeholder="No limit"
					error="A whole number, at least 1."
				/>
			</FormSection>
		</FormLayout>
	</div>
);

/** Selects beside a text input: the chevron inset as far as the words, long words stopping short of it, and its states. */
export const Selects: Story = () => (
	<div style={{ maxWidth: "var(--kt-content-width)", padding: "var(--kt-space-9)" }}>
		<FormLayout>
			<FormSection title="Selects">
				<SelectField label="Whose it is" options={[{ value: "deployment", label: "Kantel, for everyone" }]} />
				<TextField label="GitHub organisation" placeholder="Your personal account" />
				<FormGrid>
					<SelectField
						label="Long option"
						options={[
							{
								value: "long",
								label: "America/Argentina/Buenos Aires, with a label long enough to run under the chevron",
							},
						]}
					/>
					<SelectField label="Disabled" disabled options={ZONES} />
				</FormGrid>
				<FormGrid>
					<SelectField label="Invalid" options={ZONES} error="Pick a time zone." />
					<SelectField label="Short" width="short" options={[{ value: "day", label: "Day" }]} />
				</FormGrid>
			</FormSection>
		</FormLayout>
	</div>
);

export const Mobile: Story = () => (
	<div style={{ padding: "var(--kt-space-6)" }}>
		<PageHeader
			title="API keys"
			lede="Host apps call Kantel with these keys. Each key acts only in its project, with its role."
			actions={
				<Button variant="primary" icon={<PlusIcon size="sm" />}>
					New key
				</Button>
			}
		/>
		<div style={{ marginTop: "var(--kt-space-8)" }}>
			<ScheduleLikeForm />
		</div>
	</div>
);
Mobile.meta = { width: 420 };
