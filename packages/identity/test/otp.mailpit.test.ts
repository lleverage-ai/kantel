/**
 * Email one-time PIN sign-in (#15), end to end against a real Mailpit: an invited user signs in over HTTP with the code read
 * from Mailpit's API, and a stranger's email gets the same 202 and no mail. Runs when `KANTEL_TEST_SMTP_URL` (the
 * relay, such as `smtp://127.0.0.1:1025?starttls=off`) and `KANTEL_TEST_MAILPIT_URL` (its HTTP API) are set; the
 * directory is real Postgres when `KANTEL_TEST_POSTGRES_URL` is set too, PGlite otherwise.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type CallContext,
	OTP_START_PATH,
	OTP_VERIFY_PATH,
	type OtpVerifyResponse,
	SESSION_END_PATH,
} from "@kantel/contracts";
import { createAuthenticator, withAuthentication } from "@kantel/identity/authenticator";
import { createEmailOtp, kantelSessionProvider } from "@kantel/identity/otp";
import { createOtpHandler } from "@kantel/identity/otp/http";
import { createSmtpMailer } from "@kantel/identity/smtp";
import { createSqlIdentity, createSqlOtpStores, migrateIdentity } from "@kantel/identity/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { RecordingAuditSink } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

const smtpUrl = process.env.KANTEL_TEST_SMTP_URL ?? "";
const mailpitUrl = (process.env.KANTEL_TEST_MAILPIT_URL ?? "").replace(/\/$/, "");
const bootstrap: CallContext = { actor: { kind: "system", component: "bootstrap" }, organisationId: "bootstrap" };

/** Serves a Fetch-style handler over real HTTP on a random local port. */
async function serve(handler: (request: Request) => Promise<Response>) {
	const server = createServer(async (incoming: IncomingMessage, outgoing: ServerResponse) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(chunk as Buffer);
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (typeof value === "string") headers.set(name, value);
		}
		const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
		const response = await handler(
			new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
				method: incoming.method ?? "GET",
				headers,
				...(body === undefined ? {} : { body }),
			}),
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

interface MailpitSummary {
	readonly ID: string;
	readonly To: readonly { readonly Address: string }[];
}

async function messagesTo(address: string): Promise<MailpitSummary[]> {
	const response = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
	expect(response.ok).toBe(true);
	const body = (await response.json()) as { messages: MailpitSummary[] };
	return body.messages.filter((message) => message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()));
}

