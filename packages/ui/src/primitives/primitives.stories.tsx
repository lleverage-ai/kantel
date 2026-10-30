import { useState } from "react";
import type { Story, StoryDefault } from "../workbench/ladle.ts";
import { Column, Row, Section, Sheet } from "../workbench/specimen.tsx";
import { Button, IconButton } from "./button.tsx";
import { CheckboxField, CopyButton, Disclosure, SegmentedControl, TextAreaField, TextField } from "./controls.tsx";
import { DotsIcon, PlusIcon, ShieldIcon, StopIcon } from "./icons.tsx";
import { ListRow } from "./list-row.tsx";
import { Kbd, Skeleton, Spinner } from "./spinner.tsx";
import { Badge, StatusDot, StatusLabel } from "./status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "./surface.tsx";
import { Elapsed, RelativeTime } from "./time.tsx";

export default { title: "Primitives" } satisfies StoryDefault;

const long =
	"Re-run the migration against the staging copy of the billing database, then compare row counts per tenant and report any differences";

export const Buttons: Story = () => (
	<Sheet title="Button">
		<Section title="Variants">
			<Row label="Small (default)">
				<Button variant="primary">Approve</Button>
				<Button>Decline</Button>
				<Button variant="ghost">Show detail</Button>
				<Button variant="danger" icon={<StopIcon size="sm" />}>
					Stop
				</Button>
			</Row>
			<Row label="Sizes">
				<Button size="xs">Extra small</Button>
				<Button size="sm">Small</Button>
				<Button size="md">Medium</Button>
				<Button size="lg" variant="primary">
					Large
				</Button>
			</Row>
			<Row label="Icon only">
				<IconButton label="New session" icon={<PlusIcon />} variant="ghost" />
				<IconButton label="Session options" icon={<DotsIcon />} variant="ghost" />
				<IconButton label="Approve with passkey" icon={<ShieldIcon />} variant="primary" />
			</Row>
		</Section>
		<Section title="States">
			<Row label="Loading">
				<Button variant="primary" busy>
					Approving
				</Button>
				<Button busy>Saving</Button>
			</Row>
			<Row label="Disabled">
				<Button variant="primary" disabled>
					Approve
				</Button>
				<Button disabled>Decline</Button>
			</Row>
			<Row label="Long content">
				<div style={{ width: "14em", display: "flex" }}>
					<Button>{long}</Button>
				</div>
			</Row>
		</Section>
	</Sheet>
);

export const Status: Story = () => (
	<Sheet title="Status">
		<Section title="Labels">
			<Row>
				<StatusLabel status="working">Working for 3m</StatusLabel>
				<StatusLabel status="waiting" />
				<StatusLabel status="approval" />
				<StatusLabel status="done" />
				<StatusLabel status="error" />
				<StatusLabel status="idle" />
			</Row>
		</Section>
		<Section title="Dots">
			<Row>
				<StatusDot status="working" label="Working" />
				<StatusDot status="waiting" label="Needs your answer" />
				<StatusDot status="approval" label="Needs approval" />
				<StatusDot status="done" label="Done" />
				<StatusDot status="error" label="Failed" />
			</Row>
		</Section>
		<Section title="Badges">
			<Row>
				<Badge tone="approval">Proposed</Badge>
				<Badge tone="done">Approved</Badge>
				<Badge tone="error">Denied</Badge>
				<Badge tone="accent">Route grant</Badge>
				<Badge>Read only</Badge>
			</Row>
		</Section>
		<Section title="Loading">
			<Row>
				<Spinner label="Loading" />
				<Spinner size="sm" />
				<div style={{ width: "20em" }}>
					<Skeleton lines={3} />
				</div>
			</Row>
		</Section>
		<Section title="Keys">
			<Row>
				<Kbd>Enter</Kbd>
				<Kbd>⇧ Enter</Kbd>
				<Kbd>⌘K</Kbd>
				<Kbd>Esc</Kbd>
			</Row>
		</Section>
	</Sheet>
);

