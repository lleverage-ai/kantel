// The compute console's API source against the real compute API, in process: `@kantel/compute`'s `createComputeApi`
// over its stub backend, with `fetch` handing each call straight to the API. Each test opens its own API and closes it
// after. Lifecycle calls answer as soon as the work is under way, so a test waits for `api.service.idle()` before it
// looks at a settled state.

import { createKantelClient } from "@kantel/api/sdk";
import {
	type AuthenticatePerson,
	type ComputeApi,
	createComputeApi,
	type PersonIdentity,
	type SandboxBackend,
} from "@kantel/compute";
import { createStubBackend, STUB_HOST_ID } from "@kantel/compute/stub";
import { KantelError } from "@kantel/contracts";
import { type ComputeSource, FilesRefusedError } from "@kantel/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiCompute, SCREENS_NOT_END_TO_END, SCREENS_NOT_SERVED, shapesOf } from "./api-source.ts";
import { sandboxMeans } from "./live-usage.ts";
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
function setup(
	options: {
		accountHosts?: boolean;
		backend?: SandboxBackend;
		baseImages?: Parameters<typeof createComputeApi>[0]["baseImages"];
		templates?: boolean;
	} = {},
) {
	const { backend = createStubBackend(), ...rest } = options;
	const api = createComputeApi({
		backend,
		authenticatePerson,
		...rest,
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
		// Its page reads it as deleted, as it would after the live feed reconnected having missed the deletion.
		expect(await source.sandboxes.get(fork.id)).toMatchObject({ id: fork.id, deleted: true });
		expect(await source.sandboxes.get(made.id)).not.toHaveProperty("deleted");
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

	it("opens a microVM's desktop and browser, and says why not where the gateway refuses them or E2E is on", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const made = await source.sandboxes.create({ accountId, kind: "microvm" });
		await api.service.idle();
		const access = await source.sandboxes.access(made.id);
		expect(access.unavailable).toBeUndefined();
		expect(access.embed?.desktop).toMatch(/embed=1$/);
		expect(access.browserUrl).not.toBe("");

		// A deployment that doesn't serve this sandbox's screens refuses them: SSH stays, the screens say why.
		const stub = createStubBackend();
		const refuse = async (): Promise<never> => {
			throw new KantelError("not_supported", "Not served here");
		};
		const refusing = setup({ backend: { ...stub, openDesktop: refuse, openBrowser: refuse } });
		const there = await open(refusing.fetchApi);
		const box = await there.sandboxes.create({
			accountId: await personalAccount(there),
			kind: "microvm",
		});
		await refusing.api.service.idle();
		const refused = await there.sandboxes.access(box.id);
		expect(refused.ssh).toBe(`kantel ssh ${box.id}`);
		expect(refused.unavailable).toEqual({ desktop: SCREENS_NOT_SERVED, browser: SCREENS_NOT_SERVED });
		expect([refused.desktopUrl, refused.desktopViewUrl, refused.browserUrl]).toEqual(["", "", ""]);

		// An end-to-end space: its host refuses the gateway's desktop, so neither is asked for.
		const local = await localBridge(async (input, init) => {
			if (String(input) === "/local/info") {
				return Response.json({
					local: true,
					device: { id: "d1", label: "Ada's laptop" },
					spaces: [{ id: accountId, mode: "strict" }],
				});
			}
			return fetchApi(input, init);
		}, "127.0.0.1");
		const asked: string[] = [];
		const e2e = await apiCompute({
			headers: () => ({ authorization: "Bearer person-ada" }),
			fetch: async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				asked.push(new URL(url, ORIGIN).pathname);
				return fetchApi(input, init);
			},
			...(local === undefined ? {} : { local }),
		});
		const inSpace = await e2e.sandboxes.access(made.id);
		expect(inSpace.unavailable).toEqual({ desktop: SCREENS_NOT_END_TO_END, browser: SCREENS_NOT_END_TO_END });
		// SSH is E2E v1's own: the host refuses the gateway's, which lets a key in with a command.
		expect(inSpace.ssh).toBe(`kantel e2e ssh ${made.id}`);
		expect(inSpace.sshWithoutCli).toBe(false);
		// `kantel console`'s page is the CLI's own, signed in already; its loopback origin is no gateway to sign in to.
		if (local !== undefined) {
			vi.stubGlobal("location", { origin: "http://127.0.0.1:58091" });
			try {
				expect((await e2e.sandboxes.access(made.id)).cliLogin).toBeUndefined();
			} finally {
				vi.unstubAllGlobals();
			}
		}
		expect(asked.filter((path) => /\/(desktop|browser|ssh)$/.test(path))).toEqual([]);
	});

	it("shows the CLI's ssh and lets a key in for plain ssh only when asked, with the private key Kantel made", async () => {
		const { api, fetchApi } = setup();
		const asked: string[] = [];
		const source = await open(async (input, init) => {
			asked.push(new URL(input instanceof Request ? input.url : String(input), ORIGIN).pathname);
			return fetchApi(input, init);
		});
		const made = await source.sandboxes.create({
			accountId: await personalAccount(source),
			kind: "microvm",
		});
		await api.service.idle();

		// Opening the page lets no key in: the CLI's command needs nothing from the API.
		const access = await source.sandboxes.access(made.id);
		expect(access.ssh).toBe(`kantel ssh ${made.id}`);
		expect(access.sshWithoutCli).toBe(true);
		expect(asked.filter((path) => path.endsWith("/ssh"))).toEqual([]);
		// Served by a gateway, the page says to sign the CLI in to it: the gateway is this page's origin.
		vi.stubGlobal("location", { origin: "https://app.kantel.dev" });
		try {
			expect((await source.sandboxes.access(made.id)).cliLogin).toBe("kantel login --url https://app.kantel.dev");
		} finally {
			vi.unstubAllGlobals();
		}

		// Without a public key, Kantel makes a pair: its private half is the download, and the command uses its file.
		const generated = await source.sandboxes.sshKey?.(made.id);
		expect(generated?.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]*\n$/);
		expect(generated?.keyFile).toEqual({ name: `kantel-${made.id}`, path: `~/Downloads/kantel-${made.id}` });
		expect(generated?.command).toBe(
			`chmod 600 ~/Downloads/kantel-${made.id} && ssh -i ~/Downloads/kantel-${made.id} -o IdentitiesOnly=yes -p 2222 ${made.id}@ssh.stub.kantel.invalid`,
		);
		expect(generated?.hostKeyFingerprint).toBe("SHA256:stub");

		// With one, it's let in as it is and nothing private comes back.
		const given = await source.sandboxes.sshKey?.(made.id, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample ada@laptop");
		expect(given?.privateKey).toBeUndefined();
		expect(given?.keyFile).toBeUndefined();
		expect(given?.command).toBe(`ssh -p 2222 ${made.id}@ssh.stub.kantel.invalid`);
		expect(asked.filter((path) => path.endsWith("/ssh"))).toHaveLength(2);
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

	it("tells a host's refusal of a path through `kantel console` from a session that failed", async () => {
		const { api, fetchApi } = setup();
		const plain = await open(fetchApi);
		const accountId = await personalAccount(plain);
		const made = await plain.sandboxes.create({ accountId, kind: "microvm" });
		await api.service.idle();
		// What `kantel console` answers: the host's own refusal with its code, else a session that didn't get there.
		const localFetch: typeof fetch = async (input, init) => {
			const path = String(input);
			if (path === "/local/info") return Response.json({ local: true, spaces: [{ id: accountId, mode: "on" }] });
			if (path === "/local/e2e") {
				const { params } = JSON.parse(String(init?.body)) as { params: { path: string } };
				if (params.path === "/home/user") {
					return Response.json(
						{ error: { code: "e2e", message: "no such directory", hostCode: "not_found" } },
						{ status: 502 },
					);
				}
				if (params.path === "/home/user/secret") {
					return Response.json({ error: { code: "e2e", message: "outside", hostCode: "invalid" } }, { status: 502 });
				}
				return Response.json({ error: { code: "e2e", message: "The relay closed the stream" } }, { status: 502 });
			}
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
		// A start the image hasn't got, and a read the host won't do: refusals, with no Try again.
		await expect(files.list(made.id, "home/user")).rejects.toBeInstanceOf(FilesRefusedError);
		await expect(files.read(made.id, "home/user/secret", { offset: 0, length: 5 })).rejects.toBeInstanceOf(
			FilesRefusedError,
		);
		// The session not getting there is a failure, to try again.
		const dropped = await files.list(made.id, "tmp").catch((error: unknown) => error);
		expect(dropped).toBeInstanceOf(Error);
		expect(dropped).not.toBeInstanceOf(FilesRefusedError);
	});

	it("shows what the host gave a microVM, and names sizes without figures", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const made = await source.sandboxes.create({ accountId, kind: "microvm" });
		await api.service.idle();
		const [listed] = await source.sandboxes.list(accountId);
		// The stub backend's "default" is 2 vCPU and 4 GB, not the sample catalogue's 4 and 8.
		expect(listed).toMatchObject({ id: made.id, size: "medium", resources: { vcpus: 2, memoryGb: 4, diskGb: 20 } });
	});

	it("keeps whether hosts make shapes off the presets, as the API says", () => {
		const microvm = {
			vcpus: { min: 1, max: 8, step: 1, default: 2 },
			memoryMb: { min: 512, max: 16_384, step: 512, default: 4096 },
			memoryMbPerVcpu: { min: 512, max: 8192 },
			presets: [{ name: "default" as const, vcpus: 2, memoryMb: 4096, diskGb: 20 }],
		};
		const isolate = { memoryMb: { min: 128, max: 512, step: 64, default: 256 }, enforced: false };
		// Older hosts only: the presets alone.
		const older = shapesOf({ isolate, microvm: { ...microvm, custom: false } });
		expect(older.microvm.custom).toBe(false);
		const current = shapesOf({ isolate, microvm: { ...microvm, custom: true } });
		expect(current.microvm.custom).toBe(true);
		expect(current.microvm.available).toBeUndefined();
		// No host for microVMs: the sample's ranges stand in, but no microVM may be made from them.
		const none = shapesOf({ isolate });
		expect(none.microvm.available).toBe(false);
		expect(none.isolate.memoryMb).toEqual(isolate.memoryMb);
	});

	it("asks for the shape the sliders chose, and reads what may be chosen from the API", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const shapes = await source.sandboxes.shapes?.(accountId);
		expect(shapes?.isolate.memoryMb).toEqual({ min: 128, max: 512, step: 64, default: 256 });
		expect(shapes?.microvm.presets.map((preset) => preset.name)).toEqual(["small", "default", "large", "xlarge"]);
		// Self-hosted: no price.
		expect(shapes?.rates).toBeUndefined();
		const custom = await source.sandboxes.create({ accountId, kind: "microvm", shape: { vcpus: 3, memoryMb: 6144 } });
		const isolate = await source.sandboxes.create({ accountId, kind: "isolate", shape: { vcpus: 0, memoryMb: 384 } });
		await api.service.idle();
		expect(await source.sandboxes.get(custom.id)).toMatchObject({ resources: { vcpus: 3, memoryGb: 6 } });
		expect(await source.sandboxes.get(isolate.id)).toMatchObject({ resources: { vcpus: 0, memoryGb: 0.375 } });
	});

	it("sends no resources for a template's microVM whose sliders weren't moved, so the template's own apply", async () => {
		const { fetchApi } = setup();
		const sent: Record<string, unknown>[] = [];
		const recording: typeof fetch = async (input, init) => {
			const request = new Request(new URL(String(input instanceof Request ? input.url : input), ORIGIN), init);
			if (request.method === "POST" && new URL(request.url).pathname.endsWith("/sandboxes")) {
				sent.push((await request.clone().json()) as Record<string, unknown>);
			}
			return fetchApi(request);
		};
		const source = await open(recording);
		const accountId = await personalAccount(source);
		// The stub deployment has no such template: only what was sent matters here.
		await source.sandboxes.create({ accountId, kind: "microvm", templateId: "tpl_any" }).catch(() => undefined);
		await source.sandboxes
			.create({ accountId, kind: "microvm", shape: { vcpus: 4, memoryMb: 8192 }, templateId: "tpl_any" })
			.catch(() => undefined);
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatchObject({ type: "microvm", template: "tpl_any" });
		expect(sent[0]).not.toHaveProperty("resources");
		expect(sent[1]).toMatchObject({ type: "microvm", template: "tpl_any", resources: { vcpus: 4, memoryMb: 8192 } });
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

	it("reads a path the sandbox refuses (outside an isolate's /workspace) as a refusal, and a failure as a failure", async () => {
		const { api, fetchApi } = setup();
		const plain = await open(fetchApi);
		const accountId = await personalAccount(plain);
		const made = await plain.sandboxes.create({ accountId, kind: "isolate" });
		await api.service.idle();
		// The host's answers for an isolate, as the gateway passes them on: `invalid` for a path outside /workspace,
		// `not_found` for one that isn't there, and `unavailable` when it can't reach the host.
		const answers: Record<string, { status: number; code: string; message: string }> = {
			"/": { status: 400, code: "invalid", message: "/ is outside /workspace, an isolate's only files" },
			"/workspace/gone": { status: 404, code: "not_found", message: "no directory /workspace/gone" },
			"/workspace": { status: 503, code: "unavailable", message: "The host isn't connected" },
		};
		const source = await open(async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input), ORIGIN);
			const answer = answers[url.searchParams.get("path") ?? ""];
			if (!url.pathname.endsWith("/files/list") || answer === undefined) return fetchApi(input, init);
			return Response.json({ error: { code: answer.code, message: answer.message } }, { status: answer.status });
		});
		const files = source.sandboxes.files;
		if (files === undefined) throw new Error("No files");
		const outside = await files.list(made.id, "").catch((error: unknown) => error);
		expect(outside).toBeInstanceOf(FilesRefusedError);
		expect((outside as Error).message).toBe("/ is outside /workspace, an isolate's only files");
		await expect(files.list(made.id, "workspace/gone")).rejects.toBeInstanceOf(FilesRefusedError);
		// A host that's away is worth trying again: not a refusal.
		const away = await files.list(made.id, "workspace").catch((error: unknown) => error);
		expect(away).toBeInstanceOf(Error);
		expect(away).not.toBeInstanceOf(FilesRefusedError);
	});
});