/** The code in the newest message to `address`, waiting up to 10 seconds for it to arrive. */
async function codeFromMailpit(address: string): Promise<string> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const [newest] = await messagesTo(address);
		if (newest !== undefined) {
			const message = (await (await fetch(`${mailpitUrl}/api/v1/message/${newest.ID}`)).json()) as {
				Text: string;
				Subject: string;
			};
			expect(message.Subject).toBe("Your Kantel sign-in code");
			const match = /sign-in code is ([0-9]{6})\./.exec(message.Text);
			if (match?.[1] === undefined) throw new Error("no code in the message");
			return match[1];
		}
		if (Date.now() > deadline) throw new Error(`no mail reached ${address}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const median = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

describe.skipIf(smtpUrl === "" || mailpitUrl === "")("email one-time PIN through Mailpit", () => {
	it("signs an invited user in with the code from Mailpit; a stranger gets the same 202 and no mail", async () => {
		const kinds = testDatabaseKinds();
		const kind = kinds.find((candidate) => candidate.name === "Postgres") ?? kinds[0];
		if (kind === undefined) throw new Error("no database");
		const database = await kind.open();
		const run = crypto.randomUUID().slice(0, 8);
		try {
			await migrateIdentity(database.driver);
			const audit = new RecordingAuditSink();
			const identity = createSqlIdentity({ driver: database.driver, audit });
			const founder = await identity.createUser(bootstrap, { name: "Founder" });
			const organisation = await identity.createOrganisation(bootstrap, {
				name: "Org",
				admin: { kind: "user", userId: founder.id },
			});
			const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
			const invitedEmail = `ada.${run}@example.test`;
			const ada = await identity.createUser(admin, { name: "Ada", email: invitedEmail });
			await identity.grantRole(admin, { principal: { kind: "user", userId: ada.id }, role: "viewer" });

			const stores = createSqlOtpStores(database.driver);
			const otp = createEmailOtp({
				identity,
				...stores,
				mailer: createSmtpMailer({ url: smtpUrl, from: "Kantel <harbour@example.test>" }),
				audit,
			});
			const otpRoutes = createOtpHandler({ otp });
			const authenticator = createAuthenticator({ identity, providers: [kantelSessionProvider(stores)] });
			const whoAmI = withAuthentication(authenticator, async (_request, caller) => Response.json(caller));
			const server = await serve(async (request) =>
				new URL(request.url).pathname.startsWith("/auth/") ? otpRoutes(request) : whoAmI(request),
			);
			try {
				const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
					fetch(`${server.base}${path}`, {
						method: "POST",
						headers: { "content-type": "application/json", ...headers },
						body: JSON.stringify(body),
					});

				const strangerEmail = `stranger.${run}@example.test`;
				const invited = await post(OTP_START_PATH, { email: invitedEmail });
				const stranger = await post(OTP_START_PATH, { email: strangerEmail });
				expect(invited.status).toBe(202);
				expect(stranger.status).toBe(202);
				const invitedBody = await invited.text();
				expect(await stranger.text()).toBe(invitedBody);

				const code = await codeFromMailpit(invitedEmail);
				// The invited user's mail has arrived; give the stranger's every chance to arrive too.
				await new Promise((resolve) => setTimeout(resolve, 1000));
				expect(await messagesTo(strangerEmail)).toHaveLength(0);

				const verified = await post(OTP_VERIFY_PATH, { email: invitedEmail, code });
				expect(verified.status).toBe(200);
				const session = (await verified.json()) as OtpVerifyResponse;
				expect(session.user.id).toBe(ada.id);

				const me = await fetch(`${server.base}/v1/me`, { headers: { authorization: `Bearer ${session.token}` } });
				expect(me.status).toBe(200);
				expect(await me.json()).toEqual({
					method: "harbour_session",
					actor: { kind: "human", userId: ada.id },
					organisationId: organisation.id,
				});
				expect((await post(OTP_VERIFY_PATH, { email: invitedEmail, code })).status).toBe(401);

				expect((await post(SESSION_END_PATH, {}, { authorization: `Bearer ${session.token}` })).status).toBe(204);
				const after = await fetch(`${server.base}/v1/me`, { headers: { authorization: `Bearer ${session.token}` } });
				expect(after.status).toBe(401);

				// Timing: start for fresh invited users and fresh strangers, interleaved; the medians must be close.
				const invitedTimes: number[] = [];
				const strangerTimes: number[] = [];
				for (let index = 0; index < 15; index += 1) {
					const email = `timing.${index}.${run}@example.test`;
					await identity.createUser(admin, { name: `Timing ${index}`, email });
					const pair = [
						[email, invitedTimes],
						[`nobody.${index}.${run}@example.test`, strangerTimes],
					] as const;
					// Alternate which goes first, and let the previous mail go out, so neither side pays for the other's send.
					for (const [address, times] of index % 2 === 0 ? pair : [...pair].reverse()) {
						await new Promise((resolve) => setTimeout(resolve, 50));
						const began = performance.now();
						const response = await post(OTP_START_PATH, { email: address });
						times.push(performance.now() - began);
						expect(response.status).toBe(202);
					}
				}
				const difference = Math.abs(median(invitedTimes) - median(strangerTimes));
				console.info(
					`start medians: invited ${median(invitedTimes).toFixed(2)} ms, stranger ${median(strangerTimes).toFixed(2)} ms (${kind.name})`,
				);
				expect(difference).toBeLessThan(15);
			} finally {
				await server.close();
			}
		} finally {
			await database.close();
		}
	}, 60_000);
});
