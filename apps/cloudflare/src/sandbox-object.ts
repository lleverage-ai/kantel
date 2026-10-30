/**
 * `HarbourSandbox`: one session's container tier on Cloudflare. A Durable Object with its Container (images/sandbox,
 * the agent `images/sandbox/agent/agent.ts` on port 8080), named by the session (`src/container-backend.ts` has the
 * other half, in the stack object). Ported from the M0 spike's `HarbourContainer` (spikes/cloudflare/src/container-tier.ts).
 *
 * - **Its own state** (storage): the lease that holds the container, each ended lease's fence, and whether the session
 *   ever ran a command here (a warm-up starts only a container the session has needed before, unless forced).
 * - **No storage, no credentials**: every call brings its sync from the stack object, which read the workspace with the
 *   caller's context. The object only forwards it.
 * - **No network**: `enableInternet: false` and nothing intercepted, so no request leaves the container, as none leaves
 *   the isolate. Egress through the vault is a later step.
 * - **Calls are serialised**, so a re-base, a command and a commit never interleave.
 *
 * A container stops after `INACTIVITY_MS` without calls; what it held is gone then, so the stack commits after every
 * command (`checkpointContainer`), and a new lease of the same session takes over a container an evicted stack forgot.
 */
import { DurableObject } from "cloudflare:workers";
import type {
	Behind,
	ContainerCall,
	ContainerChanges,
	ContainerCommand,
	ContainerRan,
	ContainerStage,
	ContainerStaged,
	ContainerSync,
	ContainerWarmed,
	SandboxContainer,
} from "./container-backend.ts";

const PORT = 8080;
/** How long a container waits for a call before it stops. A warm-up on typing covers coming back later. */
const INACTIVITY_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 60_000;
const ENTRYPOINT = ["bun", "/opt/harbour/agent.ts"];
/**
 * The agent's own environment. The image's HOME is /workspace (the self-hosted tier's), where Bun would keep its
 * transpiler cache for the agent itself, and every checkpoint would commit it: the agent gets a home outside the
 * workspace and no cache.
 */
const AGENT_ENV = { HOME: "/home/sandbox", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };

/** The lease holding the container (`""` when none does) and the workspace its working copy is of. */
interface Owner {
	readonly leaseId: string;
	readonly workspaceId: string;
}

/** `closing` once a release has taken its final snapshot, `ended` once the lease is over: it runs nothing more. */
type Fence = "closing" | "ended";
const fenceKey = (leaseId: string) => `fence:${leaseId}`;

