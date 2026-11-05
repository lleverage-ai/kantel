// The newest kantel-host Kantel has released, which the control plane compares each host's version with, so the
// console can say a host is out of date and offer to update it. Read from Kantel's latest stable GitHub Release (or a
// mirror), at most once an hour; a failed read is tried again after a few minutes, and never stops anything: without
// an answer, no host is said to be out of date.

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

/** Reads the newest release from `url`: GitHub's `{tag_name}`, or a mirror's `{version}`. */
export function createHostReleases(options: HostReleasesOptions = {}): HostReleases {
	const url = options.url ?? DEFAULT_HOST_RELEASES_URL;
	const fetcher = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
	const retryMs = options.retryMs ?? 5 * 60 * 1000;
	const timeoutMs = options.timeoutMs ?? 3000;
	let kept: string | undefined;
	/** When the next read is due. */
	let due = 0;
	let reading: Promise<string | undefined> | undefined;

	const read = (): Promise<string | undefined> => {
		reading ??= (async () => {
			try {
				const response = await fetcher(url, {
					headers: { accept: "application/json", "user-agent": "kantel-control-plane" },
					// A redirect to a release's tag names its version, so it isn't followed.
					redirect: "manual",
					signal: AbortSignal.timeout(Math.max(timeoutMs, 10_000)),
				});
				const location = response.headers.get("location");
				let raw: unknown;
				if (response.status >= 300 && response.status < 400 && location !== null) {
					raw = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
					if (raw !== undefined) raw = decodeURIComponent(raw as string);
				} else {
					if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
					// A mirror's (or GitHub API's) JSON: `{"version"}` or `{"tag_name"}`.
					const body = (await response.json()) as { tag_name?: unknown; version?: unknown };
					raw = typeof body.tag_name === "string" ? body.tag_name : body.version;
				}
				if (typeof raw !== "string" || compareVersions(raw, raw) === undefined) {
					throw new Error(`${url} names no release version`);
				}
				kept = plainVersion(raw);
				due = now() + ttlMs;
			} catch (error) {
				due = now() + retryMs;
				options.log?.(
					`[hosts] couldn't read the latest kantel-host: ${error instanceof Error ? error.message : error}`,
				);
			}
			return kept;
		})().finally(() => {
			reading = undefined;
		});
		return reading;
	};

	return {
		async latest() {
			if (now() < due) return kept;
			const answer = read();
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
			if (now() >= due) void read();
			return kept;
		},
	};
}
