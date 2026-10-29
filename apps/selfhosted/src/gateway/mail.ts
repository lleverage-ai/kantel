// How the gateway sends email: sign-in codes for the email one-time PIN flow (#15, Sign-in). The identity lane owns
// the `OtpMailer` and its SMTP implementation (@harbour/identity/smtp); the deployment's part is the configuration,
// read and checked here with the same parser the mailer uses, so a bad value stops the gateway at start rather than at
// the first sign-in.
//
//   HARBOUR_SMTP_URL   smtps://[user:password@]host[:port] (TLS from the start), smtp://… (STARTTLS required), or
//                      smtp://host:port?starttls=off (in the clear, for a relay on a private network such as Mailpit)
//   HARBOUR_MAIL_FROM  the From address, such as `Harbour <harbour@example.com>`
import type { OtpMailer } from "@harbour/identity/otp";
import { createSmtpMailer, parseSmtpUrl } from "@harbour/identity/smtp";

export interface MailConfig {
	readonly smtpUrl: URL;
	readonly from: string;
}

/** What `/v1/deployment` shows of the mail configuration: never the credentials. */
export interface MailDescription {
	readonly transport: "smtp" | "smtps";
	readonly host: string;
	readonly port: number;
	/** Whether an `smtp:` relay must offer STARTTLS; `off` sends in the clear. Always `required` for `smtps:`. */
	readonly starttls: "required" | "off";
	readonly authenticated: boolean;
	readonly from: string;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

/** Whether `value` has a control character (CR, LF and the rest), which must never reach a mail header. */
function hasControl(value: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
	return /[\u0000-\u001f\u007f]/.test(value);
}

function validFrom(from: string): boolean {
	if (hasControl(from)) return false;
	const named = /^[^<>]*<([^<>]+)>$/.exec(from.trim());
	return ADDRESS.test(named?.[1] ?? from.trim());
}

/** Whether `email` is plausibly one bare address: what `HARBOUR_ADMIN_EMAIL` must be. */
export function plausibleAddress(email: string): boolean {
	return !hasControl(email) && ADDRESS.test(email) && email.length <= 254;
}

/** The mail configuration, or undefined when `HARBOUR_SMTP_URL` is unset. Throws on a malformed value. */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | undefined {
	const raw = env.HARBOUR_SMTP_URL?.trim();
	if (raw === undefined || raw === "") return undefined;
	// The identity lane's parser, whose errors never include the URL: what the mailer will accept, and nothing else.
	parseSmtpUrl(raw);
	const smtpUrl = new URL(raw);
	const from = env.HARBOUR_MAIL_FROM?.trim() ?? "";
	if (from === "") throw new Error("HARBOUR_MAIL_FROM is required when HARBOUR_SMTP_URL is set");
	if (!validFrom(from)) throw new Error("HARBOUR_MAIL_FROM must be an address or `Name <address>`");
	return { smtpUrl, from };
}

/** The port a URL without one means: 465 for smtps (implicit TLS), 587 for smtp (submission, STARTTLS). */
export function smtpPort(url: URL): number {
	if (url.port !== "") return Number(url.port);
	return url.protocol === "smtps:" ? 465 : 587;
}

export function describeMail(config: MailConfig): MailDescription {
	const smtps = config.smtpUrl.protocol === "smtps:";
	return {
		transport: smtps ? "smtps" : "smtp",
		host: config.smtpUrl.hostname,
		port: smtpPort(config.smtpUrl),
		starttls: !smtps && config.smtpUrl.searchParams.get("starttls") === "off" ? "off" : "required",
		authenticated: config.smtpUrl.username !== "",
		from: config.from,
	};
}

/** The sign-in mailer for `config`: the identity lane's SMTP client. */
export function createMailer(config: MailConfig): OtpMailer {
	return createSmtpMailer({ url: config.smtpUrl.href, from: config.from });
}
