/**
 * The runtime-owned TTL sweeper: a timer loop that calls `Sandboxes.sweep` so a lease past its TTL ends even when
 * nobody asks, plus `usageReport`, which turns `Sandboxes.usage` into the held/bound ratio per tier.
 *
 * Portable: it uses only `setTimeout`/`clearTimeout`, so it runs in Node, Bun and a Worker (where a Durable Object
 * alarm would normally call `sweep` instead).
 */
import {
	type Sandboxes,
	type SandboxLease,
	type SandboxTier,
	type SandboxUsage,
	type SystemContext,
	systemContext,
} from "@harbour/contracts";

const DEFAULT_INTERVAL_MS = 5_000;

export interface LeaseSweeperOptions {
	readonly sandboxes: Pick<Sandboxes, "sweep">;
	/** Milliseconds between the end of one sweep and the start of the next (default 5 000). */
	readonly intervalMs?: number;
	/** The worker context `sweep` is called with; a `system` actor, `sandbox.sweeper` by default. */
	readonly ctx?: SystemContext;
	/** Called after a timed sweep that ended at least one lease. */
	readonly onSwept?: (leases: readonly SandboxLease[]) => void;
	/** Called when a timed sweep fails; the loop carries on. Logs to the console when absent. */
	readonly onError?: (error: unknown) => void;
}

export interface LeaseSweeper {
	/** Sweeps now, after any sweep in flight, and returns what it ended. Rejects when the sweep fails. */
	sweepNow(): Promise<readonly SandboxLease[]>;
	/** Stops the loop and waits for a sweep in flight. Idempotent. */
	stop(): Promise<void>;
}

/**
 * Starts sweeping every `intervalMs`. Sweeps never overlap: the next one is scheduled when the last one finishes, and
 * `sweepNow` queues behind one in flight. The timer is unref'd where the host supports it, so it never keeps a
 * process alive on its own.
 */
export function startLeaseSweeper(options: LeaseSweeperOptions): LeaseSweeper {
	const { sandboxes } = options;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("intervalMs must be a positive number");
	const ctx = options.ctx ?? systemContext("sandbox.sweeper");
	const onError =
		options.onError ??
		((error: unknown) => {
			console.error("harbour: the sandbox lease sweep failed", error);
		});
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The tail of the sweeps queued so far; never rejects. */
	let chain: Promise<unknown> = Promise.resolve();

	function sweep(): Promise<readonly SandboxLease[]> {
		const next = chain.then(() => sandboxes.sweep(ctx));
		chain = next.catch(() => undefined);
		return next;
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(tick, intervalMs);
		const handle = timer as unknown as { unref?: () => void };
		if (typeof handle === "object" && handle !== null && typeof handle.unref === "function") handle.unref();
	}

	async function tick(): Promise<void> {
		timer = undefined;
		if (stopped) return;
		try {
			const swept = await sweep();
			if (swept.length > 0) options.onSwept?.(swept);
		} catch (error) {
			try {
				onError(error);
			} catch {
				// A failing reporter must not stop the loop.
			}
		} finally {
			schedule();
		}
	}

	schedule();
	return {
		sweepNow: () => sweep(),
		async stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			await chain;
		},
	};
}

/** One tier's line in a usage report. */
export interface TierUsageReport {
	readonly tier: SandboxTier;
	readonly leases: number;
	readonly heldMs: number;
	readonly busyMs: number;
	/** `busyMs / heldMs`: how much of the held time the tier was running commands; 0 when nothing was held. */
	readonly boundRatio: number;
}

/** Per-tier held and busy time with the bound ratio, in the order `usage` gave them. */
export function usageReport(usage: readonly SandboxUsage[]): TierUsageReport[] {
	return usage.map(({ tier, leases, heldMs, busyMs }) => ({
		tier,
		leases,
		heldMs,
		busyMs,
		boundRatio: heldMs > 0 ? busyMs / heldMs : 0,
	}));
}
