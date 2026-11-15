// A host as kantel-host behaves, for tests: it speaks the protocol over a hub and answers calls from a table of
// sandboxes, with an echo server on every port, and a table of files it streams with `sandbox.files.open`.
import type { AcceptedHost } from "../src/hub.ts";
import {
	decodeStreamFrame,
	encodeStreamFrame,
	FILE_STREAM_WINDOW_BYTES,
	type HostError,
	type HostExecResult,
	type HostExecStatus,
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
	/** What its template builds' answers say they were made on (`cpu`, `runtime`); absent, a host from before it said. */
	madeOn?: { readonly [key: string]: unknown };
	/** Every call's method and params, as sent. */
	readonly calls: { readonly method: string; readonly params: { readonly [key: string]: unknown } }[] = [];
	/** For a test: a call of a method it answers a promise for is answered once that settles (a slow host). */
	hold?: (method: string, params: { readonly [key: string]: unknown }) => Promise<void> | undefined;
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
	refuse?: (
		method: string,
		params: { readonly [key: string]: unknown },
	) => { readonly code: string; readonly message: string } | undefined;
	/** For a test: what a call of a method it answers a result for is answered, instead of the usual. */
	answer?: (method: string) => unknown;
	/** Facts it reports beyond the usual: its Firecracker and guest kernel, say. */
	moreFacts: Partial<HostFacts> = {};
	/** What is on each sandbox's disk and sticky drives here, by sandbox, which a move takes with it. */
	readonly disks = new Map<string, string>();
	/** The sandboxes' exports for a move (`sandbox.export`), by `<sandboxId>/<version>`: what was on their disks. */
	readonly exports = new Map<string, string>();
	/** The move each sandbox here was last exported by (`sandbox.export`), which a delete with `exported` must name. */
	readonly exportedBy = new Map<string, string>();
	/** The moves whose import was cancelled here (`sandbox.import.cancel`), by `<sandboxId>/<version>`. */
	readonly cancelled = new Set<string>();
	/** Versions fetched and kept staged here (`sandbox.import` with `stage`), by `<sandboxId>/<version>`: what they hold. */
	readonly staged = new Map<string, string>();
	/**
	 * What each running sandbox here runs (its processes, as a test names them): a start boots it afresh (`booted`), a
	 * resume carries on with what its kept memory ran.
	 */
	readonly processes = new Map<string, string>();
	/** What each sandbox stopped keeping its memory here ran, which a resume carries on with. */
	readonly memories = new Map<string, string>();
	/** The memories exported with a move (`sandbox.export` with `memory`), by `<sandboxId>/<version>`. */
	readonly memoryExports = new Map<string, string>();
	/** The runtime its sandboxes' memory is of, as `sandbox.memory` answers it (`HOST_FEATURES.sandboxMoveMemory`). */
	runtime = "firecracker=v1.17.0;kernel=6.1.155;sticky=2";
	/** Every host made, by ID: a move's target reads its holder's export from it, as from a peer. */
	static readonly byId = new Map<string, FakeHost>();
	/**
	 * Runs commands by Kantel's ID as kantel-host does with a guest that keeps them (`HOST_FEATURES.execControl`): each
	 * kept in `FakeHost.guestCommands`, a foreground one answered only once a test ends it there, or with `suspended`
	 * once its sandbox is stopped keeping its memory (and with its guest's broken call when it isn't). Off, a command is
	 * answered at once, `hi`.
	 */
	keepsCommands = false;
	/**
	 * For a test: a stop asked to keep its sandbox's memory stops it cold instead, as a host whose Firecracker won't
	 * pause does: its commands end with its machine, and the stop is answered a moment later, `memory: false`.
	 */
	stopsCold = false;
	/**
	 * The commands each sandbox's guest keeps by ID (`<sandboxId>/<commandId>`), in its memory: every host's, as a
	 * sandbox moved with its memory has the same guest. A test ends one by setting its result.
	 */
	static readonly guestCommands = new Map<string, HostExecStatus>();
	/** Foreground calls waiting for their command to end, by `<sandboxId>/<commandId>`: answered with what ended it. */
	private readonly foreground = new Map<string, (end: { result?: HostExecResult; error?: HostError }) => void>();

	/** Ends a guest's command with `result`, answering its foreground call where one waits for it here. */
	static endCommand(sandboxId: string, commandId: string, result: HostExecResult) {
		const key = `${sandboxId}/${commandId}`;
		FakeHost.guestCommands.set(key, { commandId, state: "exited", result });
		for (const host of FakeHost.byId.values()) host.foreground.get(key)?.({ result });
	}

	constructor(
		readonly service: HostsService,
		readonly hostId: string,
		/** What it reports doing beyond protocol 1 as first released; absent, an older host's report. */
		readonly features?: readonly string[],
	) {
		FakeHost.byId.set(hostId, this);
	}

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
		const wait = this.hold?.(message.method ?? "", message.params as { [key: string]: unknown });
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
		const refused = this.refuse?.(message.method ?? "", (message.params ?? {}) as { [key: string]: unknown });
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
				const cold = this.stopsCold && (message.params as { memory?: boolean }).memory !== false;
				const keeps = (message.params as { memory?: boolean }).memory !== false && !cold;
				// Its commands' calls break with its machine: kept in its memory they carry on, else they end with it.
				for (const [key, end] of this.foreground) {
					if (!key.startsWith(`${sandbox.id}/`)) continue;
					if (!keeps) FakeHost.guestCommands.delete(key);
					end({
						error: keeps
							? { code: "suspended", message: `sandbox ${sandbox.id} was stopped keeping its memory` }
							: { code: "internal", message: 'Post "http://guest/exec": EOF' },
					});
				}
				if (!keeps) {
					for (const key of FakeHost.guestCommands.keys()) {
						if (key.startsWith(`${sandbox.id}/`)) FakeHost.guestCommands.delete(key);
					}
				}
				const ran = this.processes.get(sandbox.id);
				if (keeps && sandbox.state === "running") this.memories.set(sandbox.id, ran ?? "booted");
				if (!keeps) this.memories.delete(sandbox.id);
				this.processes.delete(sandbox.id);
				const stopped = { ...sandbox, state: "stopped" as const, memory: keeps };
				this.sandboxes.set(sandbox.id, stopped);
				if (cold) {
					setTimeout(() => answer(stopped), 200);
					return;
				}
				return answer(stopped);
			}
			case "sandbox.start":
			case "sandbox.resume": {
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				if (sandbox.state !== "running") {
					const kept = message.method === "sandbox.resume" ? this.memories.get(sandbox.id) : undefined;
					this.processes.set(sandbox.id, kept ?? "booted");
					this.memories.delete(sandbox.id);
					// Booted afresh, its guest knows none of the commands its memory ran.
					if (kept === undefined) {
						for (const key of FakeHost.guestCommands.keys()) {
							if (key.startsWith(`${sandbox.id}/`)) FakeHost.guestCommands.delete(key);
						}
					}
				}
				const running = { ...sandbox, state: "running" as const };
				this.sandboxes.set(sandbox.id, running);
				return answer(withMounts(running));
			}
			case "sandbox.memory": {
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				const has = sandbox.state === "running" || this.memories.has(sandbox.id);
				return answer({ memory: has, bytes: has ? 512 * 1024 * 1024 : 0, ...(has ? { runtime: this.runtime } : {}) });
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
				const exec = message.params as { commandId?: string; detached?: boolean };
				if (this.keepsCommands && exec.commandId !== undefined) {
					const key = `${params.sandboxId}/${exec.commandId}`;
					FakeHost.guestCommands.set(key, { commandId: exec.commandId, state: "running", stdout: "so far\n" });
					if (exec.detached === true) return answer({ commandId: exec.commandId, state: "running", pid: 7 });
					this.foreground.set(key, (end) => {
						this.foreground.delete(key);
						if (end.error !== undefined) fail(end.error.code, end.error.message);
						else answer(end.result);
					});
					return;
				}
				this.send({ type: "event", call: message.id, event: { kind: "exec.output", stdout: btoa("hi\n"), at: 1 } });
				return answer({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 3 });
			}
			case "sandbox.exec.get":
			case "sandbox.exec.kill": {
				if (!this.keepsCommands) return fail("unsupported", `unknown method ${message.method}`);
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				if (sandbox.state !== "running")
					return fail("conflict", `sandbox ${sandbox.id} is ${sandbox.state}, not running`);
				const { commandId } = message.params as { commandId: string };
				const key = `${sandbox.id}/${commandId}`;
				const known = FakeHost.guestCommands.get(key);
				if (message.method === "sandbox.exec.get") {
					return known === undefined ? fail("not_found", `no command ${commandId}`) : answer(known);
				}
				const running = known?.state === "running";
				if (running)
					FakeHost.endCommand(sandbox.id, commandId, { exitCode: 137, stdout: "so far\n", stderr: "", durationMs: 5 });
				return answer({ killed: running });
			}
			case "sandbox.delete":
				if (
					typeof (message.params as { exported?: unknown }).exported === "string" &&
					this.exportedBy.get(params.sandboxId) !== (message.params as { exported: string }).exported
				) {
					return fail("not_found", "not the copy that move exported");
				}
				this.exportedBy.delete(params.sandboxId);
				this.sandboxes.delete(params.sandboxId);
				this.disks.delete(params.sandboxId);
				this.memories.delete(params.sandboxId);
				this.processes.delete(params.sandboxId);
				for (const key of this.exports.keys()) if (key.startsWith(`${params.sandboxId}/`)) this.exports.delete(key);
				return answer({ ok: true });
			case "sandbox.get": {
				const sandbox = this.sandboxes.get(params.sandboxId);
				return sandbox === undefined ? fail("not_found", "no such sandbox") : answer(sandbox);
			}
			case "sandbox.export": {
				const { version, live, memory } = message.params as { version: string; live?: boolean; memory?: boolean };
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				if (sandbox.state !== "stopped" && !(live === true && sandbox.state === "running")) {
					return fail("conflict", `sandbox ${sandbox.id} is ${sandbox.state}`);
				}
				const kept = this.memories.get(params.sandboxId);
				if (memory === true && kept === undefined) return fail("conflict", "it was stopped without its memory");
				this.exports.set(`${params.sandboxId}/${version}`, this.disks.get(params.sandboxId) ?? "");
				if (memory === true && kept !== undefined) this.memoryExports.set(`${params.sandboxId}/${version}`, kept);
				this.exportedBy.set(params.sandboxId, version);
				return answer({
					mapDigest: `sha256:${"a".repeat(64)}`,
					allocatedBytes: 4096,
					...(memory === true ? { memoryMapDigest: `sha256:${"b".repeat(64)}`, memoryAllocatedBytes: 8192 } : {}),
				});
			}
			case "sandbox.export.delete": {
				const { version } = message.params as { version?: string };
				for (const key of this.exports.keys()) {
					if (
						key === `${params.sandboxId}/${version}` ||
						(version === undefined && key.startsWith(`${params.sandboxId}/`))
					)
						this.exports.delete(key);
				}
				return answer({});
			}
			case "sandbox.import": {
				const { version, holders, grant, mapDigest, stage, base, memory } = message.params as {
					version: string;
					holders: { hostId: string; address: string }[];
					grant: string;
					mapDigest: string;
					stage?: boolean;
					base?: string;
					memory?: { mapDigest: string; holders: { hostId: string; address: string }[]; grant: string };
				};
				const key = `${params.sandboxId}/${version}`;
				if (this.cancelled.has(key)) return fail("conflict", "the move was cancelled here");
				const held = this.sandboxes.get(params.sandboxId);
				if (held !== undefined) return stage === true ? fail("conflict", "the sandbox is here already") : answer(held);
				const from = FakeHost.byId.get(holders[0]?.hostId ?? "");
				const disk = from?.exports.get(key);
				if (disk === undefined || grant === "" || mapDigest === "") return fail("unavailable", "no holder has it");
				const memoryOf =
					memory === undefined ? undefined : FakeHost.byId.get(memory.holders[0]?.hostId ?? "")?.memoryExports.get(key);
				if (memory !== undefined && (memoryOf === undefined || memory.grant === "" || memory.mapDigest === "")) {
					return fail("unavailable", "no holder has its memory");
				}
				if (stage === true) {
					this.staged.set(key, disk);
					return answer({});
				}
				// Its staged base goes once this version is the sandbox here.
				if (base !== undefined) this.staged.delete(`${params.sandboxId}/${base}`);
				const sandbox: HostSandbox = {
					id: params.sandboxId,
					tier: "microvm",
					size: "default",
					state: "stopped",
					createdAt: 1,
				};
				this.sandboxes.set(params.sandboxId, sandbox);
				this.disks.set(params.sandboxId, disk);
				if (memoryOf !== undefined) this.memories.set(params.sandboxId, memoryOf);
				return answer(sandbox);
			}
			case "sandbox.import.cancel": {
				const { version } = message.params as { version: string };
				this.cancelled.add(`${params.sandboxId}/${version}`);
				this.staged.delete(`${params.sandboxId}/${version}`);
				this.sandboxes.delete(params.sandboxId);
				this.disks.delete(params.sandboxId);
				this.memories.delete(params.sandboxId);
				return answer({});
			}
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
				return answer({ ref: build.snapshotId, imageDigest: "sha256:feed", sizeBytes: 42, ...this.madeOn });
			}
			case "template.delete":
				return answer({ ok: true });
			default:
				return fail("unsupported", `unknown method ${message.method}`);
		}
	}
}
