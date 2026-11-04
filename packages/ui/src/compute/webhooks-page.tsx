// The Webhooks page (compute console, experimental): the endpoints Kantel posts an account's sandbox events to, each
// with its URL, the events it gets, an Enabled switch that applies at once and how its last delivery went. Opening an
// endpoint shows its recent deliveries; its menu sends a test event, edits or deletes it. Add endpoint shows the
// signing secret once. Every call goes through the `WebhooksSource` the host binds; stories bind it to fixtures.

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { ChevronRightIcon, PencilIcon, PlusIcon, SendIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { OneTimeSecret } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import {
	type ComputeAccount,
	type CreatedWebhook,
	WEBHOOK_EVENTS,
	type Webhook,
	type WebhookDelivery,
	type WebhookEvent,
	type WebhooksSource,
} from "./compute-model.ts";
import { cellMono, cellSub, computePage, messageOf, TableFrame, table, tableFrame, td, th } from "./parts.tsx";
import { SettingsPageHeader } from "./settings-nav.tsx";

export interface WebhooksPageProps {
	readonly source: WebhooksSource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** The endpoint whose deliveries show when the page opens, by id. */
	readonly initialOpen?: string;
}

type NoticeSetter = (notice: { level: "info" | "error"; text: string } | undefined) => void;

const eventLabel = (event: WebhookEvent): string =>
	WEBHOOK_EVENTS.find((entry) => entry.event === event)?.label ?? event;

/** "143 ms", "10.0 s": how long a delivery took. */
const tookText = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** "12m ago", "just now". */
const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

/** A delivery's answer: its HTTP status, or that nothing answered. */
const answerText = (delivery: WebhookDelivery): string =>
	delivery.status === undefined ? "No answer" : String(delivery.status);

/** An endpoint's host, for a heading: `hooks.example.com`. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** An endpoint must be https, with a host. */
function urlError(url: string): string | undefined {
	if (url.trim() === "") return undefined;
	try {
		const parsed = new URL(url.trim());
		return parsed.protocol === "https:" && parsed.hostname !== "" ? undefined : "Use an https address.";
	} catch {
		return "Enter a full address, starting https://";
	}
}

export function WebhooksPage({ source, account, now: fixedNow, initialOpen }: WebhooksPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	// Endpoints made, changed or deleted here, ahead of the next read.
	const [local, setLocal] = useState<ReadonlyMap<string, Webhook | null>>(new Map());
	const [open, setOpen] = useState<string | undefined>(initialOpen);
	const [editing, setEditing] = useState<Webhook | "new">();
	const [deleting, setDeleting] = useState<Webhook>();
	const [created, setCreated] = useState<CreatedWebhook>();
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	const now = fixedNow ?? Date.now();

	const listed = state.status === "ready" ? state.value : undefined;
	const webhooks = useMemo(() => {
		if (listed === undefined) return undefined;
		const byId = new Map(listed.map((hook) => [hook.id, hook]));
		for (const [id, hook] of local) {
			if (hook === null) byId.delete(id);
			else byId.set(id, hook);
		}
		return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
	}, [listed, local]);

	const change = (hook: Webhook | null, id: string) => {
		setLocal((current) => new Map(current).set(id, hook));
		reload();
	};

	const addButton = (
		<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setEditing("new")}>
			Add endpoint
		</Button>
	);

	return (
		<div className={computePage}>
			<SettingsPageHeader title="Webhooks" actions={addButton} />
			{created === undefined ? null : (
				<OneTimeSecret
					title={`Copy the signing secret for ${hostOf(created.webhook.url)} now`}
					secret={created.secret}
					secretLabel="Signing secret"
					copyLabel="Copy secret"
					warning="Kantel shows this secret only once. If it's lost, delete the endpoint and add it again."
					onAcknowledge={() => setCreated(undefined)}
				>
					<p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted">
						<span>
							Deliveries are signed as Standard Webhooks are: check the{" "}
							<code className="font-mono text-code text-fg">webhook-signature</code> header with this secret, or use any
							Standard Webhooks library.
						</span>
					</p>
				</OneTimeSecret>
			)}
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
			{state.status === "error" && webhooks === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the webhooks.")}
				</Notice>
			) : webhooks === undefined ? (
				<WebhooksSkeleton />
			) : webhooks.length === 0 ? (
				<EmptyState title="No webhooks yet" action={addButton}>
					Add an endpoint to hear when a sandbox starts, stops, fails or is deleted, or when a snapshot is saved.
				</EmptyState>
			) : (
				<TableFrame>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Endpoint
								</th>
								<th className={th} scope="col">
									Events
								</th>
								<th className={th} scope="col">
									Last delivery
								</th>
								<th className={th} scope="col">
									Enabled
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{webhooks.map((hook) => (
								<Fragment key={hook.id}>
									<WebhookRow
										webhook={hook}
										now={now}
										source={source}
										open={open === hook.id}
										onToggle={() => setOpen((current) => (current === hook.id ? undefined : hook.id))}
										onChange={change}
										onNotice={setNotice}
										onEdit={setEditing}
										onDelete={setDeleting}
									/>
									{open === hook.id ? (
										<tr>
											<td className={`${td} bg-sunken`} colSpan={5} id={`deliveries-${hook.id}`}>
												<Deliveries webhook={hook} source={source} now={now} />
											</td>
										</tr>
									) : null}
								</Fragment>
							))}
						</tbody>
					</table>
				</TableFrame>
			)}
			{editing === undefined ? null : (
				<WebhookDialog
					webhook={editing === "new" ? undefined : editing}
					onClose={() => setEditing(undefined)}
					onSave={async (input) => {
						if (editing === "new") {
							const made = await source.create({ accountId: account.id, ...input });
							setCreated(made);
							change(made.webhook, made.webhook.id);
						} else {
							change(await source.update(editing.id, input), editing.id);
							setNotice({ level: "info", text: `Saved ${input.url}.` });
						}
						setEditing(undefined);
					}}
				/>
			)}
			<DeleteDialog
				webhook={deleting}
				onClose={() => setDeleting(undefined)}
				onDelete={async (hook) => {
					await source.remove(hook.id);
					change(null, hook.id);
					setNotice({ level: "info", text: `Deleted ${hook.url}. It gets no more events.` });
				}}
			/>
		</div>
	);
}

function WebhooksSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1].map((row) => (
					<Skeleton key={row} lines={2} />
				))}
			</div>
		</div>
	);
}

function WebhookRow({
	webhook,
	now,
	source,
	open,
	onToggle,
	onChange,
	onNotice,
	onEdit,
	onDelete,
}: {
	webhook: Webhook;
	now: number;
	source: WebhooksSource;
	open: boolean;
	onToggle: () => void;
	onChange: (hook: Webhook | null, id: string) => void;
	onNotice: NoticeSetter;
	onEdit: (hook: Webhook) => void;
	onDelete: (hook: Webhook) => void;
}) {
	const [saving, setSaving] = useState(false);
	const all = WEBHOOK_EVENTS.every((entry) => webhook.events.includes(entry.event));
	const last = webhook.lastDelivery;

	const setEnabled = async (enabled: boolean) => {
		setSaving(true);
		// The switch moves at once; a failure puts it back.
		onChange({ ...webhook, enabled }, webhook.id);
		try {
			onChange(await source.update(webhook.id, { enabled }), webhook.id);
		} catch (caught) {
			onChange(webhook, webhook.id);
			onNotice({ level: "error", text: messageOf(caught, `Kantel couldn't change ${webhook.url}. Try again.`) });
		} finally {
			setSaving(false);
		}
	};
	const sendTest = async () => {
		try {
			const sent = await source.test(webhook.id);
			onChange({ ...webhook, lastDelivery: sent }, webhook.id);
			const answer =
				sent.status === undefined
					? `${webhook.url} didn't answer within ${tookText(sent.durationMs)}.`
					: `${webhook.url} answered ${sent.status} in ${tookText(sent.durationMs)}.`;
			onNotice({ level: sent.ok ? "info" : "error", text: `Sent a test event. ${answer}` });
		} catch (caught) {
			onNotice({ level: "error", text: messageOf(caught, "Kantel couldn't send a test event. Try again.") });
		}
	};

	const entries: MenuEntry[] = [
		{
			kind: "item",
			id: "test",
			label: "Send test event",
			icon: <SendIcon size="sm" />,
			onSelect: () => void sendTest(),
		},
		{ kind: "item", id: "edit", label: "Edit", icon: <PencilIcon size="sm" />, onSelect: () => onEdit(webhook) },
		{ kind: "separator", id: "sep-delete" },
		{
			kind: "item",
			id: "delete",
			label: "Delete",
			icon: <TrashIcon />,
			danger: true,
			onSelect: () => onDelete(webhook),
		},
	];

	return (
		<tr data-webhook={webhook.id} className={open ? "bg-hover" : undefined} data-row={open ? "open" : undefined}>
			<td className={td}>
				<button
					type="button"
					className="kt-focusable -ml-1 flex min-w-0 max-w-full cursor-pointer items-start gap-1 rounded-sm border-0 bg-transparent p-1 text-left"
					aria-expanded={open}
					aria-controls={open ? `deliveries-${webhook.id}` : undefined}
					onClick={onToggle}
				>
					<ChevronRightIcon
						size="sm"
						className={`mt-0.5 flex-none text-faint transition-transform ${open ? "rotate-90" : ""}`}
					/>
					<span className="flex min-w-0 flex-col">
						<span className="block max-w-(--kt-card-width) truncate font-mono text-code text-fg">{webhook.url}</span>
						{webhook.description === undefined ? null : <span className={cellSub}>{webhook.description}</span>}
					</span>
				</button>
			</td>
			<td className={td}>
				<span className="flex max-w-(--kt-popover-width) flex-wrap gap-1">
					{all ? (
						<Badge>All events</Badge>
					) : (
						webhook.events.map((event) => (
							<span key={event} title={eventLabel(event)}>
								<Badge>{event}</Badge>
							</span>
						))
					)}
				</span>
			</td>
			<td className={td}>
				{last === undefined ? (
					<span className="text-faint">None yet</span>
				) : (
					<>
						<StatusLabel status={last.ok ? "done" : "error"}>{last.ok ? "Delivered" : "Failed"}</StatusLabel>
						<span className={cellSub}>
							{answerText(last)}, {agoText(last.at, now)}
						</span>
					</>
				)}
			</td>
			<td className={td}>
				<Switch
					label={`Send events to ${webhook.url}`}
					hideLabel
					checked={webhook.enabled}
					busy={saving}
					onChange={(enabled) => void setEnabled(enabled)}
				/>
			</td>
			<td className={`${td} w-0 text-right`}>
				<Menu label={`Actions for ${webhook.url}`} icon={<EllipsisIcon />} entries={entries} align="end" />
			</td>
		</tr>
	);
}

