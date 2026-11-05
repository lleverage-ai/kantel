// Retries with an Idempotency-Key: each route that takes one does its work once for one key and request, refuses the
// key for a different request, and keeps an answer with a secret sealed. The routes that take none answer a retry as
// things are, which is checked here too.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend } from "../src/backend.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { ANSWER_WITHHELD, CLAIM_LAPSED, canonicalJson, IDEMPOTENCY_CLAIM_MS } from "../src/service.ts";
import { type ComputeStore, createMemoryStore } from "../src/store.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"root-token": { userId: "usr_root", name: "Root", email: "root@example.com", superAdmin: true },
};

/** Whether Root is a super admin now: a test takes it away between a call and its retry. */
let rootIsSuperAdmin = true;

const opened: ComputeApi[] = [];
afterEach(async () => {
	rootIsSuperAdmin = true;
	for (const api of opened.splice(0)) await api.close();
});

/** The person a bearer names, as they are now. */
function person(token: string | undefined): PersonIdentity | undefined {
	if (token === undefined) return undefined;
	const found = PEOPLE[token];
	return found !== undefined && token === "root-token" ? { ...found, superAdmin: rootIsSuperAdmin } : found;
}

/** What the backend was asked to do, by method. */
type Counts = { recover: number; exposePort: number; takeSnapshot: number };

