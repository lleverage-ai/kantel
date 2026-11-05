// The organisation's settings and your organisations (compute console, under Settings).
//
// In an organisation, General: its name, its people (members and invites waiting, in one list, each with its role) and
// Leave. Admins and owners rename it, invite people, change roles, revoke invites and remove members; anyone but the
// owner can leave. On the personal account, Organisations: the ones you belong to, with your role and Switch, and
// Create or Join with a code under them. Every call goes through the `AccountsSource` the host binds; stories bind it to
// fixtures.

import { useId, useState } from "react";
import { initials } from "../identity/signed-in-as.tsx";
import { Button } from "../primitives/button.tsx";
import { SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { compactAge } from "../primitives/format.ts";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, RevokeInviteIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { OneTimeSecret } from "../primitives/one-time-secret.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { ACCOUNT_ROLE_LABELS, AccountMark } from "./account-switcher.tsx";
import type {
	AccountRole,
	AccountsSource,
	ComputeAccount,
	OrganisationInvite,
	OrganisationMember,
} from "./compute-model.ts";
import { computePage, messageOf, SectionHeading } from "./parts.tsx";
import { SettingsPageHeader } from "./settings-nav.tsx";

export interface OrganisationPageProps {
	readonly source: AccountsSource;
	readonly account: ComputeAccount;
	/** The person signed in, marked as you, and never offered Remove. */
	readonly viewerId: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** Every account the viewer has, for the personal account's list of organisations. */
	readonly accounts?: readonly ComputeAccount[];
	/** Switches the console to an organisation, from the personal account's list. */
	readonly onSwitch?: (account: ComputeAccount) => void;
	/** Opens Create an organisation, from the personal account. */
	readonly onCreate?: () => void;
	/** Opens Join with a code, from the personal account. */
	readonly onJoin?: () => void;
	/** The viewer left the organisation: the host switches to another account. */
	readonly onLeft?: () => void;
	/** The organisation has a new name: the host reads its accounts again. */
	readonly onRenamed?: (account: ComputeAccount) => void;
	/** A phone: rows that fit 390px. */
	readonly narrow?: boolean;
	/** An invite just made, with its join code showing: for a story. */
	readonly invited?: OrganisationInvite;
}

/** The roles an invite can give: the owner is whoever made the organisation. */
const INVITE_ROLES: readonly { value: Exclude<AccountRole, "owner">; label: string }[] = [
	{ value: "member", label: "Member" },
	{ value: "admin", label: "Admin" },
];

const canManage = (role: AccountRole): boolean => role === "owner" || role === "admin";

/**
 * One change at a time for each member: `run` starts a change unless one for the same member is still going, and says
 * which members are busy as that changes. The API writes a role or a removal as it comes, so two at once could land in
 * either order; holding the second until the first settles keeps what is stored and what is shown the same.
 */
export function createMemberLocks(onBusy: (busy: ReadonlySet<string>) => void) {
	const busy = new Set<string>();
	return {
		run<T>(memberId: string, change: () => Promise<T>): Promise<T> | undefined {
			if (busy.has(memberId)) return undefined;
			busy.add(memberId);
			onBusy(new Set(busy));
			return change().finally(() => {
				busy.delete(memberId);
				onBusy(new Set(busy));
			});
		},
	};
}

type NoticeState = { level: "info" | "error"; text: string };

export function OrganisationPage(props: OrganisationPageProps) {
	return props.account.kind === "personal" ? <OrganisationsList {...props} /> : <General {...props} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Organisations: the personal account's list

function OrganisationsList({
	source,
	accounts = [],
	narrow = false,
	onSwitch,
	onCreate,
	onJoin,
}: OrganisationPageProps) {
	const organisations = accounts.filter((each) => each.kind === "organisation");
	const actions =
		onCreate === undefined && onJoin === undefined ? null : (
			<div className="flex flex-wrap items-center gap-2">
				{onCreate === undefined ? null : (
					<Button icon={<PlusIcon size="sm" />} onClick={onCreate}>
						Create
					</Button>
				)}
				{onJoin === undefined ? null : (
					<Button variant="ghost" onClick={onJoin}>
						Join with a code
					</Button>
				)}
			</div>
		);
	return (
		<div className={computePage}>
			<SettingsPageHeader title="Organisations" narrow={narrow} />
			{organisations.length === 0 ? (
				<EmptyState title="No organisations yet" action={actions ?? undefined}>
					Share sandboxes, snapshots and keys with other people.
				</EmptyState>
			) : (
				<>
					<ul className="kt-organisation-rows m-0 flex list-none flex-col p-0">
						{organisations.map((organisation) => (
							<OrganisationRow
								key={organisation.id}
								source={source}
								organisation={organisation}
								narrow={narrow}
								{...(onSwitch === undefined ? {} : { onSwitch })}
							/>
						))}
					</ul>
					{actions}
				</>
			)}
		</div>
	);
}

/** "5 members", read from the organisation itself: an account in the list doesn't always count them. */
function useMemberCount(source: AccountsSource, organisation: ComputeAccount): string | undefined {
	const { state } = useLoad(() => source.members(organisation.id), [source, organisation.id]);
	if (state.status !== "ready") return undefined;
	const count = state.value.length;
	return count === 1 ? "1 member" : `${count} members`;
}

function OrganisationRow({
	source,
	organisation,
	narrow,
	onSwitch,
}: {
	source: AccountsSource;
	organisation: ComputeAccount;
	narrow: boolean;
	onSwitch?: (account: ComputeAccount) => void;
}) {
	const members = useMemberCount(source, organisation);
	const role = ACCOUNT_ROLE_LABELS[organisation.role];
	const who = (
		<span className="flex min-w-0 flex-1 flex-col gap-0.5">
			<span className="truncate font-medium text-fg">{organisation.name}</span>
			<span className="min-h-4 truncate text-sm text-muted">{members ?? ""}</span>
		</span>
	);
	// A phone: the whole row switches, with a chevron, as a list of places to go.
	if (narrow && onSwitch !== undefined) {
		return (
			<li className="border-b border-border" data-account={organisation.id}>
				<button
					type="button"
					className="kt-focusable flex w-full min-w-0 cursor-pointer items-center gap-3 border-0 bg-transparent px-0 py-3 text-left [font-family:inherit] text-md text-fg"
					onClick={() => onSwitch(organisation)}
					aria-label={`Switch to ${organisation.name}, ${role}`}
				>
					<AccountMark account={organisation} />
					{who}
					<span className="flex-none text-sm text-muted">{role}</span>
					<ChevronRightIcon className="flex-none text-faint" />
				</button>
			</li>
		);
	}
	return (
		<li
			className="flex min-w-0 items-center gap-3 border-b border-border px-2 py-2.5 text-sm"
			data-account={organisation.id}
		>
			<AccountMark account={organisation} />
			{who}
			<span className="w-24 flex-none text-muted">{role}</span>
			{onSwitch === undefined ? null : (
				<Button size="sm" onClick={() => onSwitch(organisation)} aria-label={`Switch to ${organisation.name}`}>
					Switch
				</Button>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// General: an organisation's name, people and Leave

function General({
	source,
	account,
	viewerId,
	now: fixedNow,
	onLeft,
	onRenamed,
	narrow = false,
	invited: firstInvited,
}: OrganisationPageProps) {
	const members = useLoad(() => source.members(account.id), [source, account.id]);
	const manager = canManage(account.role);
	// Only an admin may list the invites.
	const invites = useLoad(
		() => (manager ? source.invites(account.id) : Promise.resolve([] as readonly OrganisationInvite[])),
		[source, account.id, manager],
	);
	// What this page changed, ahead of the next read: people removed or given a new role, invites revoked and sent.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [roles, setRoles] = useState<ReadonlyMap<string, AccountRole>>(new Map());
	const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
	const [sent, setSent] = useState<readonly OrganisationInvite[]>([]);
	const [notice, setNotice] = useState<NoticeState>();
	const [inviting, setInviting] = useState(false);
	const [leaving, setLeaving] = useState(false);
	// The invite just made, while its join code shows.
	const [invited, setInvited] = useState(firstInvited);
	// Members with a role change or a removal on its way: their role and Remove wait for it.
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const [locks] = useState(() => createMemberLocks(setBusy));
	const now = fixedNow ?? Date.now();
	const headingId = useId();

	const memberList =
		members.state.status === "ready"
			? members.state.value
					.filter((member) => !removed.has(member.id))
					.map((member) => ({ ...member, role: roles.get(member.id) ?? member.role }))
			: undefined;
	const inviteList =
		invites.state.status === "ready"
			? [
					...invites.state.value,
					...sent.filter((invite) =>
						invites.state.status === "ready" ? !invites.state.value.some((read) => read.id === invite.id) : true,
					),
				].filter((invite) => !revoked.has(invite.id))
			: [];

	const toggle = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
		const next = new Set(set);
		if (on) next.add(id);
		else next.delete(id);
		return next;
	};

	const remove = (member: OrganisationMember) =>
		locks.run(member.id, async () => {
			setRemoved((current) => toggle(current, member.id, true));
			try {
				await source.removeMember(account.id, member.id);
				setNotice({ level: "info", text: `Removed ${member.name}.` });
				members.reload();
			} catch (caught) {
				setRemoved((current) => toggle(current, member.id, false));
				setNotice({ level: "error", text: messageOf(caught, `Kantel couldn't remove ${member.name}. Try again.`) });
			}
		});

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

	const sourceRename = source.rename;
	const rename =
		manager && sourceRename !== undefined
			? async (name: string) => {
					const renamed = await sourceRename(account.id, name);
					onRenamed?.(renamed);
				}
			: undefined;
	const setRole = source.setRole;
	const changeRole =
		setRole === undefined
			? undefined
			: (member: OrganisationMember, role: AccountRole) =>
					locks.run(member.id, async () => {
						// What was shown, and confirmed, before: nothing else for this member can have changed it meanwhile.
						const was = member.role;
						setRoles((current) => new Map(current).set(member.id, role));
						try {
							const changed = await setRole(account.id, member.id, role);
							setRoles((current) => new Map(current).set(member.id, changed.role));
							setNotice({
								level: "info",
								text: `${member.name} is now ${ACCOUNT_ROLE_LABELS[changed.role].toLowerCase()}.`,
							});
							members.reload();
						} catch (caught) {
							setRoles((current) => new Map(current).set(member.id, was));
							setNotice({
								level: "error",
								text: messageOf(caught, `Kantel couldn't change ${member.name}'s role. Try again.`),
							});
						}
					});

	return (
		<div className={computePage}>
			<SettingsPageHeader title="General" narrow={narrow} />
			<NameField account={account} {...(rename === undefined ? {} : { rename })} />
			{invited?.code === undefined ? null : (
				<OneTimeSecret
					title={
						invited.emailed === true
							? `Kantel emailed ${invited.email} a link to join`
							: `Send ${invited.email} this code now`
					}
					secret={invited.code}
					secretLabel="Join code"
					copyLabel="Copy code"
					warning={
						invited.emailed === true
							? `If it doesn't arrive, send them this code. It's shown only once. They join with it from the account menu, signed in as ${invited.email}.`
							: `Kantel shows this code only once. They join with it from the account menu, signed in as ${invited.email}.`
					}
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
			<section className="flex min-w-0 flex-col gap-2" aria-labelledby={`${headingId}-members`}>
				<SectionHeading
					id={`${headingId}-members`}
					title="Members"
					actions={
						manager ? (
							<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setInviting(true)}>
								Invite
							</Button>
						) : undefined
					}
				/>
				{members.state.status === "error" && memberList === undefined ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={members.reload}>
								Try again
							</Button>
						}
					>
						{messageOf(members.state.error, "Kantel couldn't read the members.")}
					</Notice>
				) : memberList === undefined ? (
					<RowsSkeleton />
				) : (
					<People
						members={memberList}
						invites={inviteList}
						viewerId={viewerId}
						viewerRole={account.role}
						now={now}
						narrow={narrow}
						busy={busy}
						onRemove={(member) => void remove(member)}
						onRevoke={(invite) => void revoke(invite)}
						{...(manager && changeRole !== undefined
							? { onRole: (member: OrganisationMember, role: AccountRole) => void changeRole(member, role) }
							: {})}
					/>
				)}
				{invites.state.status === "error" ? (
					<p className="m-0 text-sm text-status-error">
						{messageOf(invites.state.error, "Kantel couldn't read the invites.")}
					</p>
				) : null}
			</section>
			{account.role === "owner" ? null : (
				<section className="flex min-w-0 flex-col gap-2 pt-4" aria-labelledby={`${headingId}-leave`}>
					<SectionHeading id={`${headingId}-leave`} title="Leave" />
					{/* A card like the members list above it, so the page ends on a block rather than loose text. */}
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-panel border border-border bg-raised px-4 py-3">
						<p className="m-0 min-w-0 text-sm text-muted">
							You lose access to {account.name}'s sandboxes, snapshots and keys.
						</p>
						{/* Quiet until it's asked for: the confirming dialog has the solid red button. */}
						<Button variant="danger-quiet" onClick={() => setLeaving(true)}>
							Leave {account.name}
						</Button>
					</div>
				</section>
			)}
			{manager ? (
				<InviteDialog
					open={inviting}
					onClose={() => setInviting(false)}
					onInvite={async (input) => {
						const made = await source.invite(account.id, input);
						// The code shows once, in its own panel; the list never holds it.
						const { code, ...invite } = made;
						setSent((current) => [...current, invite]);
						if (code === undefined) {
							setNotice({ level: "info", text: `Invited ${invite.email}.` });
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

/** The organisation's name: a field an admin can change and save; for anyone else, read only. */
function NameField({ account, rename }: { account: ComputeAccount; rename?: (name: string) => Promise<void> }) {
	const [name, setName] = useState(account.name);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const trimmed = name.trim();
	const dirty = rename !== undefined && trimmed !== "" && trimmed !== account.name;
	const save = () => {
		if (!dirty || busy || rename === undefined) return;
		setBusy(true);
		setFailure(undefined);
		rename(trimmed).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't rename it. Try again."));
			},
		);
	};
	return (
		<form
			className="flex min-w-0 max-w-(--kt-card-width) items-end gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<div className="min-w-0 flex-1">
				<TextField
					label="Name"
					value={name}
					readOnly={rename === undefined}
					maxLength={100}
					onChange={(event) => setName(event.currentTarget.value)}
					{...(failure === undefined ? {} : { error: failure })}
				/>
			</div>
			{dirty ? (
				<Button type="submit" variant="primary" busy={busy}>
					Save
				</Button>
			) : null}
		</form>
	);
}

function RowsSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-2" aria-busy="true">
			{[0, 1, 2, 3].map((row) => (
				<Skeleton key={row} />
			))}
		</div>
	);
}

/** A person's initials in a circle; an invite's from its email. */
function PersonMark({ name }: { name: string }) {
	return (
		<span
			className="inline-grid size-control-sm flex-none place-items-center rounded-full border border-border-strong bg-raised text-xs font-strong leading-none text-fg"
			aria-hidden="true"
		>
			{initials(name)}
		</span>
	);
}

/** A row's role: words, or for an admin a menu of the roles they may give, in the same words. */
function RoleControl({
	member,
	viewerRole,
	onRole,
}: {
	member: OrganisationMember;
	viewerRole: AccountRole;
	onRole?: (member: OrganisationMember, role: AccountRole) => void;
}) {
	const label = ACCOUNT_ROLE_LABELS[member.role];
	// Only an owner makes or unmakes an owner.
	const offered: readonly AccountRole[] = viewerRole === "owner" ? ["member", "admin", "owner"] : ["member", "admin"];
	if (onRole === undefined || !offered.includes(member.role)) return <RoleText role={member.role} />;
	const entries: MenuEntry[] = offered.map((role) => ({
		kind: "item",
		id: role,
		label: ACCOUNT_ROLE_LABELS[role],
		checked: role === member.role,
		onSelect: () => {
			if (role !== member.role) onRole(member, role);
		},
	}));
	return (
		<Menu
			label={`Role for ${member.name}`}
			entries={entries}
			align="end"
			triggerClassName="kt-focusable inline-flex cursor-pointer items-center gap-1 rounded-control border-0 bg-transparent px-1.5 py-1 [font-family:inherit] text-sm text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover"
			trigger={
				<>
					<span className="kt-sr-only">{member.name}'s role: </span>
					{label}
					<ChevronDownIcon size="sm" />
				</>
			}
		/>
	);
}

/** A role in words, taking the room a role's menu takes so the column lines up. */
function RoleText({ role }: { role: AccountRole }) {
	return (
		<span className="inline-flex items-center gap-1 px-1.5 py-1 text-sm text-muted">
			{ACCOUNT_ROLE_LABELS[role]}
			<ChevronDownIcon size="sm" className="invisible" />
		</span>
	);
}

/** The ⋯ for a row, or the room it takes so rows line up. */
function RowMenu({ label, entries }: { label: string; entries: readonly MenuEntry[] }) {
	return (
		<span className="flex h-control-xs w-control-xs flex-none items-center justify-end pointer-coarse:h-control-lg pointer-coarse:w-control-lg">
			{entries.length === 0 ? null : <Menu label={label} icon={<EllipsisIcon />} align="end" entries={entries} />}
		</span>
	);
}

/** Members, the owner first, then admins, then members, each by name; then the invites waiting. */
function People({
	members,
	invites,
	viewerId,
	viewerRole,
	now,
	narrow,
	busy,
	onRemove,
	onRevoke,
	onRole,
}: {
	members: readonly OrganisationMember[];
	invites: readonly OrganisationInvite[];
	viewerId: string;
	viewerRole: AccountRole;
	now: number;
	narrow: boolean;
	/** Members with a change on its way: their role and Remove wait for it. */
	busy: ReadonlySet<string>;
	onRemove: (member: OrganisationMember) => void;
	onRevoke: (invite: OrganisationInvite) => void;
	onRole?: (member: OrganisationMember, role: AccountRole) => void;
}) {
	const manager = canManage(viewerRole);
	const rank: Readonly<Record<AccountRole, number>> = { owner: 0, admin: 1, member: 2 };
	const sorted = [...members].sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name, "en-GB"));
	// In a card at every width, as every list in the console.
	const row = `flex min-w-0 items-center gap-3 border-b border-border py-2.5 text-sm last:border-b-0 ${narrow ? "px-3" : "px-4"}`;
	// The role is a fixed column just before the row's menu, under a Role heading on a wide card, so every row ends on the
	// same edge and the column reads as one.
	const roleColumn = "flex w-28 flex-none justify-start";
	// The menu's room, kept on every row (and the heading) so the role column lines up whether a row has a menu or not.
	const menuColumn = "w-control-xs flex-none pointer-coarse:w-control-lg";
	return (
		// In a white card, as every list in the console is.
		<div className="rounded-panel border border-border bg-raised">
			{narrow ? null : (
				// The headings, as a table's: the list's own rows are read with their labels, so this is for the eye.
				<div
					className="flex h-control-md items-center gap-3 border-b border-border px-4 text-sm font-medium text-muted"
					aria-hidden="true"
				>
					<span className="flex-1">Name</span>
					<span className={`${roleColumn} px-1.5`}>Role</span>
					{manager ? <span className={menuColumn} /> : null}
				</div>
			)}
			<ul className="kt-member-rows m-0 flex list-none flex-col p-0">
				{sorted.map((member) => {
					const you = member.id === viewerId;
					const waiting = busy.has(member.id);
					const removable = manager && !you && !waiting && member.role !== "owner";
					return (
						<li key={member.id} className={row} data-member={member.id} aria-busy={waiting || undefined}>
							<PersonMark name={member.name} />
							<span
								className="flex min-w-0 flex-1 flex-col gap-0.5"
								title={`Joined ${compactAge(member.joinedAt, now)} ago`}
							>
								<span className="flex min-w-0 items-center gap-2">
									<span className="truncate font-medium text-fg">{member.name}</span>
									{/* A label, not part of the name. */}
									{you ? <Badge tone="neutral">You</Badge> : null}
								</span>
								{member.email === "" ? null : <span className="truncate text-sm text-muted">{member.email}</span>}
							</span>
							<span className={roleColumn}>
								<RoleControl
									member={member}
									viewerRole={viewerRole}
									{...(you || waiting || onRole === undefined ? {} : { onRole })}
								/>
							</span>
							{manager ? (
								<RowMenu
									label={`Actions for ${member.name}`}
									entries={
										removable
											? [
													{
														kind: "item",
														id: "remove",
														label: "Remove",
														icon: <TrashIcon />,
														danger: true,
														onSelect: () => onRemove(member),
													},
												]
											: []
									}
								/>
							) : null}
						</li>
					);
				})}
				{invites.map((invite) => {
					const sent = `Invited ${compactAge(invite.sentAt, now)} ago`;
					const name = invite.email === "" ? "Anyone with the code" : invite.email;
					return (
						<li key={invite.id} className={row} data-invite={invite.id}>
							<PersonMark name={invite.email === "" ? "?" : invite.email} />
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate font-medium text-fg">{name}</span>
								<span className="truncate text-sm text-muted">{sent}</span>
							</span>
							<span className={roleColumn}>
								<RoleText role={invite.role} />
							</span>
							{manager ? (
								<RowMenu
									label={`Actions for the invite to ${name}`}
									entries={[
										{
											kind: "item",
											id: "revoke",
											label: "Revoke invite",
											icon: <RevokeInviteIcon />,
											danger: true,
											onSelect: () => onRevoke(invite),
										},
									]}
								/>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** Invite: an email and the role they join with. Errors from the call show in the dialog. */
function InviteDialog({
	open,
	onClose,
	onInvite,
}: {
	open: boolean;
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
			title="Invite"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!valid}>
						Invite
					</Button>
				</>
			}
		>
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
				stay with it.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
