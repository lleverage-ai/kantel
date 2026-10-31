import type { Role } from "@kantel/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton, inputClass, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { EllipsisIcon, InviteIcon, KeyRoundIcon, RevokeInviteIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	createMembersFlow,
	type InviteDialogState,
	type InviteRow,
	type MemberRow,
	type MembersApi,
	type MembersFlow,
	type MembersProblem,
	type MembersState,
	onlyYou,
	resetText,
} from "./members-model.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css). A heading with Invite, then the organisation's people, after
// Linear's and Vercel's members lists: one column at reading width, the pending invites first, each row a "…" menu
// (Revoke invite, or Reset passkeys). The menu is always visible (not on hover), so it works the same with touch.
// Invite is the page's one primary action: in the header, or in the empty state when it's only you.

const ROLE_OPTIONS: readonly { value: Role; label: string }[] = [
	{ value: "viewer", label: "Viewer" },
	{ value: "operator", label: "Operator" },
	{ value: "admin", label: "Admin" },
];

const roleLabel = (role: Role) => ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;

export interface MembersPageProps {
	/** `GET /v1/members`, `POST /v1/members/:userId/passkeys/reset`, and `GET`/`POST /v1/invites`. */
	readonly api: MembersApi;
	/** The signed-in person's user ID, marked as you in the list. */
	readonly viewer?: string;
	/** Where the page starts, for stories; it loads the list either way. */
	readonly initial?: MembersState;
}

/** The sentence for a problem, by what was being done. */
function problemText(problem: MembersProblem, doing: "load" | "reset" | "invite" | "revoke"): string {
	switch (problem.kind) {
		case "signed-out":
			return "You're signed out. Reload the page to sign in.";
		case "forbidden":
			if (doing === "reset") return "You can't reset passkeys. It needs the admin role on this organisation.";
			if (doing === "load") return "You can't list this organisation's members. Ask an admin of this organisation.";
			return "You can't manage invites. It needs the admin role on this organisation.";
		case "not-found":
			return doing === "revoke" ? "That invite isn't pending any more." : "Kantel has no such member any more.";
		case "not-supported":
			return "This deployment has no passkeys to reset.";
		case "conflict":
			return "That email is invited or a member already.";
		case "invalid":
			return "Enter an email address.";
		case "unavailable":
			if (doing === "load") return "Kantel can't list its members right now. Try again in a moment.";
			if (doing === "reset") return "Kantel couldn't reset the passkeys. Try again in a moment.";
			return doing === "invite"
				? "Kantel couldn't make the invite. Try again in a moment."
				: "Kantel couldn't revoke the invite. Try again in a moment.";
	}
}

/**
 * The organisation's members, for an admin, with a way to reset a person's passkeys when they've lost them. A reset
 * removes every passkey the person has, so they can set up a new one after signing in; Kantel audits it. Reset asks
 * first.
 */
