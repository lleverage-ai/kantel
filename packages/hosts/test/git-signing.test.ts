// Host-side Git signing over the host link: `signing.fetch`, `signing` audit events, `HOST_FEATURES.gitSigning`
// placement filtering, `onHost` refusal on hosts without the feature, and live `sandbox.signing` updates.

import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { createHostHub, type HostHub, type HostHubOptions } from "../src/hub.ts";
import {
	HOST_FEATURES,
	type HostGitSigning,
	type HostMessage,
	type HostSigningKey,
	type HostSigningRecord,
} from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const SIGNING_META: HostGitSigning = {
	format: "gpg",
	keyId: "FD86B81C2E05E2A5",
	fingerprint: "111122223333444455556666FD86B81C2E05E2A5",
	publicKey: "-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----\n",
	version: 42,
};

const SIGNING_KEY: HostSigningKey = {
	version: 42,
	enabled: true,
	format: "gpg",
	keyId: SIGNING_META.keyId,
	fingerprint: SIGNING_META.fingerprint,
	allowedEmails: ["jeff@lleverage.ai"],
	privateKey: "PRIVATE-KEY-NEVER-LEAKED",
	passphrase: "PASSPHRASE-NEVER-LEAKED",
};

const hubs: HostHub[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const hub of hubs.splice(0)) hub.closeAll(1000, "done");
	for (const close of closers.splice(0).reverse()) await close();
});

function hubWith(options: Partial<HostHubOptions> = {}): HostHub {
	const hub = createHostHub({
		onHello: async (hostId) => ({ hostId, heartbeatSeconds: 15 }),
		...options,
	});
	hubs.push(hub);
	return hub;
}

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
			facts: facts({}, [HOST_FEATURES.egressPolicy, HOST_FEATURES.gitSigning]),
			sandboxes: [],
			capacity: { freeMemoryMiB: 1024, freeDiskGiB: 10, running: 0, stopped: 0, load1: 0, warm: {} },
		},
	});
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

describe("the hub's signing.fetch and signing events", () => {
	it("answers signing.fetch for the connection's own host only and hides internal errors", async () => {
		const signing = vi.fn(async (_hostId: string, sandboxId: string) =>
			sandboxId === "sbx_mine" ? SIGNING_KEY : undefined,
		);
		const host = connect(hubWith({ signing }), "host_a");
		await host.welcomed();

		// Ignores any spoofed hostId in params and passes the authenticated connection's hostId.
		host.send({ type: "call", id: "s1", method: "signing.fetch", params: { sandboxId: "sbx_mine", hostId: "host_b" } });
		expect(await host.result("s1")).toEqual({ type: "result", id: "s1", result: SIGNING_KEY });
		expect(signing).toHaveBeenCalledWith("host_a", "sbx_mine");

		host.send({ type: "call", id: "s2", method: "signing.fetch", params: { sandboxId: "sbx_elsewhere" } });
		expect((await host.result("s2")).error?.code).toBe("not_found");

		// Never leaks secret material if the signing fetcher throws.
		const failing = connect(
			hubWith({
				signing: async () => {
					throw new Error(`failed opening ${SIGNING_KEY.privateKey}`);
				},
			}),
			"host_fail",
		);
		await failing.welcomed();
		failing.send({ type: "call", id: "s3", method: "signing.fetch", params: { sandboxId: "sbx_mine" } });
		const failed = await failing.result("s3");
		expect(failed.error?.code).toBe("unavailable");
		expect(JSON.stringify(failed)).not.toContain(SIGNING_KEY.privateKey);
	});

	it("delivers signing audit events to onSigning with the authenticated hostId", async () => {
		const onSigning = vi.fn();
		const onEvent = vi.fn();
		const host = connect(hubWith({ onSigning, onEvent }), "host_a");
		await host.welcomed();

		const records: HostSigningRecord[] = [
			{
				at: 1_760_000_000_000,
				sandboxId: "sbx_mine",
				allowed: true,
				format: "gpg",
				keyId: SIGNING_META.keyId,
				fingerprint: SIGNING_META.fingerprint,
				objectType: "commit",
				committer: "jeff@lleverage.ai",
				object: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
			},
		];
		host.send({ type: "event", event: { kind: "signing", at: 1_760_000_000_000, signing: records } });
		await vi.waitFor(() => expect(onSigning).toHaveBeenCalledTimes(1));
		expect(onSigning).toHaveBeenCalledWith("host_a", records);
		expect(onEvent).not.toHaveBeenCalled();
	});
});

describe("gitSigning placement and live updates", () => {
	const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };

	it("places signing microVMs only on hosts with HOST_FEATURES.gitSigning and sends sandbox.signing updates", async () => {
		const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
		const backend = createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		});
		const api = createComputeApi({
			backend,
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer root" ? ROOT : undefined,
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
		});
		service.useJoinTokens(joinTokenSpender(api.store));
		service.useCompute({
			secrets: async () => undefined,
			signing: async () => SIGNING_KEY,
			recordEgress: async () => undefined,
			recordSigning: async () => undefined,
		});
		closers.push(
			() => service.close(),
			() => api.close(),
		);
		const root = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});

		const addHost = async (name: string, features: readonly string[]) => {
			const token = await root.createHostJoinToken({ name });
			const { hostId } = await service.register({ token: token.token });
			const fake = new FakeHost(service, hostId, features);
			fake.connect();
			await vi.waitFor(() => {
				if (!fake.sent.some((message) => message.type === "welcome")) throw new Error("not welcomed");
			});
			return { hostId, fake };
		};

		const old = await addHost("old-host", [HOST_FEATURES.egressPolicy]);
		const modern = await addHost("modern-host", [HOST_FEATURES.egressPolicy, HOST_FEATURES.gitSigning]);

		const placement = await backend.create({
			sandboxId: "sbx_signed",
			accountId: "acc_1",
			type: "microvm",
			subdomain: "signed",
			size: "default",
			env: {},
			eligibleHosts: [old.hostId, modern.hostId],
			gitSigning: SIGNING_META,
		});
		expect(placement.hostId).toBe(modern.hostId);
		expect(old.fake.calls.filter((call) => call.method === "sandbox.create")).toHaveLength(0);
		expect(modern.fake.calls.find((call) => call.method === "sandbox.create")?.params.gitSigning).toEqual(SIGNING_META);

		// Live updateSigning calls `sandbox.signing` on the modern host.
		await backend.updateSigning?.("sbx_signed", { ...SIGNING_META, version: 99 }, 99);
		const signingCall = modern.fake.calls.find((call) => call.method === "sandbox.signing");
		expect(signingCall?.params).toEqual({
			sandboxId: "sbx_signed",
			signing: { ...SIGNING_META, version: 99 },
			version: 99,
		});

		// Pinning a signing microVM to the old host is refused with not_supported.
		await expect(
			backend.create({
				sandboxId: "sbx_refused",
				accountId: "acc_1",
				type: "microvm",
				subdomain: "refused",
				size: "default",
				env: {},
				eligibleHosts: [old.hostId],
				gitSigning: SIGNING_META,
			}),
		).rejects.toThrow(/supports host-side Git signing/i);
	});
});
