// The compute console's API source against the real compute API, in process: `@kantel/compute`'s `createComputeApi`
// over its stub backend, with `fetch` handing each call straight to the API. Each test opens its own API and closes it
// after. Lifecycle calls answer as soon as the work is under way, so a test waits for `api.service.idle()` before it
// looks at a settled state.

import { createKantelClient } from "@kantel/api/sdk";
import { type AuthenticatePerson, type ComputeApi, createComputeApi, type PersonIdentity } from "@kantel/compute";
import { createStubBackend, STUB_HOST_ID } from "@kantel/compute/stub";
import type { ComputeSource } from "@kantel/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiCompute } from "./api-source.ts";
import { localBridge } from "./local.ts";

const ORIGIN = "https://kantel.test";

/** People the authenticator knows, by their whole `authorization` header. */
const PEOPLE: Readonly<Record<string, PersonIdentity>> = {
	"Bearer person-ada": { userId: "u_ada", name: "Ada", superAdmin: true },
	"Bearer person-bob": { userId: "u_bob", name: "Bob" },
};

const authenticatePerson: AuthenticatePerson = async (request) => PEOPLE[request.headers.get("authorization") ?? ""];

const opened: ComputeApi[] = [];

afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

/** A 404 as a gateway answers one, for a path no route serves. */
const notFound = (): Response =>
	new Response(JSON.stringify({ error: { code: "not_found", message: "No such route" } }), {
		status: 404,
		headers: { "content-type": "application/json" },
	});

/** A fresh API, and a `fetch` that hands each call to it. */
function setup(options: { accountHosts?: boolean } = {}) {
	const api = createComputeApi({
		backend: createStubBackend(),
		authenticatePerson,
		...options,
		// Webhook deliveries and telemetry exports: every endpoint takes them.
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const fetchApi: typeof fetch = async (input, init) => {
		const request =
			typeof input === "string" || input instanceof URL
				? new Request(new URL(input, ORIGIN), init)
				: new Request(input, init);
		return (await api.fetch(request)) ?? notFound();
	};
	return { api, fetchApi };
}

/** The console's source as `token` signs in. */
function open(fetchApi: typeof fetch, token = "person-ada", onUnauthenticated?: () => void): Promise<ComputeSource> {
	return apiCompute({
		headers: () => ({ authorization: `Bearer ${token}` }),
		fetch: fetchApi,
		...(onUnauthenticated === undefined ? {} : { onUnauthenticated }),
	});
}

/** The viewer's personal account's ID. */
async function personalAccount(source: ComputeSource): Promise<string> {
	const [personal] = await source.accounts.list();
	if (personal === undefined) throw new Error("No personal account");
	return personal.id;
}

describe("apiCompute", () => {
	it("rejects when the API answers 404 to everything", async () => {
		await expect(apiCompute({ fetch: async () => notFound() })).rejects.toMatchObject({ status: 404 });
	});

	it("is self-hosted with no billing by default", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		expect(source.hosting).toBe("self-hosted");
		expect(source.billing).toBeUndefined();
		expect(source.domain).toBe("localhost");
	});

	it("calls onUnauthenticated on a 401", async () => {
		const { fetchApi } = setup();
		const onUnauthenticated = vi.fn();
		let token = "person-ada";
		const source = await apiCompute({
			headers: () => ({ authorization: `Bearer ${token}` }),
			fetch: fetchApi,
			onUnauthenticated,
		});
		expect(onUnauthenticated).not.toHaveBeenCalled();
		token = "person-gone";
		await expect(source.accounts.list()).rejects.toMatchObject({ status: 401 });
		expect(onUnauthenticated).toHaveBeenCalledTimes(1);
	});
});

describe("accounts", () => {
	it("lists the personal account, creates an organisation and reads the viewer", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);

		const [personal, ...others] = await source.accounts.list();
		expect(others).toEqual([]);
		expect(personal).toMatchObject({ kind: "personal", role: "owner", members: 1 });

		const organisation = await source.accounts.createOrganisation({ name: "Analytical Engines", slug: "engines" });
		expect(organisation).toMatchObject({ kind: "organisation", name: "Analytical Engines", role: "owner" });
		const accounts = await source.accounts.list();
		expect(accounts.map((account) => account.kind)).toEqual(["personal", "organisation"]);
		expect(accounts[1]?.id).toBe(organisation.id);

		expect(await source.accounts.viewer()).toEqual({ id: "u_ada", name: "Ada", email: "", superAdmin: true });
	});
});

