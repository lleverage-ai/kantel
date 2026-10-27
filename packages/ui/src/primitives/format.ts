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
