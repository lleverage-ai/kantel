// Sandboxes' live changes between gateway replicas over one database (`LiveRelay`, @kantel/compute's live.ts), on
// Postgres's LISTEN/NOTIFY: a change one replica makes is NOTIFY'd on the schema's channel, and every other replica,
// LISTENing on a connection of its own, hands it to the consoles watching it. Nothing new to run or open: the database
// the replicas share carries it. A change that came from this replica is left alone when it comes back (it was handed
// over here already). The listening connection is opened again after a drop, and the consoles are then told to read
// again, as NOTIFY keeps nothing for a listener that wasn't there.
import { createHash, randomUUID } from "node:crypto";
import type { LiveRelay, SandboxChange } from "@kantel/compute";
import type pg from "pg";

/** The pauses before each reconnection of the listener while it keeps failing; the last repeats. */
const RETRY_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** The channel for a schema: a database may hold several deployments, one schema each, and each hears only its own. */
export function liveChannel(schema: string): string {
	return `kantel_live_${createHash("sha256").update(schema).digest("hex").slice(0, 16)}`;
}

interface Notice {
	readonly origin: string;
	readonly change: SandboxChange;
}

/** A notice another replica sent, or undefined for anything else. */
export function noticeOf(payload: string | undefined): Notice | undefined {
	if (payload === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const notice = value as { origin?: unknown; change?: Partial<Record<keyof SandboxChange, unknown>> };
	const change = notice.change;
	if (typeof notice.origin !== "string" || typeof change !== "object" || change === null) return undefined;
	if (typeof change.sandboxId !== "string" || typeof change.accountId !== "string") return undefined;
	if (typeof change.state !== "string" || typeof change.at !== "number") return undefined;
	if (change.previousState !== undefined && typeof change.previousState !== "string") return undefined;
	return {
		origin: notice.origin,
		change: {
			sandboxId: change.sandboxId,
			accountId: change.accountId,
			state: change.state as SandboxChange["state"],
			...(change.previousState === undefined ? {} : { previousState: change.previousState as SandboxChange["state"] }),
			at: change.at,
		},
	};
}

export interface PostgresLiveRelayOptions {
	readonly schema: string;
	/** Sends one statement on the pool the gateway already has. */
	readonly query: (text: string, values: readonly unknown[]) => Promise<unknown>;
	/** A new connection of its own, for LISTEN (a pooled one would be handed to others). */
	readonly connect: () => pg.Client;
	readonly log: (message: string) => void;
	readonly retryMs?: readonly number[];
}

export function postgresLiveRelay(options: PostgresLiveRelayOptions): LiveRelay {
	const channel = liveChannel(options.schema);
	const origin = randomUUID();
	const retry = options.retryMs ?? RETRY_MS;
	let client: pg.Client | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let failures = 0;
	return {
		send(change) {
			if (stopped) return;
			const payload = JSON.stringify({ origin, change } satisfies Notice);
			void options
				.query("SELECT pg_notify($1, $2)", [channel, payload])
				.catch((error: unknown) => options.log(`[gateway] live: NOTIFY failed: ${(error as Error).message}`));
		},
		start(receive, resync) {
			let listened = false;
			const listen = async () => {
				if (stopped) return;
				const own = options.connect();
				client = own;
				let dropped = false;
				const drop = (why: string) => {
					if (dropped) return;
					dropped = true;
					if (client === own) client = undefined;
					void own.end().catch(() => undefined);
					if (stopped) return;
					const wait = retry[Math.min(failures, retry.length - 1)] ?? 1_000;
					failures += 1;
					options.log(`[gateway] live: the listening connection ${why}; again in ${wait} ms`);
					timer = setTimeout(() => {
						timer = undefined;
						void listen();
					}, wait);
					timer.unref?.();
				};
				own.on("error", (error) => drop(`failed (${error.message})`));
				own.on("end", () => drop("closed"));
				own.on("notification", (message) => {
					if (message.channel !== channel) return;
					const notice = noticeOf(message.payload);
					if (notice === undefined || notice.origin === origin) return;
					receive(notice.change);
				});
				try {
					await own.connect();
					await own.query(`LISTEN ${channel}`);
				} catch (error) {
					drop(`didn't open (${(error as Error).message})`);
					return;
				}
				if (stopped) {
					void own.end().catch(() => undefined);
					return;
				}
				failures = 0;
				// What came while nobody was listening is lost: the watchers read again.
				if (listened) resync();
				listened = true;
			};
			void listen();
		},
		async stop() {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			const own = client;
			client = undefined;
			await own?.end().catch(() => undefined);
		},
	};
}
