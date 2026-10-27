// The gateway's end-to-end test against the compose stack:
//
//   bun apps/selfhosted/test/gateway/stack.ts [--base-url http://127.0.0.1:58090]
//
// It reads the gateway's bootstrap (organisation, project, workspace and API key) from the running `gateway`
// container with `docker compose exec`, so it follows COMPOSE_PROJECT_NAME like every other compose command, then
// makes the same pass as the in-process test. Prints one line per check and exits 1 if any failed.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { type E2eTarget, runGatewayE2e } from "./e2e.ts";

const { values } = parseArgs({
	options: {
		"base-url": {
			type: "string",
			default: process.env.HARBOUR_GATEWAY_URL ?? `http://127.0.0.1:${process.env.HARBOUR_GATEWAY_PORT ?? "58090"}`,
		},
		compose: { type: "string", default: "deploy/compose/compose.yaml" },
	},
});
const baseUrl = values["base-url"];

const read = spawnSync(
	"docker",
	["compose", "-f", values.compose, "exec", "-T", "gateway", "cat", "/var/lib/harbour/bootstrap.json"],
	{ encoding: "utf8" },
);
if (read.status !== 0) {
	console.error(`could not read the gateway's bootstrap: ${read.stderr.trim()}`);
	process.exit(2);
}
const seeded = JSON.parse(read.stdout) as Omit<E2eTarget, "baseUrl">;

const started = performance.now();
const checks = await runGatewayE2e({ baseUrl, ...seeded });
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
