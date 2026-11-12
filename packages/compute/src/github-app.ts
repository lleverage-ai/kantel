/**
 * A GitHub App, as the runner broker (`github-runners.ts`) uses it: its JWT, an installation's access token, a
 * just-in-time runner configuration, a runner's removal, and a webhook's signature. Web Crypto and `fetch` only, so it
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
	};
}
