import { DurableObject } from "cloudflare:workers";
import type { CallContext, ExecRequest } from "@harbour/contracts";
import { r2Store } from "./r2.ts";
import { listAll, type ModedChange, type ModedFileEntry, ObjectStoreWorkspaces } from "./workspace.ts";

/** What every call carries: the lease it is for and the workspace head to re-base on. */
export type ContainerCall = {
	readonly leaseId: string;
	readonly sessionId: string;
	readonly workspaceId: string;
	readonly head: number;
	readonly ctx: CallContext;
};

type Put = { path: string; mode: number; content: string };
type Sync = { from: number | null; to: number; put: Put[]; remove: string[] };
type ContainerExecBody = {
	stdout: string;
	stderr: string;
	exitCode: number;
	dirty: number;
	timings: Record<string, number>;
	container: { bootedAt: number; execs: number };
};
/** `closing`: the lease's release has taken its final snapshot; no more commands run on it. */
type Owner = { leaseId: string; sessionId: string; workspaceId: string; closing?: boolean };

/** A container's uncommitted changes, with the stamp that acknowledges exactly these and nothing later. */
export type ContainerPending = { readonly changes: ModedChange[]; readonly stamp: number };

const PORT = 8080;
const INACTIVITY_MS = 3 * 60_000;
/** Instance size, chosen per start under the durable_object scheduling policy. */
const INSTANCE = "standard-1";
const SYNC_CONCURRENCY = 32;

/**
 * The container tier: one Durable Object per container, using the Durable Object Container API directly
 * (`durable_object` scheduling policy, so the object picks the image and instance size at start).
 *
 * The container keeps a working copy of one workspace. Before every command the object re-bases it on the workspace
 * head (the container's own uncommitted changes win), so it sees the isolate's last write. Its changes stay in the
 * container until the sandbox commits them: on lease release, or before an isolate command (see src/sandbox.ts).
 *
 * A running container belongs to one live lease at a time. Calls are serialised, so a re-base, a command and a commit
 * never interleave.
 *
 * No internet: `enableInternet: false`, and every HTTP and HTTPS request the container makes is intercepted and handed
 * to VaultGateway with tier "container", which applies the same policies as for the isolate.
 */
export class HarbourContainer extends DurableObject<Env> {
	/** The version the working copy is based on, as far as this object knows. Lost on eviction, which is safe. */
	#held: number | null = null;
	#queue: Promise<unknown> = Promise.resolve();

