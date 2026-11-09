/** Compact human output: aligned tables and key–value lists, ages, sizes and money. */

/** Rows under a header, columns padded to line up, two spaces apart. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
	const all = [header, ...rows];
	const widths = header.map((_, column) => Math.max(...all.map((row) => (row[column] ?? "").length)));
	return all
		.map((row) =>
			row
				.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

/** `key  value` lines, keys padded; a row with no value is left out. */
export function fields(rows: readonly (readonly [string, string | undefined])[]): string {
	const shown = rows.filter((row): row is readonly [string, string] => row[1] !== undefined && row[1] !== "");
	const width = Math.max(0, ...shown.map(([key]) => key.length));
	return shown.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}

function span(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

/** How long ago an epoch-millisecond time was, such as `5m ago`. */
export function ago(at: number, now = Date.now()): string {
	const seconds = (now - at) / 1000;
	return seconds < 5 ? "just now" : `${span(seconds)} ago`;
}

/** How long until an epoch-millisecond time, such as `in 42m`. */
export function until(at: number, now = Date.now()): string {
	const seconds = (at - now) / 1000;
	return seconds <= 0 ? "now" : `in ${span(seconds)}`;
}

/** A duration in seconds, such as `1h 5m`. */
export function duration(seconds: number): string {
	const whole = Math.round(seconds);
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${whole % 60}s`;
	return `${whole}s`;
}

/** A size in bytes, such as `1.5 MiB`. */
export function bytes(size: number): string {
	if (size < 1024) return `${size} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = size / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "TiB"}`;
}

/** An amount of money, such as `0.12 USD`; under 1, to a tenth of a cent (`0.035 USD`), so a small rate isn't rounded. */
export function money(amount: number, currency: string): string {
	return `${amount.toFixed(amount > 0 && amount < 1 ? 3 : 2)} ${currency}`;
}

/** A time as `2026-11-03 14:05 UTC`. */
export function timestamp(at: number): string {
	return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
