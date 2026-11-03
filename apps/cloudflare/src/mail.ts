/**
 * Sign-in codes and invites, sent with Cloudflare Email Sending through the Worker's `SIGN_IN_MAIL` binding (a
 * `send_email` binding limited to the one sender, KANTEL_SIGN_IN_FROM), within a daily cap (`MailBudget`).
 *
 * Portable: the binding is typed here by what is used of it, so the tests stand one in under Node.
 */
import { KantelError } from "@kantel/contracts";
import { type InviteMailer, type InviteMessage, inviteMail } from "@kantel/identity/invites";
import { type OtpMailer, type OtpMessage, otpEmail } from "@kantel/identity/otp";

/** What is used of a `send_email` binding (Cloudflare's `SendEmail`, its structured `send`). */
export interface SendEmailBinding {
	send(message: {
		readonly to: string;
		readonly from: string | { readonly email: string; readonly name?: string };
		readonly subject: string;
		readonly text: string;
	}): Promise<unknown>;
}

/**
 * How many messages may still go today. One stack object answers every request, so its storage is the one count; a
 * memory budget is for tests.
 */
export interface MailBudget {
	/** Counts one message against today's cap: false, and nothing counted, once the cap is reached. */
	take(): Promise<boolean>;
}

/** The UTC day `at` is in, as `YYYY-MM-DD`. */
export const mailDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** What a budget keeps its count in: the stack object's storage, or a map. */
export interface MailCounts {
	get(day: string): Promise<number | undefined>;
	put(day: string, count: number): Promise<void>;
	/** Forgets the count of every day before `day`. */
	prune?(day: string): Promise<void>;
}

/** A budget of `cap` messages a UTC day over `counts`. */
export function dailyMailBudget(options: {
	readonly cap: number;
	readonly counts: MailCounts;
	readonly now?: () => number;
}): MailBudget {
	const now = options.now ?? Date.now;
	return {
		async take() {
			const day = mailDay(now());
			const sent = (await options.counts.get(day)) ?? 0;
			if (sent >= options.cap) return false;
			await options.counts.put(day, sent + 1);
			if (sent === 0) await options.counts.prune?.(day);
			return true;
		},
	};
}

export function memoryMailCounts(): MailCounts {
	const counts = new Map<string, number>();
	return {
		get: async (day) => counts.get(day),
		put: async (day, count) => {
			counts.set(day, count);
		},
		prune: async (day) => {
			for (const key of counts.keys()) if (key < day) counts.delete(key);
		},
	};
}

/** The message a refused send rejects with, so the logs say why a code didn't go. */
export const MAIL_CAP_REACHED = "Today's sign-in mail cap is reached";

/**
 * Sends codes and invites from `from` through `binding`. Each invite counts against `budget`; a code was counted when
 * its sign-in started (the gateway refuses the start once the cap is reached), so it isn't counted twice.
 */
export function cloudflareMailer(options: {
	readonly binding: SendEmailBinding;
	readonly from: string;
	readonly budget: MailBudget;
}): OtpMailer & InviteMailer {
	const { binding, budget } = options;
	const from = { email: options.from, name: "Kantel" };
	return {
		async send(message: OtpMessage) {
			const mail = otpEmail(message);
			await binding.send({ to: message.to, from, subject: mail.subject, text: mail.text });
		},
		async sendInvite(message: InviteMessage) {
			if (!(await budget.take())) throw new KantelError("exhausted", MAIL_CAP_REACHED);
			const mail = inviteMail(message);
			await binding.send({ to: message.to, from, subject: mail.subject, text: mail.text });
		},
	};
}
