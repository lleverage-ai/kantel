// Personal access tokens (compute console, under Profile): the person's own credentials for the command line and
// their scripts, which act as them in every account they belong to, or only the ones a token names. `kantel login`
// makes one when it is approved; New token makes one for a script, its secret shown once. Each row has the token's name
// and prefix, what it may do, where, when it was last used and when it expires, and Revoke in its ⋯. Revoked tokens are
// left out. A phone gets two-line rows. Every call goes through the `PersonalTokensSource` the host binds; stories bind
// it to fixtures.

import { useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { CommandBlock } from "../primitives/one-time-secret.tsx";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import {
	type ApiScope,
	type ComputeAccount,
	type CreatedPersonalToken,
	type PersonalToken,
	type PersonalTokensSource,
	SCOPE_PRESETS,
	untilText,
} from "./compute-model.ts";
import { MetaPair, messageOf, SectionHeading, table, tableFrame } from "./parts.tsx";

export interface PersonalTokensSectionProps {
	readonly source: PersonalTokensSource;
	/** The person's accounts, to name the ones a token is limited to and to pick from. */
	readonly accounts: readonly ComputeAccount[];
	/** A fixed time, for stories. */
	readonly now?: number;
	/** A phone: two-line rows instead of the table. */
	readonly narrow?: boolean;
	/** Open New token when the section shows, for a story. */
	readonly creating?: boolean;
	/** A token just made, with its secret showing: for a story. */
	readonly created?: CreatedPersonalToken;
}

/** What New token offers: whatever your role allows, or one of the presets but admin (which is the same). */
const ACCESS_CHOICES = [
	{ value: "full", label: "Your role" },
	...SCOPE_PRESETS.filter((preset) => preset.id !== "admin").map((preset) => ({
		value: preset.id,
		label: preset.label,
	})),
];

const EXPIRY_CHOICES = [
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
	{ value: "366", label: "1 year" },
] as const;

const sameScopes = (a: readonly ApiScope[], b: readonly ApiScope[]): boolean =>
	a.length === b.length && a.every((scope) => b.includes(scope));

/** "Your role", "Agent", "3 scopes": what a token may do, in a cell. */
function accessText(scopes: readonly ApiScope[] | undefined): string {
	if (scopes === undefined) return "Your role";
	const preset = SCOPE_PRESETS.find((entry) => sameScopes(entry.scopes, scopes));
	if (preset !== undefined) return preset.label;
	return scopes.length === 1 ? "1 scope" : `${scopes.length} scopes`;
}

/** "All accounts", "Acme", "Acme and 2 more": where a token acts. */
function accountsText(ids: readonly string[] | undefined, accounts: readonly ComputeAccount[]): string {
	if (ids === undefined) return "All accounts";
	const names = ids.map((id) => {
		const account = accounts.find((each) => each.id === id);
		return account === undefined ? id : account.kind === "personal" ? "Personal" : account.name;
	});
	const [first] = names;
	if (first === undefined) return "None";
	return names.length === 1 ? first : `${first} and ${names.length - 1} more`;
}

const when = (at: number): string => new Date(at).toLocaleString("en-GB");

export function PersonalTokensSection({
	source,
	accounts,
	now: fixedNow,
	narrow = false,
	creating = false,
	created: initialCreated,
}: PersonalTokensSectionProps) {
	const headingId = useId();
	const { state, reload } = useLoad(() => source.list(), [source]);
	const [local, setLocal] = useState<ReadonlyMap<string, PersonalToken>>(
		() => new Map(initialCreated === undefined ? [] : [[initialCreated.token.id, initialCreated.token]]),
	);
	const [newOpen, setNewOpen] = useState(creating);
	const [created, setCreated] = useState<CreatedPersonalToken | undefined>(initialCreated);
	const [revoking, setRevoking] = useState<PersonalToken>();
	const now = fixedNow ?? Date.now();

	const listed = state.status === "ready" ? state.value : undefined;
	const tokens = useMemo(() => {
		if (listed === undefined) return undefined;
		const byId = new Map(listed.map((token) => [token.id, token]));
		for (const [id, token] of local) byId.set(id, token);
		return [...byId.values()]
			.filter((token) => token.revokedAt === undefined)
			.sort((a, b) => b.createdAt - a.createdAt);
	}, [listed, local]);

	const keep = (token: PersonalToken) => {
		setLocal((current) => new Map(current).set(token.id, token));
		reload();
	};

	return (
		<section className="flex min-w-0 flex-col gap-2 pt-4" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
				<SectionHeading id={headingId} title="Personal access tokens" />
				<Button icon={<PlusIcon size="sm" />} onClick={() => setNewOpen(true)}>
					New token
				</Button>
			</div>
			<p className="m-0 text-sm text-muted">
				They act as you, with your role in each of your accounts. kantel login makes one when you approve it. For an
				agent or CI in one account, an API key is usually better: it acts only there, with only its scopes.
			</p>
			{state.status === "error" && tokens === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read your tokens.")}
				</Notice>
			) : tokens === undefined ? (
				<div className="flex flex-col gap-3 py-2" aria-busy="true">
					{[0, 1].map((row) => (
						<Skeleton key={row} />
					))}
				</div>
			) : tokens.length === 0 ? (
				<p className="m-0 rounded-panel border border-border bg-raised px-4 py-3 text-sm text-muted">
					No tokens yet. Run kantel login, or make one here for a script.
				</p>
			) : (
				<TokenList tokens={tokens} accounts={accounts} now={now} narrow={narrow} onRevoke={setRevoking} />
			)}
			{newOpen ? (
				<NewTokenDialog
					accounts={accounts}
					onClose={() => setNewOpen(false)}
					onCreate={async (input) => {
						const made = await source.create(input);
						setNewOpen(false);
						setCreated(made);
						keep(made.token);
					}}
				/>
			) : null}
			{created === undefined ? null : <CreatedDialog created={created} onDone={() => setCreated(undefined)} />}
			<RevokeDialog
				token={revoking}
				onClose={() => setRevoking(undefined)}
				onRevoke={async (token) => keep(await source.revoke(token.id))}
			/>
		</section>
	);
}