describe("templates", () => {
	it("changes a description alone without a new version, and makes the next one only for a changed spec", async () => {
		const { api, fetchApi } = setup({ templates: true });
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const templates = source.templates;
		if (templates === undefined) throw new Error("Templates aren't offered.");
		const spec = {
			image: { kind: "kantel-base" },
			base: { image: "kantel/sandbox", channel: "stable" },
			vcpus: 2,
			memoryMb: 4096,
			env: { APP_MODE: "one" },
			grants: [],
		} as const;
		const made = await templates.create({ accountId, name: "web", spec });
		await api.service.idle();

		const described = await templates.update(made.id, { description: "The web app" });
		expect(described).toMatchObject({ version: 1, name: "web", description: "The web app" });
		expect(await templates.versions(made.id)).toHaveLength(1);
		const cleared = await templates.update(made.id, { description: "" });
		expect(cleared.description).toBeUndefined();

		const changed = await templates.update(made.id, { spec: { ...spec, env: { APP_MODE: "two" } } });
		expect(changed).toMatchObject({ version: 2, name: "web", spec: { env: { APP_MODE: "two" } } });
		expect((await templates.versions(made.id)).map((entry) => entry.version)).toEqual([2, 1]);
		await api.service.idle();
	});

	it("lists the base channels the deployment publishes, with the digests each has published", async () => {
		const { api, fetchApi } = setup({ templates: true });
		const source = await open(fetchApi);
		const templates = source.templates;
		if (templates === undefined) throw new Error("Templates aren't offered.");
		expect(await templates.bases()).toEqual([]);
		const first = `sha256:${"1".repeat(64)}`;
		const second = `sha256:${"2".repeat(64)}`;
		await api.service.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: first });
		await api.service.publishTemplateBase({ image: "kantel/sandbox", channel: "stable", digest: second });
		const [stable, ...others] = await templates.bases();
		expect(others).toEqual([]);
		expect(stable).toMatchObject({ image: "kantel/sandbox", channel: "stable", digest: second });
		expect(stable?.history.map((release) => release.digest)).toEqual([second, first]);
		await api.service.idle();
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

	it("says what kind of sandbox a snapshot is of, for a link to its files, and refuses a folder that isn't there", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const sandbox = await source.sandboxes.create({ accountId, kind: "isolate" });
		await api.service.idle();
		await source.sandboxes.stop(sandbox.id);
		await api.service.idle();
		const [taken] = await source.snapshots.history(sandbox.id);
		if (taken === undefined) throw new Error("No snapshot");
		expect(await source.snapshots.kindOf?.(taken.id)).toBe("isolate");
		const gone = await source.snapshots.list(taken.id, "home/user/nowhere").catch((error: unknown) => error);
		expect(gone).toBeInstanceOf(FilesRefusedError);
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

	it("never undoes a change made between its read and its write: it is made again on a fresh read", async () => {
		const { fetchApi } = setup();
		let meanwhile: (() => Promise<unknown>) | undefined;
		const puts: unknown[] = [];
		// Someone else's write lands just before this source's next PUT.
		const racing: typeof fetch = async (input, init) => {
			if (init?.method === "PUT" && String(input).includes("/proxy")) {
				puts.push(JSON.parse(String(init.body)));
				const other = meanwhile;
				meanwhile = undefined;
				if (other !== undefined) await other();
			}
			return fetchApi(input, init);
		};
		const source = await open(racing);
		const theirs = await open(fetchApi);
		const accountId = await personalAccount(source);
		await theirs.proxy.update(accountId, { enabled: true, policy: "allowlist", allow: ["api.github.com"] });

		// A change with no `expected`: the settings form's. Made again over their deny.
		meanwhile = () => theirs.proxy.update(accountId, { deny: ["evil.example"] });
		const saved = await source.proxy.update(accountId, { upstream: { url: "http://upstream.example:3128" } });
		expect(saved).toMatchObject({ deny: ["evil.example"], upstream: { url: "http://upstream.example:3128" } });
		expect(puts).toHaveLength(2);
		expect(puts[0]).toMatchObject({ deny: [], expected: { deny: [] } });

		// A change made from the caller's own read, which someone changed since: refused, for the caller to redo.
		const read = await source.proxy.get(accountId);
		await theirs.proxy.update(accountId, { allow: ["api.github.com", "pypi.org"] });
		await expect(
			source.proxy.update(accountId, { allow: [...read.allow, "crates.io"], expected: read }),
		).rejects.toMatchObject({ code: "conflict" });
		// And when someone writes between its read and its write, Kantel refuses it.
		const fresh = await source.proxy.get(accountId);
		meanwhile = () => theirs.proxy.update(accountId, { deny: [] });
		await expect(
			source.proxy.update(accountId, { allow: [...fresh.allow, "crates.io"], expected: fresh }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await source.proxy.get(accountId)).toMatchObject({ allow: ["api.github.com", "pypi.org"], deny: [] });
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

	it("offers a super-admin Images only where the gateway has image patching on", async () => {
		const off = await open(setup().fetchApi);
		expect(off.hosts).toBeDefined();
		expect(off.images).toBeUndefined();

		// On, with an index it can't read: the page opens and says so.
		const baseImages = {
			indexUrl: "https://example.test/index.json",
			index: async () => {
				throw new Error("The base image index couldn't be read: unreachable");
			},
		};
		const { fetchApi } = setup({ baseImages });
		const on = await open(fetchApi);
		if (on.images === undefined) throw new Error("No Images with image patching on");
		expect((await on.images.overview()).error).toContain("couldn't be read");
		expect((await open(fetchApi, "person-bob")).images).toBeUndefined();
	});

	it("reads a sandbox's and a host's live usage, newer than a point it has", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const made = await source.sandboxes.create({ accountId, kind: "microvm", shape: { vcpus: 3, memoryMb: 6144 } });
		await api.service.idle();

		const read = source.sandboxes.usageSeries;
		if (read === undefined) throw new Error("No live sandbox usage");
		// Just booted, so no readings yet, but its limit is its own shape's memory, not a size preset's.
		const sandbox = await read(made.id, Date.now() - 600_000);
		expect(sandbox).toEqual({ intervalMs: expect.any(Number), memLimitBytes: 6144 * 1024 ** 2, points: [] });

		const host = source.hosts?.usage;
		if (host === undefined) throw new Error("No live host usage for a super-admin");
		const usage = await host(STUB_HOST_ID, Date.now() - 600_000);
		expect(usage).toMatchObject({
			intervalMs: 5_000,
			memLimitBytes: 256 * 1024 ** 3,
			diskTotalBytes: 2048 * 1024 ** 3,
		});
		expect(usage.points.length).toBeGreaterThan(0);
		for (const point of usage.points) {
			expect(point.cpu).toBeGreaterThanOrEqual(0);
			expect(point.cpu).toBeLessThanOrEqual(1);
			expect(point.diskUsedBytes).toBeGreaterThan(0);
		}
		const newest = usage.points.at(-1)?.at ?? 0;
		expect((await host(STUB_HOST_ID, newest)).points.every((point) => point.at > newest)).toBe(true);
	});

	it("reads a sandbox's metrics over an hour, a day or a week, leaving out what nothing measured", async () => {
		const { api, fetchApi } = setup();
		const source = await open(fetchApi);
		const accountId = await personalAccount(source);
		const made = await source.sandboxes.create({ accountId, kind: "microvm" });
		await api.service.idle();
		const history = source.sandboxes.usageHistory;
		if (history === undefined) throw new Error("No usage history");
		// Just made: no readings, so no points, rather than a day of zeros.
		for (const range of ["1h", "24h", "1w"] as const) expect((await history(made.id, range)).points).toEqual([]);
		expect((await history(made.id, "24h")).intervalMs).toBe(300_000);
		expect((await history(made.id, "1w")).intervalMs).toBe(3_600_000);
	});

	it("maps a day's means for the chart: at each interval's end, a microVM's disk and IO, unmeasured ones left out", () => {
		const now = 1_000_000;
		const series = sandboxMeans(
			{
				sandboxId: "sbx_a",
				intervalSeconds: 300,
				points: [
					{ at: 100_000, cpu: 0, memoryMb: 0, runningSeconds: 0, cost: 0, measured: false },
					{
						at: 400_000,
						cpu: 0.5,
						memoryMb: 512,
						runningSeconds: 300,
						cost: 0,
						measured: true,
						diskUsedBytes: 2 * 1024 ** 3,
						ioPressure: 0.1,
					},
					// From a gateway before `measured`: one it ran in, and one it didn't.
					{ at: 700_000, cpu: 0.25, memoryMb: 256, runningSeconds: 120, cost: 0 },
					{ at: 900_000, cpu: 0, memoryMb: 0, runningSeconds: 0, cost: 0 },
				],
				totals: { runningSeconds: 0, cpuSeconds: 0, cost: { currency: "USD", total: 0, ratePerHour: 0 } },
				memLimitBytes: 4 * 1024 ** 3,
				diskTotalBytes: 20 * 1024 ** 3,
				series: { intervalMs: 5_000, points: [] },
			},
			now,
		);
		expect(series).toEqual({
			intervalMs: 300_000,
			memLimitBytes: 4 * 1024 ** 3,
			diskTotalBytes: 20 * 1024 ** 3,
			points: [
				{ at: 700_000, cpu: 0.5, memUsedBytes: 512 * 1024 ** 2, diskUsedBytes: 2 * 1024 ** 3, ioPressure: 0.1 },
				{ at: now, cpu: 0.25, memUsedBytes: 256 * 1024 ** 2 },
			],
		});
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

describe("mounts", () => {
	const DIGEST = `sha256:${"3f2a".repeat(15)}9c01`;
	const json = (body: unknown): Response =>
		new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

	it("has none where the deployment has mounts off", async () => {
		const { fetchApi } = setup();
		expect((await open(fetchApi)).mounts).toBeUndefined();
		expect((await open(fetchApi, "person-bob")).mounts).toBeUndefined();
	});

	it("has none behind a gateway from before mounts, which answers 404", async () => {
		const { fetchApi } = setup();
		const older: typeof fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input, ORIGIN);
			return url.pathname.startsWith("/v1/bundles") ? notFound() : fetchApi(input, init);
		};
		expect((await open(older)).mounts).toBeUndefined();
	});

	it("lists and deletes bundles and bucket sources, and names a sandbox's bucket mounts", async () => {
		const { api, fetchApi } = setup();
		// The stub API has mounts off, so these routes answer here, and a sandbox's read gains mounts.
		const calls: string[] = [];
		let accountId = "";
		let sandboxId = "";
		const withMounts: typeof fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(new URL(input, ORIGIN), init);
			const url = new URL(request.url);
			const path = decodeURIComponent(url.pathname);
			if (path.startsWith("/v1/bundles") || path.startsWith("/v1/bucket-sources")) {
				calls.push(`${request.method} ${path}${url.search}`);
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				if (path === "/v1/bundles") {
					return json({
						items: [{ digest: DIGEST, accountId, sizeBytes: 4_404_019, mountedBy: 1, createdAt: 1_000 }],
					});
				}
				return json({
					items: [
						{
							id: "bks_4kq9x2mt",
							accountId,
							name: "org files",
							provider: "s3",
							bucket: "org-files",
							endpoint: "https://acct.r2.cloudflarestorage.com",
							region: "auto",
							hasCredentials: true,
							mountedBy: 1,
							createdAt: 2_000,
						},
						{
							id: "bks_7hp3w8rn",
							accountId,
							name: "public datasets",
							provider: "gcs",
							bucket: "datasets",
							hasCredentials: false,
							mountedBy: 0,
							createdAt: 3_000,
						},
					],
				});
			}
			const response = await fetchApi(input, init);
			if (request.method !== "GET" || sandboxId === "" || path !== `/v1/sandboxes/${sandboxId}`) return response;
			const sandbox = (await response.json()) as object;
			return json({
				...sandbox,
				mounts: [
					{ path: "/mnt/skills", source: { kind: "bundle", digest: DIGEST }, status: "ready" },
					{
						path: "/mnt/org-files",
						source: { kind: "bucket", bucketSourceId: "bks_4kq9x2mt", prefix: "org/42/", refreshTtlSeconds: 60 },
						status: "failed",
						error: "This host can't mount buckets yet",
					},
					{
						path: "/mnt/new",
						source: { kind: "bucket", bucketSourceId: "bks_unknown", prefix: "" },
						status: "pending",
					},
				],
			});
		};

		const source = await open(withMounts);
		const mounts = source.mounts;
		if (mounts === undefined) throw new Error("No mounts where the deployment has them on");
		accountId = await personalAccount(source);

		expect(await mounts.bundles(accountId)).toEqual([
			{ digest: DIGEST, accountId, sizeBytes: 4_404_019, mountedBy: 1, createdAt: 1_000 },
		]);
		const sources = await mounts.bucketSources(accountId);
		expect(sources.map((bucket) => bucket.name)).toEqual(["org files", "public datasets"]);
		expect(sources[0]).toMatchObject({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto" });
		expect(sources[1]).not.toHaveProperty("endpoint");
		expect(sources[1]).not.toHaveProperty("credentials");
		await mounts.removeBundle(accountId, DIGEST);
		await mounts.removeBucketSource("bks_7hp3w8rn");
		expect(calls).toEqual([
			// The probe, in the caller's own account.
			"GET /v1/bundles",
			`GET /v1/bundles?account=${accountId}`,
			`GET /v1/bucket-sources?account=${accountId}`,
			`DELETE /v1/bundles/${DIGEST}?account=${accountId}`,
			"DELETE /v1/bucket-sources/bks_7hp3w8rn",
		]);

		const made = await source.sandboxes.create({ accountId, name: "lab", kind: "isolate" });
		await api.service.idle();
		sandboxId = made.id;
		calls.length = 0;
		expect((await source.sandboxes.get(made.id)).mounts).toEqual([
			{ path: "/mnt/skills", source: { kind: "bundle", digest: DIGEST }, status: "ready" },
			{
				path: "/mnt/org-files",
				source: {
					kind: "bucket",
					bucketSourceId: "bks_4kq9x2mt",
					prefix: "org/42/",
					refreshTtlSeconds: 60,
					bucketSourceName: "org files",
					bucket: "org-files",
				},
				status: "failed",
				error: "This host can't mount buckets yet",
			},
			// One the console hasn't read, after reading them again: by its ID.
			{
				path: "/mnt/new",
				source: { kind: "bucket", bucketSourceId: "bks_unknown", prefix: "" },
				status: "pending",
			},
		]);
		expect(calls).toEqual([`GET /v1/bucket-sources?account=${accountId}`]);
	});
});
