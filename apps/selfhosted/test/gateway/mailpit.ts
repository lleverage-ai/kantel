// Mail in the compose stack's end-to-end tests: send one message over plain SMTP (enough for Mailpit, which needs no
// TLS or auth), and read messages back through Mailpit's HTTP API, the way the email one-time PIN test will read its
// code once the identity lane's flow lands (#15, Sign-in).
import { connect } from "node:net";

/** Sends one plain-text message with the bare SMTP dialogue. For tests against Mailpit only: no TLS, no auth. */
export async function sendPlainSmtp(options: {
	readonly host: string;
	readonly port: number;
	readonly from: string;
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly timeoutMs?: number;
}): Promise<void> {
	const address = (value: string) => /<([^<>]+)>/.exec(value)?.[1] ?? value;
	const socket = connect(options.port, options.host);
	socket.setEncoding("utf8");
	socket.setTimeout(options.timeoutMs ?? 10_000, () => socket.destroy(new Error("SMTP timed out")));
	let buffer = "";
	const waiters: ((line: string) => void)[] = [];
	const failures: ((error: Error) => void)[] = [];
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		// A reply ends with a line whose code is followed by a space, not a dash.
		for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			if (/^\d{3} /.test(line)) waiters.shift()?.(line);
		}
	});
	// Whatever ends the connection early (an error, or the server closing it cleanly) fails the reply being waited for,
	// and any asked for afterwards.
	let ended: Error | undefined;
	const end = (error: Error) => {
		ended ??= error;
		waiters.length = 0;
		for (const fail of failures.splice(0)) fail(ended);
	};
	socket.on("error", end);
	socket.on("close", () => end(new Error("SMTP connection closed")));
	const reply = (expect: string) =>
		new Promise<void>((resolve, reject) => {
			if (ended !== undefined) return reject(ended);
			failures.push(reject);
			waiters.push((line) => {
				failures.shift();
				if (line.startsWith(expect)) resolve();
				else reject(new Error(`SMTP: expected ${expect}, got ${line}`));
			});
		});
	const send = async (line: string, expect: string) => {
		const answered = reply(expect);
		socket.write(`${line}\r\n`);
		await answered;
	};
	try {
		await reply("220");
		await send("EHLO harbour-test", "250");
		await send(`MAIL FROM:<${address(options.from)}>`, "250");
		await send(`RCPT TO:<${address(options.to)}>`, "250");
		await send("DATA", "354");
		const body = [
			`From: ${options.from}`,
			`To: ${options.to}`,
			`Subject: ${options.subject}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			...options.text.split("\n").map((line) => (line.startsWith(".") ? `.${line}` : line)),
			".",
		].join("\r\n");
		await send(body, "250");
		await send("QUIT", "221");
	} finally {
		socket.destroy();
	}
}

export interface MailpitMessage {
	readonly id: string;
	readonly subject: string;
	readonly from: string;
	readonly to: readonly string[];
	readonly text: string;
}

/** The newest message to `to` in Mailpit, waiting up to `timeoutMs` in all (requests included) for one to arrive. */
export async function latestMessageTo(
	mailpitUrl: string,
	to: string,
	timeoutMs = 10_000,
): Promise<MailpitMessage | undefined> {
	const deadline = Date.now() + timeoutMs;
	const signal = AbortSignal.timeout(timeoutMs);
	for (;;) {
		const search = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`, {
			signal,
		});
		if (!search.ok) throw new Error(`Mailpit search answered ${search.status}`);
		const found = (await search.json()) as { messages?: { ID: string }[] };
		const id = found.messages?.[0]?.ID;
		if (id !== undefined) {
			const response = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`, { signal });
			if (!response.ok) throw new Error(`Mailpit message answered ${response.status}`);
			const message = (await response.json()) as {
				ID: string;
				Subject: string;
				From: { Address: string };
				To: { Address: string }[];
				Text: string;
			};
			return {
				id: message.ID,
				subject: message.Subject,
				from: message.From.Address,
				to: message.To.map((recipient) => recipient.Address),
				text: message.Text,
			};
		}
		const left = deadline - Date.now();
		if (left <= 0) return undefined;
		await new Promise((resolve) => setTimeout(resolve, Math.min(200, left)));
	}
}
