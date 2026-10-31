/**
 * `HarbourBrowser`: Harbour's own browser on Cloudflare (docs/design/browser-runtime.md), one Durable Object with its
 * Container per browser, as brwsr's session object is (tvdavies/brwsr@0d22bf8, src/session-do.ts). The object runs the
 * portable coordinator (`@harbour/browser/runtime`) over:
 *
 * - its Container (images/browser, the agent on port 8080), placed in WEUR by the container app's `constraints`;
 * - R2: the workspaces bucket under `browser/` (contexts' profiles and recordings, sealed with `HARBOUR_BROWSER_SEAL_KEY`);
 * - its own storage for its state, and its alarm, every few seconds while the browser runs, for the recording's chunks
 *   and the browser's timeout.
 *
 * Goal mode (`/run`): the container asks for its decisions at `BROWSER_DECISIONS_URL`, which this object intercepts
 * for its own container and routes to `HarbourBrowserDecisions` (`src/browser-decisions.ts`) with the browser's
 * decision token, so the model (Clef through Workers AI, or Jev with its key) never reaches the container.
 *
 * Who reaches it: the stack object, by the browser's ID, for the coordinator's routes (`/browsers/{id}/…`; the harbour
 * provider in `src/browser.ts`), and a viewer holding a view token (`/v1/browser/view/{browser}/…`, routed here by the
 * Worker once the token checks out, and checked again here).
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
	type BlobStore,
	BROWSER_VIEW_API,
	type BrowserCoordinator,
	createBrowserCoordinator,
	createBrowserViewSigner,
	createSealer,
	declineConsentSetting,
	handleBrowserView,
	type PipeSocket,
	pipeLive,
	prefixedBlobs,
	VIEW_PROTOCOL,
} from "@harbour/browser/runtime";
import {
	answerDecision,
	BROWSER_DECISIONS_ADDRESS,
	BROWSER_DECISIONS_URL,
	type DecisionModels,
	type DecisionVars,
} from "./browser-decisions.ts";

export interface BrowserObjectVars extends DecisionVars {
	/** Seals profiles and recordings in R2. A Worker secret. */
	readonly HARBOUR_BROWSER_SEAL_KEY?: string;
	/** Signs view links. A Worker secret. */
	readonly HARBOUR_BROWSER_VIEW_KEY?: string;
	/** Days a recording is kept. Default 7. */
	readonly HARBOUR_BROWSER_RECORDING_DAYS?: string;
	/** `off` stops steps and looks declining cookie and consent dialogs ("Reject all"). Default on. */
	readonly HARBOUR_BROWSER_CONSENT?: string;
}

export interface BrowserObjectEnv extends BrowserObjectVars {
	readonly WORKSPACES: R2Bucket;
	/** Workers AI, for Clef's decisions in goal mode. */
	readonly AI?: DecisionModels["ai"];
}

/** What the decisions entrypoint is made with, for one browser's container: the token its requests must carry. */
export interface DecisionProps {
	readonly token: string;
}

/**
 * `HarbourBrowserDecisions`: answers one browser container's decision requests (`src/browser-decisions.ts`), made by
 * its `HarbourBrowser` object through `ctx.exports` with the browser's decision token, and reached only through that
 * object's intercept.
 */
export class HarbourBrowserDecisionsBase extends WorkerEntrypoint<BrowserObjectEnv, DecisionProps> {
	override async fetch(request: Request): Promise<Response> {
		return answerDecision(request, this.ctx.props.token, {
			...(this.env.AI === undefined ? {} : { ai: this.env.AI }),
			...(this.env.HARBOUR_JEV_API_KEY === undefined ? {} : { jevApiKey: this.env.HARBOUR_JEV_API_KEY }),
		});
	}
}

/** The decisions entrypoint as `ctx.exports` offers it, when the runtime does. */
type DecisionsExport = (options: { readonly props: DecisionProps }) => Fetcher;

/** The prefix the browser's blobs have in the workspaces bucket. Its R2 lifecycle rule is the retention's backstop. */
export const BROWSER_BLOB_PREFIX = "browser/";
const TICK_MS = 5_000;
const BROWSER_PATH = /^\/browsers\/([A-Za-z0-9-]{1,64})(\/.*)$/;

export function r2Blobs(bucket: R2Bucket): BlobStore {
	return {
		async get(key) {
			const object = await bucket.get(key);
			return object === null ? undefined : new Uint8Array(await object.arrayBuffer());
		},
		async put(key, bytes) {
			await bucket.put(key, bytes);
		},
		async delete(key) {
			await bucket.delete(key);
		},
	};
}

export function recordingRetentionMs(vars: BrowserObjectVars): number {
	const days = Number((vars.HARBOUR_BROWSER_RECORDING_DAYS ?? "").trim() || "7");
	return (Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7) * 24 * 3_600_000;
}

