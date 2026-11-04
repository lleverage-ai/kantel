// The Organisation page (compute console, experimental): the people in the current organisation and the invites
// waiting, with your role. Admins and owners invite people, revoke invites and remove members; anyone but the owner
// can leave. On a personal account it says what organisations are for and offers to make or join one. Every call goes
// through the `AccountsSource` the host binds; stories bind it to fixtures.

import { useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, InviteIcon, RevokeInviteIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { OneTimeSecret } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { ACCOUNT_ROLE_LABELS } from "./account-switcher.tsx";
import type {
	AccountRole,
	AccountsSource,
	ComputeAccount,
	OrganisationInvite,
	OrganisationMember,
} from "./compute-model.ts";
import { computePage, messageOf, SectionHeading, TableFrame, table, tableFrame, td, th } from "./parts.tsx";

export interface OrganisationPageProps {
	readonly source: AccountsSource;
	readonly account: ComputeAccount;
	/** The person signed in, marked as you, and never offered Remove. */
	readonly viewerId: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Opens Create an organisation, from a personal account. */
	readonly onCreate?: () => void;
	/** Opens Join with a code, from a personal account. */
	readonly onJoin?: () => void;
	/** The viewer left the organisation: the host switches to another account. */
	readonly onLeft?: () => void;
	/** An invite just made, with its join code showing: for a story. */
	readonly invited?: OrganisationInvite;
}

/** The roles an invite can give: the owner is whoever made the organisation. */
const INVITE_ROLES: readonly { value: Exclude<AccountRole, "owner">; label: string }[] = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
];

const YOUR_ROLE: Readonly<Record<AccountRole, string>> = {
	owner: "You're its owner.",
	admin: "You're an admin.",
	member: "You're a member.",
};

const canManage = (role: AccountRole): boolean => role === "owner" || role === "admin";

type NoticeState = { level: "info" | "error"; text: string };

export function OrganisationPage({
	source,
	account,
	viewerId,
	now,
	onCreate,
	onJoin,
	onLeft,
	invited,
}: OrganisationPageProps) {
	if (account.kind === "personal") {
		return (
			<div className={computePage}>
				<PageHeader title="Organisation" />
				<EmptyState
					title="This is your personal account"
					action={
						onCreate === undefined && onJoin === undefined ? undefined : (
							<div className="flex flex-wrap justify-center gap-2">
								{onCreate === undefined ? null : (
									<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={onCreate}>
										Create an organisation
									</Button>
								)}
								{onJoin === undefined ? null : (
									<Button icon={<InviteIcon />} onClick={onJoin}>
										Join with a code
									</Button>
								)}
							</div>
						)
					}
				>
					Your personal account is yours alone. Organisations are where sandboxes, keys, snapshots and settings are
					shared with other people.
				</EmptyState>
			</div>
		);
	}
	return (
		<OrganisationDetails
			source={source}
			account={account}
			viewerId={viewerId}
			now={now}
			{...(onLeft === undefined ? {} : { onLeft })}
			{...(invited === undefined ? {} : { invited })}
		/>
	);
}

