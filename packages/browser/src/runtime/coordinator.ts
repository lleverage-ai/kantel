/**
 * The browser coordinator: one per browser, the part that sits between Harbour and the browser's container. Both hosts
 * run this same code: Cloudflare inside a `HarbourBrowser` Durable Object (one per browser, with its Container), and
 * self-hosted inside the browser host service (one per Docker container). It
 *
 * - starts the container and Chromium, restoring the grant's context (a sealed profile tarball in the blob store) and
 *   setting the grant's sites in the browser itself (the agent's navigation guard), then starts the recording;
 * - runs model-free steps (Reflex `act` and `look`) and screenshots;
 * - moves each closed recording chunk (JPEG frames in Matroska, captured only when the screen changes) into the blob
 *   store, sealed, with a manifest the replay reads; nothing is encoded here or in the container;
 * - on release (or at its timeout) drains the recording, exports the profile when the grant persists, and stops the
 *   container.
 *
 * It is the part of brwsr's session Durable Object (tvdavies/brwsr@0d22bf8, src/session-do.ts) that Harbour needs:
 * no warm pool, billing, vault fills, CAPTCHAs, logs or Browserbase's session API. Portable: `fetch`, WebCrypto and
 * the interfaces below, no Node or Cloudflare APIs.
 *
 * The coordinator's own API, which a host serves under `/browsers/{id}` (src/runtime/protocol.ts):
 *
 *   POST /start                  { contextId?, persist, timeoutMs, sites? }  starts the browser (idempotent)
 *   POST /act                    { action }  one Reflex step (not `look`); its page
 *   GET  /look                   the page as Reflex sees it
 *   GET  /screenshot             { mimeType, data, url, title }
 *   GET  /status                 { status, startedAt, expiresAt, endedAt?, endReason? }
 *   POST /release                { reason? }  ends the browser (idempotent)
 *   GET  /recording              the recording's manifest (pages and their stored chunks)
 *   GET  /recording/{page}/{n}   one stored chunk, opened (video/x-matroska)
 *   WS   /live, /cdp             proxied to the agent by the host, with `agentHeaders()`
 */
import { type BrowserAction, HarbourError } from "@harbour/contracts";
import type { Sealer } from "./seal.ts";

/** The browser's container, as a host runs it. */
export interface BrowserMachine {
	/** Starts the container with this environment, unless it is running. Resolves once it has been asked to start. */
	start(env: { readonly [name: string]: string }): Promise<void>;
	/** An HTTP request to the agent in the container (port 8080). `path` starts with `/`. */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** Stops and removes the container. A container already gone is not an error. */
	stop(): Promise<void>;
}

/** Where profiles and recordings go: R2 on Cloudflare, S3 or a directory self-hosted. */
export interface BlobStore {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, bytes: Uint8Array): Promise<void>;
	delete(key: string): Promise<void>;
}

/** The coordinator's own small state (a Durable Object's storage, or memory). */
export interface CoordinatorStore {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
}

export type BrowserEndReason = "closed" | "timeout" | "failed";

export interface BrowserState {
	readonly status: "running" | "ended";
	readonly contextId?: string;
	readonly persist: boolean;
	readonly sites: readonly string[];
	readonly startedAt: number;
	readonly expiresAt: number;
	readonly endedAt?: number;
	readonly endReason?: BrowserEndReason;
	readonly agentToken: string;
}

export interface RecordingChunk {
	readonly index: number;
	readonly startMs: number;
	readonly durationMs: number;
	readonly frames: number;
	readonly bytes: number;
}

export interface RecordingPage {
	readonly pageId: string;
	/** When the page's first frame was drawn, in milliseconds from the browser's start. */
	readonly startMs: number;
	readonly durationMs: number;
	readonly width: number;
	readonly height: number;
	readonly frames: number;
	readonly chunks: readonly RecordingChunk[];
}

