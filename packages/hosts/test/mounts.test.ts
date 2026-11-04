// Mounts and file streams on the host link: the hub's file streams (`sandbox.files.open`) and the end reasons they
// carry, a host's `bucket.fetch` and `sandbox.mounts` events, the bundle route a host fetches tars from, and the
// backend's handoff of mounts to hosts by their features, and its file streams.
import type { BackendMount, SandboxBackend, SandboxSpec } from "@kantel/compute";
import { isKantelError, type KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend, fileStreamEnd } from "../src/backend.ts";
import { createHostsApi, HOSTS_BUNDLES_PATH } from "../src/http.ts";
import {
	createHostHub,
	FILE_STREAM_BUFFER_BYTES,
	HostCallError,
	type HostHub,
	type HostHubOptions,
	type PortSink,
} from "../src/hub.ts";
import {
	decodeStreamFrame,
	encodeStreamFrame,
	FILE_STREAM_ACK_BYTES,
	FILE_STREAM_FRAME_MAX_BYTES,
	FILE_STREAM_WINDOW_BYTES,
	HOST_FEATURES,
	HOST_MESSAGE_LIMIT_BYTES,
	HOST_WRITE_FILE_MAX_BYTES,
	type HostBucketSource,
	type HostFileOpen,
	type HostMessage,
	type HostMountStatus,
} from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostComputeLink, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A body of these chunks. */
const streamOf = (...chunks: string[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encode(chunk));
			controller.close();
		},
	});

async function failure(work: Promise<unknown>): Promise<KantelError> {
	try {
		await work;
	} catch (error) {
		if (isKantelError(error)) return error;
		throw error;
	}
	throw new Error("Expected it to fail");
}

const DIGEST = `sha256:${"ab".repeat(32)}`;
const SOURCE: HostBucketSource = {
	id: "bks_1",
	provider: "s3",
	bucket: "skills",
	region: "eu-west-1",
	credentials: { accessKeyId: "AKIATEST", secretAccessKey: "s3cr3t" },
};

const hubs: HostHub[] = [];
const services: HostsService[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.closeAll(1000, "done");
	for (const service of services.splice(0)) service.close();
});

/** A hub over `options`, welcoming every host. */
function hubWith(options: Partial<HostHubOptions> = {}): HostHub {
	const hub = createHostHub({ onHello: async (hostId) => ({ hostId, heartbeatSeconds: 15 }), ...options });
	hubs.push(hub);
	return hub;
}

