import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createRoutedBackend, NOT_HELD } from "../src/routed-backend.ts";
import {
	checkShape,
	hourlyRate,
	type InviteMail,
	inviteForSomeoneElse,
	inviteLink,
	isLoopbackUrl,
	microvmShapes,
	NEVER_MADE,
	PLACEHOLDER_RATES,
	publicOrigin,
	SHARED_HOSTS_REFUSED,
	SHARED_KEY_REFUSED,
	shapeFor,
} from "../src/service.ts";
import { createMemoryStore } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";

/** People the injected authenticator knows, by bearer. */
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

function setup(
	backend: SandboxBackend = createStubBackend(),
	extra: Pick<Parameters<typeof createComputeApi>[0], "sharedHosts" | "invites"> = {},
) {
	const api = createComputeApi({
		...extra,
		backend,
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string | undefined) =>
		createKantelClient({
			baseUrl: BASE_URL,
			...(token === undefined ? {} : { token }),
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return { api, client, tom: client("tom-token"), ann: client("ann-token"), root: client("root-token") };
}

/** The error a call failed with; fails the test when it succeeded. */
async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

describe("sandboxes", () => {
	it("creates an isolate, runs a command and reads, writes and lists files", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		expect(sandbox.type).toBe("isolate");
		expect(sandbox.state).toBe("running");
		expect(sandbox.visibility).toBe("private");
		expect(sandbox.stopsAt).toBeTypeOf("number");

		const command = await tom.runCommand(sandbox.id, { command: "echo hello > f.txt && cat f.txt" });
		expect(command.state).toBe("exited");
		expect(command.exitCode).toBe(0);
		expect(command.stdout).toBe("hello\n");
		expect((await tom.listCommands(sandbox.id)).items.map((item) => item.id)).toEqual([command.id]);

		const read = await tom.readFile(sandbox.id, { path: "f.txt" });
		expect(read).toMatchObject({ path: "/home/user/f.txt", encoding: "utf8", content: "hello\n", size: 6 });

		const written = await tom.writeFile(sandbox.id, { path: "notes/todo.md", content: "# To do" });
		expect(written).toMatchObject({ path: "/home/user/notes/todo.md", kind: "file", size: 7 });
		const listing = await tom.listFiles(sandbox.id, { path: "notes" });
		expect(listing.items.map((entry) => entry.name)).toEqual(["todo.md"]);
		const encoded = await tom.readFile(sandbox.id, { path: "/home/user/notes/todo.md", encoding: "base64" });
		expect(atob(encoded.content)).toBe("# To do");

		await tom.deleteFile(sandbox.id, { path: "notes/todo.md" });
		expect((await failure(tom.readFile(sandbox.id, { path: "notes/todo.md" }))).code).toBe("not_found");
	});

	it("reads a file over 1 MiB in parts with offset and length", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const half = 768 * 1024;
		await tom.writeFile(sandbox.id, { path: "a.txt", content: "a".repeat(half) });
		await tom.writeFile(sandbox.id, { path: "b.txt", content: "b".repeat(half) });
		await tom.runCommand(sandbox.id, { command: "cat a.txt b.txt > big.txt" });

		const whole = await failure(tom.readFile(sandbox.id, { path: "big.txt" }));
		expect(whole.code).toBe("invalid");
		expect(whole.message).toContain("read it in parts with offset and length");

		const first = await tom.readFile(sandbox.id, { path: "big.txt", offset: 0 });
		expect(first).toMatchObject({ size: 2 * half, offset: 0 });
		expect(first.content).toBe("a".repeat(half) + "b".repeat(1024 * 1024 - half));
		const rest = await tom.readFile(sandbox.id, { path: "big.txt", offset: 1024 * 1024, length: 1024 * 1024 });
		expect(rest).toMatchObject({ size: 2 * half, offset: 1024 * 1024 });
		expect(rest.content).toBe("b".repeat(2 * half - 1024 * 1024));
		const some = await tom.readFile(sandbox.id, { path: "big.txt", offset: half - 2, length: 4, encoding: "base64" });
		expect(atob(some.content)).toBe("aabb");
		const past = await tom.readFile(sandbox.id, { path: "big.txt", offset: 5 * half, length: 10 });
		expect(past).toMatchObject({ content: "", size: 2 * half, offset: 2 * half });
		// A small file read with a range says where its part starts; without one, it answers no offset.
		expect(await tom.readFile(sandbox.id, { path: "a.txt", length: 3 })).toMatchObject({ content: "aaa", offset: 0 });
		expect(await tom.readFile(sandbox.id, { path: "a.txt" })).not.toHaveProperty("offset");
		expect((await failure(tom.readFile(sandbox.id, { path: "a.txt", length: 1024 * 1024 + 1 }))).code).toBe("invalid");
	});

	it("runs a detached command in the background and records how it ended", async () => {
		const { api, tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const detached = await tom.runCommand(sandbox.id, { command: "echo later", detached: true });
		expect(detached.state).toBe("running");
		await api.service.idle();
		const ended = await tom.getCommand(sandbox.id, detached.id);
		expect(ended.state).toBe("exited");
		expect(ended.stdout).toBe("later\n");
	});

	it("stops with a history snapshot and resumes with its files", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		await tom.runCommand(sandbox.id, { command: "echo kept > keep.txt" });

		const stopped = await tom.stopSandbox(sandbox.id, { wait: true });
		expect(stopped.state).toBe("stopped");
		expect(stopped.stopsAt).toBeUndefined();
		const history = await tom.listSnapshots({ sandboxId: sandbox.id });
		expect(history.items).toHaveLength(1);
		expect(history.items[0]).toMatchObject({ kind: "automatic", trigger: "stop", sandboxId: sandbox.id });
		expect(stopped.latestSnapshotId).toBe(history.items[0]?.id);
		expect((await failure(tom.runCommand(sandbox.id, { command: "true" }))).code).toBe("conflict");
		expect((await tom.listSandboxes()).items.map((item) => item.id)).not.toContain(sandbox.id);
		expect((await tom.listSandboxes({ all: true })).items.map((item) => item.id)).toContain(sandbox.id);

		const resumed = await tom.resumeSandbox(sandbox.id, { wait: true });
		expect(resumed.state).toBe("running");
		expect((await tom.readFile(sandbox.id, { path: "keep.txt" })).content).toBe("kept\n");

		const events = await tom.listEvents({ sandboxId: sandbox.id });
		expect(events.items.map((event) => event.type)).toEqual([
			"sandbox.running",
			"sandbox.stopped",
			"sandbox.running",
			"sandbox.created",
		]);
	});

	it("forks, saves a named snapshot, creates from it and deletes for good", async () => {
		const { tom } = setup();
		const source = await tom.createSandbox({ name: "source", wait: true });
		await tom.writeFile(source.id, { path: "app.txt", content: "v1" });

		const forks = await tom.forkSandbox(source.id, { count: 2, wait: true });
		expect(forks.items).toHaveLength(2);
		for (const fork of forks.items) {
			expect(fork.state).toBe("running");
			expect(fork.source?.sandboxId).toBe(source.id);
			expect((await tom.readFile(fork.id, { path: "app.txt" })).content).toBe("v1");
		}

		const saved = await tom.saveSnapshot({ name: "base", sandboxId: source.id });
		expect(saved).toMatchObject({ kind: "saved", name: "base", trigger: "save" });
		expect((await failure(tom.saveSnapshot({ name: "base", sandboxId: source.id }))).code).toBe("conflict");

		const fromSaved = await tom.createSandbox({ from: "base", wait: true });
		expect(fromSaved.source?.snapshotId).toBe(saved.id);
		expect((await tom.readFile(fromSaved.id, { path: "app.txt" })).content).toBe("v1");

		await tom.stopSandbox(source.id, { wait: true });
		const deleted = await tom.deleteSandbox(source.id);
		expect(deleted.state).toBe("deleted");
		expect((await tom.getSandbox(source.id)).state).toBe("deleted");
		expect((await failure(tom.runCommand(source.id, { command: "true" }))).code).toBe("not_found");
		expect((await tom.listSandboxes({ all: true })).items.map((item) => item.id)).not.toContain(source.id);
		expect((await tom.listSnapshots({ sandboxId: source.id })).items).toEqual([]);
		const kept = await tom.listSnapshots({ kind: "saved" });
		expect(kept.items.map((item) => item.id)).toEqual([saved.id]);
		expect(kept.items[0]?.sandboxId).toBeUndefined();
	});

	it("answers the first sandbox again for a repeated idempotency key", async () => {
		const { tom } = setup();
		const first = await tom.createSandbox({ name: "once" }, { idempotencyKey: "create-1" });
		const again = await tom.createSandbox({ name: "once" }, { idempotencyKey: "create-1" });
		expect(again.id).toBe(first.id);
		const named = (await tom.listSandboxes({ all: true })).items.filter((item) => item.name === "once");
		expect(named).toHaveLength(1);
	});

	it("refuses microVM-only features on an isolate and gives them to a microVM", async () => {
		const { tom } = setup();
		const isolate = await tom.createSandbox({ wait: true });
		const refused = await failure(tom.openSsh(isolate.id, {}));
		expect(refused.status).toBe(501);
		expect(refused.code).toBe("not_supported");
		expect((await failure(tom.stopSandbox(isolate.id, { keepMemory: true }))).code).toBe("not_supported");

		const vm = await tom.createSandbox({ type: "microvm", wait: true });
		expect(vm.size).toBe("default");
		const ssh = await tom.openSsh(vm.id, {});
		expect(ssh.command).toContain("ssh");
		const port = await tom.exposePort(vm.id, { port: 3000 });
		expect(port.url).toBe(`http://3000-${vm.subdomain}.sandbox.localhost`);
		const paused = await tom.stopSandbox(vm.id, { keepMemory: true, wait: true });
		expect(paused.state).toBe("paused");
	});

	it("says what shapes may be asked for: an isolate's memory and, on a host that makes them, any microVM", async () => {
		const { tom } = setup();
		const shapes = await tom.getSandboxShapes();
		expect(shapes.isolate).toEqual({ memoryMb: { min: 128, max: 512, step: 64, default: 256 }, enforced: false });
		expect(shapes.microvm).toMatchObject({
			vcpus: { min: 1, max: 32, step: 1, default: 2 },
			memoryMb: { min: 512, step: 512, default: 4096 },
			memoryMbPerVcpu: { min: 512, max: 8192 },
			custom: true,
		});
		expect(shapes.microvm?.presets.map((preset) => preset.name)).toEqual(["small", "default", "large", "xlarge"]);
		// Hosts keep no warm pools, so no preset says it is warm.
		expect(shapes.microvm?.presets.some((preset) => "warm" in preset)).toBe(false);
		// Self-hosted, sandboxes have no price.
		expect(shapes.rates).toBeUndefined();
	});

	it("makes a microVM of any shape, matching a preset by its numbers, and an isolate of the memory it asks", async () => {
		const { tom } = setup();
		const custom = await tom.createSandbox({ type: "microvm", resources: { vcpus: 3, memoryMb: 6144 }, wait: true });
		expect(custom.size).toBeUndefined();
		expect(custom.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		expect(custom.cost.ratePerHour).toBe(hourlyRate(PLACEHOLDER_RATES, "microvm", { vcpus: 3, memoryMb: 6144 }));
		// A fork is its source's shape.
		const [fork] = (await tom.forkSandbox(custom.id, { wait: true })).items;
		expect(fork?.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });

		const preset = await tom.createSandbox({ type: "microvm", resources: { vcpus: 4, memoryMb: 8192 }, wait: true });
		expect(preset.size).toBe("large");

		const isolate = await tom.createSandbox({ resources: { memoryMb: 384 }, wait: true });
		expect(isolate.resources).toMatchObject({ vcpus: 0, memoryMb: 384 });
		expect(isolate.cost.ratePerHour).toBe(hourlyRate(PLACEHOLDER_RATES, "isolate", { vcpus: 0, memoryMb: 384 }));
		const plain = await tom.createSandbox({ wait: true });
		expect(plain.resources).toMatchObject({ memoryMb: 256 });
	});

	it("refuses a shape it can't make", async () => {
		const { tom } = setup();
		const refusals = [
			{ resources: { memoryMb: 600 } },
			{ resources: { memoryMb: 1024 } },
			{ resources: { vcpus: 2, memoryMb: 256 } },
			{ type: "microvm", resources: { memoryMb: 2048 } },
			{ type: "microvm", resources: { vcpus: 1, memoryMb: 16_384 } },
			{ type: "microvm", resources: { vcpus: 2, memoryMb: 3000 } },
			{ type: "microvm", resources: { vcpus: 2, memoryMb: 2048 }, size: "small" },
		] as const;
		for (const body of refusals) expect((await failure(tom.createSandbox(body))).code).toBe("invalid");
	});

	it("prices by vCPU and GB an hour", () => {
		const rates = { currency: "USD", microvmPerVcpuHour: 0.01, microvmPerGbHour: 0.002, isolatePerGbHour: 0.02 };
		expect(hourlyRate(rates, "microvm", { vcpus: 2, memoryMb: 4096 })).toBe(0.028);
		expect(hourlyRate(rates, "isolate", { vcpus: 0, memoryMb: 512 })).toBe(0.01);
		expect(checkShape("microvm", { vcpus: 2, memoryMb: 768 }, [{ vcpus: 2, memoryMb: 768 }])).toEqual({
			vcpus: 2,
			memoryMb: 768,
		});
	});

	it("offers a host's presets, and any shape where it makes them, promising no disk for one", () => {
		const host = {
			id: "h",
			name: "h",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
			labels: {},
		} as const;
		const sizes = [{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 }] as const;
		const named = microvmShapes([host], sizes);
		expect(named).toMatchObject({ vcpus: { max: 2 }, memoryMb: { max: 2048 }, custom: false });
		const custom = microvmShapes([{ ...host, features: ["custom-shapes"] }], sizes);
		expect(custom).toMatchObject({ vcpus: { max: 8 }, memoryMb: { max: 16_384 }, custom: true });
		expect(custom?.presets).toEqual([{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 }]);
		// A custom shape's disk is its host's to give (and a snapshot's to keep): none is said ahead.
		expect(custom).not.toHaveProperty("customDisk");
		expect(microvmShapes([], sizes)).toBeUndefined();
	});

	it("keeps hosts' different shapes under one name apart", () => {
		const host = {
			id: "a",
			name: "a",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
			labels: {},
			features: ["custom-shapes"],
		} as const;
		const four = { ...host, sizes: [{ name: "default" as const, vcpus: 4, memoryMb: 2048, diskGb: 20 }] };
		const two = { ...host, id: "b", sizes: [{ name: "default" as const, vcpus: 2, memoryMb: 4096, diskGb: 40 }] };
		const shapes = microvmShapes([four, two], []);
		expect(shapes?.presets).toEqual([
			{ name: "default", vcpus: 2, memoryMb: 4096, diskGb: 40 },
			{ name: "default", vcpus: 4, memoryMb: 2048, diskGb: 20 },
		]);
		// The same shape on both: one entry.
		const same = microvmShapes([four, { ...four, id: "c" }], []);
		expect(same?.presets).toEqual([{ name: "default", vcpus: 4, memoryMb: 2048, diskGb: 20 }]);
	});

	it("checks a shape against the hosts this create may use only, however full they are", () => {
		const host = {
			id: "named",
			name: "named",
			version: "1",
			os: "linux",
			arch: "x86_64",
			tiers: ["microvm"],
			kvm: true,
			nestedVirtualisation: false,
			capacity: { vcpus: 8, memoryMb: 16_384, diskGb: 200 },
			labels: {},
		} as const;
		const sizes = [{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20 }] as const;
		const custom = { vcpus: 3, memoryMb: 6144 };
		// Only named sizes where it may go: another account's upgraded host doesn't count.
		expect(() => shapeFor("microvm", custom, [host], sizes)).toThrow(/No host this sandbox may use/);
		expect(shapeFor("microvm", { vcpus: 2, memoryMb: 2048 }, [host], sizes)).toEqual({ vcpus: 2, memoryMb: 2048 });
		expect(shapeFor("microvm", custom, [{ ...host, features: ["custom-shapes"] }], sizes)).toEqual(custom);
		// From a snapshot it boots on the snapshot's host as it was.
		expect(shapeFor("microvm", custom, [host], sizes, false)).toEqual(custom);
		expect(shapeFor("isolate", undefined, [], sizes)).toEqual({ vcpus: 0, memoryMb: 256 });
		expect(shapeFor("microvm", undefined, [], sizes)).toBeUndefined();
	});

	it("refuses a screen the image reports it lacks once placed, even when asked for before then", async () => {
		const stub = createStubBackend();
		const reason = "No desktop in this image: it has no Xvfb";
		let screens = 0;
		const backend: SandboxBackend = {
			...stub,
			// An injected Alpine image: it says what it has when it boots, after the create returned.
			create: async (spec) => {
				const placement = await stub.create(spec);
				await new Promise((resolve) => setTimeout(resolve, 20));
				const unavailable = { available: false, reason };
				return {
					...placement,
					capabilities: {
						...placement.capabilities,
						desktop: false,
						browser: false,
						guest: {
							reportedAt: Date.now(),
							os: { id: "alpine", name: "Alpine Linux v3.22", version: "3.22.0" },
							arch: "x86_64",
							libc: "musl",
							shell: "/bin/sh",
							init: "kantel",
							agent: { version: "test", injected: true },
							desktop: unavailable,
							browser: { available: false, reason: "No browser in this image" },
							docker: { available: false, reason: "No Docker in this image", kvm: false },
						},
					},
				};
			},
			openDesktop: async (...args) => {
				screens++;
				return stub.openDesktop(...args);
			},
			openBrowser: async (...args) => {
				screens++;
				return stub.openBrowser(...args);
			},
		};
		const { tom } = setup(backend);
		const vm = await tom.createSandbox({ type: "microvm" });
		const desktop = await failure(tom.openDesktop(vm.id, {}));
		expect(desktop.code).toBe("not_supported");
		expect(desktop.message).toBe(reason);
		expect((await failure(tom.openBrowser(vm.id, {}))).code).toBe("not_supported");
		expect(screens).toBe(0);
	});

	it("extends a running sandbox's stop time and stops it once that passes", async () => {
		let clock = Date.UTC(2026, 0, 1);
		const api = createComputeApi({
			backend: createStubBackend(),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
			now: () => clock,
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sandbox = await tom.createSandbox({ autoStopMinutes: 5, wait: true });
		expect(sandbox.stopsAt).toBe(clock + 5 * 60_000);
		const extended = await tom.updateSandbox(sandbox.id, { extendMinutes: 30 });
		expect(extended.stopsAt).toBe(clock + 30 * 60_000);

		clock += 31 * 60_000;
		await tom.getCaller();
		await api.service.idle();
		const stopped = await tom.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.usage.runningSeconds).toBe(31 * 60);
		expect(stopped.cost.total).toBeGreaterThan(0);
	});
});

describe("keys and scopes", () => {
	it("refuses a read-only key a create, and a call with no bearer or a bad one", async () => {
		const { client, tom } = setup();
		const issued = await tom.createApiKey({ name: "reader", preset: "read-only" });
		expect(issued.secret).toMatch(/^ksk_[0-9A-Za-z]{32}$/);
		expect(issued.key.prefix).toBe(issued.secret.slice(0, 8));
		expect(issued.key.scopes).toEqual(["sandboxes:read", "snapshots:read", "account:read"]);

		const reader = client(issued.secret);
		expect((await reader.listSandboxes()).items).toEqual([]);
		const refused = await failure(reader.createSandbox({}));
		expect(refused.status).toBe(403);
		expect(refused.code).toBe("forbidden");

		const anonymous = await failure(client(undefined).getCaller());
		expect(anonymous.status).toBe(401);
		expect(anonymous.code).toBe("unauthenticated");
		expect((await failure(client("ksk_notakey").getCaller())).status).toBe(401);

		await tom.revokeApiKey(issued.key.id);
		expect((await failure(reader.listSandboxes())).status).toBe(401);
	});

	it("lets a key grant only the scopes it holds", async () => {
		const { client, tom } = setup();
		const admin = client(
			(await tom.createApiKey({ name: "admin", scopes: ["account:admin", "sandboxes:read"] })).secret,
		);
		const refused = await failure(admin.createApiKey({ name: "more", scopes: ["exec"] }));
		expect(refused.code).toBe("forbidden");
		const narrower = await admin.createApiKey({ name: "less", scopes: ["sandboxes:read"] });
		expect(narrower.key.scopes).toEqual(["sandboxes:read"]);
		expect((await failure(admin.createApiKey({ name: "hosts", scopes: ["hosts:admin"] }))).code).toBe("forbidden");
	});

	it("rotates a key, so the old secret stops working", async () => {
		const { client, tom } = setup();
		const issued = await tom.createApiKey({ name: "ci", preset: "ci" });
		const rotated = await tom.rotateApiKey(issued.key.id);
		expect(rotated.secret).not.toBe(issued.secret);
		expect((await failure(client(issued.secret).listSandboxes())).status).toBe(401);
		expect((await client(rotated.secret).getCaller()).apiKey?.id).toBe(issued.key.id);
	});

	it("won't let a key rotate a key holding scopes it lacks, which would hand it their secret", async () => {
		const { client, root } = setup();
		const admin = await root.createApiKey({ name: "admin", preset: "admin" });
		const wide = await root.createApiKey({ name: "hosts", scopes: ["account:read", "hosts:admin"] });
		const refused = await failure(client(admin.secret).rotateApiKey(wide.key.id));
		expect(refused.code).toBe("forbidden");
		expect((await client(wide.secret).getCaller()).apiKey?.id).toBe(wide.key.id);
	});

	it("never answers the proxy's upstream header values", async () => {
		const { tom } = setup();
		const settings = await tom.putProxySettings({
			enabled: true,
			defaultAction: "deny",
			allow: ["api.github.com"],
			upstream: { url: "https://mehen.example", headers: { authorization: "Bearer hush-123" } },
		});
		expect(settings.upstream?.headerNames).toEqual(["authorization"]);
		expect(JSON.stringify(settings)).not.toContain("hush-123");
		expect(JSON.stringify(await tom.getProxySettings())).not.toContain("hush-123");
	});

	it("refuses a proxy write made from an older read, with `expected`, and leaves the settings as they were", async () => {
		const { tom } = setup();
		// Never written: the defaults are what was read.
		const unset = await tom.getProxySettings();
		const first = await tom.putProxySettings({
			enabled: true,
			defaultAction: "deny",
			allow: ["api.github.com"],
			upstream: { url: "https://mehen.example", headers: { authorization: "Bearer hush-123" } },
			expected: unset,
		});
		// Someone else adds a host from that read.
		const theirs = await tom.putProxySettings({
			...first,
			upstream: { url: "https://mehen.example" },
			allow: [...first.allow, "pypi.org"],
			expected: first,
		});
		expect(theirs.upstream?.headerNames).toEqual(["authorization"]);

		// A write from the same, now older, read would drop pypi.org: it is refused.
		const stale = await failure(
			tom.putProxySettings({
				...first,
				upstream: { url: "https://mehen.example" },
				deny: ["evil.example"],
				expected: first,
			}),
		);
		expect(stale.code).toBe("conflict");
		const now = await tom.getProxySettings();
		expect(now).toMatchObject({ allow: ["api.github.com", "pypi.org"], deny: [] });

		// From the defaults too, once the settings have been written.
		expect((await failure(tom.putProxySettings({ enabled: false, expected: unset }))).code).toBe("conflict");
		// Without `expected` the write replaces them whatever they hold, as before.
		expect(await tom.putProxySettings({ enabled: false })).toMatchObject({ enabled: false, allow: [] });
	});

	it("refuses a first proxy write whose `expected` isn't the defaults", async () => {
		const { tom } = setup();
		const unset = await tom.getProxySettings();
		const refused = await failure(
			tom.putProxySettings({ enabled: true, expected: { ...unset, allow: ["api.github.com"] } }),
		);
		expect(refused.code).toBe("conflict");
		expect(await tom.getProxySettings()).toEqual(unset);
	});
});

describe("device sign-in", () => {
	it("signs a device in once a person approves its code, and hands its key over once", async () => {
		const { client, tom } = setup();
		const device = client(undefined);
		const started = await device.startDeviceLogin({ clientName: "kantel on build-01" });
		expect(started.deviceCode).toMatch(/^kdc_/);
		expect(started.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
		expect(started.verificationUrl).toBe("http://compute.test/device");
		expect(started.verificationUrlComplete).toBe(`http://compute.test/device?code=${started.userCode}`);

		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "pending" });

		// The person may type it in lower case and without the dash.
		const typed = started.userCode.toLowerCase().replace("-", "");
		expect(await tom.getDeviceLogin(typed)).toMatchObject({ clientName: "kantel on build-01", state: "pending" });
		expect(await tom.approveDeviceLogin(typed, { preset: "agent" })).toMatchObject({ state: "approved" });

		const approved = await device.pollDeviceLogin({ deviceCode: started.deviceCode });
		expect(approved.state).toBe("approved");
		expect(approved.issued?.secret).toMatch(/^ksk_/);
		expect(approved.issued?.key.name).toBe("kantel on build-01");
		expect(approved.issued?.key.expiresAt).toBeTypeOf("number");
		const caller = await client(approved.issued?.secret).getCaller();
		expect(caller.apiKey?.scopes).not.toContain("account:admin");
		expect(caller.apiKey?.id).toBe(approved.issued?.key.id);
		expect(approved.issued?.key.createdBy).toMatchObject({ kind: "user", id: "usr_tom" });

		// The secret is handed over once.
		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "expired" });
		expect((await failure(tom.approveDeviceLogin(started.userCode, {}))).code).toBe("conflict");
	});

	it("tells the device when the person denies it, and needs a person to approve", async () => {
		const { client, tom } = setup();
		const device = client(undefined);
		const started = await device.startDeviceLogin({});
		const key = await tom.createApiKey({ name: "admin", preset: "admin" });
		expect((await failure(client(key.secret).approveDeviceLogin(started.userCode, {}))).code).toBe("forbidden");
		expect((await failure(device.approveDeviceLogin(started.userCode, {}))).status).toBe(401);
		await tom.denyDeviceLogin(started.userCode);
		expect(await device.pollDeviceLogin({ deviceCode: started.deviceCode })).toEqual({ state: "denied" });
		expect((await failure(device.pollDeviceLogin({ deviceCode: "kdc_nope" }))).code).toBe("not_found");
		expect((await failure(tom.getDeviceLogin("BBBB-BBBB"))).code).toBe("not_found");
	});
});

