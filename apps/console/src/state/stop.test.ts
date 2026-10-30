import {
	type ClientFrame,
	PROTOCOL_VERSION,
	type ServerFrame,
	type SessionSnapshot,
	type ToolItem,
} from "@harbour/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerState } from "../ui/actions.ts";
import { Outbox } from "./outbox.ts";
import { SessionClient, type Transport } from "./session-client.ts";
import { Stopper } from "./stop.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const LIVE = { live: true } as const;
const SESSION = "s1";

/** A host the test speaks for: it answers hello with `snapshot`, and `push` sends a frame down the stream. */
function scriptedHost(snapshot: SessionSnapshot) {
	let receive: ((frame: ServerFrame) => void) | undefined;
	const transport: Transport = {
		connect(onFrame) {
			receive = onFrame;
			return {
				send(frame: ClientFrame) {
					if (frame.type !== "hello") return;
					queueMicrotask(() => {
						onFrame({
							type: "hello",
							v: PROTOCOL_VERSION,
							sessionId: SESSION,
							cursor: snapshot.cursor,
							resumed: false,
						} as ServerFrame);
						onFrame({ type: "snapshot", snapshot });
					});
				},
				close() {},
			};
		},
	};
	return { transport, push: (frame: ServerFrame) => receive?.(frame) };
}

const bash: ToolItem = {
	kind: "tool",
	id: "t1",
	at: 1_000,
	callId: "call-1",
	name: "bash",
	label: "Running pip install pillow",
	status: "running",
	args: { command: "cd /workspace && (pip install pillow 2>&1 | tail -1)" },
	tier: "container",
};

const running: SessionSnapshot = {
	v: PROTOCOL_VERSION,
	sessionId: SESSION,
	cursor: "c1",
	status: "running",
	attention: "working",
	items: [{ kind: "user", id: "u1", at: 900, text: "Make a PDF of the cat pictures", via: "prompt" }, bash],
	hasEarlier: false,
	updatedAt: 1_000,
};

/** The stream's frames when the run is interrupted during the call, as the host sends them before it answers the abort. */
const interrupted = (cursor: string): ServerFrame => ({
	type: "delta",
	delta: {
		sessionId: SESSION,
		cursor,
		at: 2_000,
		ops: [
			{ op: "replace", item: { ...bash, status: "interrupted", output: "Tool bash was aborted", endedAt: 2_000 } },
			{ op: "status", status: "idle", attention: "done" },
		],
	},
});

/** A session screen's pieces, wired as `app/session-screen.tsx` wires them. */
async function screen(cancel: () => Promise<void>) {
	const host = scriptedHost(running);
	const session = new SessionClient(host.transport, SESSION);
	const failures: string[] = [];
	const stopper = new Stopper(cancel, (reason) => failures.push(reason));
	session.subscribe(() => stopper.settle(session.getState().status));
	const delivered: string[] = [];
	const outbox = new Outbox(async (message) => {
		delivered.push(message.text);
	});
	session.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(session.getState().status).toBe("running");
	// What the composer shows: `sending` is the screen's own sends (a browser decision, a follow-up), never a stop.
	const composer = () => composerState(LIVE, session.getState().status, false);
	return { host, session, stopper, outbox, delivered, failures, composer };
}

describe("Stop during a tool call (TASK-4146)", () => {
	it("leaves the composer ready for the next message as soon as the stream says the run ended, without a reload", async () => {
		// The deployed host answers the abort only once the container command the call started has ended: 64 s in the
		// report. The request never settles in this test.
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const { host, session, stopper, outbox, delivered, composer } = await screen(cancel);
		expect(composer()).toBe("running");

		stopper.stop();
		expect(cancel).toHaveBeenCalledTimes(1);
		// Held, not sending: Stop shows disabled and can't abort twice; the composer never spins.
		expect(stopper.getState()).toBe(true);
		expect(composer()).toBe("running");
		stopper.stop();
		expect(cancel).toHaveBeenCalledTimes(1);

		host.push(interrupted("c2"));
		await vi.advanceTimersByTimeAsync(0);
		expect(session.getState().items.at(-1)).toMatchObject({ kind: "tool", status: "interrupted" });
		expect(session.getState().status).toBe("idle");
		// The run has ended: the composer offers Send, with the abort request still on its way.
		expect(stopper.getState()).toBe(false);
		expect(composer()).toBe("idle");

		// And the next message goes to the host.
		outbox.send("prompt", "Try img2pdf instead");
		await vi.advanceTimersByTimeAsync(0);
		expect(delivered).toEqual(["Try img2pdf instead"]);
		expect(outbox.getState()).toMatchObject([{ status: "sent" }]);
	});

	it("frees Stop when the abort fails, says why, and lets it be pressed again", async () => {
		const cancel = vi.fn().mockRejectedValueOnce(new Error("Can't reach Harbour. Check your connection."));
		cancel.mockImplementation(() => new Promise<void>(() => {}));
		const { stopper, failures, composer } = await screen(cancel);

		stopper.stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(stopper.getState()).toBe(false);
		expect(failures).toEqual(["Can't reach Harbour. Check your connection."]);
		expect(composer()).toBe("running");

		stopper.stop();
		expect(cancel).toHaveBeenCalledTimes(2);
		expect(stopper.getState()).toBe(true);
	});

	it("ignores a late failure once the stream has ended the run", async () => {
		let fail: (reason: Error) => void = () => {};
		const cancel = vi.fn(
			() =>
				new Promise<void>((_, reject) => {
					fail = reject;
				}),
		);
		const { host, stopper, failures, composer } = await screen(cancel);

		stopper.stop();
		host.push(interrupted("c2"));
		await vi.advanceTimersByTimeAsync(0);
		expect(composer()).toBe("idle");

		fail(new Error("timed out"));
		await vi.advanceTimersByTimeAsync(0);
		expect(failures).toEqual([]);
		expect(stopper.getState()).toBe(false);
	});

	it("frees Stop when the abort is answered, even before the stream catches up", async () => {
		const cancel = vi.fn(async () => {});
		const { stopper, composer } = await screen(cancel);

		stopper.stop();
		expect(stopper.getState()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(stopper.getState()).toBe(false);
		expect(composer()).toBe("running");
	});
});
