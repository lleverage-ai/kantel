// A service's logo on its tile. The tile is light in every theme (`--kt-logo-tile`), like an app's icon, so a logo in
// its own brand colours reads on a dark page as on a light one; a hairline keeps it from melting into a light theme.
// With no logo (a custom service, an MCP server added by URL) the tile shows a line icon or the name's first letter on
// the page's own sunken surface instead.

import { type ReactNode, useState } from "react";

export type LogoSize = "sm" | "md" | "lg";

const TILE: Record<LogoSize, string> = {
	sm: "size-8 rounded-sm p-1.5",
	md: "size-10 rounded-control p-2",
	lg: "size-14 rounded-panel p-3",
};

const LETTER: Record<LogoSize, string> = { sm: "text-sm", md: "text-md", lg: "text-lg" };

export function ProviderLogo({
	name,
	icon,
	size = "md",
	fallback,
}: {
	name: string;
	/** An https or data: URL. */
	icon?: string | undefined;
	size?: LogoSize;
	/** What a tile without a logo shows: a line icon, else the name's first letter. */
	fallback?: ReactNode;
}) {
	// A logo that fails to load falls back as if there were none.
	const [broken, setBroken] = useState(false);
	const tile = `${TILE[size]} box-border flex shrink-0 items-center justify-center overflow-hidden border border-border`;
	if (icon !== undefined && !broken)
		return (
			<span className={`${tile} bg-logo-tile`}>
				<img src={icon} alt="" className="block size-full object-contain" onError={() => setBroken(true)} />
			</span>
		);
	return (
		<span className={`${tile} bg-sunken font-strong text-muted ${LETTER[size]}`} aria-hidden="true">
			{fallback ?? name.trim().charAt(0).toUpperCase()}
		</span>
	);
}
