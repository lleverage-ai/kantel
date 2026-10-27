import { useRef, useSyncExternalStore } from "react";

// One shared clock for every relative time and countdown on the page. A session list with 200 rows showing "5m"
// would otherwise run 200 intervals; here there is one interval per period, and it stops when nothing listens.
// Components subscribe only while they need the time to move (a countdown that is running, a "now" that will age).

type Ticker = { now: number; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | undefined };

const tickers = new Map<number, Ticker>();

function tickerFor(period: number): Ticker {
	let ticker = tickers.get(period);
	if (ticker === undefined) {
		ticker = { now: Date.now(), listeners: new Set(), timer: undefined };
		tickers.set(period, ticker);
	}
	return ticker;
}

function subscribe(period: number, listener: () => void): () => void {
	const ticker = tickerFor(period);
	ticker.listeners.add(listener);
	if (ticker.timer === undefined) {
		ticker.now = Date.now();
		ticker.timer = setInterval(() => {
			ticker.now = Date.now();
			for (const notify of ticker.listeners) notify();
		}, period);
	}
	return () => {
		ticker.listeners.delete(listener);
		if (ticker.listeners.size === 0 && ticker.timer !== undefined) {
			clearInterval(ticker.timer);
			ticker.timer = undefined;
		}
	};
}

const frozen = () => () => {};
const subscribers = new Map<number, (listener: () => void) => () => void>();

// One subscribe function per period, so React keeps the subscription across renders.
function subscriberFor(period: number): (listener: () => void) => () => void {
	let subscriber = subscribers.get(period);
	if (subscriber === undefined) {
		subscriber = (listener) => subscribe(period, listener);
		subscribers.set(period, subscriber);
	}
	return subscriber;
}

/**
 * The current time, re-rendering every `period` ms while `live` is true. When not live it keeps the last time it
 * saw (or the time of its first render) and costs nothing.
 */
export function useNow(period = 1000, live = true): number {
	const last = useRef<number | undefined>(undefined);
	if (last.current === undefined) last.current = Date.now();
	const seen = last.current;
	const read = live ? () => tickerFor(period).now : () => seen;
	const now = useSyncExternalStore(live ? subscriberFor(period) : frozen, read, read);
	last.current = now;
	return now;
}

/** Listeners on each period, for tests and the design loop's measurements. */
export function clockListenerCounts(): Record<number, number> {
	return Object.fromEntries([...tickers].map(([period, ticker]) => [period, ticker.listeners.size]));
}
