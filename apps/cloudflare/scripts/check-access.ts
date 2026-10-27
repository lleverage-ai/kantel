/**
 * After a deploy: checks that an anonymous request to the deployed hostname is sent to Cloudflare Access sign-in, for
 * the console, the gateway and the health check alike. Anything else (a 200, a 401 from the Worker itself, a redirect
 * to another host) means Access isn't in front of the Worker, and fails the deploy.
 *
 * A new custom domain can take a minute or two to get its certificate, so connection errors and 5xx answers are
 * retried until `--timeout` seconds have passed. A wrong answer is not retried.
 *
 * Usage: node scripts/check-access.ts --host harbour.myslop.app --team-domain <team>.cloudflareaccess.com [--timeout 300]
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { hostOnly } from "./deploy-config.ts";

/** The paths checked: the console, a deep link, the gateway and the health check. */
export const CHECKED_PATHS = ["/", "/projects", "/v1/sessions", "/healthz"] as const;

export type AccessVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether one response is Access sending an anonymous visitor to sign in: a redirect to
 * `https://<team domain>/cdn-cgi/access/login/…`.
 */
export function accessVerdict(status: number, location: string | null, teamDomain: string): AccessVerdict {
	if (status < 300 || status > 399) {
		return { ok: false, reason: `expected a redirect to Access sign-in, got HTTP ${status}` };
	}
	if (location === null || location === "") return { ok: false, reason: `HTTP ${status} without a Location header` };
	let target: URL;
	try {
		target = new URL(location);
	} catch {
		return { ok: false, reason: `HTTP ${status} to an unparseable Location: ${location}` };
	}
	const team = hostOnly(teamDomain).toLowerCase();
	if (target.protocol !== "https:" || target.host.toLowerCase() !== team) {
		return { ok: false, reason: `redirected to ${target.origin}, not the Access team domain https://${team}` };
	}
	if (!target.pathname.startsWith("/cdn-cgi/access/login")) {
		return { ok: false, reason: `redirected to ${target.pathname} on the team domain, not /cdn-cgi/access/login` };
	}
	return { ok: true };
}

async function checkOnce(url: string, teamDomain: string): Promise<AccessVerdict> {
	const response = await fetch(url, { redirect: "manual", headers: { "user-agent": "harbour-deploy-check" } });
	await response.body?.cancel();
	// A new custom domain can answer 5xx (such as 522) until it is fully set up: retried like a connection error.
	if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
	return accessVerdict(response.status, response.headers.get("location"), teamDomain);
}

async function main(): Promise<void> {
	const { values: args } = parseArgs({
		options: {
			host: { type: "string" },
			"team-domain": { type: "string" },
			timeout: { type: "string", default: "300" },
		},
	});
	const host = args.host?.trim();
	const teamDomain = args["team-domain"]?.trim();
	if (!host || !teamDomain) throw new Error("Pass --host and --team-domain");
	const deadline = Date.now() + Number(args.timeout) * 1000;
	let failures = 0;
	for (const path of CHECKED_PATHS) {
		const url = `https://${host}${path}`;
		for (;;) {
			try {
				const verdict = await checkOnce(url, teamDomain);
				if (verdict.ok) console.log(`ok   ${url} goes to Access sign-in`);
				else {
					console.error(`FAIL ${url}: ${verdict.reason}`);
					failures += 1;
				}
				break;
			} catch (error) {
				if (Date.now() > deadline) throw new Error(`${url} still unreachable: ${String(error)}`);
				console.log(`wait ${url} not reachable yet (${String(error)}); retrying`);
				await new Promise((done) => setTimeout(done, 10_000));
			}
		}
	}
	if (failures > 0) throw new Error(`${failures} of ${CHECKED_PATHS.length} paths are not behind Access sign-in`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
