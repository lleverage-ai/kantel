// Bundles the isolate tier's worker for workerd: dist/host.js, with the just-bash sandbox
// (images/isolate-host/src/sandbox.ts) bundled on its own as dist/sandbox.js, which host.js hands to the
// workerLoader binding as a text module.
// The sandbox's source lives in images/isolate-host, but its dependencies are installed here.
const here: import("bun").BunPlugin = {
	name: "resolve-here",
	setup(build) {
		build.onResolve({ filter: /^just-bash(\/.*)?$/ }, (args) => ({
			path: Bun.resolveSync(args.path, import.meta.dir),
		}));
	},
};

const common = {
	target: "browser" as const,
	format: "esm" as const,
	external: ["cloudflare:workers", "node:*"],
	minify: true,
	plugins: [here],
};

const sandbox = await Bun.build({
	...common,
	entrypoints: ["../../../images/isolate-host/src/sandbox.ts"],
	outdir: "dist",
	naming: "sandbox.js",
});
if (!sandbox.success) throw new AggregateError(sandbox.logs, "sandbox build failed");

const host = await Bun.build({
	...common,
	entrypoints: ["src/host.ts"],
	outdir: "dist",
	naming: "host.js",
	external: [...common.external, "kantel-sandbox-bundle"],
});
if (!host.success) throw new AggregateError(host.logs, "host build failed");

for (const output of [...sandbox.outputs, ...host.outputs]) console.log(output.path, output.size);
