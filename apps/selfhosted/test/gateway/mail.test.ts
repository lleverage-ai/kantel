import { describe, expect, it } from "vitest";
import { describeMail, mailConfig } from "../../src/gateway/mail.ts";

describe("mail configuration", () => {
	it("is off without HARBOUR_SMTP_URL", () => {
		expect(mailConfig({})).toBeUndefined();
		expect(mailConfig({ HARBOUR_SMTP_URL: "  " })).toBeUndefined();
	});

	it("reads smtp and smtps URLs and never describes their credentials", () => {
		const plain = mailConfig({ HARBOUR_SMTP_URL: "smtp://mailpit:1025", HARBOUR_MAIL_FROM: "harbour@example.com" });
		expect(plain && describeMail(plain)).toEqual({
			transport: "smtp",
			host: "mailpit",
			port: 1025,
			authenticated: false,
			from: "harbour@example.com",
		});
		const tls = mailConfig({
			HARBOUR_SMTP_URL: "smtps://user:secret-password@smtp.example.com",
			HARBOUR_MAIL_FROM: "Harbour <harbour@example.com>",
		});
		const described = tls && describeMail(tls);
		expect(described).toMatchObject({ transport: "smtps", port: 465, authenticated: true });
		const submission = mailConfig({ HARBOUR_SMTP_URL: "smtp://relay.example.com", HARBOUR_MAIL_FROM: "a@b.example" });
		expect(submission && describeMail(submission).port).toBe(587);
		expect(JSON.stringify(described)).not.toContain("secret-password");
		expect(JSON.stringify(described)).not.toContain("user");
	});

	it("refuses a malformed URL, another scheme or a missing or malformed From", () => {
		const from = { HARBOUR_MAIL_FROM: "harbour@example.com" };
		expect(() => mailConfig({ HARBOUR_SMTP_URL: "not a url", ...from })).toThrow(/not a URL/);
		expect(() => mailConfig({ HARBOUR_SMTP_URL: "https://mail.example.com", ...from })).toThrow(/smtp/);
		expect(() => mailConfig({ HARBOUR_SMTP_URL: "smtp://mailpit:1025" })).toThrow(/HARBOUR_MAIL_FROM/);
		expect(() => mailConfig({ HARBOUR_SMTP_URL: "smtp://mailpit:1025", HARBOUR_MAIL_FROM: "Harbour" })).toThrow(
			/address/,
		);
		for (const injected of [
			"Harbour\r\nBcc: x@evil.example <harbour@example.com>",
			"harbour@example.com\nBcc: x@y",
			"a\u0000@b",
		]) {
			expect(() => mailConfig({ HARBOUR_SMTP_URL: "smtp://mailpit:1025", HARBOUR_MAIL_FROM: injected })).toThrow(
				/address/,
			);
		}
	});

	it("does not echo a URL's credentials in its errors", () => {
		expect(() => mailConfig({ HARBOUR_SMTP_URL: "http://user:secret-password@x", HARBOUR_MAIL_FROM: "a@b" })).toThrow(
			expect.not.objectContaining({ message: expect.stringContaining("secret-password") }),
		);
	});
});

describe("the test SMTP client and Mailpit reader", () => {
	it("fails, rather than hangs, when the server closes before its greeting or mid-dialogue", async () => {
		const { createServer } = await import("node:net");
		const { sendPlainSmtp } = await import("./mailpit.ts");
		for (const behaviour of ["no greeting", "after EHLO"] as const) {
			const server = createServer((socket) => {
				if (behaviour === "no greeting") return socket.end();
				socket.write("220 hi\r\n");
				socket.once("data", () => socket.end());
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as { port: number }).port;
			await expect(
				sendPlainSmtp({ host: "127.0.0.1", port, from: "a@b", to: "c@d", subject: "s", text: "t", timeoutMs: 5000 }),
			).rejects.toThrow(/closed/);
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it("answers undefined, not an error, when a responsive Mailpit has no message", async () => {
		const { createServer } = await import("node:http");
		const { latestMessageTo } = await import("./mailpit.ts");
		const server = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ messages: [] }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		// Another search is begun only while at least the 500 ms margin is left before the deadline: headroom, so a loaded
		// machine (CI shares its host) usually still answers in time, though a sleep that overruns can still eat into it.
		// 500 ends after its first search; the others wait and search again.
		for (const timeoutMs of [500, 800, 1_200]) {
			await expect(latestMessageTo(`http://127.0.0.1:${port}`, "a@b", timeoutMs)).resolves.toBeUndefined();
		}
		await new Promise((resolve) => server.close(resolve));
	});

	it("bounds a stalled Mailpit API by its timeout", async () => {
		const { createServer } = await import("node:http");
		const { latestMessageTo } = await import("./mailpit.ts");
		const server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const started = Date.now();
		await expect(latestMessageTo(`http://127.0.0.1:${port}`, "a@b", 300)).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(3000);
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
});
