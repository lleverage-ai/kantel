/**
 * Tier backends for running the sandbox conformance suite in Node.
 *
 * - The isolate backend is the real isolate shell (src/isolate/shell.ts, the code the Dynamic Worker runs) called in
 *   process instead of over the Worker Loader.
 * - The container backend is a simulator: it keeps a per-lease working copy as an overlay over the head, as the
 *   container agent does, and runs commands in the same shell with a `git --version` stand-in. It exercises the
 *   sandbox's commit-on-release, re-base and discard logic; the real container (container/server.ts) is exercised by
 *   the deployed scenario, not here.
 */
import type { SandboxLease } from "@harbour/contracts";
import { defineCommand } from "just-bash/browser";
import { BlobCache, type Overlay, runShell } from "../src/isolate/shell.ts";
import { workspacePort } from "../src/port.ts";
import type { BackendExec, BackendOutput, ContainerBackend, IsolateBackend, PendingChanges } from "../src/sandbox.ts";
import type { ModedChange, ObjectStoreWorkspaces } from "../src/workspace.ts";

export function inProcessIsolate(workspaces: ObjectStoreWorkspaces): IsolateBackend {
	const cache = new BlobCache();
	return {
		async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
			const port = workspacePort(workspaces, ctx, lease.workspaceId);
			return runShell(port, { ...request, baseVersion: record.head, mounts: record.mounts }, { cache });
		},
	};
}

const git = defineCommand("git", async (args) =>
	args[0] === "--version"
		? { stdout: "git version 2.47.0 (container simulator)\n", stderr: "", exitCode: 0 }
		: { stdout: "", stderr: "git: only --version in the simulator\n", exitCode: 1 },
);

export class SimulatedContainer implements ContainerBackend {
	readonly #overlays = new Map<string, Map<string, { content: Uint8Array; mode: number } | null>>();
	/** Per lease, the exec that last changed each overlay path, as the agent stamps its dirty paths. */
	readonly #stamps = new Map<string, Map<string, number>>();
	/** Leases whose release has taken its final snapshot, as the container DO fences them. */
	readonly #closing = new Set<string>();
	#stamp = 0;
	readonly #cache = new BlobCache();

	constructor(private readonly workspaces: ObjectStoreWorkspaces) {}

	async exec({ ctx, lease, record, request }: BackendExec): Promise<BackendOutput> {
		if (this.#closing.has(lease.id)) throw new Error(`lease ${lease.id} is being released`);
		const overlay = this.#overlay(lease);
		const port = workspacePort(this.workspaces, ctx, lease.workspaceId);
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
		if (options.final === true) this.#closing.add(lease.id);
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

	async ended(lease: SandboxLease): Promise<void> {
		this.#overlays.delete(lease.id);
		this.#stamps.delete(lease.id);
		this.#closing.delete(lease.id);
	}

	#overlay(lease: SandboxLease): Overlay {
		return this.#overlays.get(lease.id) ?? new Map();
	}
}

function sameEntry(
	left: { content: Uint8Array; mode: number } | null | undefined,
	right: { content: Uint8Array; mode: number } | null,
): boolean {
	if (left === undefined) return false;
	if (left === null || right === null) return left === right;
	return left.mode === right.mode && Buffer.from(left.content).equals(Buffer.from(right.content));
}

function toOverlay(changes: readonly ModedChange[]) {
	const overlay = new Map<string, { content: Uint8Array; mode: number } | null>();
	for (const change of changes) {
		if (change.op === "delete") overlay.set(change.path, null);
		else overlay.set(change.path, { content: change.content as Uint8Array, mode: change.mode ?? 0o644 });
	}
	return overlay;
}

function fromOverlay(overlay: Overlay): ModedChange[] {
	return [...overlay].map(([path, entry]) =>
		entry === null ? { op: "delete", path } : { op: "put", path, content: entry.content, mode: entry.mode },
	);
}
