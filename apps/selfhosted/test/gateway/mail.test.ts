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
	});

	it("does not echo a URL's credentials in its errors", () => {
		expect(() => mailConfig({ HARBOUR_SMTP_URL: "http://user:secret-password@x", HARBOUR_MAIL_FROM: "a@b" })).toThrow(
			expect.not.objectContaining({ message: expect.stringContaining("secret-password") }),
		);
	});
});