export interface RecordingManifest {
	readonly browserId: string;
	readonly status: "recording" | "complete" | "none";
	readonly startedAt: number;
	readonly endedAt?: number;
	/** When the stored frames are deleted (retention). */
	readonly expiresAt: number;
	readonly segmentSeconds: number;
	readonly pages: readonly RecordingPage[];
}

export interface CoordinatorOptions {
	readonly id: string;
	readonly machine: BrowserMachine;
	readonly blobs: BlobStore;
	readonly store: CoordinatorStore;
	readonly sealer: Sealer;
	readonly now?: () => number;
	/** How long recordings are kept. Default 7 days. */
	readonly recordingRetentionMs?: number;
	/** How long one agent call may take. Default 60 s. */
	readonly agentTimeoutMs?: number;
	/** How long the container has to answer `/health`. Default 60 s. */
	readonly startTimeoutMs?: number;
	/** The viewport Chromium starts with. Default 1280 x 800. */
	readonly viewport?: { readonly width: number; readonly height: number };
}

export const SEGMENT_SECONDS = 10;
export const DEFAULT_RECORDING_RETENTION_MS = 7 * 24 * 3_600_000;
export const AGENT_TOKEN_HEADER = "x-harbour-agent-token";

/** Blob keys. A context's profile, and a browser's recording (manifest and chunks). */
export const blobKeys = {
	context: (contextId: string) => `contexts/${encodeURIComponent(contextId)}.tgz`,
	manifest: (browserId: string) => `recordings/${encodeURIComponent(browserId)}/manifest.json`,
	chunk: (browserId: string, pageId: string, index: number) =>
		`recordings/${encodeURIComponent(browserId)}/${encodeURIComponent(pageId)}/${String(index).padStart(5, "0")}.mkv`,
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

const errorResponse = (error: unknown) => {
	if (error instanceof HarbourError) {
		const status =
			error.code === "invalid"
				? 400
				: error.code === "not_found"
					? 404
					: error.code === "expired"
						? 410
						: error.code === "conflict"
							? 409
							: 503;
		return json({ error: { code: error.code, message: error.message } }, status);
	}
	return json({ error: { code: "unavailable", message: "The browser failed" } }, 503);
};

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): { readonly [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: unknown })
		: {};
}

/** A Reflex act's body for a step other than `look` (brwsr's verbs). Never logged: a fill's value may be private. */
export function reflexBody(action: Exclude<BrowserAction, { readonly kind: "look" }>): {
	readonly [key: string]: string;
} {
	switch (action.kind) {
		case "goto":
			return { verb: "goto", url: action.url };
		case "click":
		case "check":
			return { verb: action.kind, element: action.element };
		case "fill":
		case "select":
			return { verb: action.kind, element: action.element, value: action.value };
		case "press":
			return { verb: "press", key: action.key };
		case "scroll":
		case "wait":
			return { verb: action.kind };
	}
}

const ACTION_KINDS = new Set(["goto", "click", "check", "fill", "select", "press", "scroll", "wait"]);

function parseAction(value: unknown): Exclude<BrowserAction, { readonly kind: "look" }> {
	const raw = record(value);
	if (typeof raw.kind !== "string" || !ACTION_KINDS.has(raw.kind)) throw new HarbourError("invalid", "Unknown step");
	const text = (name: string) => {
		const field = raw[name];
		if (typeof field !== "string" || field.length > 10_000) throw new HarbourError("invalid", `The step needs ${name}`);
		return field;
	};
	switch (raw.kind) {
		case "goto":
			return { kind: "goto", url: text("url") };
		case "click":
		case "check":
			return { kind: raw.kind, element: text("element") };
		case "fill":
		case "select":
			return { kind: raw.kind, element: text("element"), value: text("value") };
		case "press":
			return { kind: "press", key: text("key") };
		default:
			return { kind: raw.kind as "scroll" | "wait" };
	}
}

