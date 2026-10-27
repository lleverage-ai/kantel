// How the gateway sends email: sign-in codes for the email one-time PIN flow (#15, Sign-in). The identity lane owns
// the `OtpMailer` and its SMTP implementation; the deployment's part is the configuration, read and checked here so a
// bad value stops the gateway at start rather than at the first sign-in.
//
//   HARBOUR_SMTP_URL   smtp://[user:password@]host[:port] (STARTTLS when the server offers it) or smtps://… (TLS)
//   HARBOUR_MAIL_FROM  the From address, such as `Harbour <harbour@example.com>`

export interface MailConfig {
	readonly smtpUrl: URL;
	readonly from: string;
}

/** What `/v1/deployment` shows of the mail configuration: never the credentials. */
export interface MailDescription {
	readonly transport: "smtp" | "smtps";
	readonly host: string;
	readonly port: number;
	readonly authenticated: boolean;
	readonly from: string;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

function validFrom(from: string): boolean {
	// A From value goes into a message header: no CR, LF or other control characters, anywhere in it.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
	if (/[\u0000-\u001f\u007f]/.test(from)) return false;
	const named = /^[^<>]*<([^<>]+)>$/.exec(from.trim());
	return ADDRESS.test(named?.[1] ?? from.trim());
}

/** The mail configuration, or undefined when `HARBOUR_SMTP_URL` is unset. Throws on a malformed value. */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | undefined {
	const raw = env.HARBOUR_SMTP_URL?.trim();
	if (raw === undefined || raw === "") return undefined;
	let smtpUrl: URL;
	try {
		smtpUrl = new URL(raw);
	} catch {
		throw new Error("HARBOUR_SMTP_URL is not a URL");
	}
	if (smtpUrl.protocol !== "smtp:" && smtpUrl.protocol !== "smtps:") {
		throw new Error("HARBOUR_SMTP_URL must be smtp:// or smtps://");
	}
	if (smtpUrl.hostname === "") throw new Error("HARBOUR_SMTP_URL needs a host");
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
		authenticated: config.smtpUrl.username !== "",
		from: config.from,
	};
}
