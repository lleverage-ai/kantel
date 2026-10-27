/**
 * Bundles the isolate tier (src/isolate/entry.ts, just-bash included) into one ES module, stored as text so the main
 * Worker can hand it to the Worker Loader. `cloudflare:workers` and `node:*` stay external: the Dynamic Worker runs
 * with nodejs_compat.
 *
 *   pnpm build:isolate
 */
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
	entryPoints: [new URL("../src/isolate/entry.ts", import.meta.url).pathname],
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2024",
	minify: true,
	write: false,
	external: ["cloudflare:workers", "node:*"],
	conditions: ["browser", "import"],
	logLevel: "warning",
});
const code = result.outputFiles[0]?.text;
if (code === undefined) throw new Error("no output");
await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/isolate.bundle.txt", import.meta.url), code);
console.log(`dist/isolate.bundle.txt: ${(code.length / 1024).toFixed(0)} KiB`);
