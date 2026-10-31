// Recorded sessions, two ways. A Pi Durable recording (fixtures/pi-durable/*.jsonl) is what Pi's `watchEvents()`
// emitted, one commit per line. A frame fixture (fixtures/sessions/*.jsonl) is what Kantel's protocol sends a client
// that connects before the recording starts: `hello`, one `snapshot` with every item, then a `delta` per commit. The
// second is made from the first by the projector, deterministically, with `pnpm fixtures`.

import { PROTOCOL_VERSION, type ServerFrame, type SessionDelta } from "@kantel/protocol";
import type { RecordedBatch, RecordingHeader, SnapshotEvent } from "../pi-durable/events.ts";
import { Projector } from "./project.ts";

export type Recording = { header: RecordingHeader; snapshot: SnapshotEvent; batches: RecordedBatch[] };

export function parseRecording(text: string): Recording {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	const [first, ...rest] = lines.map((line) => JSON.parse(line) as unknown);
	const header = first as RecordingHeader;
	if (header?.recording !== "pi-durable/watchEvents") throw new Error("Not a recorded Pi Durable stream");
	const batches = rest as RecordedBatch[];
	const opening = batches.shift();
	const snapshot = opening?.events[0];
	if (snapshot?.type !== "snapshot") throw new Error("A recording starts with a snapshot batch");
	return { header, snapshot, batches };
}

/** Used when a recording has no timestamped message to date it by. */
export const RECORDING_EPOCH = Date.UTC(2026, 9, 27, 9, 0, 0);

/**
 * Wall-clock time of a recording's start. Batches carry only offsets (`at`), so frames are dated from the first live
 * message's own timestamp, keeping the projector's times and Pi's message times on one clock.
 */
export function recordingStart(recording: Recording): number {
	for (const batch of recording.batches) {
		for (const event of batch.events) {
			if (event.type === "message_start") return event.message.timestamp - batch.at;
		}
	}
	return RECORDING_EPOCH;
}

export const FIXTURE_SESSION_ID = "session-1";

/** A recording as protocol frames: hello, a snapshot holding every item, then one delta per commit that changed something. */
export function toFrames(recording: Recording, sessionId = FIXTURE_SESSION_ID): ServerFrame[] {
	const projector = new Projector();
	const start = recordingStart(recording);
	const { items, status } = projector.fromSnapshot(recording.snapshot, start);
	const frames: ServerFrame[] = [
		{ type: "hello", v: PROTOCOL_VERSION, sessionId, cursor: "c0", resumed: false },
		{
			type: "snapshot",
			snapshot: {
				v: PROTOCOL_VERSION,
				sessionId,
				cursor: "c0",
				status,
				attention: status === "running" ? "working" : "done",
				title: recording.header.title,
				items,
				hasEarlier: false,
				updatedAt: start,
			},
		},
	];
	let sequence = 0;
	for (const batch of recording.batches) {
		const at = start + batch.at;
		const ops = projector.batch(batch.events, at);
		if (ops.length === 0) continue;
		const delta: SessionDelta = { sessionId, cursor: `c${++sequence}`, at, ops };
		frames.push({ type: "delta", delta });
	}
	return frames;
}
