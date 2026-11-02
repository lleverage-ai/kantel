/**
 * The boat.dev provider (`kind: "boat"`): environments as boat sandboxes, driven through boat's REST API
 * (https://boat.dev/api/v1) with a scoped API key (the `ci` preset: create, read, stop, resume, fork, commands, files
 * and hosted ports). Runs on Node and in a Worker: it needs only `fetch` and WebCrypto.
 *
 * - **Nothing of the account's.** Every sandbox is created and forked with `noEnv: true`: none of the boat account
 *   owner's variables, secret files or logins, and confined so it can't act on the account or other sandboxes. A
 *   sandbox that still reports `holdsCreatorLogins` is answered with `holdsOwnerLogins`, which the broker refuses.
 * - **Idempotent create.** `Idempotency-Key: kantel-<environment ID>-v<definition version>`, so a lost answer retried
 *   returns the same sandbox, and a label `kantel.environment` names the environment on boat's side.
 * - **Lifecycle.** Kantel's broker stops a sandbox when it has been idle; boat's own auto-stop (`ttlSeconds`) is only
 *   a backstop (default four hours from each start), in case the broker can't. A resumed sandbox is usable before
 *   its files have all copied back (`hydrated`); a command sent while it is still restoring is retried here.
 * - **Commands** run in the sandbox's work directory (`/home/user`) or under it. boat's command call has no variables,
 *   so non-secret ones are `export`ed at the top of the script. Output streams (`stream: true`) when the caller wants
 *   it. boat runs a synchronous command for at most 600 seconds.
 * - **Webhooks.** `verifyBoatWebhook` checks a delivery's signature (`X-Ascii-Signature`, HMAC-SHA256 over
 *   `delivery.timestamp.body`) and turns it into a `MachineStateReport`. Registering the endpoint changes the boat
 *   account, so it is the account owner's step; without it the broker polls `status`.
 *
 * Errors are `KantelError`s: 400 `invalid`, 402 `refused` (boat wants payment: Kantel never pays), 403 `forbidden`,
 * 404 `not_found`, 409 `conflict`, 429 `exhausted` (a start limit), 401 and 5xx `unavailable`. A message never carries
 * the key, a hosted port's token or a desktop URL.
 */
import {
	type EnvironmentProvider,
	type EnvironmentSizeName,
	type ErrorCode,
	KantelError,
	type MachineExecRequest,
	type MachineExecResult,
	type MachineFileEntry,
	type MachineFiles,
	type MachineRef,
	type MachineSpec,
	type MachineState,
	type MachineStateReport,
	type MachineStatus,
	type PortUrl,
	type ProviderCapabilities,
	type SnapshotRef,
} from "@kantel/contracts";

export const BOAT_API = "https://boat.dev/api/v1";
/** The sandbox's work directory: relative paths resolve against it, and files may only be under it or `/tmp`. */
export const BOAT_HOME = "/home/user";
/** boat's longest synchronous command. */
export const BOAT_MAX_COMMAND_SECONDS = 600;
const DEFAULT_BACKSTOP_SECONDS = 4 * 3600;

export interface BoatProviderOptions {
	/** A scoped boat API key (`boat_…`). Never logged or put in an error. */
	readonly apiKey: string;
	/** Default `https://boat.dev/api/v1`. */
	readonly baseUrl?: string;
	/** Bill sandboxes to this boat organisation (`X-Boat-Org`). */
	readonly org?: string;
	/** boat's own auto-stop after each start, a backstop for the broker's idle stop. Default four hours. */
	readonly backstopSeconds?: number;
	readonly fetch?: typeof fetch;
	/** Waits between retries of a command sent while a sandbox restores its disk. Default 500 ms, at most 20 tries. */
	readonly retryDelayMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
}

const CAPABILITIES: ProviderCapabilities = {
	sizes: ["small", "default", "large", "xlarge"],
	stopModes: ["stop"],
	snapshot: true,
	fork: true,
	expose: true,
	docker: true,
	kvm: false,
	gpu: false,
	egress: "unmanaged",
	pushesState: true,
	maxExecMs: BOAT_MAX_COMMAND_SECONDS * 1000,
};

/** boat's sandbox states, as Kantel's machine states. */
export function boatStatus(state: string): MachineStatus {
	switch (state) {
		case "init":
		case "provisioning":
		case "provisioned":
		case "cloning":
		case "resuming":
		case "forking":
			return "starting";
		case "ready":
		case "idle":
		case "running":
			return "running";
		case "archiving":
		case "stopping":
			return "stopping";
		case "archived":
			return "stopped";
		case "error":
			return "error";
		case "cancelled":
			return "gone";
		default:
			return "error";
	}
}

