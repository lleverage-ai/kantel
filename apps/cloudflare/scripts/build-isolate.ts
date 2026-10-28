/**
 * Bundles the `dynamic-worker` isolate (src/isolate/entry.ts, just-bash included) into one ES module, kept as text in
 * `generated/isolate.bundle.txt` so the main Worker can hand it to the Worker Loader (`src/dynamic-worker.ts`).
 * `cloudflare:workers` and `node:*` stay external: the isolate runs with nodejs_compat.
 *
 * `pnpm dev`, `pnpm deploy:dry-run` and the deploy workflow run it before wrangler; the tests don't need it.
 *
 * Usage: node scripts/build-isolate.ts
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
if (code === undefined) throw new Error("esbuild wrote no output");
await mkdir(new URL("../generated", import.meta.url), { recursive: true });
await writeFile(new URL("../generated/isolate.bundle.txt", import.meta.url), code);
console.log(`generated/isolate.bundle.txt: ${(code.length / 1024).toFixed(0)} KiB`);