export const Surfaces: Story = () => (
	<Sheet title="Panel, notice and empty state">
		<Column>
			<Panel header="Grant" footer="Expires in 14 days">
				<FieldList>
					<Field label="Host">
						<code className="hb-mono">api.linear.app</code>
					</Field>
					<Field label="Methods" extra={<Badge tone="approval">Proposed</Badge>}>
						GET, POST
					</Field>
					<Field label="Path">
						<code className="hb-mono">/graphql</code>
					</Field>
					<Field label="Long content">{long}</Field>
				</FieldList>
			</Panel>
			<Panel tone="approval" header="Needs approval">
				Waiting for you.
			</Panel>
			<Panel tone="error" header="Failed">
				The vault refused the grant: the code you picked does not match.
			</Panel>
			<Notice>Reconnecting. What you see may be a few seconds behind.</Notice>
			<Notice level="warning" action={<Button size="xs">Show output</Button>}>
				This command may have partly run before the connection dropped.
			</Notice>
			<Notice level="error">The session failed: the sandbox ran out of memory.</Notice>
			<Panel>
				<EmptyState title="Nothing waiting on you" />
			</Panel>
			<Panel>
				<EmptyState title="No skills yet" action={<Button variant="primary">New skill</Button>}>
					Skills you or your agents save appear here.
				</EmptyState>
			</Panel>
		</Column>
	</Sheet>
);

function ControlsDemo() {
	const [layout, setLayout] = useState<"unified" | "split">("unified");
	const [filter, setFilter] = useState<"all" | "working" | "waiting" | "done">("all");
	const [agentWrites, setAgentWrites] = useState(false);
	return (
		<Sheet title="Controls">
			<Section title="Segmented control">
				<Row>
					<SegmentedControl
						label="Diff layout"
						options={[
							{ value: "unified", label: "Unified" },
							{ value: "split", label: "Split" },
						]}
						value={layout}
						onChange={setLayout}
					/>
					<SegmentedControl
						label="Show"
						options={[
							{ value: "all", label: "All", count: 24 },
							{ value: "working", label: "Working", count: 3 },
							{ value: "waiting", label: "Waiting on you", count: 2 },
							{ value: "done", label: "Done", count: 19 },
						]}
						value={filter}
						onChange={setFilter}
					/>
				</Row>
			</Section>
			<Section title="Text field">
				<Row>
					<div style={{ width: "20em" }}>
						<TextField label="Path prefix" defaultValue="/graphql" hint="Requests outside it are refused." />
					</div>
					<div style={{ width: "20em" }}>
						<TextField label="Uses" defaultValue="0" error="At least one use." />
					</div>
				</Row>
			</Section>
			<Section title="Text area">
				<Row>
					<div style={{ width: "20em" }}>
						<TextAreaField
							label="Prompt"
							defaultValue="Label the issues opened since your last run."
							hint="Sent exactly as written."
						/>
					</div>
					<div style={{ width: "20em" }}>
						<TextAreaField label="Prompt" rows={2} defaultValue="" error="Write what to ask the agent." />
					</div>
				</Row>
			</Section>
			<Section title="Checkbox">
				<Row>
					<CheckboxField
						label="Let agents write"
						checked={agentWrites}
						onChange={(event) => setAgentWrites(event.target.checked)}
					/>
					<CheckboxField label="Let agents write" defaultChecked disabled />
					<div style={{ width: "20em" }}>
						<CheckboxField
							label="Require a second person to publish"
							hint="Whoever saved the draft can't publish it. Long hints wrap under the label, not the box."
						/>
					</div>
				</Row>
			</Section>
			<Section title="Copy and disclose">
				<Row>
					<CopyButton text="https://vault.example/p/abc" label="Copy link" />
					<CopyButton text="K7-QX" iconOnly label="Copy code" variant="ghost" />
				</Row>
				<Column>
					<Disclosure summary="Thought for 12s">
						<p style={{ margin: 0, color: "var(--hb-text-muted)" }}>
							The release notes reference three PRs that were reverted, so those lines come out.
						</p>
					</Disclosure>
					<Disclosure summary="Worked for 3m 43s" defaultOpen>
						<p style={{ margin: 0, color: "var(--hb-text-muted)" }}>{long}</p>
					</Disclosure>
				</Column>
			</Section>
		</Sheet>
	);
}

