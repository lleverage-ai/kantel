// Writes generated/openapi.json and generated/sdk.ts from src/routes.ts, formatted by Biome as the repository's lint
// expects. `--check` writes nothing and fails if either file differs from what it would write: CI runs it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { openApi, sdkSource } from "../src/document.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repository = join(root, "..", "..");
const check = process.argv.includes("--check");

/** Formats text as Biome would format the file at `path`. */
const format = (path: string, text: string): string =>
	execFileSync(
		join(repository, "node_modules", ".bin", "biome"),
		["format", `--stdin-file-path=${relative(repository, path)}`],
		{
			cwd: repository,
			input: text,
			encoding: "utf8",
		},
	);

const outputs: { path: string; text: string }[] = [
	{ path: join(root, "generated", "openapi.json"), text: `${JSON.stringify(openApi(), null, "\t")}\n` },
	{
		path: join(root, "generated", "sdk.ts"),
		text: sdkSource(readFileSync(join(root, "src", "sdk-runtime.ts"), "utf8")),
	},
];

let stale = 0;
for (const { path, text } of outputs) {
	const formatted = format(path, text);
	const name = relative(repository, path);
	if (check) {
		let current: string | undefined;
		try {
			current = readFileSync(path, "utf8");
		} catch {
			current = undefined;
		}
		if (current !== formatted) {
			stale += 1;
			console.error(`${name} is stale. Run \`pnpm --filter @kantel/api generate\` and commit the result.`);
		}
	} else {
		writeFileSync(path, formatted);
		console.log(`Wrote ${name}`);
	}
}
if (stale > 0) process.exit(1);
if (check) console.log("The generated API files are current.");