describe("sandboxes", () => {
	it("creates, lists, stops, resumes, forks and deletes", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		const made = await source.sandboxes.create({ accountId, name: "lab", kind: "isolate" });
		expect(made).toMatchObject({ name: "lab", accountId, kind: "isolate", state: "starting", createdBy: "Ada" });
		expect(made.stopsAt).toBeUndefined();
		await api.service.idle();
		const [listed] = await source.sandboxes.list(accountId);
		expect(listed).toMatchObject({ id: made.id, state: "running", shared: false });
		expect(listed?.hostname).toMatch(/^lab-[a-z0-9]+\.localhost$/);

		expect((await source.sandboxes.stop(made.id)).state).toBe("stopping");
		await api.service.idle();
		const [stopped] = await source.sandboxes.list(accountId);
		expect(stopped?.state).toBe("stopped");
		expect(stopped?.snapshot?.id).toMatch(/^snap_/);

		expect((await source.sandboxes.resume(made.id)).state).toBe("starting");
		await api.service.idle();

		const fork = await source.sandboxes.fork(made.id);
		expect(fork.id).not.toBe(made.id);
		expect(fork.forkedFrom).toBe(made.id);
		await api.service.idle();
		expect((await source.sandboxes.list(accountId)).map((sandbox) => sandbox.state)).toEqual(["running", "running"]);

		await source.sandboxes.remove(fork.id);
		await api.service.idle();
		expect((await source.sandboxes.list(accountId)).map((sandbox) => sandbox.id)).toEqual([made.id]);
	});

	it("reads an E2E sandbox's history from its host through kantel console, and others' from the gateway", async () => {
		const { api, fetchApi } = setup();
		const plain = await open(fetchApi);
		const accountId = await personalAccount(plain);
		const made = await plain.sandboxes.create({ accountId, kind: "isolate" });
		await api.service.idle();
		expect(await plain.e2e?.mode(accountId)).toBe("off");
		expect(plain.e2e?.served).toBe("gateway");
		// The gateway's console frames Browser and Desktop on the page, and reads files and output as ever.
		expect(plain.sandboxes.screens).toBe("console");
		await plain.sandboxes.list(accountId);
		expect(await plain.sandboxes.endToEnd?.(made.id)).toBe(false);

		const calls: { sandboxId: string; method: string; params: { before?: string } }[] = [];
		// The host's history, newest first, in pages of one: a console that drops the cursor sees only the newest.
		const kept = [
			{ id: "c2", command: "make test", startedAt: 2000, endedAt: 2100, device: "d1", deviceLabel: "Ada's laptop" },
			{
				id: "c1",
				command: "make",
				startedAt: 1000,
				endedAt: 1250,
				exitCode: 0,
				device: "d1",
				deviceLabel: "Ada's laptop",
			},
		];
		const localFetch: typeof fetch = async (input, init) => {
			const path = String(input);
			if (path === "/local/info") {
				return Response.json({
					local: true,
					device: { id: "d1", label: "Ada's laptop" },
					spaces: [{ id: accountId, mode: "on" }],
				});
			}
			if (path === "/local/e2e") {
				const call = JSON.parse(String(init?.body)) as (typeof calls)[number];
				calls.push(call);
				const from = call.params.before === undefined ? 0 : kept.findIndex((c) => c.id === call.params.before) + 1;
				const items = kept.slice(from, from + 1);
				const next = from + 1 < kept.length ? items.at(-1)?.id : undefined;
				return Response.json({ result: { items, ...(next === undefined ? {} : { next }) } });
			}
			return fetchApi(input, init);
		};
		// Only on 127.0.0.1 does the console ask for kantel console's bridge.
		expect(await localBridge(localFetch, "kantel.example.com")).toBeUndefined();
		const local = await localBridge(localFetch, "127.0.0.1");
		expect(local?.mode(accountId)).toBe("on");
		expect(local?.mode("acct_elsewhere")).toBe("off");
		const source = await apiCompute({
			headers: () => ({ authorization: "Bearer person-ada" }),
			fetch: fetchApi,
			...(local === undefined ? {} : { local }),
		});
		expect(source.e2e).toMatchObject({ served: "local", device: "Ada's laptop" });
		// kantel console's page frames nothing from the gateway: Browser and Desktop open in tabs of their own.
		expect(source.sandboxes.screens).toBe("tab");
		// Its files and output can't be read end to end yet; the page says so. Opened straight from its address, the
		// console reads which account it's in first.
		expect(await source.sandboxes.endToEnd?.(made.id)).toBe(true);
		await source.sandboxes.list(accountId);
		expect(await source.sandboxes.endToEnd?.(made.id)).toBe(true);
		expect(await source.sandboxes.history(made.id)).toEqual([
			{ id: "c2", command: "make test", startedAt: 2000, durationMs: 100, by: "Ada's laptop" },
			{ id: "c1", command: "make", startedAt: 1000, durationMs: 250, exitCode: 0, by: "Ada's laptop" },
		]);
		expect(calls).toEqual([
			{ sandboxId: made.id, method: "sandbox.history", params: { limit: 100, output: false } },
			{ sandboxId: made.id, method: "sandbox.history", params: { limit: 100, output: false, before: "c2" } },
		]);
	});

	it("lists and reads an E2E sandbox's files over the console's own session, never the gateway's file routes", async () => {
		const { api, fetchApi } = setup();
		const plain = await open(fetchApi);
		const accountId = await personalAccount(plain);
		const made = await plain.sandboxes.create({ accountId, kind: "isolate" });
		await api.service.idle();
		const calls: { sandboxId: string; method: string; params: object }[] = [];
		const gatewayFiles: string[] = [];
		const bytes = new TextEncoder().encode("Hello, world");
		const localFetch: typeof fetch = async (input, init) => {
			const path = String(input);
			if (path === "/local/info") {
				return Response.json({
					local: true,
					device: { id: "d1", label: "Ada's laptop" },
					spaces: [{ id: accountId, mode: "on" }],
				});
			}
			if (path === "/local/e2e") {
				const call = JSON.parse(String(init?.body)) as (typeof calls)[number] & {
					params: { offset?: number; length?: number };
				};
				calls.push(call);
				if (call.method === "sandbox.files.list") {
					const entries = [
						{ name: "readme.txt", path: "/home/user/readme.txt", type: "file", size: 12, modTimeMs: 5 },
						{ name: "app", path: "/home/user/app", type: "dir", size: 4096 },
					];
					return Response.json({ result: { entries } });
				}
				const { offset = 0, length = bytes.byteLength } = call.params;
				const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + length)));
				return Response.json({ result: { data, fileSize: bytes.byteLength } });
			}
			if (new URL(path, ORIGIN).pathname.includes("/files")) gatewayFiles.push(path);
			return fetchApi(input, init);
		};
		const local = await localBridge(localFetch, "127.0.0.1");
		const source = await apiCompute({
			headers: () => ({ authorization: "Bearer person-ada" }),
			fetch: localFetch,
			...(local === undefined ? {} : { local }),
		});
		const files = source.sandboxes.files;
		if (files === undefined) throw new Error("No files");
		const folder = await files.list(made.id, "home/user");
		expect(folder).toEqual({
			entries: [
				{ name: "app", path: "home/user/app", kind: "folder" },
				{ name: "readme.txt", path: "home/user/readme.txt", kind: "file", sizeBytes: 12, modifiedAt: 5 },
			],
			more: false,
		});
		const part = await files.read(made.id, "home/user/readme.txt", { offset: 7, length: 5 });
		expect([new TextDecoder().decode(part.bytes), part.size]).toEqual(["world", 12]);
		expect(calls).toEqual([
			{ sandboxId: made.id, method: "sandbox.files.list", params: { path: "/home/user" } },
			{
				sandboxId: made.id,
				method: "sandbox.files.read",
				params: { path: "/home/user/readme.txt", offset: 7, length: 5 },
			},
		]);
		// The gateway relays the session and serves none of the files.
		expect(gatewayFiles).toEqual([]);
	});

	it("shows what the host gave a microVM, and names sizes without figures", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const made = await source.sandboxes.create({ accountId, kind: "microvm", shape: { vcpus: 4, memoryMb: 8192 } });
		await api.service.idle();
		const [listed] = await source.sandboxes.list(accountId);
		// The stub backend's "default" is 2 vCPU and 4 GB, not the sample catalogue's 4 and 8.
		expect(listed).toMatchObject({ id: made.id, size: "medium", resources: { vcpus: 2, memoryGb: 4, diskGb: 20 } });
	});

	it("reads one for its page, sets its auto-stop, and reads its live files and a failed command's output", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const made = await source.sandboxes.create({ accountId, name: "page", kind: "isolate" });
		await api.service.idle();

		expect(await source.sandboxes.get(made.id)).toMatchObject({ id: made.id, name: "page", state: "running" });
		const set = source.sandboxes.setAutoStop;
		if (set === undefined) throw new Error("No setAutoStop");
		expect((await set(made.id, 60)).stopsAt).toBeGreaterThan(Date.now());
		expect((await set(made.id, undefined)).stopsAt).toBeUndefined();

		const sdk = createKantelClient({ baseUrl: "/v1", token: "person-ada", fetch: fetchApi });
		await sdk.writeFile(made.id, { path: "work/readme.txt", content: "Hello" });
		const files = source.sandboxes.files;
		if (files === undefined) throw new Error("No files");
		const folder = await files.list(made.id, "home/user/work");
		expect(folder.entries.map((entry) => [entry.kind, entry.path])).toEqual([["file", "home/user/work/readme.txt"]]);
		expect(folder.more).toBe(false);
		// A folder that runs on past the pages it reads says so, rather than looking complete.
		let pages = 0;
		const endless = await open(async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (!new URL(url, "https://kantel.test").pathname.endsWith("/files/list")) return fetchApi(input, init);
			pages += 1;
			const entry = { name: `f${pages}`, path: `/home/user/f${pages}`, kind: "file", size: 1 };
			return Response.json({ items: [entry], nextCursor: `c${pages}` });
		});
		const cut = await endless.sandboxes.files?.list(made.id, "home/user");
		expect(cut?.more).toBe(true);
		expect(cut?.entries).toHaveLength(pages);
		expect(pages).toBe(20);
		// A part at a time, as the preview reads it: the bytes asked for, and the whole file's size.
		const text = (part: { bytes: Uint8Array }) => new TextDecoder().decode(part.bytes);
		const whole = await files.read(made.id, "home/user/work/readme.txt", { offset: 0, length: 256 * 1024 });
		expect([text(whole), whole.size]).toEqual(["Hello", 5]);
		const part = await files.read(made.id, "home/user/work/readme.txt", { offset: 1, length: 3 });
		expect([text(part), part.size]).toEqual(["ell", 5]);

		await sdk.runCommand(made.id, { command: "echo fine" });
		await sdk.runCommand(made.id, { command: "echo broken >&2; exit 2" });
		const commands = await source.sandboxes.history(made.id);
		const failed = commands.find((command) => command.exitCode !== undefined && command.exitCode !== 0);
		const fine = commands.find((command) => command.exitCode === 0);
		expect(fine?.output).toBeUndefined();
		expect(failed?.output).toContain("broken");
	});
});

