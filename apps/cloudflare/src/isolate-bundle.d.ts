/** An isolate's code as text (`scripts/build-isolate.ts`), imported by wrangler's `Text` rule. */
declare module "*.bundle.txt" {
	const source: string;
	export default source;
}

/** QuickJS's WebAssembly as bytes (`scripts/build-isolate.ts`), imported by wrangler's `Data` rule for code mode. */
declare module "*.wasm.bin" {
	const bytes: ArrayBuffer;
	export default bytes;
}

/** A compiled WebAssembly module: in the code mode isolate, the `quickjs.wasm` module the Worker Loader gives it. */
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
