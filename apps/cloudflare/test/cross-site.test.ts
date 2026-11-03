// Cross-site writes and cookies on the Worker (TASK-4842), in Node over node:sqlite. Hosted ports live under
// ports.kantel.dev; until it is on the Public Suffix List a port's page is the same site as a console under kantel.dev,
// so SameSite stops nothing. These show what does: a cookie is never a Kantel session, whatever its name, and a write
// that carries no bearer must come from the console's own origin, Access's cookie or not. Bearer calls (the CLI, the
// SDK, MCP) pass unchanged, and the console's own sign-in, device approval and sandbox actions still work.
import { DatabaseSync } from "node:sqlite";
import { CROSS_SITE_REFUSED } from "@kantel/identity/csrf";
import { createMockAccess } from "@kantel/identity/testing";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { memoryMailCounts, type SendEmailBinding } from "../src/mail.ts";
import { createStack } from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
/** Behind Access, as harbour.myslop.app is. */
const ACCESS_HOST = "https://harbour.kantel.test";
/** The public origin, as app.kantel.dev is: email codes, no Access. */
const PUBLIC = "https://app.kantel.test";
/** A sandbox's exposed port: the same site as PUBLIC until the ports domain is on the Public Suffix List. */
const PORT_PAGE = "https://5173-k7xq2m.ports.kantel.test";
const ELSEWHERE = "https://evil.example";

type Sent = Parameters<SendEmailBinding["send"]>[0];

type CallOptions = {
	body?: unknown;
	token?: string;
	/** As Access at the edge: its assertion header, and the cookie the browser sent it. */
	access?: boolean;
	origin?: string;
	site?: string;
	cookie?: string;
	headers?: Record<string, string>;
};