export class HarbourBrowserBase extends DurableObject<BrowserObjectEnv> {
	#coordinator: BrowserCoordinator | undefined;

	/** The coordinator for this object's browser, made with its ID the first time the stack names it. */
	async #coordinatorFor(id?: string): Promise<BrowserCoordinator | undefined> {
		if (this.#coordinator !== undefined) return this.#coordinator;
		const stored = await this.ctx.storage.get<string>("id");
		const browserId = stored ?? id;
		if (browserId === undefined) return undefined;
		if (stored === undefined) await this.ctx.storage.put("id", browserId);
		const sealKey = this.env.HARBOUR_BROWSER_SEAL_KEY ?? "";
		const container = this.ctx.container;
		if (container === undefined) throw new Error("HarbourBrowser has no container");
		const storage = this.ctx.storage;
		const decisions = (this.ctx as unknown as { readonly exports?: { readonly [name: string]: unknown } }).exports
			?.HarbourBrowserDecisions as DecisionsExport | undefined;
		this.#coordinator = createBrowserCoordinator({
			id: browserId,
			machine: {
				start: async (env, options) => {
					if (container.running) return;
					container.start({ enableInternet: true, env });
					// Goal mode's decisions: this container's requests to the address, and only its, answered here.
					if (decisions !== undefined && options?.decisionToken !== undefined) {
						await container.interceptOutboundHttp(
							BROWSER_DECISIONS_ADDRESS,
							decisions({ props: { token: options.decisionToken } }),
						);
					}
					// The object's alarm ends the browser properly; this stops a container the object lost track of.
					await container.setInactivityTimeout(15 * 60_000);
				},
				fetch: (path, init) => container.getTcpPort(8080).fetch(`http://agent${path}`, init),
				stop: async () => {
					if (container.running) await container.destroy();
				},
			},
			blobs: prefixedBlobs(r2Blobs(this.env.WORKSPACES), BROWSER_BLOB_PREFIX),
			store: { get: (key) => storage.get(key), put: (key, value) => storage.put(key, value) },
			sealer: createSealer(sealKey),
			recordingRetentionMs: recordingRetentionMs(this.env),
			...(decisions === undefined ? {} : { decisions: { url: BROWSER_DECISIONS_URL } }),
			declineConsent: declineConsentSetting(this.env.HARBOUR_BROWSER_CONSENT),
		});
		return this.#coordinator;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith(BROWSER_VIEW_API)) return this.#view(request);
		const match = url.pathname.match(BROWSER_PATH);
		if (match === null)
			return Response.json({ error: { code: "not_found", message: "No such route" } }, { status: 404 });
		const coordinator = await this.#coordinatorFor(match[1]);
		if (coordinator === undefined) return Response.json({ error: { code: "not_found" } }, { status: 404 });
		const inner = new Request(new URL(`${match[2]}${url.search}`, "http://browser"), request);
		const response = await coordinator.handle(inner);
		if (response.ok && match[2] === "/start") await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
		return response;
	}

	override async alarm(): Promise<void> {
		const coordinator = await this.#coordinatorFor();
		if (coordinator === undefined) return;
		await coordinator.tick();
		const state = await coordinator.state();
		if (state?.status === "running") await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
	}

	/** A viewer's request, its token checked again here: the view's status, its recording, or the live socket. */
	async #view(request: Request): Promise<Response> {
		const coordinator = await this.#coordinatorFor();
		const viewKey = this.env.HARBOUR_BROWSER_VIEW_KEY ?? "";
		if (coordinator === undefined || viewKey === "") {
			return Response.json({ error: { code: "not_found", message: "No such view" } }, { status: 404 });
		}
		const self = {
			fetch: (_browserId: string, path: string, init?: RequestInit) =>
				coordinator.handle(new Request(new URL(path, "http://browser"), init)),
		};
		const answer = await handleBrowserView(request, { views: createBrowserViewSigner(viewKey), host: self });
		if (answer.response !== undefined) return answer.response;
		const live = answer.live!;
		const headers = await coordinator.agentHeaders();
		if (headers === undefined) {
			return Response.json({ error: { code: "expired", message: "The browser has ended" } }, { status: 410 });
		}
		const container = this.ctx.container!;
		const upgrade = await container.getTcpPort(8080).fetch(`http://agent${live.path}`, {
			headers: { ...headers, upgrade: "websocket" },
		});
		const up = upgrade.webSocket;
		if (up === null) {
			await upgrade.body?.cancel();
			return Response.json({ error: { code: "unavailable", message: "The live view did not open" } }, { status: 503 });
		}
		up.accept();
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();
		pipeLive(up as unknown as PipeSocket, server as unknown as PipeSocket, {
			control: live.claims.control,
			expiresAt: live.claims.expiresAt,
		});
		// The viewer offered the token as a subprotocol; the answer picks the plain one, so the token isn't echoed.
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: { "sec-websocket-protocol": VIEW_PROTOCOL },
		});
	}
}
