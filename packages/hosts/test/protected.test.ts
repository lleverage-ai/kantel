// Protected variables on the host link: the egress a host is given names the hosts to intercept and the grants, never a
// value; the hub answers a host's `secrets.fetch` for its own connection only; and egress reports reach `onEgress`.
import type { BackendEgress } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostEgress } from "../src/backend.ts";
import { createHostHub, type HostHub, type HostHubOptions } from "../src/hub.ts";
import type { HostEgressRecord, HostMessage, HostSecrets, HostWelcome } from "../src/protocol.ts";
import { facts } from "./fake-host.ts";

const SECRET = "ghp_TESTSECRETVALUE123";

const TABLE: HostSecrets = {
	version: 7,
	entries: [
		{
			placeholder: `kph_${"a".repeat(40)}`,
			name: "GH_TOKEN",
			value: SECRET,
			bindings: [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET"] }],
		},
	],
};

describe("hostEgress", () => {
	const egress: BackendEgress = {
		defaultAction: "deny",
		allow: ["registry.npmjs.org"],
		deny: ["tracker.example"],
		upstream: { url: "http://mehen.internal:3128", headers: { "Proxy-Authorization": "Bearer upstream" } },
		attribution: true,
		protected: { version: 7, intercept: ["api.github.com", "*.example.com"] },
		grants: [
			{
				action: "deny",
				host: "api.github.com",
				methods: ["DELETE"],
				paths: ["/repos/*"],
				rule: "deny DELETE api.github.com /repos/*",
			},
			{ action: "allow", host: "example.org", rule: "allow example.org" },
		],
	};

	it("maps the protected hosts, their version and the grants", () => {
		expect(hostEgress(egress, "attribution-key")).toEqual({
			mode: "proxy",
			allow: ["registry.npmjs.org"],
			deny: ["tracker.example"],
			defaultDeny: true,
			upstream: "http://mehen.internal:3128",
			headers: { "Proxy-Authorization": "Bearer upstream" },
			attributionKey: "attribution-key",
			protected: { version: 7, intercept: ["api.github.com", "*.example.com"] },
			grants: [
				{
					action: "deny",
					host: "api.github.com",
					methods: ["DELETE"],
					paths: ["/repos/*"],
					rule: "deny DELETE api.github.com /repos/*",
				},
				{ action: "allow", host: "example.org", rule: "allow example.org" },
			],
		});
	});

	it("leaves out what isn't there, and carries no value even when one is slipped in", () => {
		expect(hostEgress(undefined)).toBeUndefined();
		expect(hostEgress({ defaultAction: "allow", allow: [], deny: [], attribution: true, grants: [] })).toEqual({
			mode: "proxy",
			allow: [],
			deny: [],
			defaultDeny: false,
		});
		// Only the version and the hosts are copied: a value on the egress by mistake never reaches the host.
		const slipped = {
			...egress,
			protected: { ...egress.protected, entries: TABLE.entries, value: SECRET },
			grants: egress.grants?.map((grant) => ({ ...grant, value: SECRET })),
		} as unknown as BackendEgress;
		const mapped = hostEgress(slipped, "attribution-key");
		expect(JSON.stringify(mapped)).not.toContain(SECRET);
		expect(JSON.stringify(mapped)).not.toContain("kph_");
		expect(mapped?.protected).toEqual({ version: 7, intercept: ["api.github.com", "*.example.com"] });
	});
});

const hubs: HostHub[] = [];

afterEach(() => {
	for (const hub of hubs.splice(0)) hub.closeAll(1000, "done");
});

/** A hub over `options`, welcoming every host. */
function hubWith(options: Partial<HostHubOptions> = {}): HostHub {
	const hub = createHostHub({
		onHello: async (hostId) => ({ hostId, heartbeatSeconds: 15 }),
		...options,
	});
	hubs.push(hub);
	return hub;
}

/** A host connected to `hub` as `hostId`: what it was sent, and a way to send. */
function connect(hub: HostHub, hostId: string) {
	const sent: HostMessage[] = [];
	const accepted = hub.accept(hostId, {
		sendText: (text) => sent.push(JSON.parse(text) as HostMessage),
		sendBinary: () => undefined,
		close: () => undefined,
	});
	const send = (message: object) => accepted.receive(JSON.stringify(message));
	send({
		type: "hello",
		hello: {
			hostId,
			facts: facts(),
			sandboxes: [],
			capacity: { freeMemoryMiB: 1024, freeDiskGiB: 10, running: 0, stopped: 0, load1: 0, warm: {} },
		},
	});
	/** The answer to the host's call `id`, once it comes. */
	const result = async (id: string): Promise<HostMessage> => {
		let found: HostMessage | undefined;
		await vi.waitFor(() => {
			found = sent.find((message) => message.type === "result" && message.id === id);
			if (found === undefined) throw new Error(`No answer to ${id} yet`);
		});
		return found as HostMessage;
	};
	const welcomed = () =>
		vi.waitFor(() => {
			if (!sent.some((message) => message.type === "welcome")) throw new Error("Not welcomed yet");
		});
	return { sent, send, result, welcomed };
}

describe("the hub's secrets.fetch", () => {
	it("answers through `secrets` for the connection's own host, whatever the host names", async () => {
		const secrets = vi.fn(async (_hostId: string, sandboxId: string) => (sandboxId === "sbx_mine" ? TABLE : undefined));
		const host = connect(hubWith({ secrets }), "host_a");
		await host.welcomed();

		host.send({ type: "call", id: "h1", method: "secrets.fetch", params: { sandboxId: "sbx_mine", hostId: "host_b" } });
		expect(await host.result("h1")).toEqual({ type: "result", id: "h1", result: TABLE });
		expect(secrets).toHaveBeenCalledWith("host_a", "sbx_mine");

		host.send({ type: "call", id: "h2", method: "secrets.fetch", params: { sandboxId: "sbx_elsewhere" } });
		expect((await host.result("h2")).error?.code).toBe("not_found");
		expect(secrets).toHaveBeenLastCalledWith("host_a", "sbx_elsewhere");

		host.send({ type: "call", id: "h3", method: "secrets.fetch", params: {} });
		expect((await host.result("h3")).error?.code).toBe("not_found");
		expect(secrets).toHaveBeenCalledTimes(2);
	});

	it("refuses any other method", async () => {
		const secrets = vi.fn(async () => TABLE);
		const host = connect(hubWith({ secrets }), "host_a");
		await host.welcomed();
		host.send({ type: "call", id: "h1", method: "sandbox.list", params: { sandboxId: "sbx_mine" } });
		const answer = await host.result("h1");
		expect(answer.result).toBeUndefined();
		expect(answer.error?.code).toBe("unsupported");
		expect(answer.error?.message).toContain("sandbox.list");
		expect(secrets).not.toHaveBeenCalled();
	});

	it("answers unavailable, without the reason, when the secrets fail or there is no source of them", async () => {
		const failing = connect(
			hubWith({
				secrets: async () => {
					throw new Error(`could not open ${SECRET}`);
				},
			}),
			"host_a",
		);
		await failing.welcomed();
		failing.send({ type: "call", id: "h1", method: "secrets.fetch", params: { sandboxId: "sbx_mine" } });
		const failed = await failing.result("h1");
		expect(failed.error?.code).toBe("unavailable");
		expect(JSON.stringify(failed)).not.toContain(SECRET);

		const none = connect(hubWith(), "host_b");
		await none.welcomed();
		none.send({ type: "call", id: "h1", method: "secrets.fetch", params: { sandboxId: "sbx_mine" } });
		expect((await none.result("h1")).error?.code).toBe("unavailable");
	});

	it("answers nothing but unavailable before the host is welcomed", async () => {
		let welcome: () => void = () => undefined;
		const secrets = vi.fn(async () => TABLE);
		const onEgress = vi.fn();
		const hub = hubWith({
			secrets,
			onEgress,
			onHello: (hostId) =>
				new Promise<HostWelcome>((resolve) => {
					welcome = () => resolve({ hostId, heartbeatSeconds: 15 });
				}),
		});
		const host = connect(hub, "host_a");
		host.send({ type: "call", id: "h1", method: "secrets.fetch", params: { sandboxId: "sbx_mine" } });
		expect((await host.result("h1")).error?.code).toBe("unavailable");
		host.send({ type: "event", event: { kind: "egress", at: 1, egress: [] } });
		welcome();
		await host.welcomed();
		expect(secrets).not.toHaveBeenCalled();
		expect(onEgress).not.toHaveBeenCalled();
	});
});

describe("the hub's egress events", () => {
	it("reach onEgress with the connection's host, and not onEvent", async () => {
		const onEgress = vi.fn();
		const onEvent = vi.fn();
		const host = connect(hubWith({ onEgress, onEvent }), "host_a");
		await host.welcomed();
		const records: HostEgressRecord[] = [
			{
				at: 1_700_000_000_000,
				sandboxId: "sbx_mine",
				method: "GET",
				host: "api.github.com",
				port: 443,
				path: "/repos/lleverage-ai/kantel",
				allowed: true,
				swapped: ["GH_TOKEN"],
				inspected: true,
				status: 200,
				bytesUp: 120,
				bytesDown: 900,
			},
			{
				at: 1_700_000_000_001,
				sandboxId: "sbx_mine",
				method: "CONNECT",
				host: "tracker.example",
				port: 443,
				allowed: false,
				rule: "deny tracker.example",
				code: "denied",
				swapped: [],
				inspected: false,
				bytesUp: 0,
				bytesDown: 0,
			},
		];
		host.send({ type: "event", event: { kind: "egress", at: 1_700_000_000_002, egress: records } });
		await vi.waitFor(() => expect(onEgress).toHaveBeenCalledTimes(1));
		expect(onEgress).toHaveBeenCalledWith("host_a", records);
		expect(onEvent).not.toHaveBeenCalled();

		// One that keeps failing is no reason to drop the host.
		onEgress.mockImplementation(async () => {
			throw new Error("the store is down");
		});
		host.send({ type: "event", event: { kind: "egress", at: 1_700_000_000_003, egress: records } });
		await vi.waitFor(() => expect(onEgress).toHaveBeenCalledTimes(2));
		host.send({ type: "event", event: { kind: "sandbox.state", at: 1_700_000_000_004 } });
		await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
	});
});
