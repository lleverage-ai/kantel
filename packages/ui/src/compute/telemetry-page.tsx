// The OpenTelemetry page (compute console, experimental): where an account's sandbox metrics and lifecycle events are
// exported, over OTLP. An Enabled switch that applies at once; a destination preset that fills in an example endpoint
// and the name of the header its key goes in; the endpoint, the protocol, the headers (a saved value never comes back:
// it shows as Set, with Replace and Remove), what to send and extra resource attributes. Save sends only what changed;
// Send test asks Kantel to send one metric and one event now. Every call goes through the `TelemetrySource` the host
// binds; stories bind it to fixtures.

import { useId, useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { CheckboxField, SegmentedControl, TextField } from "../primitives/controls.tsx";
import { FormActions, FormField, FormLayout, FormSection, PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PlusIcon, XIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import type {
	ComputeAccount,
	TelemetryChange,
	TelemetryProtocol,
	TelemetrySettings,
	TelemetrySource,
} from "./compute-model.ts";
import { computePage, messageOf } from "./parts.tsx";

export interface TelemetryPageProps {
	readonly source: TelemetrySource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
}

type DestinationId = "grafana" | "honeycomb" | "datadog" | "otlp";

/** Where people usually send it: an example endpoint and the header its key goes in (the name only, never a value). */
const DESTINATIONS: readonly {
	readonly id: DestinationId;
	readonly label: string;
	readonly endpoint: string;
	readonly header?: string;
}[] = [
	{
		id: "grafana",
		label: "Grafana Cloud",
		endpoint: "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp",
		header: "Authorization",
	},
	{ id: "honeycomb", label: "Honeycomb", endpoint: "https://api.honeycomb.io", header: "x-honeycomb-team" },
	{ id: "datadog", label: "Datadog", endpoint: "https://otlp.datadoghq.com", header: "DD-API-KEY" },
	{ id: "otlp", label: "Any OTLP endpoint", endpoint: "https://otel-collector.example.com:4318" },
];

const PROTOCOLS: readonly { value: TelemetryProtocol; label: string }[] = [
	{ value: "http/protobuf", label: "HTTP/protobuf" },
	{ value: "grpc", label: "gRPC" },
];

/** The preset an endpoint looks like, by its host; none for no endpoint. */
function destinationOf(endpoint: string): DestinationId | undefined {
	if (endpoint === "") return undefined;
	let host = "";
	try {
		host = new URL(endpoint).hostname;
	} catch {
		return "otlp";
	}
	if (host.endsWith("grafana.net")) return "grafana";
	if (host.endsWith("honeycomb.io")) return "honeycomb";
	if (/datadoghq\.(com|eu)$/.test(host)) return "datadog";
	return "otlp";
}

/** A header in the editor: one already set (its value never comes back) or one added here. */
type HeaderRow =
	| {
			readonly kind: "saved";
			readonly id: string;
			readonly name: string;
			readonly action: "keep" | "replace" | "remove";
			readonly value: string;
	  }
	| { readonly kind: "new"; readonly id: string; readonly name: string; readonly value: string };

type AttributeRow = { readonly id: string; readonly name: string; readonly value: string };

interface Draft {
	readonly endpoint: string;
	readonly protocol: TelemetryProtocol;
	readonly metrics: boolean;
	readonly events: boolean;
	readonly headers: readonly HeaderRow[];
	readonly attributes: readonly AttributeRow[];
}

let rowCounter = 0;
const rowId = (): string => {
	rowCounter += 1;
	return `row-${rowCounter}`;
};

function draftOf(settings: TelemetrySettings): Draft {
	return {
		endpoint: settings.endpoint,
		protocol: settings.protocol,
		metrics: settings.metrics,
		events: settings.events,
		headers: settings.headers.map((name) => ({ kind: "saved", id: rowId(), name, action: "keep", value: "" })),
		attributes: Object.entries(settings.attributes).map(([name, value]) => ({ id: rowId(), name, value })),
	};
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** What's wrong with each row, by its id, and with the endpoint. */
function problemsOf(draft: Draft): { endpoint?: string; rows: ReadonlyMap<string, { name?: string; value?: string }> } {
	const rows = new Map<string, { name?: string; value?: string }>();
	const endpoint = draft.endpoint.trim();
	let endpointProblem: string | undefined;
	if (endpoint !== "") {
		try {
			const url = new URL(endpoint);
			if (url.protocol !== "https:" && url.protocol !== "http:") endpointProblem = "Use an http or https address.";
		} catch {
			endpointProblem = "Enter a full address, starting https://";
		}
	}
	const taken = new Set(
		draft.headers.filter((row) => row.kind === "saved" && row.action !== "remove").map((row) => row.name.toLowerCase()),
	);
	for (const row of draft.headers) {
		// A saved header being replaced keeps its value until a new one is typed.
		if (row.kind === "saved") continue;
		const name = row.name.trim();
		if (name === "" && row.value === "") continue;
		if (name === "") rows.set(row.id, { name: "Name the header." });
		else if (!HEADER_NAME.test(name)) rows.set(row.id, { name: "Letters, digits and dashes only." });
		else if (taken.has(name.toLowerCase())) rows.set(row.id, { name: "Already set: replace it instead." });
		else if (row.value === "") rows.set(row.id, { value: "Enter its value." });
		taken.add(name.toLowerCase());
	}
	const keys = new Set<string>();
	for (const row of draft.attributes) {
		const name = row.name.trim();
		if (name === "" && row.value === "") continue;
		if (name === "") rows.set(row.id, { name: "Name the attribute." });
		else if (keys.has(name)) rows.set(row.id, { name: "Already listed." });
		keys.add(name);
	}
	return { ...(endpointProblem === undefined ? {} : { endpoint: endpointProblem }), rows };
}

/** Only what changed from the saved settings. */
function changeOf(saved: TelemetrySettings, draft: Draft): TelemetryChange {
	const headers: Record<string, string | null> = {};
	for (const row of draft.headers) {
		if (row.kind === "saved") {
			if (row.action === "replace" && row.value !== "") headers[row.name] = row.value;
			if (row.action === "remove") headers[row.name] = null;
		} else if (row.name.trim() !== "" && row.value !== "") {
			headers[row.name.trim()] = row.value;
		}
	}
	const attributes = Object.fromEntries(
		draft.attributes.filter((row) => row.name.trim() !== "").map((row) => [row.name.trim(), row.value]),
	);
	const savedAttributes = Object.entries(saved.attributes);
	const attributesChanged =
		savedAttributes.length !== Object.keys(attributes).length ||
		savedAttributes.some(([name, value]) => attributes[name] !== value);
	const endpoint = draft.endpoint.trim();
	return {
		...(endpoint === saved.endpoint ? {} : { endpoint }),
		...(draft.protocol === saved.protocol ? {} : { protocol: draft.protocol }),
		...(draft.metrics === saved.metrics ? {} : { metrics: draft.metrics }),
		...(draft.events === saved.events ? {} : { events: draft.events }),
		...(Object.keys(headers).length === 0 ? {} : { headers }),
		...(attributesChanged ? { attributes } : {}),
	};
}

/** "12m ago", "just now". */
const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

export function TelemetryPage({ source, account, now: fixedNow }: TelemetryPageProps) {
	const { state, reload } = useLoad(() => source.get(account.id), [source, account.id]);
	const now = fixedNow ?? Date.now();
	return (
		<div className={computePage}>
			<PageHeader
				title="OpenTelemetry"
				lede="Export sandbox metrics (CPU, memory, disk, network and how many are running) and lifecycle events to any OTLP collector."
			/>
			{state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the telemetry settings.")}
				</Notice>
			) : state.status === "loading" ? (
				<TelemetrySkeleton />
			) : (
				<TelemetryForm key={state.value.accountId} initial={state.value} source={source} account={account} now={now} />
			)}
		</div>
	);
}

function TelemetrySkeleton() {
	return (
		<div className="flex max-w-content flex-col gap-4" aria-busy="true">
			<Skeleton width="40%" />
			<Skeleton lines={3} />
			<Skeleton lines={2} />
		</div>
	);
}

function TelemetryForm({
	initial,
	source,
	account,
	now,
}: {
	initial: TelemetrySettings;
	source: TelemetrySource;
	account: ComputeAccount;
	now: number;
}) {
	const [saved, setSaved] = useState(initial);
	const [draft, setDraft] = useState(() => draftOf(initial));
	const [destination, setDestination] = useState(() => destinationOf(initial.endpoint));
	const [switching, setSwitching] = useState(false);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	const destinationId = useId();
	const protocolId = useId();
	const headersId = useId();

	const problems = problemsOf(draft);
	const change = changeOf(saved, draft);
	const dirty = Object.keys(change).length > 0;
	const valid = problems.endpoint === undefined && problems.rows.size === 0;
	const edit = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

	const setEnabled = async (enabled: boolean) => {
		setSwitching(true);
		try {
			setSaved(await source.update(account.id, { enabled }));
			setNotice({ level: "info", text: enabled ? "Export is on." : "Export is off. Nothing more is sent." });
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't change that. Try again.") });
		} finally {
			setSwitching(false);
		}
	};

	const chooseDestination = (id: DestinationId) => {
		const preset = DESTINATIONS.find((entry) => entry.id === id);
		if (preset === undefined) return;
		setDestination(id);
		const presetHeaders = new Set(DESTINATIONS.map((entry) => entry.header?.toLowerCase()));
		setDraft((current) => {
			// A header row another preset added, still empty, goes; this preset's header is added if it isn't there.
			const kept = current.headers.filter(
				(row) => !(row.kind === "new" && row.value === "" && presetHeaders.has(row.name.toLowerCase())),
			);
			const has = kept.some((row) => row.name.toLowerCase() === preset.header?.toLowerCase());
			return {
				...current,
				endpoint: preset.endpoint,
				headers:
					preset.header === undefined || has
						? kept
						: [...kept, { kind: "new", id: rowId(), name: preset.header, value: "" }],
			};
		});
	};

	const save = async () => {
		if (!dirty || !valid) return;
		setSaving(true);
		try {
			const next = await source.update(account.id, change);
			setSaved(next);
			setDraft(draftOf(next));
			setNotice({ level: "info", text: "Saved." });
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't save the settings. Try again.") });
		} finally {
			setSaving(false);
		}
	};

	const sendTest = async () => {
		setTesting(true);
		try {
			const result = await source.test(account.id);
			setNotice({ level: result.ok ? "info" : "error", text: result.message });
		} catch (caught) {
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't send a test. Try again.") });
		} finally {
			setTesting(false);
		}
	};

	const setHeader = (
		id: string,
		next: Partial<{ name: string; value: string; action: "keep" | "replace" | "remove" }>,
	) => edit({ headers: draft.headers.map((row) => (row.id === id ? ({ ...row, ...next } as HeaderRow) : row)) });
	const setAttribute = (id: string, next: Partial<AttributeRow>) =>
		edit({ attributes: draft.attributes.map((row) => (row.id === id ? { ...row, ...next } : row)) });

	return (
		<form
			className="min-w-0"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<FormLayout className="max-w-content">
				<FormSection title="Export">
					<Switch
						label="Export telemetry"
						checked={saved.enabled}
						busy={switching}
						disabled={!saved.enabled && saved.endpoint === ""}
						hint={
							!saved.enabled && saved.endpoint === ""
								? "Save an endpoint first."
								: "Applies at once. Kantel sends while it's on."
						}
						onChange={(enabled) => void setEnabled(enabled)}
					/>
					<LastExport settings={saved} now={now} />
				</FormSection>
				<FormSection title="Destination" description="Where Kantel sends it, and how.">
					<FormField
						id={destinationId}
						label="Preset"
						hint="Fills in an example endpoint and the name of the header your key goes in."
					>
						<SegmentedControl
							label="Preset"
							options={DESTINATIONS.map((entry) => ({ value: entry.id, label: entry.label }))}
							value={destination}
							onChange={chooseDestination}
						/>
					</FormField>
					<TextField
						label="Endpoint"
						hint="Your collector's OTLP address."
						value={draft.endpoint}
						onChange={(event) => edit({ endpoint: event.currentTarget.value })}
						placeholder="https://otel-collector.example.com:4318"
						type="url"
						mono
						{...(problems.endpoint === undefined ? {} : { error: problems.endpoint })}
					/>
					<FormField id={protocolId} label="Protocol">
						<SegmentedControl
							label="Protocol"
							options={PROTOCOLS}
							value={draft.protocol}
							onChange={(protocol) => edit({ protocol })}
						/>
					</FormField>
					<FormField
						id={headersId}
						label="Headers"
						hint="Sent with every export, such as your key. Kantel never shows a saved value again."
					>
						<div className="flex min-w-0 flex-col gap-2">
							{draft.headers.map((row) =>
								row.kind === "saved" ? (
									<SavedHeader key={row.id} row={row} onChange={(next) => setHeader(row.id, next)} />
								) : (
									<PairRow
										key={row.id}
										what="header"
										name={row.name}
										value={row.value}
										secret
										problems={problems.rows.get(row.id)}
										onName={(name) => setHeader(row.id, { name })}
										onValue={(value) => setHeader(row.id, { value })}
										onRemove={() => edit({ headers: draft.headers.filter((each) => each.id !== row.id) })}
									/>
								),
							)}
							<div className="-ml-2">
								<Button
									size="xs"
									variant="ghost"
									icon={<PlusIcon size="sm" />}
									onClick={() =>
										edit({ headers: [...draft.headers, { kind: "new", id: rowId(), name: "", value: "" }] })
									}
								>
									Add header
								</Button>
							</div>
						</div>
					</FormField>
				</FormSection>
				<FormSection title="What to send">
					<CheckboxField
						label="Metrics"
						hint="CPU, memory, disk and network for each sandbox, and how many are running."
						checked={draft.metrics}
						onChange={(event) => edit({ metrics: event.currentTarget.checked })}
					/>
					<CheckboxField
						label="Lifecycle events"
						hint="A log record when a sandbox starts, stops, pauses, fails, recovers or is deleted."
						checked={draft.events}
						onChange={(event) => edit({ events: event.currentTarget.checked })}
					/>
				</FormSection>
				<FormSection
					title="Resource attributes"
					description="Added to everything Kantel sends, such as deployment.environment=production."
				>
					<div className="flex min-w-0 flex-col gap-2">
						{draft.attributes.map((row) => (
							<PairRow
								key={row.id}
								what="attribute"
								name={row.name}
								value={row.value}
								problems={problems.rows.get(row.id)}
								onName={(name) => setAttribute(row.id, { name })}
								onValue={(value) => setAttribute(row.id, { value })}
								onRemove={() => edit({ attributes: draft.attributes.filter((each) => each.id !== row.id) })}
							/>
						))}
						<div className="-ml-2">
							<Button
								size="xs"
								variant="ghost"
								icon={<PlusIcon size="sm" />}
								onClick={() => edit({ attributes: [...draft.attributes, { id: rowId(), name: "", value: "" }] })}
							>
								Add attribute
							</Button>
						</div>
					</div>
				</FormSection>
				{notice === undefined ? null : (
					<Notice
						level={notice.level}
						action={
							<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
								Dismiss
							</Button>
						}
					>
						{notice.text}
					</Notice>
				)}
				<FormActions>
					<Button type="submit" variant="primary" busy={saving} disabled={!dirty || !valid}>
						Save
					</Button>
					<Button busy={testing} disabled={saved.endpoint === ""} onClick={() => void sendTest()}>
						Send test
					</Button>
					{dirty ? <span className="text-xs text-muted">Send test uses the saved settings.</span> : null}
				</FormActions>
			</FormLayout>
		</form>
	);
}

/** How the last export went: when, and the collector's message if it failed. */
function LastExport({ settings, now }: { settings: TelemetrySettings; now: number }) {
	const last = settings.lastExport;
	if (last === undefined) {
		return (
			<p className="m-0 text-sm text-faint">
				{settings.endpoint === "" ? "Not set up yet." : "Nothing has been exported yet."}
			</p>
		);
	}
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span title={new Date(last.at).toLocaleString("en-GB")}>
				<StatusLabel status={last.ok ? "done" : "error"}>
					{last.ok ? `Last exported ${agoText(last.at, now)}` : `Last export failed ${agoText(last.at, now)}`}
				</StatusLabel>
			</span>
			{last.ok || last.message === undefined ? null : (
				<span className="text-xs text-muted wrap-anywhere">{last.message}</span>
			)}
		</div>
	);
}

/** A header that's set: its name and Set, with Replace and Remove. Replacing asks for the new value. */
function SavedHeader({
	row,
	onChange,
}: {
	row: Extract<HeaderRow, { kind: "saved" }>;
	onChange: (next: { action: "keep" | "replace" | "remove"; value?: string }) => void;
}) {
	const removed = row.action === "remove";
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex min-h-control-md min-w-0 flex-wrap items-center gap-2">
				<span className={`font-mono text-code ${removed ? "text-muted line-through" : "text-fg"}`}>{row.name}</span>
				{removed ? <Badge>Removed when you save</Badge> : <Badge tone="done">Set</Badge>}
				<span className="ml-auto flex items-center gap-1">
					{row.action === "keep" ? (
						<>
							<Button size="xs" variant="ghost" onClick={() => onChange({ action: "replace", value: "" })}>
								Replace
							</Button>
							<Button size="xs" variant="ghost" onClick={() => onChange({ action: "remove" })}>
								Remove
							</Button>
						</>
					) : (
						<Button size="xs" variant="ghost" onClick={() => onChange({ action: "keep", value: "" })}>
							{removed ? "Undo" : "Cancel"}
						</Button>
					)}
				</span>
			</div>
			{row.action === "replace" ? (
				<TextField
					label={`New value for ${row.name}`}
					hideLabel
					value={row.value}
					onChange={(event) => onChange({ action: "replace", value: event.currentTarget.value })}
					placeholder="New value"
					type="password"
					autoComplete="off"
					mono
				/>
			) : null}
		</div>
	);
}