	#serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.#queue.then(work, work);
		this.#queue = next.catch(() => undefined);
		return next;
	}

	#container(): Container {
		const container = this.ctx.container;
		if (container === undefined) throw new Error("no container attached to this Durable Object");
		return container;
	}

	async exec(call: ContainerCall & { readonly request: ExecRequest }) {
		return this.#serial(async () => {
			const timings = await this.#claim(call);
			let at = performance.now();
			const step = (phase: string) => {
				const now = performance.now();
				timings[phase] = round(now - at);
				at = now;
			};
			const body = (await this.#withSync(call, "/exec", (sync) => ({
				sync,
				command: call.request.command,
				cwd: call.request.cwd,
				env: call.request.env,
				stdin: call.request.stdin,
				timeoutMs: call.request.timeoutMs,
			}))) as ContainerExecBody;
			step("container.request");
			return {
				exitCode: body.exitCode,
				stdout: body.stdout,
				stderr: body.stderr,
				timings: { ...timings, ...body.timings },
				container: { ...body.container, dirty: body.dirty },
			};
		});
	}

	/**
	 * Re-bases on the head and returns the container's uncommitted changes, for the sandbox to commit. `final` fences the
	 * lease first: `exec` on it is refused from here on, so no command can change the working copy after this snapshot
	 * (calls are serialised, so a command already accepted has finished and is in it).
	 */
	async pending(call: ContainerCall, options: { final?: boolean } = {}): Promise<ContainerPending> {
		return this.#serial(async () => {
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (options.final === true && owner?.leaseId === call.leaseId && owner.closing !== true) {
				await this.ctx.storage.put("owner", { ...owner, closing: true });
			}
			if (owner?.leaseId !== call.leaseId || !this.#container().running) {
				if (owner?.leaseId === call.leaseId) {
					// The container stopped while this lease held it: whatever it had not committed is gone.
					console.error(JSON.stringify({ message: "container gone; uncommitted changes lost", leaseId: call.leaseId }));
				}
				return { changes: [], stamp: 0 };
			}
			const body = (await this.#withSync(call, "/changes", (sync) => ({ sync }))) as {
				put: Put[];
				remove: string[];
				stamp: number;
			};
			return {
				changes: [
					...body.put.map(
						(file): ModedChange => ({ op: "put", path: file.path, content: fromBase64(file.content), mode: file.mode }),
					),
					...body.remove.map((path): ModedChange => ({ op: "delete", path })),
				],
				stamp: body.stamp,
			};
		});
	}

	/** The changes `pending` returned with `stamp` are committed as `version`; later changes stay pending. */
	async committed(args: { leaseId: string; version: number; stamp: number }): Promise<void> {
		return this.#serial(async () => {
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (owner?.leaseId !== args.leaseId || !this.#container().running) return;
			const response = await this.#post("/ack", { version: args.version, stamp: args.stamp });
			if (!response.ok) throw new Error(`container /ack failed: ${response.status}`);
			const { version } = (await response.json()) as { version: number | null };
			this.#held = version;
		});
	}

	/** The lease ended. The container keeps running (warm) for the next lease; a discarded lease's changes are dropped. */
	async ended(args: { leaseId: string; discard: boolean }): Promise<void> {
		return this.#serial(async () => {
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (owner?.leaseId !== args.leaseId) return;
			if (args.discard && this.#container().running) {
				await this.#post("/reset");
				this.#held = null;
			}
			await this.ctx.storage.put("owner", { ...owner, leaseId: "", closing: false });
		});
	}

	/**
	 * Stops the container now, as the cold-start harness needs. Refused while another session's lease holds it, so one
	 * session cannot throw away another's uncommitted work.
	 */
	async stop(args: { sessionId: string }): Promise<void> {
		return this.#serial(async () => {
			const owner = await this.ctx.storage.get<Owner>("owner");
			if (owner !== undefined && owner.leaseId !== "" && owner.sessionId !== args.sessionId) {
				throw new Error("this container is in use by another session");
			}
			this.#held = null;
			const container = this.ctx.container;
			if (container?.running) await container.destroy();
			await this.ctx.storage.delete("owner");
		});
	}

	// ---- internals ---------------------------------------------------------------------------------------------------

	/** Starts the container if needed and makes `call.leaseId` its owner. */
	async #claim(call: ContainerCall): Promise<Record<string, number>> {
		const owner = await this.ctx.storage.get<Owner>("owner");
		if (owner?.leaseId === call.leaseId && owner.closing === true) {
			throw new Error(`lease ${call.leaseId} is being released`);
		}
		const claim: Owner = { leaseId: call.leaseId, sessionId: call.sessionId, workspaceId: call.workspaceId };
		if (owner !== undefined && owner.leaseId !== "" && owner.leaseId !== call.leaseId && this.#container().running) {
			throw new Error("this container is in use by another lease");
		}
		if (this.#container().running && owner?.sessionId !== call.sessionId) {
			// Egress interception is bound to the session that started the container: another session gets a new one.
			await this.#container().destroy();
		}
		if (!this.#container().running) {
			this.#held = null;
			// Claimed before starting, so a call that interleaves with the start sees the right owner.
			await this.ctx.storage.put("owner", claim);
			return this.#start(call.sessionId);
		}
		if (owner === undefined || owner.workspaceId !== call.workspaceId) {
			// A warm container that last held another workspace starts from an empty working copy.
			await this.#post("/reset");
			this.#held = null;
		}
		await this.ctx.storage.put("owner", claim);
		return {};
	}

	async #start(sessionId: string): Promise<Record<string, number>> {
		const container = this.#container();
		const timings: Record<string, number> = {};
		let at = performance.now();
		const image = container.images.sandbox;
		if (image === undefined) throw new Error("image 'sandbox' missing from ctx.container.images");
		container.start({ image, instance: INSTANCE, enableInternet: false } as ContainerStartupOptions);
		this.ctx.waitUntil(
			container
				.monitor()
				.catch((error) => console.error(JSON.stringify({ message: "container exited", error: String(error) }))),
		);
		// Route all egress through the vault before the agent can make a request.
		const vault = this.ctx.exports.VaultGateway({ props: { sessionId, tier: "container" } });
		await container.interceptAllOutboundHttp(vault);
		await container.interceptOutboundHttps("*", vault);
		await container.setInactivityTimeout(INACTIVITY_MS);
		timings["container.start"] = round(performance.now() - at);
		at = performance.now();
		const port = container.getTcpPort(PORT);
		for (let attempt = 0; ; attempt += 1) {
			try {
				const response = await port.fetch("http://container/health");
				if (response.ok) break;
			} catch {
				// Not listening yet.
			}
			if (performance.now() - at > 60_000) throw new Error("container did not become ready within 60 s");
			await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 50 : 250));
		}
		timings["container.ready"] = round(performance.now() - at);
		return timings;
	}

	/** Posts to the agent with a sync from the held version to the head; resyncs once if the agent disagrees. */
	async #withSync(call: ContainerCall, path: string, body: (sync: Sync) => unknown): Promise<unknown> {
		const workspaces = new ObjectStoreWorkspaces({ store: r2Store(this.env.WORKSPACES) });
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const sync = await this.#sync(workspaces, call, this.#held, call.head);
			const response = await this.#post(path, body(sync));
			if (response.status === 409) {
				const { have } = (await response.json()) as { have: number | null };
				if (have === null) await this.#post("/reset");
				this.#held = have;
				continue;
			}
			if (!response.ok) throw new Error(`container ${path} failed: ${response.status} ${await response.text()}`);
			this.#held = call.head;
			return response.json();
		}
		throw new Error("container stayed out of sync after a full resync");
	}

	async #post(path: string, body?: unknown): Promise<Response> {
		return this.#container()
			.getTcpPort(PORT)
			.fetch(`http://container${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: body === undefined ? "{}" : JSON.stringify(body),
			});
	}

	async #sync(workspaces: ObjectStoreWorkspaces, call: ContainerCall, from: number | null, to: number): Promise<Sync> {
		if (from === to) return { from, to, put: [], remove: [] };
		const files = async (version: number) =>
			new Map(
				(await listAll(workspaces, call.ctx, call.workspaceId, { version }))
					.filter((entry) => entry.kind === "file")
					.map((entry) => [entry.path, entry]),
			);
		const target = await files(to);
		const source = from === null ? new Map<string, ModedFileEntry>() : await files(from);
		const changed = [...target.values()].filter((entry) => {
			const before = source.get(entry.path);
			return before === undefined || before.digest !== entry.digest || (before.mode ?? 0o644) !== (entry.mode ?? 0o644);
		});
		const remove = [...source.keys()].filter((path) => !target.has(path));
		const put: Put[] = [];
		// R2 reads in parallel batches: one at a time costs a round trip per file.
		for (let i = 0; i < changed.length; i += SYNC_CONCURRENCY) {
			const batch = changed.slice(i, i + SYNC_CONCURRENCY);
			const bodies = await Promise.all(
				batch.map((entry) => workspaces.readBlob(call.ctx, call.workspaceId, entry.digest ?? "")),
			);
			for (const [j, entry] of batch.entries()) {
				put.push({ path: entry.path, mode: entry.mode ?? 0o644, content: toBase64(bodies[j]!) });
			}
		}
		return { from, to, put, remove };
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function round(ms: number) {
	return Math.round(ms * 10) / 10;
}
