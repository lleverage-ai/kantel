/**
 * Bundles the Dynamic Worker (src/isolate.ts: the self-hosted sandbox with just-bash) into one ES module, stored as text so the
 * main Worker can hand it to the Worker Loader. As images/isolate-host/build.ts does: browser target, no nodejs_compat.
 *
 *   pnpm build:isolate
 */
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
	entryPoints: [new URL("../src/isolate.ts", import.meta.url).pathname],
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
