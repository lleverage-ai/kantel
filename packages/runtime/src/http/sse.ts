/**
 * Server-sent events for `watch`. Each protocol frame is one event named after its type, with the frame as JSON data;
 * snapshot and delta events carry their cursor as the event ID, so a reconnecting `EventSource` resumes with
 * `Last-Event-ID`. After the first frames (hello, then a snapshot or the missed deltas) the server sends one `ready`
 * event; comments keep idle connections open.
 */
import type { ServerFrame } from "@harbour/protocol";
import { READY_EVENT } from "./wire.ts";

const encoder = new TextEncoder();

export interface SseEvent {
	readonly event: string;
	readonly data: string;
	readonly id?: string;
}

/** One event in SSE's text format. `data` must hold no newlines; JSON.stringify output never does. */
export function encodeSse(event: SseEvent): Uint8Array {
	const id = event.id === undefined ? "" : `id: ${event.id}\n`;
	return encoder.encode(`${id}event: ${event.event}\ndata: ${event.data}\n\n`);
}

export function frameEvent(frame: ServerFrame): SseEvent {
	const id =
		frame.type === "delta" ? frame.delta.cursor : frame.type === "snapshot" ? frame.snapshot.cursor : undefined;
	return { event: frame.type, data: JSON.stringify(frame), ...(id === undefined ? {} : { id }) };
}

export const readyEvent: SseEvent = { event: READY_EVENT, data: "{}" };
export const SSE_COMMENT = encoder.encode(": keep-alive\n\n");

/** Reads SSE events from a byte stream until it ends or `onEvent` returns false to stop. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => boolean): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "message";
	let data: string[] = [];
	let id: string | undefined;
	const dispatch = (): boolean => {
		if (data.length === 0) {
			event = "message";
			return true;
		}
		const result = onEvent({ event, data: data.join("\n"), ...(id === undefined ? {} : { id }) });
		event = "message";
		data = [];
		id = undefined;
		return result;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.search(/\r\n|\r|\n/);
			// A lone \r at the end may be the first half of \r\n: wait for the next chunk.
			while (newline >= 0 && !(newline === buffer.length - 1 && buffer.endsWith("\r"))) {
				const line = buffer.slice(0, newline);
				const width = buffer.startsWith("\r\n", newline) ? 2 : 1;
				buffer = buffer.slice(newline + width);
				if (line === "") {
					if (!dispatch()) return;
				} else if (!line.startsWith(":")) {
					const colon = line.indexOf(":");
					const field = colon < 0 ? line : line.slice(0, colon);
					let value = colon < 0 ? "" : line.slice(colon + 1);
					if (value.startsWith(" ")) value = value.slice(1);
					if (field === "event") event = value;
					else if (field === "data") data.push(value);
					else if (field === "id") id = value;
				}
				newline = buffer.search(/\r\n|\r|\n/);
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}
