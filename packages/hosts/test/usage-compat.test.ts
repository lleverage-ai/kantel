// kantel-host sends a `usage` message every 5 s (apps/host/internal/agent/usage.go). A control plane that predates it
// must keep the host's connection: its hub drops a message type it doesn't know.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostHub, type HostHub } from "../src/hub.ts";
import type { HostMessage } from "../src/protocol.ts";
import { facts } from "./fake-host.ts";

/** What kantel-host's Go side marshals (TestUsageEventWireShape in apps/host/internal/agent/usage_test.go). */
const USAGE_FRAME =
	'{"type":"usage","usage":{"at":1,"intervalMs":5000,"host":{"cpu":0.25,"memUsedBytes":1,"memTotalBytes":2,"diskUsedBytes":3,"diskTotalBytes":4},"sandboxes":[{"id":"sbx_a","kind":"microvm","cpu":0.5,"memUsedBytes":5,"memLimitBytes":6}]}}';

const hubs: HostHub[] = [];

afterEach(() => {
	for (const hub of hubs.splice(0)) hub.closeAll(1000, "done");
});

describe("a host's usage messages", () => {
	it("keep the connection of a hub that doesn't take them, which goes on answering calls", async () => {
		const onEvent = vi.fn();
		const onHeartbeat = vi.fn();
		const hub = createHostHub({ onHello: async (hostId) => ({ hostId, heartbeatSeconds: 15 }), onEvent, onHeartbeat });
		hubs.push(hub);
		const sent: HostMessage[] = [];
		const close = vi.fn();
		const accepted = hub.accept("host_a", {
			sendText: (text) => sent.push(JSON.parse(text) as HostMessage),
			sendBinary: () => undefined,
			close,
		});
		accepted.receive(
			JSON.stringify({
				type: "hello",
				hello: {
					hostId: "host_a",
					facts: facts({}, ["egress-policy", "usage"]),
					sandboxes: [],
					capacity: { freeMemoryMiB: 1, freeDiskGiB: 1, running: 0, stopped: 0, load1: 0, warm: {} },
				},
			}),
		);
		await vi.waitFor(() => expect(sent.some((message) => message.type === "welcome")).toBe(true));
		// A tick, the same with no sandbox running (Go's nil slice), and a batch sent after a reconnect.
		accepted.receive(USAGE_FRAME);
		accepted.receive(USAGE_FRAME.replace(/"sandboxes":\[.*\]/, '"sandboxes":null'));
		for (let i = 0; i < 50; i++) accepted.receive(USAGE_FRAME);
		expect(close).not.toHaveBeenCalled();
		expect(hub.connected("host_a")).toBe(true);
		expect(onEvent).not.toHaveBeenCalled();
		expect(onHeartbeat).not.toHaveBeenCalled();

		const answered = hub.call<{ ok: boolean }>("host_a", "sandbox.list", {});
		await vi.waitFor(() => expect(sent.some((message) => message.type === "call")).toBe(true));
		const call = sent.find((message) => message.type === "call");
		accepted.receive(JSON.stringify({ type: "result", id: call?.id, result: { ok: true } }));
		await expect(answered).resolves.toEqual({ ok: true });
	});
});