export class HarbourSandboxBase extends DurableObject implements SandboxContainer {
	#queue: Promise<unknown> = Promise.resolve();

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => undefined);
		return next;
	}

	#container(): Container | undefined {
		return this.ctx.container;
	}

	#running(): boolean {
		return this.#container()?.running === true;
	}

	async exec(call: ContainerCall & { readonly request: ContainerCommand }): Promise<ContainerRan> {
		return this.#serial(async () => {
			const fence = await this.ctx.storage.get<Fence>(fenceKey(call.leaseId));
			if (fence !== undefined) {
				throw new Error(`lease ${call.leaseId} ${fence === "closing" ? "is being released" : "has ended"}`);
			}
			const timings = await this.#claim(call.leaseId, call.workspaceId);
			await this.ctx.storage.put("used", true);
			const started = performance.now();
			const response = await this.#post("/exec", { sync: call.sync, ...call.request });
			const behind = await behindOf(response);
			if (behind !== undefined) return behind;
			if (!response.ok) throw new Error(`sandbox /exec failed: ${response.status} ${await response.text()}`);
			const body = (await response.json()) as {
				stdout: string;
				stderr: string;
				exitCode: number;
				truncated?: boolean;
				timings: Record<string, number>;
			};
			return {
				kind: "ran",
				exitCode: body.exitCode,
				stdout: body.stdout,
				stderr: body.stderr,
				...(body.truncated === true ? { truncated: true } : {}),
				timings: { ...timings, ...body.timings, "container.request": round(performance.now() - started) },
			};
		});
	}

	async changes(call: ContainerCall & { readonly final?: boolean }): Promise<ContainerChanges> {
		return this.#serial(async () => {
			// Fenced whether or not the lease ever held the container: a command of its still on the way is refused.
			if (call.final === true && (await this.ctx.storage.get<Fence>(fenceKey(call.leaseId))) === undefined) {
				await this.ctx.storage.put(fenceKey(call.leaseId), "closing" satisfies Fence);
			}
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (owner?.leaseId !== call.leaseId || !this.#running()) {
				return { kind: "changes", put: [], remove: [], stamp: 0 };
			}
			const response = await this.#post("/changes", { sync: call.sync });
			const behind = await behindOf(response);
			if (behind !== undefined) return behind;
			if (!response.ok) throw new Error(`sandbox /changes failed: ${response.status}`);
			const body = (await response.json()) as { put: ContainerSync["put"]; remove: string[]; stamp: number };
			return { kind: "changes", put: body.put, remove: body.remove, stamp: body.stamp };
		});
	}

	async ack(args: { readonly leaseId: string; readonly version: number; readonly stamp: number }): Promise<void> {
		return this.#serial(async () => {
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (owner?.leaseId !== args.leaseId || !this.#running()) return;
			const response = await this.#post("/ack", { version: args.version, stamp: args.stamp });
			if (!response.ok) throw new Error(`sandbox /ack failed: ${response.status}`);
		});
	}

	async ended(args: { readonly leaseId: string; readonly discard: boolean }): Promise<void> {
		return this.#serial(async () => {
			await this.ctx.storage.put(fenceKey(args.leaseId), "ended" satisfies Fence);
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (owner?.leaseId !== args.leaseId) return;
			// An expired lease is never committed: its working copy goes. A released one stays, warm, for the next lease.
			if (args.discard && this.#running()) await this.#post("/reset");
			await this.ctx.storage.put("owner", { ...owner, leaseId: "" } satisfies Owner);
		});
	}

	async warm(args: {
		readonly sessionId: string;
		readonly workspaceId: string;
		readonly head: number;
		readonly sync?: ContainerSync;
		readonly force?: boolean;
	}): Promise<ContainerWarmed> {
		return this.#serial(async () => {
			if (this.#container() === undefined) return { kind: "warmed", state: "unavailable", timings: {} };
			if (args.force !== true && (await this.ctx.storage.get<boolean>("used")) !== true) {
				return { kind: "warmed", state: "skipped", timings: {} };
			}
			const wasRunning = this.#running();
			const state = wasRunning ? "running" : "started";
			const owner = await this.ctx.storage.get<Owner>("owner");
			// A warm-up never takes the container from a lease; it only starts it, or re-bases what it holds.
			const timings = await this.#claim(owner?.leaseId ?? "", args.workspaceId);
			const started = performance.now();
			if (args.sync === undefined) {
				// A probe: a container that holds the head is ready; otherwise the caller sends the sync from what it holds.
				const health = (await (await this.#get("/health")).json()) as { version: number | null };
				timings["container.health"] = round(performance.now() - started);
				if (health.version === args.head) return { kind: "warmed", state, timings };
				return { kind: "behind", have: health.version, started: !wasRunning, timings };
			}
			const response = await this.#post("/sync", { sync: args.sync });
			const behind = await behindOf(response);
			if (behind !== undefined) return behind;
			if (!response.ok) throw new Error(`sandbox /sync failed: ${response.status}`);
			timings["container.sync"] = round(performance.now() - started);
			return { kind: "warmed", state, timings };
		});
	}

	async stage(call: ContainerStage): Promise<ContainerStaged> {
		return this.#serial(async () => {
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (call.start) {
				// Ahead of a command (or a warm-up, with no lease): start the container and claim it, as the call will.
				if (call.leaseId !== undefined) {
					const fence = await this.ctx.storage.get<Fence>(fenceKey(call.leaseId));
					if (fence !== undefined) {
						throw new Error(`lease ${call.leaseId} ${fence === "closing" ? "is being released" : "has ended"}`);
					}
				}
				await this.#claim(call.leaseId ?? owner?.leaseId ?? "", call.workspaceId);
			} else if (!this.#running() || owner?.leaseId !== call.leaseId) {
				// Ahead of `changes`, which reads only its own lease's running container: nothing to stage.
				return { kind: "staged" };
			}
			const response = await this.#post("/sync", { sync: { ...call.sync, partial: true } });
			const behind = await behindOf(response);
			if (behind !== undefined) return behind;
			if (!response.ok) throw new Error(`sandbox /sync failed: ${response.status}`);
			return { kind: "staged" };
		});
	}

	// ---- internals ---------------------------------------------------------------------------------------------------

	/**
	 * Starts the container if needed and makes `leaseId` its owner. A container holding another workspace's working copy
	 * starts that copy again. Another lease of this session takes the container over: the stack holds one container lease
	 * per session, so an owner it doesn't know is one an eviction made it forget, whose changes were committed after its
	 * last command.
	 */
	async #claim(leaseId: string, workspaceId: string): Promise<Record<string, number>> {
		const container = this.#container();
		if (container === undefined) {
			throw new Error("This deployment runs no sandbox containers (HARBOUR_SANDBOX_CONTAINERS is off)");
		}
		const owner = await this.ctx.storage.get<Owner>("owner");
		const claim: Owner = { leaseId, workspaceId };
		if (!container.running) {
			// Claimed before starting, so a call that interleaves with the start sees the right owner.
			await this.ctx.storage.put("owner", claim);
			return this.#start(container);
		}
		if (owner === undefined || owner.workspaceId !== workspaceId) await this.#post("/reset");
		await this.ctx.storage.put("owner", claim);
		return {};
	}

	async #start(container: Container): Promise<Record<string, number>> {
		const timings: Record<string, number> = {};
		let at = performance.now();
		container.start({ enableInternet: false, entrypoint: ENTRYPOINT, env: AGENT_ENV });
		this.ctx.waitUntil(
			container
				.monitor()
				.catch((error) => console.error(JSON.stringify({ message: "sandbox container exited", error: String(error) }))),
		);
		await container.setInactivityTimeout(INACTIVITY_MS);
		timings["container.start"] = round(performance.now() - at);
		at = performance.now();
		const port = container.getTcpPort(PORT);
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await port.fetch("http://sandbox/health");
				if (response.ok) break;
			} catch {
				// Not listening yet.
			}
			if (performance.now() - at > READY_TIMEOUT_MS) throw new Error("the sandbox container did not start in 60 s");
			await new Promise((resolve) => setTimeout(resolve, attempt < 40 ? 50 : 250));
		}
		timings["container.ready"] = round(performance.now() - at);
		return timings;
	}

	async #get(path: string): Promise<Response> {
		const container = this.#container();
		if (container === undefined) throw new Error("no sandbox container");
		return container.getTcpPort(PORT).fetch(`http://sandbox${path}`);
	}

	async #post(path: string, body?: unknown): Promise<Response> {
		const container = this.#container();
		if (container === undefined) throw new Error("no sandbox container");
		return container.getTcpPort(PORT).fetch(`http://sandbox${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? "{}" : JSON.stringify(body),
		});
	}
}

/** The agent's `409 version_mismatch` as `behind`, with the version it holds (null: an empty working copy). */
async function behindOf(response: Response): Promise<Behind | undefined> {
	if (response.status !== 409) return undefined;
	const { have } = (await response.json()) as { have: number | null };
	return { kind: "behind", have };
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}
