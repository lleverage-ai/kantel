/**
 * A container backend for tests, ported from the Cloudflare spike's simulator (spikes/cloudflare/test/backends.ts).
 *
 * It keeps a per-lease working copy as an overlay over the head, as a real container agent does, and runs commands in
 * the isolate's shell with a `git --version` stand-in. It exercises the tiered sandboxes' commit-on-release, re-base
 * and discard logic; a real container is exercised by its own target's tests.
 */
import type { SandboxLease } from "@kantel/contracts";
import { BlobCache, createWorkspacePort, type Overlay, runShell } from "@kantel/sandbox/isolate";
import type { BackendExec, BackendOutput, ContainerBackend, PendingChanges } from "@kantel/sandbox/tiered";
import type { ModedChange, StoredWorkspaces } from "@kantel/workspace/stored";
import { defineCommand } from "just-bash/browser";

const git = defineCommand("git", async (args) =>
	args[0] === "--version"
		? { stdout: "git version 2.47.0 (container simulator)\n", stderr: "", exitCode: 0 }
		: { stdout: "", stderr: "git: only --version in the simulator\n", exitCode: 1 },
);

type OverlayEntry = { content: Uint8Array; mode: number } | null;

export class SimulatedContainer implements ContainerBackend {
	readonly #overlays = new Map<string, Map<string, OverlayEntry>>();
	/** Per lease, the exec that last changed each overlay path, as the agent stamps its dirty paths. */
	readonly #stamps = new Map<string, Map<string, number>>();
	/** Leases whose release has taken its final snapshot, or that ended, as a container host fences them. */
	readonly #fenced = new Set<string>();
	#stamp = 0;
	readonly #cache = new BlobCache();
	readonly #workspaces: StoredWorkspaces;
	/** Every `ended` call, in order, for tests. */
	readonly endedCalls: { readonly leaseId: string; readonly discard: boolean }[] = [];

	constructor(workspaces: StoredWorkspaces) {
		this.#workspaces = workspaces;
	}

	async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
		if (this.#fenced.has(lease.id)) throw new Error(`lease ${lease.id} is being released or has ended`);
		const overlay = this.#overlay(lease);
		const port = createWorkspacePort(this.#workspaces, ctx, lease.workspaceId, record.head);
		const outcome = await runShell(
			port,
			{ ...request, baseVersion: record.head, mounts: record.mounts },
			{ cache: this.#cache, overlay, commands: [git] },
		);
		const next = toOverlay(outcome.changes);
		const stamps = this.#stamps.get(lease.id) ?? new Map<string, number>();
		this.#stamp += 1;
		for (const [path, entry] of next) if (!sameEntry(overlay.get(path), entry)) stamps.set(path, this.#stamp);
		for (const path of overlay.keys()) if (!next.has(path)) stamps.delete(path);
		this.#overlays.set(lease.id, next);
		this.#stamps.set(lease.id, stamps);
		const { changes: _kept, ...output } = outcome;
		return output;
	}

	async pending(
		{ lease }: Omit<BackendExec, "request">,
		options: { readonly final?: boolean } = {},
	): Promise<PendingChanges> {
		if (options.final === true) this.#fenced.add(lease.id);
		return { changes: fromOverlay(this.#overlay(lease)), stamp: this.#stamp };
	}

	async committed(lease: SandboxLease, _version: number, stamp: number): Promise<void> {
		const overlay = new Map(this.#overlays.get(lease.id) ?? []);
		const stamps = this.#stamps.get(lease.id) ?? new Map<string, number>();
		for (const [path, at] of [...stamps]) {
			if (at > stamp) continue;
			overlay.delete(path);
			stamps.delete(path);
		}
		this.#overlays.set(lease.id, overlay);
	}

	async ended(lease: SandboxLease, options: { readonly discard: boolean }): Promise<void> {
		this.endedCalls.push({ leaseId: lease.id, discard: options.discard });
		this.#overlays.delete(lease.id);
		this.#stamps.delete(lease.id);
		this.#fenced.add(lease.id);
	}

	/** The paths the lease's working copy holds uncommitted, for tests. */
	pendingPaths(leaseId: string): string[] {
		return [...(this.#overlays.get(leaseId)?.keys() ?? [])].sort();
	}

	#overlay(lease: SandboxLease): Overlay {
		return this.#overlays.get(lease.id) ?? new Map();
	}
}

function sameEntry(left: OverlayEntry | undefined, right: OverlayEntry): boolean {
	if (left === undefined) return false;
	if (left === null || right === null) return left === right;
	return left.mode === right.mode && Buffer.from(left.content).equals(Buffer.from(right.content));
}

function toOverlay(changes: readonly ModedChange[]): Map<string, OverlayEntry> {
	const overlay = new Map<string, OverlayEntry>();
	for (const change of changes) {
		if (change.op === "delete") overlay.set(change.path, null);
		else overlay.set(change.path, { content: change.content as Uint8Array, mode: change.mode ?? 0o644 });
	}
	return overlay;
}

function fromOverlay(overlay: Overlay): ModedChange[] {
	return [...overlay].map(
		([path, entry]): ModedChange =>
			entry === null ? { op: "delete", path } : { op: "put", path, content: entry.content, mode: entry.mode },
	);
}