const head = "h-control-md border-b border-border px-2 py-0 text-sm font-medium whitespace-nowrap text-muted";
const cell = "border-b border-border px-2 py-2.5 align-middle whitespace-nowrap";

function expiry(token: PersonalToken, now: number): { text: string; done: boolean } {
	const left = untilText(token.expiresAt, now);
	return { text: left ?? "Expired", done: left === undefined };
}

function TokenMenu({ token, onRevoke }: { token: PersonalToken; onRevoke: (token: PersonalToken) => void }) {
	return (
		<span className="flex h-control-xs w-control-xs flex-none items-center justify-end pointer-coarse:h-control-lg pointer-coarse:w-control-lg">
			<Menu
				label={`Actions for ${token.name}`}
				icon={<EllipsisIcon />}
				align="end"
				entries={[
					{
						kind: "item",
						id: "revoke",
						label: "Revoke",
						icon: <TrashIcon />,
						danger: true,
						onSelect: () => onRevoke(token),
					},
				]}
			/>
		</span>
	);
}

function TokenList({
	tokens,
	accounts,
	now,
	narrow,
	onRevoke,
}: {
	tokens: readonly PersonalToken[];
	accounts: readonly ComputeAccount[];
	now: number;
	narrow: boolean;
	onRevoke: (token: PersonalToken) => void;
}) {
	if (narrow) {
		return (
			<ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-raised p-0">
				{tokens.map((token) => {
					const ends = expiry(token, now);
					return (
						<li
							key={token.id}
							className="flex min-w-0 flex-col gap-1 border-b border-border px-3 py-3 last:border-b-0"
							data-token={token.id}
						>
							<div className="flex min-w-0 items-center gap-2">
								<span className={`min-w-0 flex-1 truncate text-md font-medium ${ends.done ? "text-muted" : "text-fg"}`}>
									{token.name}
								</span>
								<span className="-my-1 -mr-1">
									<TokenMenu token={token} onRevoke={onRevoke} />
								</span>
							</div>
							<span className="font-mono text-code text-muted">{token.prefix}…</span>
							<div className="flex min-w-0 flex-col gap-1 text-sm">
								<dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4">
									<MetaPair label="Access">{accessText(token.scopes)}</MetaPair>
									<MetaPair label="In">{accountsText(token.accounts, accounts)}</MetaPair>
								</dl>
								<dl className="m-0 grid min-w-0 grid-cols-2 gap-x-4">
									<MetaPair label="Used">
										{token.lastUsedAt === undefined ? "Never" : `${compactAge(token.lastUsedAt, now)} ago`}
									</MetaPair>
									<MetaPair label={ends.done ? "Expired" : "Expires"} title={when(token.expiresAt)}>
										{ends.done ? `${compactAge(token.expiresAt, now)} ago` : ends.text}
									</MetaPair>
								</dl>
							</div>
						</li>
					);
				})}
			</ul>
		);
	}
	return (
		<SideScroll className={tableFrame}>
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
							Accounts
						</th>
						<th className={head} scope="col">
							Last used
						</th>
						<th className={head} scope="col">
							Expires
						</th>
						<th className={head} scope="col">
							<span className="kt-sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{tokens.map((token) => {
						const ends = expiry(token, now);
						return (
							<tr
								key={token.id}
								className={`[&>td]:align-baseline [&>td:last-child]:align-middle ${ends.done ? "text-muted" : "text-fg"}`}
								data-token={token.id}
							>
								<td className={cell}>
									<span className="block max-w-(--kt-popover-width) truncate font-medium">{token.name}</span>
									<span className="block font-mono text-code text-muted">{token.prefix}…</span>
								</td>
								<td className={cell}>{accessText(token.scopes)}</td>
								<td className={cell}>
									<span
										className="text-muted"
										title={token.accounts === undefined ? undefined : accountsText(token.accounts, accounts)}
									>
										{accountsText(token.accounts, accounts)}
									</span>
								</td>
								<td className={cell}>
									{token.lastUsedAt === undefined ? (
										<span className="text-faint">Never</span>
									) : (
										<span className="text-muted" title={when(token.lastUsedAt)}>
											{compactAge(token.lastUsedAt, now)} ago
										</span>
									)}
								</td>
								<td className={cell}>
									<span className="text-muted" title={when(token.expiresAt)}>
										{ends.text}
									</span>
								</td>
								<td className={`${cell} w-0 text-right`}>
									<TokenMenu token={token} onRevoke={onRevoke} />
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</SideScroll>
	);
}

/** The token just made, once. Only Done closes it, so a stray click can't lose it. */
function CreatedDialog({ created, onDone }: { created: CreatedPersonalToken; onDone: () => void }) {
	return (
		<Dialog
			open
			title="Copy your token"
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

/** New token: a name, what it may do (your role, or a preset), where (all your accounts, or one) and how long. */
function NewTokenDialog({
	accounts,
	onClose,
	onCreate,
}: {
	accounts: readonly ComputeAccount[];
	onClose: () => void;
	onCreate: (input: {
		name: string;
		scopes?: readonly ApiScope[];
		accounts?: readonly string[];
		expiresInDays: number;
	}) => Promise<void>;
}) {
	const accessId = useId();
	const [name, setName] = useState("");
	const [access, setAccess] = useState("full");
	const [where, setWhere] = useState("all");
	const [expiry, setExpiry] = useState("90");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const preset = SCOPE_PRESETS.find((entry) => entry.id === access);
	const valid = name.trim() !== "";
	// Not closed while its token is being made: its answer, and its one-time secret, would land after a newer dialog.
	const close = () => {
		if (!busy) onClose();
	};

	const submit = () => {
		if (!valid || busy) return;
		setBusy(true);
		setFailure(undefined);
		onCreate({
			name: name.trim(),
			...(preset === undefined ? {} : { scopes: preset.scopes }),
			...(where === "all" ? {} : { accounts: [where] }),
			expiresInDays: Number(expiry),
		}).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't make the token. Try again."));
			},
		);
	};

	return (
		<Dialog
			open
			title="New token"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={close} disabled={busy}>
						Cancel
					</Button>
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
					placeholder="Deploy script"
					required
				/>
				<FormField id={accessId} label="Access">
					<SegmentedControl label="Access" options={ACCESS_CHOICES} value={access} onChange={setAccess} />
					<p className="m-0 pt-1 text-sm text-muted">
						{preset === undefined
							? "Whatever your role allows in each account."
							: `At most what ${preset.label.toLowerCase()} keys may do, within your role.`}
					</p>
				</FormField>
				<SelectField
					label="Accounts"
					value={where}
					onChange={(event) => setWhere(event.currentTarget.value)}
					options={[
						{ value: "all", label: "All your accounts" },
						...accounts.map((account) => ({
							value: account.id,
							label: account.kind === "personal" ? "Only your personal account" : `Only ${account.name}`,
						})),
					]}
				/>
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
	token,
	onClose,
	onRevoke,
}: {
	token: PersonalToken | undefined;
	onClose: () => void;
	onRevoke: (token: PersonalToken) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	// Not closed while the revoke is on its way: its answer would otherwise close another token's confirmation.
	const close = () => {
		if (busy) return;
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={token !== undefined}
			title="Revoke this token?"
			onClose={close}
			actions={
				<>
					<Button onClick={close} disabled={busy}>
						Cancel
					</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (token === undefined) return;
							setBusy(true);
							onRevoke(token).then(
								() => {
									setBusy(false);
									setFailure(undefined);
									onClose();
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
				Anything signed in with <strong>{token?.name}</strong>, such as a terminal's kantel, stops working at once. This
				can't be undone.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
