// The gateway in process, over a real socket, with no stack: the same end-to-end pass the compose test makes, plus
// the HTTP adapter's limits, the bootstrap file's permissions and an older version's bootstrap file.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMAIL_OTP_ISSUER, systemContext } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type Bootstrap, bootstrap, createGatewayComponents, inviteAdmin } from "../../src/gateway/components.ts";
import { type GatewayCompute, gatewayCompute } from "../../src/gateway/compute.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { readBootstrap, writePrivateFile } from "../../src/gateway/main.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";
import { type E2eTarget, runGatewayE2e } from "./e2e.ts";
import { runSignInE2e } from "./signin-e2e.ts";

const REQUEST_TIMEOUT_MS = 1000;
const ADMIN_EMAIL = "Admin@Kantel.localhost";
const mailer = new MemoryOtpMailer();
let components: ReturnType<typeof createGatewayComponents>;
let compute: GatewayCompute;

let server: Listening;
let target: E2eTarget & Bootstrap;
let scratch: string;
let close: () => Promise<void>;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "kantel-gateway-"));
	await writeFile(join(scratch, "index.html"), '<!doctype html><div id="root"></div>');
	components = createGatewayComponents();
	const seeded = await bootstrap(components, {
		organisation: "Test",
		project: "test",
		adminEmail: ADMIN_EMAIL,
		projects: ["atlas", "dev"],
	});
	// As `serveGateway` mounts it, on the stub: the compute plane and the gateway share one authenticator.
	const authenticator = createAuthenticator({
		identity: components.identity,
		providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
	});
	compute = await gatewayCompute({ authenticator, identity: components.identity });
	const gateway = createGateway({ components, authenticator, compute: compute.api, consoleDir: scratch, mailer });
	server = await listen(gateway.fetch, 0, { host: "127.0.0.1", requestTimeoutMs: REQUEST_TIMEOUT_MS });
	target = { baseUrl: server.url, ...seeded, computeKey: compute.superAdminKey };
	close = async () => {
		await gateway.close();
		await compute.close();
		await server.close();
		await components.close();
	};
});

afterAll(async () => {
	await close();
	await rm(scratch, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the gateway serves the compute plane and identity end to end, and none of the agent plane", async () => {
	const checks = await runGatewayE2e(target);
	expect(checks.filter((check) => !check.ok)).toEqual([]);
	expect(checks.length).toBeGreaterThan(15);
});

/** The newest code the memory mailer sent to `email`, waiting up to `timeoutMs` for one. */
async function memoryCode(email: string, _since: number, timeoutMs: number): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const code = mailer.lastCodeFor(email);
		if (code !== undefined) return code;
		if (Date.now() >= deadline) return undefined;
		await sleep(20);
	}
}

test("email one-time PIN sign-in starts a Kantel session the compute plane accepts", async () => {
	// As configured, mixed case and all: sign-in and /v1/me both compare it normalised.
	const checks = await runSignInE2e({ ...target, adminEmail: ADMIN_EMAIL, readCode: memoryCode });
	expect(checks.filter((check) => !check.ok)).toEqual([]);
	expect(checks.length).toBeGreaterThanOrEqual(12);
});

