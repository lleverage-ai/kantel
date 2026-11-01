/**
 * `KantelSandbox`: one session's container tier on Cloudflare. A Durable Object with its Container (images/sandbox,
 * the agent `images/sandbox/agent/agent.ts` on port 8080), named by the session (`src/container-backend.ts` has the
 * other half, in the stack object). Ported from the Cloudflare spike's `KantelContainer` (spikes/cloudflare/src/container-tier.ts).
 *
 * - **Its own state** (storage): the lease that holds the container, each ended lease's fence, whether the session
 *   ever ran a command here (a warm-up starts only a container the session has needed before, unless forced), and
 *   whether the session has closed (`closeSession`: its container stopped at once, and nothing starts it again).
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
import { withKantelEnv } from "@kantel/contracts/env";
import type {
	Behind,
	ContainerCall,
	ContainerChanges,
	ContainerClosed,
	ContainerCommand,
	ContainerRan,
	ContainerStage,
	ContainerStaged,
	ContainerSync,
	ContainerWarmed,
	SandboxContainer,
} from "./container-backend.ts";
import { startContainer } from "./sandbox-start.ts";
import { stopContainer } from "./sandbox-stop.ts";

const PORT = 8080;
/** How long a container waits for a call before it stops. A warm-up on typing covers coming back later. */
const INACTIVITY_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 60_000;
/** How long a start keeps asking for an instance while Cloudflare has none free (src/sandbox-start.ts). */
const INSTANCE_WAIT_MS = 20_000;
/** A closed session's container this object can't see stops this long after its last call (src/sandbox-stop.ts). */
const CLOSED_INACTIVITY_MS = 1_000;
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

export class KantelSandboxBase extends DurableObject implements SandboxContainer {
	#queue: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, withKantelEnv(env));
		// An object that restarts (a deploy) starts without its container's inactivity timeout, and without one Cloudflare
		// stops a running container as soon as the object is idle: set it again, as for a new start.
		const container = ctx.container;
		if (container?.running === true)
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
	}

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
			await this.#refuseClosed();
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
			// An expired lease is never committed: its working copy goes, and so does the container. The lease went 15
			// minutes without a command, past the 10-minute inactivity stop, so a container still running then (one whose
			// object restarted without its timeout, say) stops here rather than running on reset. A released lease's
			// container stays, warm, for the next lease.
			if (args.discard && this.#running()) await this.#container()?.destroy();
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
			// A closed session's container stays stopped, forced or not.
			if ((await this.ctx.storage.get<boolean>("closed")) === true)
				return { kind: "warmed", state: "skipped", timings: {} };
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
				await this.#refuseClosed();
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

	async closeSession(): Promise<ContainerClosed> {
		// Serialised behind any call still running here, so a start in flight (its wait for an instance included) has
		// settled before the close looks.
		return this.#serial(async () => {
			const container = this.#container();
			// A session that never ran a container here has nothing to stop, and nothing worth storing: every closed session
			// calls this, and most never escalate.
			if (!this.#running() && (await this.ctx.storage.get<boolean>("used")) !== true) return { stopped: false };
			await this.ctx.storage.put("closed", true);
			const owner = await this.ctx.storage.get<Owner>("owner");
			// The stack released the session's lease (committing its last changes) before this call; fence one it couldn't,
			// so nothing more runs on it.
			if (owner !== undefined && owner.leaseId !== "") {
				await this.ctx.storage.put(fenceKey(owner.leaseId), "ended" satisfies Fence);
				await this.ctx.storage.put("owner", { ...owner, leaseId: "" } satisfies Owner);
			}
			// Stopped now, not after the inactivity timeout: the instance is free for another session at once. `running` is
			// only this object's view, and can read false while Cloudflare still runs the container: that one gets a short
			// inactivity timeout instead, as `destroy()` would do nothing.
			if (container === undefined) return { stopped: false };
			const via = await stopContainer(container, { releaseMs: CLOSED_INACTIVITY_MS });
			return via === "none" ? { stopped: false } : { stopped: true, via };
		});
	}

	// ---- internals ---------------------------------------------------------------------------------------------------

	/** A closed session runs nothing more here. */
	async #refuseClosed(): Promise<void> {
		if ((await this.ctx.storage.get<boolean>("closed")) === true) throw new Error("the session has closed");
	}

	/**
	 * Starts the container if needed and makes `leaseId` its owner. A container holding another workspace's working copy
	 * starts that copy again. Another lease of this session takes the container over: the stack holds one container lease
	 * per session, so an owner it doesn't know is one an eviction made it forget, whose changes were committed after its
	 * last command.
	 */
	async #claim(leaseId: string, workspaceId: string): Promise<Record<string, number>> {
		const container = this.#container();
		if (container === undefined) {
			throw new Error("This deployment runs no sandbox containers (KANTEL_SANDBOX_CONTAINERS is off)");
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

	#start(container: Container): Promise<Record<string, number>> {
		// No `monitor()`: a pending one keeps this object busy for up to 15 minutes, which holds off the inactivity
		// timeout (src/sandbox-start.ts).
		return startContainer(container, {
			startup: { enableInternet: false, entrypoint: ENTRYPOINT, env: AGENT_ENV },
			port: PORT,
			inactivityMs: INACTIVITY_MS,
			readyTimeoutMs: READY_TIMEOUT_MS,
			instanceWaitMs: INSTANCE_WAIT_MS,
		});
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
