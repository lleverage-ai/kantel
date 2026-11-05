// Your menu (compute console): at the foot of the sidebar, or your initials at the top right on a phone. Who is
// signed in, the theme, Profile, Docs, Admin on a phone (a wide screen has it in the sidebar) and Sign out.

import type { ThemePreference } from "@kantel/contracts";
import { initials } from "../identity/signed-in-as.tsx";
import { DocsIcon, ExpandIcon, PersonIcon, ServerIcon, SignOutIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { useThemeMenuEntry } from "../theme/theme-switch.tsx";

/** Your initials in a circle. */
const avatar =
	"kt-user-avatar inline-grid size-control-sm flex-none place-items-center rounded-full border border-border-strong bg-raised text-2xs font-strong leading-none text-fg";

/** The sidebar's row: avatar, name and the chevrons, the width of the sidebar. */
const rowTrigger =
	"kt-user-menu flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-1.5 py-1 text-left [font-family:inherit] text-sm text-fg hover:bg-hover aria-expanded:bg-hover";

/** The phone's: the avatar alone. */
const avatarTrigger =
	"kt-user-menu inline-grid size-control-lg flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0";

export interface UserMenuProps {
	/** Your name; undefined while it loads. */
	readonly name?: string;
	readonly email?: string;
	/** The avatar alone, for a phone's top bar. */
	readonly compact?: boolean;
	/** Opens Admin: shown here on a phone, where the sidebar's Admin isn't. */
	readonly onAdmin?: () => void;
	/** Opens your profile, under Settings. */
	readonly onProfile?: () => void;
	/** Where Kantel's docs are: they open in a new tab. Default kantel.dev's. */
	readonly docsHref?: string;
	/** Ends your session, when you can end it yourself. */
	readonly onSignOut?: () => void;
	/** A theme was chosen and applied: the app keeps it for you. */
	readonly onThemeChoose?: (preference: ThemePreference) => void;
	/** Open on mount, for a story. */
	readonly defaultOpen?: boolean;
}

/** Kantel's public docs. */
export const DOCS_HREF = "https://kantel.dev/docs/";

/** Your menu: who you are, the theme, Profile, Docs, Admin on a phone, Sign out. */
export function UserMenu({
	name,
	email,
	compact = false,
	onAdmin,
	onProfile,
	docsHref = DOCS_HREF,
	onSignOut,
	onThemeChoose,
	defaultOpen = false,
}: UserMenuProps) {
	const theme = useThemeMenuEntry(onThemeChoose === undefined ? {} : { onChoose: onThemeChoose });
	if (name === undefined) {
		return (
			<div className="flex min-w-0 items-center gap-2 px-1.5 py-1" aria-busy="true">
				<span className={avatar} aria-hidden="true" />
				{compact ? null : <Skeleton width="60%" />}
				<span className="kt-sr-only">Loading who is signed in</span>
			</div>
		);
	}
	const showEmail = email !== undefined && email !== "" && email !== name;
	const entries: MenuEntry[] = [
		{
			kind: "label",
			id: "you",
			label: name,
			...(showEmail ? { detail: email } : {}),
		},
		{ kind: "separator", id: "sep-you" },
		theme,
		...(onProfile === undefined
			? []
			: [{ kind: "item" as const, id: "profile", label: "Profile", icon: <PersonIcon />, onSelect: onProfile }]),
		{
			kind: "item",
			id: "docs",
			label: "Docs",
			icon: <DocsIcon />,
			onSelect: () => void globalThis.open?.(docsHref, "_blank", "noopener"),
		},
		...(onAdmin === undefined
			? []
			: [{ kind: "item" as const, id: "admin", label: "Admin", icon: <ServerIcon />, onSelect: onAdmin }]),
		...(onSignOut === undefined
			? []
			: [
					{ kind: "separator" as const, id: "sep-out" },
					{ kind: "item" as const, id: "sign-out", label: "Sign out", icon: <SignOutIcon />, onSelect: onSignOut },
				]),
	];
	const mark = (
		<span className={avatar} aria-hidden="true">
			{initials(name)}
		</span>
	);
	return (
		<Menu
			label="Your menu"
			entries={entries}
			align={compact ? "end" : "start"}
			defaultOpen={defaultOpen}
			triggerClassName={compact ? avatarTrigger : rowTrigger}
			trigger={
				compact ? (
					<>
						{mark}
						<span className="kt-sr-only">{name}</span>
					</>
				) : (
					<>
						{mark}
						<span className="min-w-0 flex-1 truncate font-medium">{name}</span>
						<ExpandIcon className="flex-none text-faint" />
					</>
				)
			}
		/>
	);
}