/** A host connected to `hub`: what it was sent (text and binary), and ways to send. */
function attach(hub: HostHub, hostId: string, bufferedAmount?: () => number) {
	const sent: HostMessage[] = [];
	const binary: Uint8Array[] = [];
	const accepted = hub.accept(hostId, {
		sendText: (text) => sent.push(JSON.parse(text) as HostMessage),
		sendBinary: (bytes) => binary.push(bytes),
		close: () => undefined,
		...(bufferedAmount === undefined ? {} : { bufferedAmount }),
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
	const find = async (match: (message: HostMessage) => boolean, what: string): Promise<HostMessage> => {
		let found: HostMessage | undefined;
		await vi.waitFor(() => {
			found = sent.find(match);
			if (found === undefined) throw new Error(`No ${what} yet`);
		});
		return found as HostMessage;
	};
	return {
		sent,
		binary,
		send,
		receive: (frame: Uint8Array) => accepted.receive(frame),
		closed: (reason: string) => accepted.closed(1006, reason),
		welcomed: () => find((message) => message.type === "welcome", "welcome"),
		/** The call of `method` Kantel made, once it has. */
		called: (method: string) => find((message) => message.type === "call" && message.method === method, method),
		/** The answer to the host's call `id`, once it comes. */
		result: (id: string) => find((message) => message.type === "result" && message.id === id, `answer to ${id}`),
		/** The binary frames sent, as stream, size and text. */
		frames: () =>
			binary.map((frame) => {
				const decoded = decodeStreamFrame(frame);
				return [decoded?.stream, decoded?.payload.byteLength, decode(decoded?.payload ?? new Uint8Array(0))];
			}),
	};
}

/** A sink that keeps what reaches it. */
function keeping() {
	const data: string[] = [];
	const ends: string[] = [];
	const sink: PortSink = {
		data: (bytes) => data.push(decode(bytes)),
		end: (reason) => ends.push(reason),
	};
	return { data, ends, sink };
}

describe("the hub's file streams", () => {
	it("opens a read, takes bytes that follow its answer at once, and ends it with the host's reason", async () => {
		const hub = hubWith();
		const host = attach(hub, "host_a");
		await host.welcomed();
		const { data, ends, sink } = keeping();
		const opening = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/home/user/big.bin", op: "read" }, sink);
		const call = await host.called("sandbox.files.open");
		const params = call.params as HostFileOpen;
		// A read says Kantel acks what it takes, so the host keeps within its window.
		expect(params).toEqual({
			sandboxId: "sbx_a",
			path: "/home/user/big.bin",
			op: "read",
			stream: expect.any(Number),
			acks: true,
		});
		expect(params.stream).toBeGreaterThan(0);
		host.send({ type: "result", id: call.id, result: { size: 11 } });
		// Before the caller has the stream: the sink was registered before the call.
		host.receive(encodeStreamFrame(params.stream, encode("hello ")));
		const opened = await opening;
		expect(opened.size).toBe(11);
		expect(opened.stream.stream).toBe(params.stream);
		host.receive(encodeStreamFrame(params.stream, encode("world")));
		host.send({ type: "stream.close", stream: params.stream, reason: "ok 11" });
		expect(data).toEqual(["hello ", "world"]);
		expect(ends).toEqual(["ok 11"]);
		// Ended: nothing more reaches the sink.
		host.receive(encodeStreamFrame(params.stream, encode("late")));
		expect(data).toEqual(["hello ", "world"]);
	});

	it("sends a write's bytes, then an empty frame for their end, and passes on an error's reason", async () => {
		const hub = hubWith();
		const host = attach(hub, "host_a");
		await host.welcomed();
		const { ends, sink } = keeping();
		const opening = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/srv/a.tar", op: "write", mode: 0o600 }, sink);
		const call = await host.called("sandbox.files.open");
		const params = call.params as HostFileOpen;
		expect(params).toMatchObject({ op: "write", mode: 0o600, path: "/srv/a.tar" });
		host.send({ type: "result", id: call.id, result: {} });
		const { stream, size } = await opening;
		expect(size).toBeUndefined();
		stream.write(encode("abc"));
		// An empty chunk is not the end: only `finish` is.
		stream.write(new Uint8Array(0));
		stream.write(encode("de"));
		stream.finish();
		expect(host.frames()).toEqual([
			[params.stream, 3, "abc"],
			[params.stream, 2, "de"],
			[params.stream, 0, ""],
		]);
		host.send({ type: "stream.close", stream: params.stream, reason: "error refused: read-only file system" });
		expect(ends).toEqual(["error refused: read-only file system"]);
		// Ended: neither bytes nor an end go out any more.
		stream.write(encode("more"));
		stream.finish();
		expect(host.binary).toHaveLength(3);
	});

	it("tells the host when Kantel closes one, and forgets one the host refuses to open", async () => {
		const hub = hubWith();
		const host = attach(hub, "host_a");
		await host.welcomed();
		const { data, ends, sink } = keeping();
		const opening = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/a", op: "read" }, sink);
		const call = await host.called("sandbox.files.open");
		const stream = (call.params as HostFileOpen).stream;
		host.send({ type: "result", id: call.id, result: { size: 1 } });
		(await opening).stream.close();
		expect(host.sent.at(-1)).toEqual({ type: "stream.close", stream, reason: "closed by the client" });
		host.receive(encodeStreamFrame(stream, encode("x")));
		expect(data).toEqual([]);

		const refused = keeping();
		const missing = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/missing", op: "read" }, refused.sink);
		// The call goes out as `openFile` is called.
		const second = host.sent.filter((message) => message.method === "sandbox.files.open").at(-1);
		expect(second?.id).not.toBe(call.id);
		const refusedStream = (second?.params as HostFileOpen | undefined)?.stream ?? 0;
		host.send({ type: "result", id: second?.id, error: { code: "not_found", message: "no such file" } });
		await expect(missing).rejects.toSatisfy((error) => error instanceof HostCallError && error.code === "not_found");
		host.receive(encodeStreamFrame(refusedStream, encode("x")));
		host.send({ type: "stream.close", stream: refusedStream, reason: "ok 1" });
		expect([refused.data, refused.ends, ends]).toEqual([[], [], []]);
	});

	it("ends an open stream when the host goes", async () => {
		const hub = hubWith();
		const host = attach(hub, "host_a");
		await host.welcomed();
		const { ends, sink } = keeping();
		const opening = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/a", op: "write" }, sink);
		const call = await host.called("sandbox.files.open");
		host.send({ type: "result", id: call.id, result: {} });
		await opening;
		host.closed("gone");
		expect(ends).toEqual(["the host disconnected"]);
	});

	it("waits to write while the host's socket holds too much, and not when it can't tell", async () => {
		let buffered = FILE_STREAM_BUFFER_BYTES;
		const hub = hubWith();
		const host = attach(hub, "host_a", () => buffered);
		await host.welcomed();
		const opening = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/a", op: "write" }, keeping().sink);
		const call = await host.called("sandbox.files.open");
		host.send({ type: "result", id: call.id, result: {} });
		const { stream } = await opening;
		let drained = false;
		const draining = stream.drained().then(() => {
			drained = true;
		});
		await pause(40);
		expect(drained).toBe(false);
		buffered = FILE_STREAM_BUFFER_BYTES - 1;
		await draining;
		expect(drained).toBe(true);

		// A stream that ends while its writer waits lets the writer go.
		buffered = FILE_STREAM_BUFFER_BYTES * 2;
		const waiting = stream.drained();
		host.send({ type: "stream.close", stream: stream.stream, reason: "error unavailable: the disk is full" });
		await waiting;

		// A socket that can't tell: at once.
		const blind = hubWith();
		const other = attach(blind, "host_b");
		await other.welcomed();
		const blindOpening = blind.openFile("host_b", { sandboxId: "sbx_b", path: "/b", op: "write" }, keeping().sink);
		const blindCall = await other.called("sandbox.files.open");
		other.send({ type: "result", id: blindCall.id, result: {} });
		await (await blindOpening).stream.drained();
	});

	it("keeps a write only FILE_STREAM_WINDOW_BYTES ahead of what the host acks, whatever the socket says", async () => {
		// A socket that says nothing is waiting, as Bun's ws can while a send is queued.
		const hub = hubWith();
		const host = attach(hub, "host_a", () => 0);
		await host.welcomed();
		const opening = hub.openFile("host_a", { sandboxId: "sbx_a", path: "/a", op: "write" }, keeping().sink);
		const call = await host.called("sandbox.files.open");
		host.send({ type: "result", id: call.id, result: {} });
		const { stream } = await opening;
		const chunk = new Uint8Array(FILE_STREAM_WINDOW_BYTES / 2);
		stream.write(chunk);
		await stream.drained();
		stream.write(chunk);
		let drained = false;
		const draining = stream.drained().then(() => {
			drained = true;
		});
		await pause(40);
		expect(drained).toBe(false);
		// An ack for another stream, or one that says less, doesn't let it go.
		host.send({ type: "stream.ack", stream: stream.stream + 1, acked: FILE_STREAM_WINDOW_BYTES });
		host.send({ type: "stream.ack", stream: stream.stream, acked: 0 });
		await pause(20);
		expect(drained).toBe(false);
		host.send({ type: "stream.ack", stream: stream.stream, acked: 1 });
		await draining;
		expect(drained).toBe(true);

		// Once the stream has ended, an ack for it is dropped, and its writer isn't held.
		stream.write(chunk);
		stream.write(chunk);
		host.send({ type: "stream.close", stream: stream.stream, reason: "ok 0" });
		host.send({ type: "stream.ack", stream: stream.stream, acked: FILE_STREAM_WINDOW_BYTES * 2 });
		await stream.drained();
	});
});

describe("the hub's bucket.fetch", () => {
	it("answers through `bucketSource` for the connection's own host, whatever the host names", async () => {
		const bucketSource = vi.fn(async (_hostId: string, sandboxId: string, id: string) =>
			sandboxId === "sbx_mine" && id === "bks_1" ? SOURCE : undefined,
		);
		const host = attach(hubWith({ bucketSource }), "host_a");
		const ask = (id: string, params: unknown) => host.send({ type: "call", id, method: "bucket.fetch", params });
		await host.welcomed();
		ask("h1", { sandboxId: "sbx_mine", bucketSourceId: "bks_1", hostId: "host_b" });
		expect(await host.result("h1")).toEqual({ type: "result", id: "h1", result: SOURCE });
		expect(bucketSource).toHaveBeenCalledWith("host_a", "sbx_mine", "bks_1");

		ask("h2", { sandboxId: "sbx_mine", bucketSourceId: "bks_2" });
		expect((await host.result("h2")).error?.code).toBe("not_found");
		ask("h3", { sandboxId: "sbx_mine" });
		expect((await host.result("h3")).error?.code).toBe("not_found");
		ask("h4", null);
		expect((await host.result("h4")).error?.code).toBe("not_found");
		expect(bucketSource).toHaveBeenCalledTimes(2);
	});

	it("answers unavailable, without the reason, when the source fails or there is none to ask", async () => {
		const failing = attach(
			hubWith({
				bucketSource: async () => {
					throw new Error("could not open s3cr3t");
				},
			}),
			"host_a",
		);
		await failing.welcomed();
		failing.send({ type: "call", id: "h1", method: "bucket.fetch", params: { sandboxId: "s", bucketSourceId: "b" } });
		const failed = await failing.result("h1");
		expect(failed.error?.code).toBe("unavailable");
		expect(JSON.stringify(failed)).not.toContain("s3cr3t");

		const none = attach(hubWith(), "host_b");
		await none.welcomed();
		none.send({ type: "call", id: "h1", method: "bucket.fetch", params: { sandboxId: "s", bucketSourceId: "b" } });
		expect((await none.result("h1")).error?.code).toBe("unavailable");
	});
});

/** A hosts service with one host joined (not yet connected) and a backend over it. */
async function setup(features?: readonly string[]) {
	const service = createHostsService({
		store: createMemoryHostStore(),
		publicUrl: "https://kantel.test",
		log: () => undefined,
	});
	services.push(service);
	const token = await service.createJoinToken({ name: "box" });
	const { hostId, credential } = await service.register({ token: token.token, facts: facts() });
	const host = new FakeHost(service, hostId, features);
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const link = (more: Partial<HostComputeLink> = {}) =>
		service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined, ...more });
	return {
		service,
		host,
		hostId,
		credential,
		backend,
		link,
		/** Connects the host and waits for its welcome (its features are recorded by then). */
		async connect() {
			host.connect();
			await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		},
	};
}

