// A client for the scenario surface both M0 targets serve (M0-CF1's
// spikes/scenario/README.md): /sessions/:id/{setup,prompt,state,vault}.
// The conformance suite uses only this, so it runs unchanged against the
// Cloudflare worker and the self-hosted hosts. No dependencies.

export interface Step {
	tool: "bash" | "read" | "write";
	args: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	text: string;
}

export interface ExecRecord {
	command: string;
	tier: "isolate" | "container";
	exitCode: number;
	base: string;
	version: string;
}

export interface State {
	submission?: { id: string; status: string; reason?: string };
	toolResults: ToolResult[];
	answer?: string;
	workspace: { id: string; head: string };
	execs: ExecRecord[];
	events: { at: number; type: string }[];
}

export interface VaultUse {
	tier: string;
	decision: string;
	host?: string;
	injected?: unknown;
	redactions?: number;
}

export const FINAL = "conformance run finished";

export class SharedSurface {
	constructor(
		readonly base: string,
		readonly token = process.env.KANTEL_SPIKE_TOKEN ?? "",
	) {}

	async call<T>(method: string, sessionId: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.base}/sessions/${sessionId}/${path}`, {
			method,
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(60_000),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
		return JSON.parse(text) as T;
	}

	/** Set up a session that runs `steps` with the scripted model, prompt it, and wait until it settles. */
	async run(steps: Step[], options: { seed?: Record<string, string>; timeoutMs?: number } = {}) {
		const sessionId = `conformance-${crypto.randomUUID().slice(0, 12)}`;
		await this.call("POST", sessionId, "setup", {
			scenario: {
				name: "conformance",
				seed: options.seed ?? { "README.md": "conformance\n" },
				steps,
				finalAnswer: FINAL,
			},
		});
		const { submissionId } = await this.prompt(sessionId, `${sessionId}-prompt`);
		const state = await this.settle(sessionId, submissionId, options.timeoutMs);
		return { sessionId, submissionId, state };
	}

	prompt(sessionId: string, requestId: string) {
		return this.call<{ submissionId: string | number }>("POST", sessionId, "prompt", {
			content: "Run the steps.",
			requestId,
		});
	}

	async settle(sessionId: string, submissionId: string | number, timeoutMs = 180_000): Promise<State> {
		const deadline = Date.now() + timeoutMs;
		let state: State | undefined;
		while (Date.now() < deadline) {
			state = await this.call<State>("GET", sessionId, `state?submission=${submissionId}`);
			const status = state.submission?.status;
			if (status === "done" || status === "unanswered") return state;
			await Bun.sleep(300);
		}
		throw new Error(`session ${sessionId} did not settle: ${JSON.stringify(state?.submission)}`);
	}

	vault(sessionId: string) {
		return this.call<VaultUse[]>("GET", sessionId, "vault");
	}
}

/** The exec record for a command (the last one, if it ran more than once). */
export function execOf(state: State, command: string): ExecRecord | undefined {
	return state.execs.filter((e) => e.command === command).at(-1);
}