function OrganisationDetails({
	source,
	account,
	viewerId,
	now: fixedNow,
	onLeft,
	invited: firstInvited,
}: {
	source: AccountsSource;
	account: ComputeAccount;
	viewerId: string;
	now: number | undefined;
	onLeft?: () => void;
	invited?: OrganisationInvite;
}) {
	const members = useLoad(() => source.members(account.id), [source, account.id]);
	const invites = useLoad(() => source.invites(account.id), [source, account.id]);
	// What this page changed, ahead of the next read: people removed, invites revoked and invites sent.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
	const [sent, setSent] = useState<readonly OrganisationInvite[]>([]);
	const [notice, setNotice] = useState<NoticeState>();
	const [inviting, setInviting] = useState(false);
	const [leaving, setLeaving] = useState(false);
	// The invite just made, while its join code shows.
	const [invited, setInvited] = useState(firstInvited);
	const now = fixedNow ?? Date.now();
	const manager = canManage(account.role);

	const memberList =
		members.state.status === "ready" ? members.state.value.filter((member) => !removed.has(member.id)) : undefined;
	const inviteList =
		invites.state.status === "ready"
			? [
					...invites.state.value,
					...sent.filter((invite) =>
						invites.state.status === "ready" ? !invites.state.value.some((read) => read.id === invite.id) : true,
					),
				].filter((invite) => !revoked.has(invite.id))
			: undefined;

	const toggle = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
		const next = new Set(set);
		if (on) next.add(id);
		else next.delete(id);
		return next;
	};

	const remove = async (member: OrganisationMember) => {
		setRemoved((current) => toggle(current, member.id, true));
		try {
			await source.removeMember(account.id, member.id);
			setNotice({ level: "info", text: `Removed ${member.name} from ${account.name}.` });
			members.reload();
		} catch (caught) {
			setRemoved((current) => toggle(current, member.id, false));
			setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't remove ${member.name}. Try again.`) });
		}
	};

	const revoke = async (invite: OrganisationInvite) => {
		setRevoked((current) => toggle(current, invite.id, true));
		try {
			await source.revokeInvite(account.id, invite.id);
			setNotice({ level: "info", text: `Revoked the invite to ${invite.email}.` });
			invites.reload();
		} catch (caught) {
			setRevoked((current) => toggle(current, invite.id, false));
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't revoke the invite. Try again.") });
		}
	};

	const count = memberList?.length ?? account.members;
	const people = count === 1 ? "1 person" : `${count} people`;
	const headingId = useId();
	return (
		<div className={computePage}>
			<PageHeader
				title={account.name}
				lede={
					account.slug === undefined ? (
						<>
							It has {people}. {YOUR_ROLE[account.role]}
						</>
					) : (
						<>
							Its slug is <span className="font-mono text-code text-fg">{account.slug}</span>, and it has {people}.{" "}
							{YOUR_ROLE[account.role]}
						</>
					)
				}
				actions={
					manager ? (
						<Button variant="primary" icon={<InviteIcon />} onClick={() => setInviting(true)}>
							Invite people
						</Button>
					) : undefined
				}
			/>
			{invited?.code === undefined ? null : (
				<OneTimeSecret
					title={`Send ${invited.email} this code now`}
					secret={invited.code}
					secretLabel="Join code"
					copyLabel="Copy code"
					warning={`Kantel sends no email and shows this code only once. ${invited.email} joins as ${ACCOUNT_ROLE_LABELS[invited.role].toLowerCase()} with it: in the account menu, Join with an invite code. It works once.`}
					acknowledgeLabel="Done"
					onAcknowledge={() => setInvited(undefined)}
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
			{members.state.status === "error" && memberList === undefined ? (
				<Notice
					level="error"
					action={
						<Button
							size="sm"
							onClick={() => {
								members.reload();
								invites.reload();
							}}
						>
							Try again
						</Button>
					}
				>
					{messageOf(members.state.error, "Kantel couldn't read the organisation's members.")}
				</Notice>
			) : memberList === undefined ? (
				<TableSkeleton />
			) : (
				<>
					<section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${headingId}-members`}>
						<SectionHeading id={`${headingId}-members`} title="Members" />
						<MembersTable
							members={memberList}
							viewerId={viewerId}
							manager={manager}
							now={now}
							onRemove={(member) => void remove(member)}
						/>
					</section>
					<section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${headingId}-invites`}>
						<SectionHeading id={`${headingId}-invites`} title="Invites" />
						{invites.state.status === "error" && inviteList === undefined ? (
							<Notice
								level="error"
								action={
									<Button size="sm" onClick={invites.reload}>
										Try again
									</Button>
								}
							>
								{messageOf(invites.state.error, "Kantel couldn't read the invites.")}
							</Notice>
						) : inviteList === undefined ? (
							<TableSkeleton rows={1} />
						) : inviteList.length === 0 ? (
							<p className="m-0 text-sm text-muted">No invites waiting.</p>
						) : (
							<InvitesTable
								invites={inviteList}
								manager={manager}
								now={now}
								onRevoke={(invite) => void revoke(invite)}
							/>
						)}
					</section>
					{account.role === "owner" ? null : (
						<section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${headingId}-leave`}>
							<SectionHeading id={`${headingId}-leave`} title="Leave organisation" />
							<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-panel border border-status-error-line bg-panel px-3 py-2.5">
								<p className="m-0 min-w-0 flex-[1_1_var(--kt-card-width)] text-sm text-muted">
									You lose access to its sandboxes, snapshots and keys. Someone who can invite people can ask you back.
								</p>
								<Button variant="danger" onClick={() => setLeaving(true)}>
									Leave organisation
								</Button>
							</div>
						</section>
					)}
				</>
			)}
			{manager ? (
				<InviteDialog
					open={inviting}
					account={account}
					onClose={() => setInviting(false)}
					onInvite={async (input) => {
						const made = await source.invite(account.id, input);
						// The code shows once, in its own panel; the list never holds it.
						const { code, ...invite } = made;
						setSent((current) => [...current, invite]);
						if (code === undefined) {
							setNotice({ level: "info", text: `Invited ${invite.email} as ${ACCOUNT_ROLE_LABELS[invite.role]}.` });
						} else {
							setNotice(undefined);
							setInvited(made);
						}
						invites.reload();
					}}
				/>
			) : null}
			<LeaveDialog
				open={leaving}
				account={account}
				onClose={() => setLeaving(false)}
				onLeave={async () => {
					await source.leave(account.id);
					onLeft?.();
				}}
			/>
		</div>
	);
}

function TableSkeleton({ rows = 4 }: { rows?: number }) {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2, 3].slice(0, rows).map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		</div>
	);
}

function RoleBadge({ role }: { role: AccountRole }) {
	return <Badge tone={role === "owner" ? "accent" : "neutral"}>{ACCOUNT_ROLE_LABELS[role]}</Badge>;
}

function MembersTable({
	members,
	viewerId,
	manager,
	now,
	onRemove,
}: {
	members: readonly OrganisationMember[];
	viewerId: string;
	manager: boolean;
	now: number;
	onRemove: (member: OrganisationMember) => void;
}) {
	// The owner first, then admins, then members, each by name.
	const rank: Readonly<Record<AccountRole, number>> = { owner: 0, admin: 1, member: 2 };
	const sorted = [...members].sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name, "en-GB"));
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Name
						</th>
						<th className={th} scope="col">
							Email
						</th>
						<th className={th} scope="col">
							Role
						</th>
						<th className={th} scope="col">
							Joined
						</th>
						{manager ? (
							<th className={th} scope="col">
								<span className="kt-sr-only">Actions</span>
							</th>
						) : null}
					</tr>
				</thead>
				<tbody>
					{sorted.map((member) => {
						const you = member.id === viewerId;
						const removable = manager && !you && member.role !== "owner";
						return (
							<tr key={member.id} data-member={member.id}>
								<td className={td}>
									<span className="flex items-center gap-2">
										<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{member.name}</span>
										{you ? <Badge>You</Badge> : null}
									</span>
								</td>
								<td className={td}>
									<span className="text-muted">{member.email}</span>
								</td>
								<td className={td}>
									<RoleBadge role={member.role} />
								</td>
								<td className={td}>
									<span className="text-muted" title={new Date(member.joinedAt).toLocaleString("en-GB")}>
										{compactAge(member.joinedAt, now)}
									</span>
								</td>
								{manager ? (
									<td className={`${td} w-0`}>
										{/* A row with no menu keeps the menu's height, so every row is as tall. */}
										<span className="flex h-control-xs items-center justify-end pointer-coarse:h-control-lg">
											{removable ? (
												<Menu
													label={`Actions for ${member.name}`}
													icon={<EllipsisIcon />}
													align="end"
													entries={[
														{
															kind: "item",
															id: "remove",
															label: "Remove",
															icon: <TrashIcon />,
															danger: true,
															onSelect: () => onRemove(member),
														},
													]}
												/>
											) : null}
										</span>
									</td>
								) : null}
							</tr>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}

function InvitesTable({
	invites,
	manager,
	now,
	onRevoke,
}: {
	invites: readonly OrganisationInvite[];
	manager: boolean;
	now: number;
	onRevoke: (invite: OrganisationInvite) => void;
}) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Email
						</th>
						<th className={th} scope="col">
							Role
						</th>
						<th className={th} scope="col">
							Sent
						</th>
						{manager ? (
							<th className={th} scope="col">
								<span className="kt-sr-only">Actions</span>
							</th>
						) : null}
					</tr>
				</thead>
				<tbody>
					{invites.map((invite) => (
						<tr key={invite.id} data-invite={invite.id}>
							<td className={td}>
								<span className="font-medium text-fg">{invite.email}</span>
							</td>
							<td className={td}>
								<RoleBadge role={invite.role} />
							</td>
							<td className={td}>
								<span className="text-muted" title={new Date(invite.sentAt).toLocaleString("en-GB")}>
									{compactAge(invite.sentAt, now)}
								</span>
							</td>
							{manager ? (
								<td className={`${td} w-0 text-right`}>
									<Button
										size="xs"
										variant="ghost"
										icon={<RevokeInviteIcon />}
										aria-label={`Revoke the invite to ${invite.email}`}
										onClick={() => onRevoke(invite)}
									>
										Revoke
									</Button>
								</td>
							) : null}
						</tr>
					))}
				</tbody>
			</table>
		</TableFrame>
	);
}

/** Invite people: an email and the role they join with. Errors from the call show in the dialog. */
function InviteDialog({
	open,
	account,
	onClose,
	onInvite,
}: {
	open: boolean;
	account: ComputeAccount;
	onClose: () => void;
	onInvite: (input: { email: string; role: AccountRole }) => Promise<void>;
}) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Exclude<AccountRole, "owner">>("member");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
	const close = () => {
		setEmail("");
		setRole("member");
		setFailure(undefined);
		onClose();
	};
	const submit = () => {
		if (!valid || busy) return;
		setBusy(true);
		setFailure(undefined);
		onInvite({ email: email.trim(), role }).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't make the invite. Try again."));
			},
		);
	};
	return (
		<Dialog
			open={open}
			title="Invite people"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						Make invite
					</Button>
				</>
			}
		>
			<p>
				Kantel makes a code for them to join <strong>{account.name}</strong> and use its sandboxes. You send it to them.
			</p>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Email"
					type="email"
					value={email}
					onChange={(event) => setEmail(event.currentTarget.value)}
					placeholder="sam@example.com"
					autoComplete="off"
				/>
				<SelectField
					label="Role"
					hint="Admins can invite and remove people too."
					value={role}
					onChange={(event) => setRole(event.currentTarget.value as Exclude<AccountRole, "owner">)}
					options={INVITE_ROLES}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function LeaveDialog({
	open,
	account,
	onClose,
	onLeave,
}: {
	open: boolean;
	account: ComputeAccount;
	onClose: () => void;
	onLeave: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={open}
			title={`Leave ${account.name}?`}
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							setBusy(true);
							onLeave().then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't take you out of it. Try again."));
								},
							);
						}}
					>
						Leave
					</Button>
				</>
			}
		>
			<p>
				You lose access to <strong>{account.name}</strong>'s sandboxes, snapshots and keys at once. Sandboxes you made
				stay with the organisation.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