describe("snapshots", () => {
	it("lists a stop's snapshot and its files, and saves one under a name", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const sandbox = await source.sandboxes.create({ accountId, kind: "isolate" });
		await api.service.idle();
		// The UI source runs no commands, so the SDK writes the files.
		const sdk = createKantelClient({ baseUrl: "/v1", token: "person-ada", fetch: fetchApi });
		await sdk.writeFile(sandbox.id, { path: "work/readme.txt", content: "Hello" });
		await sdk.writeFile(sandbox.id, { path: "work/notes/todo.md", content: "# To do" });

		await source.sandboxes.stop(sandbox.id);
		await api.service.idle();
		const [taken, ...older] = await source.snapshots.history(sandbox.id);
		expect(older).toEqual([]);
		expect(taken).toMatchObject({ sandboxId: sandbox.id, reason: "stop" });
		if (taken === undefined) throw new Error("No snapshot");

		const entries = await source.snapshots.list(taken.id, "home/user/work");
		expect(entries.map((entry) => [entry.kind, entry.path])).toEqual([
			["folder", "home/user/work/notes"],
			["file", "home/user/work/readme.txt"],
		]);
		expect(entries[1]?.sizeBytes).toBe(5);
		const read = await source.snapshots.read(taken.id, "home/user/work/readme.txt", { offset: 0, length: 1024 });
		expect([new TextDecoder().decode(read.bytes), read.size]).toEqual(["Hello", 5]);

		const saved = await source.snapshots.save(sandbox.id, "golden");
		expect(saved).toMatchObject({ name: "golden", accountId, sandboxId: sandbox.id, sandboxName: sandbox.name });
		expect((await source.snapshots.saved(accountId)).map((entry) => entry.id)).toEqual([saved.id]);

		await source.snapshots.removeSaved(saved.id);
		expect(await source.snapshots.saved(accountId)).toEqual([]);
	});
});

