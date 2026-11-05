import { describe, expect, it } from "vitest";
import { utf8 } from "../src/bytes.ts";
import { type ChainEntry, chainDevice, extendChain, type SpaceState, signEntry, verifyChain } from "../src/chain.ts";
import { generateDh } from "../src/keys.ts";
import { serveSession } from "../src/responder.ts";
import { type ByteChannel, openSession, SessionClient } from "../src/session.ts";
import { contains, recordingRelay } from "../src/testing.ts";
import { type Fixture, fixture, gatewaySigner, HOST_ID, SPACE, signAs, T0 } from "./fixture.ts";

const SECRET_COMMAND = "cat /home/user/.env | grep OPENAI_API_KEY";
const SECRET_OUTPUT = "OPENAI_API_KEY=sk-live-the-secret-value";

/** A host serving the fixture's space, which runs calls on a pretend sandbox `sbx_one`. */
function host(
	f: Fixture,
	channel: ByteChannel,
	knows: readonly ChainEntry[] = f.entries,
	/** Held till it settles: each command runs as long as this. */
	lasts?: Promise<void>,
) {
	let state: SpaceState | undefined;
	const calls: { device: string; method: string; params: unknown }[] = [];
	const ready = verifyChain(knows).then((verified) => {
		state = verified;
	});
	const served = ready.then(() =>
		serveSession({
			channel,
			static: f.host.static,
			hostId: HOST_ID,
			chain: {
				state: () => state as SpaceState,
				async extend(from, entries) {
					state = await extendChain(state as SpaceState, entries, from);
					return state;
				},
			},
			authorize: (_device, hello) => (hello.sandbox === "sbx_one" ? undefined : "No such sandbox on this host"),
			async rpc(device, _sandbox, method, params, emit) {
				calls.push({ device: device.id, method, params });
				if (method !== "sandbox.exec") throw Object.assign(new Error("Not here"), { code: "unsupported" });
				await lasts;
				emit({ kind: "exec.output", stdout: btoa(SECRET_OUTPUT) });
				return { exitCode: 0, stdout: `${SECRET_OUTPUT}\n`, stderr: "" };
			},
			async port(_device, _sandbox, port) {
				if (port !== 22) throw new Error("Nothing listens there");
				// An echo server.
				let listener: ((bytes: Uint8Array) => void) | undefined;
				return {
					send: (bytes) => queueMicrotask(() => listener?.(bytes)),
					onData: (next) => {
						listener = next;
					},
					onClose: () => undefined,
					close: () => undefined,
				};
			},
		}),
	);
	return { served, calls, state: () => state };
}

