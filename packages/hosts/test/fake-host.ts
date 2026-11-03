// A host as kantel-host behaves, for tests: it speaks the protocol over a hub and answers calls from a table of
// sandboxes, with an echo server on every port.
import type { AcceptedHost } from "../src/hub.ts";
import {
	decodeStreamFrame,
	encodeStreamFrame,
	type HostFacts,
	type HostMessage,
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
	closedWith: { code: number; reason: string } | undefined;
	connection!: AcceptedHost;
	freeMemoryMiB = 20_000;
	warm: { [pool: string]: number } = {};
	/** Every call's method and params, as sent. */
	readonly calls: { readonly method: string; readonly params: { readonly [key: string]: unknown } }[] = [];
	/** For a test: a call of a method it answers a promise for is answered once that settles (a slow host). */
	hold?: (method: string) => Promise<void> | undefined;

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
		});
		this.send({
			type: "hello",
			hello: {
				hostId: this.hostId,
				facts: facts({}, this.features),
				sandboxes: [...this.sandboxes.values()],
				capacity: {
					freeMemoryMiB: this.freeMemoryMiB,
					freeDiskGiB: 400,
					running: 0,
					stopped: 0,
					load1: 0.1,
					warm: this.warm,
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
		// An echo server on the port.
		if (frame !== undefined && frame.payload.byteLength > 0) {
			this.connection.receive(
				encodeStreamFrame(frame.stream, new TextEncoder().encode(`echo:${new TextDecoder().decode(frame.payload)}`)),
			);
		}
	}

	private onText(message: HostMessage) {
		this.sent.push(message);
		if (message.type !== "call") return;
		this.calls.push({ method: message.method ?? "", params: message.params as { [key: string]: unknown } });
		const wait = this.hold?.(message.method ?? "");
		if (wait !== undefined) {
			void wait.then(() => this.answerCall(message));
			return;
		}
		this.answerCall(message);
	}

	private answerCall(message: HostMessage) {
		const params = message.params as { sandboxId: string; tier?: string; size?: string; newId?: string };
		const answer = (result: unknown) => this.send({ type: "result", id: message.id, result });
		const fail = (code: string, text: string) =>
			this.send({ type: "result", id: message.id, error: { code, message: text } });
		switch (message.method) {
			case "sandbox.create":
			case "sandbox.fork": {
				const id = message.method === "sandbox.fork" ? (params.newId as string) : params.sandboxId;
				const sandbox: HostSandbox = {
					id,
					tier: "microvm",
					size: "default",
					state: "running",
					createdAt: 1,
					source: "pool",
				};
				this.sandboxes.set(id, sandbox);
				return answer(sandbox);
			}
			case "sandbox.stop": {
				const sandbox = this.sandboxes.get(params.sandboxId);
				if (sandbox === undefined) return fail("not_found", "no such sandbox");
				const stopped = { ...sandbox, state: "stopped" as const, memory: true };
				this.sandboxes.set(sandbox.id, stopped);
				return answer(stopped);
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
				return answer({ ok: true });
			case "sandbox.secrets":
				return answer({});
			default:
				return fail("unsupported", `unknown method ${message.method}`);
		}
	}
}
