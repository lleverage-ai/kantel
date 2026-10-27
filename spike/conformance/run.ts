#!/usr/bin/env bun
// Run the spike conformance suite against one target.
//
//   bun spike/conformance/run.ts --target=selfhosted [--base=URL]
//   bun spike/conformance/run.ts --target=cloudflare --base=https://...
//
// The suite itself (spike.test.ts) knows nothing about targets; this only
// picks the URL. Self-hosted extras (Pi Durable storage on Postgres, lease
// fencing) live in apps/selfhosted/test and run with the same command.

import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		target: { type: "string", default: "selfhosted" },
		base: { type: "string" },
	},
});

const defaults: Record<string, string> = { selfhosted: "http://127.0.0.1:58081" };
const base = values.base ?? defaults[values.target!];
if (!base) throw new Error(`--base is required for --target=${values.target}`);

const root = new URL("../..", import.meta.url).pathname;
const env = { ...process.env, HARBOUR_TARGET_URL: base };
const suites: { cwd: string; args: string[] }[] = [{ cwd: root, args: ["test", "./spike/conformance/"] }];
if (values.target === "selfhosted") suites.push({ cwd: `${root}apps/selfhosted`, args: ["test", "./test/"] });

let failed = false;
for (const suite of suites) {
	console.log(`\n# ${values.target}: bun ${suite.args.join(" ")} (in ${suite.cwd.replace(root, "") || "."})`);
	const child = Bun.spawnSync(["bun", ...suite.args], { cwd: suite.cwd, env, stdout: "inherit", stderr: "inherit" });
	if (child.exitCode !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
