// The isolate host's pool of pre-loaded isolates (loader.ts), kept free of
// workerd APIs so it can be tested on its own (test/pool.test.ts, `bun test`).
//
// A slot is loaded with no workspace and no session; handing it out writes
// slot → session once. A slot is never handed out twice: when its session goes
// idle the mapping is dropped, and the isolate's egress is refused from then on.

export const DEFAULT_POOL_SIZE = 4;
export const MAX_POOL_SIZE = 64;

/** ISOLATE_POOL_SIZE: unset or empty is the default; anything but an integer from 0 to 64 turns the pool off. */
export function parsePoolSize(raw: string | undefined): { size: number; invalid: boolean } {
	const value = raw?.trim();
	if (value === undefined || value === "") return { size: DEFAULT_POOL_SIZE, invalid: false };
	if (/^\d+$/.test(value) && Number(value) <= MAX_POOL_SIZE) return { size: Number(value), invalid: false };
	return { size: 0, invalid: true };
}

export interface Assignment {
	readonly slot: string;
	lastUsed: number;
	inFlight: number;
}

export interface PoolOptions {
	/** A session idle this long gives up its slot; its next call gets a fresh isolate. */
	readonly sessionIdleMs: number;
	/** A refill loads only once no call has been in flight for this long. */
	readonly quietMs: number;
	/** A refill that finds no quiet spell for this long stops; the next hand-out or health check starts another. */
	readonly refillPatienceMs: number;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<unknown>;
	readonly onRefillError?: (error: unknown) => void;
}

export class Pool {
	/** Loaded, not yet handed out. */
	readonly #idle: string[] = [];
	readonly #owners = new Map<string, string>();
	readonly #sessions = new Map<string, Assignment>();
	#next = 0;
	#refilling: Promise<void> | undefined;
	/** Calls in flight, and when the last one started or ended. */
	#active = 0;
	#lastActive = Number.NEGATIVE_INFINITY;
	readonly #options: PoolOptions;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<unknown>;

	constructor(options: PoolOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** The session a slot was handed to, unless that session has since gone idle and given it up. */
	owner(slot: string): string | undefined {
		const sessionId = this.#owners.get(slot);
		if (sessionId === undefined) return undefined;
		const assignment = this.#sessions.get(sessionId);
		if (assignment === undefined || assignment.slot !== slot || this.#expired(assignment, this.#now())) {
			this.#drop(sessionId, slot);
			return undefined;
		}
		return sessionId;
	}

	/** A call starts. */
	begin(): void {
		this.#active += 1;
		this.#lastActive = this.#now();
	}

	/** A call ends. */
	end(): void {
		this.#active -= 1;
		this.#lastActive = this.#now();
	}

	/** The session's slot, handing out a pre-loaded one (or a fresh one when none is ready) on its first call. */
	assign(sessionId: string): { assignment: Assignment; hit: boolean | undefined } {
		const now = this.#now();
		this.expire();
		const existing = this.#sessions.get(sessionId);
		if (existing) return { assignment: existing, hit: undefined };
		const ready = this.#idle.shift();
		const slot = ready ?? this.#newSlot();
		const assignment: Assignment = { slot, lastUsed: now, inFlight: 0 };
		this.#owners.set(slot, sessionId);
		this.#sessions.set(sessionId, assignment);
		return { assignment, hit: ready !== undefined };
	}

	/** Top the pool up to `size`, one load at a time, each in a quiet spell. */
	refill(load: (slot: string) => Promise<unknown>, size: number): Promise<void> {
		this.#refilling ??= (async () => {
			// After a turn, so `#refilling` is set before the `finally` below clears it.
			await undefined;
			const giveUp = this.#now() + this.#options.refillPatienceMs;
			try {
				while (this.#idle.length < size) {
					if (!(await this.#quiet(giveUp))) return;
					const slot = this.#newSlot();
					await load(slot);
					this.#idle.push(slot);
				}
			} catch (error) {
				this.#options.onRefillError?.(error);
			} finally {
				this.#refilling = undefined;
			}
		})();
		return this.#refilling;
	}

	/** Drops every idle session's slot. */
	expire(): void {
		const now = this.#now();
		for (const [sessionId, assignment] of this.#sessions) {
			if (this.#expired(assignment, now)) this.#drop(sessionId, assignment.slot);
		}
	}

	stats() {
		this.expire();
		return { idle: this.#idle.length, sessions: this.#sessions.size };
	}

	#expired(assignment: Assignment, now: number): boolean {
		return assignment.inFlight === 0 && now - assignment.lastUsed >= this.#options.sessionIdleMs;
	}

	#drop(sessionId: string, slot: string): void {
		if (this.#sessions.get(sessionId)?.slot === slot) this.#sessions.delete(sessionId);
		this.#owners.delete(slot);
	}

	/** Until nothing has been in flight for quietMs; false once `giveUp` passes first. */
	async #quiet(giveUp: number): Promise<boolean> {
		for (;;) {
			const now = this.#now();
			if (this.#active === 0 && now - this.#lastActive >= this.#options.quietMs) return true;
			if (now >= giveUp) return false;
			await this.#sleep(this.#options.quietMs);
		}
	}

	#newSlot(): string {
		// Never reused, and apart from the `session:` IDs of the unpooled path.
		return `pool:${this.#next++}`;
	}
}
