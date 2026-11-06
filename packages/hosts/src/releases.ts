// The newest kantel-host Kantel has released, which the control plane compares each host's version with, so the
// console can say a host is out of date and offer to update it. Read from Kantel's latest stable GitHub Release (or a
// mirror), at most once an hour; a failed read is tried again after a few minutes, and never stops anything: without
// an answer, no host is said to be out of date.
//
// A check (`HostReleases.check`) reads it again at once: the release workflow asks for one when it publishes a release
// (`POST /v1/hosts/releases/check`), and a super-admin's Check for updates does too. It never takes a version from
// whoever asked, only what the release URL names. Checks are recorded in a store every reader shares (a row in SQL),
// so a check that one replica or object made makes every other reader read again too; and one is made at most every
// `CHECK_GAP_MS`, so asking again (a retried workflow step) does nothing more.
import type { SqlDriver } from "@kantel/sql";

/**
 * Kantel's latest stable release: GitHub redirects it to the release's tag (`…/releases/tag/v0.4.2`). Read from the
 * redirect rather than GitHub's API, whose unauthenticated limit (60 an hour an IP) a Cloudflare Worker shares with
 * every other tenant on its egress IPs, and so often finds spent.
 */
export const DEFAULT_HOST_RELEASES_URL = "https://github.com/lleverage-ai/kantel/releases/latest";

/** Where a host fetches a version of kantel-host: that version's GitHub Release, checked against its SHA256SUMS. */
export const DEFAULT_HOST_UPDATE_URL =
	"https://github.com/lleverage-ai/kantel/releases/download/v{version}/kantel-host-{os}-{arch}";

export interface HostReleases {
	/** The newest version, read if what's kept is stale; undefined when it can't be read. */
	latest(): Promise<string | undefined>;
	/** The newest version as kept now, without waiting; a stale one starts a read for next time. */
	known(): string | undefined;
	/**
	 * Reads the newest version again now, whatever is kept, and has every reader sharing the store read it again too.
	 * At most one check every `CHECK_GAP_MS` across them: within it, nothing is read and `checked` is false. Rejects
	 * when the read fails. Absent: the release is only read on its schedule.
	 */
	check?(): Promise<ReleaseCheck>;
}

/** What a check found. */
export interface ReleaseCheck {
	/** Whether this check read the release: false when another was made within `CHECK_GAP_MS`, whose answer stands. */
	readonly checked: boolean;
	/** The newest version known after it; absent when none has been read. */
	readonly latestVersion?: string;
}

/** The least time between two checks, across every reader sharing a store. */
export const CHECK_GAP_MS = 30_000;
/** How often a reader with a store looks for a check another made, while it's being asked. */
export const CHECK_POLL_MS = 10_000;

/**
 * What every reader of the latest release shares: when it was last checked (read again at once). The reader that
 * checks records it; the others see a newer check and read again themselves.
 */
export interface HostReleasesStore {
	/** When the latest check was made, by any reader; undefined before the first. */
	lastCheck(): Promise<number | undefined>;
	/** Records a check at `at`, unless one was recorded less than `gapMs` before it: whether this one was. Atomic. */
	claimCheck(at: number, gapMs: number): Promise<boolean>;
}

/** A store in memory: for one process, and tests. */
export function createMemoryHostReleasesStore(): HostReleasesStore {
	let last: number | undefined;
	return {
		async lastCheck() {
			return last;
		},
		async claimCheck(at, gapMs) {
			if (last !== undefined && at - last < gapMs) return false;
			last = at;
			return true;
		},
	};
}

