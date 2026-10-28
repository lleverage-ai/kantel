// The gateway's end-to-end test against the compose stack:
//
//   bun apps/selfhosted/test/gateway/stack.ts [--base-url http://127.0.0.1:58090] [--mailpit-url http://127.0.0.1:58025]
//
// It reads the gateway's bootstrap (organisation, project, workspace and API key) from the running `gateway`
// container with `docker compose exec`, so it follows COMPOSE_PROJECT_NAME like every other compose command, then
// makes the same pass as the in-process test. Then it checks mail: the gateway reports its SMTP server, and a message
// sent from inside the gateway container through its own HARBOUR_SMTP_URL is readable through Mailpit's API. Prints
// one line per check and exits 1 if any failed.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { type E2eCheck, type E2eTarget, runGatewayE2e } from "./e2e.ts";
import { latestMessageTo } from "./mailpit.ts";

const { values } = parseArgs({
	options: {
		"base-url": {
			type: "string",
			default: process.env.HARBOUR_GATEWAY_URL ?? `http://127.0.0.1:${process.env.HARBOUR_GATEWAY_PORT ?? "58090"}`,
		},
		"mailpit-url": {
			type: "string",
			default: process.env.HARBOUR_MAILPIT_URL ?? `http://127.0.0.1:${process.env.HARBOUR_MAILPIT_PORT ?? "58025"}`,
		},
		compose: { type: "string", default: "deploy/compose/compose.yaml" },
	},
});
const baseUrl = values["base-url"];

const inGateway = (...command: string[]) =>
	spawnSync("docker", ["compose", "-f", values.compose, "exec", "-T", "gateway", ...command], { encoding: "utf8" });

const read = inGateway("cat", "/var/lib/harbour/bootstrap.json");
if (read.status !== 0) {
	console.error(`could not read the gateway's bootstrap: ${read.stderr.trim()}`);
	process.exit(2);
}
const seeded = JSON.parse(read.stdout) as Omit<E2eTarget, "baseUrl">;

const started = performance.now();
const checks: E2eCheck[] = [...(await runGatewayE2e({ baseUrl, ...seeded }))];
checks.push(...(await mailChecks(seeded.apiKey)));
for (const check of checks) {
	console.log(
		`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.ok || check.detail === undefined ? "" : `: ${check.detail}`}`,
	);
}
const failed = checks.filter((check) => !check.ok).length;
console.log(
	`${checks.length - failed}/${checks.length} checks passed against ${baseUrl} in ${Math.round(performance.now() - started)} ms`,
);
process.exit(failed === 0 ? 0 : 1);

async function mailChecks(apiKey: string): Promise<E2eCheck[]> {
	const out: E2eCheck[] = [];
	const deployment = await fetch(`${baseUrl}/v1/deployment`, { headers: { authorization: `Bearer ${apiKey}` } });
	const body = (await deployment.json()) as { mail?: { transport?: string; host?: string; from?: string } | null };
	out.push({
		name: "deployment names its SMTP server",
		ok: deployment.ok && body.mail?.transport === "smtp" && typeof body.mail.host === "string",
		detail: JSON.stringify(body.mail),
	});
	const to = `probe-${crypto.randomUUID()}@harbour.localhost`;
	const subject = `Harbour mail probe ${new Date().toISOString()}`;
	const probe = inGateway("bun", "test/gateway/smtp-probe.ts", to, subject);
	out.push({
		name: "the gateway container sends through HARBOUR_SMTP_URL",
		ok: probe.status === 0,
		detail: (probe.stderr || probe.stdout).trim(),
	});
	const message = probe.status === 0 ? await latestMessageTo(values["mailpit-url"], to) : undefined;
	out.push({
		name: "Mailpit's API returns the message, from HARBOUR_MAIL_FROM",
		ok:
			message?.subject === subject &&
			message.text.includes("000000") &&
			message.from === body.mail?.from?.replace(/^.*<|>$/g, ""),
		detail: JSON.stringify(message ?? null),
	});
	return out;
}
