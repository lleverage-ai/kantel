import type { ReactNode } from "react";
import { Button } from "../primitives/button.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import "./signed-in-as.css";

export interface SignedInAsProps {
	/** The person's name, as `GET /v1/me` gives it. Undefined while it loads. */
	readonly name?: string;
	/** Their email, shown under the name when it says something the name doesn't. */
	readonly email?: string;
	/** A short tag beside the name, such as a Badge saying sign-in is stubbed. */
	readonly badge?: ReactNode;
	/** Shown when the person can end their own session (an email code); Access ends it at the edge instead. */
	readonly onSignOut?: () => void;
	readonly signingOut?: boolean;
	/** Small controls for the person's own settings, before Sign out: the theme picker's button. */
	readonly actions?: ReactNode;
}

/** One or two letters for the avatar: the first letters of the first two words, or of the email's name. */
export function initials(name: string): string {
	const words = name
		.replace(/@.*$/, "")
		.split(/[\s._-]+/)
		.filter((word) => word !== "");
	const letters = words.length === 1 ? (words[0] ?? "").slice(0, 1) : words.slice(0, 2).map((word) => word[0]);
	return [...letters].join("").toUpperCase() || "?";
}

/**
 * Who is signed in, at the foot of the console's sidebar: an avatar with their initials, their name and, when it adds
 * something, their email. A sign-out button when the person can end their own session. Loading is a skeleton of the
 * same height, so the sidebar doesn't jump when the name arrives.
 */
export function SignedInAs({ name, email, badge, onSignOut, signingOut = false, actions }: SignedInAsProps) {
	if (name === undefined) {
		return (
			<div className="hb-signed-in-as" aria-busy="true">
				<span className="hb-signed-in-as-avatar hb-signed-in-as-avatar-empty" aria-hidden="true" />
				<span className="hb-signed-in-as-text">
					<Skeleton width="60%" />
				</span>
				<span className="hb-sr-only">Loading who is signed in</span>
			</div>
		);
	}
	const showEmail = email !== undefined && email !== "" && email !== name;
	return (
		<div className="hb-signed-in-as">
			<span className="hb-signed-in-as-avatar" aria-hidden="true">
				{initials(name)}
			</span>
			<span className="hb-signed-in-as-text">
				<span className="hb-sr-only">Signed in as </span>
				<span className="hb-signed-in-as-name" title={name}>
					{name}
				</span>
				{showEmail ? (
					<span className="hb-signed-in-as-email" title={email}>
						{email}
					</span>
				) : null}
			</span>
			{badge}
			{actions}
			{onSignOut === undefined ? null : (
				<Button variant="ghost" size="xs" busy={signingOut} onClick={onSignOut}>
					Sign out
				</Button>
			)}
		</div>
	);
}