/** The store's table, for SQLite and Postgres alike; `migrateHosts` makes it with the registry's. */
export function hostReleasesSchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS compute_host_release_checks (
			id TEXT PRIMARY KEY,
			checked_at ${real} NOT NULL
		)`,
	];
}

/** The store in SQL: one row, shared by every replica (Postgres) or by the stack object's requests (its SQLite). */
export function createSqlHostReleasesStore(driver: SqlDriver): HostReleasesStore {
	return {
		async lastCheck() {
			const [row] = await driver.query("SELECT checked_at FROM compute_host_release_checks WHERE id = 'latest'");
			if (row === undefined) return undefined;
			const at = Number(row.checked_at);
			return Number.isFinite(at) ? at : undefined;
		},
		async claimCheck(at, gapMs) {
			// One statement: two replicas claiming at once can't both win.
			const rows = await driver.query(
				`INSERT INTO compute_host_release_checks (id, checked_at) VALUES ('latest', ?)
				ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at
				WHERE compute_host_release_checks.checked_at <= ?
				RETURNING checked_at`,
				[at, at - gapMs],
			);
			return rows.length > 0;
		},
	};
}

export interface HostReleasesOptions {
	/** Default `DEFAULT_HOST_RELEASES_URL`. */
	readonly url?: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	/** How long an answer is kept: default an hour, which keeps well inside GitHub's 60 unauthenticated reads an hour. */
	readonly ttlMs?: number;
	/** How long a failed read waits before the next: default 5 minutes. */
	readonly retryMs?: number;
	/** How long `latest` waits for an answer: default 3 seconds. */
	readonly timeoutMs?: number;
	readonly log?: (message: string) => void;
	/**
	 * Where checks are recorded for every reader: the SQL store with several replicas or one object's many requests.
	 * Default one in memory, which only this reader sees.
	 */
	readonly store?: HostReleasesStore;
	/** Default `CHECK_GAP_MS`. */
	readonly checkGapMs?: number;
	/** Default `CHECK_POLL_MS`. */
	readonly checkPollMs?: number;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Compares two release versions (`0.4.2`, `v0.5.0-rc.1`): negative when `a` is older, positive when newer, 0 when
 * they're the same release. Undefined when either isn't a release version (`dev`, a commit), which can't be ordered.
 */
export function compareVersions(a: string, b: string): number | undefined {
	const left = VERSION.exec(a.trim());
	const right = VERSION.exec(b.trim());
	if (left === null || right === null) return undefined;
	for (const part of [1, 2, 3]) {
		const diff = Number(left[part]) - Number(right[part]);
		if (diff !== 0) return Math.sign(diff);
	}
	const [pre, other] = [left[4], right[4]];
	// A prerelease comes before its release.
	if (pre === undefined || other === undefined) return pre === other ? 0 : pre === undefined ? 1 : -1;
	const ids = pre.split(".");
	const otherIds = other.split(".");
	for (let i = 0; i < Math.max(ids.length, otherIds.length); i++) {
		const [x, y] = [ids[i], otherIds[i]];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const [nx, ny] = [/^\d+$/.test(x) ? Number(x) : undefined, /^\d+$/.test(y) ? Number(y) : undefined];
		if (nx !== undefined && ny !== undefined) {
			if (nx !== ny) return Math.sign(nx - ny);
		} else if (nx !== undefined || ny !== undefined) {
			return nx !== undefined ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/** A version as kantel-host's `{version}` takes it: without a leading `v`. */
export function plainVersion(version: string): string {
	return version.trim().replace(/^v(?=\d)/, "");
}

/**
 * Whether a host on `version` should move to `target`. A version the operator set (`pinned`, KANTEL_HOST_VERSION) is
 * the one hosts run, so any other is out of date, an older pin included. The latest release only moves a host that is
 * older than it: one on a newer prerelease or its own build (`dev`) is left alone.
 */
export function needsUpdate(version: string | undefined, target: string, pinned: boolean): boolean {
	if (version === undefined || version === "") return false;
	if (plainVersion(version) === plainVersion(target)) return false;
	if (pinned) return true;
	return (compareVersions(version, target) ?? 0) < 0;
}

/**
 * Reads the newest release from `url`: GitHub's `{tag_name}`, or a mirror's `{version}`. With a `store`, a check made
 * by any reader sharing it (`check`) has this one read again the next time it's asked, within `checkPollMs`.
 */
export function createHostReleases(options: HostReleasesOptions = {}): HostReleases {
	const url = options.url ?? DEFAULT_HOST_RELEASES_URL;
	const fetcher = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
	const retryMs = options.retryMs ?? 5 * 60 * 1000;
	const timeoutMs = options.timeoutMs ?? 3000;
	const store = options.store ?? createMemoryHostReleasesStore();
	const checkGapMs = options.checkGapMs ?? CHECK_GAP_MS;
	const checkPollMs = options.checkPollMs ?? CHECK_POLL_MS;
	const log = (error: unknown, what: string) =>
		options.log?.(`[hosts] couldn't ${what}: ${error instanceof Error ? error.message : error}`);
	let kept: string | undefined;
	/** When the next read is due. */
	let due = 0;
	/**
	 * Goes up each time what's kept goes stale before its time (a check, here or by another reader): a read that
	 * started before then doesn't count as fresh, and isn't shared with a read asked for after.
	 */
	let epoch = 0;
	let reading: { readonly epoch: number; readonly answer: Promise<ReadAnswer> } | undefined;
	/** The latest check this reader has acted on; a check older than this reader was made before its first read. */
	let seenCheck = now();
	let polledAt: number | undefined;
	let polling: Promise<void> | undefined;

	type ReadAnswer = { readonly version: string | undefined; readonly error?: unknown };

	const readOnce = async (): Promise<ReadAnswer> => {
		const get = (target: string, redirect: "manual" | "follow") =>
			fetcher(target, {
				headers: { accept: "application/json", "user-agent": "kantel-control-plane" },
				redirect,
				signal: AbortSignal.timeout(Math.max(timeoutMs, 10_000)),
			});
		// A redirect to a release's tag (GitHub's `…/releases/latest`) names its version, so it isn't followed; any
		// other redirect (a mirror moving its JSON) is, as an ordinary fetch would.
		let response = await get(url, "manual");
		const location = response.headers.get("location");
		const tag =
			response.status >= 300 && response.status < 400 && location !== null
				? /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1]
				: undefined;
		if (tag === undefined && location !== null && response.status >= 300 && response.status < 400) {
			response = await get(new URL(location, url).toString(), "follow");
		}
		let raw: unknown;
		if (tag !== undefined) {
			raw = decodeURIComponent(tag);
		} else {
			if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
			// A mirror's (or GitHub API's) JSON: `{"version"}` or `{"tag_name"}`.
			const body = (await response.json()) as { tag_name?: unknown; version?: unknown };
			raw = typeof body.tag_name === "string" ? body.tag_name : body.version;
		}
		if (typeof raw !== "string" || compareVersions(raw, raw) === undefined) {
			throw new Error(`${url} names no release version`);
		}
		return { version: plainVersion(raw) };
	};

	/** Reads the release: one read for everyone asking in the same epoch; a newer epoch's starts after an older one. */
	const read = (): Promise<ReadAnswer> => {
		if (reading !== undefined && reading.epoch === epoch) return reading.answer;
		const before = reading?.answer;
		const started = epoch;
		const answer = (async (): Promise<ReadAnswer> => {
			// An older read still running ends first, so it can't put back what it found over this one's.
			if (before !== undefined) await before;
			try {
				const found = await readOnce();
				kept = found.version;
				// Gone stale while it was read: the next ask reads again.
				due = epoch === started ? now() + ttlMs : 0;
				return found;
			} catch (error) {
				due = now() + retryMs;
				log(error, "read the latest kantel-host");
				return { version: kept, error };
			}
		})();
		const entry = { epoch: started, answer };
		reading = entry;
		void answer.finally(() => {
			if (reading === entry) reading = undefined;
		});
		return answer;
	};

	const stale = () => {
		epoch += 1;
		due = 0;
	};

	/** Looks for a check another reader made, at most every `checkPollMs`; one newer than what's acted on goes stale. */
	const poll = (): Promise<void> => {
		if (polling !== undefined) return polling;
		if (polledAt !== undefined && now() - polledAt < checkPollMs) return Promise.resolve();
		polledAt = now();
		polling = (async () => {
			try {
				const at = await store.lastCheck();
				if (at !== undefined && at > seenCheck) {
					seenCheck = at;
					stale();
				}
			} catch (error) {
				log(error, "look for a release check");
			}
		})().finally(() => {
			polling = undefined;
		});
		return polling;
	};

	return {
		async latest() {
			await poll();
			if (now() < due) return kept;
			const answer = read().then((found) => found.version);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<string | undefined>((resolve) => {
				timer = setTimeout(() => resolve(kept), timeoutMs);
			});
			try {
				return await Promise.race([answer, late]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		},
		known() {
			// A check another reader made starts a read here once it's seen, for a later ask: this one never waits.
			if (now() >= due) void read();
			void poll().then(() => {
				if (now() >= due) void read();
			});
			return kept;
		},
		async check() {
			const at = now();
			if (!(await store.claimCheck(at, checkGapMs))) {
				// Another reader's check stands. If this one hasn't acted on it yet, it reads now, so it answers what that found.
				const last = await store.lastCheck().catch(() => undefined);
				if (last !== undefined && last > seenCheck) {
					seenCheck = last;
					stale();
				}
				const version = now() < due ? kept : (await read()).version;
				return { checked: false, ...(version === undefined ? {} : { latestVersion: version }) };
			}
			// This reader acts on its own check now; the others see it in the store.
			if (at > seenCheck) seenCheck = at;
			stale();
			const found = await read();
			if (found.error !== undefined) {
				throw new Error(
					`Couldn't read the latest kantel-host release: ${found.error instanceof Error ? found.error.message : found.error}`,
				);
			}
			return { checked: true, ...(found.version === undefined ? {} : { latestVersion: found.version }) };
		},
	};
}
