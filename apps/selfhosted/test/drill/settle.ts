// When has a gateway recovered from an outage? postgres.ts's outage drill asks this every 250 ms while its writers run,
// so the tracker keeps a few numbers per gateway as writes start and finish, rather than scanning the write history.

/** A gateway's writes, as the tracker sees them. */
interface Gateway {
	/** When the last failed write finished. */
	lastFailure: number;
	/** When the last successful write started and finished. */
	lastSuccess?: { readonly at: number; readonly end: number };
	/** When each write in flight started, by writer. */
	readonly inFlight: Map<number, number>;
}

export class Settle {
	readonly #gateways: Gateway[];

	/**
	 * @param gateways how many gateways the writers write through
	 * @param from when the outage began: failures before it don't count
	 * @param settleMs how long every gateway must write with no failure, and no write stuck, to have recovered
	 */
	constructor(
		gateways: number,
		from: number,
		readonly settleMs: number,
	) {
		this.#gateways = Array.from({ length: gateways }, () => ({ lastFailure: from, inFlight: new Map() }));
	}

	/** The outage began at `from`: writes before it don't count towards recovery. */
	outageFrom(from: number) {
		for (const gateway of this.#gateways) gateway.lastFailure = Math.max(gateway.lastFailure, from);
	}

	started(gateway: number, writer: number, at: number) {
		this.#gateways[gateway]?.inFlight.set(writer, at);
	}

	finished(gateway: number, writer: number, at: number, end: number, ok: boolean) {
		const state = this.#gateways[gateway];
		if (state === undefined) return;
		state.inFlight.delete(writer);
		if (!ok) state.lastFailure = Math.max(state.lastFailure, end);
		else if (state.lastSuccess === undefined || end >= state.lastSuccess.end) state.lastSuccess = { at, end };
	}

	/** When gateway `n`'s last failure finished (the outage's start, if none failed). */
	lastFailure(n: number): number | undefined {
		return this.#gateways[n]?.lastFailure;
	}

	/**
	 * Gateway `n` has recovered at `now` when, for the whole settle window before `now`, no write through it failed and
	 * none has been stuck, and a write begun after its last failure succeeded within the last second (or window, if
	 * shorter): it is writing again now, not merely quiet.
	 */
	recovered(n: number, now: number): boolean {
		const state = this.#gateways[n];
		if (state === undefined) return false;
		const windowStart = now - this.settleMs;
		if (state.lastFailure > windowStart) return false;
		for (const at of state.inFlight.values()) if (at < windowStart) return false;
		const success = state.lastSuccess;
		return (
			success !== undefined && success.at > state.lastFailure && success.end >= now - Math.min(1_000, this.settleMs)
		);
	}

	/** Every gateway has recovered at `now`. */
	all(now: number): boolean {
		return this.#gateways.every((_, n) => this.recovered(n, now));
	}
}
