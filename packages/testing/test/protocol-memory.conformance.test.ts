import { createMemorySessionStream } from "@harbour/protocol/memory";
import { describe, expect, it } from "vitest";
import { registerProtocolConformance } from "../src/protocol.ts";

registerProtocolConformance({ describe, expect, it }, "in-memory session stream", async (deps, use) => {
	const stream = createMemorySessionStream({
		sessionId: "session-1",
		pageSize: 10,
		retainDeltas: 20,
		now: () => deps.clock.now(),
	});
	await use({ stream, writer: stream, pageSize: 10, retainDeltas: 20 });
});
