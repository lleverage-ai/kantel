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

		// A microVM placed on the old host without signing refuses a non-null updateSigning, while clears stay no-ops.
		await backend.create({
			sandboxId: "sbx_old_vm",
			accountId: "acc_1",
			type: "microvm",
			subdomain: "oldvm",
			size: "default",
			env: {},
			eligibleHosts: [old.hostId],
		});
		await expect(backend.updateSigning?.("sbx_old_vm", SIGNING_META, 100)).rejects.toThrow(
			/doesn't support host-side Git signing/i,
		);
		await expect(backend.updateSigning?.("sbx_old_vm", null, 101)).resolves.toBeUndefined();
	});

	it("omits microVM signing from isolate create, start and live fork while enforcing it on upgrade", async () => {
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

		const addHost = async (name: string, features: readonly string[], tiers: readonly ("microvm" | "isolate")[]) => {
			const token = await root.createHostJoinToken({ name });
			const { hostId } = await service.register({ token: token.token });
			const fake = new FakeHost(service, hostId, features);
			fake.moreFacts = { tiers };
			fake.connect();
			await vi.waitFor(() => {
				if (!fake.sent.some((message) => message.type === "welcome")) throw new Error("not welcomed");
			});
			return { hostId, fake };
		};

		// Isolate-only host has NO git-signing feature; microVM host has git-signing + filesExtract for cross-host upgrade.
		const isoHost = await addHost("iso-only", [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze], ["isolate"]);
		const vmHost = await addHost(
			"vm-signer",
			[HOST_FEATURES.egressPolicy, HOST_FEATURES.gitSigning, HOST_FEATURES.filesExtract],
			["microvm"],
		);

		// Create an isolate with signing metadata: succeeds on iso-only and strips microVM signing fields.
		const created = await backend.create({
			sandboxId: "sbx_iso_1",
			accountId: "acc_1",
			type: "isolate",
			subdomain: "iso1",
			size: "default",
			env: {},
			eligibleHosts: [isoHost.hostId, vmHost.hostId],
			gitSigning: SIGNING_META,
			signingVersion: SIGNING_META.version,
		});
		expect(created.hostId).toBe(isoHost.hostId);
		const createCall = isoHost.fake.calls.find((call) => call.method === "sandbox.create");
		expect(createCall?.params.gitSigning).toBeUndefined();
		expect(createCall?.params.clearGitSigning).toBeUndefined();
		expect(createCall?.params.signingVersion).toBeUndefined();

		// Stop and start the isolate with gitSigning present: succeeds and omits signing fields.
		await backend.stop("sbx_iso_1", { keepMemory: false });
		await backend.start("sbx_iso_1", {
			env: {},
			eligibleHosts: [isoHost.hostId],
			gitSigning: SIGNING_META,
			signingVersion: SIGNING_META.version,
		});
		const startCall = isoHost.fake.calls.find((call) => call.method === "sandbox.start");
		expect(startCall?.params.gitSigning).toBeUndefined();
		expect(startCall?.params.clearGitSigning).toBeUndefined();
		expect(startCall?.params.signingVersion).toBeUndefined();

		// Live-fork the isolate with gitSigning present: succeeds and omits signing fields.
		await backend.fork({ sandboxId: "sbx_iso_1" }, [
			{
				sandboxId: "sbx_iso_fork",
				accountId: "acc_1",
				type: "isolate",
				subdomain: "isofork",
				size: "default",
				env: {},
				eligibleHosts: [isoHost.hostId],
				gitSigning: SIGNING_META,
				signingVersion: SIGNING_META.version,
			},
		]);
		const forkCall = isoHost.fake.calls.find((call) => call.method === "sandbox.fork");
		expect(forkCall?.params.gitSigning).toBeUndefined();
		expect(forkCall?.params.clearGitSigning).toBeUndefined();
		expect(forkCall?.params.signingVersion).toBeUndefined();

		// updateSigning for an isolate is a harmless no-op.
		await expect(backend.updateSigning?.("sbx_iso_1", SIGNING_META, 99)).resolves.toBeUndefined();
		expect(isoHost.fake.calls.filter((call) => call.method === "sandbox.signing")).toHaveLength(0);

		// Upgrading the isolate to a microVM forwards gitSigning and lands on the signing-capable microVM host.
		const upgraded = await backend.upgrade?.(
			"sbx_iso_1",
			{
				sandboxId: "sbx_iso_1",
				accountId: "acc_1",
				type: "microvm",
				subdomain: "iso1",
				size: "default",
				env: {},
				eligibleHosts: [isoHost.hostId, vmHost.hostId],
				gitSigning: SIGNING_META,
				signingVersion: SIGNING_META.version,
			},
			"upg_1",
		);
		expect(upgraded?.hostId).toBe(vmHost.hostId);
		const vmCreate = vmHost.fake.calls.find((call) => call.method === "sandbox.create");
		expect(vmCreate?.params.gitSigning).toEqual(SIGNING_META);
	});

	it("reconciles signing during isolate-to-microVM upgrade, stops VMs on incapable hosts, and retries revocations on reconnect", async () => {
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
			signing: (hostId, sandboxId) => api.service.signingKey(hostId, sandboxId),
			recordEgress: async () => undefined,
			recordSigning: (hostId, records) => api.service.recordSigning(hostId, records),
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

		const addHost = async (
			name: string,
			features: readonly string[],
			tiers: readonly ("microvm" | "isolate")[] = ["microvm", "isolate"],
			labels: { [key: string]: string } = {},
		) => {
			const token = await root.createHostJoinToken({ name });
			const { hostId } = await service.register({ token: token.token });
			const fake = new FakeHost(service, hostId, features);
			fake.moreFacts = { tiers, labels };
			fake.connect();
			await vi.waitFor(() => {
				if (!fake.sent.some((message) => message.type === "welcome")) throw new Error("not welcomed");
			});
			return { hostId, fake };
		};

		const sshKey = [
			"-----BEGIN " + "OPENSSH PRIVATE KEY-----",
			Buffer.concat([
				Buffer.from("openssh-key-v1\0"),
				Buffer.from([0, 0, 0, 4]),
				Buffer.from("none"),
				Buffer.from([0, 0, 0, 4]),
				Buffer.from("none"),
				Buffer.from([0, 0, 0, 0]),
				Buffer.from([0, 0, 0, 1]),
				Buffer.from([0, 0, 0, 51]),
				Buffer.from([0, 0, 0, 11]),
				Buffer.from("ssh-ed25519"),
				Buffer.from([0, 0, 0, 32]),
				Buffer.alloc(32, 0x61),
				Buffer.from([0, 0, 0, 136]),
				Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]),
				Buffer.from([0, 0, 0, 11]),
				Buffer.from("ssh-ed25519"),
				Buffer.from([0, 0, 0, 32]),
				Buffer.alloc(32, 0x61),
				Buffer.from([0, 0, 0, 64]),
				Buffer.alloc(64, 0x71),
				Buffer.from([0, 0, 0, 4]),
				Buffer.from("test"),
				Buffer.from([1, 2, 3, 4]),
			]).toString("base64"),
			"-----END " + "OPENSSH PRIVATE KEY-----",
			"",
		].join("\n");

		const oldHost = await addHost("old-vm", [HOST_FEATURES.egressPolicy], ["microvm"], { role: "old" });
		const isoHost = await addHost("iso-host", [HOST_FEATURES.egressPolicy, HOST_FEATURES.isolateFreeze], ["isolate"], {
			role: "iso",
		});
		const modernHost = await addHost(
			"modern-vm",
			[HOST_FEATURES.egressPolicy, HOST_FEATURES.gitSigning, HOST_FEATURES.filesExtract],
			["microvm"],
			{ role: "modern" },
		);

		// 1. Enabling signing while an isolate upgrades to a microVM reconciles against the resulting microVM type.
		const upgEnv = await root.createEnvironment({ name: "upg-env" });
		const iso = await root.createSandbox({
			name: "iso-upgrade",
			type: "isolate",
			environment: upgEnv.id,
			wait: true,
		});
		let releaseUpgradeCreate!: () => void;
		const upgradeCreateStarted = new Promise<void>((resolve) => {
			modernHost.fake.hold = (method) => {
				if (method === "sandbox.create") {
					resolve();
					return new Promise<void>((done) => {
						releaseUpgradeCreate = done;
					});
				}
				return undefined;
			};
		});
		const upgradePromise = root.upgradeSandbox(iso.id, { wait: true });
		await upgradeCreateStarted;
		await root.setEnvironmentGitSigning(upgEnv.id, {
			privateKey: sshKey,
			allowedEmails: ["jeff@lleverage.ai"],
		});
		modernHost.fake.hold = undefined;
		releaseUpgradeCreate();
		const upgraded = await upgradePromise;
		expect(upgraded.type).toBe("microvm");
		expect(upgraded.state).toBe("running");
		// Reconciliation delivered sandbox.signing to the upgraded microVM before publishing it running.
		const upgradeSigningCall = modernHost.fake.calls.find(
			(call) => call.method === "sandbox.signing" && call.params.sandboxId === iso.id,
		);
		expect(upgradeSigningCall?.params.signing).toMatchObject({ format: "ssh" });

		// 2. Disconnect modernHost, revoke the key, reconnect and run sweep: revocation reaches the host.
		modernHost.fake.connection.closed(1006, "network drop");
		await root.deleteEnvironmentGitSigning(upgEnv.id);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const clearsBeforeReconnect = modernHost.fake.calls.filter(
			(call) => call.method === "sandbox.signing" && call.params.sandboxId === iso.id && call.params.signing === null,
		);
		expect(clearsBeforeReconnect).toHaveLength(0);
		modernHost.fake.connect();
		await vi.waitFor(() => {
			if (!service.hub.connected(modernHost.hostId)) throw new Error("not reconnected");
		});
		await api.service.sweep();
		await vi.waitFor(() => {
			const clears = modernHost.fake.calls.filter(
				(call) => call.method === "sandbox.signing" && call.params.sandboxId === iso.id && call.params.signing === null,
			);
			expect(clears).toHaveLength(1);
		});

		// 3. Enabling signing while a microVM is starting on an incapable host stops it instead of publishing running.
		const oldEnv = await root.createEnvironment({ name: "old-race-env" });
		let releaseOldCreate!: () => void;
		const oldCreateStarted = new Promise<void>((resolve) => {
			oldHost.fake.hold = (method) => {
				if (method === "sandbox.create") {
					resolve();
					return new Promise<void>((done) => {
						releaseOldCreate = done;
					});
				}
				return undefined;
			};
		});
		const oldVm = await root.createSandbox({
			name: "old-race-vm",
			type: "microvm",
			environment: oldEnv.id,
			hostLabels: { role: "old" },
			wait: false,
		});
		await oldCreateStarted;
		await root.setEnvironmentGitSigning(oldEnv.id, {
			privateKey: sshKey,
			allowedEmails: ["jeff@lleverage.ai"],
		});
		oldHost.fake.hold = undefined;
		releaseOldCreate();
		await vi.waitFor(async () => {
			const current = await root.getSandbox(oldVm.id);
			expect(current.state).toBe("stopped");
		});
		expect(oldHost.fake.calls.filter((call) => call.method === "sandbox.signing")).toHaveLength(0);
		expect(isoHost.fake.calls.filter((call) => call.method === "sandbox.signing")).toHaveLength(0);
	});
});
