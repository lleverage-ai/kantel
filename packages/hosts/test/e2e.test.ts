// End-to-end encryption through the gateway (`@kantel/e2e`), end to end: the compute API keeps an organisation's
// chain and hands out a tunnel to the host's E2E responder (port 0), the host joins the chain over its credential, and
// a device's Noise session crosses the hub as stream frames. The host here is kantel-host's TypeScript twin
// (`serveSession`); the Go host replays the same bytes (apps/host/internal/e2e). What the hub carried, either way, is
// checked for the command and its output, and a key the gateway slips into the chain is refused by the host.
import { KantelApiError } from "@kantel/api/sdk";
import { utf8 } from "@kantel/e2e/bytes";
import { chainDevice, createHostTicket, signEntry, verifyChain } from "@kantel/e2e/chain";
import { keyId, newIdentity } from "@kantel/e2e/keys";
import { openSession, SessionClient } from "@kantel/e2e/session";
import { contains } from "@kantel/e2e/testing";
import { describe, expect, it } from "vitest";
import { hostJoins, joined, PEOPLE, ROOT, SECRET_COMMAND, SECRET_OUTPUT, setup } from "./e2e-host.ts";

/** An organisation's E2E space through the API: Root's device starts it, the host joins it with Root's ticket. */
async function space() {
	const s = await setup();
	const sandbox = await s.root.createSandbox({ type: "microvm", wait: true });
	const accountId = sandbox.accountId;
	const device = await newIdentity();
	const by = { id: await keyId("kd", device.signer.publicKey), signer: device.signer };
	const genesis = await signEntry(
		undefined,
		accountId,
		{
			type: "genesis",
			body: { mode: "on", device: await chainDevice(device, ROOT.userId, "cli", "kantel on laptop") },
		},
		by,
		Date.now(),
	);
	await s.root.appendE2EChain(accountId, { from: 0, entries: [genesis] });
	let state = await verifyChain([genesis]);
	await hostJoins(s, await createHostTicket(state, by, "rack-1", Date.now() + 600_000));
	// The device reads the chain back and verifies it from its own genesis.
	const entries = (await s.root.getE2EChain(accountId)).entries;
	state = await verifyChain(entries, state.genesis);
	return { ...s, sandbox, accountId, device, by, state, entries };
}

