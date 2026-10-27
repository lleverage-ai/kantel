import {
	Badge,
	Button,
	CheckIcon,
	CopyButton,
	Disclosure,
	EmptyState,
	Field,
	FieldList,
	IconButton,
	Kbd,
	ListRow,
	Notice,
	Panel,
	PlusIcon,
	SearchIcon,
	SegmentedControl,
	Skeleton,
	Spinner,
	StatusDot,
	StatusLabel,
	TextField,
} from "../index.ts";
import type { Status } from "../tokens/tokens.ts";
import type { Story, StoryDefault } from "./ladle.ts";
import { Column, Row, Section, Sheet, Swatch } from "./specimen.tsx";

export default { title: "Workbench" } satisfies StoryDefault;

const statuses: Status[] = ["working", "waiting", "approval", "done", "error", "idle"];

export const Overview: Story = () => (
	<Sheet
		title="Harbour UI"
		intro="Dark and neutral after T3 Code, one accent, compact 12 to 14px type. Every value below is a token in tokens.css; components use nothing else."
	>
		<Section title="Surfaces">
			<Row>
				<Swatch name="--hb-canvas" value="var(--hb-canvas)" />
				<Swatch name="--hb-panel" value="var(--hb-panel)" />
				<Swatch name="--hb-raised" value="var(--hb-raised)" />
				<Swatch name="--hb-user-message" value="var(--hb-user-message)" />
				<Swatch name="--hb-accent" value="var(--hb-accent)" />
			</Row>
		</Section>
		<Section title="Text">
			<Row>
				<Swatch name="--hb-text" value="var(--hb-text)" text />
				<Swatch name="--hb-text-muted" value="var(--hb-text-muted)" text />
				<Swatch name="--hb-text-faint" value="var(--hb-text-faint)" text />
				<Swatch name="--hb-accent-text" value="var(--hb-accent-text)" text />
			</Row>
		</Section>
		<Section title="Status">
			<Row>
				{statuses.map((status) => (
					<StatusLabel key={status} status={status} />
				))}
			</Row>
			<Row>
				{statuses.map((status) => (
					<Badge key={status} tone={status}>
						{status === "approval"
							? "Proposed"
							: status === "done"
								? "Approved"
								: status === "error"
									? "Denied"
									: "Label"}
					</Badge>
				))}
				<Badge tone="accent">Accent</Badge>
				<Badge>Neutral</Badge>
			</Row>
		</Section>
		<Section title="Type">
			<div style={{ display: "grid", gap: "var(--hb-space-3)" }}>
				<span style={{ fontSize: "var(--hb-text-lg)", fontWeight: "var(--hb-weight-strong)" }}>
					Session title, 16px
				</span>
				<span style={{ fontSize: "var(--hb-text-md)" }}>Body and transcript, 14px</span>
				<span style={{ fontSize: "var(--hb-text-sm)", color: "var(--hb-text-muted)" }}>
					Tool rows and secondary text, 13px
				</span>
				<span style={{ fontSize: "var(--hb-text-xs)", color: "var(--hb-text-faint)" }}>Metadata, 12px</span>
				<span className="hb-mono">ui-monospace for code, paths and commands, 12.5px</span>
			</div>
		</Section>
		<Section title="Controls">
			<Row>
				<Button variant="primary">Approve</Button>
				<Button>Decline</Button>
				<Button variant="ghost">Show detail</Button>
				<Button variant="danger">Stop</Button>
				<Button busy>Saving</Button>
				<IconButton label="New session" icon={<PlusIcon />} variant="ghost" />
				<CopyButton text="https://vault.example/p/abc" label="Copy link" />
				<Kbd>⌘K</Kbd>
			</Row>
			<Row>
				<SegmentedControl
					label="Diff layout"
					options={[
						{ value: "unified", label: "Unified" },
						{ value: "split", label: "Split" },
					]}
					value="unified"
					onChange={() => {}}
				/>
				<div style={{ width: "18em" }}>
					<TextField label="Search sessions" placeholder="Title, project or branch" />
				</div>
			</Row>
		</Section>
		<Section title="Lists, panels and messages">
			<Column>
				<div>
					<ListRow
						leading={<StatusDot status="working" />}
						title="Migrate the billing worker to Pi Durable"
						trailing={<StatusLabel status="working">Working</StatusLabel>}
						onSelect={() => {}}
					/>
					<ListRow
						leading={<StatusDot status="approval" />}
						title="Rotate the Linear API key"
						trailing={<StatusLabel status="approval" />}
						onSelect={() => {}}
						selected
					/>
					<ListRow
						leading={<StatusDot status="done" />}
						title="Tidy the release notes"
						trailing="2h"
						quiet
						onSelect={() => {}}
					/>
				</div>
				<Panel header={<span>Grant</span>}>
					<FieldList>
						<Field label="Host">
							<code className="hb-mono">api.linear.app</code>
						</Field>
						<Field label="Methods" extra={<Badge tone="approval">Proposed</Badge>}>
							GET, POST
						</Field>
					</FieldList>
				</Panel>
				<Notice level="warning">This command may have partly run before the connection dropped.</Notice>
				<Disclosure summary="Thought for 12s">
					<p style={{ margin: 0, color: "var(--hb-text-muted)" }}>
						The release notes reference three PRs that were reverted.
					</p>
				</Disclosure>
				<Row>
					<Spinner label="Loading" />
					<div style={{ width: "16em" }}>
						<Skeleton lines={2} />
					</div>
					<CheckIcon label="Done" style={{ color: "var(--hb-status-done)" }} />
					<SearchIcon />
				</Row>
				<Panel>
					<EmptyState title="No sessions yet" action={<Button variant="primary">New session</Button>}>
						Start one here, or from Slack.
					</EmptyState>
				</Panel>
			</Column>
		</Section>
	</Sheet>
);