describe("a host's calls and events about mounts, through the service", () => {
	it("answers bucket.fetch from the compute plane's link, and unavailable without it", async () => {
		const { host, hostId, link, connect } = await setup();
		await connect();
		const answerTo = (id: string) =>
			vi.waitFor(() => {
				const found = host.sent.find((message) => message.type === "result" && message.id === id);
				if (found === undefined) throw new Error(`No answer to ${id} yet`);
				return found;
			});
		const ask = (id: string, sandboxId: string) =>
			host.send({ type: "call", id, method: "bucket.fetch", params: { sandboxId, bucketSourceId: "bks_1" } });
		ask("h1", "sbx_a");
		expect((await answerTo("h1")).error?.code).toBe("unavailable");

		const bucketSource = vi.fn(async (_hostId: string, sandboxId: string, _id: string) =>
			sandboxId === "sbx_a" ? SOURCE : undefined,
		);
		link({ bucketSource });
		ask("h2", "sbx_a");
		expect((await answerTo("h2")).result).toEqual(SOURCE);
		expect(bucketSource).toHaveBeenCalledWith(hostId, "sbx_a", "bks_1");
		ask("h3", "sbx_b");
		expect((await answerTo("h3")).error?.code).toBe("not_found");
	});

	it("hands a sandbox.mounts event, checked and clipped, to reportMounts, and drops a malformed one", async () => {
		const { service, host, hostId, link, connect } = await setup([HOST_FEATURES.mountsBundle]);
		await connect();
		const reportMounts = vi.fn(
			async (_hostId: string, _sandboxId: string, _mounts: readonly HostMountStatus[]): Promise<void> => undefined,
		);
		link({ reportMounts });
		host.send({
			type: "event",
			event: {
				kind: "sandbox.mounts",
				at: 1,
				sandboxId: "sbx_a",
				mounts: [
					{ path: "/mnt/skills", status: "ready" },
					{ path: "/mnt/data", status: "failed", error: "x".repeat(2000) },
					{ path: "/mnt/odd", status: "mounted" },
					"junk",
				],
			},
		});
		await vi.waitFor(() => expect(reportMounts).toHaveBeenCalledTimes(1));
		expect(reportMounts).toHaveBeenCalledWith(hostId, "sbx_a", [
			{ path: "/mnt/skills", status: "ready" },
			{ path: "/mnt/data", status: "failed", error: "x".repeat(512) },
		]);

		// More mounts than a sandbox may have, none at all, or no sandbox: dropped.
		const many = Array.from({ length: 17 }, (_, at) => ({ path: `/mnt/${at}`, status: "ready" }));
		host.send({ type: "event", event: { kind: "sandbox.mounts", at: 2, sandboxId: "sbx_a", mounts: many } });
		host.send({ type: "event", event: { kind: "sandbox.mounts", at: 3, sandboxId: "sbx_a", mounts: "ready" } });
		host.send({ type: "event", event: { kind: "sandbox.mounts", at: 4, mounts: [] } });
		// The sandbox as a create answers it, with its mounts, is taken too.
		host.send({
			type: "event",
			event: {
				kind: "sandbox.mounts",
				at: 5,
				sandbox: {
					id: "sbx_b",
					tier: "microvm",
					size: "default",
					state: "running",
					createdAt: 1,
					mounts: [{ path: "/mnt/skills", status: "pending" }],
				},
			},
		});
		await vi.waitFor(() => expect(reportMounts).toHaveBeenCalledTimes(2));
		expect(reportMounts).toHaveBeenLastCalledWith(hostId, "sbx_b", [{ path: "/mnt/skills", status: "pending" }]);

		// One that fails to keep is no reason to drop the host.
		reportMounts.mockRejectedValueOnce(new Error("the store is down"));
		host.send({ type: "event", event: { kind: "sandbox.mounts", at: 6, sandboxId: "sbx_a", mounts: null } });
		await vi.waitFor(() => expect(reportMounts).toHaveBeenCalledTimes(3));
		expect(reportMounts).toHaveBeenLastCalledWith(hostId, "sbx_a", []);
		await pause(5);
		expect(service.hub.connected(hostId)).toBe(true);
	});
});