describe("keys", () => {
	it("creates a key, showing its secret once, lists it and revokes it", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		const created = await source.keys.create({ accountId, name: "CI", scopes: ["sandboxes:read"] });
		expect(created.secret).toMatch(/^ksk_/);
		expect(created.key).toMatchObject({ name: "CI", accountId, scopes: ["sandboxes:read"], createdBy: "Ada" });

		const [listed] = await source.keys.list(accountId);
		expect(listed?.id).toBe(created.key.id);
		expect(JSON.stringify(listed)).not.toContain(created.secret);

		const revoked = await source.keys.revoke(created.key.id);
		expect(revoked.revokedAt).toBeTypeOf("number");
	});
});

describe("webhooks", () => {
	it("creates, lists, updates, tests and deletes a webhook", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		const { webhook, secret } = await source.webhooks.create({
			accountId,
			url: "https://hooks.example.com/kantel",
			description: "Deploy bot",
			events: ["sandbox.created", "sandbox.stopped"],
		});
		expect(secret).toMatch(/^whsec_/);
		expect(webhook).toMatchObject({ description: "Deploy bot", enabled: true, secretPrefix: secret.slice(0, 10) });

		expect((await source.webhooks.list(accountId)).map((hook) => hook.id)).toEqual([webhook.id]);

		const updated = await source.webhooks.update(webhook.id, { enabled: false, description: "" });
		expect(updated.enabled).toBe(false);
		expect(updated.description).toBeUndefined();

		const sent = await source.webhooks.test(webhook.id);
		expect(sent).toMatchObject({ event: "sandbox.created", ok: true, status: 204 });
		expect((await source.webhooks.deliveries(webhook.id)).map((delivery) => delivery.id)).toContain(sent.id);

		await source.webhooks.remove(webhook.id);
		expect(await source.webhooks.list(accountId)).toEqual([]);
	});
});