interface BoatSandbox {
	readonly id: string;
	readonly state: string;
	readonly type?: EnvironmentSizeName;
	readonly error?: string | null;
	readonly holdsCreatorLogins?: boolean;
}

function machineState(sandbox: BoatSandbox): MachineState {
	return {
		status: boatStatus(sandbox.state),
		...(sandbox.type === undefined ? {} : { size: sandbox.type }),
		...(sandbox.error == null ? {} : { error: sandbox.error }),
		...(sandbox.holdsCreatorLogins === true ? { holdsOwnerLogins: true } : {}),
	};
}

function errorCode(status: number): ErrorCode {
	if (status === 400) return "invalid";
	if (status === 402) return "refused";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 429) return "exhausted";
	return "unavailable";
}

/** Single-quoted for bash. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The script boat runs: the variables exported, then the command. */
export function boatScript(command: string, env: { readonly [name: string]: string } | undefined): string {
	const exports = Object.entries(env ?? {}).map(([name, value]) => {
		if (!NAME.test(name)) throw new KantelError("invalid", `${name} isn't a variable name`);
		return `export ${name}=${shellQuote(value)}`;
	});
	return exports.length === 0 ? command : `${exports.join("\n")}\n${command}`;
}

/** A path for boat's `cwd`, which is relative to the work directory; undefined for the work directory itself. */
export function boatCwd(cwd: string | undefined): string | undefined {
	if (cwd === undefined || cwd === "" || cwd === BOAT_HOME || cwd === `${BOAT_HOME}/`) return undefined;
	if (cwd.startsWith(`${BOAT_HOME}/`)) return cwd.slice(BOAT_HOME.length + 1);
	if (cwd.startsWith("/")) throw new KantelError("invalid", `A command runs under ${BOAT_HOME}, not in ${cwd}`);
	return cwd;
}

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
	let text = "";
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
}

