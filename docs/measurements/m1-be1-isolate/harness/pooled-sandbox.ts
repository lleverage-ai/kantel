// The pooled form of images/isolate-host/src/sandbox.ts: the same bundle, with
// the workspace scope passed per call instead of a WS binding fixed by props
// at load time. Variant c of the measurement (bench-host.ts).

import { WorkerEntrypoint } from "cloudflare:workers";
import Sandbox, { type ExecRequest, type Manifest } from "../../../../images/isolate-host/src/sandbox.ts";

interface WorkspaceScope {
	read(sha: string): Promise<Uint8Array>;
	put(bytes: Uint8Array): Promise<string>;
}

export default class PooledSandbox extends WorkerEntrypoint {
	async list(manifest: Manifest, scope: WorkspaceScope) {
		return Sandbox.prototype.list.call({ env: { WS: scope } } as Sandbox, manifest);
	}

	/** Not called by the measurement; it keeps just-bash in the bundle, so loading costs what sandbox.ts costs. */
	async exec(request: ExecRequest, scope: WorkspaceScope) {
		return Sandbox.prototype.exec.call({ env: { WS: scope } } as Sandbox, request);
	}
}
