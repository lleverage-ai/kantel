/**
 * Builds the npm package `kantel` in `dist/`: one bundled file, `kantel.js` (the CLI with the SDK in it, for Node 22
 * and later), its package.json, and the README. Publishing is a separate step: `npm publish dist`.
 */
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
	readonly version: string;
	readonly description?: string;
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const SHEBANG = "#!/usr/bin/env node";
const result = await build({
	entryPoints: [join(root, "src/main.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	banner: { js: SHEBANG },
	legalComments: "none",
	write: false,
	outfile: join(dist, "kantel.js"),
	logLevel: "warning",
});
const [output] = result.outputFiles;
if (output === undefined) throw new Error("esbuild wrote nothing");
// main.ts starts with its own shebang, which esbuild keeps beside the banner's: keep exactly one.
const body = output.text.replace(/^(#![^\n]*\n)+/, "");
const bundle = join(dist, "kantel.js");
await writeFile(bundle, `${SHEBANG}\n${body}`);
await chmod(bundle, 0o755);

const manifest = {
	name: "kantel",
	version: source.version,
	description: source.description,
	license: "Apache-2.0",
	// npm's trusted publishing and provenance check this against the repository the release workflow runs in.
	repository: { type: "git", url: "git+https://github.com/lleverage-ai/kantel.git", directory: "packages/cli" },
	type: "module",
	bin: { kantel: "kantel.js" },
	files: ["kantel.js", "README.md"],
	engines: { node: ">=22" },
};
await writeFile(join(dist, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
await copyFile(join(root, "README.md"), join(dist, "README.md"));

process.stdout.write(`Built kantel ${source.version} in ${dist}\n`);
