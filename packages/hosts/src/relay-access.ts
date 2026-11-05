/**
 * Access a gateway relays after the call that granted it: tunnels (desktop VNC, CDP, SSH) and exposed ports' requests
 * and WebSockets. Each was given to someone (a key, or a person and their sign-in: the grantee), and lasts only while
 * they still may open the sandbox's access, as the compute API decides (`stillAllowed`).
 *
 * A new tunnel or port request asks first. A session already open (a WebSocket, an SSH connection) is held here and
 * asked about again every `intervalMs` (default 2 s): once its grantee's key is revoked, they sign out, they leave the
 * account or lose sight of the sandbox, it is closed. The answer is the compute API's records, which every gateway
 * replica shares, so access revoked on one replica ends on all of them within one interval.
 */

/** The close code for a session whose grantee lost access, as for a ticket that isn't valid. */
export const RELAY_CLOSE_REVOKED = 4003;
export const RELAY_REVOKED_REASON = "Access to this sandbox was revoked";

export interface RelayAccessOptions {
	/** Whether `grantee` may still open `sandboxId`'s access (`ComputeService.stillAllowed`). */
	stillAllowed(grantee: string | undefined, sandboxId: string): Promise<boolean>;
	/** How long an answer is reused for new requests; default 1 s. */
	readonly cacheMs?: number;
	readonly intervalMs?: number;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

/** A session held open: `end` closes it. */
export interface RelaySession {
	readonly sandboxId: string;
	readonly grantee?: string;
	/** What it is, for the log: `desktop`, `ssh`, `cdp`, `port 3000`. */
	readonly kind: string;
	end(reason: string): void;
}

export interface RelayAccess {
	/** Whether a new request or session may go ahead; reuses an answer up to `cacheMs` old. */
	allowed(grantee: string | undefined, sandboxId: string): Promise<boolean>;
	/** Holds a session open until the returned function is called (when it closes). */
	track(session: RelaySession): () => void;
	/** Asks about every held session now, and ends those whose grantee lost access. */
	check(): Promise<void>;
	/** The sessions held now. */
	readonly size: number;
	start(): void;
	stop(): void;
}

export function createRelayAccess(options: RelayAccessOptions): RelayAccess {
	const cacheMs = options.cacheMs ?? 1000;
	const intervalMs = options.intervalMs ?? 2000;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((message: string) => console.error(message));
	const sessions = new Set<RelaySession>();
	const answers = new Map<string, { at: number; allowed: boolean }>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let checking: Promise<void> | undefined;

	const keyOf = (grantee: string | undefined, sandboxId: string) => `${sandboxId}\n${grantee ?? ""}`;

	async function ask(grantee: string | undefined, sandboxId: string): Promise<boolean> {
		let allowed: boolean;
		try {
			allowed = await options.stillAllowed(grantee, sandboxId);
		} catch (error) {
			// Refuse rather than let access outlive a revocation the gateway couldn't check.
			log(`[relay] could not check access to ${sandboxId}: ${error instanceof Error ? error.message : String(error)}`);
			allowed = false;
		}
		answers.set(keyOf(grantee, sandboxId), { at: now(), allowed });
		return allowed;
	}

	async function sweep(): Promise<void> {
		const groups = new Map<string, RelaySession[]>();
		for (const session of sessions) {
			const key = keyOf(session.grantee, session.sandboxId);
			const group = groups.get(key);
			if (group === undefined) groups.set(key, [session]);
			else group.push(session);
		}
		await Promise.all(
			[...groups.values()].map(async (group) => {
				const [first] = group;
				if (first === undefined) return;
				if (await ask(first.grantee, first.sandboxId)) return;
				for (const session of group) {
					if (!sessions.delete(session)) continue;
					log(`[relay] ended a ${session.kind} session on ${session.sandboxId}: its grantee lost access`);
					try {
						session.end(RELAY_REVOKED_REASON);
					} catch {
						// Already closing.
					}
				}
			}),
		);
		for (const [key, answer] of answers) if (now() - answer.at > cacheMs * 10) answers.delete(key);
	}

	return {
		async allowed(grantee, sandboxId) {
			const cached = answers.get(keyOf(grantee, sandboxId));
			if (cached !== undefined && now() - cached.at < cacheMs) return cached.allowed;
			return ask(grantee, sandboxId);
		},
		track(session) {
			sessions.add(session);
			return () => {
				sessions.delete(session);
			};
		},
		check() {
			checking ??= sweep().finally(() => {
				checking = undefined;
			});
			return checking;
		},
		get size() {
			return sessions.size;
		},
		start() {
			if (timer !== undefined) return;
			timer = setInterval(() => void this.check(), intervalMs);
			(timer as { unref?: () => void }).unref?.();
		},
		stop() {
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		},
	};
}