describe("the bundle route", () => {
	it("streams a bundle's tar to the host whose credential asks, for its sandbox that mounts it", async () => {
		const { service, hostId, credential, link } = await setup();
		const api = createHostsApi({
			hosts: service,
			authorizeAdmin: async () => {
				throw new Error("not for this route");
			},
		});
		const get = (path: string, token?: string, method = "GET") =>
			api.fetch(
				new Request(`https://k.example${path}`, {
					method,
					...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
				}),
			);
		const url = `${HOSTS_BUNDLES_PATH}/${DIGEST}?sandboxId=sbx_a`;

		// Before the compute plane is linked: unavailable.
		expect((await get(url, credential))?.status).toBe(503);

		const bundle = vi.fn(async (_hostId: string, sandboxId: string, digest: string) =>
			sandboxId === "sbx_a" && digest === DIGEST ? { sizeBytes: 11, body: streamOf("hello ", "world") } : undefined,
		);
		link({ bundle });
		expect((await get(url))?.status).toBe(401);
		expect((await get(url, "khc_wrong"))?.status).toBe(401);
		expect(bundle).not.toHaveBeenCalled();

		const answer = await get(url, credential);
		expect(answer?.status).toBe(200);
		expect(answer?.headers.get("content-type")).toBe("application/x-tar");
		expect(answer?.headers.get("content-length")).toBe("11");
		expect(answer?.headers.get("cache-control")).toBe("no-store");
		expect(await answer?.text()).toBe("hello world");
		expect(bundle).toHaveBeenCalledWith(hostId, "sbx_a", DIGEST);
		// The colon may come escaped.
		const escaped = await get(`${HOSTS_BUNDLES_PATH}/${DIGEST.replace(":", "%3A")}?sandboxId=sbx_a`, credential);
		expect(escaped?.status).toBe(200);

		const missing = await get(`${HOSTS_BUNDLES_PATH}/${DIGEST}?sandboxId=sbx_other`, credential);
		expect(missing?.status).toBe(404);
		expect(((await missing?.json()) as { error: { code: string } } | undefined)?.error.code).toBe("not_found");
		expect((await get(`${HOSTS_BUNDLES_PATH}/sha256:abc?sandboxId=sbx_a`, credential))?.status).toBe(400);
		expect((await get(`${HOSTS_BUNDLES_PATH}/${DIGEST}`, credential))?.status).toBe(400);
		expect((await get(url, credential, "POST"))?.status).toBe(405);

		// A revoked host's credential no longer reaches it.
		await service.revoke(hostId);
		expect((await get(url, credential))?.status).toBe(401);
	});
});

