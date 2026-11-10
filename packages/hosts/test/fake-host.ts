// A host as kantel-host behaves, for tests: it speaks the protocol over a hub and answers calls from a table of
// sandboxes, with an echo server on every port, and a table of files it streams with `sandbox.files.open`.
import type { AcceptedHost } from "../src/hub.ts";
import {
	decodeStreamFrame,
	encodeStreamFrame,
	FILE_STREAM_WINDOW_BYTES,
	type HostFacts,
	type HostFileOpen,
	type HostMessage,
	type HostMount,
	type HostMountStatus,
	type HostSandbox,
} from "../src/protocol.ts";
import type { HostsService } from "../src/service.ts";

export const facts = (labels: { [key: string]: string } = {}, features?: readonly string[]): HostFacts => ({
	version: "0.1.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "h",
	cpus: 16,
	memoryMiB: 32_768,
	diskGiB: 500,
	kvm: true,
	nested: true,
	tiers: ["microvm", "isolate"],
	sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
	egress: "proxy",
	labels,
	...(features === undefined ? {} : { features }),
});

/** A host as kantel-host behaves: it answers calls from a table of sandboxes. */
export class FakeHost {
	readonly sent: HostMessage[] = [];
	readonly binary: Uint8Array[] = [];
	readonly sandboxes = new Map<string, HostSandbox>();
	/** What `snapshot.list` answers. */
	snapshots: {
		readonly id: string;
		readonly sandboxId: string;
		readonly base?: string;
		readonly sizeBytes?: number;
		readonly uniqueBytes?: number;
	}[] = [];
	/** What `snapshot.list` answers beside them: the files several share, by holder. */
	shared: { readonly snapshots: readonly string[]; readonly bytes: number }[] = [];
	closedWith: { code: number; reason: string } | undefined;
	connection!: AcceptedHost;
	freeMemoryMiB = 20_000;
	/** Every call's method and params, as sent. */
	readonly calls: { readonly method: string; readonly params: { readonly [key: string]: unknown } }[] = [];
	/** For a test: a call of a method it answers a promise for is answered once that settles (a slow host). */
	hold?: (method: string) => Promise<void> | undefined;
	/** Files `sandbox.files.open` streams, by path; a write lands here once all of it has arrived. */
	readonly files = new Map<string, Uint8Array>();
	/** How many bytes a read's frames carry each. */
	chunkBytes = 4;
	/** For a test: a write ends with `error <this>` instead of landing. */
	writeFailure?: string;
	/** Writes under way, by stream: their path and what has arrived. */
	readonly writes = new Map<number, { readonly path: string; readonly chunks: Uint8Array[] }>();
	/** Streams Kantel closed (`stream.close` from Kantel). */
	readonly aborted: number[] = [];
	/** For a test: what a create, fork, start or resume answers of the mounts it was sent; absent, nothing. */
	mountStatus?: (mounts: readonly HostMount[]) => HostMountStatus[];
	/** For a test: the `mountsAt` answered with them; absent, none (a host too old to say). */
	mountsAt?: number;
	/** For a test: the socket's buffered bytes, as a WebSocket reports them; absent, it can't tell. */
	buffered?: () => number;
	/** For a test: a write's bytes aren't acked (`stream.ack`) as they arrive, as from a sandbox that takes none. */
	holdAcks = false;
	/** For a test: a read sends all of its file at once, past its window, as a host that ignores acks would. */
	ignoreWindow = false;
	/** Reads under way, by stream: what is still to send, and how much Kantel's reader has acked. */
	readonly reads = new Map<number, { readonly data: Uint8Array; sent: number; acked: number }>();
	/** `sandbox.files.extract` calls: the archive, the target. */
	readonly extracts: { readonly archive: string; readonly target: string }[] = [];
	/** How a create is answered as served (`HostSandbox.source`): `boot` for a template snapshot it couldn't restore. */
	createSource = "pool";
	/** For a test: the size a create is answered as made, instead of the one asked for (a restore's own size). */
	madeSize?: string;
	/** For a test: a call of a method it answers an error for fails with it. */
	refuse?: (method: string) => { readonly code: string; readonly message: string } | undefined;
	/** For a test: what a call of a method it answers a result for is answered, instead of the usual. */
	answer?: (method: string) => unknown;
	/** Facts it reports beyond the usual: its Firecracker and guest kernel, say. */
	moreFacts: Partial<HostFacts> = {};

