import {
	authenticationFailureOf,
	type CallContext,
	EMAIL_OTP_ISSUER,
	externalSubjectOf,
	type IdentityDirectory,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	type OtpVerifyResponse,
	SESSION_END_PATH,
} from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { createMemoryIdentity } from "@kantel/identity/memory";
import {
	createEmailOtp,
	createMemoryOtpStores,
	DEFAULT_SESSION_TTL_MILLISECONDS,
	type EmailOtpOptions,
	generateOtpCode,
	hashSessionToken,
	isSessionToken,
	kantelSessionProvider,
	MemoryOtpMailer,
	OTP_CODE_TTL_MILLISECONDS,
	OTP_RATE_WINDOW_MILLISECONDS,
	type OtpCodeStore,
	type OtpMailer,
	type SessionStore,
} from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { createSqlIdentity, createSqlOtpStores, migrateIdentity } from "@kantel/identity/sql";
import type { SqlDriver } from "@kantel/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { ManualClock, RecordingAuditSink, WORKER } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };

interface Backend {
	readonly name: string;
	/** The database kind's longer timeout, when its fixture is slow (`TestDatabaseKind.testTimeoutMs`). */
	readonly testTimeoutMs?: number;
	open(
		clock: ManualClock,
		audit: RecordingAuditSink,
	): Promise<{
		readonly identity: IdentityDirectory;
		readonly codes: OtpCodeStore;
		readonly sessions: SessionStore;
		readonly driver?: SqlDriver;
		close(): Promise<void>;
	}>;
}

const backends: Backend[] = [
	{
		name: "memory",
		async open(clock, audit) {
			return { identity: createMemoryIdentity({ clock, audit }), ...createMemoryOtpStores(), close: async () => {} };
		},
	},
	...testDatabaseKinds().map(
		(kind): Backend => ({
			name: kind.name,
			testTimeoutMs: kind.testTimeoutMs,
			async open(clock, audit) {
				const database = await kind.open();
				await migrateIdentity(database.driver);
				return {
					identity: createSqlIdentity({ driver: database.driver, clock, audit }),
					...createSqlOtpStores(database.driver),
					driver: database.driver,
					close: () => database.close(),
				};
			},
		}),
	),
];

