// Profile (compute console, under Settings): who is signed in, the theme, their personal access tokens, and deleting
// the account. The name and email come from sign-in and can't be changed here; the theme is the same System, Light or
// Dark as in your menu.

import type { ThemePreference } from "@kantel/contracts";
import { useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField } from "../primitives/form-layout.tsx";
import { ThemeSwitch } from "../theme/theme-switch.tsx";
import type { ComputeAccount, PersonalTokensSource } from "./compute-model.ts";
import { computePage, messageOf, SectionHeading } from "./parts.tsx";
import { PersonalTokensSection } from "./personal-tokens.tsx";
import { SettingsPageHeader } from "./settings-nav.tsx";

export interface ProfilePageProps {
	readonly name: string;
	readonly email?: string;
	/** A phone. */
	readonly narrow?: boolean;
	/** A theme was chosen and applied: the host keeps it for the person. */
	readonly onThemeChoose?: (preference: ThemePreference) => void;
	/** Deletes the person's account; Delete account shows only with it. Rejects with why it couldn't. */
	readonly onDeleteAccount?: () => Promise<void>;
	/** Their personal access tokens; the section shows only with it. */
	readonly tokens?: PersonalTokensSource;
	/** Their accounts, which a token may be limited to. */
	readonly accounts?: readonly ComputeAccount[];
	/** A fixed time, for stories. */
	readonly now?: number;
}

/** A label and its value, read only, laid out as a field's label is. */
function Fact({ label, children }: { label: string; children: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="text-sm leading-normal text-muted">{label}</dt>
			<dd className="m-0 truncate text-sm text-fg">{children}</dd>
		</div>
	);
}

export function ProfilePage({
	name,
	email,
	narrow = false,
	onThemeChoose,
	onDeleteAccount,
	tokens,
	accounts = [],
	now,
}: ProfilePageProps) {
	const themeId = useId();
	const headingId = useId();
	const [deleting, setDeleting] = useState(false);
	return (
		<div className={computePage}>
			<SettingsPageHeader title="Profile" narrow={narrow} />
			<dl className="m-0 flex min-w-0 flex-col gap-4">
				<Fact label="Name">{name}</Fact>
				{email === undefined || email === "" ? null : <Fact label="Email">{email}</Fact>}
			</dl>
			<FormField id={themeId} label="Theme">
				<ThemeSwitch {...(onThemeChoose === undefined ? {} : { onChoose: onThemeChoose })} />
			</FormField>
			{tokens === undefined ? null : (
				<PersonalTokensSection
					source={tokens}
					accounts={accounts}
					narrow={narrow}
					{...(now === undefined ? {} : { now })}
				/>
			)}
			{onDeleteAccount === undefined ? null : (
				<section className="flex min-w-0 flex-col gap-2 pt-4" aria-labelledby={headingId}>
					<SectionHeading id={headingId} title="Delete account" />
					{/* A card as Leave is on an organisation's page, with the solid red button kept for the dialog. */}
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-panel border border-border bg-raised px-4 py-3">
						<p className="m-0 min-w-0 text-sm text-muted">
							Removes your personal account, its hosts, your API keys and personal tokens, and takes you out of every
							organisation.
						</p>
						<Button variant="danger-quiet" onClick={() => setDeleting(true)}>
							Delete account
						</Button>
					</div>
					<DeleteAccountDialog open={deleting} onClose={() => setDeleting(false)} onDelete={onDeleteAccount} />
				</section>
			)}
		</div>
	);
}

function DeleteAccountDialog({
	open,
	onClose,
	onDelete,
}: {
	open: boolean;
	onClose: () => void;
	onDelete: () => Promise<void>;
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
			title="Delete your account?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							setBusy(true);
							setFailure(undefined);
							onDelete().then(
								() => setBusy(false),
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete your account. Try again."));
								},
							);
						}}
					>
						Delete account
					</Button>
				</>
			}
		>
			<p>
				Your personal account goes, with its hosts, environments, webhooks and templates. Every API key you made and
				every personal token stops working, you leave every organisation, and you're signed out everywhere. This can't
				be undone.
			</p>
			<p>
				Delete your own sandboxes, saved snapshots and bundles first. If you're an organisation's last owner, make
				someone else an owner or delete it.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