	constructor(
		readonly service: HostsService,
		readonly hostId: string,
		/** What it reports doing beyond protocol 1 as first released; absent, an older host's report. */
		readonly features?: readonly string[],
	) {}

	connect(held: HostSandbox[] = []) {
		for (const sandbox of held) this.sandboxes.set(sandbox.id, sandbox);
		this.connection = this.service.hub.accept(this.hostId, {
			sendText: (text) => this.onText(JSON.parse(text) as HostMessage),
			sendBinary: (bytes) => this.onBinary(bytes),
			close: (code, reason) => {
				this.closedWith = { code, reason };
			},
			...(this.buffered === undefined ? {} : { bufferedAmount: () => this.buffered?.() ?? 0 }),
		});
		this.send({
			type: "hello",
			hello: {
				hostId: this.hostId,
				facts: { ...facts({}, this.features), ...this.moreFacts },
				sandboxes: [...this.sandboxes.values()],
				capacity: {
					freeMemoryMiB: this.freeMemoryMiB,
					freeDiskGiB: 400,
					running: 0,
					stopped: 0,
					load1: 0.1,
				},
			},
		});
	}

	send(message: object) {
		this.connection.receive(JSON.stringify(message));
	}

	welcomed() {
		return this.sent.some((message) => message.type === "welcome");
	}

	private onBinary(bytes: Uint8Array) {
		this.binary.push(bytes);
		const frame = decodeStreamFrame(bytes);
		const write = frame === undefined ? undefined : this.writes.get(frame.stream);
		if (frame !== undefined && write !== undefined) {
			if (frame.payload.byteLength > 0) {
				write.chunks.push(frame.payload.slice());
				if (!this.holdAcks) {
					const acked = write.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
					this.send({ type: "stream.ack", stream: frame.stream, acked });
				}
				return;
			}
			// The empty frame: all of it has arrived.
			this.writes.delete(frame.stream);
			if (this.writeFailure !== undefined) {
				this.send({ type: "stream.close", stream: frame.stream, reason: `error ${this.writeFailure}` });
				return;
			}
			const size = write.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
			const whole = new Uint8Array(size);
			let at = 0;
			for (const chunk of write.chunks) {
				whole.set(chunk, at);
				at += chunk.byteLength;
			}
			this.files.set(write.path, whole);
			this.send({ type: "stream.close", stream: frame.stream, reason: `ok ${size}` });
			return;
		}
		// An echo server on the port.
		if (frame !== undefined && frame.payload.byteLength > 0) {
			this.connection.receive(
				encodeStreamFrame(frame.stream, new TextEncoder().encode(`echo:${new TextDecoder().decode(frame.payload)}`)),
			);
		}
	}

	private onText(message: HostMessage) {
		this.sent.push(message);
		if (message.type === "stream.close" && typeof message.stream === "number") {
			// An abort: a write under way is dropped, nothing put in place.
			this.writes.delete(message.stream);
			this.reads.delete(message.stream);
			this.aborted.push(message.stream);
			return;
		}
		if (message.type === "stream.ack" && typeof message.stream === "number") {
			const read = this.reads.get(message.stream);
			if (read !== undefined && typeof message.acked === "number") {
				read.acked = Math.max(read.acked, message.acked);
				this.sendRead(message.stream);
			}
			return;
		}
		if (message.type !== "call") return;
		this.calls.push({ method: message.method ?? "", params: message.params as { [key: string]: unknown } });
		const wait = this.hold?.(message.method ?? "");
		if (wait !== undefined) {
			void wait.then(() => this.answerCall(message));
			return;
		}
		this.answerCall(message);
	}

	/** Sends what a read's window allows, as kantel-host does, and ends it once all is sent. */
	private sendRead(stream: number) {
		const read = this.reads.get(stream);
		if (read === undefined) return;
		while (
			read.sent < read.data.byteLength &&
			(this.ignoreWindow || read.sent - read.acked < FILE_STREAM_WINDOW_BYTES) &&
			this.reads.has(stream)
		) {
			const take = Math.min(this.chunkBytes, read.data.byteLength - read.sent);
			this.connection.receive(encodeStreamFrame(stream, read.data.subarray(read.sent, read.sent + take)));
			read.sent += take;
		}
		if (read.sent < read.data.byteLength) return;
		this.reads.delete(stream);
		this.send({ type: "stream.close", stream, reason: `ok ${read.data.byteLength}` });
	}