/** An endpoint's recent deliveries, read when it opens and again after a test event. */
function Deliveries({ webhook, source, now }: { webhook: Webhook; source: WebhooksSource; now: number }) {
	const { state, reload } = useLoad(() => source.deliveries(webhook.id), [source, webhook.id]);
	// A new last delivery (a test event) means a new list.
	const lastId = webhook.lastDelivery?.id;
	const seenLast = useRef(lastId);
	useEffect(() => {
		if (seenLast.current === lastId) return;
		seenLast.current = lastId;
		reload();
	}, [lastId, reload]);

	if (state.status === "loading") return <Skeleton lines={3} />;
	if (state.status === "error") {
		return (
			<Notice
				level="error"
				action={
					<Button size="xs" onClick={reload}>
						Try again
					</Button>
				}
			>
				{messageOf(state.error, "Kantel couldn't read the deliveries.")}
			</Notice>
		);
	}
	if (state.value.length === 0) {
		return <p className="m-0 py-1 text-sm text-muted">Nothing has been sent to this endpoint yet.</p>;
	}
	return (
		<div className="flex min-w-0 flex-col gap-2 py-1">
			<span className="text-xs font-medium text-muted">Recent deliveries</span>
			<TableFrame>
				<table className={table}>
					<thead>
						<tr>
							<th className={th} scope="col">
								Event
							</th>
							<th className={th} scope="col">
								When
							</th>
							<th className={th} scope="col">
								Status
							</th>
							<th className={`${th} text-right`} scope="col">
								Duration
							</th>
							<th className={`${th} text-right`} scope="col">
								Attempt
							</th>
						</tr>
					</thead>
					<tbody>
						{state.value.map((delivery) => (
							<tr key={delivery.id}>
								<td className={td}>
									<span className={cellMono} title={eventLabel(delivery.event)}>
										{delivery.event}
									</span>
								</td>
								<td className={td}>
									<span className="text-muted" title={new Date(delivery.at).toLocaleString("en-GB")}>
										{agoText(delivery.at, now)}
									</span>
								</td>
								<td className={td}>
									<StatusLabel status={delivery.ok ? "done" : "error"}>{answerText(delivery)}</StatusLabel>
								</td>
								<td className={`${td} text-right text-muted tabular-nums`}>{tookText(delivery.durationMs)}</td>
								<td className={`${td} text-right text-muted tabular-nums`}>{delivery.attempt}</td>
							</tr>
						))}
					</tbody>
				</table>
			</TableFrame>
		</div>
	);
}

