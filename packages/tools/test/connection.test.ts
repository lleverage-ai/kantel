import type { ToolServerSnapshot } from "@harbour/contracts";
import { describe, expect, it, vi } from "vitest";
import { TunnelConnection, type TunnelConnectionState, type TunnelReady } from "../src/connection.ts";
import { TUNNEL_MAX_MESSAGE_BYTES } from "../src/protocol.ts";
import { echoHandler, type FakeHandler, fakeServer } from "./fake-server.ts";

function open(handler?: FakeHandler, state?: TunnelConnectionState) {
	const server = fakeServer(handler);
	const frames: string[] = [];
	const closes: [number, string][] = [];
	const ready: TunnelReady[] = [];
	const snapshots: ToolServerSnapshot[] = [];
	let now = 1000;
	const connection = new TunnelConnection({
		socket: {
			send: (text) => {
				frames.push(text);
				if (text !== "pong") server.send(text);
			},
			close: (code, reason) => closes.push([code, reason]),
		},
		clock: { now: () => now },
		...(state === undefined ? {} : { state }),
		onReady: (info) => {
			ready.push(info);
		},
		onSnapshot: (snapshot) => {
			snapshots.push(snapshot);
		},
		onClosed: (code, reason) => closes.push([-code, reason]),
	});
	server.attach((text) => connection.receive(text));
	return { server, connection, frames, closes, ready, snapshots, tick: (ms: number) => (now += ms) };
}

/** A server whose tools are `tools()` at the time each `tools/list` comes. */
function changingServer(tools: () => string[], hold?: () => boolean): FakeHandler {
	return (request) => {
		if (request.method !== "tools/list") return echoHandler(request);
		if (hold?.() === true) return "hold";
		return { result: { tools: tools().map((name) => ({ name })) } };
	};
}

describe("TunnelConnection", () => {
	it("initialises, lists and is ready with the server's info and a snapshot", async () => {
		const env = open();
		await env.connection.start();
		expect(env.server.methods()).toEqual(["initialize", "notifications/initialized", "tools/list"]);
		expect(env.ready).toHaveLength(1);
		expect(env.ready[0]?.serverInfo).toEqual({ name: "fake", version: "1" });
		expect(env.ready[0]?.snapshot.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(env.ready[0]?.snapshot.takenAt).toBe(1000);
		expect(env.connection.state().snapshotHash).toBe(env.ready[0]?.snapshot.hash);
	});

	it("answers ping with pong outside JSON-RPC, and notes when it heard from the server", () => {
		const env = open();
		env.tick(500);
		env.connection.receive("ping");
		expect(env.frames).toEqual(["pong"]);
		expect(env.server.received).toEqual([]);
		expect(env.connection.lastSeenAt).toBe(1500);
	});

	it("closes 1003 on a binary frame, 1009 on a frame too large and 1008 on one that isn't JSON-RPC", () => {
		const binary = open();
		binary.connection.receive(new Uint8Array([1, 2]));
		expect(binary.closes[0]).toEqual([1003, "The tunnel takes text frames only"]);

		const large = open();
		large.connection.receive(`"${"x".repeat(TUNNEL_MAX_MESSAGE_BYTES)}"`);
		expect(large.closes[0]?.[0]).toBe(1009);

		const bad = open();
		bad.connection.receive("{nope");
		expect(bad.closes).toEqual([
			[1008, "A frame wasn't a JSON-RPC message"],
			[-1008, "A frame wasn't a JSON-RPC message"],
		]);
		// Only the first close counts.
		bad.connection.close(1000, "again");
		expect(bad.closes).toHaveLength(2);
	});

	it("closes 1008 when the server won't initialise", async () => {
		const env = open(() => ({ error: { code: -32603, message: "no" } }));
		await env.connection.start();
		expect(env.ready).toEqual([]);
		expect(env.closes[0]).toEqual([1008, "The tool server didn't start: The tool server refused initialize: no"]);
	});

	it("lists again on list_changed and reports a snapshot only when the hash changed", async () => {
		let tools = ["echo"];
		const env = open(changingServer(() => tools));
		await env.connection.start();

		env.server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(env.server.requests("tools/list")).toHaveLength(2));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(env.snapshots).toEqual([]);

		tools = ["echo", "added"];
		env.server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(env.snapshots).toHaveLength(1));
		expect(env.snapshots[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "added"]);
		expect(env.snapshots[0]?.hash).not.toBe(env.ready[0]?.snapshot.hash);
		expect(env.connection.state().snapshotHash).toBe(env.snapshots[0]?.hash);
	});

	it("lists at most once more however many changes come during a listing", async () => {
		let tools = ["echo"];
		let holding = false;
		const env = open(
			changingServer(
				() => tools,
				() => holding,
			),
		);
		await env.connection.start();
		tools = ["echo", "new"];
		holding = true;
		for (let i = 0; i < 3; i += 1) env.server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		expect(env.server.requests("tools/list")).toHaveLength(2);

		holding = false;
		const [waiting] = [...env.server.held.values()];
		env.server.push({ jsonrpc: "2.0", id: waiting?.id, result: { tools: [{ name: "echo" }, { name: "new" }] } });
		await vi.waitFor(() => expect(env.server.requests("tools/list")).toHaveLength(3));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(env.server.requests("tools/list")).toHaveLength(3);
		expect(env.snapshots).toHaveLength(1);
	});

	it("lists again after start when the tools changed while it was listing", async () => {
		let tools = ["echo"];
		let first = true;
		const env = open((request) => {
			if (request.method === "tools/list" && first) {
				first = false;
				// The server changes its tools between answering and Harbour reading the answer.
				setTimeout(() => env.server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 0);
				tools = ["echo", "later"];
				return { result: { tools: [{ name: "echo" }] } };
			}
			return changingServer(() => tools)(request);
		});
		await env.connection.start();
		await vi.waitFor(() => expect(env.snapshots).toHaveLength(1));
		expect(env.snapshots[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "later"]);
	});

	it("passes calls through and rejects those waiting when it closes", async () => {
		const env = open((request) => (request.method === "tools/call" ? "hold" : echoHandler(request)));
		await env.connection.start();
		const call = env.connection.callTool({ name: "echo" }).catch((caught: unknown) => caught);
		env.connection.close(4004, "The tool server was removed");
		expect(((await call) as Error).message).toBe("The tool server's tunnel closed: The tool server was removed");
		expect(env.closes).toEqual([
			[4004, "The tool server was removed"],
			[-4004, "The tool server was removed"],
		]);
	});

	it("is rebuilt from state() without initialising or listing again", async () => {
		let tools = ["echo"];
		const first = open(changingServer(() => tools));
		await first.connection.start();
		const state = JSON.parse(JSON.stringify(first.connection.state())) as TunnelConnectionState;

		const rebuilt = open(
			changingServer(() => tools),
			state,
		);
		await rebuilt.connection.start();
		expect(rebuilt.server.received).toEqual([]);
		expect(rebuilt.ready).toEqual([]);

		// The same tools again are no change; new ones are.
		rebuilt.server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(rebuilt.server.requests("tools/list")).toHaveLength(1));
		tools = ["echo", "two"];
		rebuilt.server.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await vi.waitFor(() => expect(rebuilt.snapshots).toHaveLength(1));
		expect(rebuilt.server.requests("tools/list").map((request) => request.id)).toEqual([3, 4]);
	});
});