describe("inviting the admin", () => {
	const email = "invited@kantel.localhost";
	const asOtp = { issuer: EMAIL_OTP_ISSUER, subject: email, email, emailVerified: true } as const;
	const names = { organisation: "Invite", project: "invite" };

	/** A fresh deployment, and the admin bindings `email`'s user holds in its organisation. */
	async function fresh() {
		const parts = createGatewayComponents();
		const seeded = await bootstrap(parts, names);
		const inOrganisation = {
			actor: { kind: "system", component: "test" },
			organisationId: seeded.organisationId,
		} as const;
		const adminBindings = async () => {
			if (!(await parts.identity.canSignIn(systemContext("test"), asOtp))) return [];
			const { user } = await parts.identity.signIn(systemContext("test"), asOtp);
			return (await parts.identity.listRoleBindings(inOrganisation)).filter(
				(binding) => binding.principal.kind === "user" && binding.principal.userId === user.id,
			);
		};
		return { parts, seeded, inOrganisation, adminBindings };
	}

	test("twice before anyone signs in creates one user, with one admin binding", async () => {
		const { parts, seeded, adminBindings } = await fresh();
		const createUser = vi.spyOn(parts.identity, "createUser");
		await inviteAdmin(parts.identity, seeded.organisationId, email);
		await inviteAdmin(parts.identity, seeded.organisationId, email);
		expect(createUser).toHaveBeenCalledTimes(1);
		expect((await adminBindings()).map((binding) => binding.role)).toEqual(["admin"]);
		await parts.close();
	});

	test("after the person has signed in creates no user", async () => {
		const { parts, seeded } = await fresh();
		await inviteAdmin(parts.identity, seeded.organisationId, email);
		await parts.identity.signIn(systemContext("test"), asOtp);
		const createUser = vi.spyOn(parts.identity, "createUser");
		await inviteAdmin(parts.identity, seeded.organisationId, email);
		expect(createUser).not.toHaveBeenCalled();
		await parts.close();
	});

	test("an attempt that stopped before its grant is finished by the next, with no second user", async () => {
		const { parts, seeded, adminBindings } = await fresh();
		const createUser = vi.spyOn(parts.identity, "createUser");
		vi.spyOn(parts.identity, "grantRole").mockRejectedValueOnce(new Error("the database went away"));
		await expect(bootstrap(parts, { ...names, adminEmail: email }, seeded)).rejects.toThrow(/went away/);
		expect(await adminBindings()).toEqual([]);
		const retried = await bootstrap(parts, { ...names, adminEmail: email }, seeded);
		expect(retried.invitedAdmin).toBe(email);
		expect(createUser).toHaveBeenCalledTimes(1);
		expect((await adminBindings()).map((binding) => binding.role)).toEqual(["admin"]);
		await parts.close();
	});

	test("a finished invite is not repeated, so a role removed since stays removed", async () => {
		const { parts, seeded, inOrganisation, adminBindings } = await fresh();
		const invited = await bootstrap(parts, { ...names, adminEmail: email.toUpperCase() }, seeded);
		expect(invited.invitedAdmin).toBe(email);
		const [binding] = await adminBindings();
		if (binding === undefined) throw new Error("the invite granted nothing");
		await parts.identity.revokeRole(inOrganisation, { principal: binding.principal });
		await bootstrap(parts, { ...names, adminEmail: email }, invited);
		expect(await adminBindings()).toEqual([]);
		await parts.close();
	});
});

test("without a mailer the sign-in routes answer 503, and API keys still work", async () => {
	const bare = createGateway({ components });
	for (const path of ["/auth/otp/start", "/auth/otp/verify", "/auth/session/end"]) {
		const response = await bare.fetch(new Request(`http://gateway${path}`, { method: "POST", body: "{}" }));
		expect(response.status).toBe(503);
	}
	const deployment = await bare.fetch(
		new Request("http://gateway/v1/deployment", { headers: { authorization: `Bearer ${target.apiKey}` } }),
	);
	expect(deployment.status).toBe(200);
	await bare.close();
});

test("sign-in requests are limited per client address, and another address is unaffected", async () => {
	const limited = createGateway({
		components,
		mailer: new MemoryOtpMailer(),
		signInLimit: { requests: 3, windowMilliseconds: 60_000 },
	});
	const start = (address: string) =>
		limited.fetch(
			new Request("http://gateway/auth/otp/start", {
				method: "POST",
				headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
				body: JSON.stringify({ email: `someone-${crypto.randomUUID()}@example.com` }),
			}),
			{ address },
		);
	const statuses = [];
	for (let i = 0; i < 4; i += 1) statuses.push((await start("192.0.2.1")).status);
	expect(statuses).toEqual([202, 202, 202, 429]);
	const refused = await start("192.0.2.1");
	const retryAfter = Number(refused.headers.get("retry-after"));
	expect(retryAfter).toBeGreaterThan(0);
	expect(retryAfter).toBeLessThanOrEqual(60);
	expect((await start("192.0.2.2")).status).toBe(202);
	await limited.close();
});

test("static paths cannot leave the console directory", async () => {
	const outside = join(scratch, "..", `kantel-outside-${crypto.randomUUID()}.txt`);
	await writeFile(outside, "outside-sentinel");
	try {
		const name = outside.split("/").pop();
		for (const path of [`/..%2f${name}`, `/%2e%2e/${name}`, `/assets/../../${name}`, `/../${name}`]) {
			const response = await fetch(`${server.url}${path}`);
			expect(await response.text()).not.toContain("outside-sentinel");
		}
	} finally {
		await rm(outside, { force: true });
	}
});

