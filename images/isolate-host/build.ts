// Bundles the isolate host and the sandbox for workerd.
// dist/sandbox.js is embedded in the host as a text module and handed to the
// workerLoader binding at runtime.
const common = {
	target: "browser" as const,
	format: "esm" as const,
	external: ["cloudflare:workers", "node:*"],
	minify: true,
};

const sandbox = await Bun.build({ ...common, entrypoints: ["src/sandbox.ts"], outdir: "dist", naming: "sandbox.js" });
if (!sandbox.success) throw new AggregateError(sandbox.logs, "sandbox build failed");

const loader = await Bun.build({
	...common,
	entrypoints: ["src/loader.ts"],
	outdir: "dist",
	naming: "loader.js",
	external: [...common.external, "kantel-sandbox-bundle"],
});
if (!loader.success) throw new AggregateError(loader.logs, "loader build failed");

for (const output of [...sandbox.outputs, ...loader.outputs]) console.log(output.path, output.size);
