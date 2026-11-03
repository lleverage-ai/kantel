/**
 * Bundles the isolate the main Worker hands to the Worker Loader into one ES module kept as text in `generated/`:
 * `isolate.bundle.txt`, the `dynamic-worker` isolate (src/isolate/entry.ts, just-bash included), `src/dynamic-worker.ts`.
 *
 * `cloudflare:workers` and `node:*` stay external: the isolate runs with nodejs_compat.
 *
 * It also copies the QuickJS build the in-process isolate's `node` runs (`src/sandboxes.ts`,
 * `@kantel/sandbox/isolate-node`) to `generated/quickjs-node.wasm`, which wrangler compiles: its `CompiledWasm` rule
 * matches an import's path, and the package exports the file only as `@jitl/quickjs-wasmfile-release-sync/wasm`.
 *
 * `pnpm dev`, `pnpm deploy:dry-run` and the deploy workflow run it before wrangler; the tests don't need it.
 *
 * Usage: node scripts/build-isolate.ts
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

async function bundle(entry: string, output: string): Promise<void> {
	const result = await build({
		entryPoints: [new URL(entry, import.meta.url).pathname],
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
	if (code === undefined) throw new Error(`esbuild wrote no output for ${entry}`);
	await writeFile(new URL(`../generated/${output}`, import.meta.url), code);
	console.log(`generated/${output}: ${(code.length / 1024).toFixed(0)} KiB`);
}

await mkdir(new URL("../generated", import.meta.url), { recursive: true });
await bundle("../src/isolate/entry.ts", "isolate.bundle.txt");
const quickjsNode = createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
await copyFile(quickjsNode, new URL("../generated/quickjs-node.wasm", import.meta.url));
console.log("generated/quickjs-node.wasm: QuickJS for node");