async function rpc(
	f: Fixture,
	channel: ByteChannel,
	device = f.bobLaptop,
	state = f.state,
	entries = f.entries,
	keepaliveMs?: number,
) {
	return new SessionClient(
		await openSession({
			channel,
			static: device.static,
			state,
			entries,
			hostId: HOST_ID,
			sandbox: "sbx_one",
			op: "rpc",
		}),
		keepaliveMs === undefined ? {} : { keepaliveMs },
	);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("an E2E session through the relay", () => {
	it("runs a member's command, and the relay sees only ciphertext either way", async () => {
		const f = await fixture();
		const relay = recordingRelay({ chunk: 7 });
		const h = host(f, relay.host);
		const client = await rpc(f, relay.device);
		const events: unknown[] = [];
		const result = await client.call<{ stdout: string }>("sandbox.exec", { command: SECRET_COMMAND }, (event) =>
			events.push(event),
		);
		expect(result.stdout).toBe(`${SECRET_OUTPUT}\n`);
		expect(events).toHaveLength(1);
		expect(h.calls).toEqual([
			{
				device: (await chainDevice(f.bobLaptop, "usr_bob", "cli", "")).id,
				method: "sandbox.exec",
				params: { command: SECRET_COMMAND },
			},
		]);
		client.close();
		await h.served;
		const seen = relay.seen();
		for (const secret of [
			SECRET_COMMAND,
			"OPENAI_API_KEY",
			"sk-live-the-secret-value",
			btoa(SECRET_OUTPUT),
			"sbx_one",
		]) {
			expect(contains(seen.toHost, utf8(secret))).toBe(false);
			expect(contains(seen.toDevice, utf8(secret))).toBe(false);
		}
		// Not even the device's own keys or name: its static key goes encrypted in IK's first message.
		expect(contains(seen.toHost, f.bobLaptop.static.publicKey)).toBe(false);
		expect(contains(seen.toHost, utf8("bob"))).toBe(false);
	});

	it("sends keepalives while a foreground command is pending, and only then, for the sandbox's idle stop", async () => {
		const f = await fixture();
		const relay = recordingRelay();
		let finish = () => {};
		const lasts = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const h = host(f, relay.host, f.entries, lasts);
		const client = await rpc(f, relay.device, f.bobLaptop, f.state, f.entries, 20);
		const sent = () => relay.seen().toHost.length;

		// A detached command is followed elsewhere (`sandbox.exec.get`): no keepalive for it, even while its call waits.
		const detached = client.call("sandbox.exec", { command: "sleep 90", detached: true });
		await pause(10);
		const afterDetachedCall = sent();
		await pause(80);
		expect(sent()).toBe(afterDetachedCall);

		// A foreground one: bytes go to the host every interval while it runs, though it sends no output.
		const attached = client.call("sandbox.exec", { command: "sleep 90" });
		await pause(10);
		const started = sent();
		await pause(110);
		const during = sent();
		expect(during - started).toBeGreaterThanOrEqual(3);
		finish();
		await Promise.all([detached, attached]);
		// The host read past them: the command's answer came, and it ran once each.
		expect(h.calls.map((call) => call.method)).toEqual(["sandbox.exec", "sandbox.exec"]);

		// Once it ends, they stop.
		const ended = sent();
		await pause(80);
		expect(sent()).toBe(ended);
		client.close();
		await h.served;
	});

	it("brings a host that is behind up to date, so a device added since it last heard can open a session", async () => {
		const f = await fixture();
		const relay = recordingRelay();
		// The host knows the chain up to Bob's first device; his laptop came later.
		const h = host(f, relay.host, f.entries.slice(0, 4));
		const client = await rpc(f, relay.device);
		await client.call("sandbox.exec", { command: "true" });
		expect(h.state()?.seq).toBe(f.state.seq);
		client.close();
	});

	it("refuses a device the gateway made up, with a key no admin signed in", async () => {
		const f = await fixture();
		const relay = recordingRelay();
		const h = host(f, relay.host);
		const rogue = await generateDh();
		await expect(
			openSession({
				channel: relay.device,
				static: rogue,
				state: f.state,
				entries: f.entries,
				hostId: HOST_ID,
				sandbox: "sbx_one",
				op: "rpc",
			}),
		).rejects.toThrow(/isn't in the space's chain/);
		expect(h.calls).toEqual([]);
	});

	it("refuses a key the gateway injects into the chain it hands the host", async () => {
		const f = await fixture();
		const relay = recordingRelay();
		const h = host(f, relay.host);
		const gateway = await gatewaySigner();
		const rogue = await generateDh();
		const device = {
			id: gateway.id,
			user: "usr_bob",
			sign: btoa(String.fromCharCode(...gateway.signer.publicKey))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, ""),
			dh: btoa(String.fromCharCode(...rogue.publicKey))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replace(/=+$/, ""),
			class: "cli" as const,
			label: "kantel on bob-laptop",
		};
		const injected = await signEntry(f.state, SPACE, { type: "device.add", body: { device } }, gateway, T0 + 999_000);
		// The gateway's own "view" of the chain, with its key in, as if it were a device that verified it.
		const forgedState = {
			...f.state,
			seq: f.state.seq + 1,
			devices: new Map([...f.state.devices, [device.id, device]]),
		};
		await expect(
			openSession({
				channel: relay.device,
				static: rogue,
				state: forgedState,
				entries: [...f.entries, injected],
				hostId: HOST_ID,
				sandbox: "sbx_one",
				op: "rpc",
			}),
		).rejects.toThrow(/isn't a device in the chain/);
		expect(h.calls).toEqual([]);
		expect(h.state()?.seq).toBe(f.state.seq);
	});

	it("can't be answered by the relay posing as the host", async () => {
		const f = await fixture();
		const relay = recordingRelay();
		// The gateway's own responder, with its own key, chain and all.
		const fake = { ...f, host: f.gateway };
		host(fake, relay.host);
		await expect(rpc(f, relay.device)).rejects.toThrow();
	});

	it("ends the session when the relay changes a byte", async () => {
		const f = await fixture();
		const relay = recordingRelay();
		host(f, relay.host);
		const client = await rpc(f, relay.device);
		relay.tamper((bytes, direction) => {
			if (direction !== "toDevice" || bytes.byteLength < 8) return bytes;
			const changed = bytes.slice();
			changed[changed.byteLength - 1] = (changed[changed.byteLength - 1] ?? 0) ^ 1;
			return changed;
		});
		await expect(client.call("sandbox.exec", { command: "true" })).rejects.toThrow(/closed/);
	});

	it("lets a member in until an admin removes them, whatever the gateway does", async () => {
		const f = await fixture();
		const removal = await signAs(f.state, f.tom, { type: "member.remove", body: { user: "usr_bob" } }, T0 + 500_000);
		const after = await verifyChain([...f.entries, removal]);
		// Tom's device brings the removal to the host on his next session...
		const first = recordingRelay();
		const h = host(f, first.host);
		const tom = await rpc(f, first.device, f.tom, after, [...f.entries, removal]);
		await tom.call("sandbox.exec", { command: "true" });
		tom.close();
		await h.served;
		// ...and from then on Bob is refused, even holding the chain from before.
		const second = recordingRelay();
		let state = h.state() as SpaceState;
		void serveSession({
			channel: second.host,
			static: f.host.static,
			hostId: HOST_ID,
			chain: {
				state: () => state,
				async extend(from, entries) {
					state = await extendChain(state, entries, from);
					return state;
				},
			},
			rpc: async () => ({}),
		});
		await expect(rpc(f, second.device)).rejects.toThrow(/isn't in the space's chain/);
	});

	it("refuses the hosted console's device once the space is strict", async () => {
		const f = await fixture();
		const strict = await signAs(f.state, f.tom, { type: "mode", body: { mode: "strict" } }, T0 + 500_000);
		const entries = [...f.entries, strict];
		const relay = recordingRelay();
		host(f, relay.host, entries);
		await expect(rpc(f, relay.device, f.tomPhone, await verifyChain(entries), entries)).rejects.toThrow(/strict/);
	});

	it("carries a port's bytes end to end", async () => {
		const f = await fixture();
		const relay = recordingRelay({ chunk: 5 });
		host(f, relay.host);
		const session = await openSession({
			channel: relay.device,
			static: f.bob.static,
			state: f.state,
			entries: f.entries,
			hostId: HOST_ID,
			sandbox: "sbx_one",
			op: "port",
			port: 22,
		});
		const received: Uint8Array[] = [];
		const echoed = new Promise<void>((resolve) => {
			session.stream.onData((bytes) => {
				received.push(bytes);
				if (new TextDecoder().decode(Buffer.concat(received)).includes("SSH-2.0-secret")) resolve();
			});
		});
		await session.stream.write(utf8("SSH-2.0-secret\r\n"));
		await echoed;
		expect(contains(relay.seen().toHost, utf8("SSH-2.0-secret"))).toBe(false);
	});
});