describe("organisations", () => {
	it("creates an organisation, invites someone and lets them join", async () => {
		const { tom, ann } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		expect(org).toMatchObject({ kind: "organisation", role: "owner", defaultVisibility: "organisation" });

		const invite = await tom.createInvite(org.id, { role: "member" });
		const code = invite.code ?? "";
		expect(code).toMatch(/^kji_/);
		const joined = await ann.joinOrganisation({ code });
		expect(joined).toMatchObject({ id: org.id, role: "member" });
		expect((await failure(ann.joinOrganisation({ code }))).code).toBe("expired");

		const members = await tom.listMembers(org.id);
		expect(members.items.map((member) => member.userId).sort()).toEqual(["usr_ann", "usr_tom"]);
		expect((await ann.getCaller()).accounts.map((account) => account.id)).toContain(org.id);
		expect((await failure(ann.createInvite(org.id, {}))).code).toBe("forbidden");

		const shared = await tom.createSandbox({ account: org.id, wait: true });
		const mine = await tom.createSandbox({ account: org.id, visibility: "private", wait: true });
		const seen = await ann.listSandboxes({ account: org.id });
		expect(seen.items.map((item) => item.id)).toEqual([shared.id]);
		expect((await failure(ann.getSandbox(mine.id))).code).toBe("not_found");
		const annEvents = await ann.listEvents({ account: org.id });
		expect(annEvents.items.some((event) => event.sandboxId === shared.id)).toBe(true);
		expect(annEvents.items.some((event) => event.sandboxId === mine.id)).toBe(false);
		const tomEvents = await tom.listEvents({ account: org.id });
		expect(tomEvents.items.some((event) => event.sandboxId === mine.id)).toBe(true);
		expect((await failure(ann.listSandboxes({ account: "acc_elsewhere" }))).code).toBe("forbidden");

		expect((await failure(tom.removeMember(org.id, "usr_tom"))).code).toBe("conflict");
		await ann.removeMember(org.id, "usr_ann");
		expect((await failure(ann.listSandboxes({ account: org.id }))).code).toBe("forbidden");
	});

	it("lets only the person an emailed invite is for join, whatever case either email is in, and says who it's for (#657)", async () => {
		const { tom, ann, root } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "  Ann@Example.COM ", role: "admin" });
		expect(invite.email).toBe("ann@example.com");
		const code = invite.code ?? "";

		const refused = await failure(root.joinOrganisation({ code }));
		expect(refused.code).toBe("forbidden");
		expect(refused.message).toBe(
			"This invite is for ann@example.com, but you're signed in as root@example.com. Sign in as ann@example.com to join.",
		);
		expect(await ann.joinOrganisation({ code })).toMatchObject({ id: org.id, role: "admin" });
		expect((await failure(tom.createInvite(org.id, { email: "not an email" }))).code).toBe("invalid");
	});

	it("emails an invite made for an address, with a link that joins with its code", async () => {
		const sent: InviteMail[] = [];
		const { tom, ann } = setup(createStubBackend(), {
			invites: { send: async (mail) => void sent.push(mail), consoleUrl: "https://kantel.example.com/" },
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "Ann@Example.com", role: "member" });
		expect(invite.emailed).toBe(true);
		expect(sent).toEqual([
			{
				to: "ann@example.com",
				organisation: "Acme",
				invitedBy: "tom@example.com",
				link: `https://kantel.example.com/organisation#join=${invite.code}`,
				expiresAt: invite.expiresAt,
			},
		]);
		// The link's code is the invite's: following it joins.
		const code = decodeURIComponent(new URL(sent[0]?.link ?? "").hash.replace(/^#join=/, ""));
		expect(await ann.joinOrganisation({ code })).toMatchObject({ id: org.id, role: "member" });

		// An invite for anyone with the code goes to nobody.
		expect((await tom.createInvite(org.id, {})).emailed).toBe(false);
		expect(sent).toHaveLength(1);
	});

	it("keeps an invite whose email didn't go, and says so; without mail it sends none", async () => {
		const failed: string[] = [];
		const { tom, ann } = setup(createStubBackend(), {
			invites: {
				send: async () => {
					throw new Error("mail is down");
				},
				onMailError: (_error, to) => void failed.push(to),
			},
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "ann@example.com" });
		expect(invite.emailed).toBe(false);
		expect(failed).toEqual(["ann@example.com"]);
		expect(await ann.joinOrganisation({ code: invite.code ?? "" })).toMatchObject({ id: org.id });

		const unmailed = setup();
		const other = await unmailed.tom.createOrganisation({ name: "Beta" });
		expect((await unmailed.tom.createInvite(other.id, { email: "ann@example.com" })).emailed).toBe(false);
	});

	it("emails an invite only to an address that can sign in to follow its link, where the deployment says", async () => {
		const sent: InviteMail[] = [];
		const asked: string[] = [];
		const { tom, ann } = setup(createStubBackend(), {
			invites: {
				send: async (mail) => void sent.push(mail),
				canSignIn: async (email) => {
					asked.push(email);
					return email === "ann@example.com";
				},
			},
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		const stranger = await tom.createInvite(org.id, { email: "stranger@example.com" });
		expect(stranger).toMatchObject({ email: "stranger@example.com", emailed: false });
		expect(stranger.code).toMatch(/^kji_/);
		const invite = await tom.createInvite(org.id, { email: "Ann@Example.com" });
		expect(invite.emailed).toBe(true);
		expect(asked).toEqual(["stranger@example.com", "ann@example.com"]);
		expect(sent.map((mail) => mail.to)).toEqual(["ann@example.com"]);
		expect(await ann.joinOrganisation({ code: invite.code ?? "" })).toMatchObject({ id: org.id });
	});

	it("links an invite to the console where the call came in, without a console URL", async () => {
		const sent: InviteMail[] = [];
		const { tom } = setup(createStubBackend(), { invites: { send: async (mail) => void sent.push(mail) } });
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { email: "ann@example.com" });
		expect(sent[0]?.link).toBe(`http://compute.test/organisation#join=${invite.code}`);
		expect(inviteLink("https://kantel.example.com//", "kji_a/b")).toBe(
			"https://kantel.example.com/organisation#join=kji_a%2Fb",
		);
	});

	it("tells someone signed in with no email which email an invite is for", () => {
		expect(inviteForSomeoneElse("Ann@Example.com", undefined)).toBe(
			"This invite is for ann@example.com, but you're signed in with no email. Sign in as ann@example.com to join.",
		);
	});

	it("keeps someone off the shared hosts (sharedHosts) out of a sandbox there, though a member shared its account", async () => {
		const { tom, ann, root } = setup(createStubBackend(), { sharedHosts: async (userId) => userId === "usr_tom" });
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = await tom.createInvite(org.id, { role: "member" });
		await ann.joinOrganisation({ code: invite.code ?? "" });
		// On the stub, the deployment's one shared host.
		const shared = await tom.createSandbox({ account: org.id, wait: true });

		// Ann sees it listed, but can't use it, nor put a sandbox of her own on the shared hosts.
		expect((await ann.listSandboxes({ account: org.id })).items.map((item) => item.id)).toEqual([shared.id]);
		expect((await failure(ann.getSandbox(shared.id))).code).toBe("forbidden");
		expect((await failure(ann.runCommand(shared.id, { command: "true" }))).code).toBe("forbidden");
		const placed = await failure(ann.createSandbox({ account: org.id, wait: true }));
		expect(placed.code).toBe("unavailable");
		expect(placed.message).toMatch(/host of this account's own/);
		// Tom, who may, still can; and so can the super-admin with sandboxes of their own.
		expect((await tom.runCommand(shared.id, { command: "echo hi" })).stdout).toBe("hi\n");
		const roots = await root.createSandbox({ wait: true });
		expect((await root.runCommand(roots.id, { command: "echo hi" })).stdout).toBe("hi\n");
	});

	it("makes a sandbox whose create or fork failed from its source again, never as an empty one", async () => {
		const stub = createStubBackend();
		let failing = false;
		const refuse = () => Promise.reject(new KantelError("unavailable", "The host is away"));
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => (failing ? refuse() : stub.create(spec)),
			fork: (source, targets) => (failing ? refuse() : stub.fork(source, targets)),
		};
		const { tom } = setup(backend);
		const source = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.writeFile(source.id, { path: "/home/user/kept.txt", content: "kept" });
		const stopped = await tom.stopSandbox(source.id, { wait: true });
		const snapshotId = stopped.latestSnapshotId ?? "";
		await tom.startSandbox(source.id, { wait: true });

		// Its create from the snapshot fails, and so does a fork of the running sandbox (it has no snapshot of its own).
		failing = true;
		const fromSnapshot = await tom.createSandbox({ type: "microvm", from: snapshotId, wait: true });
		expect(fromSnapshot.state).toBe("error");
		const [fork] = (await tom.forkSandbox(source.id, { wait: true })).items;
		expect(fork?.state).toBe("error");
		failing = false;

		// Started again, the first is made from the snapshot, its file there; the fork can't be, so it is refused.
		expect((await tom.startSandbox(fromSnapshot.id, { wait: true })).state).toBe("running");
		expect((await tom.readFile(fromSnapshot.id, { path: "/home/user/kept.txt" })).content).toBe("kept");
		for (const call of [tom.startSandbox(fork?.id ?? "", { wait: true }), tom.recoverSandbox(fork?.id ?? "")]) {
			expect(await failure(call)).toMatchObject({ code: "conflict", message: NEVER_MADE });
		}
		expect((await tom.getSandbox(fork?.id ?? "")).state).toBe("error");

		// One of a shape of its own is made again as that shape; a size named on its start replaces it.
		failing = true;
		const shaped = await tom.createSandbox({
			type: "microvm",
			from: snapshotId,
			resources: { vcpus: 3, memoryMb: 6144 },
			wait: true,
		});
		const sized = await tom.createSandbox({
			type: "microvm",
			from: snapshotId,
			resources: { vcpus: 3, memoryMb: 6144 },
			wait: true,
		});
		failing = false;
		const again = await tom.startSandbox(shaped.id, { wait: true });
		expect(again.resources).toMatchObject({ vcpus: 3, memoryMb: 6144 });
		const large = await tom.startSandbox(sized.id, { size: "large", wait: true });
		expect(large).toMatchObject({ size: "large", resources: { vcpus: 4, memoryMb: 8192 } });
	});

	it("runs a restart that names a size as that size, even the name it had, and one that names none as it was", async () => {
		const { tom } = setup();
		const custom = { vcpus: 3, memoryMb: 6144 };
		const made = await tom.createSandbox({ type: "microvm", resources: custom, wait: true });
		const name = made.size ?? "default";
		await tom.stopSandbox(made.id, { wait: true });
		const kept = await tom.startSandbox(made.id, { wait: true });
		expect(kept.resources).toMatchObject(custom);
		// Its own size's name, given: that size, not the custom shape it had.
		await tom.stopSandbox(made.id, { keepMemory: true, wait: true });
		const named = await tom.resumeSandbox(made.id, { size: name, wait: true });
		const size = (await tom.getSandboxShapes()).microvm?.presets.find((preset) => preset.name === name);
		expect(named.resources).toMatchObject({ vcpus: size?.vcpus, memoryMb: size?.memoryMb });
		expect(named.cost.ratePerHour).toBe(
			hourlyRate(PLACEHOLDER_RATES, "microvm", { vcpus: size?.vcpus ?? 0, memoryMb: size?.memoryMb ?? 0 }),
		);
		// Another size, then a fork and a plain restart: each the size it now runs as.
		await tom.stopSandbox(made.id, { wait: true });
		const large = await tom.startSandbox(made.id, { size: "large", wait: true });
		expect(large).toMatchObject({ size: "large", resources: { vcpus: 4, memoryMb: 8192 } });
		const [fork] = (await tom.forkSandbox(made.id, { wait: true })).items;
		expect(fork?.resources).toMatchObject({ vcpus: 4, memoryMb: 8192 });
		await tom.stopSandbox(made.id, { wait: true });
		expect((await tom.startSandbox(made.id, { wait: true })).resources).toMatchObject({ vcpus: 4, memoryMb: 8192 });
	});

	it("makes a plain sandbox whose create failed again as its create would, on recover, start or resume", async () => {
		const stub = createStubBackend();
		let failing = true;
		const creates: string[] = [];
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => {
				creates.push(spec.sandboxId);
				return failing
					? Promise.reject(new KantelError("unavailable", "The disk couldn't be made"))
					: stub.create(spec);
			},
		};
		const { api, tom } = setup(backend);
		// Made from no snapshot, each create fails: no backend has them, and they have no snapshot of their own.
		const made = [];
		for (let i = 0; i < 3; i++) made.push(await tom.createSandbox({ type: "microvm", wait: true }));
		expect(made.map((sandbox) => sandbox.state)).toEqual(["error", "error", "error"]);
		failing = false;

		// Each is made again with the backend's create, as its create made it, rather than asked of a backend without it.
		const [recovered, started, resumed] = made.map((sandbox) => sandbox.id);
		await tom.recoverSandbox(recovered ?? "");
		await api.service.idle();
		expect((await tom.startSandbox(started ?? "", { wait: true })).state).toBe("running");
		expect((await tom.resumeSandbox(resumed ?? "", { wait: true })).state).toBe("running");
		for (const sandbox of made) {
			expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
			expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");
		}
		expect(creates.filter((id) => id === recovered)).toHaveLength(2);
	});

	it("makes a plain microVM of its own shape whose create failed again as that shape, on recover, start or resume", async () => {
		const stub = createStubBackend();
		let failing = true;
		const creates: { readonly sandboxId: string; readonly size?: string; readonly shape?: unknown }[] = [];
		const backend: SandboxBackend = {
			...stub,
			create: (spec) => {
				creates.push({ sandboxId: spec.sandboxId, size: spec.size, shape: spec.shape });
				return failing
					? Promise.reject(new KantelError("unavailable", "The disk couldn't be made"))
					: stub.create(spec);
			},
		};
		const { api, tom } = setup(backend);
		const custom = { vcpus: 3, memoryMb: 6144 };
		const made = [];
		for (let i = 0; i < 3; i++) made.push(await tom.createSandbox({ type: "microvm", resources: custom, wait: true }));
		expect(made.map((sandbox) => sandbox.state)).toEqual(["error", "error", "error"]);
		failing = false;

		// Each is made again at the shape it asked for: no preset's size in its place.
		const [recovered, started, resumed] = made.map((sandbox) => sandbox.id);
		await tom.recoverSandbox(recovered ?? "");
		await api.service.idle();
		await tom.startSandbox(started ?? "", { wait: true });
		await tom.resumeSandbox(resumed ?? "", { wait: true });
		for (const sandbox of made) {
			const again = await tom.getSandbox(sandbox.id);
			expect(again.state).toBe("running");
			expect(again.resources).toMatchObject(custom);
			const remade = creates.filter((create) => create.sandboxId === sandbox.id);
			expect(remade).toHaveLength(2);
			expect(remade[1]).toMatchObject({ shape: custom });
			expect(remade[1]?.size).toBeUndefined();
		}
	});

	it("sends a sandbox the routed backend's fallback has just made its egress before it runs, and refuses one never made", async () => {
		const stub = createStubBackend();
		let release = () => {};
		const booting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let failing = false;
		const fallback: SandboxBackend = {
			...stub,
			create: async (spec) => {
				if (failing) throw new KantelError("unavailable", "The disk couldn't be made");
				await booting;
				return stub.create(spec);
			},
		};
		// An account-hosts side with no hosts: everything is the fallback's, as is the records' say of what it holds.
		const primary: SandboxBackend = {
			...createStubBackend(),
			capabilities: async () => ({ types: ["isolate", "microvm"], sizes: [], hosts: [] }),
		};
		const records: { api?: ComputeApi } = {};
		const routed = createRoutedBackend({
			primary,
			fallback,
			holds: async () => false,
			fallbackHolds: async (id) => (await records.api?.store.sandboxes.get(id))?.hostId === STUB_HOST_ID,
			holdsSnapshot: () => false,
		});
		const { api, tom } = setup(routed);
		records.api = api;

		// Its grants change while it is made: sent once it is placed, before its record says where, so it runs.
		const sandbox = await tom.createSandbox({});
		await tom.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "evil.example" }] });
		release();
		await api.service.idle();
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "running" });
		expect((await tom.runCommand(sandbox.id, { command: "echo hi" })).stdout).toBe("hi\n");

		// One whose create failed is the fallback's no more than anyone's.
		failing = true;
		const lost = await tom.createSandbox({ wait: true });
		expect(lost.state).toBe("error");
		await expect(routed.exec(lost.id, { command: "true" })).rejects.toMatchObject({ message: NOT_HELD });
	});

	it("keeps an overdue sandbox whose host is away running, and auto-stops it once its host is back", async () => {
		let clock = 1_000_000;
		const stub = createStubBackend();
		let connected = true;
		let dropOnStop = false;
		let refuseStop = false;
		const stops: string[] = [];
		const away = () => new KantelError("unavailable", "Host host_stub is not connected");
		const backend: SandboxBackend = {
			...stub,
			async capabilities() {
				const known = await stub.capabilities();
				return { ...known, hosts: known.hosts.map((host) => ({ ...host, connected })) };
			},
			async stop(sandboxId, how) {
				// The connection drops with the stop pending, and the host is connected again (a new connection) by the
				// time the failure is handled: the stop never reached the machine.
				if (dropOnStop) {
					dropOnStop = false;
					throw new KantelError("unavailable", "The host disconnected: replaced by a newer connection");
				}
				if (refuseStop) throw new KantelError("conflict", "The host refused the stop");
				if (!connected) throw away();
				stops.push(sandboxId);
				return stub.stop(sandboxId, how);
			},
		};
		const api = createComputeApi({
			backend,
			now: () => clock,
			authenticatePerson: async (request) => PEOPLE[request.headers.get("authorization")?.slice(7) ?? ""],
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", autoStopMinutes: 1, wait: true });
		const sweep = async () => {
			await api.service.sweep();
			await api.service.idle();
		};
		clock += 2 * 60_000;

		// Away across its stop time: it isn't stopped, nor written off as `error`, but kept running, its time kept.
		connected = false;
		await sweep();
		expect(await tom.getSandbox(sandbox.id)).toMatchObject({ state: "running", stopsAt: sandbox.stopsAt });
		// Back, but its connection is lost (and replaced) as the stop goes out: the stop never got through, so it is
		// running as it was, though the host is connected again by then.
		[connected, dropOnStop] = [true, true];
		await sweep();
		const handedBack = await tom.getSandbox(sandbox.id);
		expect(handedBack).toMatchObject({ state: "running", stopsAt: sandbox.stopsAt });
		expect(handedBack.reason).toBeUndefined();
		expect(stops).toEqual([]);
		// The next sweep stops it.
		await sweep();
		expect(stops).toEqual([sandbox.id]);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("stopped");

		// A stop the host refuses outright is an error, as before, not retried on every sweep.
		const refused = await tom.createSandbox({ type: "microvm", autoStopMinutes: 1, wait: true });
		clock += 2 * 60_000;
		refuseStop = true;
		await sweep();
		expect((await tom.getSandbox(refused.id)).state).toBe("error");
	});

	it("keeps a fork that was made when a later one in its batch fails, rather than taking it for never made", async () => {
		const stub = createStubBackend();
		// Room for one more machine: as a host's backend does, it makes a batch's targets one by one, so the first is made
		// and the second refused.
		let room = 1;
		const backend: SandboxBackend = {
			...stub,
			async fork(source, targets) {
				const out = [];
				for (const target of targets) {
					if (room-- <= 0) throw new KantelError("unavailable", "The host is full");
					out.push(...(await stub.fork(source, [target])));
				}
				return out;
			},
		};
		const { tom } = setup(backend);
		for (const live of [false, true]) {
			room = 1;
			const source = await tom.createSandbox({ type: "microvm", wait: true });
			await tom.writeFile(source.id, { path: "/home/user/kept.txt", content: "kept" });
			if (!live) await tom.stopSandbox(source.id, { wait: true });
			const { items } = await tom.forkSandbox(source.id, { count: 2, wait: true });
			const [made, refused] = await Promise.all(items.map((fork) => tom.getSandbox(fork.id)));
			// The one made is running, its disk the source's; only the other failed.
			expect(made?.state).toBe("running");
			expect((await tom.readFile(made?.id ?? "", { path: "/home/user/kept.txt" })).content).toBe("kept");
			expect(refused?.state).toBe("error");
			// Stopped and started, the one made is its own machine again, never made anew or refused as never made.
			await tom.stopSandbox(made?.id ?? "", { wait: true });
			expect((await tom.startSandbox(made?.id ?? "", { wait: true })).state).toBe("running");
			expect((await tom.readFile(made?.id ?? "", { path: "/home/user/kept.txt" })).content).toBe("kept");
		}
	});

	it("won't rotate a key that may use the shared hosts for an admin who may not", async () => {
		const { tom, ann, client } = setup(createStubBackend(), { sharedHosts: async (userId) => userId === "usr_tom" });
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "admin" })).code ?? "" });
		const scopes = ["sandboxes:read", "sandboxes:write", "exec"] as const;
		const toms = await tom.createApiKey({ account: org.id, name: "tom's", scopes: [...scopes] });
		const anns = await ann.createApiKey({ account: org.id, name: "ann's", scopes: [...scopes] });

		// Ann, an admin of the account but kept off the shared hosts, can't take Tom's key; it still works, unchanged.
		const refused = await failure(ann.rotateApiKey(toms.key.id));
		expect(refused).toMatchObject({ code: "forbidden", message: SHARED_KEY_REFUSED });
		expect((await client(toms.secret).createSandbox({ wait: true })).state).toBe("running");
		// Her own she may rotate, and it stays off them; Tom may rotate either.
		const hers = await ann.rotateApiKey(anns.key.id);
		expect((await failure(client(hers.secret).createSandbox({ wait: true }))).code).toBe("unavailable");
		expect((await tom.rotateApiKey(anns.key.id)).key.id).toBe(anns.key.id);
		const his = await tom.rotateApiKey(toms.key.id);
		expect((await client(his.secret).createSandbox({ wait: true })).state).toBe("running");
	});

	it("checks again once a sandbox is placed, so a call queued while it starts can't reach a shared host", async () => {
		// The host's reply to the first create is held until `release`, so calls queue behind the placement.
		const stub = createStubBackend();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const backend: SandboxBackend = { ...stub, create: async (input) => held.then(() => stub.create(input)) };
		const { tom, ann } = setup(backend, { sharedHosts: async (userId) => userId === "usr_tom" });
		const org = await tom.createOrganisation({ name: "Acme" });
		await ann.joinOrganisation({ code: (await tom.createInvite(org.id, { role: "member" })).code ?? "" });

		const starting = await tom.createSandbox({ account: org.id });
		expect(starting.state).toBe("starting");
		// Ann finds it while it has no host yet, and queues calls on it; so does Tom.
		expect((await ann.listSandboxes({ account: org.id })).items.map((item) => item.id)).toEqual([starting.id]);
		const annRuns = failure(ann.runCommand(starting.id, { command: "echo hi" }));
		const annWrites = failure(ann.writeFile(starting.id, { path: "/tmp/x", content: "x" }));
		const annStops = failure(ann.stopSandbox(starting.id, {}));
		const tomRuns = tom.runCommand(starting.id, { command: "echo hi" });
		// Long enough for each to be let in (no host yet) and wait on the placement; nothing here takes a millisecond.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await tom.getSandbox(starting.id)).state).toBe("starting");
		release();

		// Once it is on the shared host, hers are refused there and none of them reached it; Tom's ran.
		for (const refused of await Promise.all([annRuns, annWrites, annStops])) {
			expect(refused).toMatchObject({ code: "forbidden", message: SHARED_HOSTS_REFUSED });
		}
		expect((await tomRuns).stdout).toBe("hi\n");
		const after = await tom.getSandbox(starting.id);
		expect(after.state).toBe("running");
		await expect(tom.readFile(starting.id, { path: "/tmp/x" })).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("hosts", () => {
	it("needs hosts:admin", async () => {
		const { api, client, root, tom } = setup();
		expect((await failure(tom.listHosts())).code).toBe("forbidden");
		const plain = client((await root.createApiKey({ name: "plain", preset: "admin" })).secret);
		expect((await failure(plain.listHosts())).code).toBe("forbidden");

		const ops = client((await root.createApiKey({ name: "ops", scopes: ["hosts:admin"] })).secret);
		const hosts = await ops.listHosts();
		expect(hosts.items.map((host) => host.id)).toEqual([STUB_HOST_ID]);
		const token = await ops.createHostJoinToken({ name: "box" });
		expect(token.token).toMatch(/^kth_/);
		expect(token.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url http://compute.test --token ${token.token}`,
		);

		const drained = await ops.updateHost(STUB_HOST_ID, { draining: true });
		expect(drained.state).toBe("draining");
		expect((await failure(tom.createSandbox({}))).code).toBe("unavailable");

		expect(await api.fetch(new Request("http://compute.test/v1/sessions"))).toBeUndefined();
		expect(await api.fetch(new Request("http://compute.test/elsewhere"))).toBeUndefined();
	});

	it("sets the public URL join commands use, and goes back to the deployment's own", async () => {
		const { root, tom } = setup();
		const before = await root.getPublicUrl();
		expect(before).toEqual({
			publicUrl: "http://compute.test",
			source: "deployment",
			deploymentUrl: "http://compute.test",
			loopback: false,
		});
		expect((await failure(tom.getPublicUrl())).code).toBe("forbidden");
		expect((await failure(tom.setPublicUrl({ publicUrl: "https://kantel.example.com" }))).code).toBe("forbidden");

		const set = await root.setPublicUrl({ publicUrl: "https://kantel.example.com/" });
		expect(set).toEqual({
			publicUrl: "https://kantel.example.com",
			source: "console",
			deploymentUrl: "http://compute.test",
			loopback: false,
		});
		const token = await root.createHostJoinToken({});
		expect(token.command).toContain(`--url https://kantel.example.com --token ${token.token}`);

		for (const bad of ["kantel.example.com", "ftp://kantel.example.com", "https://kantel.example.com/console"]) {
			expect((await failure(root.setPublicUrl({ publicUrl: bad }))).code).toBe("invalid");
		}
		// A host the URL parser allows but a shell would run, when the join command is pasted.
		for (const bad of [
			"https://$(id).example.com",
			"https://`id`.example.com",
			"http://a;id.example.com",
			"http://a&b.com",
		]) {
			expect((await failure(root.setPublicUrl({ publicUrl: bad }))).code).toBe("invalid");
		}
		expect((await root.getPublicUrl()).publicUrl).toBe("https://kantel.example.com");
		const safe = await root.createHostJoinToken({});
		expect(safe.command).toContain(`--url https://kantel.example.com --token ${safe.token}`);

		expect(await root.setPublicUrl({ publicUrl: "http://127.0.0.1:58090" })).toMatchObject({ loopback: true });
		expect(await root.setPublicUrl({ publicUrl: null })).toEqual(before);
		expect((await root.createHostJoinToken({})).command).toContain("--url http://compute.test --token");
	});

	it("tells a loopback public URL from one other machines can reach", () => {
		for (const url of ["http://127.0.0.1:58090", "http://localhost:8080", "http://[::1]:58090", "http://0.0.0.0"]) {
			expect(isLoopbackUrl(url)).toBe(true);
		}
		for (const url of ["https://kantel.example.com", "http://10.0.0.5:58090", "http://kantel.tail1234.ts.net"]) {
			expect(isLoopbackUrl(url)).toBe(false);
		}
		expect(publicOrigin(" https://Kantel.Example.com/ ")).toBe("https://kantel.example.com");
		// DNS names, ports, IPv4 and IPv6, and an international name in its punycode form.
		expect(publicOrigin("http://10.0.0.5:58090")).toBe("http://10.0.0.5:58090");
		expect(publicOrigin("http://[fd00::5]:58090/")).toBe("http://[fd00::5]:58090");
		expect(publicOrigin("https://kantel.tail1234.ts.net:8443")).toBe("https://kantel.tail1234.ts.net:8443");
		expect(publicOrigin("https://bücher.example")).toBe("https://xn--bcher-kva.example");
		for (const bad of ["https://$(id).example.com", "https://a'b.example.com", "https://a!b.example.com"]) {
			expect(() => publicOrigin(bad)).toThrow("domain name or an IP address");
		}
	});

	it("keeps a revocation that lands while a drain is in flight", async () => {
		const stub = createStubBackend();
		let revokeMeanwhile: (() => Promise<unknown>) | undefined;
		const { client, root } = setup({
			...stub,
			// Between the drain reading the host and writing it, another call revokes it.
			async updateHost(hostId, change) {
				const revoke = revokeMeanwhile;
				revokeMeanwhile = undefined;
				await revoke?.();
				return stub.updateHost?.(hostId, change);
			},
		});
		const ops = client((await root.createApiKey({ name: "ops", scopes: ["hosts:admin"] })).secret);
		revokeMeanwhile = () => ops.revokeHost(STUB_HOST_ID);
		expect((await failure(ops.updateHost(STUB_HOST_ID, { draining: true }))).code).toBe("conflict");
		const listed = await ops.listHosts();
		expect(listed.items.find((host) => host.id === STUB_HOST_ID)?.state).toBe("revoked");
		// And the next capabilities refresh doesn't bring it back.
		expect((await ops.listHosts()).items.find((host) => host.id === STUB_HOST_ID)?.state).toBe("revoked");
	});
});

describe("people's names", () => {
	it("shows a person whose record has their user ID for a name by their email, without them signing in again", async () => {
		// Gateways once named everyone by their user ID, and wrote it back on every sign-in.
		const store = createMemoryStore();
		const legacy = "usr_4e473b3d-2b96-4bbf-9427-98be4e40ecff";
		const api = createComputeApi({
			backend: createStubBackend(),
			store,
			authenticatePerson: async (request) => {
				const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
				return token === undefined ? undefined : PEOPLE[token];
			},
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const tom = createKantelClient({
			baseUrl: BASE_URL,
			token: "tom-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const org = await tom.createOrganisation({ name: "Acme" });
		await store.accounts.put({
			id: "acc_alex",
			kind: "personal",
			name: legacy,
			defaultVisibility: "private",
			createdAt: 1,
		});
		await store.users.put({
			id: legacy,
			name: legacy,
			email: "alex@example.com",
			superAdmin: false,
			personalAccountId: "acc_alex",
			createdAt: 1,
		});
		await store.members.put({
			id: `${org.id}:${legacy}`,
			accountId: org.id,
			userId: legacy,
			role: "owner",
			joinedAt: 2,
		});
		await store.apiKeys.put({
			id: "key_alex",
			accountId: org.id,
			name: "alex's",
			prefix: "ksk_abcd",
			scopes: ["sandboxes:read"],
			createdBy: { kind: "user", id: legacy, name: legacy },
			createdAt: 3,
			secretHash: "0".repeat(64),
			ownerUserId: legacy,
		});

		const members = await tom.listMembers(org.id);
		expect(members.items.map((member) => [member.userId, member.name])).toEqual(
			expect.arrayContaining([
				["usr_tom", "Tom"],
				[legacy, "alex@example.com"],
			]),
		);
		const keys = await tom.listApiKeys({ account: org.id });
		expect(keys.items.find((key) => key.id === "key_alex")?.createdBy).toEqual({
			kind: "user",
			id: legacy,
			name: "alex@example.com",
		});
		expect((await tom.getApiKey("key_alex")).createdBy.name).toBe("alex@example.com");
		// What Tom makes says who he is, and so does what he made while his record said only his user ID.
		const sandbox = await tom.createSandbox({ account: org.id, wait: true });
		expect(sandbox.createdBy).toEqual({ kind: "user", id: "usr_tom", name: "Tom" });
		await store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			createdBy: { kind: "user", id: "usr_tom", name: "usr_tom" },
		}));
		expect((await tom.getSandbox(sandbox.id)).createdBy.name).toBe("Tom");
		const listed = await tom.listSandboxes({ account: org.id });
		expect(listed.items.find((item) => item.id === sandbox.id)?.createdBy.name).toBe("Tom");
	});

	it("names a personal account made with its person's user ID as they are now", async () => {
		const store = createMemoryStore();
		const api = createComputeApi({
			backend: createStubBackend(),
			store,
			authenticatePerson: async () => PEOPLE["ann-token"],
			fetch: async () => new Response(null, { status: 204 }),
		});
		opened.push(api);
		const ann = createKantelClient({
			baseUrl: BASE_URL,
			token: "ann-token",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const caller = await ann.getCaller();
		const personal = caller.accounts.find((account) => account.kind === "personal");
		if (personal === undefined) throw new Error("no personal account");
		await store.accounts.update(personal.id, (current) => ({ ...current, name: "usr_ann" }));
		expect((await ann.getCaller()).accounts.find((account) => account.id === personal.id)?.name).toBe("Ann");
		expect((await ann.getAccount(personal.id)).name).toBe("Ann");
	});
});
