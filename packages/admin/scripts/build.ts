/**
 * Builds `kantel-admin` in `dist/`: one bundled file, `kantel-admin.js`, with the SDK and the parts of `@kantel/cli`
 * it uses, for Node 22 and later. It isn't on npm: each release attaches it to Kantel's GitHub Release
 * (tools/release/pack.sh), where `curl -fsSLo kantel-admin <release>/kantel-admin.js` fetches it.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const source = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly version: string };

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
	outfile: join(dist, "kantel-admin.js"),
	logLevel: "warning",
});
const [output] = result.outputFiles;
if (output === undefined) throw new Error("esbuild wrote nothing");
// main.ts starts with its own shebang, which esbuild keeps beside the banner's: keep exactly one.
const body = output.text.replace(/^(#![^\n]*\n)+/, "");
const bundle = join(dist, "kantel-admin.js");
await writeFile(bundle, `${SHEBANG}\n${body}`);
await chmod(bundle, 0o755);

process.stdout.write(`Built kantel-admin ${source.version} in ${bundle}\n`);