describe("telemetry", () => {
	it("reads no export, saves one, tests it and turns it off", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		expect(await source.telemetry.get(accountId)).toMatchObject({ enabled: false, endpoint: "", headers: [] });

		const saved = await source.telemetry.update(accountId, {
			endpoint: "https://otel.example.com/otlp",
			headers: { "x-api-key": "secret" },
			metrics: true,
			events: false,
		});
		expect(saved).toMatchObject({
			enabled: true,
			endpoint: "https://otel.example.com/otlp",
			headers: ["x-api-key"],
			metrics: true,
			events: false,
			lastExport: { ok: true },
		});
		expect(await source.telemetry.get(accountId)).toEqual(saved);
		expect((await source.telemetry.test(accountId)).ok).toBe(true);

		await expect(source.telemetry.update(accountId, { protocol: "grpc" })).rejects.toThrow(/OTLP\/HTTP/);

		expect((await source.telemetry.update(accountId, { enabled: false })).enabled).toBe(false);
		expect((await source.telemetry.get(accountId)).endpoint).toBe("");
	});
});

describe("proxy", () => {
	it("reads the defaults and updates the policy and upstream", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		expect(await source.proxy.get(accountId)).toEqual({
			accountId,
			enabled: false,
			policy: "open",
			allow: [],
			deny: [],
		});

		const updated = await source.proxy.update(accountId, {
			enabled: true,
			policy: "allowlist",
			allow: ["api.github.com"],
			upstream: { url: "http://upstream.example:3128", auth: "ada:lovelace" },
		});
		expect(updated).toMatchObject({
			enabled: true,
			policy: "allowlist",
			allow: ["api.github.com"],
			upstream: { url: "http://upstream.example:3128", authSet: true },
		});

		// A change that leaves the upstream out keeps it and its credentials.
		const denied = await source.proxy.update(accountId, { deny: ["evil.example"] });
		expect(denied).toMatchObject({ deny: ["evil.example"], upstream: { authSet: true } });

		const removed = await source.proxy.update(accountId, {
			upstream: { url: "http://upstream.example:3128", auth: "" },
		});
		expect(removed.upstream).toEqual({ url: "http://upstream.example:3128", authSet: false });

		// The API keeps each sandbox's log, with no switch to stop it.
		await expect(source.proxy.update(accountId, { logRequests: false })).rejects.toThrow(/always keeps/);
	});

	it("goes from Nothing to Allowed hosts with the first host in one change, an IPv4 address included", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		const closed = await source.proxy.update(accountId, { policy: "closed" });
		expect(closed).toMatchObject({ policy: "closed", allow: [] });
		// Allowed hosts alone can't be had: with nothing allowed the API reads it back as Nothing.
		expect(await source.proxy.update(accountId, { policy: "allowlist" })).toMatchObject({ policy: "closed" });

		const opened = await source.proxy.update(accountId, { policy: "allowlist", allow: ["1.1.1.1"] });
		expect(opened).toMatchObject({ policy: "allowlist", allow: ["1.1.1.1"] });
		expect(await source.proxy.get(accountId)).toMatchObject({ policy: "allowlist", allow: ["1.1.1.1"] });

		// Removing the last host for every sandbox is Nothing again.
		expect(await source.proxy.update(accountId, { allow: [] })).toMatchObject({ policy: "closed" });
	});
});