	private answerCall(message: HostMessage) {
		const params = message.params as {
			sandboxId: string;
			tier?: string;
			size?: string;
			vcpus?: number;
			memoryMiB?: number;
			diskGiB?: number;
			newId?: string;
			mounts?: HostMount[];
		};
		const answer = (result: unknown) => this.send({ type: "result", id: message.id, result });
		const fail = (code: string, text: string) =>
			this.send({ type: "result", id: message.id, error: { code, message: text } });
		/** A sandbox as answered: with its mounts' statuses when the test reports them. */
		const withMounts = (sandbox: HostSandbox): HostSandbox =>
			this.mountStatus === undefined
				? sandbox
				: {
						...sandbox,
						mounts: this.mountStatus(params.mounts ?? []),
						...(this.mountsAt === undefined ? {} : { mountsAt: this.mountsAt }),
					};
		const refused = this.refuse?.(message.method ?? "");
		if (refused !== undefined) return fail(refused.code, refused.message);
		const answered = this.answer?.(message.method ?? "");
		if (answered !== undefined) return answer(answered);
		switch (message.method) {
			case "sandbox.create":
			case "sandbox.fork": {
				const id = message.method === "sandbox.fork" ? (params.newId as string) : params.sandboxId;
				// As a host answers it: the size it made, asked for by name or as a custom shape's numbers.
				const asked =
					params.size !== undefined && params.size !== ""
						? params.size
						: params.vcpus !== undefined && params.vcpus > 0
							? `custom-${params.vcpus}c-${params.memoryMiB}m-${params.diskGiB}g`
							: "default";
				const sandbox: HostSandbox = {
					id,
					tier: "microvm",
					size: message.method === "sandbox.create" ? (this.madeSize ?? asked) : "default",
					state: "running",
					createdAt: 1,
					source: this.createSource,
				};
				this.sandboxes.set(id, sandbox);
				return answer(withMounts(sandbox));
			}
			case "sandbox.stop": {
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				const stopped = { ...sandbox, state: "stopped" as const, memory: true };
				this.sandboxes.set(sandbox.id, stopped);
				return answer(stopped);
			}
			case "sandbox.start":
			case "sandbox.resume": {
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				const running = { ...sandbox, state: "running" as const };
				this.sandboxes.set(sandbox.id, running);
				return answer(withMounts(running));
			}
			case "sandbox.files.open": {
				const open = message.params as HostFileOpen;
				if (open.op === "write") {
					this.writes.set(open.stream, { path: open.path, chunks: [] });
					return answer({});
				}
				const data = this.files.get(open.path);
				if (data === undefined) return fail("not_found", "no such file");
				answer({ size: data.byteLength });
				this.reads.set(open.stream, { data, sent: 0, acked: 0 });
				return this.sendRead(open.stream);
			}
			case "sandbox.files.extract": {
				const extract = message.params as { archive: string; target: string };
				this.extracts.push({ archive: extract.archive, target: extract.target });
				return answer({});
			}
			case "sandbox.exec": {
				this.send({ type: "event", call: message.id, event: { kind: "exec.output", stdout: btoa("hi\n"), at: 1 } });
				return answer({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 3 });
			}
			case "sandbox.delete":
				this.sandboxes.delete(params.sandboxId);
				return answer({ ok: true });
			case "port.open":
			case "sandbox.egress":
			case "sandbox.env":
				return answer({ ok: true });
			case "sandbox.secrets":
				return answer({});
			case "snapshot.save": {
				const { sandboxId, snapshotId } = params as { sandboxId: string; snapshotId: string };
				if (!this.sandboxes.has(sandboxId)) return fail("not_found", "no such sandbox");
				this.snapshots.push({ id: snapshotId, sandboxId });
				return answer({ id: snapshotId, sandboxId, sizeBytes: 0 });
			}
			case "snapshot.list":
				return answer({
					snapshots: this.snapshots.filter((s) => params.sandboxId === "" || s.sandboxId === params.sandboxId),
					shared: this.shared,
				});
			case "template.build": {
				const build = message.params as { snapshotId: string };
				return answer({ ref: build.snapshotId, imageDigest: "sha256:feed", sizeBytes: 42 });
			}
			case "template.delete":
				return answer({ ok: true });
			default:
				return fail("unsupported", `unknown method ${message.method}`);
		}
	}
}
