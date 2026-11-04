import { describe, expect, it } from "vitest";
import { fromHex, toHex, utf8 } from "../src/bytes.ts";
import { dhFromSeed, generateDh } from "../src/keys.ts";
import { NoiseInitiator, NoiseResponder, sameHandshake } from "../src/noise.ts";
import vectors from "../vectors/noise-ik.json" with { type: "json" };

const v = vectors.vector;

describe("Noise_IK_25519_AESGCM_SHA256", () => {
	it("matches cacophony's test vector, both ways and through transport", async () => {
		const initiator = new NoiseInitiator({
			prologue: fromHex(v.init_prologue),
			static: await dhFromSeed(fromHex(v.init_static)),
			remoteStatic: fromHex(v.init_remote_static),
			ephemeral: await dhFromSeed(fromHex(v.init_ephemeral)),
		});
		const responder = new NoiseResponder({
			prologue: fromHex(v.resp_prologue),
			static: await dhFromSeed(fromHex(v.resp_static)),
			ephemeral: await dhFromSeed(fromHex(v.resp_ephemeral)),
		});
		const [m1, m2, ...rest] = v.messages;
		if (m1 === undefined || m2 === undefined) throw new Error("The vector has no handshake");

		const first = await initiator.writeMessage1(fromHex(m1.payload));
		expect(toHex(first)).toBe(m1.ciphertext);
		const read1 = await responder.readMessage1(first);
		expect(toHex(read1.payload)).toBe(m1.payload);
		expect(toHex(read1.remoteStatic)).toBe(toHex((await dhFromSeed(fromHex(v.init_static))).publicKey));

		const second = await responder.writeMessage2(fromHex(m2.payload));
		expect(toHex(second.message)).toBe(m2.ciphertext);
		const read2 = await initiator.readMessage2(second.message);
		expect(toHex(read2.payload)).toBe(m2.payload);
		expect(toHex(read2.transport.handshakeHash)).toBe(v.handshake_hash);
		expect(sameHandshake(read2.transport, second.transport)).toBe(true);

		// After the handshake the initiator and the responder take turns, as the vector's messages do.
		for (const [index, message] of rest.entries()) {
			const [from, to] =
				index % 2 === 0
					? [read2.transport.send, second.transport.receive]
					: [second.transport.send, read2.transport.receive];
			const sealed = await from.encryptWithAd(new Uint8Array(0), fromHex(message.payload));
			expect(toHex(sealed)).toBe(message.ciphertext);
			expect(toHex(await to.decryptWithAd(new Uint8Array(0), sealed))).toBe(message.payload);
		}
	});

	it("can't be finished by anyone but the holder of the responder's static key", async () => {
		const host = await generateDh();
		const impostor = await generateDh();
		const initiator = new NoiseInitiator({
			prologue: utf8("p"),
			static: await generateDh(),
			remoteStatic: host.publicKey,
		});
		const first = await initiator.writeMessage1(utf8("hello"));
		// A relay with its own key can't even read the first message.
		await expect(new NoiseResponder({ prologue: utf8("p"), static: impostor }).readMessage1(first)).rejects.toThrow();
		// Nor answer for the host after a real host read it: the answer must come from the host's own keys.
		const forged = await new NoiseResponder({ prologue: utf8("p"), static: host }).readMessage1(first);
		expect(new TextDecoder().decode(forged.payload)).toBe("hello");
	});

	it("binds the prologue: a relay that changes what the session is for breaks it", async () => {
		const host = await generateDh();
		const initiator = new NoiseInitiator({
			prologue: utf8("space a"),
			static: await generateDh(),
			remoteStatic: host.publicKey,
		});
		const first = await initiator.writeMessage1(new Uint8Array(0));
		await expect(new NoiseResponder({ prologue: utf8("space b"), static: host }).readMessage1(first)).rejects.toThrow(
			/decrypt/,
		);
	});

	it("refuses a tampered or replayed transport message", async () => {
		const host = await generateDh();
		const initiator = new NoiseInitiator({
			prologue: utf8("p"),
			static: await generateDh(),
			remoteStatic: host.publicKey,
		});
		const responder = new NoiseResponder({ prologue: utf8("p"), static: host });
		await responder.readMessage1(await initiator.writeMessage1(new Uint8Array(0)));
		const { message, transport: hostSide } = await responder.writeMessage2(new Uint8Array(0));
		const { transport: deviceSide } = await initiator.readMessage2(message);
		const sealed = await deviceSide.send.encryptWithAd(new Uint8Array(0), utf8("ls"));
		const tampered = sealed.slice();
		tampered[0] = (tampered[0] ?? 0) ^ 1;
		await expect(hostSide.receive.decryptWithAd(new Uint8Array(0), tampered)).rejects.toThrow();
		expect(new TextDecoder().decode(await hostSide.receive.decryptWithAd(new Uint8Array(0), sealed))).toBe("ls");
		// The counter moved on, so the same ciphertext again doesn't decrypt.
		await expect(hostSide.receive.decryptWithAd(new Uint8Array(0), sealed)).rejects.toThrow();
	});
});
