// Cross-site writes and cookies on the self-hosted gateway (TASK-4842), over a real socket. A sandbox's exposed port
// lives under KANTEL_COMPUTE_PORTS_DOMAIN; on a domain that isn't on the Public Suffix List, its page can be the same
// site as the console, so SameSite stops nothing. These show what does: a cookie is never a Kantel session, whatever its
// name, and a write that carries no bearer must come from the console's own origin. Bearer calls (the CLI, the SDK, MCP)
// pass unchanged, and the console's own sign-in, device approval and sandbox actions still work.

import { createAuthenticator } from "@kantel/identity/authenticator";
import { CROSS_SITE_REFUSED } from "@kantel/identity/csrf";
import { kantelSessionProvider, MemoryOtpMailer } from "@kantel/identity/otp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { type GatewayCompute, gatewayCompute } from "../../src/gateway/compute.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";

const ADMIN = "admin@kantel.localhost";
/** Where people reach the console through a proxy that ends TLS (KANTEL_PUBLIC_URL). */
const PUBLIC = "https://kantel.example.test";
/** A sandbox's exposed port under a ports domain beside it: the same site until that domain is on the PSL. */
const PORT_PAGE = "https://5173-k7xq2m.ports.example.test";
const ELSEWHERE = "https://evil.example";

const mailer = new MemoryOtpMailer();
let components: ReturnType<typeof createGatewayComponents>;
let compute: GatewayCompute;
let server: Listening;
/** The admin's session, signed in once: one email gets five codes an hour. */
let adminToken: string;

beforeAll(async () => {
	components = createGatewayComponents();
	await bootstrap(components, { organisation: "Test", project: "test", adminEmail: ADMIN });
	const authenticator = createAuthenticator({
		identity: components.identity,
		providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
	});
	compute = await gatewayCompute({ authenticator, identity: components.identity });
	const gateway = createGateway({ components, authenticator, compute: compute.api, mailer, publicOrigin: PUBLIC });
	server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
	adminToken = await signIn();
});

afterAll(async () => {
	await compute.close();
	await server.close();
	await components.close();
});

type CallOptions = {
	body?: unknown;
	token?: string;
	origin?: string;
	site?: string;
	cookie?: string;
};

