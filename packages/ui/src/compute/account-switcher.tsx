// The account switcher (compute console, experimental): at the top of the console's sidebar, the account whose
// sandboxes the console shows, and a menu of the others to switch to. The personal account comes first, then the
// organisations with the viewer's role in each, the current one ticked, then making or joining an organisation. On the
// CreateOrganisationDialog and JoinOrganisationDialog are what its
// last two rows open; the host opens them, so a page can open them too. On a phone it is in the top bar, the same row.

import { useEffect, useState } from "react";
import { initials } from "../identity/signed-in-as.tsx";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PlusIcon } from "../primitives/icons.tsx";
import { ExpandIcon, InviteIcon, OrganisationIcon, PersonIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import type { AccountKind, AccountRole, ComputeAccount } from "./compute-model.ts";
import { messageOf } from "./parts.tsx";

export const ACCOUNT_ROLE_LABELS: Readonly<Record<AccountRole, string>> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
};

export const ACCOUNT_KIND_LABELS: Readonly<Record<AccountKind, string>> = {
	personal: "Personal",
	organisation: "Organisation",
};

/** An account's short name: lowercase letters, digits and dashes, starting and ending with a letter or digit. */
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** "Eval lab" to "eval-lab", "Café Ünïon" to "cafe-union": the slug a name suggests, up to 40 characters. */
export function slugFromName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 40)
		.replace(/-+$/, "");
}

const KindIcon = ({ kind }: { kind: AccountKind }) =>
	kind === "personal" ? <PersonIcon size="sm" /> : <OrganisationIcon size="sm" />;

/** The account's initials: round for a person, square for an organisation. */
export function AccountMark({ account }: { account: Pick<ComputeAccount, "kind" | "name"> }) {
	return (
		<span
			className={`kt-account-mark inline-grid size-control-sm flex-none place-items-center border border-border-strong bg-raised text-2xs font-strong leading-none text-fg ${
				account.kind === "personal" ? "rounded-full" : "rounded-control"
			}`}
			aria-hidden="true"
		>
			{initials(account.name)}
		</span>
	);
}

export interface AccountSwitcherProps {
	readonly accounts: readonly ComputeAccount[];
	readonly current: ComputeAccount;
	readonly onSwitch: (account: ComputeAccount) => void;
	readonly onCreate: () => void;
	readonly onJoin: () => void;
	/** Open the menu on mount, for a story. */
	readonly defaultOpen?: boolean;
}

/** The trigger: the account's mark and name, filling the room it is given. */
const trigger =
	"kt-account-switcher flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-1.5 py-1 text-left [font-family:inherit] text-fg hover:bg-hover aria-expanded:bg-hover";

/** The account the console shows, and a menu to switch to another, make an organisation or join one. */
export function AccountSwitcher({
	accounts,
	current,
	onSwitch,
	onCreate,
	onJoin,
	defaultOpen = false,
}: AccountSwitcherProps) {
	const ordered = [
		...accounts.filter((account) => account.kind === "personal"),
		...accounts.filter((account) => account.kind === "organisation"),
	];
	const accountEntry = (account: ComputeAccount): MenuEntry => ({
		kind: "item",
		id: `account-${account.id}`,
		label: account.name,
		icon: <KindIcon kind={account.kind} />,
		detail: account.kind === "personal" ? ACCOUNT_KIND_LABELS.personal : ACCOUNT_ROLE_LABELS[account.role],
		checked: account.id === current.id,
		onSelect: () => {
			if (account.id !== current.id) onSwitch(account);
		},
	});
	const personal = ordered.filter((account) => account.kind === "personal");
	const organisations = ordered.filter((account) => account.kind === "organisation");
	const entries: MenuEntry[] = [
		...personal.map(accountEntry),
		...(personal.length > 0 && organisations.length > 0
			? [{ kind: "separator" as const, id: "sep-organisations" }]
			: []),
		...organisations.map(accountEntry),
		{ kind: "separator", id: "sep-actions" },
		{ kind: "item", id: "create", label: "Create an organisation", icon: <PlusIcon size="sm" />, onSelect: onCreate },
		{ kind: "item", id: "join", label: "Join with an invite code", icon: <InviteIcon size="sm" />, onSelect: onJoin },
	];
	const kind = ACCOUNT_KIND_LABELS[current.kind];
	return (
		<Menu
			label="Switch account"
			entries={entries}
			defaultOpen={defaultOpen}
			triggerClassName={trigger}
			trigger={
				<>
					<AccountMark account={current} />
					<span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{current.name}</span>
					<span className="kt-sr-only">, {kind}</span>
					<ExpandIcon className="flex-none text-faint" />
				</>
			}
		/>
	);
}