function fromBase64(text: string): Uint8Array {
	const raw = atob(text);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

export function createBoatProvider(options: BoatProviderOptions): EnvironmentProvider {
	const base = (options.baseUrl ?? BOAT_API).replace(/\/$/, "");
	const doFetch = options.fetch ?? fetch;
	const backstop = options.backstopSeconds ?? DEFAULT_BACKSTOP_SECONDS;
	const retryDelayMs = options.retryDelayMs ?? 500;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const headers = (extra?: Record<string, string>): Record<string, string> => ({
		authorization: `Bearer ${options.apiKey}`,
		accept: "application/json",
		...(options.org === undefined ? {} : { "x-boat-org": options.org }),
		...extra,
	});

	/** One call; a non-2xx answer becomes a KantelError with boat's code and message, never the request. */
	async function call(
		method: string,
		path: string,
		init: {
			body?: unknown;
			query?: Record<string, string>;
			headers?: Record<string, string>;
			signal?: AbortSignal;
		} = {},
	): Promise<Response> {
		const url = new URL(`${base}${path}`);
		for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
		let response: Response;
		try {
			response = await doFetch(url, {
				method,
				headers: headers({
					...(init.body === undefined ? {} : { "content-type": "application/json" }),
					...init.headers,
				}),
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				...(init.signal === undefined ? {} : { signal: init.signal }),
			});
		} catch (error) {
			if (init.signal?.aborted) throw new KantelError("aborted", "The call to boat was aborted");
			throw new KantelError(
				"unavailable",
				`boat couldn't be reached: ${error instanceof Error ? error.message : error}`,
			);
		}
		if (response.ok) return response;
		let code = "";
		let message = response.statusText;
		try {
			const body = (await response.json()) as { code?: string; message?: string; error?: { message?: string } };
			code = body.code ?? "";
			message = body.message ?? body.error?.message ?? message;
		} catch {
			// Not JSON: keep the status text.
		}
		// boat's trial caps its auto-stop at two hours: say which setting fixes it.
		if (code === "trial_auto_stop_required") {
			message = `boat's trial allows an auto-stop of 2 hours at most, and Kantel asked for ${Math.round(backstop / 60)} minutes: set KANTEL_BOAT_AUTO_STOP_MINUTES to 120 or less. boat said: ${message}`;
		}
		const detail = code === "" ? message : `${message} (${code})`;
		const prefix = response.status === 401 ? "boat refused the API key" : "boat refused the call";
		throw new KantelError(errorCode(response.status), `${prefix}: ${detail}`, {
			status: response.status,
			...(code === "" ? {} : { boatCode: code }),
		});
	}

	async function json<T>(method: string, path: string, init?: Parameters<typeof call>[2]): Promise<T> {
		return (await call(method, path, init)).json() as Promise<T>;
	}

	const sandboxPath = (ref: MachineRef) => `/sandboxes/${encodeURIComponent(ref.machineId)}`;

	async function get(ref: MachineRef): Promise<BoatSandbox | undefined> {
		try {
			return (await json<{ sandbox: BoatSandbox }>("GET", sandboxPath(ref))).sandbox;
		} catch (error) {
			if (error instanceof KantelError && error.code === "not_found") return undefined;
			throw error;
		}
	}

	/** An action's answer: the sandbox when boat includes it, else its status word. */
	function actionState(body: { status?: string; sandbox?: BoatSandbox | null }): MachineState {
		if (body.sandbox != null && typeof body.sandbox === "object" && "state" in body.sandbox) {
			const state = machineState(body.sandbox);
			// The action's own status is newer than the sandbox snapshot that comes with it.
			return body.status === undefined ? state : { ...state, status: boatStatus(body.status) };
		}
		return { status: boatStatus(body.status ?? "error") };
	}

	function labels(spec: MachineSpec): Record<string, string> {
		return { ...spec.labels, "kantel.environment": spec.environmentId };
	}

	async function runOnce(ref: MachineRef, request: MachineExecRequest): Promise<MachineExecResult | "retry"> {
		const started = Date.now();
		const timeoutSeconds =
			request.timeoutMs === undefined
				? undefined
				: Math.min(BOAT_MAX_COMMAND_SECONDS, Math.max(1, Math.ceil(request.timeoutMs / 1000)));
		const cwd = boatCwd(request.cwd);
		const stream = request.onOutput !== undefined && request.detached !== true;
		const body = {
			command: boatScript(request.command, request.env),
			...(cwd === undefined ? {} : { cwd }),
			...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
			...(request.detached ? { detached: true } : {}),
			...(stream ? { stream: true } : {}),
		};
		let response: Response;
		try {
			response = await call("POST", `${sandboxPath(ref)}/commands`, {
				body,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
		} catch (error) {
			// A sandbox still restoring its disk answers 409; the command never ran, so it is safe to send again.
			if (error instanceof KantelError && error.code === "conflict" && error.details?.boatCode === "sandbox_restoring")
				return "retry";
			throw error;
		}
		if (request.detached) {
			const process = (await response.json()) as { processId?: number | string };
			return {
				exitCode: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				durationMs: Date.now() - started,
				...(process.processId === undefined ? {} : { processId: String(process.processId) }),
			};
		}
		if (!stream) {
			const result = (await response.json()) as {
				exitCode?: number | null;
				stdout?: string;
				stderr?: string;
				stdoutTruncated?: boolean;
				stderrTruncated?: boolean;
				timedOut?: boolean;
			};
			return {
				exitCode: result.exitCode ?? null,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				timedOut: result.timedOut ?? false,
				truncated: (result.stdoutTruncated ?? false) || (result.stderrTruncated ?? false),
				durationMs: Date.now() - started,
			};
		}
		// Newline-delimited frames: started, stdout and stderr chunks, then one exit or error.
		let stdout = "";
		let stderr = "";
		let exit: { exitCode: number | null; timedOut: boolean } | undefined;
		const reader = response.body?.getReader();
		if (reader === undefined) throw new KantelError("unavailable", "boat answered a streamed command with no body");
		const decoder = new TextDecoder();
		let buffer = "";
		const frame = (line: string): "retry" | undefined => {
			if (line.trim() === "") return undefined;
			const parsed = JSON.parse(line) as {
				type: string;
				data?: string;
				exitCode?: number | null;
				timedOut?: boolean;
				message?: string;
				error?: string;
				retryable?: boolean;
			};
			if (parsed.type === "stdout" || parsed.type === "stderr") {
				const data = parsed.data ?? "";
				if (parsed.type === "stdout") stdout += data;
				else stderr += data;
				request.onOutput?.(parsed.type, data);
			} else if (parsed.type === "exit") {
				exit = { exitCode: parsed.exitCode ?? null, timedOut: parsed.timedOut ?? false };
			} else if (parsed.type === "error") {
				if (parsed.retryable === true && stdout === "" && stderr === "") return "retry";
				throw new KantelError("unavailable", `boat couldn't run the command: ${parsed.message ?? parsed.error}`);
			}
			return undefined;
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (value !== undefined) buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				if (frame(buffer.slice(0, newline)) === "retry") return "retry";
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
			if (done) break;
		}
		if (frame(buffer) === "retry") return "retry";
		if (exit === undefined) throw new KantelError("unavailable", "boat's command stream ended without an exit");
		return { ...exit, stdout, stderr, durationMs: Date.now() - started };
	}

	const provider: EnvironmentProvider = {
		kind: "boat",
		capabilities: () => CAPABILITIES,

		async create(spec) {
			const body = await json<{ sandbox: BoatSandbox }>("POST", "/sandboxes", {
				headers: { "idempotency-key": `kantel-${spec.environmentId}-v${spec.definition.version}` },
				body: {
					name: spec.name,
					type: spec.size,
					noEnv: true,
					labels: labels(spec),
					ttlSeconds: backstop,
					...(spec.definition.template === undefined ? {} : { from: spec.definition.template }),
					...(spec.definition.setup === undefined ? {} : { setupScript: spec.definition.setup }),
				},
			});
			return { provider: "boat", machineId: body.sandbox.id };
		},

		async start(ref, startOptions) {
			try {
				const body = await json<{ status?: string; sandbox?: BoatSandbox | null }>(
					"POST",
					`${sandboxPath(ref)}/resume`,
					{ body: { noEnv: true, ttlSeconds: backstop, ...(startOptions?.size ? { type: startOptions.size } : {}) } },
				);
				return actionState(body);
			} catch (error) {
				// Resuming a sandbox that is already up is a conflict: answer it as it is.
				if (error instanceof KantelError && error.code === "conflict") {
					const sandbox = await get(ref);
					if (sandbox !== undefined && boatStatus(sandbox.state) !== "stopped") return machineState(sandbox);
				}
				throw error;
			}
		},

		async stop(ref) {
			const body = await json<{ status?: string; sandbox?: BoatSandbox | null }>("POST", `${sandboxPath(ref)}/stop`, {
				body: {},
			});
			return actionState(body);
		},

		async status(ref) {
			const sandbox = await get(ref);
			return sandbox === undefined ? { status: "gone" } : machineState(sandbox);
		},

		async destroy(ref) {
			const sandbox = await get(ref);
			if (sandbox === undefined || boatStatus(sandbox.state) === "gone") return;
			// boat deletes a stopped sandbox's data; stop it first, and wait for the archive to settle.
			if (boatStatus(sandbox.state) !== "stopped") {
				await provider.stop(ref).catch(() => undefined);
				for (let i = 0; i < 120; i++) {
					const now = await get(ref);
					if (now === undefined) return;
					if (["stopped", "error", "gone"].includes(boatStatus(now.state))) break;
					await sleep(retryDelayMs * 2);
				}
			}
			try {
				await call("DELETE", sandboxPath(ref), { headers: { "x-ascii-confirm-delete": ref.machineId } });
			} catch (error) {
				if (error instanceof KantelError && error.code === "not_found") return;
				throw error;
			}
		},

		async exec(ref, request) {
			for (let attempt = 0; attempt < 20; attempt++) {
				const result = await runOnce(ref, request);
				if (result !== "retry") return result;
				await sleep(retryDelayMs);
			}
			throw new KantelError("unavailable", "The sandbox was still restoring its disk; try the command again");
		},

		files(ref): MachineFiles {
			const path = `${sandboxPath(ref)}/files`;
			return {
				async read(file) {
					const body = await json<{ content: string; encoding?: string }>("GET", path, {
						query: { path: file, encoding: "base64" },
					});
					return body.encoding === "utf8" ? encoder.encode(body.content) : fromBase64(body.content);
				},
				async write(file, bytes) {
					await call("PUT", path, { body: { path: file, content: base64(bytes), encoding: "base64" } });
				},
				async list(dir) {
					const body = await json<{
						files?: { name: string; path: string; isDir: boolean; size?: number }[];
					}>("GET", `${path}/list`, { query: { path: dir } });
					return (body.files ?? []).map(
						(entry): MachineFileEntry => ({
							name: entry.name,
							path: entry.path,
							directory: entry.isDir,
							size: entry.size ?? 0,
						}),
					);
				},
				async remove(file) {
					try {
						await call("DELETE", path, { query: { path: file, recursive: "true" } });
					} catch (error) {
						if (error instanceof KantelError && error.code === "not_found") return;
						throw error;
					}
				},
			};
		},

		async expose(ref, port, exposeOptions): Promise<PortUrl> {
			const isPublic = exposeOptions?.public ?? false;
			const body = await json<{ url: string; isProtected?: boolean }>("POST", `${sandboxPath(ref)}/host`, {
				body: { port, public: isPublic },
			});
			return { port, url: body.url, public: body.isProtected === undefined ? isPublic : !body.isProtected };
		},

		async snapshot(ref, name): Promise<SnapshotRef> {
			const body = await json<{ snapshot: { name: string } }>("POST", "/saved-snapshots", {
				body: { sandboxId: ref.machineId, name },
			});
			return { provider: "boat", snapshotId: body.snapshot.name };
		},

		async fork(from, spec) {
			if ("snapshotId" in from) {
				const body = await json<{ sandbox: BoatSandbox }>("POST", "/sandboxes", {
					headers: { "idempotency-key": `kantel-${spec.environmentId}-v${spec.definition.version}` },
					body: {
						name: spec.name,
						type: spec.size,
						noEnv: true,
						labels: labels(spec),
						ttlSeconds: backstop,
						from: from.snapshotId,
					},
				});
				return { provider: "boat", machineId: body.sandbox.id };
			}
			const body = await json<{ id: string }>("POST", `${sandboxPath(from)}/fork`, {
				headers: { "idempotency-key": `kantel-${spec.environmentId}-v${spec.definition.version}` },
				body: { noEnv: true, labels: labels(spec), type: spec.size, ttlSeconds: backstop },
			});
			return { provider: "boat", machineId: body.id };
		},

		async usage(ref, since) {
			const body = await json<{ seconds: number; dollars?: number }>("GET", `${sandboxPath(ref)}/usage`, {
				query: { since: new Date(since).toISOString() },
			});
			return { runningMs: body.seconds * 1000, ...(body.dollars === undefined ? {} : { dollars: body.dollars }) };
		},
	};
	return provider;
}

// ---------------------------------------------------------------------------------------------------------------------
// Webhooks

/** boat's sandbox lifecycle events, as machine states. */
const WEBHOOK_STATUS: Readonly<Record<string, MachineStatus>> = {
	"sandbox.ready": "running",
	"sandbox.hydrated": "running",
	"sandbox.recovered": "running",
	"sandbox.degraded": "running",
	"sandbox.archived": "stopped",
	"sandbox.error": "error",
};

/** How old a delivery may be before it is refused as a replay. */
export const BOAT_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
	return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** The signature boat puts on a delivery: `v1=` and the hex HMAC-SHA256 of `delivery.timestamp.body`. */
export async function signBoatWebhook(secret: string, deliveryId: string, timestamp: string, body: string) {
	return `v1=${await hmacHex(secret, `${deliveryId}.${timestamp}.${body}`)}`;
}

/**
 * A boat webhook delivery checked and read: its state report, or undefined for an event that says nothing about the
 * machine's state. Rejects with `forbidden` for a bad or missing signature or a delivery older than the tolerance,
 * and `invalid` for a body that isn't one.
 */
export async function verifyBoatWebhook(input: {
	readonly secret: string;
	readonly headers: Headers;
	readonly body: string;
	readonly now?: number;
	readonly toleranceMs?: number;
}): Promise<MachineStateReport | undefined> {
	const delivery = input.headers.get("x-ascii-delivery");
	const timestamp = input.headers.get("x-ascii-timestamp");
	const signature = input.headers.get("x-ascii-signature");
	if (delivery === null || timestamp === null || signature === null || !/^[0-9]+$/.test(timestamp)) {
		throw new KantelError("forbidden", "Not a signed boat delivery");
	}
	const expected = await signBoatWebhook(input.secret, delivery, timestamp, input.body);
	if (!sameText(expected, signature)) throw new KantelError("forbidden", "The delivery's signature doesn't match");
	const sentAt = Number(timestamp) * 1000;
	const now = input.now ?? Date.now();
	if (Math.abs(now - sentAt) > (input.toleranceMs ?? BOAT_WEBHOOK_TOLERANCE_MS)) {
		throw new KantelError("forbidden", "The delivery is too old");
	}
	let event: { id?: string; type?: string; createdAt?: string; data?: { sandbox?: { id?: string }; error?: string } };
	try {
		event = JSON.parse(input.body);
	} catch {
		throw new KantelError("invalid", "The delivery's body isn't JSON");
	}
	const status = event.type === undefined ? undefined : WEBHOOK_STATUS[event.type];
	const machineId = event.data?.sandbox?.id;
	if (status === undefined || machineId === undefined) return undefined;
	const at = event.createdAt === undefined ? sentAt : Date.parse(event.createdAt);
	return {
		ref: { provider: "boat", machineId },
		status,
		at: Number.isNaN(at) ? sentAt : at,
		deliveryId: delivery,
		...(event.data?.error === undefined ? {} : { error: event.data.error }),
	};
}
