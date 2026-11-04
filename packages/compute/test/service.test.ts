import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import {
	checkShape,
	hourlyRate,
	microvmShapes,
	NEVER_MADE,
	PLACEHOLDER_RATES,
	SHARED_HOSTS_REFUSED,
	SHARED_KEY_REFUSED,
} from "../src/service.ts";
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
	extra: Pick<Parameters<typeof createComputeApi>[0], "sharedHosts"> = {},
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
		expect(shapes.microvm?.presets.map((preset) => [preset.name, preset.warm])).toEqual([
			["small", false],
			["default", false],
			["large", false],
			["xlarge", false],
		]);
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

	it("puts no warm presets on offer where no host keeps a pool, and marks the ones it does", () => {
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
		const warm = microvmShapes([{ ...host, features: ["custom-shapes"], pools: { "microvm/default": 1 } }], sizes);
		expect(warm).toMatchObject({ vcpus: { max: 8 }, memoryMb: { max: 16_384 }, custom: true });
		expect(warm?.presets).toEqual([{ name: "default", vcpus: 2, memoryMb: 2048, diskGb: 20, warm: true }]);
		expect(microvmShapes([], sizes)).toBeUndefined();
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
