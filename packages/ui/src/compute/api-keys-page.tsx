// The API keys page (compute console, under Settings): an account's keys for the CLI, the SDKs, the MCP server and CI.
// Each row has the key's name and prefix, its access (a preset's name when the scopes match one), when it was last used,
// when it expires and who made it, and Revoke in its ⋯. Revoked keys fold away under "N revoked". New key asks for a
// name, the access and an expiry, then shows the secret once in a dialog that only Done closes. A phone gets two-line
// rows. Every call goes through the `ApiKeysSource` the host binds; stories bind it to fixtures. Not the identity area's
// `ApiKeysPage`, which is a host app's own keys.

import { useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { ChevronRightIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { CommandBlock } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	API_SCOPES,
	type ApiKey,
	type ApiKeysSource,
	type ApiScope,
	type ComputeAccount,
	type CreatedApiKey,
	SCOPE_PRESETS,
	untilText,
} from "./compute-model.ts";
import { computePage, MetaPair, messageOf, table, tableFrame } from "./parts.tsx";
import { SettingsPageHeader } from "./settings-nav.tsx";

export interface ComputeApiKeysPageProps {
	readonly source: ApiKeysSource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Open New key when the page opens, for a story or a `?new` link. */
	readonly creating?: boolean;
	/** A key just made, with its secret showing: for a story. */
	readonly created?: CreatedApiKey;
	/** A phone: two-line rows instead of the table. */
	readonly narrow?: boolean;
	/** Show the revoked keys unfolded, for a story. */
	readonly revokedOpen?: boolean;
}

const EXPIRY_CHOICES = [
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "365", label: "1 year" },
	{ value: "never", label: "Never" },
] as const;

/** A preset's id, or `custom` for any other set of scopes. */
type ScopeChoice = string;
const CUSTOM: ScopeChoice = "custom";

const sameScopes = (a: readonly ApiScope[], b: readonly ApiScope[]): boolean =>
	a.length === b.length && a.every((scope) => b.includes(scope));

/** The preset a set of scopes is exactly, if any. */
const presetOf = (scopes: readonly ApiScope[]) => SCOPE_PRESETS.find((preset) => sameScopes(preset.scopes, scopes));

const scopeLabel = (scope: ApiScope): string => API_SCOPES.find((entry) => entry.scope === scope)?.label ?? scope;

/** "Agent", "3 scopes", "1 scope": what a key may do, in a cell. */
function accessText(scopes: readonly ApiScope[]): string {
	const preset = presetOf(scopes);
	if (preset !== undefined) return preset.label;
	return scopes.length === 1 ? "1 scope" : `${scopes.length} scopes`;
}

/** Newest first; revoked keys most recently revoked first. */
function keyOrder(a: ApiKey, b: ApiKey): number {
	if (a.revokedAt !== undefined && b.revokedAt !== undefined) return b.revokedAt - a.revokedAt;
	return b.createdAt - a.createdAt;
}

/** A date for a cell's tooltip. */
const when = (at: number): string => new Date(at).toLocaleString("en-GB");

export function ComputeApiKeysPage({
	source,
	account,
	now: fixedNow,
	creating = false,
	created: initialCreated,
	narrow = false,
	revokedOpen = false,
}: ComputeApiKeysPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	// Keys made or revoked here, ahead of the next read.
	const [local, setLocal] = useState<ReadonlyMap<string, ApiKey>>(
		() => new Map(initialCreated === undefined ? [] : [[initialCreated.key.id, initialCreated.key]]),
	);
	const [newOpen, setNewOpen] = useState(creating);
	const [created, setCreated] = useState<CreatedApiKey | undefined>(initialCreated);
	const [revoking, setRevoking] = useState<ApiKey>();
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	const now = fixedNow ?? Date.now();

	const listed = state.status === "ready" ? state.value : undefined;
	const keys = useMemo(() => {
		if (listed === undefined) return undefined;
		const byId = new Map(listed.map((key) => [key.id, key]));
		for (const [id, key] of local) byId.set(id, key);
		const all = [...byId.values()].sort(keyOrder);
		return {
			live: all.filter((key) => key.revokedAt === undefined),
			revoked: all.filter((key) => key.revokedAt !== undefined),
		};
	}, [listed, local]);

	const keep = (key: ApiKey) => {
		setLocal((current) => new Map(current).set(key.id, key));
		reload();
	};

	const newKey = (
		<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setNewOpen(true)}>
			New key
		</Button>
	);
	const empty = keys !== undefined && keys.live.length === 0 && keys.revoked.length === 0;

	return (
		<div className={computePage}>
			<SettingsPageHeader title="API keys" actions={empty ? undefined : newKey} narrow={narrow} />
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
			{state.status === "error" && keys === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the API keys.")}
				</Notice>
			) : keys === undefined ? (
				<KeysSkeleton />
			) : empty ? (
				<EmptyState title="No API keys yet" action={newKey}>
					For the CLI, an SDK, the MCP server or CI.
				</EmptyState>
			) : (
				<KeyList
					live={keys.live}
					revoked={keys.revoked}
					now={now}
					narrow={narrow}
					revokedOpen={revokedOpen}
					onRevoke={setRevoking}
				/>
			)}
			{newOpen ? (
				<NewKeyDialog
					onClose={() => setNewOpen(false)}
					onCreate={async (input) => {
						const made = await source.create({ accountId: account.id, ...input });
						setNewOpen(false);
						setCreated(made);
						keep(made.key);
					}}
				/>
			) : null}
			{created === undefined ? null : <CreatedDialog created={created} onDone={() => setCreated(undefined)} />}
			<RevokeDialog
				apiKey={revoking}
				onClose={() => setRevoking(undefined)}
				onRevoke={async (key) => {
					keep(await source.revoke(key.id));
					setNotice({ level: "info", text: `Revoked ${key.name}.` });
				}}
			/>
		</div>
	);
}

function KeysSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-2" aria-busy="true">
			{[0, 1, 2].map((row) => (
				<Skeleton key={row} />
			))}
		</div>
	);
}

/** The table: no frame round it, a hairline under the head and under every row. */
const head = "h-control-md border-b border-border px-2 py-0 text-sm font-medium whitespace-nowrap text-muted";
const cell = "border-b border-border px-2 py-2.5 align-middle whitespace-nowrap";

/** The live keys, then the revoked ones folded under a toggle. */
function KeyList({
	live,
	revoked,
	now,
	narrow,
	revokedOpen,
	onRevoke,
}: {
	live: readonly ApiKey[];
	revoked: readonly ApiKey[];
	now: number;
	narrow: boolean;
	revokedOpen: boolean;
	onRevoke: (key: ApiKey) => void;
}) {
	const [open, setOpen] = useState(revokedOpen);
	const foldId = useId();
	const fold =
		revoked.length === 0 ? null : (
			<button
				type="button"
				className="kt-focusable -ml-2 inline-flex cursor-pointer items-center gap-1.5 rounded-control border-0 bg-transparent px-2 py-1 text-sm text-muted hover:bg-hover hover:text-fg"
				aria-expanded={open}
				aria-controls={foldId}
				onClick={() => setOpen((was) => !was)}
			>
				<ChevronRightIcon size="sm" className={`transition-transform ${open ? "rotate-90" : ""}`} />
				{revoked.length} revoked
			</button>
		);
	if (narrow) {
		// One card, as on a wide screen: the live keys, then the revoked ones' fold as the card's last row, and the revoked
		// keys under it when it's open.
		return (
			<ul className="kt-key-rows m-0 flex list-none flex-col rounded-panel border border-border bg-raised p-0">
				{live.map((key) => (
					<KeyPhoneRow key={key.id} apiKey={key} now={now} onRevoke={onRevoke} />
				))}
				{fold === null ? null : <li className="border-b border-border px-3 py-2 last:border-b-0">{fold}</li>}
				{fold !== null && open ? (
					<li className="p-0">
						<ul id={foldId} className="kt-key-rows m-0 flex list-none flex-col p-0">
							{revoked.map((key) => (
								<KeyPhoneRow key={key.id} apiKey={key} now={now} onRevoke={onRevoke} />
							))}
						</ul>
					</li>
				) : null}
			</ul>
		);
	}

	return (
		<div className={tableFrame}>
			<table className={table}>
				<thead>
					<tr>
						<th className={head} scope="col">
							Name
						</th>
						<th className={head} scope="col">
							Access
						</th>
						<th className={head} scope="col">
							Last used
						</th>
						<th className={head} scope="col">
							Expires
						</th>
						<th className={head} scope="col">
							Created by
						</th>
						<th className={head} scope="col">
							<span className="kt-sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{live.map((key) => (
						<KeyRow key={key.id} apiKey={key} now={now} onRevoke={onRevoke} />
					))}
				</tbody>
				{fold === null ? null : (
					<tbody id={foldId}>
						<tr>
							{/* Its own row under a hairline, as the phone card's fold is: the last live row drops its own. */}
							<td className="border-t border-border py-1.5" colSpan={6}>
								{fold}
							</td>
						</tr>
						{open ? revoked.map((key) => <KeyRow key={key.id} apiKey={key} now={now} onRevoke={onRevoke} />) : null}
					</tbody>
				)}
			</table>
		</div>
	);
}

