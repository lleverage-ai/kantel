// A Dynamic Worker with nothing in it: loading it is the fixed cost of a new
// isolate, without compiling or running the just-bash bundle.

import { WorkerEntrypoint } from "cloudflare:workers";

export default class TrivialSandbox extends WorkerEntrypoint {
	async list(_manifest: unknown) {
		return { entries: 0, bytes: 0 };
	}
}
