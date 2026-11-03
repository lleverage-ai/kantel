/** An isolate's code as text (`scripts/build-isolate.ts`), imported by wrangler's `Text` rule. */
declare module "*.bundle.txt" {
	const source: string;
	export default source;
}

/** A compiled WebAssembly module: QuickJS for the in-process isolate's `node` (`generated/quickjs-node.wasm`). */
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
