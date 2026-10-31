// The dynamic-worker isolate backend in Node: the isolate's own code (src/isolate/runner.ts) behind a stand-in for the
// Worker Loader that keeps one isolate per loader ID and copies every argument and result as RPC would, so only plain
// data and the workspace port cross the boundary. The tiered sandboxes and the measurement run on it as on Cloudflare.
import { type CallContext, isKantelError } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import type { ShellRequest } from "@kantel/sandbox/isolate";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import {
	bundleId,
	createDynamicWorkerIsolateBackend,
	ISOLATE_COMPATIBILITY_DATE,
	ISOLATE_ENTRYPOINT,
	type IsolateCode,
	isolateId,
	type WorkerLoaderLike,
	workerLoaderIsolates,
} from "../src/dynamic-worker.ts";
import { createGateway } from "../src/gateway.ts";
import {
	createIsolateRunner,
	type IsolateExecOptions,
	type IsolatePort,
	type IsolateRunner,
} from "../src/isolate/runner.ts";
import { MEASURE_FILES, MEASURE_PATH, type Placement } from "../src/measure.ts";
import { isolateBackendName } from "../src/sandboxes.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";
const BUNDLE = "export class KantelIsolate {}";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** A Worker Loader stand-in: one runner per ID, made on first use, with RPC's copying at the boundary. */
function fakeLoader() {
	const isolates = new Map<string, IsolateRunner>();
	const codes: IsolateCode[] = [];
	const entrypoints: (string | undefined)[] = [];
	/** Each command as the isolate ran it, settled when the isolate finished it (not when the caller stopped waiting). */
	const runs: Promise<unknown>[] = [];
	const loader: WorkerLoaderLike = {
		get(id, code) {
			return {
				getEntrypoint(name) {
					entrypoints.push(name);
					return {
						async exec(port: IsolatePort, request: ShellRequest, options?: IsolateExecOptions) {
							let runner = isolates.get(id);
							if (runner === undefined) {
								codes.push(await code());
								runner = createIsolateRunner();
								isolates.set(id, runner);
							}
							const ran = runner.exec(port, structuredClone(request), structuredClone(options));
							runs.push(ran.catch((error: unknown) => error));
							return structuredClone(await ran);
						},
					};
				},
			};
		},
	};
	return { loader, isolates, codes, entrypoints, runs };
}

