// Profile (compute console, under Settings): who is signed in, and the theme. The name and email come from sign-in and
// can't be changed here; the theme is the same System, Light or Dark as in your menu.

import type { ThemePreference } from "@kantel/contracts";
import { useId } from "react";
import { FormField } from "../primitives/form-layout.tsx";
import { ThemeSwitch } from "../theme/theme-switch.tsx";
import { computePage } from "./parts.tsx";
import { SettingsPageHeader } from "./settings-nav.tsx";

export interface ProfilePageProps {
	readonly name: string;
	readonly email?: string;
	/** A phone. */
	readonly narrow?: boolean;
	/** A theme was chosen and applied: the host keeps it for the person. */
	readonly onThemeChoose?: (preference: ThemePreference) => void;
}

/** A label and its value, read only, laid out as a field's label is. */
function Fact({ label, children }: { label: string; children: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="text-xs leading-normal text-muted">{label}</dt>
			<dd className="m-0 truncate text-sm text-fg">{children}</dd>
		</div>
	);
}

export function ProfilePage({ name, email, narrow = false, onThemeChoose }: ProfilePageProps) {
	const themeId = useId();
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
		</div>
	);
}