async function start(vars: Record<string, string> = {}) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const sent: Sent[] = [];
	const pending: Promise<unknown>[] = [];
	const stack = await createStack({
		config: gatewayConfig({
			KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
			KANTEL_ACCESS_AUD: AUD,
			KANTEL_ADMIN_EMAIL: ADMIN,
			KANTEL_PUBLIC_URL: PUBLIC,
			KANTEL_SIGN_IN_FROM: "sign-in@kantel.test",
			...vars,
		}),
		accessFetch: mock.fetch,
		storage: { sql: syncSqliteDriver(new DatabaseSync(":memory:")) },
		mail: {
			binding: {
				send: async (message) => {
					sent.push(message);
					return { messageId: `m${sent.length}` };
				},
			},
			counts: memoryMailCounts(),
			defer: (work) => {
				pending.push(work);
			},
		},
	});
	const gateway = createGateway(stack);
	const accessToken = await mock.sign({ sub: "access-subject-1", email: ADMIN });

	const call = async (base: string, method: string, path: string, options: CallOptions = {}) => {
		const headers: Record<string, string> = { ...options.headers };
		if (options.body !== undefined) headers["content-type"] = "application/json";
		if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
		if (options.access === true) {
			headers["cf-access-jwt-assertion"] = accessToken;
			headers.cookie = `CF_Authorization=${accessToken}`;
		}
		if (options.cookie !== undefined) headers.cookie = options.cookie;
		if (options.origin !== undefined) headers.origin = options.origin;
		if (options.site !== undefined) headers["sec-fetch-site"] = options.site;
		const response = await gateway.fetch(
			new Request(`${base}${path}`, {
				method,
				headers,
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
	};

	/** The console on `base`, as a browser sends its writes: its own origin, same-origin. */
	const fromConsole = (base: string): CallOptions => ({ origin: base, site: "same-origin" });

	const codeFor = async (email: string): Promise<string> => {
		await Promise.all(pending.splice(0));
		const mail = sent.findLast((message) => message.to === email);
		const code = /code is (\d{6})/.exec(mail?.text ?? "")?.[1];
		if (code === undefined) throw new Error(`no code was sent to ${email}`);
		return code;
	};

	/** Signs `email` in on the public origin, as the console does; the session token. */
	const signIn = async (email: string): Promise<string> => {
		const started = await call(PUBLIC, "POST", "/auth/otp/start", { body: { email }, ...fromConsole(PUBLIC) });
		expect(started.status).toBe(202);
		const code = await codeFor(email);
		const verified = await call(PUBLIC, "POST", "/auth/otp/verify", { body: { email, code }, ...fromConsole(PUBLIC) });
		expect(verified.status).toBe(200);
		return String(verified.body.token);
	};

	const sandboxNames = async () => {
		const listed = await call(ACCESS_HOST, "GET", "/v1/sandboxes", { access: true });
		return (listed.body.items as { name?: string }[]).map((sandbox) => sandbox.name);
	};

	/** An identity key's body for `token`'s first project, as the console's Keys page sends it. */
	const keyBody = async (token: string, name: string) => {
		const projects = await call(PUBLIC, "GET", "/v1/projects", { token });
		const [project] = projects.body.items as { id: string }[];
		return { name, projectIds: [project?.id], role: "operator" };
	};

	return { call, fromConsole, signIn, keyBody, sent, pending, sandboxNames, close: () => stack.compute.close() };
}

const refused = (answer: { status: number; body: Record<string, unknown> }) => {
	expect(answer.status).toBe(403);
	expect(answer.body.error).toMatchObject({ code: "forbidden", message: CROSS_SITE_REFUSED });
};

describe("cookies are never a Kantel session", () => {
	it("refuses a valid session under any cookie name, the old one and a __Host- one included", async () => {
		const { call, fromConsole, signIn, close } = await start();
		const token = await signIn("ada@example.test");
		// The bearer works, so the token is good.
		expect((await call(PUBLIC, "GET", "/v1/me", { token })).status).toBe(200);
		// A page under kantel.dev can set any of these with Domain=kantel.dev; none of them signs anyone in.
		for (const cookie of [
			`kts=${token}`,
			`kts_session=${token}`,
			`kantel_session=${token}`,
			`__Host-kantel_session=${token}`,
			`session=${token}`,
			`authorization=Bearer%20${token}`,
		]) {
			expect((await call(PUBLIC, "GET", "/v1/me", { cookie })).status, cookie).toBe(401);
			const write = await call(PUBLIC, "POST", "/v1/keys", { cookie, body: { name: "x" }, ...fromConsole(PUBLIC) });
			expect(write.status, cookie).toBe(401);
		}
		await close();
	});

	it("never reads Access's own cookie: only the assertion Access adds at the edge signs a request in", async () => {
		const { call, close } = await start();
		expect((await call(ACCESS_HOST, "GET", "/v1/me", { access: true })).status).toBe(200);
		// The cookie alone, as a page could plant it for kantel.dev, is nothing to the Worker.
		const cookieOnly = await call(ACCESS_HOST, "GET", "/v1/me", { cookie: "CF_Authorization=forged" });
		expect(cookieOnly.status).toBe(401);
		await close();
	});
});

describe("a browser's write must come from the console's own origin", () => {
	it("refuses a write from a port's page or another site, even with Access's cookie signing it in", async () => {
		const { call, sandboxNames, close } = await start();
		for (const [origin, site] of [
			[PORT_PAGE, "same-site"],
			[PORT_PAGE, undefined],
			[ELSEWHERE, "cross-site"],
			[ELSEWHERE, undefined],
			["null", "cross-site"],
			[ACCESS_HOST, "same-site"],
			[ACCESS_HOST, "cross-site"],
			[undefined, "cross-site"],
			[undefined, "same-site"],
			[PUBLIC, undefined],
			[`${ACCESS_HOST}:8443`, undefined],
			["http://harbour.kantel.test", undefined],
		] as const) {
			const answer = await call(ACCESS_HOST, "POST", "/v1/sandboxes", {
				access: true,
				body: { name: "planted", wait: true },
				...(origin === undefined ? {} : { origin }),
				...(site === undefined ? {} : { site }),
			});
			refused(answer);
		}
		// Every method that changes something.
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			refused(await call(ACCESS_HOST, method, "/v1/sandboxes/sbx_any", { access: true, origin: PORT_PAGE }));
		}
		expect(await sandboxNames()).not.toContain("planted");
		await close();
	});

	it("refuses a page's write to Kantel Connect's host routes, and a host's own registration still goes through", async () => {
		const { call, fromConsole, close } = await start({ KANTEL_CONNECT: "experimental" });
		const enrolled = await call(ACCESS_HOST, "POST", "/v1/connect/enrolments", {
			body: {},
			access: true,
			...fromConsole(ACCESS_HOST),
		});
		expect(enrolled.status).toBe(201);
		const token = String(enrolled.body.token);
		// A port's page or another site, with Access's cookie or without: refused before the token is looked at.
		for (const [origin, site] of [
			[PORT_PAGE, "same-site"],
			[ELSEWHERE, "cross-site"],
		]) {
			refused(await call(PUBLIC, "POST", "/v1/hosts/register", { body: { token }, access: true, origin, site }));
			refused(await call(PUBLIC, "POST", "/v1/hosts/register", { body: { token }, origin, site }));
		}
		// kantel-host sends neither an Origin nor a cookie: it registers with the token, which is still unused.
		const registered = await call(PUBLIC, "POST", "/v1/hosts/register", { body: { token } });
		expect(registered.status).toBe(201);
		expect(String(registered.body.hostId)).toMatch(/^host_/);
		await close();
	});

	it("refuses a write that carries a cookie and no Origin and no bearer", async () => {
		const { call, sandboxNames, close } = await start();
		refused(await call(ACCESS_HOST, "POST", "/v1/sandboxes", { access: true, body: { name: "planted", wait: true } }));
		refused(await call(PUBLIC, "POST", "/v1/keys", { cookie: "anything=1", body: { name: "x" } }));
		expect(await sandboxNames()).not.toContain("planted");
		await close();
	});

	it("protects the sign-in routes: no code is sent, verified or ended for a page elsewhere", async () => {
		const { call, fromConsole, signIn, sent, pending, close } = await start();
		for (const origin of [PORT_PAGE, ELSEWHERE]) {
			const site = origin === PORT_PAGE ? "same-site" : "cross-site";
			refused(await call(PUBLIC, "POST", "/auth/otp/start", { body: { email: "bob@example.test" }, origin, site }));
			refused(
				await call(PUBLIC, "POST", "/auth/otp/verify", {
					body: { email: "bob@example.test", code: "000000" },
					origin,
					site,
				}),
			);
		}
		await Promise.all(pending.splice(0));
		expect(sent.filter((message) => message.to === "bob@example.test")).toEqual([]);
		// The console's own sign-in, and its sign-out with the bearer, still work.
		const token = await signIn("bob@example.test");
		const ended = await call(PUBLIC, "POST", "/auth/session/end", { token, ...fromConsole(PUBLIC) });
		expect(ended.status).toBeLessThan(300);
		expect((await call(PUBLIC, "GET", "/v1/me", { token })).status).toBe(401);
		await close();
	});

	it("protects the device page's approval, and the console's own approval still signs the device in", async () => {
		const { call, fromConsole, close } = await start();
		// `kantel login` starts and polls with no credential, no Origin and no cookie, as a command line does.
		const started = await call(ACCESS_HOST, "POST", "/v1/auth/device", { body: { clientName: "kantel on ci" } });
		expect(started.status).toBe(201);
		const { userCode, deviceCode } = started.body as { userCode: string; deviceCode: string };
		const approve = `/v1/auth/device/${encodeURIComponent(userCode)}/approve`;
		refused(await call(ACCESS_HOST, "POST", approve, { access: true, body: {}, origin: PORT_PAGE, site: "same-site" }));
		refused(await call(ACCESS_HOST, "POST", approve, { access: true, body: {} }));
		const pendingPoll = await call(ACCESS_HOST, "POST", "/v1/auth/device/token", { body: { deviceCode } });
		expect(pendingPoll.body.state).toBe("pending");
		const approved = await call(ACCESS_HOST, "POST", approve, { access: true, body: {}, ...fromConsole(ACCESS_HOST) });
		expect(approved.status).toBe(200);
		const polled = await call(ACCESS_HOST, "POST", "/v1/auth/device/token", { body: { deviceCode } });
		expect(polled.body.state).toBe("approved");
		await close();
	});

	it("lets the console's own writes through, on the Access hostname and the public one", async () => {
		const { call, fromConsole, signIn, keyBody, sandboxNames, close } = await start();
		const made = await call(ACCESS_HOST, "POST", "/v1/sandboxes", {
			access: true,
			body: { name: "console", wait: true },
			...fromConsole(ACCESS_HOST),
		});
		expect(made.status).toBe(201);
		// An older browser that sends Origin and no Sec-Fetch-Site.
		const older = await call(ACCESS_HOST, "POST", "/v1/sandboxes", {
			access: true,
			body: { name: "older", wait: true },
			origin: ACCESS_HOST,
		});
		expect(older.status).toBe(201);
		expect(await sandboxNames()).toEqual(expect.arrayContaining(["console", "older"]));
		const token = await signIn("carol@example.test");
		const body = await keyBody(token, "cli");
		const key = await call(PUBLIC, "POST", "/v1/keys", { token, body, ...fromConsole(PUBLIC) });
		expect(key.status).toBe(201);
		await close();
	});
});

describe("bearer calls are not cross-site writes", () => {
	it("passes the CLI's and the SDK's key-authenticated calls unchanged, with or without an Origin", async () => {
		const { call, fromConsole, signIn, keyBody, sandboxNames, close } = await start();
		const issued = await call(ACCESS_HOST, "POST", "/v1/api-keys", {
			access: true,
			body: { name: "cli", scopes: ["sandboxes:read", "sandboxes:write"] },
			...fromConsole(ACCESS_HOST),
		});
		expect(issued.status).toBe(201);
		const secret = String((issued.body as { secret?: string }).secret);
		expect(secret).toMatch(/^ksk_/);
		// As the CLI and the SDK send it: a bearer, no Origin, no cookie.
		const cli = await call(ACCESS_HOST, "POST", "/v1/sandboxes", { token: secret, body: { name: "cli", wait: true } });
		expect(cli.status).toBe(201);
		// A bearer is something no other page can attach, so an Origin beside it changes nothing.
		const sdk = await call(ACCESS_HOST, "POST", "/v1/sandboxes", {
			token: secret,
			body: { name: "sdk", wait: true },
			origin: ELSEWHERE,
			site: "cross-site",
		});
		expect(sdk.status).toBe(201);
		expect(await sandboxNames()).toEqual(expect.arrayContaining(["cli", "sdk"]));
		// A Kantel session as a bearer, as the console on the public origin sends it.
		const token = await signIn("dan@example.test");
		const body = await keyBody(token, "mcp");
		expect((await call(PUBLIC, "POST", "/v1/keys", { token, body, origin: PORT_PAGE, site: "same-site" })).status).toBe(
			201,
		);
		await close();
	});
});