async function setup(options: { placement?: () => Promise<Placement> } = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
	});
	const fake = fakeLoader();
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		isolateBackend: "dynamic-worker",
		extraIsolateBackends: (workspaces) => ({
			"dynamic-worker": createDynamicWorkerIsolateBackend(workspaces, {
				load: workerLoaderIsolates(fake.loader, BUNDLE),
				bundleId: bundleId(BUNDLE),
			}),
		}),
	});
	opened.push(stack);
	const gateway = createGateway(stack, options.placement === undefined ? {} : { placement: options.placement });
	const signedIn = { "cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }) };
	const measure = (body?: unknown) =>
		gateway.fetch(
			new Request(`${BASE}${MEASURE_PATH}`, {
				method: "POST",
				headers: { ...signedIn, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	const workspace = async () => {
		const made = await stack.workspaces.create(stack.admin, {
			owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		});
		await stack.workspaces.commit(stack.admin, made.id, {
			baseVersion: made.head,
			changes: [{ op: "put", path: "notes/a.md", content: "# A" }],
		});
		return made.id;
	};
	const session = async (workspaceId: string) =>
		stack.runtime.runtime.create(stack.admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			title: "Sandboxed",
			workspaceId,
		});
	const run = (ctx: CallContext, sessionId: string, workspaceId: string, command: string) =>
		stack.sandboxes.sandboxes.run(ctx, { sessionId, workspaceId, tool: "bash", request: { command } });
	return { stack, fake, measure, workspace, session, run };
}

describe("the dynamic-worker isolate backend", () => {
	it("runs a session's commands in its own isolate and commits what they write", async () => {
		const { stack, fake, workspace, session, run } = await setup();
		expect(stack.sandboxes.backend).toBe("dynamic-worker");
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);

		const wrote = await run(stack.admin, sessionId, workspaceId, "cat notes/a.md && echo hello > notes/b.md");
		expect(wrote).toMatchObject({ exitCode: 0, stdout: "# A", tier: "isolate" });
		const read = await stack.workspaces.read(stack.admin, workspaceId, "notes/b.md");
		expect(new TextDecoder().decode(read.content)).toBe("hello\n");

		// The next command reuses the warm isolate and sees the committed change.
		const again = await run(stack.admin, sessionId, workspaceId, "cat notes/b.md");
		expect(again).toMatchObject({ exitCode: 0, stdout: "hello\n" });
		expect(fake.isolates.size).toBe(1);
		const [id] = fake.isolates.keys();
		expect(id).toBe(
			isolateId({
				organisationId: stack.organisation.id,
				sessionId,
				workspaceId,
				bundleId: bundleId(BUNDLE),
			}),
		);
	});

	it("gives every session its own isolate", async () => {
		const { stack, fake, workspace, session, run } = await setup();
		const workspaceId = await workspace();
		const first = await session(workspaceId);
		const second = await session(workspaceId);
		await run(stack.admin, first.id, workspaceId, "echo one > one.txt");
		const seen = await run(stack.admin, second.id, workspaceId, "cat one.txt");
		// Shared through the workspace, not the isolate.
		expect(seen).toMatchObject({ exitCode: 0, stdout: "one\n" });
		expect(fake.isolates.size).toBe(2);
	});

	it("loads the bundle with no bindings and no network", async () => {
		const { stack, fake, workspace, session, run } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		await run(stack.admin, sessionId, workspaceId, "true");
		expect(fake.entrypoints).toEqual([ISOLATE_ENTRYPOINT]);
		expect(fake.codes).toEqual([
			{
				compatibilityDate: ISOLATE_COMPATIBILITY_DATE,
				compatibilityFlags: ["nodejs_compat"],
				mainModule: "isolate.js",
				modules: { "isolate.js": BUNDLE },
				env: {},
				globalOutbound: null,
			},
		]);
	});

	it("stops a running command when its caller cancels, committing nothing", async () => {
		const { stack, fake, workspace, session, run } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const before = (await stack.workspaces.get(stack.admin, workspaceId)).head;
		const controller = new AbortController();
		const started = performance.now();
		const running = run(
			{ ...stack.admin, signal: controller.signal },
			sessionId,
			workspaceId,
			"echo a > a.txt; sleep 5; echo b > b.txt",
		);
		setTimeout(() => controller.abort(), 100);
		await expect(running).rejects.toSatisfy((error: unknown) => isKantelError(error, "aborted"));
		// The isolate itself stopped, well before the sleep would have ended.
		const stopped = await fake.runs[0];
		expect(String(stopped)).toMatch(/cancelled|aborted/);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect((await stack.workspaces.get(stack.admin, workspaceId)).head).toBe(before);
		for (const path of ["a.txt", "b.txt"]) {
			await expect(stack.workspaces.read(stack.admin, workspaceId, path)).rejects.toSatisfy((error: unknown) =>
				isKantelError(error, "not_found"),
			);
		}
	});

	it("drops a command cancelled before it starts", async () => {
		const { stack, workspace, session, run } = await setup();
		const workspaceId = await workspace();
		const { id: sessionId } = await session(workspaceId);
		const controller = new AbortController();
		controller.abort();
		const cancelled = run({ ...stack.admin, signal: controller.signal }, sessionId, workspaceId, "echo x > x.txt");
		await expect(cancelled).rejects.toSatisfy((error: unknown) => isKantelError(error, "aborted"));
		await expect(stack.workspaces.read(stack.admin, workspaceId, "x.txt")).rejects.toSatisfy((error: unknown) =>
			isKantelError(error, "not_found"),
		);
	});

	it("is a backend KANTEL_ISOLATE_BACKEND can name, and refused where the Worker has no loader", async () => {
		expect(isolateBackendName({ KANTEL_ISOLATE_BACKEND: "dynamic-worker" })).toBe("dynamic-worker");
		const config = gatewayConfig({ KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, KANTEL_ACCESS_AUD: AUD });
		await expect(createStack({ config, isolateBackend: "dynamic-worker" })).rejects.toSatisfy((error: unknown) =>
			isKantelError(error, "invalid"),
		);
	});

	it("changes the bundle's ID when the bundle changes", () => {
		expect(bundleId(BUNDLE)).toBe(bundleId(`${BUNDLE}`));
		expect(bundleId(BUNDLE)).not.toBe(bundleId(`${BUNDLE} `));
	});
});

describe("the isolate-ready measurement on dynamic-worker", () => {
	it("lists the measurement workspace in a fresh isolate for each new session", async () => {
		const { fake, measure } = await setup();
		const runs: { backend: string; exitCode: number; listed: number; timings: Record<string, number> }[] = [];
		for (let i = 0; i < 2; i += 1) {
			const response = await measure({ backend: "dynamic-worker" });
			expect(response.status).toBe(200);
			runs.push(await response.json());
		}
		for (const run of runs) {
			expect(run).toMatchObject({ backend: "dynamic-worker", exitCode: 0 });
			expect(run.listed).toBeGreaterThanOrEqual(MEASURE_FILES);
			expect(run.timings["isolate.cold"]).toBe(1);
			for (const phase of ["signIn", "session", "isolate", "total", "isolate.call"]) {
				expect(run.timings[phase]).toBeTypeOf("number");
			}
		}
		expect(fake.isolates.size).toBe(2);
	});

	it("says where the stack runs when asked, and only then", async () => {
		const where: Placement = {
			objectColo: "AMS",
			edgeColo: "LHR",
			d1: { region: "WEUR", colo: "AMS", primary: true, queries: [{ roundTripMs: 3, sqlMs: 0.1 }] },
		};
		const { measure } = await setup({ placement: async () => where });
		const asked = (await (await measure({ backend: "dynamic-worker", placement: true })).json()) as {
			placement?: Placement;
		};
		expect(asked.placement).toEqual(where);
		const plain = (await (await measure({ backend: "dynamic-worker" })).json()) as { placement?: Placement };
		expect(plain.placement).toBeUndefined();
		expect((await measure({ placement: "yes" })).status).toBe(400);
	});
});
