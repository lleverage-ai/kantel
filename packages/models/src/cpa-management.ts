/**
 * A client for CLIProxyAPI's (CPA's) management API, `/v0/management/...` under CPA's root, which is how Harbour signs
 * an organisation's subscriptions in (`ModelProviders.startSignIn`): CPA runs the provider's OAuth flow and keeps the
 * tokens; Harbour only starts the flow, polls it and lists the accounts CPA holds.
 *
 * - Every request carries `Authorization: Bearer <management key>`. The key is CPA's operator secret, so it is never
 *   in an error, a log line or a returned value.
 * - A 401 or 403 is `refused` (CPA refused the management key); any other failure, an unreachable CPA or an answer
 *   that isn't the JSON expected, is `unavailable` with the HTTP status.
 */
import { HarbourError } from "@harbour/contracts";
import { connectorRoot } from "./presets.ts";

/** The OAuth providers CPA's management API signs in: Claude (`anthropic`) and ChatGPT (`codex`). */
export type CpaAuthProvider = "anthropic" | "codex";

export interface CpaAuthUrl {
	readonly status: "ok";
	/** The provider's sign-in page. */
	readonly url: string;
	/** CPA's handle on the flow, for `authStatus` and `submitCallback`. */
	readonly state: string;
}

export interface CpaAuthStatus {
	readonly status: "wait" | "ok" | "error";
	readonly error?: string;
}

/** One credential file CPA holds, as its management API lists it. The provider is in `provider` or `type`. */
export interface CpaAuthFile {
	readonly provider?: string;
	readonly type?: string;
	readonly email?: string;
	readonly label?: string;
	readonly status?: string;
	readonly disabled?: boolean;
}

export interface CpaManagement {
	/** Starts a sign-in: `GET /v0/management/{anthropic|codex}-auth-url?is_webui=true`. */
	authUrl(provider: CpaAuthProvider): Promise<CpaAuthUrl>;
	/** Where a sign-in is: `GET /v0/management/get-auth-status?state=`. */
	authStatus(state: string): Promise<CpaAuthStatus>;
	/** Hands CPA the address the browser ended on: `POST /v0/management/oauth-callback`. */
	submitCallback(provider: CpaAuthProvider, state: string, redirectUrl: string): Promise<{ readonly status: "ok" }>;
	/** The credentials CPA holds: `GET /v0/management/auth-files`. */
	authFiles(): Promise<{ readonly files: readonly CpaAuthFile[] }>;
}

export interface CpaManagementOptions {
	/** CPA's root, such as `http://127.0.0.1:8317`; a trailing `/v1` is dropped. */
	readonly baseUrl: string;
	/** CPA's management key (its `remote-management.secret-key`). */
	readonly managementKey: string;
	readonly fetch?: typeof fetch;
}

const MAX_ERROR_LENGTH = 200;

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function createCpaManagement(options: CpaManagementOptions): CpaManagement {
	const root = connectorRoot(options.baseUrl);
	const key = options.managementKey;
	const doFetch = options.fetch ?? fetch;

	/** CPA's own error text, when it gave one, without the key and kept short. */
	function upstreamError(body: unknown): string | undefined {
		if (!isRecord(body)) return undefined;
		const text = optionalString(body.error) ?? optionalString(body.message);
		if (text === undefined || text === "") return undefined;
		const redacted = key === "" ? text : text.split(key).join("[redacted]");
		return redacted.length > MAX_ERROR_LENGTH ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…` : redacted;
	}

	async function call(
		method: "GET" | "POST",
		path: string,
		query?: { readonly [name: string]: string },
		body?: unknown,
	): Promise<{ readonly [key: string]: unknown }> {
		const url = new URL(`${root}/v0/management/${path}`);
		for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
		let response: Response;
		try {
			response = await doFetch(url.toString(), {
				method,
				headers: {
					authorization: `Bearer ${key}`,
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			// The fetch error may quote the request; say only that CPA couldn't be reached.
			throw new HarbourError("unavailable", `CLIProxyAPI's management API could not be reached (${path})`);
		}
		let parsed: unknown;
		try {
			const text = await response.text();
			parsed = text.trim() === "" ? {} : JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (response.status === 401 || response.status === 403) {
			throw new HarbourError(
				"refused",
				`CLIProxyAPI refused the management key (HTTP ${response.status}); check HARBOUR_CPA_MANAGEMENT_KEY`,
				{ status: response.status },
			);
		}
		if (!response.ok) {
			const detail = upstreamError(parsed);
			const message = `CLIProxyAPI's management API answered HTTP ${response.status} (${path})`;
			throw new HarbourError("unavailable", detail === undefined ? message : `${message}: ${detail}`, {
				status: response.status,
			});
		}
		if (!isRecord(parsed)) {
			const message = `CLIProxyAPI's management API answered something other than a JSON object (${path})`;
			throw new HarbourError("unavailable", message, { status: response.status });
		}
		return parsed;
	}

	return {
		async authUrl(provider) {
			const answer = await call("GET", `${provider}-auth-url`, { is_webui: "true" });
			const url = optionalString(answer.url);
			const state = optionalString(answer.state);
			if (url === undefined || url === "" || state === undefined || state === "") {
				throw new HarbourError("unavailable", "CLIProxyAPI did not answer with a sign-in URL and state");
			}
			return { status: "ok", url, state };
		},

		async authStatus(state) {
			const answer = await call("GET", "get-auth-status", { state });
			const status = answer.status;
			if (status === "wait" || status === "ok") return { status };
			if (status === "error") {
				const error = upstreamError(answer);
				return error === undefined ? { status } : { status, error };
			}
			throw new HarbourError("unavailable", "CLIProxyAPI answered a sign-in status it doesn't document");
		},

		async submitCallback(provider, state, redirectUrl) {
			const answer = await call("POST", "oauth-callback", undefined, {
				provider,
				redirect_url: redirectUrl,
				state,
			});
			if (answer.status === "error") {
				const error = upstreamError(answer);
				const message = "CLIProxyAPI did not take the sign-in's address";
				throw new HarbourError("invalid", error === undefined ? message : `${message}: ${error}`);
			}
			return { status: "ok" };
		},

		async authFiles() {
			const answer = await call("GET", "auth-files");
			const listed = Array.isArray(answer.files) ? answer.files : [];
			const files: CpaAuthFile[] = [];
			for (const entry of listed) {
				if (!isRecord(entry)) continue;
				const provider = optionalString(entry.provider);
				const type = optionalString(entry.type);
				const email = optionalString(entry.email);
				const label = optionalString(entry.label);
				const status = optionalString(entry.status);
				files.push({
					...(provider === undefined ? {} : { provider }),
					...(type === undefined ? {} : { type }),
					...(email === undefined ? {} : { email }),
					...(label === undefined ? {} : { label }),
					...(status === undefined ? {} : { status }),
					...(typeof entry.disabled === "boolean" ? { disabled: entry.disabled } : {}),
				});
			}
			return { files };
		},
	};
}
