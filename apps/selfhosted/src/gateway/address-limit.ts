// A per-client-address request limit for the sign-in routes. The identity lane limits codes per email (5 an hour);
// that does not stop one client trying many emails, so its CONTRACT.md asks the deployment to limit `/auth/otp/*` per
// client address at the edge as well. In compose the gateway is the edge.
//
// Fixed windows, in memory: one gateway process is the deployment here. Behind a reverse proxy every client shares the
// proxy's address, so a deployment there limits at the proxy instead and raises this one.

export interface AddressLimitOptions {
	/** Requests one address may make in a window. */
	readonly requests: number;
	readonly windowMilliseconds: number;
	readonly now?: () => number;
	/** Addresses tracked at once; the oldest windows are dropped past it, so a flood of addresses cannot grow memory. */
	readonly maxAddresses?: number;
}

export interface AddressLimit {
	/** Counts a request from `address`: undefined when it may go ahead, or the seconds until it may. */
	take(address: string): number | undefined;
}

export function createAddressLimit(options: AddressLimitOptions): AddressLimit {
	const { requests, windowMilliseconds } = options;
	if (!(Number.isInteger(requests) && requests > 0))
		throw new Error("the sign-in limit needs a positive request count");
	if (!(Number.isFinite(windowMilliseconds) && windowMilliseconds > 0)) {
		throw new Error("the sign-in limit needs a positive window");
	}
	const now = options.now ?? Date.now;
	const maxAddresses = options.maxAddresses ?? 10_000;
	// Insertion order is window-start order: a window is deleted and re-added when it starts again.
	const windows = new Map<string, { start: number; count: number }>();
	return {
		take(address) {
			const at = now();
			let window = windows.get(address);
			if (window === undefined || at - window.start >= windowMilliseconds) {
				windows.delete(address);
				window = { start: at, count: 0 };
				windows.set(address, window);
				for (const [oldest, entry] of windows) {
					if (windows.size <= maxAddresses && at - entry.start < windowMilliseconds) break;
					windows.delete(oldest);
				}
			}
			if (window.count >= requests) return Math.max(1, Math.ceil((window.start + windowMilliseconds - at) / 1000));
			window.count += 1;
			return undefined;
		},
	};
}