async function call(method: string, path: string, options: CallOptions = {}) {
	const headers: Record<string, string> = {};
	if (options.body !== undefined) headers["content-type"] = "application/json";
	if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
	if (options.cookie !== undefined) headers.cookie = options.cookie;
	if (options.origin !== undefined) headers.origin = options.origin;
	if (options.site !== undefined) headers["sec-fetch-site"] = options.site;
	const response = await fetch(`${server.url}${path}`, {
		method,
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
}

/** The console as a browser sends its writes, on the gateway's own address (a laptop, the compose default). */
const fromConsole = (): CallOptions => ({ origin: server.url.replace(/\/$/, ""), site: "same-origin" });

const refused = (answer: { status: number; body: Record<string, unknown> }) => {
	expect(answer.status).toBe(403);
	expect(answer.body.error).toMatchObject({ code: "forbidden", message: CROSS_SITE_REFUSED });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signs the admin in as the console does; the session token. */
async function signIn(options: CallOptions = fromConsole()): Promise<string> {
	const before = mailer.sent.length;
	const started = await call("POST", "/auth/otp/start", { body: { email: ADMIN }, ...options });
	expect(started.status).toBe(202);
	// The code is mailed after the answer.
	for (let tries = 0; mailer.sent.length === before && tries < 100; tries++) await sleep(10);
	const code = mailer.lastCodeFor(ADMIN);
	const verified = await call("POST", "/auth/otp/verify", { body: { email: ADMIN, code }, ...options });
	expect(verified.status).toBe(200);
	return String(verified.body.token);
}

async function sandboxNames(token = compute.superAdminKey): Promise<(string | undefined)[]> {
	const listed = await call("GET", "/v1/sandboxes", { token });
	return (listed.body.items as { name?: string }[]).map((sandbox) => sandbox.name);
}

describe("cookies are never a Kantel session", () => {
	test("a valid session under any cookie name, the old one and a __Host- one included, signs nobody in", async () => {
		const token = adminToken;
		expect((await call("GET", "/v1/me", { token })).status).toBe(200);
		for (const cookie of [
			`kts=${token}`,
			`kts_session=${token}`,
			`kantel_session=${token}`,
			`__Host-kantel_session=${token}`,
			`session=${token}`,
		]) {
			expect((await call("GET", "/v1/me", { cookie })).status, cookie).toBe(401);
			expect((await call("GET", "/v1/whoami", { cookie })).status, cookie).toBe(401);
			const write = await call("POST", "/v1/sandboxes", { cookie, body: { name: "planted" }, ...fromConsole() });
			expect(write.status, cookie).toBe(401);
		}
		expect(await sandboxNames()).not.toContain("planted");
		expect(await sandboxNames(token)).not.toContain("planted");
	});

	test("sign-in answers with no cookie: the session is the bearer in its body", async () => {
		const post = (path: string, body: unknown) =>
			fetch(`${server.url}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headersOf(fromConsole()) },
				body: JSON.stringify(body),
			});
		const before = mailer.sent.length;
		const started = await post("/auth/otp/start", { email: ADMIN });
		expect(started.headers.get("set-cookie")).toBeNull();
		for (let tries = 0; mailer.sent.length === before && tries < 100; tries++) await sleep(10);
		const verified = await post("/auth/otp/verify", { email: ADMIN, code: mailer.lastCodeFor(ADMIN) });
		expect(verified.status).toBe(200);
		expect(verified.headers.get("set-cookie")).toBeNull();
		expect(String(((await verified.json()) as { token?: string }).token)).toMatch(/^kts_/);
	});
});

function headersOf(options: CallOptions): Record<string, string> {
	return {
		...(options.origin === undefined ? {} : { origin: options.origin }),
		...(options.site === undefined ? {} : { "sec-fetch-site": options.site }),
	};
}

describe("a browser's write must come from the console's own origin", () => {
	test("refuses a write from a port's page or another site, with a cookie or without", async () => {
		for (const [origin, site] of [
			[PORT_PAGE, "same-site"],
			[PORT_PAGE, undefined],
			[ELSEWHERE, "cross-site"],
			[ELSEWHERE, undefined],
			["null", "cross-site"],
			[PUBLIC, "same-site"],
			[undefined, "cross-site"],
			[undefined, "same-site"],
			["https://kantel.example.test:8443", undefined],
		] as const) {
			const answer = await call("POST", "/v1/sandboxes", {
				cookie: "kts=anything",
				body: { name: "planted" },
				...(origin === undefined ? {} : { origin }),
				...(site === undefined ? {} : { site }),
			});
			refused(answer);
		}
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			refused(await call(method, "/v1/sandboxes/sbx_any", { origin: PORT_PAGE }));
		}
		expect(await sandboxNames()).not.toContain("planted");
		expect(await sandboxNames(adminToken)).not.toContain("planted");
	});

	test("refuses a write that carries a cookie and no Origin and no bearer", async () => {
		refused(await call("POST", "/v1/sandboxes", { cookie: "kts=anything", body: { name: "planted" } }));
		refused(await call("POST", "/auth/otp/start", { cookie: "kts=anything", body: { email: ADMIN } }));
	});

	test("protects the sign-in routes: no code is sent or verified for a page elsewhere", async () => {
		const stranger = "stranger@kantel.localhost";
		for (const origin of [PORT_PAGE, ELSEWHERE]) {
			const site = origin === PORT_PAGE ? "same-site" : "cross-site";
			refused(await call("POST", "/auth/otp/start", { body: { email: ADMIN }, origin, site }));
			refused(await call("POST", "/auth/otp/verify", { body: { email: stranger, code: "000000" }, origin, site }));
			refused(await call("POST", "/auth/session/end", { cookie: "kts=anything", origin, site }));
		}
		// The console's own sign-in works on KANTEL_PUBLIC_URL (and on the gateway's address, before every test), and so
		// does signing out.
		const token = await signIn({ origin: PUBLIC, site: "same-origin" });
		const ended = await call("POST", "/auth/session/end", { token, ...fromConsole() });
		expect(ended.status).toBeLessThan(300);
		expect((await call("GET", "/v1/me", { token })).status).toBe(401);
	});

	test("protects the device page's approval, and the console's own approval still signs the device in", async () => {
		// `kantel login` starts and polls with no credential, no Origin and no cookie, as a command line does.
		const started = await call("POST", "/v1/auth/device", { body: { clientName: "kantel on ci" } });
		expect(started.status).toBe(201);
		const { userCode, deviceCode } = started.body as { userCode: string; deviceCode: string };
		const approve = `/v1/auth/device/${encodeURIComponent(userCode)}/approve`;
		refused(await call("POST", approve, { cookie: "kts=anything", body: {}, origin: PORT_PAGE, site: "same-site" }));
		refused(await call("POST", approve, { cookie: "kts=anything", body: {} }));
		expect((await call("POST", "/v1/auth/device/token", { body: { deviceCode } })).body.state).toBe("pending");
		const token = adminToken;
		const approved = await call("POST", approve, { token, body: {}, ...fromConsole() });
		expect(approved.status).toBe(200);
		expect((await call("POST", "/v1/auth/device/token", { body: { deviceCode } })).body.state).toBe("approved");
	});

	test("lets the console's own writes through: its address, its https twin and KANTEL_PUBLIC_URL", async () => {
		const token = adminToken;
		const host = new URL(server.url).host;
		for (const [name, origin] of [
			["own", server.url.replace(/\/$/, "")],
			["twin", `https://${host}`],
			["public", PUBLIC],
		] as const) {
			const made = await call("POST", "/v1/sandboxes", { token, body: { name }, origin, site: "same-origin" });
			expect(made.status, name).toBe(201);
		}
		expect(await sandboxNames(token)).toEqual(expect.arrayContaining(["own", "twin", "public"]));
	});
});

describe("bearer calls are not cross-site writes", () => {
	test("passes the CLI's and the SDK's key-authenticated calls unchanged, with or without an Origin", async () => {
		const key = compute.superAdminKey;
		// As the CLI and the SDK send it: a bearer, no Origin, no cookie.
		expect((await call("POST", "/v1/sandboxes", { token: key, body: { name: "cli" } })).status).toBe(201);
		// A bearer is something no other page can attach, so an Origin beside it changes nothing.
		const sdk = await call("POST", "/v1/sandboxes", {
			token: key,
			body: { name: "sdk" },
			origin: ELSEWHERE,
			site: "cross-site",
		});
		expect(sdk.status).toBe(201);
		const issued = await call("POST", "/v1/api-keys", {
			token: key,
			body: { name: "mcp", scopes: ["sandboxes:read"] },
		});
		expect(issued.status).toBe(201);
		const mcp = String((issued.body as { secret?: string }).secret);
		expect((await call("GET", "/v1/sandboxes", { token: mcp })).status).toBe(200);
		expect(await sandboxNames()).toEqual(expect.arrayContaining(["cli", "sdk"]));
	});
});
