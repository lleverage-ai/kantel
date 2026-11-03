import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
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