/** A driver that records every statement it runs, for comparing the work two calls do. */
function recording(driver: SqlDriver) {
	const statements: string[] = [];
	const wrapped: SqlDriver = {
		dialect: driver.dialect,
		query(sql, params) {
			statements.push(sql);
			return driver.query(sql, params);
		},
		batch(batch) {
			for (const statement of batch) statements.push(statement.sql);
			return driver.batch(batch);
		},
	};
	return { driver: wrapped, statements };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	new Request(`https://kantel.test${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

async function harness(backend: Backend, overrides: Partial<EmailOtpOptions> = {}) {
	const clock = new ManualClock();
	const audit = new RecordingAuditSink();
	const opened = await backend.open(clock, audit);
	const { identity, codes, sessions } = opened;
	const founder = await identity.createUser(bootstrap, { name: "Founder", email: "founder@example.test" });
	const organisation = await identity.createOrganisation(bootstrap, {
		name: "Org",
		admin: { kind: "user", userId: founder.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
	const ada = await identity.createUser(admin, { name: "Ada", email: "Ada@Example.test" });
	await identity.grantRole(admin, { principal: { kind: "user", userId: ada.id }, role: "viewer" });
	const mailer = new MemoryOtpMailer();
	const pending: Promise<unknown>[] = [];
	const otp = createEmailOtp({
		identity,
		codes,
		sessions,
		mailer,
		clock,
		audit,
		defer: (work) => {
			pending.push(work);
		},
		...overrides,
	});
	const handler = createOtpHandler({ otp });
	const authenticator = createAuthenticator({
		identity,
		providers: [kantelSessionProvider({ sessions, clock })],
	});
	const settle = async () => {
		await Promise.all(pending.splice(0));
	};
	const start = async (email: string) => {
		const response = await handler(post(OTP_START_PATH, { email }));
		await settle();
		return response;
	};
	const verify = (email: string, code: string) => handler(post(OTP_VERIFY_PATH, { email, code }));
	const whoAmI = (token: string) =>
		authenticator.authenticate(
			new Request("https://kantel.test/v1/sessions", { headers: { authorization: `Bearer ${token}` } }),
		);
	return { ...opened, clock, audit, organisation, admin, ada, mailer, otp, handler, start, verify, whoAmI, settle };
}

/** A code that is not `code`. */
const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

for (const backend of backends) {
	describe(`email one-time PIN on ${backend.name}`, { timeout: backend.testTimeoutMs }, () => {
		it("signs an invited user in end to end, and the session authenticates as them", async () => {
			const h = await harness(backend);
			try {
				const started = await h.start("  ADA@example.test ");
				expect(started.status).toBe(202);
				expect(await started.json()).toEqual({ status: "accepted" });
				expect(h.mailer.sent).toHaveLength(1);
				const [mail] = h.mailer.sent;
				expect(mail?.to).toBe("ADA@example.test");
				expect(mail?.code).toMatch(/^[0-9]{6}$/);
				expect(mail?.expiresAt).toBe(h.clock.now() + OTP_CODE_TTL_MILLISECONDS);

				const verified = await h.verify("ada@example.test", mail?.code ?? "");
				expect(verified.status).toBe(200);
				expect(verified.headers.get("cache-control")).toBe("no-store");
				const body = (await verified.json()) as OtpVerifyResponse;
				expect(body.token).toMatch(/^kts_[A-Za-z0-9_-]{43}$/);
				expect(body.expiresAt).toBe(h.clock.now() + DEFAULT_SESSION_TTL_MILLISECONDS);
				expect(body.user.id).toBe(h.ada.id);
				expect(body.user.externalSubject).toBe(externalSubjectOf(EMAIL_OTP_ISSUER, "ada@example.test"));
				expect(body.organisationIds).toEqual([h.organisation.id]);

				expect(await h.whoAmI(body.token)).toEqual({
					method: "harbour_session",
					actor: { kind: "human", userId: h.ada.id },
					organisationId: h.organisation.id,
				});
				const started2 = h.audit.ofType("identity.session.started");
				expect(started2).toHaveLength(1);
				expect(started2[0]).toMatchObject({
					actor: { kind: "human", userId: h.ada.id },
					organisationId: h.organisation.id,
					subject: { kind: "identity.session" },
				});
				expect(JSON.stringify(h.audit.events)).not.toContain(body.token);
				expect(JSON.stringify(h.audit.events)).not.toContain(mail?.code);
			} finally {
				await h.close();
			}
		});

		it("answers a stranger exactly as it answers an invited user, and mails nobody", async () => {
			const h = await harness(backend);
			try {
				const invited = await h.start("ada@example.test");
				const stranger = await h.start("stranger@example.test");
				expect(stranger.status).toBe(invited.status);
				expect(await stranger.text()).toBe(await invited.text());
				expect([...stranger.headers.entries()]).toEqual([...invited.headers.entries()]);
				expect(h.mailer.sent.map((message) => message.to)).toEqual(["ada@example.test"]);

				// Whatever a stranger guesses, verify answers as it does for a wrong code.
				const strangerVerify = await h.verify("stranger@example.test", "123456");
				const wrongVerify = await h.verify("ada@example.test", wrong(h.mailer.lastCodeFor("ada@example.test") ?? ""));
				expect(strangerVerify.status).toBe(401);
				expect(await strangerVerify.text()).toBe(await wrongVerify.text());
			} finally {
				await h.close();
			}
		});

		it("refuses an expired code", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				const code = h.mailer.lastCodeFor("ada@example.test") ?? "";
				h.clock.advance(OTP_CODE_TTL_MILLISECONDS);
				expect((await h.verify("ada@example.test", code)).status).toBe(401);
			} finally {
				await h.close();
			}
		});

		it("signs in once per code: a used code is refused", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				const code = h.mailer.lastCodeFor("ada@example.test") ?? "";
				expect((await h.verify("ada@example.test", code)).status).toBe(200);
				expect((await h.verify("ada@example.test", code)).status).toBe(401);
			} finally {
				await h.close();
			}
		});

		it("allows five tries: a right code on the fifth works, and five wrong ones burn the code", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				let code = h.mailer.lastCodeFor("ada@example.test") ?? "";
				for (let attempt = 0; attempt < 4; attempt += 1) {
					expect((await h.verify("ada@example.test", wrong(code))).status).toBe(401);
				}
				expect((await h.verify("ada@example.test", code)).status).toBe(200);

				await h.start("ada@example.test");
				code = h.mailer.lastCodeFor("ada@example.test") ?? "";
				for (let attempt = 0; attempt < 5; attempt += 1) {
					expect((await h.verify("ada@example.test", wrong(code))).status).toBe(401);
				}
				expect((await h.verify("ada@example.test", code)).status).toBe(401);
			} finally {
				await h.close();
			}
		});

		it("never lets concurrent guesses past the attempt limit, and a code signs in once under a race", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				const code = h.mailer.lastCodeFor("ada@example.test") ?? "";
				const guesses = await Promise.allSettled(
					Array.from({ length: 20 }, () => h.otp.verify("ada@example.test", wrong(code))),
				);
				for (const guess of guesses) {
					expect(guess.status === "rejected" && authenticationFailureOf(guess.reason) === "invalid").toBe(true);
				}
				await expect(h.otp.verify("ada@example.test", code)).rejects.toSatisfy(
					(error) => authenticationFailureOf(error) === "invalid",
				);

				await h.start("ada@example.test");
				const fresh = h.mailer.lastCodeFor("ada@example.test") ?? "";
				const outcomes = await Promise.allSettled(
					Array.from({ length: 5 }, () => h.otp.verify("ada@example.test", fresh)),
				);
				expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
			} finally {
				await h.close();
			}
		});

		it("admits exactly five attempts on a code however many claim at once", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				const claims = await Promise.all(
					Array.from({ length: 20 }, () => h.codes.claimAttempt("ada@example.test", h.clock.now(), 5)),
				);
				expect(claims.filter((claim) => claim !== undefined)).toHaveLength(5);
				if (h.driver !== undefined) {
					const [row] = await h.driver.query<{ attempts: unknown }>(
						"SELECT attempts FROM identity_otp_codes WHERE email = ?",
						["ada@example.test"],
					);
					expect(Number(row?.attempts)).toBe(5);
				}
			} finally {
				await h.close();
			}
		});

		it("issues one code for the last slot when starts race for it", async () => {
			const h = await harness(backend);
			try {
				for (let index = 0; index < 4; index += 1) await h.start("ada@example.test");
				expect(h.mailer.sent).toHaveLength(4);
				const responses = await Promise.all(
					Array.from({ length: 10 }, () => h.handler(post(OTP_START_PATH, { email: "ada@example.test" }))),
				);
				await h.settle();
				expect(responses.every((response) => response.status === 202)).toBe(true);
				expect(h.mailer.sent).toHaveLength(5);
			} finally {
				await h.close();
			}
		});

		it("answers before the mailer has begun any work, even its synchronous part", async () => {
			let begun = false;
			const h = await harness(backend, {
				mailer: {
					send: () => {
						begun = true;
						return Promise.resolve();
					},
				},
			});
			try {
				const response = await h.handler(post(OTP_START_PATH, { email: "ada@example.test" }));
				expect(response.status).toBe(202);
				expect(begun).toBe(false);
				await h.settle();
				expect(begun).toBe(true);
			} finally {
				await h.close();
			}
		});

		it("burns the older code when a new one is sent", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				const first = h.mailer.lastCodeFor("ada@example.test") ?? "";
				h.clock.advance(1000);
				await h.start("ada@example.test");
				const second = h.mailer.lastCodeFor("ada@example.test") ?? "";
				if (first !== second) expect((await h.verify("ada@example.test", first)).status).toBe(401);
				expect((await h.verify("ada@example.test", second)).status).toBe(200);
			} finally {
				await h.close();
			}
		});

		it("sends an email at most five codes an hour, and again once the hour has passed", async () => {
			const h = await harness(backend);
			try {
				for (let index = 0; index < 7; index += 1) {
					const response = await h.start("ada@example.test");
					expect(response.status).toBe(202);
					h.clock.advance(60_000);
				}
				expect(h.mailer.sent).toHaveLength(5);
				// The limit is per email: someone else is unaffected.
				const invited = await h.identity.createUser(h.admin, { name: "Grace", email: "grace@example.test" });
				expect(invited.email).toBe("grace@example.test");
				await h.start("grace@example.test");
				expect(h.mailer.sent).toHaveLength(6);

				h.clock.advance(OTP_RATE_WINDOW_MILLISECONDS);
				await h.start("ada@example.test");
				expect(h.mailer.sent).toHaveLength(7);
			} finally {
				await h.close();
			}
		});

		it("ends a session, after which it no longer authenticates; sessions also expire", async () => {
			const h = await harness(backend);
			try {
				await h.start("ada@example.test");
				const first = (await (
					await h.verify("ada@example.test", h.mailer.lastCodeFor("ada@example.test") ?? "")
				).json()) as OtpVerifyResponse;
				const ended = await h.handler(post(SESSION_END_PATH, "", { authorization: `Bearer ${first.token}` }));
				expect(ended.status).toBe(204);
				await expect(h.whoAmI(first.token)).rejects.toSatisfy((error) => authenticationFailureOf(error) === "invalid");
				const endedEvents = h.audit.ofType("identity.session.ended");
				expect(endedEvents).toHaveLength(1);
				expect(endedEvents[0]).toMatchObject({ actor: { kind: "human", userId: h.ada.id } });
				// Ending it again changes nothing.
				expect((await h.handler(post(SESSION_END_PATH, "", { authorization: `Bearer ${first.token}` }))).status).toBe(
					204,
				);
				expect(h.audit.ofType("identity.session.ended")).toHaveLength(1);

				await h.start("ada@example.test");
				const second = (await (
					await h.verify("ada@example.test", h.mailer.lastCodeFor("ada@example.test") ?? "")
				).json()) as OtpVerifyResponse;
				expect((await h.whoAmI(second.token)).actor).toEqual({ kind: "human", userId: h.ada.id });
				h.clock.advance(DEFAULT_SESSION_TTL_MILLISECONDS);
				await expect(h.whoAmI(second.token)).rejects.toSatisfy((error) => authenticationFailureOf(error) === "invalid");
				await expect(h.whoAmI("kts_not-a-session")).rejects.toSatisfy(
					(error) => authenticationFailureOf(error) === "invalid",
				);
			} finally {
				await h.close();
			}
		});

		it("signs a session in only as the user it was started for, and deletes a user's sessions", async () => {
			const h = await harness(backend);
			const signIn = async () => {
				await h.start("ada@example.test");
				const verified = await h.verify("ada@example.test", h.mailer.lastCodeFor("ada@example.test") ?? "");
				return ((await verified.json()) as OtpVerifyResponse).token;
			};
			try {
				const old = await signIn();
				// Ada deletes her account, and a session of hers is left behind (it was made as the delete ran).
				await h.identity.deleteUser(WORKER, h.ada.id);
				const again = await h.identity.createUser(h.admin, { name: "Ada again", email: "ada@example.test" });
				await expect(h.whoAmI(old)).rejects.toSatisfy((error) => authenticationFailureOf(error) === "invalid");

				const fresh = await signIn();
				expect((await h.whoAmI(fresh)).actor).toEqual({ kind: "human", userId: again.id });
				await h.sessions.deleteForUser(h.ada.id);
				expect((await h.whoAmI(fresh)).actor).toEqual({ kind: "human", userId: again.id });
				await h.sessions.deleteForUser(again.id);
				await expect(h.whoAmI(fresh)).rejects.toSatisfy((error) => authenticationFailureOf(error) === "invalid");
			} finally {
				await h.close();
			}
		});

		it("returns before the mail is sent, and a failed send changes nothing the caller sees", async () => {
			const errors: string[] = [];
			const never: OtpMailer = { send: () => new Promise(() => {}) };
			const h = await harness(backend, { mailer: never, defer: () => {} });
			try {
				const response = await h.handler(post(OTP_START_PATH, { email: "ada@example.test" }));
				expect(response.status).toBe(202);
			} finally {
				await h.close();
			}

			const failing = await harness(backend, {
				mailer: { send: async () => Promise.reject(new Error("relay down")) },
				defer: undefined,
				onMailError: (_error, to) => {
					errors.push(to);
				},
			});
			try {
				const response = await failing.handler(post(OTP_START_PATH, { email: "ada@example.test" }));
				expect(response.status).toBe(202);
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(errors).toEqual(["ada@example.test"]);
			} finally {
				await failing.close();
			}
		});

		it("refuses malformed requests without saying anything about accounts", async () => {
			const h = await harness(backend);
			try {
				expect((await h.handler(post(OTP_START_PATH, "not json"))).status).toBe(400);
				expect((await h.handler(post(OTP_START_PATH, { email: 7 }))).status).toBe(400);
				expect((await h.handler(post(OTP_START_PATH, { email: "no-at-sign" }))).status).toBe(400);
				expect((await h.handler(post(OTP_START_PATH, { email: "a@b.test\r\nBcc: x@y.test" }))).status).toBe(400);
				expect((await h.handler(post(OTP_START_PATH, { email: `${"a".repeat(5000)}@b.test` }))).status).toBe(400);
				expect((await h.handler(post(OTP_VERIFY_PATH, { email: "ada@example.test" }))).status).toBe(400);
				expect((await h.handler(post(OTP_VERIFY_PATH, { email: "ada@example.test", code: "12345" }))).status).toBe(401);
				expect((await h.handler(new Request(`https://kantel.test${OTP_START_PATH}`))).status).toBe(405);
				expect((await h.handler(post("/auth/otp/other", {}))).status).toBe(404);
				expect((await h.handler(post(SESSION_END_PATH, ""))).status).toBe(401);

				// A body with no Content-Length that passes the limit and never ends is cut off at the limit.
				const endless = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`{"email":"${"a".repeat(5000)}`));
					},
				});
				const streamed = await Promise.race([
					h.handler(
						new Request(`https://kantel.test${OTP_START_PATH}`, {
							method: "POST",
							body: endless,
							duplex: "half",
						} as RequestInit & { duplex: "half" }),
					),
					new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
				]);
				expect(streamed === "hung" ? streamed : streamed.status).toBe(400);
				expect(h.mailer.sent).toHaveLength(0);
			} finally {
				await h.close();
			}
		});

		if (backend.name !== "memory") {
			it("stores codes and sessions only as hashes, and does the same statements for a stranger as for a user", async () => {
				const clock = new ManualClock();
				const audit = new RecordingAuditSink();
				const opened = await backend.open(clock, audit);
				try {
					const driver = opened.driver as SqlDriver;
					const identity = createSqlIdentity({ driver, clock, audit });
					await identity.createUser(bootstrap, { name: "Ada", email: "ada@example.test" });
					const traced = recording(driver);
					const mailer = new MemoryOtpMailer();
					const otp = createEmailOtp({
						identity: createSqlIdentity({ driver: traced.driver, clock, audit }),
						...createSqlOtpStores(traced.driver),
						mailer,
						clock,
					});
					await otp.start("ada@example.test");
					const forUser = traced.statements.splice(0);
					await otp.start("stranger@example.test");
					const forStranger = traced.statements.splice(0);
					expect(forStranger).toEqual(forUser);
					// The mail goes out on a later task.
					await new Promise((resolve) => setTimeout(resolve, 20));

					const code = mailer.lastCodeFor("ada@example.test") ?? "";
					const session = await otp.verify("ada@example.test", code);
					const codeRows = await driver.query<{ code_hash: unknown }>("SELECT code_hash FROM identity_otp_codes");
					expect(codeRows).toHaveLength(2);
					for (const row of codeRows) {
						expect(String(row.code_hash)).toMatch(/^[0-9a-f]{64}$/);
						expect(String(row.code_hash)).not.toContain(code);
					}
					const sessionRows = await driver.query("SELECT * FROM identity_sessions");
					expect(JSON.stringify(sessionRows)).not.toContain(session.token);
					expect(JSON.stringify(sessionRows)).not.toContain(session.token.slice(4));
				} finally {
					await opened.close();
				}
			});
		}
	});
}