const BUNDLE: BackendMount = { path: "/mnt/skills", source: { kind: "bundle", digest: DIGEST } };
const BUCKET: BackendMount = {
	path: "/mnt/data",
	source: { kind: "bucket", bucketSourceId: "bks_1", prefix: "org/42/", refreshTtlSeconds: 60 },
};
const spec = (sandboxId: string, hostId: string, mounts?: readonly BackendMount[]): SandboxSpec => ({
	sandboxId,
	accountId: "acc_1",
	type: "microvm",
	subdomain: sandboxId,
	env: {},
	eligibleHosts: [hostId],
	...(mounts === undefined ? {} : { mounts }),
});

describe("the backend's mounts", () => {
	it("sends a host that can't mount none, and answers them failed, saying why", async () => {
		const { host, hostId, backend, connect } = await setup();
		await connect();
		const placement = await backend.create(spec("sbx_one", hostId, [BUNDLE, BUCKET]));
		expect(placement.mounts).toEqual([
			{ path: "/mnt/skills", status: "failed", error: "This host can't mount bundles yet" },
			{ path: "/mnt/data", status: "failed", error: "This host can't mount buckets yet" },
		]);
		expect(host.calls.find((call) => call.method === "sandbox.create")?.params.mounts).toBeUndefined();
		// No mounts: none in the placement either.
		expect((await backend.create(spec("sbx_two", hostId))).mounts).toBeUndefined();
	});

	it("sends a host the kinds it can mount, pending until it says, and failed for the rest", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.mountsBundle]);
		await connect();
		const placement = await backend.create(spec("sbx_one", hostId, [BUNDLE, BUCKET]));
		expect(host.calls.find((call) => call.method === "sandbox.create")?.params.mounts).toEqual([
			{ path: "/mnt/skills", kind: "bundle", digest: DIGEST },
		]);
		expect(placement.mounts).toEqual([
			{ path: "/mnt/skills", status: "pending" },
			{ path: "/mnt/data", status: "failed", error: "This host can't mount buckets yet" },
		]);
	});

	it("takes the statuses a host answers, on create, start and fork alike", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.mountsBundle, HOST_FEATURES.mountsBucket]);
		await connect();
		host.mountStatus = (mounts) => mounts.map((mount) => ({ path: mount.path, status: "ready" }));
		const created = await backend.create(spec("sbx_one", hostId, [BUNDLE, BUCKET]));
		expect(host.calls.find((call) => call.method === "sandbox.create")?.params.mounts).toEqual([
			{ path: "/mnt/skills", kind: "bundle", digest: DIGEST },
			{ path: "/mnt/data", kind: "bucket", bucketSourceId: "bks_1", prefix: "org/42/", refreshTtlSeconds: 60 },
		]);
		expect(created.mounts).toEqual([
			{ path: "/mnt/skills", status: "ready" },
			{ path: "/mnt/data", status: "ready" },
		]);

		// A boot mounts them again; a status the host doesn't give is pending.
		host.mountStatus = () => [{ path: "/mnt/skills", status: "failed", error: "The tar is corrupt" }];
		const started = await backend.start("sbx_one", { env: {}, eligibleHosts: [hostId], mounts: [BUNDLE, BUCKET] });
		expect(host.calls.filter((call) => call.method === "sandbox.start").at(-1)?.params.mounts).toHaveLength(2);
		expect(started.mounts).toEqual([
			{ path: "/mnt/skills", status: "failed", error: "The tar is corrupt" },
			{ path: "/mnt/data", status: "pending" },
		]);
		// A boot without mounts sends none.
		const plain = await backend.resume("sbx_one", { env: {}, eligibleHosts: [hostId] });
		expect(host.calls.filter((call) => call.method === "sandbox.resume").at(-1)?.params.mounts).toBeUndefined();
		expect(plain.mounts).toBeUndefined();

		host.mountStatus = (mounts) => mounts.map((mount) => ({ path: mount.path, status: "ready" }));
		const [forked] = await backend.fork({ sandboxId: "sbx_one" }, [spec("sbx_two", hostId, [BUNDLE])]);
		expect(host.calls.find((call) => call.method === "sandbox.fork")?.params.mounts).toEqual([
			{ path: "/mnt/skills", kind: "bundle", digest: DIGEST },
		]);
		expect(forked?.mounts).toEqual([{ path: "/mnt/skills", status: "ready" }]);
	});
});