describe("E2E through the gateway", () => {
	it("runs a member's command on the host through the hub, which carries only ciphertext", async () => {
		const s = await space();
		const access = await s.root.openE2E(s.sandbox.id, {});
		expect(access).toMatchObject({ hostId: s.hostId, accountId: s.accountId });
		const client = new SessionClient(
			await openSession({
				channel: await s.tunnel(access.url),
				static: s.device.static,
				state: s.state,
				entries: s.entries,
				hostId: access.hostId,
				sandbox: s.sandbox.id,
				op: "rpc",
			}),
		);
		const result = await client.call<{ stdout: string }>("sandbox.exec", { command: SECRET_COMMAND });
		expect(result.stdout).toBe(`${SECRET_OUTPUT}\n`);
		expect(s.host.ran).toEqual([{ device: s.by.id, method: "sandbox.exec", params: { command: SECRET_COMMAND } }]);
		client.close();
		const toHost = joined(s.host.frames.toHost);
		const toGateway = joined(s.host.frames.toGateway);
		expect(toHost.byteLength).toBeGreaterThan(0);
		for (const secret of [SECRET_COMMAND, "OPENAI_API_KEY", "sk-live-the-secret-value", "sandbox.exec"]) {
			expect(contains(toHost, utf8(secret))).toBe(false);
			expect(contains(toGateway, utf8(secret))).toBe(false);
		}
		expect(contains(toHost, s.device.static.publicKey)).toBe(false);
	});

	it("takes a signed append from an account:read key as from its person, and nothing more", async () => {
		const s = await setup();
		const sandbox = await s.root.createSandbox({ type: "microvm", wait: true });
		const accountId = sandbox.accountId;
		const keyed = async (body: Parameters<typeof s.root.createApiKey>[0], by = s.root) =>
			s.as((await by.createApiKey(body)).secret);
		const device = await newIdentity();
		const by = { id: await keyId("kd", device.signer.publicKey), signer: device.signer };
		const genesisFor = async (user: string, signer = by) =>
			signEntry(
				undefined,
				accountId,
				{ type: "genesis", body: { mode: "on", device: await chainDevice(device, user, "cli", "laptop") } },
				signer,
				Date.now(),
			);
		const code = (call: Promise<unknown>) =>
			call.then(
				() => "ok",
				(error: unknown) => (error as KantelApiError).code,
			);
		const genesis = await genesisFor(ROOT.userId);

		// Refused: no account:read, a key limited to a sandbox, a genesis naming someone else, a forged signature.
		const unscoped = await keyed({ name: "writer", scopes: ["sandboxes:write"] });
		expect(await code(unscoped.appendE2EChain(accountId, { from: 0, entries: [genesis] }))).toBe("forbidden");
		const limited = await keyed({ name: "one", scopes: ["account:read"], sandboxIds: [sandbox.id] });
		expect(await code(limited.appendE2EChain(accountId, { from: 0, entries: [genesis] }))).toBe("forbidden");
		const key = await keyed({ name: "laptop", scopes: ["account:read"] });
		expect(await code(key.appendE2EChain(accountId, { from: 0, entries: [await genesisFor(PEOPLE.bob.userId)] }))).toBe(
			"forbidden",
		);
		const other = await newIdentity();
		const forged = await genesisFor(ROOT.userId, { id: by.id, signer: other.signer });
		expect(await code(key.appendE2EChain(accountId, { from: 0, entries: [forged] }))).toBe("invalid");
		// Bob's key acts only in his own account.
		const bobs = await keyed({ name: "bob", scopes: ["account:read"] }, s.as("bob"));
		expect(await code(bobs.appendE2EChain(accountId, { from: 0, entries: [genesis] }))).not.toBe("ok");
		expect((await s.root.getE2EChain(accountId)).entries).toEqual([]);

		// Taken: Root's own key, with the genesis listing Root's device.
		expect((await key.appendE2EChain(accountId, { from: 0, entries: [genesis] })).entries).toEqual([genesis]);
		const state = await verifyChain([genesis]);
		const mode = await signEntry(state, accountId, { type: "mode", body: { mode: "strict" } }, by, Date.now());
		expect((await key.appendE2EChain(accountId, { from: 1, entries: [mode] })).entries).toHaveLength(2);
	});

	it("lets a shared host read a space's chain only while it holds one of its sandboxes or is enrolled", async () => {
		const s = await space();
		const bob = s.as("bob");
		const bobs = (await bob.getCaller()).accountId as string;
		const refused = { error: { code: "not_found" } };
		// Nothing of Bob's is on it.
		expect(await s.hostCall("GET", bobs)).toMatchObject(refused);
		// A sandbox of his, running or stopped (its disk is there), lets it.
		const box = await bob.createSandbox({ type: "microvm", wait: true });
		expect(await s.hostCall("GET", bobs)).toEqual({ entries: [] });
		// The records as stop and delete leave them (this host's twin, joined to an E2E space, takes no gateway call):
		// a deleted sandbox's keeps its hostId.
		const as = async (id: string, state: "stopped" | "deleted") => {
			const stored = await s.api.store.sandboxes.get(id);
			if (stored === undefined) throw new Error(`No record of ${id}`);
			await s.api.store.sandboxes.put({ ...stored, state });
		};
		await as(box.id, "stopped");
		expect(await s.hostCall("GET", bobs)).toEqual({ entries: [] });
		// Deleted, that is no longer enough.
		await as(box.id, "deleted");
		expect((await s.api.store.sandboxes.get(box.id))?.hostId).toBe(s.hostId);
		expect(await s.hostCall("GET", bobs)).toMatchObject(refused);
		// Enrolled in Root's space, it still reads it once Root's sandbox there is gone.
		await as(s.sandbox.id, "deleted");
		expect((await s.hostCall("GET", s.accountId)).entries).toHaveLength(2);
	});

	it("keeps no chain that wouldn't verify, and no second entry at one seq", async () => {
		const s = await space();
		const intruder = await newIdentity();
		const forged = await signEntry(
			s.state,
			s.accountId,
			{ type: "device.add", body: { device: await chainDevice(intruder, ROOT.userId, "cli", "not Root's") } },
			{ id: await keyId("kd", intruder.signer.publicKey), signer: intruder.signer },
			Date.now(),
		);
		const refused = await s.root.appendE2EChain(s.accountId, { from: 2, entries: [forged] }).catch((error) => error);
		expect(refused).toBeInstanceOf(KantelApiError);
		expect((refused as KantelApiError).code).toBe("invalid");
		const mode = await signEntry(s.state, s.accountId, { type: "mode", body: { mode: "strict" } }, s.by, Date.now());
		await s.root.appendE2EChain(s.accountId, { from: 2, entries: [mode] });
		const late = await s.root.appendE2EChain(s.accountId, { from: 2, entries: [mode] }).catch((error) => error);
		expect((late as KantelApiError).code).toBe("conflict");
		// A host appends only its own host.add.
		await expect(
			s.hostCall("POST", s.accountId, { space: s.accountId, from: 3, entries: [mode] }),
		).resolves.toMatchObject({
			error: { code: "forbidden" },
		});
	});

	it("refuses a device the gateway put in the chain itself", async () => {
		const s = await space();
		// The gateway, or whoever holds its database, signs a device.add with a key of its own and stores it unchecked.
		const gateway = await newIdentity();
		const forged = await signEntry(
			s.state,
			s.accountId,
			{ type: "device.add", body: { device: await chainDevice(gateway, ROOT.userId, "cli", "kantel on laptop") } },
			{ id: await keyId("kd", gateway.signer.publicKey), signer: gateway.signer },
			Date.now(),
		);
		await s.api.store.e2eChain.insert({
			id: `${s.accountId}#${String(2).padStart(10, "0")}`,
			space: s.accountId,
			seq: 2,
			payload: forged.payload,
			sig: forged.sig,
			addedAt: Date.now(),
		});
		const access = await s.root.openE2E(s.sandbox.id, {});
		const entries = (await s.root.getE2EChain(s.accountId)).entries;
		expect(entries).toHaveLength(3);
		// The gateway's own device, bringing its chain to the host.
		const opening = openSession({
			channel: await s.tunnel(access.url),
			static: gateway.static,
			state: s.state,
			entries,
			hostId: access.hostId,
			sandbox: s.sandbox.id,
			op: "rpc",
		});
		// The host doesn't take the entry (its signer isn't in the chain), so the device isn't one it knows.
		await expect(opening).rejects.toThrow(/This device isn't in the space's chain/);
		expect(s.host.ran).toEqual([]);
		expect(s.host.state?.seq).toBe(1);
		// And a device verifying from its genesis won't take that chain either.
		await expect(verifyChain(entries, s.state.genesis)).rejects.toThrow(/isn't a device in the chain/);
	});
});
