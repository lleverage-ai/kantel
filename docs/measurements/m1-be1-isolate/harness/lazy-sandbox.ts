// images/isolate-host/src/sandbox.ts with just-bash loaded on the first exec
// instead of when the isolate loads. The Dynamic Worker gets two modules: this
// one as its main module and the unchanged sandbox bundle as "sandbox.js".
// Variant f of the measurement (bench-host.ts).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExecRequest, Manifest, default as Sandbox } from "../../../../images/isolate-host/src/sandbox.ts";

// A specifier the bundler leaves alone, so workerd resolves it at run time.
const sandboxModule = "./sandbox.js";

export default class LazySandbox extends WorkerEntrypoint {
	/** The same as Sandbox.list: no file bodies, no just-bash. */
	async list(manifest: Manifest): Promise<{ entries: number; bytes: number }> {
		let bytes = 0;
		for (const entry of Object.values(manifest)) if (entry.kind === "file") bytes += entry.size;
		return { entries: Object.keys(manifest).length, bytes };
	}

	async exec(request: ExecRequest) {
		const { default: Loaded } = (await import(sandboxModule)) as { default: typeof Sandbox };
		return Loaded.prototype.exec.call(this as unknown as Sandbox, request);
	}
}
