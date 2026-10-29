// Reads a recording chunk: Matroska holding MJPEG, one frame per Cluster, as the browser's recorder writes it
// (images/browser/agent/mkv.mjs, from tvdavies/brwsr@0d22bf8). Nothing is decoded here but the container: each frame
// is a JPEG the page draws as it is, so a replay needs no video encoder anywhere.

/** One frame: its JPEG bytes and when it was drawn, in milliseconds on its page's timeline. */
export interface ReplayFrame {
	readonly ms: number;
	readonly jpeg: Uint8Array;
}

const CLUSTER = 0x1f43b675;
const SEGMENT = 0x18538067;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
/** Elements whose children are read; everything else is skipped by its size. */
const MASTERS = new Set([SEGMENT, CLUSTER]);

/** An EBML variable-length integer at `at`: its value (with the length marker kept for IDs) and length. */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
	const first = bytes[at];
	if (first === undefined || first === 0) throw new Error("Not a Matroska element");
	let length = 1;
	while ((first & (0x80 >> (length - 1))) === 0) length += 1;
	if (at + length > bytes.length) throw new Error("A Matroska element is cut short");
	let value = keepMarker ? first : first & (0xff >> length);
	let allOnes = value === 0xff >> length;
	for (let i = 1; i < length; i++) {
		const byte = bytes[at + i]!;
		if (byte !== 0xff) allOnes = false;
		value = value * 256 + byte;
	}
	return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(bytes: Uint8Array, at: number, size: number): number {
	let value = 0;
	for (let i = 0; i < size; i++) value = value * 256 + bytes[at + i]!;
	return value;
}

/** Every frame in one chunk, in order. A chunk cut short gives the frames before the cut. */
export function readFrames(bytes: Uint8Array): ReplayFrame[] {
	const frames: ReplayFrame[] = [];
	let clusterMs = 0;
	const walk = (start: number, end: number) => {
		let at = start;
		while (at < end) {
			let id: ReturnType<typeof vint>;
			let size: ReturnType<typeof vint>;
			try {
				id = vint(bytes, at, true);
				size = vint(bytes, at + id.length, false);
			} catch {
				return;
			}
			const body = at + id.length + size.length;
			// A Segment or Cluster cut short is read as far as it goes; any other element cut short (a frame half written)
			// ends the chunk there, so no partial JPEG is drawn.
			if (!size.unknown && !MASTERS.has(id.value) && body + size.value > end) return;
			const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
			if (MASTERS.has(id.value)) {
				walk(body, bodyEnd);
			} else if (id.value === TIMESTAMP) {
				clusterMs = readUint(bytes, body, bodyEnd - body);
			} else if (id.value === SIMPLE_BLOCK && bodyEnd - body > 4) {
				// Track number (a vint, one byte for track 1), a signed 16-bit timecode relative to the cluster, flags.
				const track = vint(bytes, body, false);
				const relative = ((bytes[body + track.length]! << 24) >> 16) | bytes[body + track.length + 1]!;
				const jpegAt = body + track.length + 3;
				frames.push({ ms: clusterMs + relative, jpeg: bytes.subarray(jpegAt, bodyEnd) });
			}
			if (size.unknown && !MASTERS.has(id.value)) return;
			at = bodyEnd;
		}
	};
	walk(0, bytes.length);
	return frames;
}

/** The newest frame at or before `ms` in frames sorted by time, or the first when none is. */
export function frameAt<T extends { readonly ms: number }>(frames: readonly T[], ms: number): T | undefined {
	let low = 0;
	let high = frames.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (frames[mid]!.ms <= ms) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return frames[Math.max(found, 0)];
}