describe("environments", () => {
	const SECRET = "ghp_CONSOLESECRET123";

	it("creates one, sets its variables, files, repositories and grants, renames it and deletes it", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);

		const made = await source.environments.create({ accountId, name: "backend", description: "The API's" });
		expect(made).toMatchObject({
			accountId,
			name: "backend",
			description: "The API's",
			variables: [],
			files: [],
			repos: [],
			grants: [],
			sandboxCount: 0,
		});
		expect((await source.environments.list(accountId)).map((environment) => environment.id)).toEqual([made.id]);
		expect((await source.environments.get(made.id)).name).toBe("backend");

		await source.environments.setVariable(made.id, {
			name: "LOG_LEVEL",
			protected: false,
			value: "debug",
			bindings: [],
		});
		const withToken = await source.environments.setVariable(made.id, {
			name: "GH_TOKEN",
			protected: true,
			value: SECRET,
			bindings: [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET"] }],
		});
		expect(withToken.variables).toEqual([
			{ name: "LOG_LEVEL", protected: false, value: "debug", bindings: [], updatedAt: expect.any(Number) },
			{
				name: "GH_TOKEN",
				protected: true,
				bindings: [{ host: "api.github.com", pathPrefixes: ["/repos/"], methods: ["GET"] }],
				updatedAt: expect.any(Number),
			},
		]);
		expect(JSON.stringify(withToken)).not.toContain(SECRET);
		// New bindings without the value keep it; empty lists are any path and any method.
		const rebound = await source.environments.setVariable(made.id, {
			name: "GH_TOKEN",
			protected: true,
			bindings: [{ host: "*.github.com", pathPrefixes: [], methods: [] }],
		});
		expect(rebound.variables[1]?.bindings).toEqual([{ host: "*.github.com", pathPrefixes: [], methods: [] }]);
		await expect(
			source.environments.setVariable(made.id, { name: "NO_BINDINGS", protected: true, value: SECRET, bindings: [] }),
		).rejects.toMatchObject({ code: "invalid" });

		const npmrc = "//registry.npmjs.org/:_authToken=npm_x\n";
		const withFile = await source.environments.setFile(made.id, {
			path: "/home/user/.npmrc",
			mode: 0o600,
			content: npmrc,
		});
		expect(withFile.files).toEqual([
			{ path: "/home/user/.npmrc", mode: 0o600, sizeBytes: npmrc.length, updatedAt: expect.any(Number) },
		]);
		// Left out, the contents are kept.
		const chmod = await source.environments.setFile(made.id, { path: "/home/user/.npmrc", mode: 0o400 });
		expect(chmod.files).toEqual([
			{ path: "/home/user/.npmrc", mode: 0o400, sizeBytes: npmrc.length, updatedAt: expect.any(Number) },
		]);

		const withRepos = await source.environments.setRepos(made.id, [
			{ url: "https://github.com/lleverage-ai/kantel", ref: "main" },
			{ url: "https://github.com/lleverage-ai/docs", path: "/home/user/work/docs" },
		]);
		expect(withRepos.repos).toEqual([
			{ url: "https://github.com/lleverage-ai/kantel", ref: "main" },
			{ url: "https://github.com/lleverage-ai/docs", path: "/home/user/work/docs" },
		]);

		const withGrants = await source.environments.setGrants(made.id, [
			{ id: "grt_new_1", action: "deny", host: "api.github.com", methods: ["DELETE"], paths: ["/repos/*"] },
			{ id: "grt_new_2", action: "allow", host: "registry.npmjs.org", methods: [], paths: [] },
		]);
		expect(withGrants.grants).toEqual([
			{
				id: expect.stringMatching(/^grt_[a-z0-9]+$/),
				action: "deny",
				host: "api.github.com",
				methods: ["DELETE"],
				paths: ["/repos/*"],
			},
			{
				id: expect.stringMatching(/^grt_[a-z0-9]+$/),
				action: "allow",
				host: "registry.npmjs.org",
				methods: [],
				paths: [],
			},
		]);
		// Saved again as the page has them, they keep their IDs.
		const again = await source.environments.setGrants(made.id, withGrants.grants);
		expect(again.grants).toEqual(withGrants.grants);
		// Written from an older read, Kantel refuses with `conflict` and the grants stay as they are.
		const stale = [withGrants.grants[0]];
		await expect(
			source.environments.setGrants(
				made.id,
				[],
				stale.filter((g) => g !== undefined),
			),
		).rejects.toMatchObject({ code: "conflict" });
		expect((await source.environments.get(made.id)).grants).toEqual(withGrants.grants);
		// Written from the current read, it's taken.
		const kept = await source.environments.setGrants(made.id, withGrants.grants, withGrants.grants);
		expect(kept.grants).toEqual(withGrants.grants);

		const renamed = await source.environments.update(made.id, { name: "api", description: "" });
		expect(renamed.name).toBe("api");
		expect(renamed.description).toBeUndefined();

		const fewer = await source.environments.removeVariable(made.id, "LOG_LEVEL");
		expect(fewer.variables.map((variable) => variable.name)).toEqual(["GH_TOKEN"]);
		expect((await source.environments.removeFile(made.id, "/home/user/.npmrc")).files).toEqual([]);

		await source.environments.remove(made.id);
		expect(await source.environments.list(accountId)).toEqual([]);
	});
});