/** A key's state for its Expires cell: "in 69 days", "Never", "Expired" or "Revoked 3d ago". */
function expiry(apiKey: ApiKey, now: number): { text: string; title?: string; done: boolean } {
	if (apiKey.revokedAt !== undefined) {
		return { text: `Revoked ${compactAge(apiKey.revokedAt, now)} ago`, title: when(apiKey.revokedAt), done: true };
	}
	if (apiKey.expiresAt === undefined) return { text: "Never", done: false };
	const left = untilText(apiKey.expiresAt, now);
	return { text: left ?? "Expired", title: when(apiKey.expiresAt), done: left === undefined };
}

/** Revoke, in the row's ⋯; a revoked key has none, but keeps the room so rows line up. */
function KeyMenu({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (key: ApiKey) => void }) {
	return (
		<span className="flex h-control-xs w-control-xs flex-none items-center justify-end pointer-coarse:h-control-lg pointer-coarse:w-control-lg">
			{apiKey.revokedAt === undefined ? (
				<Menu
					label={`Actions for ${apiKey.name}`}
					icon={<EllipsisIcon />}
					align="end"
					entries={[
						{
							kind: "item",
							id: "revoke",
							label: "Revoke",
							icon: <TrashIcon />,
							danger: true,
							onSelect: () => onRevoke(apiKey),
						},
					]}
				/>
			) : null}
		</span>
	);
}

function KeyRow({ apiKey, now, onRevoke }: { apiKey: ApiKey; now: number; onRevoke: (key: ApiKey) => void }) {
	const ends = expiry(apiKey, now);
	const muted = apiKey.revokedAt !== undefined || ends.done;
	return (
		<tr className={`kt-key-row [&>td]:align-baseline ${muted ? "text-muted" : "text-fg"}`} data-key={apiKey.id}>
			<td className={cell}>
				<span className={`block max-w-(--kt-popover-width) truncate font-medium ${muted ? "text-muted" : "text-fg"}`}>
					{apiKey.name}
				</span>
				<span className="block font-mono text-code text-muted">{apiKey.prefix}…</span>
			</td>
			<td className={cell}>
				<span title={apiKey.scopes.map(scopeLabel).join(", ")}>{accessText(apiKey.scopes)}</span>
			</td>
			<td className={cell}>
				{apiKey.lastUsedAt === undefined ? (
					<span className="text-faint">Never</span>
				) : (
					<span className="text-muted" title={when(apiKey.lastUsedAt)}>
						{compactAge(apiKey.lastUsedAt, now)} ago
					</span>
				)}
			</td>
			<td className={cell}>
				<span className="text-muted" title={ends.title}>
					{ends.text}
				</span>
			</td>
			<td className={cell}>
				<span className="text-muted" title={`Created ${when(apiKey.createdAt)}`}>
					{apiKey.createdBy}
				</span>
			</td>
			<td className={`${cell} w-0 text-right`}>
				<KeyMenu apiKey={apiKey} onRevoke={onRevoke} />
			</td>
		</tr>
	);
}

/** A phone's row: the name, then its access, when it was last used and when it expires; ⋯ at the end. */
function KeyPhoneRow({ apiKey, now, onRevoke }: { apiKey: ApiKey; now: number; onRevoke: (key: ApiKey) => void }) {
	const ends = expiry(apiKey, now);
	const muted = apiKey.revokedAt !== undefined || ends.done;
	const ending =
		apiKey.revokedAt !== undefined
			? { label: "Revoked", value: `${compactAge(apiKey.revokedAt, now)} ago` }
			: apiKey.expiresAt === undefined
				? { label: "Expires", value: "Never" }
				: ends.done
					? { label: "Expired", value: `${compactAge(apiKey.expiresAt, now)} ago` }
					: { label: "Expires", value: ends.text };
	return (
		<li
			className="kt-key-row flex min-w-0 flex-col gap-1 border-b border-border px-3 py-3 last:border-b-0"
			data-key={apiKey.id}
		>
			{/* The name with its menu on one line, so the action sits with what it acts on. */}
			<div className="flex min-w-0 items-center gap-2">
				<span className={`min-w-0 flex-1 truncate text-md font-medium ${muted ? "text-muted" : "text-fg"}`}>
					{apiKey.name}
				</span>
				<span className="-my-1 -mr-1">
					<KeyMenu apiKey={apiKey} onRevoke={onRevoke} />
				</span>
			</div>
			<span className="font-mono text-code text-muted">{apiKey.prefix}…</span>
			{/* Two fixed lines on every card, so the cards share one shape: what it may do and when it ends, then when it was
			    last used and who made it. */}
			<div className="flex min-w-0 flex-col gap-1 text-sm">
				{/* Each line its own list, so every name and value pair sits directly in a dl; two equal columns, so the same
				    fact sits in the same place on every card. */}
				<dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4">
					<MetaPair label="Access">{accessText(apiKey.scopes)}</MetaPair>
					<MetaPair label={ending.label} title={ends.title}>
						{ending.value}
					</MetaPair>
				</dl>
				<dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4">
					<MetaPair label="Used">
						{apiKey.lastUsedAt === undefined ? "Never" : `${compactAge(apiKey.lastUsedAt, now)} ago`}
					</MetaPair>
					{apiKey.createdBy === "" ? null : <MetaPair label="By">{apiKey.createdBy}</MetaPair>}
				</dl>
			</div>
		</li>
	);
}