test("an organisation key creates a project with POST /v1/projects", async () => {
	const inOrganisation = {
		actor: { kind: "system", component: "test" },
		organisationId: target.organisationId,
	} as const;
	const service = await components.identity.createServiceIdentity(inOrganisation, { name: "host app" });
	const issued = await components.identity.issueApiKey(inOrganisation, {
		serviceId: service.id,
		scope: "organisation",
		role: "operator",
		permissions: ["create_projects"],
	});
	const call = (path: string, init: RequestInit = {}, secret = issued.secret) =>
		fetch(`${target.baseUrl}${path}`, {
			...init,
			headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
		});
	const created = await call("/v1/projects", { method: "POST", body: JSON.stringify({ name: "Customer 42" }) });
	expect(created.status).toBe(201);
	const project = (await created.json()) as { id: string; organisationId: string };
	expect(project.organisationId).toBe(target.organisationId);
	const listed = (await (await call("/v1/projects?limit=1000")).json()) as { items: { id: string }[] };
	expect(listed.items.map((item) => item.id)).toContain(project.id);
	// The bootstrap's project key makes none.
	const refused = await call("/v1/projects", { method: "POST", body: '{"name":"No"}' }, target.apiKey);
	expect(refused.status).toBe(403);
	await components.identity.revokeApiKey(inOrganisation, issued.key.id);
});

test("HEAD answers with headers and no body", async () => {
	const response = await fetch(`${server.url}/`, { method: "HEAD" });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
	expect(await response.text()).toBe("");
});

test("a body over the limit is refused with 413", async () => {
	const response = await fetch(`${target.baseUrl}/v1/projects`, {
		method: "POST",
		headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
		body: "x".repeat(5 * 1024 * 1024),
	});
	expect(response.status).toBe(413);
});

test("a request whose body never finishes is cut off", async () => {
	// A client that sends half a body and stalls.
	const port = new URL(server.url).port;
	const closedAfter = await new Promise<number>((resolve, reject) => {
		const started = Date.now();
		const socket = connect(Number(port), "127.0.0.1", () => {
			socket.write(
				`POST /v1/projects HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"pro`,
			);
		});
		const watchdog = setTimeout(() => {
			socket.destroy();
			reject(new Error("the stalled request was never cut off"));
		}, REQUEST_TIMEOUT_MS * 10);
		socket.on("data", () => {});
		socket.on("close", () => {
			clearTimeout(watchdog);
			resolve(Date.now() - started);
		});
		socket.on("error", () => {});
	});
	expect(closedAfter).toBeLessThan(REQUEST_TIMEOUT_MS * 10);
}, 20_000);

test("an older version's bootstrap file is read, and its agent-plane fields kept for a rollback", async () => {
	const parts = createGatewayComponents();
	const names = { organisation: "Upgrade", project: "upgrade" };
	const first = await bootstrap(parts, names);
	// What a version with the agent plane wrote: its workspace, vault items and egress grants beside the deployment.
	const path = join(scratch, "state", "older-bootstrap.json");
	const older = {
		...first,
		workspaceId: "w_older",
		cpaItem: { name: "cpa", id: "vi_1" },
		modelItems: { cpa: { name: "cpa", id: "vi_1" } },
		egressGrants: "sha256:abc",
	};
	await writePrivateFile(path, JSON.stringify(older));
	const previous = await readBootstrap(path);
	expect(previous?.organisationId).toBe(first.organisationId);
	const again = await bootstrap(parts, names, previous);
	expect(again).toMatchObject({
		organisationId: first.organisationId,
		projectId: first.projectId,
		apiKey: first.apiKey,
		workspaceId: "w_older",
		cpaItem: { name: "cpa", id: "vi_1" },
		modelItems: { cpa: { name: "cpa", id: "vi_1" } },
		egressGrants: "sha256:abc",
	});
	// A new deployment (a fresh database) keeps none of them.
	const elsewhere = createGatewayComponents();
	const fresh = await bootstrap(elsewhere, names, previous);
	expect(fresh.organisationId).not.toBe(first.organisationId);
	expect(fresh).not.toHaveProperty("workspaceId");
	await parts.close();
	await elsewhere.close();
});

test("the bootstrap file is private even when it replaces a readable one", async () => {
	const path = join(scratch, "state", "bootstrap.json");
	await writePrivateFile(path, "first");
	await writeFile(path, "old", { mode: 0o644 });
	const { chmod } = await import("node:fs/promises");
	await chmod(path, 0o644);
	await writePrivateFile(path, '{"apiKey":"ktk_secret"}');
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(await readFile(path, "utf8")).toBe('{"apiKey":"ktk_secret"}');
});
