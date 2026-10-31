// A service's setup tier (#325), as a label on its catalogue card and its own page: how much there is to do before
// anyone can connect it. Ready tiers read as a quiet line with a coloured mark; the two that still need an app
// registered sit in a dashed outline, the shape of a step not taken yet.

import type { ReactNode } from "react";
import {
	AppWindowIcon,
	GuidedSetupIcon,
	KeyRoundIcon,
	NoSetupIcon,
	OrganisationIcon,
	PersonIcon,
	PlugIcon,
	SignInCodeIcon,
} from "../primitives/lucide.tsx";
import {
	type ConnectionsViewer,
	type ProviderTemplate,
	type TierLabel,
	type TierLook,
	tierLabel,
} from "./connections-model.ts";

const ICONS: Record<TierLook, ReactNode> = {
	none: <NoSetupIcon size="sm" />,
	code: <SignInCodeIcon size="sm" />,
	browser: <PlugIcon size="sm" />,
	provided: <OrganisationIcon size="sm" />,
	own: <PersonIcon size="sm" />,
	guided: <GuidedSetupIcon size="sm" />,
	needs_app: <AppWindowIcon size="sm" />,
	key: <KeyRoundIcon size="sm" />,
};

/** The mark's colour: green for nothing to do, the accent where Harbour does the work with you, quiet otherwise. */
const MARK: Record<TierLook, string> = {
	none: "text-status-done",
	code: "text-accent-text",
	browser: "text-accent-text",
	provided: "text-muted",
	own: "text-muted",
	guided: "text-accent-text",
	needs_app: "text-faint",
	key: "text-muted",
};

/** Still to do: an app to register first. */
const todo = (look: TierLook) => look === "guided" || look === "needs_app";

export interface SetupTierLabelProps {
	readonly template: ProviderTemplate;
	readonly viewer?: Pick<ConnectionsViewer, "host"> | undefined;
	/** `inline` on a card's foot; `pill` in a service's header, beside its other badges. */
	readonly variant?: "inline" | "pill";
	/** The label worked out already. */
	readonly label?: TierLabel;
}

export function SetupTierLabel({ template, viewer, variant = "inline", label }: SetupTierLabelProps) {
	const tier = label ?? tierLabel(template, viewer);
	const pending = todo(tier.look);
	const shape =
		variant === "pill" || pending
			? `rounded-full border px-2 py-0.5 ${pending ? "border-dashed border-border-strong" : "border-border bg-sunken"}`
			: "";
	const text = tier.look === "needs_app" ? "text-faint" : pending ? "text-fg" : "text-muted";
	return (
		<span
			className={`inline-flex min-w-0 items-center gap-1.5 text-xs leading-tight whitespace-nowrap ${shape} ${text}`}
			title={tier.detail}
			data-tier={tier.look}
		>
			<span className={`flex shrink-0 ${MARK[tier.look]}`}>{ICONS[tier.look]}</span>
			<span className="truncate">{tier.text}</span>
		</span>
	);
}
