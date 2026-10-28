/** The `dynamic-worker` isolate's code as text (`scripts/build-isolate.ts`), imported by wrangler's `Text` rule. */
declare module "*.bundle.txt" {
	const source: string;
	export default source;
}