function setup(options: { readonly store?: ComputeStore; readonly secretsKey?: string } = {}) {
	const stub = createStubBackend();
	const counts: Counts = { recover: 0, exposePort: 0, takeSnapshot: 0 };
	const backend: SandboxBackend = {
		...stub,
		recover: (...args) => {
			counts.recover++;
			return stub.recover(...args);
		},
		// A gated port's URL holds a new token each time, as a real host's does.
		exposePort: async (...args) => {
			counts.exposePort++;
			const { url } = await stub.exposePort(...args);
			return { url: args[2].public ? url : `${url}/?kantel_token=${crypto.randomUUID()}` };
		},
		takeSnapshot: (...args) => {
			counts.takeSnapshot++;
			return stub.takeSnapshot(...args);
		},
	};
	let clock = Date.now();
	const mail: string[] = [];
	const store = options.store ?? createMemoryStore();
	const api = createComputeApi({
		backend,
		store,
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
		now: () => clock,
		accountHosts: true,
		authenticatePerson: async (request) => person(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")),
		invites: { send: async (sent) => void mail.push(sent.to), consoleUrl: "https://kantel.example.com/" },
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const client = (token: string) =>
		createKantelClient({
			baseUrl: BASE_URL,
			token,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
	return {
		store,
		counts,
		mail,
		tick: (ms: number) => {
			clock += ms;
		},
		tom: client("tom-token"),
		root: client("root-token"),
	};
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

const key = (name: string) => ({ idempotencyKey: name });

describe("once per key", () => {
	it("runs a command once for one key, and refuses the key for another command", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const run = { command: "echo run >> runs.txt && cat runs.txt" };
		const first = await tom.runCommand(sandbox.id, run, key("exec-1"));
		const again = await tom.runCommand(sandbox.id, run, key("exec-1"));
		expect(again).toEqual(first);
		expect((await tom.readFile(sandbox.id, { path: "runs.txt" })).content).toBe("run\n");
		expect((await tom.listCommands(sandbox.id)).items).toHaveLength(1);

		const other = await failure(tom.runCommand(sandbox.id, { command: "rm -rf /tmp/x" }, key("exec-1")));
		expect(other.status).toBe(422);
		expect(other.code).toBe("refused");
		expect(other.message).toContain("different request");
		// Another key is another call.
		await tom.runCommand(sandbox.id, run, key("exec-2"));
		expect((await tom.readFile(sandbox.id, { path: "runs.txt" })).content).toBe("run\nrun\n");
	});

	it("starts a detached command once for one key", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const run = { command: "sleep 0", detached: true };
		const first = await tom.runCommand(sandbox.id, run, key("bg-1"));
		const again = await tom.runCommand(sandbox.id, run, key("bg-1"));
		expect(again.id).toBe(first.id);
		expect((await tom.listCommands(sandbox.id)).items).toHaveLength(1);
	});

	it("refuses a key while its call is working when the request differs", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		// Sent together: whichever claims the key first runs, and the other is refused, never run.
		const bodies = [{ command: "echo one" }, { command: "echo two" }];
		const both = await Promise.allSettled(bodies.map((body) => tom.runCommand(sandbox.id, body, key("busy"))));
		const ran = both.findIndex((result) => result.status === "fulfilled");
		const refused = both[1 - ran];
		expect(ran).not.toBe(-1);
		expect(refused?.status === "rejected" && (refused.reason as KantelApiError).code).toBe("refused");
		const winner = both[ran] as PromiseFulfilledResult<{ readonly id: string }>;
		expect((await tom.runCommand(sandbox.id, bodies[ran] as (typeof bodies)[0], key("busy"))).id).toBe(winner.value.id);
		expect((await tom.listCommands(sandbox.id)).items).toHaveLength(1);
	});

	it("keeps the first stop time when an extension is retried later", async () => {
		const { tom, tick } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const first = await tom.updateSandbox(sandbox.id, { extendMinutes: 30 }, key("extend-1"));
		tick(5 * 60_000);
		const again = await tom.updateSandbox(sandbox.id, { extendMinutes: 30 }, key("extend-1"));
		expect(again.stopsAt).toBe(first.stopsAt);
		expect((await tom.getSandbox(sandbox.id)).stopsAt).toBe(first.stopsAt);
		// Without the key, a second extension counts from now again.
		const later = await tom.updateSandbox(sandbox.id, { extendMinutes: 30 });
		expect(later.stopsAt).toBe((first.stopsAt as number) + 5 * 60_000);
		expect((await failure(tom.updateSandbox(sandbox.id, { extendMinutes: 60 }, key("extend-1")))).code).toBe("refused");
	});

	it("recovers a sandbox once for one key", async () => {
		const { tom, counts } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const first = await tom.recoverSandbox(sandbox.id, key("recover-1"));
		const again = await tom.recoverSandbox(sandbox.id, key("recover-1"));
		expect(again).toEqual(first);
		await tom.getSandbox(sandbox.id);
		expect(counts.recover).toBe(1);
	});

	it("answers a gated port's first token again, and exposes it once", async () => {
		const { tom, counts } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const first = await tom.exposePort(sandbox.id, { port: 3000 }, key("port-1"));
		const again = await tom.exposePort(sandbox.id, { port: 3000 }, key("port-1"));
		expect(first.url).toContain("kantel_token=");
		expect(again.url).toBe(first.url);
		expect(counts.exposePort).toBe(1);
		expect((await failure(tom.exposePort(sandbox.id, { port: 3001 }, key("port-1")))).code).toBe("refused");
	});

	it("takes and saves a snapshot once for one key", async () => {
		const { tom, counts } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const taken = await tom.takeSnapshot(sandbox.id, { description: "before" }, key("take-1"));
		expect((await tom.takeSnapshot(sandbox.id, { description: "before" }, key("take-1"))).id).toBe(taken.id);
		expect(counts.takeSnapshot).toBe(1);

		const save = { sandboxId: sandbox.id, name: "base" };
		const saved = await tom.saveSnapshot(save, key("save-1"));
		// Without the key the retry would be `conflict` on its own name.
		expect((await tom.saveSnapshot(save, key("save-1"))).id).toBe(saved.id);
		expect((await failure(tom.saveSnapshot(save))).code).toBe("conflict");
		// With `replace`, a retry would save it again and delete the first.
		const replaced = await tom.saveSnapshot({ ...save, replace: true }, key("save-2"));
		expect((await tom.saveSnapshot({ ...save, replace: true }, key("save-2"))).id).toBe(replaced.id);
		expect((await tom.listSnapshots({ kind: "saved" })).items.map((item) => item.id)).toEqual([replaced.id]);
		expect(counts.takeSnapshot).toBe(3);
	});

	it("makes and rotates an API key once for one key, keeping the secret sealed", async () => {
		const { tom, store } = setup();
		const body = { name: "ci", preset: "agent" } as const;
		const made = await tom.createApiKey(body, key("key-1"));
		const again = await tom.createApiKey(body, key("key-1"));
		expect(again).toEqual(made);
		expect((await tom.listApiKeys()).items.filter((item) => item.name === "ci")).toHaveLength(1);
		for (const record of await store.idempotency.list({})) {
			expect(record.body).not.toContain(made.secret);
		}

		const rotated = await tom.rotateApiKey(made.key.id, key("rotate-1"));
		const rotatedAgain = await tom.rotateApiKey(made.key.id, key("rotate-1"));
		expect(rotatedAgain.secret).toBe(rotated.secret);
		expect(rotated.secret).not.toBe(made.secret);
		// The secret answered again is the one that works.
		const ci = createKantelClient({
			baseUrl: BASE_URL,
			token: rotatedAgain.secret,
			fetch: (input, init) => (opened[0] as ComputeApi).fetch(new Request(input, init)) as Promise<Response>,
		});
		expect((await ci.getCaller()).apiKey?.id).toBe(made.key.id);
	});

	it("makes an environment, a webhook and its new secret once for one key", async () => {
		const { tom } = setup();
		const environment = await tom.createEnvironment({ name: "staging" }, key("env-1"));
		// Without the key the retry would be `conflict` on its name.
		expect((await tom.createEnvironment({ name: "staging" }, key("env-1"))).id).toBe(environment.id);

		const hook = { name: "ops", url: "https://hooks.example.com/kantel", events: ["sandbox.deleted" as const] };
		const made = await tom.createWebhook(hook, key("hook-1"));
		expect(await tom.createWebhook(hook, key("hook-1"))).toEqual(made);
		expect((await tom.listWebhooks()).items).toHaveLength(1);
		const rotated = await tom.rotateWebhookSecret(made.webhook.id, key("hook-rotate-1"));
		expect((await tom.rotateWebhookSecret(made.webhook.id, key("hook-rotate-1"))).secret).toBe(rotated.secret);
	});

	it("makes a host join token once for one key", async () => {
		const { root, tom } = setup();
		const token = await root.createHostJoinToken({ name: "rack-1" }, key("join-1"));
		expect(await root.createHostJoinToken({ name: "rack-1" }, key("join-1"))).toEqual(token);
		expect((await failure(root.createHostJoinToken({ name: "rack-2" }, key("join-1")))).code).toBe("refused");

		const own = await tom.createAccountJoinToken({ name: "laptop" }, key("enrol-1"));
		expect(await tom.createAccountJoinToken({ name: "laptop" }, key("enrol-1"))).toEqual(own);
	});

	it("makes an organisation and an invite once for one key, mailing the invite once", async () => {
		const { tom, mail } = setup();
		const org = await tom.createOrganisation({ name: "Acme" }, key("org-1"));
		expect((await tom.createOrganisation({ name: "Acme" }, key("org-1"))).id).toBe(org.id);
		expect((await tom.listAccounts()).items.filter((item) => item.name === "Acme")).toHaveLength(1);

		const invite = { email: "ann@example.com" };
		const first = await tom.createInvite(org.id, invite, key("invite-1"));
		expect(await tom.createInvite(org.id, invite, key("invite-1"))).toEqual(first);
		expect((await tom.listInvites(org.id)).items).toHaveLength(1);
		expect(mail).toEqual(["ann@example.com"]);
	});

	it("keeps no secret without a secrets key: a retry is conflict and does nothing again", async () => {
		const { tom } = setup({ store: { ...createMemoryStore(), persistent: true } });
		const made = await tom.createApiKey({ name: "ci", preset: "agent" }, key("key-1"));
		expect(made.secret).toBeTypeOf("string");
		const retried = await failure(tom.createApiKey({ name: "ci", preset: "agent" }, key("key-1")));
		expect(retried.code).toBe("conflict");
		expect(retried.message).toBe(ANSWER_WITHHELD);
		expect((await tom.listApiKeys()).items.filter((item) => item.name === "ci")).toHaveLength(1);
		// An answer with no secret is kept as it is.
		const sandbox = await tom.createSandbox({ wait: true }, key("make-1"));
		expect((await tom.createSandbox({ wait: true }, key("make-1"))).id).toBe(sandbox.id);
	});

	it("answers a key kept before fingerprints for any request, as it did", async () => {
		const { tom, store } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const command = await tom.runCommand(sandbox.id, { command: "echo old" });
		await store.idempotency.put({
			id: "user:usr_tom:runCommand:old-key",
			body: JSON.stringify(command),
			createdAt: Date.now(),
		});
		expect((await tom.runCommand(sandbox.id, { command: "echo new" }, key("old-key"))).id).toBe(command.id);
	});
});

describe("a create whose host never answered", () => {
	for (const wait of [true, false]) {
		it(`answers a retry the first answer, outcome unknown, and asks the host once (wait: ${wait})`, async () => {
			const stub = createStubBackend();
			let creates = 0;
			// As the hosts backend answers a create sent and never answered (#680): its outcome is unknown.
			const backend: SandboxBackend = {
				...stub,
				create: async () => {
					creates++;
					throw new KantelError("unavailable", "The host didn't answer the create; its outcome is unknown");
				},
			};
			const api = createComputeApi({
				backend,
				authenticatePerson: async (request) => person(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")),
				fetch: async () => new Response(null, { status: 204 }),
			});
			opened.push(api);
			const tom = createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			const first = await tom.createSandbox({ name: "unanswered", wait }, key("k-unanswered"));
			await api.service.idle();
			const again = await tom.createSandbox({ name: "unanswered", wait }, key("k-unanswered"));
			await api.service.idle();
			expect(again).toEqual(first);
			expect(creates).toBe(1);
			expect((await tom.listSandboxes({ all: true })).items.filter((item) => item.name === "unanswered")).toHaveLength(
				1,
			);
		});
	}
});

describe("a key whose call stalled", () => {
	/**
	 * Two gateways on one store, with a running sandbox, whose first snapshot stalls until `resume`, then ends as `ends`
	 * says. A snapshot's failure fails its call (a create's is answered as a sandbox in `error`), so `fails` reaches the
	 * release of the key.
	 */
	async function stalledPair(ends: "answers" | "fails") {
		const store = createMemoryStore();
		let clock = 1_000_000;
		const stub = createStubBackend();
		let snapshots = 0;
		let resume = () => {};
		const stalled = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let began = () => {};
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const backend: SandboxBackend = {
			...stub,
			takeSnapshot: async (sandboxId) => {
				snapshots++;
				if (snapshots === 1) {
					began();
					await stalled;
					if (ends === "fails") throw new KantelError("unavailable", "The host went away");
				}
				return stub.takeSnapshot(sandboxId);
			},
		};
		const gateway = () => {
			const api = createComputeApi({
				store,
				backend,
				now: () => clock,
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer tom-token" ? PEOPLE["tom-token"] : undefined,
				fetch: async () => new Response(null, { status: 204 }),
			});
			opened.push(api);
			return createKantelClient({
				baseUrl: BASE_URL,
				token: "tom-token",
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		};
		const first = gateway();
		const sandbox = await first.createSandbox({ type: "microvm", wait: true });
		return {
			first,
			second: gateway(),
			sandboxId: sandbox.id,
			store,
			started,
			resume,
			lapse: () => {
				clock += IDEMPOTENCY_CLAIM_MS + 1;
			},
		};
	}

	for (const ends of ["answers", "fails"] as const) {
		it(`never takes a lapsed claim over, and keeps what the stalled call does when it ${ends} late`, async () => {
			const { first, second, sandboxId, store, started, resume, lapse } = await stalledPair(ends);
			const body = { description: "once" };
			let answered: { readonly id: string } | undefined;
			const stalled = first.takeSnapshot(sandboxId, body, key("k-stall")).then(
				(snapshot) => {
					answered = snapshot;
					return "answered";
				},
				(error: unknown) => (error instanceof KantelApiError ? error.code : "threw"),
			);
			await started;
			lapse();
			// The stalled call may yet go on: a retry on another gateway does nothing, and says why.
			const retried = await failure(second.takeSnapshot(sandboxId, body, key("k-stall")));
			expect(retried.code).toBe("conflict");
			expect(retried.message).toBe(CLAIM_LAPSED);
			expect((await second.listSnapshots({ sandboxId })).items.filter((item) => item.description === "once")).toEqual(
				[],
			);
			resume();
			expect(await stalled).toBe(ends === "fails" ? "unavailable" : "answered");
			const kept = await store.idempotency.get("user:usr_tom:takeSnapshot:k-stall");
			if (ends === "answers") {
				// Its answer is kept, and a retry on either gateway gets it.
				expect(kept?.body).toBeDefined();
				expect((await second.takeSnapshot(sandboxId, body, key("k-stall"))).id).toBe(answered?.id);
				expect((await first.takeSnapshot(sandboxId, body, key("k-stall"))).id).toBe(answered?.id);
			} else {
				// It failed `unavailable`, which may have come after the host took it: the key stays held, and a retry under
				// it does nothing. A new key takes the snapshot.
				expect(kept?.body).toBeUndefined();
				expect((await failure(second.takeSnapshot(sandboxId, body, key("k-stall")))).message).toBe(CLAIM_LAPSED);
				expect((await second.takeSnapshot(sandboxId, body, key("k-stall-2"))).description).toBe("once");
			}
			const taken = (await second.listSnapshots({ sandboxId })).items.filter((item) => item.description === "once");
			expect(taken).toHaveLength(1);
		});
	}

	it("frees the key of a call refused before it did anything, so a retry under it does the work", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const taken = await tom.saveSnapshot({ sandboxId: sandbox.id, name: "base" });
		const save = { sandboxId: sandbox.id, name: "base" };
		// Its name is taken: refused (`conflict`) before anything is saved.
		expect((await failure(tom.saveSnapshot(save, key("save-refused")))).code).toBe("conflict");
		await tom.deleteSnapshot(taken.id);
		expect((await tom.saveSnapshot(save, key("save-refused"))).name).toBe("base");
	});

	it("never takes over a recovery's key: a retry is conflict, and nothing is recovered again", async () => {
		const { tom, store, counts } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		// A recovery whose gateway stopped renewing its claim before it read the sandbox, and may yet go on.
		await store.idempotency.put({
			id: "user:usr_tom:recoverSandbox:k-lapsed",
			createdAt: 0,
			claim: "claim_stalled",
			claimExpiresAt: 1,
		});
		const retried = await failure(tom.recoverSandbox(sandbox.id, key("k-lapsed")));
		expect(retried.status).toBe(409);
		expect(retried.details).toEqual({ idempotencyKey: "held" });
		expect(retried.code).toBe("conflict");
		expect(retried.message).toBe(CLAIM_LAPSED);
		expect(counts.recover).toBe(0);
		expect((await tom.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("never takes over a rotation's key: a retry is conflict, so a late first call can't undo the answer", async () => {
		const { tom, store } = setup();
		const made = await tom.createApiKey({ name: "ci", preset: "agent" });
		// A rotation whose gateway stopped renewing its claim, and may yet finish.
		await store.idempotency.put({
			id: "user:usr_tom:rotateApiKey:k-lapsed",
			createdAt: 0,
			claim: "claim_stalled",
			claimExpiresAt: 1,
		});
		const retried = await failure(tom.rotateApiKey(made.key.id, key("k-lapsed")));
		expect(retried.code).toBe("conflict");
		expect(retried.message).toBe(CLAIM_LAPSED);
		// A new key rotates it.
		expect((await tom.rotateApiKey(made.key.id, key("k-new"))).secret).not.toBe(made.secret);
	});
});

describe("a replay is held to what the caller may do now", () => {
	it("refuses a key's secret, made or rotated, to someone who may no longer grant its scopes", async () => {
		const { root } = setup();
		const body = { name: "ops", scopes: ["hosts:admin" as const] };
		const made = await root.createApiKey(body, key("admin-1"));
		const rotated = await root.rotateApiKey(made.key.id, key("admin-rotate-1"));
		expect(await root.createApiKey(body, key("admin-1"))).toEqual(made);
		rootIsSuperAdmin = false;
		expect((await failure(root.createApiKey(body, key("admin-1")))).code).toBe("forbidden");
		expect((await failure(root.rotateApiKey(made.key.id, key("admin-rotate-1")))).code).toBe("forbidden");
		rootIsSuperAdmin = true;
		expect(await root.rotateApiKey(made.key.id, key("admin-rotate-1"))).toEqual(rotated);
	});

	it("refuses an owner invite's code to an owner who has since become an admin", async () => {
		const { tom, store } = setup();
		const org = await tom.createOrganisation({ name: "Acme" });
		const invite = { email: "ann@example.com", role: "owner" as const };
		await tom.createInvite(org.id, invite, key("owner-invite"));
		const [member] = await store.members.list({ accountId: org.id, userId: "usr_tom" });
		await store.members.put({ ...(member as NonNullable<typeof member>), role: "admin" });
		expect((await failure(tom.createInvite(org.id, invite, key("owner-invite")))).code).toBe("forbidden");
	});

	it("rotates a key by itself without keeping an answer it couldn't sign in to fetch", async () => {
		const { tom, store } = setup();
		const made = await tom.createApiKey({ name: "admin", preset: "admin" });
		const as = (token: string) =>
			createKantelClient({
				baseUrl: BASE_URL,
				token,
				fetch: (input, init) => (opened[0] as ComputeApi).fetch(new Request(input, init)) as Promise<Response>,
			});
		const rotated = await as(made.secret).rotateApiKey(made.key.id, key("self-1"));
		const kept = (await store.idempotency.list({})).filter((record) => record.id.includes("rotateApiKey"));
		expect(kept.map((record) => record.secret)).toEqual(["withheld"]);
		expect(kept[0]?.body).not.toContain(rotated.secret);
		// The old secret can't sign in to a retry, so it can't rotate twice; the new one works.
		expect((await failure(as(made.secret).rotateApiKey(made.key.id, key("self-1")))).status).toBe(401);
		expect((await as(rotated.secret).getCaller()).apiKey?.id).toBe(made.key.id);
	});

	it("rotates a key by itself once when a retry overlaps it on another gateway", async () => {
		const base = createMemoryStore();
		// The rotation's write of the new secret stalls until `resume`; every other write goes through.
		let rotations = 0;
		let resume = () => {};
		const stalled = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let began = () => {};
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const store: ComputeStore = {
			...base,
			apiKeys: {
				...base.apiKeys,
				update: async (id, change, expected) => {
					const current = await base.apiKeys.get(id);
					const next = current === undefined ? undefined : change(current);
					if (next !== undefined && current !== undefined && next.secretHash !== current.secretHash) {
						rotations++;
						if (rotations === 1) {
							began();
							await stalled;
						}
					}
					return base.apiKeys.update(id, change, expected);
				},
			},
		};
		const stub = createStubBackend();
		const gateway = () => {
			const api = createComputeApi({
				store,
				backend: stub,
				authenticatePerson: async (request) => person(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")),
				fetch: async () => new Response(null, { status: 204 }),
			});
			opened.push(api);
			return (token: string) =>
				createKantelClient({
					baseUrl: BASE_URL,
					token,
					fetch: (input, init) =>
						api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
				});
		};
		const first = gateway();
		const second = gateway();
		const made = await first("tom-token").createApiKey({ name: "admin", preset: "admin" });
		const rotating = first(made.secret).rotateApiKey(made.key.id, key("self-overlap"));
		await started;
		// The old secret still signs in, and the key is held: the retry is conflict, not a second rotation.
		const retried = await failure(second(made.secret).rotateApiKey(made.key.id, key("self-overlap")));
		expect(retried.code).toBe("conflict");
		resume();
		const rotated = await rotating;
		expect(rotations).toBe(1);
		expect((await second(rotated.secret).getCaller()).apiKey?.id).toBe(made.key.id);
		expect((await failure(second(made.secret).getCaller())).status).toBe(401);
	});
});

describe("retries that need no key", () => {
	it("stops, starts, resumes and deletes a sandbox already so, answering it as it is", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		expect((await tom.startSandbox(sandbox.id, {})).state).toBe("running");
		expect((await tom.resumeSandbox(sandbox.id, {})).state).toBe("running");
		const stopped = await tom.stopSandbox(sandbox.id, { wait: true });
		expect(stopped.state).toBe("stopped");
		expect(await tom.stopSandbox(sandbox.id, { wait: true })).toEqual(stopped);
		const paused = await tom.createSandbox({ type: "microvm", wait: true });
		const pausedOnce = await tom.stopSandbox(paused.id, { keepMemory: true, wait: true });
		expect((await tom.stopSandbox(paused.id, { keepMemory: true, wait: true })).state).toBe(pausedOnce.state);
	});

	it("deletes a sandbox once: a retry with the key answers the first answer, one without is not_found", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const first = await tom.deleteSandbox(sandbox.id, key("delete-1"));
		expect(await tom.deleteSandbox(sandbox.id, key("delete-1"))).toEqual(first);
		expect((await failure(tom.deleteSandbox(sandbox.id))).code).toBe("not_found");
	});

	it("kills an ended command, writes a file and revokes a key again with the same answer", async () => {
		const { tom } = setup();
		const sandbox = await tom.createSandbox({ wait: true });
		const command = await tom.runCommand(sandbox.id, { command: "echo done" });
		expect(await tom.killCommand(sandbox.id, command.id)).toEqual(await tom.killCommand(sandbox.id, command.id));

		const file = { path: "notes.md", content: "# Notes" };
		const written = await tom.writeFile(sandbox.id, file);
		expect(await tom.writeFile(sandbox.id, file)).toMatchObject({ path: written.path, size: written.size });
		expect((await tom.readFile(sandbox.id, { path: "notes.md" })).content).toBe("# Notes");

		const made = await tom.createApiKey({ name: "old", preset: "agent" });
		const revoked = await tom.revokeApiKey(made.key.id);
		expect(await tom.revokeApiKey(made.key.id)).toEqual(revoked);
	});

	it("exposes a public port again with the same answer, without a key", async () => {
		const { tom, counts } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const first = await tom.exposePort(sandbox.id, { port: 8080, public: true });
		expect(await tom.exposePort(sandbox.id, { port: 8080, public: true })).toEqual(first);
		expect(counts.exposePort).toBe(1);
	});
});

describe("canonicalJson", () => {
	it("reads the same for the same request whatever its keys' order, and leaves out absent values", () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
			canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
		);
		expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
	});
});
