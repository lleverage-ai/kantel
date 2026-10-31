// Run inside the gateway container (stack.ts does it with `docker compose exec`): sends one message through the
// gateway's own KANTEL_SMTP_URL and KANTEL_MAIL_FROM, so the test proves the address the sign-in mailer will use.
//
//   bun test/gateway/smtp-probe.ts <recipient> <subject>
import { mailConfig, smtpPort } from "../../src/gateway/mail.ts";
import { sendPlainSmtp } from "./mailpit.ts";

const [to, subject] = process.argv.slice(2);
if (to === undefined || subject === undefined) {
	console.error("usage: smtp-probe.ts <recipient> <subject>");
	process.exit(2);
}
const config = mailConfig();
if (config === undefined) {
	console.error("KANTEL_SMTP_URL is not set");
	process.exit(2);
}
if (config.smtpUrl.protocol !== "smtp:") {
	console.error("the probe speaks plain SMTP only (Mailpit)");
	process.exit(2);
}
await sendPlainSmtp({
	host: config.smtpUrl.hostname,
	port: smtpPort(config.smtpUrl),
	from: config.from,
	to,
	subject,
	text: "Kantel's self-hosted stack can send mail.\nYour code would be 000000.",
});
console.log(`sent to ${to} through ${config.smtpUrl.hostname}:${config.smtpUrl.port}`);
