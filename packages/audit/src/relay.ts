/**
 * The relay: drains an `AuditOutbox` into the store on a timer, backing off while the store is down. A failed drain
 * leaves its batch queued and the next one sends it again; the store's idempotency keeps one row per event. On
 * Cloudflare, call `outbox.drain` from a Durable Object alarm or a cron trigger instead.
 */
import { type AuditOutbox, type AuditSink, type SystemContext, systemContext } from "@harbour/contracts";

export interface AuditRelayOptions {
	readonly outbox: AuditOutbox;
	readonly sink: AuditSink;
	/** How long to wait after a drain before the next. Default 1 second. */
	readonly intervalMs?: number;
	/** The longest wait after failures, which double the wait from `intervalMs`. Default 1 minute. */
	readonly maxBackoffMs?: number;
	/** Told of every failed drain. The relay keeps going. */
	readonly onError?: (error: unknown) => void;
	readonly context?: SystemContext;
}

export interface AuditRelay {
	/** Drains once now, outside the timer, and resolves how many events it sent. */
	drainNow(): Promise<number>;
	/** Stops the timer and waits for a drain in progress. */
	stop(): Promise<void>;
}

/** Starts draining `outbox` into `sink` at once, then every `intervalMs`. */
export function startAuditRelay(options: AuditRelayOptions): AuditRelay {
	const intervalMs = options.intervalMs ?? 1_000;
	const maxBackoffMs = options.maxBackoffMs ?? 60_000;
	const ctx = options.context ?? systemContext("audit.relay");
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<unknown> = Promise.resolve();
	let waitMs = intervalMs;

	const drain = () => options.outbox.drain(ctx, options.sink);

	function tick(): void {
		timer = undefined;
		const run = drain().then(
			() => {
				waitMs = intervalMs;
			},
			(error: unknown) => {
				waitMs = Math.min(waitMs * 2, maxBackoffMs);
				options.onError?.(error);
			},
		);
		running = run;
		void run.then(() => {
			if (!stopped) timer = setTimeout(tick, waitMs);
		});
	}

	tick();
	return {
		drainNow: drain,
		async stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			await running;
		},
	};
}
