import type { ServerFrame } from "./index.ts";
import { ProtocolError } from "./reduce.ts";

const FRAME_TYPES = new Set(["hello", "snapshot", "delta", "history", "error"]);

/**
 * Parses a recorded session fixture: JSON Lines, one `ServerFrame` per line, as the console's
 * `fixtures/sessions/*.jsonl` files hold them. Blank lines are skipped.
 */
export function parseFixture(text: string): ServerFrame[] {
	const frames: ServerFrame[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new ProtocolError("invalid", `Line ${index + 1} is not JSON`);
		}
		const type = (value as { type?: unknown } | null)?.type;
		if (typeof type !== "string" || !FRAME_TYPES.has(type)) {
			throw new ProtocolError("invalid", `Line ${index + 1} is not a server frame`);
		}
		frames.push(value as ServerFrame);
	}
	return frames;
}

/** Writes frames as a JSON Lines fixture. */
export function serializeFixture(frames: Iterable<ServerFrame>): string {
	let out = "";
	for (const frame of frames) out += `${JSON.stringify(frame)}\n`;
	return out;
}