describe("egress", () => {
	it("makes a sandbox from an environment and reads its protected variables, grants and log", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const environment = await source.environments.create({ accountId, name: "backend" });
		await source.environments.setVariable(environment.id, {
			name: "GH_TOKEN",
			protected: true,
			value: "ghp_CONSOLESECRET123",
			bindings: [{ host: "api.github.com", pathPrefixes: [], methods: [] }],
		});
		await source.environments.setGrants(environment.id, [
			{ id: "grt_new_1", action: "allow", host: "registry.npmjs.org", methods: [], paths: [] },
		]);

		const sandbox = await source.sandboxes.create({
			accountId,
			kind: "isolate",
			environmentId: environment.id,
		});
		expect(sandbox.environment).toEqual({ id: environment.id, name: "backend" });
		await api.service.idle();
		const [listed] = await source.sandboxes.list(accountId);
		expect(listed?.environment).toEqual({ id: environment.id, name: "backend" });
		// A console that hasn't read the environment learns its name from the list.
		const fresh = await open(fetchApi);
		const [named] = await fresh.sandboxes.list(accountId);
		expect(named?.environment).toEqual({ id: environment.id, name: "backend" });

		await api.service.recordEgress(STUB_HOST_ID, [
			{
				at: 1000,
				sandboxId: sandbox.id,
				method: "GET",
				host: "api.github.com",
				port: 443,
				path: "/user?per_page=1",
				allowed: true,
				swapped: ["GH_TOKEN"],
				inspected: true,
				status: 200,
				bytesUp: 120,
				bytesDown: 900,
			},
			{
				at: 2000,
				sandboxId: sandbox.id,
				method: "POST",
				host: "api.example.com",
				port: 443,
				path: "/upload",
				allowed: false,
				code: "placeholder-unbound",
				swapped: [],
				inspected: true,
				bytesUp: 0,
				bytesDown: 0,
			},
		]);
		const egress = await source.egress.get(sandbox.id);
		expect(egress).toMatchObject({
			sandboxId: sandbox.id,
			sandboxName: sandbox.name,
			accountId,
			environment: { id: environment.id, name: "backend" },
			environmentGrants: [{ action: "allow", host: "registry.npmjs.org", methods: [], paths: [] }],
			grants: [],
		});
		expect(egress.protectedVariables).toEqual([
			{
				name: "GH_TOKEN",
				placeholderPrefix: expect.stringMatching(/^kph_[0-9A-Za-z]{4}$/),
				bindings: [{ host: "api.github.com", pathPrefixes: [], methods: [] }],
			},
		]);
		expect(egress.entries).toEqual([
			{
				id: expect.any(String),
				at: 2000,
				method: "POST",
				host: "api.example.com",
				port: 443,
				path: "/upload",
				decision: "denied",
				// The refusal's code stands in for a reason.
				reason: "placeholder-unbound",
				code: "placeholder-unbound",
				swapped: [],
				inspected: true,
				bytesUp: 0,
				bytesDown: 0,
			},
			{
				id: expect.any(String),
				at: 1000,
				method: "GET",
				host: "api.github.com",
				port: 443,
				path: "/user",
				decision: "allowed",
				swapped: ["GH_TOKEN"],
				inspected: true,
				status: 200,
				bytesUp: 120,
				bytesDown: 900,
			},
		]);
		expect(JSON.stringify(egress)).not.toContain("ghp_CONSOLESECRET123");

		const granted = await source.egress.setGrants(sandbox.id, [
			{ id: "grt_new_1", action: "deny", host: "api.github.com", methods: ["DELETE"], paths: [] },
		]);
		expect(granted.grants).toEqual([
			{
				id: expect.stringMatching(/^grt_[a-z0-9]+$/),
				action: "deny",
				host: "api.github.com",
				methods: ["DELETE"],
				paths: [],
			},
		]);
		expect(granted.environmentGrants).toEqual(egress.environmentGrants);
		// A write from the read before that grant was added is refused, so it can't take the grant away.
		await expect(source.egress.setGrants(sandbox.id, [], egress.grants)).rejects.toMatchObject({ code: "conflict" });
		expect((await source.egress.get(sandbox.id)).grants).toEqual(granted.grants);
	});
});

