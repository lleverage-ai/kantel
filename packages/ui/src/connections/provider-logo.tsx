// A service's logo, as itself: no tile around it, on whatever the page is. A logo with its own background (most
// favicons: Linear's dark square, GitHub's white one) shows that background, its corners rounded like an app's icon,
// with a hairline edge in the theme's text colour (`--kt-logo-edge`) so a white square doesn't melt into a light page
// or a dark one into a dark page.
//
// A mark drawn on nothing in a dark ink (GitHub's octocat, Vercel's triangle, Sentry's aubergine) would vanish on a dark
// page, and one in a light ink on a light page. When the page can read the logo's pixels (a data: URL, or its own
// origin) it looks for one, and the theme shows it lightened or darkened as it needs (`--kt-logo-dark-mark`,
// `--kt-logo-light-mark`: a lightness flip that keeps the hue on a theme of the other kind, nothing on its own kind), so
// a theme switch needs no new look. A logo from another origin can't be read, and keeps the edge.
//
// With no logo (a custom service, an MCP server added by URL) a tile on the sunken surface shows a line icon or the
// name's first letter instead.

import { type ReactNode, useState } from "react";

export type LogoSize = "xs" | "sm" | "md" | "lg";

const BOX: Record<LogoSize, string> = {
	xs: "size-5 rounded-xs",
	sm: "size-8 rounded-sm",
	md: "size-10 rounded-control",
	lg: "size-14 rounded-panel",
};

const LETTER: Record<LogoSize, string> = { xs: "text-2xs", sm: "text-sm", md: "text-md", lg: "text-lg" };

/** A mark's ink, once read: dark or light on nothing, or neither (a background of its own, colours, or unreadable). */
export type MarkInk = "dark" | "light" | undefined;

const INK_CLASS = {
	dark: "filter-(--kt-logo-dark-mark)",
	light: "filter-(--kt-logo-light-mark)",
	none: "drop-shadow-logo",
} as const;

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
	/** What shows without a logo: a line icon, else the name's first letter. */
	fallback?: ReactNode;
}) {
	// A logo that fails to load falls back as if there were none.
	const [broken, setBroken] = useState(false);
	const [ink, setInk] = useState<MarkInk>();
	if (icon !== undefined && !broken)
		return (
			<img
				src={icon}
				alt=""
				className={`kt-provider-logo ${BOX[size]} block shrink-0 object-contain ${INK_CLASS[ink ?? "none"]}`}
				data-ink={ink}
				onLoad={(event) => setInk(markInk(event.currentTarget))}
				onError={() => setBroken(true)}
			/>
		);
	return (
		<span
			className={`kt-provider-logo ${BOX[size]} box-border flex shrink-0 items-center justify-center border border-border bg-sunken font-strong text-muted ${LETTER[size]}`}
			aria-hidden="true"
		>
			{fallback ?? name.trim().charAt(0).toUpperCase()}
		</span>
	);
}

/** The grid a logo is read at: enough to see its corners and its ink. */
const SAMPLE = 32;

/**
 * Whether a loaded logo is a mark on nothing in a dark or a light ink: its corners clear, and what it draws dark or
 * light on average (relative luminance). Undefined when it has a background of its own, is in middling colours, or
 * can't be read (another origin's image taints the canvas).
 */
export function markInk(image: HTMLImageElement): MarkInk {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = SAMPLE;
		canvas.height = SAMPLE;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (context === null) return undefined;
		context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
		return inkOf(context.getImageData(0, 0, SAMPLE, SAMPLE).data, SAMPLE);
	} catch {
		return undefined;
	}
}

/** `markInk` on RGBA pixels, `size` square. */
export function inkOf(pixels: ArrayLike<number>, size: number): MarkInk {
	const alpha = (x: number, y: number) => pixels[(y * size + x) * 4 + 3] ?? 0;
	const last = size - 1;
	if ([alpha(0, 0), alpha(last, 0), alpha(0, last), alpha(last, last)].some((value) => value > 24)) return undefined;
	let drawn = 0;
	let luminance = 0;
	for (let index = 0; index < pixels.length; index += 4) {
		if ((pixels[index + 3] ?? 0) < 128) continue;
		drawn += 1;
		luminance +=
			(0.2126 * (pixels[index] ?? 0) + 0.7152 * (pixels[index + 1] ?? 0) + 0.0722 * (pixels[index + 2] ?? 0)) / 255;
	}
	if (drawn === 0) return undefined;
	const mean = luminance / drawn;
	return mean < DARK ? "dark" : mean > LIGHT ? "light" : undefined;
}

/** Below this mean luminance a mark reads as dark ink; above `LIGHT`, as light. Between, it reads on both kinds. */
const DARK = 0.3;
const LIGHT = 0.8;