/** Makes an organisation: its name and the slug in its sandboxes' addresses, which follows the name until edited. */
export function CreateOrganisationDialog({
	open,
	onClose,
	onCreate,
}: {
	open: boolean;
	onClose: () => void;
	onCreate: (input: { name: string; slug: string }) => Promise<unknown>;
}) {
	const [name, setName] = useState("");
	// Undefined until the slug is edited: until then it follows the name.
	const [editedSlug, setEditedSlug] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const slug = editedSlug ?? slugFromName(name);
	const slugValid = SLUG_PATTERN.test(slug);
	const ready = name.trim() !== "" && slugValid;
	const close = () => {
		setName("");
		setEditedSlug(undefined);
		setFailure(undefined);
		onClose();
	};
	const submit = () => {
		if (!ready || busy) return;
		setBusy(true);
		setFailure(undefined);
		onCreate({ name: name.trim(), slug }).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't create the organisation. Try again."));
			},
		);
	};
	return (
		<Dialog
			open={open}
			title="Create an organisation"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={!ready}>
						Create
					</Button>
				</>
			}
		>
			<p>
				An organisation's sandboxes, snapshots, keys and settings are shared with everyone in it. You'll be its owner,
				and can invite people once it's made.
			</p>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name"
					value={name}
					onChange={(event) => {
						setName(event.currentTarget.value);
						setFailure(undefined);
					}}
					placeholder="Acme research"
					autoComplete="organization"
				/>
				<TextField
					label="Slug"
					hint={`Lowercase letters, digits and dashes. Its sandboxes' addresses are <sandbox>.${slug === "" ? "<slug>" : slug}.`}
					value={slug}
					onChange={(event) => {
						setEditedSlug(event.currentTarget.value.toLowerCase());
						setFailure(undefined);
					}}
					placeholder="acme-research"
					mono
					{...(slug === "" || slugValid
						? {}
						: {
								error:
									"Use lowercase letters, digits and dashes, up to 40, starting and ending with a letter or digit.",
							})}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/**
 * Joins an organisation with the code from an invite. What goes wrong shows in the dialog; an invite made for another
 * email (refused as `forbidden`, naming both emails) offers Sign out, to sign in as the one it was made for.
 */
export function JoinOrganisationDialog({
	open,
	onClose,
	onJoin,
	onSignOut,
	initialCode,
}: {
	open: boolean;
	onClose: () => void;
	onJoin: (code: string) => Promise<unknown>;
	/** Signs the person out; offered when the invite is for someone else. */
	onSignOut?: () => void;
	/** The code it opens with: an invite email's link's. */
	initialCode?: string;
}) {
	const [code, setCode] = useState("");
	useEffect(() => {
		if (open && initialCode !== undefined) setCode(initialCode);
	}, [open, initialCode]);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ readonly text: string; readonly otherPerson: boolean }>();
	const close = () => {
		setCode("");
		setFailure(undefined);
		onClose();
	};
	const submit = () => {
		if (code.trim() === "" || busy) return;
		setBusy(true);
		setFailure(undefined);
		onJoin(code.trim()).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure({
					text: messageOf(caught, "Kantel couldn't join with that code. Try again."),
					otherPerson: (caught as { readonly code?: unknown } | null)?.code === "forbidden",
				});
			},
		);
	};
	return (
		<Dialog
			open={open}
			title="Join an organisation"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={code.trim() === ""}>
						Join
					</Button>
				</>
			}
		>
			<p>Paste the code from your invite. Once you join, you can use the organisation's sandboxes.</p>
			<div className="w-(--kt-card-width) max-w-full pt-2">
				<TextField
					label="Invite code"
					value={code}
					onChange={(event) => {
						setCode(event.currentTarget.value);
						setFailure(undefined);
					}}
					placeholder="kji_4f8a2c91"
					autoComplete="off"
					spellCheck={false}
					mono
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure.text}</p>}
			{failure?.otherPerson === true && onSignOut !== undefined ? (
				<div className="pt-2">
					<Button size="sm" onClick={onSignOut}>
						Sign out
					</Button>
				</div>
			) : null}
		</Dialog>
	);
}
