/**
 * A GitHub App, as the runner broker (`github-runners.ts`) uses it: its JWT, an installation's access token, a
 * just-in-time runner configuration, a runner's removal, a webhook's signature, and what reconciling with GitHub reads
 * (an installation's repositories, their queued jobs, the App's failed deliveries). Web Crypto and `fetch` only, so it
 * runs on every gateway (Node and Workers).
 */
import { KantelError } from "@kantel/contracts";
import { base64ToBytes, bytesToBase64 } from "./util.ts";

export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** An imported signing key (Web Crypto's `CryptoKey`, which the lib this builds with doesn't name as a type). */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
/** How long an App JWT lasts: GitHub takes at most 10 minutes; issued a minute back for clock drift. */
const JWT_TTL_SECONDS = 9 * 60;
/** An installation token is used until this long before it expires (GitHub's last an hour). */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** How long a call to GitHub may take: a broker's pass holds its integration's lease while it waits. */
const CALL_TIMEOUT_MS = 15_000;
/**
 * The share of an installation's hourly rate limit that reconciling leaves for everything else: it stops (`exhausted`)
 * once fewer requests than this remain, until the limit resets. Registering and removing runners never stop for it.
 */
const RECONCILE_RESERVE = 0.25;
/** The fewest requests reconciling leaves, however small the installation's limit. */
const RECONCILE_RESERVE_MIN = 500;
/** How many pages of an installation's repositories are read, 100 each. */
const REPOSITORY_PAGES = 10;
/** How many conditional reads' answers are kept for their ETags (`If-None-Match`): a 304 costs no rate limit. */
const ETAG_CACHE_SIZE = 1000;
/** How many pages of a repository's runs of one status, and of a run's jobs, are read, 100 each. */
const RUN_PAGES = 5;
/** How many pages of the App's installations are read, 100 each, to find an owner's. */
const INSTALLATION_PAGES = 5;

export interface GithubAppCredentials {
	readonly appId: number;
	/** The App's private key, PEM: PKCS #1 (`BEGIN RSA PRIVATE KEY`, as GitHub gives it) or PKCS #8. */
	readonly privateKey: string;
}

export interface JitRunner {
	readonly runnerId: number;
	readonly encodedJitConfig: string;
}

/** Where runners are registered: an organization's runner group, or a repository (`owner/name`). */
export type RunnerScope =
	| { readonly kind: "organization"; readonly org: string; readonly runnerGroupId: number }
	| { readonly kind: "repository"; readonly repository: string };

/** A job GitHub has queued, as reconciling finds it. */
export interface QueuedJob {
	readonly id: number;
	readonly runId: number;
	readonly name: string;
	readonly labels: readonly string[];
	/** When GitHub made it, in milliseconds; undefined when GitHub didn't say. */
	readonly createdAt?: number;
}

/** An App webhook delivery that never got a 2xx answer. */
export interface FailedDelivery {
	/** Its latest attempt's ID: what a redelivery names. */
	readonly id: number;
	readonly guid: string;
	readonly event: string;
	readonly action?: string;
	readonly installationId?: number;
	readonly deliveredAt: number;
}

export interface GithubApp {
	/** Registers a just-in-time runner that takes one job with every one of `labels`, and answers its configuration. */
	generateJitConfig(
		installationId: number,
		scope: RunnerScope,
		runner: { readonly name: string; readonly labels: readonly string[] },
	): Promise<JitRunner>;
	/** A runner's ID by its name, or undefined when GitHub has none of that name. */
	findRunner(installationId: number, scope: RunnerScope, name: string): Promise<number | undefined>;
	/** Removes a runner GitHub still holds (one that never took a job); one already gone is no error. */
	removeRunner(installationId: number, scope: RunnerScope, runnerId: number): Promise<void>;
	/**
	 * A workflow run's event, `head_branch` and head repository, or undefined when GitHub doesn't know it. `head_branch`
	 * is a name, not a ref: a tag's run has the tag's name there.
	 */
	getRun(
		installationId: number,
		repository: string,
		runId: number,
	): Promise<{ readonly event: string; readonly headBranch?: string; readonly headRepository?: string } | undefined>;
	/** A job's status and conclusion, its run, and the runner that took it, or undefined when GitHub doesn't know it. */
	getJob(
		installationId: number,
		repository: string,
		jobId: number,
	): Promise<
		| {
				readonly status: string;
				readonly conclusion?: string;
				readonly runId?: number;
				readonly runnerId?: number;
				readonly runnerName?: string;
		  }
		| undefined
	>;
	/**
	 * The installation's repositories (`owner/name`), archived ones left out: up to `REPOSITORY_PAGES` pages. Read for
	 * reconciling, so it stops with `exhausted` when the installation's rate limit is low.
	 */
	listRepositories(installationId: number): Promise<string[]>;
	/**
	 * `repository`'s queued jobs: those of its queued and in-progress runs (a run's later job waits queued while its
	 * earlier ones run), the latest attempt of each. Conditional reads, so an unchanged list costs no rate limit; it
	 * stops with `exhausted` when the installation's rate limit is low.
	 */
	queuedJobs(installationId: number, repository: string): Promise<QueuedJob[]>;
	/**
	 * The App's recent webhook deliveries (its latest 100) that no attempt got a 2xx for, delivered at or after `since`:
	 * each event's latest attempt.
	 */
	failedDeliveries(since: number): Promise<FailedDelivery[]>;
	/** The App's installation on `owner` (an organisation or a user, compared without case), or undefined. */
	findInstallation(owner: string): Promise<number | undefined>;
	/** Asks GitHub to send a delivery again. */
	redeliver(deliveryId: number): Promise<void>;
}

