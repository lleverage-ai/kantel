/**
 * An `OtpMailer` that sends through any SMTP relay (self-hosted; Node and Bun only). Configured by one URL and a
 * sender, as the deployment's `KANTEL_SMTP_URL` and `KANTEL_MAIL_FROM`:
 *
 * - `smtps://user:password@host:465`: TLS from the first byte.
 * - `smtp://user:password@host:587`: STARTTLS, required: a relay that does not offer it is refused, so a
 *   downgrade cannot send codes in the clear.
 * - `smtp://host:1025?starttls=off`: no TLS at all, for a relay on a private network such as the compose stack's
 *   Mailpit. Only an explicit `starttls=off` turns TLS off.
 *
 * User and password are optional and URL-encoded. Neither the URL nor a code appears in any error.
 */
import { KantelError } from "@kantel/contracts";
import { createTransport } from "nodemailer";
import { type InviteMailer, inviteMail } from "./invites.ts";
import { type OtpMailer, otpEmail } from "./otp.ts";

/** How long connecting, the greeting and each command may take before the send fails. */
const SMTP_TIMEOUT_MILLISECONDS = 10_000;

export interface SmtpMailerOptions {
	/** `smtp://` or `smtps://`, as above. */
	readonly url: string;
	/** The `From` address, such as `Kantel <harbour@example.com>`. */
	readonly from: string;
}

interface SmtpSettings {
	readonly host: string;
	readonly port: number;
	readonly secure: boolean;
	readonly starttls: "required" | "off";
	readonly user?: string;
	readonly password?: string;
}

function invalid(message: string): KantelError {
	return new KantelError("invalid", message);
}

/** Parses an SMTP URL. Errors never include the URL, which may hold a password. */
export function parseSmtpUrl(raw: string): SmtpSettings {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw invalid("KANTEL_SMTP_URL is not a URL");
	}
	const secure = url.protocol === "smtps:";
	if (!secure && url.protocol !== "smtp:") throw invalid("KANTEL_SMTP_URL must be smtp:// or smtps://");
	if (url.hostname === "") throw invalid("KANTEL_SMTP_URL needs a host");
	const allowed = new Set(["starttls"]);
	for (const name of url.searchParams.keys()) {
		if (!allowed.has(name)) throw invalid(`KANTEL_SMTP_URL has an unknown parameter: ${name}`);
	}
	const starttls = url.searchParams.get("starttls");
	if (starttls !== null && starttls !== "off" && starttls !== "required") {
		throw invalid("KANTEL_SMTP_URL's starttls must be off or required");
	}
	if (secure && starttls === "off") throw invalid("smtps:// is TLS already; starttls=off does not apply");
	const port = url.port === "" ? (secure ? 465 : 587) : Number(url.port);
	const decode = (value: string) => {
		try {
			return decodeURIComponent(value);
		} catch {
			throw invalid("KANTEL_SMTP_URL has a malformed user or password");
		}
	};
	return {
		host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
		port,
		secure,
		starttls: starttls === "off" ? "off" : "required",
		...(url.username === "" ? {} : { user: decode(url.username) }),
		...(url.password === "" ? {} : { password: decode(url.password) }),
	};
}

/** Sends sign-in codes and invites through the relay `options.url` names. */
export function createSmtpMailer(options: SmtpMailerOptions): OtpMailer & InviteMailer {
	const settings = parseSmtpUrl(options.url);
	if (typeof options.from !== "string" || options.from.trim() === "") throw invalid("KANTEL_MAIL_FROM is required");
	const transport = createTransport({
		host: settings.host,
		port: settings.port,
		secure: settings.secure,
		requireTLS: !settings.secure && settings.starttls === "required",
		ignoreTLS: !settings.secure && settings.starttls === "off",
		...(settings.user === undefined ? {} : { auth: { user: settings.user, pass: settings.password ?? "" } }),
		connectionTimeout: SMTP_TIMEOUT_MILLISECONDS,
		greetingTimeout: SMTP_TIMEOUT_MILLISECONDS,
		socketTimeout: SMTP_TIMEOUT_MILLISECONDS,
	});
	const from = options.from.trim();
	const deliver = async (what: string, to: string, mail: { subject: string; text: string }) => {
		try {
			await transport.sendMail({ from, to, subject: mail.subject, text: mail.text });
		} catch (error) {
			// The relay's own error can quote the message; report only its kind.
			const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
			throw new KantelError(
				"unavailable",
				`The ${what} email could not be sent${typeof code === "string" ? ` (${code})` : ""}`,
			);
		}
	};
	return {
		send: (message) => deliver("sign-in", message.to, otpEmail(message)),
		sendInvite: (message) => deliver("invite", message.to, inviteMail(message)),
	};
}

/** The SMTP mailer from `KANTEL_SMTP_URL` and `KANTEL_MAIL_FROM`; `invalid` when either is missing. */
export function smtpMailerFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): OtpMailer & InviteMailer {
	const url = env.KANTEL_SMTP_URL;
	const from = env.KANTEL_MAIL_FROM;
	if (url === undefined || url === "") throw invalid("KANTEL_SMTP_URL is required");
	if (from === undefined || from === "") throw invalid("KANTEL_MAIL_FROM is required");
	return createSmtpMailer({ url, from });
}