describe("hosts", () => {
	it("makes a join token and lists the hosts for a super-admin", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi);
		if (source.hosts === undefined) throw new Error("No hosts for a super-admin");

		const join = await source.hosts.join({ name: "rack-1" });
		expect(join.token).toMatch(/^kth_/);
		expect(join.command).toContain("/releases/latest/download/install.sh");
		expect(join.command).toContain(join.token);

		const hosts = await source.hosts.list();
		expect(hosts.map((host) => host.id)).toContain(STUB_HOST_ID);
		expect(hosts.find((host) => host.id === STUB_HOST_ID)?.state).toBe("online");
	});

	it("has no hosts for someone who isn't a super-admin", async () => {
		const { fetchApi } = setup();
		const source = await open(fetchApi, "person-bob");
		expect(source.hosts).toBeUndefined();
		// Nor hosts of their own, where the deployment has account hosts off.
		expect(source.ownHosts).toBeUndefined();
	});

	it("gives anyone else their account's own hosts where the deployment has account hosts on", async () => {
		const { fetchApi } = setup({ accountHosts: true });
		const bob = await open(fetchApi, "person-bob");
		expect(bob.hosts).toBeUndefined();
		if (bob.ownHosts === undefined) throw new Error("No own hosts with account hosts on");
		const account = await personalAccount(bob);
		const own = bob.ownHosts(account);
		expect(await own.list()).toEqual([]);
		const join = await own.join({ name: "bob-laptop" });
		expect(join.token).toMatch(/^kth_/);
		expect(join.command).toContain(join.token);
		// Not another account's: Ada's personal account isn't Bob's to add hosts to.
		const ada = await open(fetchApi);
		const adas = bob.ownHosts(await personalAccount(ada));
		await expect(adas.join({})).rejects.toMatchObject({ code: "forbidden" });
		await expect(adas.list()).rejects.toMatchObject({ code: "forbidden" });
		// A super-admin manages the deployment's hosts instead.
		expect(ada.ownHosts).toBeUndefined();
	});
});