/** Add endpoint and Edit: an https URL, a description and the events it gets. */
function WebhookDialog({
	webhook,
	onClose,
	onSave,
}: {
	webhook: Webhook | undefined;
	onClose: () => void;
	onSave: (input: { url: string; description: string; events: readonly WebhookEvent[] }) => Promise<void>;
}) {
	const eventsId = useId();
	const [url, setUrl] = useState(webhook?.url ?? "");
	const [description, setDescription] = useState(webhook?.description ?? "");
	const [events, setEvents] = useState<readonly WebhookEvent[]>(
		webhook?.events ?? ["sandbox.running", "sandbox.stopped", "sandbox.error"],
	);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const badUrl = urlError(url);
	const valid = url.trim() !== "" && badUrl === undefined && events.length > 0;
	const all = events.length === WEBHOOK_EVENTS.length;

	// Kept in the order WEBHOOK_EVENTS lists them.
	const tick = (event: WebhookEvent, on: boolean) =>
		setEvents((current) =>
			WEBHOOK_EVENTS.map((entry) => entry.event).filter((each) => (each === event ? on : current.includes(each))),
		);
	const submit = () => {
		if (!valid || busy) return;
		setBusy(true);
		setFailure(undefined);
		onSave({ url: url.trim(), description: description.trim(), events }).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't save the endpoint. Try again."));
			},
		);
	};

	return (
		<Dialog
			open
			title={webhook === undefined ? "Add endpoint" : "Edit endpoint"}
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						{webhook === undefined ? "Add endpoint" : "Save"}
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="URL"
					value={url}
					onChange={(event) => setUrl(event.currentTarget.value)}
					placeholder="https://example.com/hooks/kantel"
					type="url"
					mono
					required
					{...(badUrl === undefined ? {} : { error: badUrl })}
				/>
				<TextField
					label="Description"
					hint="Optional. Who or what listens here."
					value={description}
					onChange={(event) => setDescription(event.currentTarget.value)}
					placeholder="Alerts channel"
				/>
				<FormField id={eventsId} label="Events">
					<div className="flex flex-col gap-2">
						<CheckboxField
							label="All events"
							checked={all}
							onChange={(event) =>
								setEvents(event.currentTarget.checked ? WEBHOOK_EVENTS.map((entry) => entry.event) : [])
							}
						/>
						<div className="flex flex-col gap-2 border-l border-border pl-3">
							{WEBHOOK_EVENTS.map((entry) => (
								<CheckboxField
									key={entry.event}
									label={entry.label}
									hint={entry.event}
									checked={events.includes(entry.event)}
									onChange={(event) => tick(entry.event, event.currentTarget.checked)}
								/>
							))}
						</div>
					</div>
				</FormField>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function DeleteDialog({
	webhook,
	onClose,
	onDelete,
}: {
	webhook: Webhook | undefined;
	onClose: () => void;
	onDelete: (hook: Webhook) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={webhook !== undefined}
			title="Delete this endpoint?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (webhook === undefined) return;
							setBusy(true);
							onDelete(webhook).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete it. Try again."));
								},
							);
						}}
					>
						Delete
					</Button>
				</>
			}
		>
			<p>
				<strong className="wrap-anywhere">{webhook?.url}</strong> gets no more events, and its delivery history goes.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
