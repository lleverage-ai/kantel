// Server-sent events from a fetch response body. The session API streams one session's protocol frames this way
// (`GET /v1/sessions/:id/events`). `EventSource` would do, except that it reconnects on its own with
// `Last-Event-ID`; the console's SessionClient owns reconnecting, with backoff and its own cursor, so the stream is
// read with fetch and simply ends.

export type SseEvent = { readonly event: string; readonly data: string };

/** Calls `onEvent` for each event until the stream ends, then resolves. Rejects when reading fails. */
export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "message";
	let data: string[] = [];
	const line = (text: string) => {
		if (text === "") {
			if (data.length > 0) onEvent({ event, data: data.join("\n") });
			event = "message";
			data = [];
			return;
		}
		if (text.startsWith(":")) return;
		const colon = text.indexOf(":");
		const field = colon < 0 ? text : text.slice(0, colon);
		let value = colon < 0 ? "" : text.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const end = buffer.search(/\r\n|\r|\n/);
				// A \r at the very end may be half of \r\n; wait for the next chunk.
				if (end < 0 || (end === buffer.length - 1 && buffer.endsWith("\r"))) break;
				const width = buffer.startsWith("\r\n", end) ? 2 : 1;
				line(buffer.slice(0, end));
				buffer = buffer.slice(end + width);
			}
		}
	} finally {
		reader.releaseLock();
	}
}
