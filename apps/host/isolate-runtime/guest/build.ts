// Bundles the guest (main.js: the shell, node and python runtimes) into one classic script for kantel-isolate's
// startup snapshot: <out>/guest.js (default guest/dist). Run with `bun run guest/build.ts [out-dir]`.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.argv[2] ?? `${import.meta.dir}/dist`);
mkdirSync(out, { recursive: true });

// just-bash's gzip, gunzip and zcat import node:zlib: give them the host's flate2 (shell/zlib.js).
const zlib: import("bun").BunPlugin = {
	name: "kantel-zlib",
	setup(build) {
		build.onResolve({ filter: /^(node:)?zlib$/ }, () => ({ path: `${import.meta.dir}/shell/zlib.js` }));
	},
};

const result = await Bun.build({
	entrypoints: [`${import.meta.dir}/main.js`],
	outdir: out,
	naming: "guest.js",
	target: "browser",
	format: "iife",
	minify: true,
	// Strict mode throughout: a strict function's CallSite has no getFunction()/getThis(), so a stack trace can't
	// hand guest code one of the runtime's own functions.
	banner: '"use strict";',
	plugins: [zlib],
});
if (!result.success) throw new AggregateError(result.logs, "guest build failed");
for (const output of result.outputs) console.log(output.path, output.size);
