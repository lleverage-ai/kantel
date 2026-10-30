/**
 * Colour arithmetic for checking themes: WCAG contrast between two colours, and how far apart two colours look
 * (OKLab distance), for telling status colours apart. Plain `#rrggbb` only. Used by the theme tests and by
 * `checkTheme`, which a custom-theme editor can show beside its fields.
 */

type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb | undefined {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (match === null) return undefined;
	return [
		Number.parseInt(match[1] as string, 16),
		Number.parseInt(match[2] as string, 16),
		Number.parseInt(match[3] as string, 16),
	];
}

const linear = (channel: number): number => {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2 relative luminance. */
export function luminance(hex: string): number {
	const rgb = parseHex(hex);
	if (rgb === undefined) return Number.NaN;
	return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** OKLab coordinates of a colour. */
export function oklab(hex: string): Rgb {
	const rgb = parseHex(hex);
	if (rgb === undefined) return [Number.NaN, Number.NaN, Number.NaN];
	const [r, g, b] = rgb.map(linear) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** How far apart two colours look, in OKLab: about 0.02 is a just-visible difference; 0.1 is clearly different. */
export function distance(a: string, b: string): number {
	const [l1, a1, b1] = oklab(a);
	const [l2, a2, b2] = oklab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