export const Controls: Story = () => <ControlsDemo />;

const now = Date.now();

function ListDemo() {
	const [selected, setSelected] = useState("b");
	const rows = [
		{
			id: "a",
			status: "working" as const,
			title: "Migrate the billing worker to Pi Durable",
			meta: "harbour, ui/session-components",
		},
		{ id: "b", status: "approval" as const, title: "Rotate the Linear API key", meta: "sal" },
		{ id: "c", status: "waiting" as const, title: "Which staging database should I use?", meta: "lleverage" },
		{ id: "d", status: "error" as const, title: "Nightly bug sweep", meta: "sal, schedule" },
		{ id: "e", status: "done" as const, title: long, meta: "harbour" },
	];
	return (
		<Sheet title="List row">
			<Section title="Compact">
				<Column>
					<div>
						{rows.map((row) => (
							<ListRow
								key={row.id}
								leading={<StatusDot status={row.status} />}
								title={row.title}
								trailing={
									row.status === "done" ? (
										<RelativeTime at={now - 2 * 3_600_000} />
									) : (
										<StatusLabel status={row.status} />
									)
								}
								selected={selected === row.id}
								onSelect={() => setSelected(row.id)}
								quiet={row.status === "done"}
							/>
						))}
					</div>
				</Column>
			</Section>
			<Section title="Comfortable, with actions on hover">
				<Column>
					<div>
						{rows.slice(0, 3).map((row) => (
							<ListRow
								key={row.id}
								density="comfortable"
								overline={row.meta}
								title={row.title}
								meta={row.status === "working" ? <Elapsed since={now - 200_000} /> : "main"}
								trailing={<StatusLabel status={row.status} />}
								actions={
									<Button size="xs" variant="ghost">
										Settle
									</Button>
								}
								selected={selected === row.id}
								onSelect={() => setSelected(row.id)}
							/>
						))}
					</div>
				</Column>
			</Section>
			<Section title="Static, with actions always shown">
				<Column>
					<div>
						<ListRow
							title="LINEAR_API_KEY"
							meta="Used by 2 grants"
							density="comfortable"
							trailing={<RelativeTime at={now - 3 * 3_600_000} />}
							actions={
								<Button size="xs" variant="ghost">
									Rotate
								</Button>
							}
						/>
					</div>
				</Column>
			</Section>
			<Section title="Loading">
				<Column>
					<div>
						{[1, 2, 3].map((index) => (
							<ListRow key={index} title={<Skeleton width="70%" />} />
						))}
					</div>
				</Column>
			</Section>
		</Sheet>
	);
}

export const ListRows: Story = () => <ListDemo />;

export const Mobile: Story = () => (
	<Sheet title="Primitives at 420px">
		<Column>
			<Row>
				<Button variant="primary">Approve</Button>
				<Button>Decline</Button>
				<CopyButton text="x" label="Copy link" />
			</Row>
			<div>
				<ListRow
					leading={<StatusDot status="working" />}
					title={long}
					trailing={<StatusLabel status="working" />}
					onSelect={() => {}}
				/>
				<ListRow
					leading={<StatusDot status="approval" />}
					title="Rotate the Linear API key"
					trailing={<StatusLabel status="approval" />}
					onSelect={() => {}}
				/>
			</div>
			<Notice level="warning">This command may have partly run before the connection dropped.</Notice>
			<TextField label="Path prefix" defaultValue="/graphql" />
		</Column>
	</Sheet>
);
Mobile.meta = { width: 420 };