/** The key just made, once: its secret and the line that uses it. Only Done closes it, so a stray click can't lose it. */
function CreatedDialog({ created, onDone }: { created: CreatedApiKey; onDone: () => void }) {
	return (
		<Dialog
			open
			title="Copy your key"
			onClose={() => {}}
			actions={
				<Button variant="primary" onClick={onDone}>
					Done
				</Button>
			}
		>
			<div className="flex w-full min-w-0 flex-col gap-3 pt-1">
				<CommandBlock command={created.secret} copyLabel="Copy" />
				<p className="m-0 text-sm text-muted">You won't see it again.</p>
				<CommandBlock label="Use it" command={`export KANTEL_API_KEY=${created.secret}`} />
			</div>
		</Dialog>
	);
}

/**
 * New key: a name, what it may do (a preset, or Custom with a tick per scope) and when it expires. A preset lists its
 * scopes in a line; Custom keeps them and shows the ticks.
 */
function NewKeyDialog({
	onClose,
	onCreate,
}: {
	onClose: () => void;
	onCreate: (input: { name: string; scopes: readonly ApiScope[]; expiresInDays?: number }) => Promise<void>;
}) {
	const scopesId = useId();
	const [name, setName] = useState("");
	const [choice, setChoice] = useState<ScopeChoice>("agent");
	const [scopes, setScopes] = useState<readonly ApiScope[]>(
		() => SCOPE_PRESETS.find((preset) => preset.id === "agent")?.scopes ?? [],
	);
	const [expiry, setExpiry] = useState("90");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const valid = name.trim() !== "" && scopes.length > 0;

	const choose = (value: ScopeChoice) => {
		setChoice(value);
		const preset = SCOPE_PRESETS.find((entry) => entry.id === value);
		if (preset !== undefined) setScopes(preset.scopes);
	};
	const tick = (scope: ApiScope, on: boolean) => {
		// Kept in the order API_SCOPES lists them.
		setScopes((current) =>
			API_SCOPES.map((entry) => entry.scope).filter((each) => (each === scope ? on : current.includes(each))),
		);
	};
	const submit = () => {
		if (!valid || busy) return;
		setBusy(true);
		setFailure(undefined);
		onCreate({
			name: name.trim(),
			scopes,
			...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
		}).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't make the key. Try again."));
			},
		);
	};

	return (
		<Dialog
			open
			title="New key"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						Create
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name"
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="GitHub Actions"
					required
				/>
				<FormField id={scopesId} label="Access">
					<SegmentedControl
						label="Access"
						options={[
							...SCOPE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
							{ value: CUSTOM, label: "Custom" },
						]}
						value={choice}
						onChange={choose}
					/>
					{choice === CUSTOM ? (
						<div className="flex flex-col gap-2 pt-2">
							{API_SCOPES.map((entry) => (
								<CheckboxField
									key={entry.scope}
									label={entry.label}
									hint={entry.help}
									checked={scopes.includes(entry.scope)}
									onChange={(event) => tick(entry.scope, event.currentTarget.checked)}
								/>
							))}
						</div>
					) : (
						<p className="m-0 pt-1 text-sm text-muted">{scopes.map(scopeLabel).join(", ")}.</p>
					)}
				</FormField>
				<SelectField
					label="Expires"
					value={expiry}
					onChange={(event) => setExpiry(event.currentTarget.value)}
					options={EXPIRY_CHOICES}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function RevokeDialog({
	apiKey,
	onClose,
	onRevoke,
}: {
	apiKey: ApiKey | undefined;
	onClose: () => void;
	onRevoke: (key: ApiKey) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={apiKey !== undefined}
			title="Revoke this key?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (apiKey === undefined) return;
							setBusy(true);
							onRevoke(apiKey).then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't revoke it. Try again."));
								},
							);
						}}
					>
						Revoke
					</Button>
				</>
			}
		>
			<p>
				Anything that uses <strong>{apiKey?.name}</strong> stops working at once. This can't be undone.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