describe("a session started before the rename", () => {
	it("authenticates and ends by its hbs_ token, as a kts_ one does", async () => {
		const h = await harness(backends[0] as Backend);
		const legacy = "hbs_started-before-the-rename";
		const now = h.clock.now();
		// Signed in once, as anyone with a session has been: their email code's subject is theirs.
		await h.identity.signIn(WORKER, {
			issuer: EMAIL_OTP_ISSUER,
			subject: "ada@example.test",
			email: "ada@example.test",
			emailVerified: true,
		});
		await h.sessions.create({
			id: "ses_legacy",
			tokenHash: await hashSessionToken(legacy),
			userId: h.ada.id,
			issuer: EMAIL_OTP_ISSUER,
			subject: "ada@example.test",
			email: "ada@example.test",
			createdAt: now,
			expiresAt: now + DEFAULT_SESSION_TTL_MILLISECONDS,
		});
		expect(await h.whoAmI(legacy)).toMatchObject({ actor: { kind: "human", userId: h.ada.id } });
		await h.otp.endSession(legacy);
		await expect(h.whoAmI(legacy)).rejects.toSatisfy((error) => authenticationFailureOf(error) === "invalid");
		expect(isSessionToken(legacy) && isSessionToken("kts_x") && !isSessionToken("hbr_x")).toBe(true);
	});
});

describe("the authenticator with Kantel sessions", () => {
	it("refuses a session bearer when no session provider is configured, and never hands one to a JWT provider", async () => {
		const identity = createMemoryIdentity();
		const authenticator = createAuthenticator({ identity });
		await expect(
			authenticator.authenticate(new Request("https://kantel.test/", { headers: { authorization: "Bearer kts_x" } })),
		).rejects.toSatisfy((error) => authenticationFailureOf(error) === "invalid");
	});
});

describe("generateOtpCode", () => {
	it("makes six digits, leading zeroes kept, spread over every digit", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 2000; index += 1) {
			const code = generateOtpCode();
			expect(code).toMatch(/^[0-9]{6}$/);
			for (const digit of code) seen.add(digit);
		}
		expect(seen.size).toBe(10);
	});
});
