/**
 * The invite email. Kantel sends one when a deployment has mail (self-hosted, `KANTEL_SMTP_URL`): the SMTP mailer
 * (`./smtp.ts`) is an `InviteMailer` as well as an `OtpMailer`. Without mail (Cloudflare, where Access signs people in
 * at the edge) the admin copies the link from the console instead. Either way the link holds no secret: the person
 * accepts by signing in with the invited email (`IdentityDirectory.signIn`). Portable: Workers, Bun and Node.
 */

/** One invite to send. */
export interface InviteMessage {
	readonly to: string;
	/** The organisation's name. */
	readonly organisation: string;
	/** Who invited them, by name. */
	readonly invitedBy: string;
	/** Where they sign in: the console. */
	readonly link: string;
	readonly expiresAt: number;
}

export interface InviteMailer {
	sendInvite(message: InviteMessage): Promise<void>;
}

/** The subject and plain-text body of an invite email. */
export function inviteMail(message: InviteMessage): { readonly subject: string; readonly text: string } {
	const expires = new Date(message.expiresAt).toISOString().slice(0, 10);
	return {
		subject: `${message.invitedBy} invited you to ${message.organisation} on Kantel`,
		text: [
			`${message.invitedBy} invited you to ${message.organisation} on Kantel.`,
			"",
			`Sign in with this email address to join: ${message.link}`,
			"",
			`The invite expires on ${expires}.`,
			"If you weren't expecting it, you can ignore this email.",
			"",
		].join("\n"),
	};
}

/** Keeps the invites it is given, for tests. */
export class MemoryInviteMailer implements InviteMailer {
	readonly sent: InviteMessage[] = [];

	async sendInvite(message: InviteMessage): Promise<void> {
		this.sent.push(message);
	}
}

/** Whether a mailer can send invites as well as sign-in codes. */
export function isInviteMailer(mailer: unknown): mailer is InviteMailer {
	return (
		typeof mailer === "object" &&
		mailer !== null &&
		typeof (mailer as { sendInvite?: unknown }).sendInvite === "function"
	);
}
