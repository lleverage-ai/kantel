// The API keys page (compute console, experimental): an account's keys for the CLI, the SDKs, the MCP server and CI,
// each with its prefix, its scopes (a preset's name when they match one), who made it and when, when it was last used
// and when it expires. New key asks for a name, a preset or a custom set of scopes and an expiry, then shows the
// secret once with the commands that use it. Revoke asks first: anything using the key stops at once. Revoked keys
// stay in the list, muted, at the end. Every call goes through the `ApiKeysSource` the host binds; stories bind it to
// fixtures. Not the identity area's `ApiKeysPage`, which is a host app's own keys.

import { useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField, PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { OneTimeSecret } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	API_SCOPES,
	type ApiKey,
	type ApiKeysSource,
	type ApiScope,
	type ComputeAccount,
	type CreatedApiKey,
	expiresText,
	SCOPE_PRESETS,
} from "./compute-model.ts";
import { cellMono, cellSub, computePage, messageOf, None, TableFrame, table, tableFrame, td, th } from "./parts.tsx";

export interface ComputeApiKeysPageProps {
	readonly source: ApiKeysSource;
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Open New key when the page opens, for a story or a `?new` link. */
	readonly creating?: boolean;
	/** A key just made, with its secret showing: for a story. */
	readonly created?: CreatedApiKey;
}

/** Where this console is, which is the control plane the CLI signs in to; a placeholder outside a browser. */
const consoleOrigin = (): string => globalThis.location?.origin ?? "https://kantel.example.com";

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

/** "Agent", "3 scopes", "1 scope": a key's scopes in a cell. */
function scopesText(scopes: readonly ApiScope[]): string {
	const preset = presetOf(scopes);
	if (preset !== undefined) return preset.label;
	return scopes.length === 1 ? "1 scope" : `${scopes.length} scopes`;
}

/** Live keys newest first, then revoked ones, most recently revoked first. */
function keyOrder(a: ApiKey, b: ApiKey): number {
	const revoked = Number(a.revokedAt !== undefined) - Number(b.revokedAt !== undefined);
	if (revoked !== 0) return revoked;
	if (a.revokedAt !== undefined && b.revokedAt !== undefined) return b.revokedAt - a.revokedAt;
	return b.createdAt - a.createdAt;
}

export function ComputeApiKeysPage({
	source,
	account,
	now: fixedNow,
	creating = false,
	created: initialCreated,
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
		return [...byId.values()].sort(keyOrder);
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

	return (
		<div className={computePage}>
			<PageHeader
				title="API keys"
				lede="Keys let the CLI, the SDKs, the MCP server and CI use this account. Each key can do only what its scopes allow."
				actions={newKey}
			/>
			{created === undefined ? null : (
				<OneTimeSecret
					title={`Copy the key for ${created.key.name} now`}
					secret={created.secret}
					secretLabel="API key"
					copyLabel="Copy key"
					commands={[
						{ label: "Use it in this shell", text: `export KANTEL_API_KEY=${created.secret}` },
						// `kantel login` reads a key piped in, which keeps it out of the shell's history (packages/cli). It's the
						// installed `kantel` (kantel.dev/cli.sh, from the GitHub Release): the CLI isn't on npm, so not `npx kantel`.
						{
							label: "Or sign the CLI in with it",
							text: `printf '%s' '${created.secret}' | kantel login --key-stdin --url ${consoleOrigin()}`,
						},
					]}
					warning="Kantel shows this key only once and keeps just a hash of it. If it's lost, make a new key and revoke this one."
					onAcknowledge={() => setCreated(undefined)}
				/>
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
			) : keys.length === 0 ? (
				<EmptyState title="No API keys yet" action={newKey}>
					Make a key for the CLI, an SDK, the MCP server or CI. It gets only the scopes you choose.
				</EmptyState>
			) : (
				<KeyTable keys={keys} now={now} onRevoke={setRevoking} />
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
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2].map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		</div>
	);
}

function KeyTable({ keys, now, onRevoke }: { keys: readonly ApiKey[]; now: number; onRevoke: (key: ApiKey) => void }) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Name
						</th>
						<th className={th} scope="col">
							Key
						</th>
						<th className={th} scope="col">
							Scopes
						</th>
						<th className={th} scope="col">
							Created
						</th>
						<th className={th} scope="col">
							Last used
						</th>
						<th className={th} scope="col">
							Expires
						</th>
						<th className={th} scope="col">
							Status
						</th>
						<th className={th} scope="col">
							<span className="kt-sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{keys.map((key) => (
						<KeyRow key={key.id} apiKey={key} now={now} onRevoke={onRevoke} />
					))}
				</tbody>
			</table>
		</TableFrame>
	);
}