export interface BrowserCoordinator {
	/** Serves the coordinator's API (paths relative to the browser, as above). */
	handle(request: Request): Promise<Response>;
	/** Housekeeping, every few seconds while the browser runs: moves recording chunks; ends it at its timeout. */
	tick(): Promise<void>;
	/** The header a host adds when it proxies `/live` or `/cdp` to the agent, or `undefined` when the browser isn't running. */
	agentHeaders(): Promise<{ readonly [name: string]: string } | undefined>;
	/** The browser's state, or `undefined` before it started. */
	state(): Promise<BrowserState | undefined>;
	/** Ends the browser (as `release`). */
	end(reason: BrowserEndReason): Promise<void>;
}

export function createBrowserCoordinator(options: CoordinatorOptions): BrowserCoordinator {
	const { id, machine, blobs, store, sealer } = options;
	const now = options.now ?? Date.now;
	const retentionMs = options.recordingRetentionMs ?? DEFAULT_RECORDING_RETENTION_MS;
	const agentTimeoutMs = options.agentTimeoutMs ?? 60_000;
	const startTimeoutMs = options.startTimeoutMs ?? 60_000;
	const viewport = options.viewport ?? { width: 1280, height: 800 };
	let cachedState: BrowserState | undefined;
	let draining: Promise<void> | undefined;
	let ending: Promise<void> | undefined;
	let starting: Promise<BrowserState> | undefined;

	const readState = async () => {
		cachedState ??= await store.get<BrowserState>("state");
		return cachedState;
	};
	const writeState = async (state: BrowserState) => {
		cachedState = state;
		await store.put("state", state);
	};

	const agent = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> => {
		const state = token === undefined ? await readState() : undefined;
		const agentToken = token ?? state?.agentToken;
		if (agentToken === undefined) throw new HarbourError("expired", "The browser is not running");
		const headers = new Headers(init.headers);
		headers.set(AGENT_TOKEN_HEADER, agentToken);
		if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
		const timeout = AbortSignal.timeout(agentTimeoutMs);
		try {
			return await machine.fetch(path, {
				...init,
				headers,
				signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
			});
		} catch (error) {
			if (error instanceof HarbourError) throw error;
			throw new HarbourError("unavailable", `The browser did not answer ${path.split("?")[0]}`);
		}
	};

	const agentJson = async <T>(path: string, init?: RequestInit, token?: string): Promise<T> => {
		const response = await agent(path, init, token);
		const text = await response.text();
		if (!response.ok) {
			let message = `HTTP ${response.status}`;
			try {
				const body = record(JSON.parse(text));
				message = String(body.message ?? body.error ?? message).slice(0, 300);
			} catch {}
			throw new HarbourError(response.status === 409 ? "expired" : "unavailable", `The browser: ${message}`);
		}
		return (text === "" ? null : JSON.parse(text)) as T;
	};

	const running = async (): Promise<BrowserState> => {
		const state = await readState();
		if (state === undefined || state.status !== "running") throw new HarbourError("expired", "The browser has ended");
		if (state.expiresAt <= now()) {
			await end("timeout");
			throw new HarbourError("expired", "The browser has ended");
		}
		return state;
	};

	const emptyManifest = (startedAt: number): RecordingManifest => ({
		browserId: id,
		status: "recording",
		startedAt,
		expiresAt: startedAt + retentionMs,
		segmentSeconds: SEGMENT_SECONDS,
		pages: [],
	});

	const readManifest = async (): Promise<RecordingManifest | undefined> => {
		const local = await store.get<RecordingManifest>("recording");
		if (local !== undefined) return local;
		const key = blobKeys.manifest(id);
		const sealed = await blobs.get(key);
		if (sealed === undefined) return undefined;
		return JSON.parse(new TextDecoder().decode(await sealer.open(key, sealed))) as RecordingManifest;
	};

	const writeManifest = async (manifest: RecordingManifest) => {
		await store.put("recording", manifest);
		const key = blobKeys.manifest(id);
		await blobs.put(key, await sealer.seal(key, new TextEncoder().encode(JSON.stringify(manifest))));
	};

	async function start(input: {
		contextId?: string;
		persist: boolean;
		timeoutMs: number;
		sites: readonly string[];
	}): Promise<BrowserState> {
		const existing = await readState();
		if (existing !== undefined) {
			if (existing.status === "running") return existing;
			throw new HarbourError("expired", "This browser has ended; open another");
		}
		const agentToken = randomToken();
		const startedAt = now();
		await machine.start({ AGENT_TOKEN: agentToken });
		const deadline = startedAt + startTimeoutMs;
		for (;;) {
			try {
				const health = await machine.fetch("/health", { signal: AbortSignal.timeout(2_000) });
				if (health.ok) break;
			} catch {}
			if (now() > deadline) {
				await machine.stop().catch(() => undefined);
				throw new HarbourError("unavailable", "The browser container did not start in time");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		try {
			if (input.contextId !== undefined) {
				const key = blobKeys.context(input.contextId);
				const sealed = await blobs.get(key);
				if (sealed !== undefined) {
					const tarball = await sealer.open(key, sealed);
					await agentJson(
						"/profile",
						{
							method: "PUT",
							body: tarball as Uint8Array<ArrayBuffer>,
							headers: { "content-type": "application/gzip" },
						},
						agentToken,
					);
				}
			}
			await agentJson("/start", { method: "POST", body: JSON.stringify({ viewport }) }, agentToken);
			// Before anyone connects: the grant's sites, enforced by the browser itself. A guard that can't start fails the
			// launch, so a browser never runs unguarded. The agent's guard lets a domain's subdomains through, so it is a
			// little wider than the broker's rule (an exact host, or `*.host` for subdomains only); the broker still refuses
			// steps and screenshots off the grant's sites exactly.
			if (input.sites.length > 0) {
				const domains = [...new Set(input.sites.map((site) => site.replace(/^\*\./, "").toLowerCase()))];
				await agentJson("/domains", { method: "POST", body: JSON.stringify({ domains }) }, agentToken);
			}
		} catch (error) {
			await machine.stop().catch(() => undefined);
			throw error;
		}
		const state: BrowserState = {
			status: "running",
			...(input.contextId === undefined ? {} : { contextId: input.contextId }),
			persist: input.persist,
			sites: [...input.sites],
			startedAt,
			expiresAt: startedAt + input.timeoutMs,
			agentToken,
		};
		await writeState(state);
		// A recording that doesn't start leaves the browser running: it's a record, not a guard.
		try {
			await agentJson(
				"/recording/start",
				{ method: "POST", body: JSON.stringify({ segmentSeconds: SEGMENT_SECONDS }) },
				agentToken,
			);
			await writeManifest(emptyManifest(startedAt));
		} catch {
			await store.put("recording", { ...emptyManifest(startedAt), status: "none" } satisfies RecordingManifest);
		}
		return state;
	}

	/** Moves the agent's closed chunks into the blob store and updates the manifest. Returns whether capture is done. */
	async function drain(): Promise<boolean> {
		const manifest = await readManifest();
		const state = await readState();
		if (manifest === undefined || manifest.status !== "recording" || state === undefined) return true;
		const listing = record(await agentJson<unknown>("/recording"));
		const pages = new Map(manifest.pages.map((page) => [page.pageId, page]));
		let changed = false;
		for (const item of Array.isArray(listing.pages) ? listing.pages : []) {
			const lp = record(item);
			const pageId = typeof lp.pageId === "string" ? lp.pageId : undefined;
			if (pageId === undefined || !/^\d+$/.test(pageId) || typeof lp.startedAt !== "number") continue;
			const before = pages.get(pageId);
			const chunks = [...(before?.chunks ?? [])];
			for (const raw of Array.isArray(lp.chunks) ? lp.chunks : []) {
				const chunk = record(raw);
				const name = typeof chunk.name === "string" ? chunk.name : "";
				const index = typeof chunk.index === "number" ? chunk.index : -1;
				if (!/^\d{5}\.mkv$/.test(name) || index < 0) continue;
				const response = await agent(`/recording/${pageId}/${name}`);
				if (!response.ok) {
					await response.body?.cancel();
					continue;
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				const key = blobKeys.chunk(id, pageId, index);
				await blobs.put(key, await sealer.seal(key, bytes));
				await (await agent(`/recording/${pageId}/${name}`, { method: "DELETE" })).body?.cancel();
				const stored: RecordingChunk = {
					index,
					startMs: Number(chunk.startMs) || 0,
					durationMs: Number(chunk.durationMs) || 0,
					frames: Number(chunk.frames) || 0,
					bytes: bytes.length,
				};
				const at = chunks.findIndex((each) => each.index === index);
				if (at >= 0) chunks[at] = stored;
				else chunks.push(stored);
				changed = true;
			}
			chunks.sort((a, b) => a.index - b.index);
			const page: RecordingPage = {
				pageId,
				startMs: Math.max(0, lp.startedAt - state.startedAt),
				durationMs: Number(lp.durationMs) || 0,
				width: Number(lp.width) || 0,
				height: Number(lp.height) || 0,
				frames: Number(lp.frames) || 0,
				chunks,
			};
			if (JSON.stringify(before) !== JSON.stringify(page)) changed = true;
			pages.set(pageId, page);
		}
		const done = listing.done === true;
		if (changed || done) {
			const next: RecordingManifest = {
				...manifest,
				status: done ? "complete" : "recording",
				...(done ? { endedAt: now() } : {}),
				pages: [...pages.values()].sort((a, b) => Number(a.pageId) - Number(b.pageId)),
			};
			await writeManifest(next);
		}
		return done;
	}

	const drainOnce = () => {
		draining ??= drain()
			.then(() => undefined)
			.finally(() => {
				draining = undefined;
			});
		return draining;
	};

	function end(reason: BrowserEndReason): Promise<void> {
		ending ??= (async () => {
			const state = await readState();
			if (state === undefined || state.status !== "running") return;
			try {
				await draining?.catch(() => undefined);
				const manifest = await readManifest();
				if (manifest?.status === "recording") {
					await agentJson("/recording/stop", { method: "POST" }).catch(() => undefined);
					for (let attempt = 0; attempt < 5; attempt++) {
						if (await drain().catch(() => true)) break;
					}
				}
				if (state.persist && state.contextId !== undefined) {
					const response = await agent("/export", { method: "POST" });
					if (response.ok) {
						const key = blobKeys.context(state.contextId);
						await blobs.put(key, await sealer.seal(key, new Uint8Array(await response.arrayBuffer())));
					} else {
						await response.body?.cancel();
					}
				}
			} catch {
				// The browser ends whatever failed above: a lost profile write is better than a browser that never stops.
			} finally {
				await machine.stop().catch(() => undefined);
				await writeState({ ...state, status: "ended", endedAt: now(), endReason: reason });
			}
		})().finally(() => {
			ending = undefined;
		});
		return ending;
	}

	async function screenshot(): Promise<{ mimeType: string; data: string; url: string; title: string }> {
		await running();
		const pages = await agentJson<{ url?: string; title?: string }[]>("/pages");
		const front = (Array.isArray(pages) ? pages : []).find((page) => page.url !== "about:blank") ?? pages[0];
		const response = await agent(`/screenshot?width=${viewport.width}`);
		if (!response.ok) {
			await response.body?.cancel();
			throw new HarbourError("unavailable", "The browser has no page to capture");
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { mimeType: "image/jpeg", data: btoa(binary), url: front?.url ?? "", title: front?.title ?? "" };
	}

	async function readJsonBody(request: Request): Promise<{ readonly [key: string]: unknown }> {
		const text = await request.text();
		if (text.length > 64 * 1024) throw new HarbourError("invalid", "The body is too big");
		try {
			return record(text === "" ? {} : JSON.parse(text));
		} catch {
			throw new HarbourError("invalid", "The body is not JSON");
		}
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		try {
			if (request.method === "POST" && path === "/start") {
				const body = await readJsonBody(request);
				const timeoutMs = Number(body.timeoutMs);
				if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 6 * 3_600_000) {
					throw new HarbourError("invalid", "timeoutMs must be 10 s to 6 h");
				}
				const sites = Array.isArray(body.sites) ? body.sites.filter((site) => typeof site === "string") : [];
				starting ??= start({
					...(typeof body.contextId === "string" && body.contextId !== "" ? { contextId: body.contextId } : {}),
					persist: body.persist === true,
					timeoutMs,
					sites: sites as string[],
				}).finally(() => {
					starting = undefined;
				});
				const state = await starting;
				return json({ status: state.status, startedAt: state.startedAt, expiresAt: state.expiresAt });
			}
			if (request.method === "POST" && path === "/act") {
				await running();
				const action = parseAction((await readJsonBody(request)).action);
				return json(await agentJson("/reflex/act", { method: "POST", body: JSON.stringify(reflexBody(action)) }));
			}
			if (request.method === "GET" && path === "/look") {
				await running();
				return json(await agentJson("/reflex/look", { method: "POST", body: "{}" }));
			}
			if (request.method === "GET" && path === "/screenshot") return json(await screenshot());
			if (request.method === "GET" && path === "/status") {
				const state = await readState();
				if (state === undefined) throw new HarbourError("not_found", "No such browser");
				if (state.status === "running" && state.expiresAt <= now()) await end("timeout");
				const current = (await readState())!;
				return json({
					status: current.status,
					startedAt: current.startedAt,
					expiresAt: current.expiresAt,
					...(current.endedAt === undefined ? {} : { endedAt: current.endedAt }),
					...(current.endReason === undefined ? {} : { endReason: current.endReason }),
				});
			}
			if (request.method === "POST" && path === "/release") {
				await end("closed");
				// What was stored, for the broker's `browser.recording.stored`: counts only.
				const manifest = await readManifest();
				const frames = manifest?.pages.reduce((sum, page) => sum + page.frames, 0) ?? 0;
				if (manifest?.status !== "complete" || frames === 0) return json({ status: "ended" });
				const durationMs = Math.max(...manifest.pages.map((page) => page.startMs + page.durationMs));
				return json({
					status: "ended",
					recording: { pages: manifest.pages.length, frames, durationMs, expiresAt: manifest.expiresAt },
				});
			}
			if (request.method === "GET" && path === "/recording") {
				const manifest = await readManifest();
				if (manifest === undefined) throw new HarbourError("not_found", "This browser has no recording");
				if (manifest.expiresAt <= now()) throw new HarbourError("expired", "The recording is past its retention");
				return json(manifest);
			}
			const chunkPath = path.match(/^\/recording\/(\d+)\/(\d{1,5})$/);
			if (request.method === "GET" && chunkPath !== null) {
				const manifest = await readManifest();
				if (manifest === undefined) throw new HarbourError("not_found", "This browser has no recording");
				if (manifest.expiresAt <= now()) throw new HarbourError("expired", "The recording is past its retention");
				const key = blobKeys.chunk(id, chunkPath[1]!, Number(chunkPath[2]));
				const sealed = await blobs.get(key);
				if (sealed === undefined) throw new HarbourError("not_found", "No such chunk");
				return new Response((await sealer.open(key, sealed)) as Uint8Array<ArrayBuffer>, {
					headers: { "content-type": "video/x-matroska", "cache-control": "private, max-age=3600, immutable" },
				});
			}
			return json({ error: { code: "not_found", message: "No such browser route" } }, 404);
		} catch (error) {
			return errorResponse(error);
		}
	}

	return {
		handle,
		async tick() {
			const state = await readState();
			if (state === undefined || state.status !== "running") return;
			if (state.expiresAt <= now()) return end("timeout");
			await drainOnce().catch(() => undefined);
		},
		async agentHeaders() {
			const state = await readState();
			if (state === undefined || state.status !== "running" || state.expiresAt <= now()) return undefined;
			return { [AGENT_TOKEN_HEADER]: state.agentToken };
		},
		state: readState,
		end,
	};
}