export function MembersPage({ api, viewer, initial }: MembersPageProps) {
	const latest = useRef(api);
	latest.current = api;
	const [flow] = useState<MembersFlow>(() =>
		createMembersFlow({
			api: {
				list: () => latest.current.list(),
				resetPasskeys: (userId) => latest.current.resetPasskeys(userId),
				listInvites: () => latest.current.listInvites(),
				invite: (input) => latest.current.invite(input),
				revokeInvite: (inviteId) => latest.current.revokeInvite(inviteId),
			},
			...(initial === undefined ? {} : { initial }),
		}),
	);
	const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
	useEffect(() => {
		void flow.load();
	}, [flow]);
	const members = state.members ?? [];
	const invites = state.invites ?? [];
	const alone = onlyYou(state, viewer);
	const loaded = state.members !== undefined && state.invites !== undefined;
	const inviteButton = (
		<Button variant="primary" icon={<InviteIcon size="sm" />} onClick={() => flow.openInvite()}>
			Invite
		</Button>
	);

	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-6 text-sm leading-normal text-fg [&_p]:m-0">
			<PageHeader title="Members" {...(loaded && !alone ? { actions: inviteButton } : {})} />

			<section className="flex min-w-0 flex-col gap-2" aria-label="Members">
				{state.loadProblem === undefined ? null : (
					<Notice
						level={state.loadProblem.kind === "forbidden" ? "warning" : "error"}
						action={
							state.loadProblem.kind === "unavailable" ? (
								<Button size="xs" busy={state.loading} onClick={() => void flow.load()}>
									Try again
								</Button>
							) : undefined
						}
					>
						{problemText(state.loadProblem, "load")}
					</Notice>
				)}
				{state.members === undefined ? (
					state.loadProblem === undefined ? (
						<div className="flex flex-col gap-4">
							<span className="kt-sr-only">Loading members</span>
							<Skeleton lines={1} />
							<Skeleton lines={1} />
						</div>
					) : null
				) : members.length === 0 && invites.length === 0 ? (
					<EmptyState title="No members yet" action={inviteButton} />
				) : (
					<ul className="m-0 flex list-none flex-col divide-y divide-border rounded-panel border border-border bg-panel p-0">
						{invites.map((invite) => (
							<InviteItem key={invite.id} invite={invite} flow={flow} state={state} />
						))}
						{members.map((member) => (
							<MemberItem
								key={member.userId}
								member={member}
								you={member.userId === viewer}
								flow={flow}
								state={state}
							/>
						))}
					</ul>
				)}
				{alone && members.length > 0 ? <EmptyState title="Just you so far" action={inviteButton} /> : null}
			</section>

			<InviteDialog state={state.inviting} flow={flow} />
		</div>
	);
}

/** A pending invite: the email, Invited, the role, and a menu to revoke it. */
function InviteItem({ invite, flow, state }: { invite: InviteRow; flow: MembersFlow; state: MembersState }) {
	const revoking = state.revoking === invite.id;
	const problem = state.revokeProblem?.inviteId === invite.id ? state.revokeProblem.problem : undefined;
	return (
		<li className="flex min-w-0 flex-col gap-2 px-3 py-2">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="wrap-anywhere text-muted">{invite.email}</span>
					<Badge>Invited</Badge>
				</p>
				<span className="flex flex-none items-center gap-2">
					<span className="text-muted">{roleLabel(invite.role)}</span>
					<Menu
						label={`Actions for the invite to ${invite.email}`}
						icon={<EllipsisIcon />}
						align="end"
						entries={[
							{
								kind: "item",
								id: "revoke-invite",
								label: "Revoke invite",
								icon: <RevokeInviteIcon />,
								danger: true,
								disabled: revoking,
								onSelect: () => void flow.revokeInvite(invite.id),
							},
						]}
					/>
				</span>
			</div>
			{problem === undefined ? null : (
				<p className="text-xs text-status-error" role="alert">
					{problemText(problem, "revoke")}
				</p>
			)}
		</li>
	);
}

