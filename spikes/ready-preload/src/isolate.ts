/**
 * The Dynamic Worker: the self-hosted sandbox (images/isolate-host/src/sandbox.ts, just-bash included), unchanged,
 * with a boot ID and a call count on every answer so the bench can tell a reused isolate from a fresh load. Bundled by
 * scripts/build-isolate.mjs into dist/isolate.bundle.txt; the main Worker never imports it.
 */
import Sandbox, { type ExecRequest, type Manifest } from "@kantel/isolate-host/src/sandbox.ts";

type WorkspaceBinding = Parameters<Sandbox["exec"]>[1];

/** Random values are not allowed at module scope in Workers, so the boot ID is drawn on the first call. */
let boot: string | undefined;
let calls = 0;

function seen() {
	boot ??= crypto.randomUUID();
	calls += 1;
	return { boot, calls };
}

export default class SpikeSandbox extends Sandbox {
	override async list(manifest: Manifest, scope?: WorkspaceBinding) {
		const isolate = seen();
		return { ...(await super.list(manifest, scope)), isolate };
	}

	override async exec(request: ExecRequest, scope?: WorkspaceBinding) {
		const isolate = seen();
		return { ...(await super.exec(request, scope)), isolate };
	}
}
