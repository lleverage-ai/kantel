// Time formatting for every component that shows a time, so the platform says it one way.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "now", "4m", "3h", "2d", "5w": T3 Code's compact relative time, with no "ago". */
export function compactAge(at: number, now: number): string {
	const age = Math.max(0, now - at);
	if (age < MINUTE) return "now";
	if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
	if (age < DAY) return `${Math.floor(age / HOUR)}h`;
	if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
	return `${Math.floor(age / (7 * DAY))}w`;
}

/** "45s", "3m 20s", "1h 5m": an elapsed duration, as in "Working for 3m 20s". */
export function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "numeric", year: "numeric" });
const startOfDay = (time: number): number => {
	const date = new Date(time);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/**
 * When something happened, by the clock and aware of the day, after T3 Code's timeline timestamp: "16:38" today,
 * "Yesterday at 16:38", "26/10 16:38" earlier this year and "26/10/2025 16:38" before that. Local time.
 */
export function clockTime(at: number, now: number): string {
	const time = clock.format(at);
	// Rounded, so a day either side of a clock change still counts as one day.
	const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
	if (days <= 0) return time;
	if (days === 1) return `Yesterday at ${time}`;
	const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
	return `${(sameYear ? dayMonth : dayMonthYear).format(at)} ${time}`;
}

/** "14:59 left", "2h 10m left", or "Expired". */
export function timeLeft(expiresAt: number, now: number): string {
	const left = expiresAt - now;
	if (left <= 0) return "Expired";
	const seconds = Math.ceil(left / 1000);
	if (seconds < HOUR / 1000) {
		const minutes = Math.floor(seconds / 60);
		return `${minutes}:${String(seconds % 60).padStart(2, "0")} left`;
	}
	return `${duration(left)} left`;
}

/** "1.2 GB", "340 MB", "12 KB". */
export function bytesText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
