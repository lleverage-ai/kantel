// The isolate tier client: just-bash in a Dynamic Worker on the workerd
// isolate host (images/isolate-host).

import type {
	Manifest,
	SandboxExecRequest,
	SandboxExecResult,
	SandboxTierRunner,
} from "../../../../spike/contracts/index.ts";

export class IsolateRunner implements SandboxTierRunner {
	readonly tier = "isolate" as const;

	constructor(private readonly baseUrl: string) {}

	async #post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			signal,
		});
		const json = (await response.json()) as T & { error?: string };
		if (!response.ok || json.error) throw new Error(`isolate host ${path}: ${json.error ?? response.status}`);
		return json;
	}

	/** Load (or reuse) the session's isolate and list the workspace version: the "isolate ready" step. */
	list(sessionId: string, workspaceId: string, version: string) {
		return this.#post<{ entries: number; bytes: number; timings: Record<string, number> }>("/list", {
			sessionId,
			workspaceId,
			version,
		});
	}

	async exec(request: SandboxExecRequest, manifest: Manifest, signal?: AbortSignal): Promise<SandboxExecResult> {
		const result = await this.#post<Omit<SandboxExecResult, "tier">>(
			"/exec",
			{
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
				version: request.version,
				manifest,
				command: request.command,
				cwd: request.cwd,
				env: request.env,
				timeoutMs: request.timeoutMs,
			},
			signal,
		);
		return { tier: "isolate", ...result };
	}
}