/** The DER of a PKCS #8 RSA key around a PKCS #1 one: what Web Crypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
	// SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
	const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const octets = [0x04, ...derLength(pkcs1.length), ...pkcs1];
	const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
	return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

function derLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
	return [0x80 | bytes.length, ...bytes];
}

/** The App's private key for signing; `invalid` for one that isn't an RSA key in PEM. */
export async function importAppKey(pem: string): Promise<SigningKey> {
	const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem);
	if (match === null) throw new KantelError("invalid", "The private key isn't a PEM RSA key, as GitHub gives an App's");
	let der: Uint8Array;
	try {
		der = base64ToBytes((match[2] ?? "").replace(/\s+/g, ""));
	} catch {
		throw new KantelError("invalid", "The private key's PEM isn't base64");
	}
	const pkcs8 = match[1] === undefined ? der : pkcs1ToPkcs8(der);
	try {
		return await crypto.subtle.importKey(
			"pkcs8",
			pkcs8 as Uint8Array<ArrayBuffer>,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"],
		);
	} catch {
		throw new KantelError("invalid", "The private key couldn't be read as an RSA key");
	}
}

const base64Url = (bytes: Uint8Array): string =>
	bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const encodeJson = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** An App JWT (RS256), issued for `nowMs`. */
export async function appJwt(appId: number, key: SigningKey, nowMs: number): Promise<string> {
	const issued = Math.floor(nowMs / 1000) - 60;
	const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iat: issued, exp: issued + JWT_TTL_SECONDS, iss: String(appId) })}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
	return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * Whether `signature` (`X-Hub-Signature-256`: `sha256=` and the hex HMAC-SHA256 of the body) is `body`'s under
 * `secret`. Compared in constant time.
 */