function KeyRow({ apiKey, now, onRevoke }: { apiKey: ApiKey; now: number; onRevoke: (key: ApiKey) => void }) {
	const revoked = apiKey.revokedAt !== undefined;
	const expired = !revoked && apiKey.expiresAt !== undefined && apiKey.expiresAt <= now;
	const muted = revoked || expired;
	return (
		<tr className={muted ? "text-muted" : undefined} data-key={apiKey.id}>
			<td className={td}>
				<span className={`block max-w-(--kt-card-width) truncate font-medium ${muted ? "text-muted" : "text-fg"}`}>
					{apiKey.name}
				</span>
			</td>
			<td className={td}>
				<span className={cellMono}>{apiKey.prefix}</span>
			</td>
			<td className={td}>
				<span className={muted ? "text-muted" : "text-fg"} title={apiKey.scopes.map(scopeLabel).join(", ")}>
					{scopesText(apiKey.scopes)}
				</span>
			</td>
			<td className={td}>
				<span className="text-muted" title={new Date(apiKey.createdAt).toLocaleString("en-GB")}>
					{compactAge(apiKey.createdAt, now)}
				</span>
				<span className={cellSub}>by {apiKey.createdBy}</span>
			</td>
			<td className={td}>
				{apiKey.lastUsedAt === undefined ? (
					<span className="text-faint">Never</span>
				) : (
					<span className="text-muted" title={new Date(apiKey.lastUsedAt).toLocaleString("en-GB")}>
						{compactAge(apiKey.lastUsedAt, now)}
					</span>
				)}
			</td>
			<td className={td}>
				{revoked ? (
					<None className="text-faint" />
				) : apiKey.expiresAt === undefined ? (
					<span className="text-muted">Never</span>
				) : (
					<span className="text-muted" title={new Date(apiKey.expiresAt).toLocaleString("en-GB")}>
						{expiresText(apiKey.expiresAt, now)}
					</span>
				)}
			</td>
			<td className={td}>
				{revoked ? (
					<Badge>Revoked</Badge>
				) : expired ? (
					<Badge>Expired</Badge>
				) : (
					<StatusLabel status="done">Active</StatusLabel>
				)}
			</td>
			<td className={`${td} w-0 text-right`}>
				{revoked ? null : (
					<Button size="xs" variant="ghost" onClick={() => onRevoke(apiKey)} aria-label={`Revoke ${apiKey.name}`}>
						Revoke
					</Button>
				)}
			</td>
		</tr>
	);
}

/**
 * New key: a name, a preset or a custom set of scopes, and when it expires. Choosing a preset ticks its scopes;
 * changing a tick makes the choice Custom.
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
		setChoice(CUSTOM);
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
			title="New API key"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						Create key
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name"
					hint="Say where it's used, so you know what stops if you revoke it."
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="GitHub Actions"
					required
				/>
				<FormField id={scopesId} label="Scopes">
					<SegmentedControl
						label="Scope preset"
						options={[
							...SCOPE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
							{ value: CUSTOM, label: "Custom" },
						]}
						value={choice}
						onChange={choose}
					/>
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
						Revoke key
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
