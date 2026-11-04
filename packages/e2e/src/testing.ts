/**
 * For tests: a relay between two `ByteChannel`s that keeps every byte it carries, as a gateway would see them, and can
 * cut chunks up or join them as a real relay may. Not for production use.
 */
import { concat } from "./bytes.ts";
import type { ByteChannel } from "./session.ts";

export interface RecordingRelay {
	/** The device's end. */
	readonly device: ByteChannel;
	/** The host's end. */
	readonly host: ByteChannel;
	/** Everything that passed, each way. */
	seen(): { readonly toHost: Uint8Array; readonly toDevice: Uint8Array };
	/** Replaces what the relay forwards to the host from now on (a tampering relay). */
	tamper(change: (bytes: Uint8Array, direction: "toHost" | "toDevice") => Uint8Array | undefined): void;
	close(): void;
}

interface End {
	listener: ((bytes: Uint8Array) => void) | undefined;
	queue: Uint8Array[];
	closeListeners: ((reason: string) => void)[];
}

export function recordingRelay(options: { readonly chunk?: number } = {}): RecordingRelay {
	const ends: { device: End; host: End } = {
		device: { listener: undefined, queue: [], closeListeners: [] },
		host: { listener: undefined, queue: [], closeListeners: [] },
	};
	const seen = { toHost: [] as Uint8Array[], toDevice: [] as Uint8Array[] };
	let closed = false;
	let change: ((bytes: Uint8Array, direction: "toHost" | "toDevice") => Uint8Array | undefined) | undefined;

	const deliver = (to: End, bytes: Uint8Array) => {
		// Asynchronously, as a socket would, and in order.
		queueMicrotask(() => {
			if (closed) return;
			if (to.listener === undefined) to.queue.push(bytes);
			else to.listener(bytes);
		});
	};
	const forward = (direction: "toHost" | "toDevice", bytes: Uint8Array) => {
		if (closed) return;
		const changed = change === undefined ? bytes : change(bytes, direction);
		if (changed === undefined) return;
		seen[direction].push(changed.slice());
		const to = direction === "toHost" ? ends.host : ends.device;
		const size = options.chunk ?? changed.byteLength;
		for (let at = 0; at < changed.byteLength; at += Math.max(1, size)) {
			deliver(to, changed.slice(at, at + Math.max(1, size)));
		}
	};
	const shut = (reason: string) => {
		if (closed) return;
		closed = true;
		queueMicrotask(() => {
			for (const end of [ends.device, ends.host]) for (const listener of end.closeListeners) listener(reason);
		});
	};
	const channel = (self: End, direction: "toHost" | "toDevice"): ByteChannel => ({
		send: (bytes) => forward(direction, bytes),
		onData(listener) {
			self.listener = listener;
			for (const bytes of self.queue.splice(0)) listener(bytes);
		},
		onClose(listener) {
			self.closeListeners.push(listener);
		},
		close: () => shut("closed"),
	});
	return {
		device: channel(ends.device, "toHost"),
		host: channel(ends.host, "toDevice"),
		seen: () => ({ toHost: concat(...seen.toHost), toDevice: concat(...seen.toDevice) }),
		tamper(next) {
			change = next;
		},
		close: () => shut("relay closed"),
	};
}

/** Whether `needle`'s bytes appear anywhere in `haystack`. */
export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (needle.byteLength === 0) return true;
	outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
		for (let j = 0; j < needle.byteLength; j++) if (haystack[i + j] !== needle[j]) continue outer;
		return true;
	}
	return false;
}
