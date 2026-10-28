/* eslint-disable */
// Written to match `wrangler types --include-runtime=false src/worker-configuration.d.ts` for wrangler.jsonc.
interface __BaseEnv_Env {
	WORKSPACES: R2Bucket;
	LOADER: WorkerLoader;
	SESSION: DurableObjectNamespace<import("./index").SessionDO>;
	WORKSPACE: DurableObjectNamespace<import("./index").WorkspaceDO>;
	POOL: DurableObjectNamespace<import("./index").PoolDO>;
	/** Worker secret: the bench's bearer token. */
	READY_SPIKE_TOKEN?: string;
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./index");
		durableNamespaces: "SessionDO" | "WorkspaceDO" | "PoolDO";
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
declare module "*.bundle.txt" {
	const value: string;
	export default value;
}