export async function verifyGithubSignature(
	secret: string,
	body: Uint8Array,
	signature: string | null,
): Promise<boolean> {
	if (signature === null || !signature.startsWith("sha256=")) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as Uint8Array<ArrayBuffer>));
	const expected = `sha256=${[...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	if (expected.length !== signature.length) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index++)
		diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	return diff === 0;
}

/** A GitHub API failure, with GitHub's status and message, as `unavailable` (or `invalid` for a 4xx GitHub refused). */
async function githubError(response: Response, what: string): Promise<KantelError> {
	let message = "";
	try {
		const body = (await response.json()) as { message?: unknown };
		if (typeof body.message === "string") message = body.message;
	} catch {
		// Not JSON: the status says enough.
	}
	const said = `GitHub answered ${response.status} to ${what}${message === "" ? "" : `: ${message}`}`;
	return new KantelError(response.status >= 500 || response.status === 429 ? "unavailable" : "invalid", said);
}

export interface GithubAppOptions extends GithubAppCredentials {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly apiUrl?: string;
}

/** A GitHub App's calls, with its installation tokens cached until shortly before they expire. */
export function createGithubApp(options: GithubAppOptions): GithubApp {
	const send = options.fetch ?? ((input, init) => fetch(input, init));
	const doFetch: typeof fetch = (input, init) => send(input, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
	const now = options.now ?? (() => Date.now());
	const api = (options.apiUrl ?? GITHUB_API).replace(/\/+$/, "");
	let key: Promise<SigningKey> | undefined;
	const tokens = new Map<number, { readonly token: string; readonly expiresAt: number }>();
	const headers = (auth: string) => ({
		accept: "application/vnd.github+json",
		authorization: `Bearer ${auth}`,
		"x-github-api-version": API_VERSION,
		"user-agent": "kantel-github-runners",
	});

	async function installationToken(installationId: number): Promise<string> {
		const cached = tokens.get(installationId);
		if (cached !== undefined && cached.expiresAt - TOKEN_MARGIN_MS > now()) return cached.token;
		key ??= importAppKey(options.privateKey);
		const jwt = await appJwt(options.appId, await key, now());
		const response = await doFetch(`${api}/app/installations/${installationId}/access_tokens`, {
			method: "POST",
			headers: headers(jwt),
		});
		if (!response.ok) throw await githubError(response, "an installation token");
		const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
		if (typeof body.token !== "string") throw new KantelError("unavailable", "GitHub answered no installation token");
		const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : now() + 3_600_000;
		tokens.set(installationId, {
			token: body.token,
			expiresAt: Number.isNaN(expiresAt) ? now() + 3_600_000 : expiresAt,
		});
		return body.token;
	}

	/** Each installation's rate limit as its latest answer gave it. */
	const limits = new Map<number, { readonly remaining: number; readonly limit: number; readonly resetAt: number }>();
	/** Conditional reads' last answers by URL and installation, oldest first. */
	const etags = new Map<string, { readonly etag: string; readonly body: unknown }>();

	/** Refuses a reconciling read while the installation's rate limit is low, until it resets. */
	function spare(installationId: number): void {
		const known = limits.get(installationId);
		if (known === undefined || known.resetAt <= now()) return;
		const reserve = Math.max(RECONCILE_RESERVE_MIN, known.limit * RECONCILE_RESERVE);
		if (known.remaining < reserve) {
			throw new KantelError(
				"exhausted",
				`GitHub's rate limit for installation ${installationId} is low (${known.remaining} of ${known.limit} left); reconciling waits until it resets`,
				{ resetAt: known.resetAt },
			);
		}
	}

	function noteLimit(installationId: number, response: Response): void {
		const remaining = Number(response.headers.get("x-ratelimit-remaining"));
		const limit = Number(response.headers.get("x-ratelimit-limit"));
		const reset = Number(response.headers.get("x-ratelimit-reset"));
		if (response.headers.get("x-ratelimit-remaining") === null || !Number.isFinite(remaining)) return;
		limits.set(installationId, {
			remaining,
			limit: Number.isFinite(limit) && limit > 0 ? limit : 5000,
			resetAt: Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + 3_600_000,
		});
	}

	/** A reconciling read's body, from the cache when GitHub answers 304; undefined for a 404. */
	async function read(installationId: number, path: string, what: string): Promise<unknown> {
		spare(installationId);
		const token = await installationToken(installationId);
		const key = `${installationId} ${path}`;
		const cached = etags.get(key);
		const response = await doFetch(`${api}${path}`, {
			headers: { ...headers(token), ...(cached === undefined ? {} : { "if-none-match": cached.etag }) },
		});
		noteLimit(installationId, response);
		if (response.status === 304 && cached !== undefined) {
			etags.delete(key);
			etags.set(key, cached);
			return cached.body;
		}
		if (response.status === 404) return undefined;
		if (!response.ok) throw await githubError(response, what);
		const body: unknown = await response.json();
		const etag = response.headers.get("etag");
		etags.delete(key);
		if (etag !== null) {
			etags.set(key, { etag, body });
			while (etags.size > ETAG_CACHE_SIZE) {
				const oldest = etags.keys().next().value;
				if (oldest === undefined) break;
				etags.delete(oldest);
			}
		}
		return body;
	}

	const repoPath = (repository: string) => `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;

	/** A page of a run's jobs (the latest attempt of each): its queued ones, and how many the page had. */
	async function runJobs(
		installationId: number,
		repository: string,
		runId: number,
		page: number,
	): Promise<{ readonly queued: QueuedJob[]; readonly count: number }> {
		const body = (await read(
			installationId,
			`${repoPath(repository)}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
			`run ${runId}'s jobs`,
		)) as
			| {
					jobs?: {
						id?: unknown;
						run_id?: unknown;
						status?: unknown;
						name?: unknown;
						labels?: unknown;
						created_at?: unknown;
					}[];
			  }
			| undefined;
		const jobs = body?.jobs ?? [];
		const queued: QueuedJob[] = [];
		for (const job of jobs) {
			if (job.status !== "queued" || typeof job.id !== "number" || !Array.isArray(job.labels)) continue;
			const createdAt = typeof job.created_at === "string" ? Date.parse(job.created_at) : Number.NaN;
			queued.push({
				id: job.id,
				runId: typeof job.run_id === "number" ? job.run_id : runId,
				name: typeof job.name === "string" ? job.name : "",
				labels: job.labels.filter((label): label is string => typeof label === "string"),
				...(Number.isNaN(createdAt) ? {} : { createdAt }),
			});
		}
		return { queued, count: jobs.length };
	}

	const runnersPath = (scope: RunnerScope) =>
		scope.kind === "organization"
			? `/orgs/${encodeURIComponent(scope.org)}/actions/runners`
			: `/repos/${scope.repository.split("/").map(encodeURIComponent).join("/")}/actions/runners`;

	return {
		async generateJitConfig(installationId, scope, runner) {
			const token = await installationToken(installationId);
			const response = await doFetch(`${api}${runnersPath(scope)}/generate-jitconfig`, {
				method: "POST",
				headers: { ...headers(token), "content-type": "application/json" },
				body: JSON.stringify({
					name: runner.name,
					labels: runner.labels,
					// A repository's runners are in its default group, which `generate-jitconfig` still asks for.
					runner_group_id: scope.kind === "organization" ? scope.runnerGroupId : 1,
					work_folder: "_work",
				}),
			});
			if (!response.ok) throw await githubError(response, "a just-in-time runner");
			const body = (await response.json()) as { runner?: { id?: unknown }; encoded_jit_config?: unknown };
			if (typeof body.encoded_jit_config !== "string" || typeof body.runner?.id !== "number") {
				throw new KantelError("unavailable", "GitHub answered no just-in-time runner configuration");
			}
			return { runnerId: body.runner.id, encodedJitConfig: body.encoded_jit_config };
		},
		async findRunner(installationId, scope, name) {
			const token = await installationToken(installationId);
			const response = await doFetch(`${api}${runnersPath(scope)}?name=${encodeURIComponent(name)}`, {
				headers: headers(token),
			});
			if (!response.ok) throw await githubError(response, "a runner's lookup");
			const body = (await response.json()) as { runners?: { id?: unknown; name?: unknown }[] };
			const found = body.runners?.find((runner) => runner.name === name);
			return typeof found?.id === "number" ? found.id : undefined;
		},
		async removeRunner(installationId, scope, runnerId) {
			const token = await installationToken(installationId);
			const response = await doFetch(`${api}${runnersPath(scope)}/${runnerId}`, {
				method: "DELETE",
				headers: headers(token),
			});
			if (!response.ok && response.status !== 404) throw await githubError(response, "a runner's removal");
		},
		async getRun(installationId, repository, runId) {
			const token = await installationToken(installationId);
			const response = await doFetch(
				`${api}/repos/${repository.split("/").map(encodeURIComponent).join("/")}/actions/runs/${runId}`,
				{ headers: headers(token) },
			);
			if (response.status === 404) return undefined;
			if (!response.ok) throw await githubError(response, "a run");
			const body = (await response.json()) as {
				event?: unknown;
				head_branch?: unknown;
				head_repository?: { full_name?: unknown };
			};
			return {
				event: typeof body.event === "string" ? body.event : "",
				...(typeof body.head_branch === "string" ? { headBranch: body.head_branch } : {}),
				...(typeof body.head_repository?.full_name === "string"
					? { headRepository: body.head_repository.full_name }
					: {}),
			};
		},
		async getJob(installationId, repository, jobId) {
			const token = await installationToken(installationId);
			const response = await doFetch(
				`${api}/repos/${repository.split("/").map(encodeURIComponent).join("/")}/actions/jobs/${jobId}`,
				{ headers: headers(token) },
			);
			if (response.status === 404) return undefined;
			if (!response.ok) throw await githubError(response, "a job's status");
			const body = (await response.json()) as {
				status?: unknown;
				conclusion?: unknown;
				run_id?: unknown;
				runner_id?: unknown;
				runner_name?: unknown;
			};
			return {
				status: typeof body.status === "string" ? body.status : "unknown",
				...(typeof body.conclusion === "string" ? { conclusion: body.conclusion } : {}),
				...(typeof body.run_id === "number" ? { runId: body.run_id } : {}),
				// GitHub answers 0 or null for a job no runner has taken.
				...(typeof body.runner_id === "number" && body.runner_id > 0 ? { runnerId: body.runner_id } : {}),
				...(typeof body.runner_name === "string" && body.runner_name !== "" ? { runnerName: body.runner_name } : {}),
			};
		},
		async listRepositories(installationId) {
			const names: string[] = [];
			for (let page = 1; page <= REPOSITORY_PAGES; page++) {
				const body = (await read(
					installationId,
					`/installation/repositories?per_page=100&page=${page}`,
					"the installation's repositories",
				)) as { repositories?: { full_name?: unknown; archived?: unknown }[] } | undefined;
				const repositories = body?.repositories ?? [];
				for (const repository of repositories) {
					if (typeof repository.full_name === "string" && repository.archived !== true)
						names.push(repository.full_name);
				}
				if (repositories.length < 100) break;
			}
			return names;
		},
		async queuedJobs(installationId, repository) {
			const runs = new Set<number>();
			for (const status of ["queued", "in_progress"]) {
				for (let page = 1; page <= RUN_PAGES; page++) {
					const body = (await read(
						installationId,
						`${repoPath(repository)}/actions/runs?status=${status}&per_page=100&page=${page}`,
						`${repository}'s ${status} runs`,
					)) as { workflow_runs?: { id?: unknown }[] } | undefined;
					const listed = body?.workflow_runs ?? [];
					for (const run of listed) if (typeof run.id === "number") runs.add(run.id);
					if (listed.length < 100) break;
				}
			}
			const queued: QueuedJob[] = [];
			for (const runId of runs) {
				for (let page = 1; page <= RUN_PAGES; page++) {
					const listed = await runJobs(installationId, repository, runId, page);
					queued.push(...listed.queued);
					if (listed.count < 100) break;
				}
			}
			return queued;
		},
		async failedDeliveries(since) {
			key ??= importAppKey(options.privateKey);
			const jwt = await appJwt(options.appId, await key, now());
			const response = await doFetch(`${api}/app/hook/deliveries?per_page=100`, { headers: headers(jwt) });
			if (!response.ok) throw await githubError(response, "the App's webhook deliveries");
			const deliveries = (await response.json()) as {
				id?: unknown;
				guid?: unknown;
				delivered_at?: unknown;
				status_code?: unknown;
				event?: unknown;
				action?: unknown;
				installation_id?: unknown;
			}[];
			// Attempts of one event share its GUID; the list is newest first, so the first seen is its latest.
			const byGuid = new Map<string, { latest: FailedDelivery; delivered: boolean }>();
			for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
				if (typeof delivery.id !== "number" || typeof delivery.guid !== "string") continue;
				const deliveredAt = typeof delivery.delivered_at === "string" ? Date.parse(delivery.delivered_at) : Number.NaN;
				const ok =
					typeof delivery.status_code === "number" && delivery.status_code >= 200 && delivery.status_code < 300;
				const seen = byGuid.get(delivery.guid);
				if (seen !== undefined) {
					seen.delivered ||= ok;
					continue;
				}
				byGuid.set(delivery.guid, {
					latest: {
						id: delivery.id,
						guid: delivery.guid,
						event: typeof delivery.event === "string" ? delivery.event : "",
						...(typeof delivery.action === "string" ? { action: delivery.action } : {}),
						...(typeof delivery.installation_id === "number" ? { installationId: delivery.installation_id } : {}),
						deliveredAt: Number.isNaN(deliveredAt) ? 0 : deliveredAt,
					},
					delivered: ok,
				});
			}
			return [...byGuid.values()]
				.filter(({ latest, delivered }) => !delivered && latest.deliveredAt >= since)
				.map(({ latest }) => latest);
		},
		async findInstallation(owner) {
			key ??= importAppKey(options.privateKey);
			const jwt = await appJwt(options.appId, await key, now());
			for (let page = 1; page <= INSTALLATION_PAGES; page++) {
				const response = await doFetch(`${api}/app/installations?per_page=100&page=${page}`, { headers: headers(jwt) });
				if (!response.ok) throw await githubError(response, "the App's installations");
				const installations = (await response.json()) as { id?: unknown; account?: { login?: unknown } }[];
				const listed = Array.isArray(installations) ? installations : [];
				const found = listed.find(
					(installation) =>
						typeof installation.account?.login === "string" &&
						installation.account.login.toLowerCase() === owner.toLowerCase(),
				);
				if (typeof found?.id === "number") return found.id;
				if (listed.length < 100) break;
			}
			return undefined;
		},
		async redeliver(deliveryId) {
			key ??= importAppKey(options.privateKey);
			const jwt = await appJwt(options.appId, await key, now());
			const response = await doFetch(`${api}/app/hook/deliveries/${deliveryId}/attempts`, {
				method: "POST",
				headers: headers(jwt),
			});
			if (!response.ok) throw await githubError(response, "a webhook's redelivery");
		},
	};
}
