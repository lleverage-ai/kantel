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

		const made = await source.sandboxes.create({ accountId, name: "lab", kind: "isolate", size: "small" });
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

	it("shows what the host gave a microVM, and names sizes without figures", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		expect(source.sandboxes.sizeFigures).toBe(false);
		const made = await source.sandboxes.create({ accountId, kind: "microvm", size: "medium" });
		await api.service.idle();
		const [listed] = await source.sandboxes.list(accountId);
		// The stub backend's "default" is 2 vCPU and 4 GB, not the sample catalogue's 4 and 8.
		expect(listed).toMatchObject({ id: made.id, size: "medium", resources: { vcpus: 2, memoryGb: 4, diskGb: 20 } });
	});
});

describe("snapshots", () => {
	it("lists a stop's snapshot and its files, and saves one under a name", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const sandbox = await source.sandboxes.create({ accountId, kind: "isolate", size: "small" });
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
		expect(await source.snapshots.read(taken.id, "home/user/work/readme.txt")).toBe("Hello");

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
			tlsInspection: false,
			headers: [],
			logRequests: false,
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

		await expect(source.proxy.update(accountId, { tlsInspection: true })).rejects.toThrow(/can't/);
		await expect(source.proxy.recent(accountId)).rejects.toThrow(/proxy requests/);
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