describe("the backend's file streams", () => {
	const read = (backend: SandboxBackend, sandboxId: string, path: string) => {
		if (backend.readFileStream === undefined) throw new Error("The backend streams no files");
		return backend.readFileStream(sandboxId, path);
	};
	const write = (backend: SandboxBackend, sandboxId: string, path: string, body: ReadableStream<Uint8Array>) => {
		if (backend.writeFileStream === undefined) throw new Error("The backend streams no files");
		return backend.writeFileStream(sandboxId, path, body, 0o640);
	};

	it("are not_supported on a host without file-streams, so the service falls back", async () => {
		const { host, hostId, backend, connect } = await setup();
		await connect();
		await backend.create(spec("sbx_one", hostId));
		host.files.set("/home/user/a.txt", encode("hello"));
		expect((await failure(read(backend, "sbx_one", "/home/user/a.txt"))).code).toBe("not_supported");
		expect((await failure(write(backend, "sbx_one", "/home/user/b.txt", streamOf("x")))).code).toBe("not_supported");
		expect(host.calls.some((call) => call.method === "sandbox.files.open")).toBe(false);
	});

	it("leave a write the host's message limit can't hold unsent, refused, and send one that fits", async () => {
		const { host, hostId, backend, connect } = await setup();
		await connect();
		await backend.create(spec("sbx_one", hostId));
		// Its base64 alone would pass the host's message limit, so the host would drop its whole link.
		expect(Math.ceil(HOST_WRITE_FILE_MAX_BYTES / 3) * 4).toBeLessThan(HOST_MESSAGE_LIMIT_BYTES - 1024 * 1024 + 4);
		const big = new Uint8Array(HOST_WRITE_FILE_MAX_BYTES + 1);
		const refused = await failure(backend.writeFile("sbx_one", "/home/user/big.bin", big));
		expect(refused.code).toBe("invalid");
		expect(host.calls.some((call) => call.method === "sandbox.files.write")).toBe(false);
		// One that fits is sent (this fake host doesn't keep it).
		await backend.writeFile("sbx_one", "/home/user/small.txt", encode("fits")).catch(() => undefined);
		expect(host.calls.some((call) => call.method === "sandbox.files.write")).toBe(true);
	});

	it("read a file's bytes as they come, and refuse a missing one", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		host.files.set("/home/user/a.txt", encode("hello, world"));
		const { size, body } = await read(backend, "sbx_one", "/home/user/a.txt");
		expect(size).toBe(12);
		expect(await new Response(body).text()).toBe("hello, world");
		expect(host.calls.find((call) => call.method === "sandbox.files.open")?.params).toMatchObject({
			sandboxId: "sbx_one",
			path: "/home/user/a.txt",
			op: "read",
		});
		expect((await failure(read(backend, "sbx_one", "/home/user/missing"))).code).toBe("not_found");
	});

	it("read a file larger than the window only as fast as the reader takes it", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		host.chunkBytes = 64 * 1024;
		await connect();
		await backend.create(spec("sbx_one", hostId));
		const big = new Uint8Array(FILE_STREAM_WINDOW_BYTES * 3).map((_, index) => index % 251);
		host.files.set("/home/user/big", big);
		const { size, body } = await read(backend, "sbx_one", "/home/user/big");
		expect(size).toBe(big.byteLength);
		// Nobody reads: the host has sent its window and waits.
		await pause(20);
		const [[stream, waiting] = [0, { sent: 0, acked: 0 }]] = [...host.reads];
		expect(waiting.sent).toBe(FILE_STREAM_WINDOW_BYTES);
		// A little read: acked once a part's worth is taken, and the host goes on by as much.
		const reader = body.getReader();
		let got = 0;
		while (got < FILE_STREAM_ACK_BYTES) got += (await reader.read()).value?.byteLength ?? 0;
		await pause(20);
		expect(host.reads.get(stream)?.acked).toBe(got);
		expect(host.reads.get(stream)?.sent).toBe(got + FILE_STREAM_WINDOW_BYTES);
		// The rest, whole.
		const chunks: Uint8Array[] = [];
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			chunks.push(next.value);
		}
		expect(got + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(big.byteLength);
		expect(host.reads.size).toBe(0);
	});

	it("end a read whose host sends past its window or in too large a frame, keeping none of it", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		host.chunkBytes = 64 * 1024;
		host.ignoreWindow = true;
		await connect();
		await backend.create(spec("sbx_one", hostId));
		host.files.set("/home/user/big", new Uint8Array(FILE_STREAM_WINDOW_BYTES * 4));
		// Nobody reads, and the host goes on sending anyway: the gateway keeps no more than its window of it.
		const { body } = await read(backend, "sbx_one", "/home/user/big");
		await pause(20);
		const refused = await new Response(body).arrayBuffer().catch((error: unknown) => error);
		expect((refused as KantelError).code).toBe("unavailable");

		// One frame larger than any a host sends.
		host.ignoreWindow = false;
		host.chunkBytes = FILE_STREAM_FRAME_MAX_BYTES + 1;
		const second = await read(backend, "sbx_one", "/home/user/big");
		const failed = await new Response(second.body).arrayBuffer().catch((error: unknown) => error);
		expect((failed as KantelError).code).toBe("unavailable");

		// A host within its window, in frames of at most the largest, reads whole.
		host.chunkBytes = FILE_STREAM_FRAME_MAX_BYTES;
		const third = await read(backend, "sbx_one", "/home/user/big");
		expect((await new Response(third.body).arrayBuffer()).byteLength).toBe(FILE_STREAM_WINDOW_BYTES * 4);
	});

	it("cancel a read the reader drops, and pass on a host's error", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		host.chunkBytes = 64 * 1024;
		await connect();
		await backend.create(spec("sbx_one", hostId));
		host.files.set("/home/user/big", new Uint8Array(FILE_STREAM_WINDOW_BYTES * 2));
		const { body } = await read(backend, "sbx_one", "/home/user/big");
		await body.cancel();
		const opened = host.calls.find((call) => call.method === "sandbox.files.open")?.params as unknown as HostFileOpen;
		expect(host.aborted).toContain(opened.stream);
		expect(host.reads.size).toBe(0);

		const second = await read(backend, "sbx_one", "/home/user/big");
		const [[stream] = [0]] = [...host.reads];
		host.reads.delete(stream);
		host.send({ type: "stream.close", stream, reason: "error not_found: it went" });
		const refused = await new Response(second.body).arrayBuffer().catch((error: unknown) => error);
		expect((refused as KantelError).code).toBe("not_found");
	});

	it("extract an archive with the host's own code, on a host that can, and refuse otherwise", async () => {
		const old = await setup([HOST_FEATURES.fileStreams]);
		await old.connect();
		await old.backend.create(spec("sbx_one", old.hostId));
		const refused = await failure(
			old.backend.extractArchive?.("sbx_one", "/tmp/a.tar", "/home/user/work") ?? Promise.resolve(),
		);
		expect(refused.code).toBe("not_supported");
		expect(old.host.calls.some((call) => call.method === "sandbox.files.extract")).toBe(false);

		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams, HOST_FEATURES.filesExtract]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		await backend.extractArchive?.("sbx_one", "/tmp/a.tar", "/home/user/work");
		expect(host.extracts).toEqual([{ archive: "/tmp/a.tar", target: "/home/user/work" }]);
		// Never a command.
		expect(host.calls.some((call) => call.method === "sandbox.exec")).toBe(false);
		// And the host a sandbox is placed on, as the scheduler recorded it.
		expect(await backend.placedOn?.("sbx_one")).toBe(hostId);
		expect(await backend.placedOn?.("sbx_none")).toBeUndefined();
	});

	it("write a body through, and answer the size the host says it wrote", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		expect(await write(backend, "sbx_one", "/home/user/b.txt", streamOf("abc", "", "defg"))).toEqual({ size: 7 });
		expect(decode(host.files.get("/home/user/b.txt") ?? new Uint8Array(0))).toBe("abcdefg");
		expect(host.calls.find((call) => call.method === "sandbox.files.open")?.params).toMatchObject({
			path: "/home/user/b.txt",
			op: "write",
			mode: 0o640,
		});
	});

	it("waits for the host's socket to drain before each chunk", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		let buffered = FILE_STREAM_BUFFER_BYTES;
		host.buffered = () => buffered;
		await connect();
		await backend.create(spec("sbx_one", hostId));
		const writing = write(backend, "sbx_one", "/home/user/c.txt", streamOf("abc"));
		await pause(40);
		expect(host.files.has("/home/user/c.txt")).toBe(false);
		buffered = 0;
		expect(await writing).toEqual({ size: 3 });
	});

	it("write a file larger than the window as the host acks it, and wait while it doesn't", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		const piece = "x".repeat(1024 * 1024);
		const pieces = Array.from({ length: (FILE_STREAM_WINDOW_BYTES * 3) / piece.length }, () => piece);
		expect(await write(backend, "sbx_one", "/home/user/big", streamOf(...pieces))).toEqual({
			size: FILE_STREAM_WINDOW_BYTES * 3,
		});
		expect(host.files.get("/home/user/big")?.byteLength).toBe(FILE_STREAM_WINDOW_BYTES * 3);

		host.holdAcks = true;
		const writing = write(backend, "sbx_one", "/home/user/held", streamOf(...pieces));
		await pause(40);
		const [[stream, held] = [0, { chunks: [] }]] = [...host.writes];
		expect(held.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(FILE_STREAM_WINDOW_BYTES);
		host.send({ type: "stream.ack", stream, acked: FILE_STREAM_WINDOW_BYTES * 3 });
		host.holdAcks = false;
		expect(await writing).toEqual({ size: FILE_STREAM_WINDOW_BYTES * 3 });
	});

	it("throw the host's error, its code when it is Kantel's", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		host.writeFailure = "refused: read-only file system";
		const refused = await failure(write(backend, "sbx_one", "/mnt/skills/a", streamOf("abc")));
		expect([refused.code, refused.message]).toEqual(["refused", "read-only file system"]);
		host.writeFailure = "eio: the disk failed";
		const odd = await failure(write(backend, "sbx_one", "/home/user/a", streamOf("abc")));
		expect([odd.code, odd.message]).toEqual(["unavailable", "the disk failed"]);
		expect(host.files.size).toBe(0);
	});

	it("stop waiting on the body when the host ends the write, and cancel the body", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		let cancelled = false;
		// A client that sends a little, then nothing more for as long as it likes.
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encode("abc"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const writing = write(backend, "sbx_one", "/home/user/e.txt", stalled);
		await pause(20);
		const [[stream] = [0]] = [...host.writes];
		host.writes.delete(stream);
		host.send({ type: "stream.close", stream, reason: "error refused: the disk is full" });
		const refused = await failure(writing);
		expect([refused.code, refused.message]).toEqual(["refused", "the disk is full"]);
		expect(cancelled).toBe(true);
		expect(host.files.has("/home/user/e.txt")).toBe(false);
	});

	it("abort the stream when the body fails, so nothing is put in place", async () => {
		const { host, hostId, backend, connect } = await setup([HOST_FEATURES.fileStreams]);
		await connect();
		await backend.create(spec("sbx_one", hostId));
		let pulled = 0;
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled === 1) controller.enqueue(encode("abc"));
				else controller.error(new Error("the client went away"));
			},
		});
		await expect(write(backend, "sbx_one", "/home/user/d.txt", failing)).rejects.toThrow("the client went away");
		const opened = host.calls.find((call) => call.method === "sandbox.files.open")?.params as unknown as HostFileOpen;
		expect(host.aborted).toContain(opened.stream);
		expect(host.files.has("/home/user/d.txt")).toBe(false);
	});
});

describe("fileStreamEnd", () => {
	it("reads a host's end reasons", () => {
		expect(fileStreamEnd("ok 12")).toEqual({ size: 12 });
		const notFound = fileStreamEnd("error not_found: no such file");
		expect(isKantelError(notFound, "not_found") && notFound.message).toBe("no such file");
		expect(isKantelError(fileStreamEnd("error eio: bad"), "unavailable")).toBe(true);
		expect(isKantelError(fileStreamEnd("the host disconnected"), "unavailable")).toBe(true);
		expect(isKantelError(fileStreamEnd("closed by the sandbox"), "unavailable")).toBe(true);
	});
});