/** A name and a value side by side, with a button to drop the row: a new header, or a resource attribute. */
function PairRow({
	what,
	name,
	value,
	secret = false,
	problems,
	onName,
	onValue,
	onRemove,
}: {
	what: "header" | "attribute";
	name: string;
	value: string;
	/** The value is a secret: hidden as it's typed. */
	secret?: boolean;
	problems: { name?: string; value?: string } | undefined;
	onName: (name: string) => void;
	onValue: (value: string) => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex min-w-0 items-start gap-2 max-sm:flex-wrap">
			<TextField
				className="min-w-0 flex-1 basis-40"
				label={what === "header" ? "Header name" : "Attribute key"}
				hideLabel
				value={name}
				onChange={(event) => onName(event.currentTarget.value)}
				placeholder={what === "header" ? "Authorization" : "deployment.environment"}
				mono
				{...(problems?.name === undefined ? {} : { error: problems.name })}
			/>
			<TextField
				className="min-w-0 flex-1 basis-40"
				label={name === "" ? "Value" : `Value of ${name}`}
				hideLabel
				value={value}
				onChange={(event) => onValue(event.currentTarget.value)}
				placeholder={what === "header" ? "Value" : "production"}
				mono
				{...(secret ? { type: "password", autoComplete: "off" } : {})}
				{...(problems?.value === undefined ? {} : { error: problems.value })}
			/>
			<IconButton
				label={name === "" ? `Remove this ${what}` : `Remove ${name}`}
				icon={<XIcon size="sm" />}
				variant="ghost"
				size="md"
				onClick={onRemove}
			/>
		</div>
	);
}
