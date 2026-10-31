import type { AddressInfo } from "node:net";
import { isHarbourError } from "@harbour/contracts";
import { createSmtpMailer, parseSmtpUrl, smtpMailerFromEnv } from "@harbour/identity/smtp";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";

interface Received {
	readonly from: string | undefined;
	readonly to: readonly string[];
	readonly user: string | undefined;
	readonly raw: string;
}

const servers: SMTPServer[] = [];

/** An SMTP server on a random local port that keeps what it receives. */
async function relay(options: SMTPServerOptions = {}) {
	const received: Received[] = [];
	const server = new SMTPServer({
		logger: false,
		disabledCommands: ["STARTTLS"],
		authOptional: true,
		...options,
		onData(stream, session, callback) {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => {
				received.push({
					from: session.envelope.mailFrom === false ? undefined : session.envelope.mailFrom.address,
					to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
					user: typeof session.user === "string" ? session.user : undefined,
					raw: Buffer.concat(chunks).toString("utf8"),
				});
				callback();
			});
		},
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.server.address() as AddressInfo;
	return { port, received };
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("parseSmtpUrl", () => {
	it("reads host, port, TLS mode and URL-encoded credentials", () => {
		expect(parseSmtpUrl("smtps://mail.example.test")).toEqual({
			host: "mail.example.test",
			port: 465,
			secure: true,
			starttls: "required",
		});
		expect(parseSmtpUrl("smtp://us%40er:p%3Ass%2Fw@mail.example.test")).toEqual({
			host: "mail.example.test",
			port: 587,
			secure: false,
			starttls: "required",
			user: "us@er",
			password: "p:ss/w",
		});
		expect(parseSmtpUrl("smtp://mailpit:1025?starttls=off")).toMatchObject({ port: 1025, starttls: "off" });
	});

	it("refuses anything else, without repeating the URL", () => {
		const secret = "hunter2";
		for (const url of [
			`https://user:${secret}@mail.example.test`,
			`smtp://user:${secret}@mail.example.test?tls=none`,
			`smtp://user:${secret}@mail.example.test?starttls=maybe`,
			`smtps://user:${secret}@mail.example.test?starttls=off`,
			"not a url",
		]) {
			let caught: unknown;
			try {
				parseSmtpUrl(url);
			} catch (error) {
				caught = error;
			}
			expect(isHarbourError(caught, "invalid")).toBe(true);
			expect(String((caught as Error).message)).not.toContain(secret);
		}
	});

	it("needs both HARBOUR_SMTP_URL and HARBOUR_MAIL_FROM", () => {
		expect(() => smtpMailerFromEnv({ HARBOUR_MAIL_FROM: "harbour@example.test" })).toThrow(/HARBOUR_SMTP_URL/);
		expect(() => smtpMailerFromEnv({ HARBOUR_SMTP_URL: "smtp://mailpit:1025?starttls=off" })).toThrow(
			/HARBOUR_MAIL_FROM/,
		);
		expect(
			smtpMailerFromEnv({ HARBOUR_SMTP_URL: "smtp://mailpit:1025?starttls=off", HARBOUR_MAIL_FROM: "h@example.test" }),
		).toBeDefined();
	});
});

describe("createSmtpMailer", () => {
	it("sends the code in a plain-text email from HARBOUR_MAIL_FROM", async () => {
		const { port, received } = await relay();
		const mailer = createSmtpMailer({
			url: `smtp://127.0.0.1:${port}?starttls=off`,
			from: "Harbour <harbour@example.test>",
		});
		await mailer.send({ to: "ada@example.test", code: "012345", expiresAt: Date.UTC(2026, 9, 27, 9, 10) });
		expect(received).toHaveLength(1);
		const [mail] = received;
		expect(mail?.from).toBe("harbour@example.test");
		expect(mail?.to).toEqual(["ada@example.test"]);
		expect(mail?.raw).toContain("Subject: Your Harbour sign-in code");
		expect(mail?.raw).not.toMatch(/Subject:.*012345/);
		expect(mail?.raw).toContain("Your Harbour sign-in code is 012345.");
		expect(mail?.raw).toContain("2026-10-27 09:10 UTC");
	});

	it("sends an invite with the link to sign in at", async () => {
		const { port, received } = await relay();
		const mailer = createSmtpMailer({ url: `smtp://127.0.0.1:${port}?starttls=off`, from: "harbour@example.test" });
		await mailer.sendInvite({
			to: "grace@example.test",
			organisation: "Acme",
			invitedBy: "Ada Lovelace",
			link: "https://harbour.example.test/",
			expiresAt: Date.UTC(2026, 10, 10, 9, 0),
		});
		const [mail] = received;
		expect(mail?.to).toEqual(["grace@example.test"]);
		expect(mail?.raw).toContain("Subject: Ada Lovelace invited you to Acme on Harbour");
		expect(mail?.raw).toContain("https://harbour.example.test/");
		expect(mail?.raw).toContain("2026-11-10");
	});

	it("authenticates with the URL's user and password", async () => {
		const { port, received } = await relay({
			authOptional: false,
			allowInsecureAuth: true,
			onAuth(auth, _session, callback) {
				if (auth.username === "us@er" && auth.password === "p:ss/w") callback(null, { user: auth.username });
				else callback(new Error("bad credentials"));
			},
		});
		const mailer = createSmtpMailer({
			url: `smtp://us%40er:p%3Ass%2Fw@127.0.0.1:${port}?starttls=off`,
			from: "harbour@example.test",
		});
		await mailer.send({ to: "ada@example.test", code: "123456", expiresAt: Date.now() });
		expect(received[0]?.user).toBe("us@er");
	});

	it("refuses to send in the clear when the relay offers no STARTTLS, and says nothing of the code or the URL", async () => {
		const { port, received } = await relay();
		const mailer = createSmtpMailer({ url: `smtp://user:hunter2@127.0.0.1:${port}`, from: "harbour@example.test" });
		let caught: unknown;
		try {
			await mailer.send({ to: "ada@example.test", code: "654321", expiresAt: Date.now() });
		} catch (error) {
			caught = error;
		}
		expect(isHarbourError(caught, "unavailable")).toBe(true);
		const message = String((caught as Error).message);
		expect(message).not.toContain("654321");
		expect(message).not.toContain("hunter2");
		expect(received).toHaveLength(0);
	});
});