/** Email and role, then the link to share once the invite is made. */
function InviteDialog({ state, flow }: { state: InviteDialogState | undefined; flow: MembersFlow }) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("operator");
	const open = state !== undefined;
	// A fresh form each time it opens.
	useEffect(() => {
		if (!open) return;
		setEmail("");
		setRole("operator");
	}, [open]);
	const sent = state?.sent;

	if (sent !== undefined) {
		return (
			<Dialog
				open={open}
				title={sent.emailed ? "Invite sent" : "Share the invite"}
				onClose={() => flow.closeInvite()}
				actions={
					<Button variant="primary" onClick={() => flow.closeInvite()}>
						Done
					</Button>
				}
			>
				<p>
					{sent.emailed ? "Emailed " : "Send "}
					<strong>{sent.invite.email}</strong>
					{sent.emailed ? " a link to sign in with." : " this link to sign in with."}
				</p>
				<div className="mt-3 flex min-w-0 items-center gap-2">
					<input className={inputClass} readOnly value={sent.link} aria-label="Invite link" />
					<CopyButton text={sent.link} label="Copy" />
				</div>
			</Dialog>
		);
	}

	const sending = state?.sending === true;
	const problem = state?.problem;
	return (
		<Dialog
			open={open}
			title="Invite to organisation"
			onClose={() => flow.closeInvite()}
			onSubmit={() => void flow.invite({ email, role })}
			actions={
				<>
					<Button disabled={sending} onClick={() => flow.closeInvite()}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" busy={sending} disabled={email.trim() === ""}>
						Invite
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<TextField
					label="Email"
					type="email"
					autoComplete="off"
					placeholder="name@example.com"
					autoFocus
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					{...(problem === undefined ? {} : { error: problemText(problem, "invite") })}
				/>
				<SelectField
					label="Role"
					options={ROLE_OPTIONS}
					value={role}
					onChange={(event) => setRole(event.target.value as Role)}
				/>
			</div>
		</Dialog>
	);
}

function MemberItem({
	member,
	you,
	flow,
	state,
}: {
	member: MemberRow;
	you: boolean;
	flow: MembersFlow;
	state: MembersState;
}) {
	const confirming = state.confirming === member.userId;
	const resetting = state.resetting === member.userId;
	const problem = state.resetProblem?.userId === member.userId ? state.resetProblem.problem : undefined;
	const done = state.done?.userId === member.userId ? state.done : undefined;
	/** Holds the row's menu, whose trigger takes focus back when the confirmation closes. */
	const menuSlot = useRef<HTMLSpanElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	// Into the confirmation when it opens, and back to the row's menu when it closes.
	useEffect(() => {
		if (confirming) cancelButton.current?.focus();
		else if (wasConfirming.current) menuSlot.current?.querySelector<HTMLButtonElement>("button")?.focus();
		wasConfirming.current = confirming;
	}, [confirming]);

	return (
		<li className="flex min-w-0 flex-col gap-2 px-3 py-2">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
					<span className="font-medium wrap-anywhere">{member.name}</span>
					{you ? <Badge>You</Badge> : null}
				</p>
				<span ref={menuSlot} className="flex flex-none">
					<Menu
						label={`Actions for ${member.name}`}
						icon={<EllipsisIcon />}
						align="end"
						entries={[
							{
								kind: "item",
								id: "reset-passkeys",
								label: "Reset passkeys",
								icon: <KeyRoundIcon />,
								disabled: confirming || resetting,
								onSelect: () => flow.askReset(member.userId),
							},
						]}
					/>
				</span>
			</div>
			{confirming ? (
				// biome-ignore lint/a11y/useSemanticElements: a confirmation inside a list row, not a form or a fieldset.
				<div
					className="flex flex-col gap-2 rounded-control border border-status-error-line bg-status-error-soft px-3 py-2.5"
					role="group"
					aria-label={`Reset passkeys for ${member.name}`}
				>
					<p className="wrap-anywhere">
						{you
							? "Reset your own passkeys? Kantel removes every passkey you have, and you can set up a new one on the connection request page."
							: `Reset ${member.name}'s passkeys? Kantel removes every passkey they have, and they can set up a new one on the connection request page. Do this only once you know it's them asking.`}
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="xs" variant="danger" busy={resetting} onClick={() => void flow.reset()}>
							Reset passkeys
						</Button>
						<Button
							ref={cancelButton}
							size="xs"
							variant="ghost"
							disabled={resetting}
							onClick={() => flow.cancelReset()}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : null}
			{problem === undefined ? null : (
				<p className="text-xs text-status-error" role="alert">
					{problemText(problem, "reset")}
				</p>
			)}
			{done === undefined ? null : (
				<p className="text-xs text-muted" role="status">
					{resetText(member.name, done.removed)}
				</p>
			)}
		</li>
	);
}
