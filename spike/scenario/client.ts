// A target-agnostic client for the spike HTTP API (spike/contracts). The
// scenario and the conformance suite use only this, so the same scripts run
// against the Cloudflare gateway and the self-hosted hosts. No dependencies.

import {
	type CreateSessionResponse,
	SCENARIO_PREFIX,
	type ScenarioSpec,
	type SessionState,
} from "../contracts/index.ts";

export class SpikeClient {
	constructor(
		public base: string,
		readonly headers: Record<string, string> = {},
	) {}

	async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${this.base}${path}`, {
			method,
			headers: { "content-type": "application/json", ...this.headers },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
		return JSON.parse(text) as T;
	}

	target() {
		return this.#call<{ target: string; [key: string]: unknown }>("GET", "/v0/target");
	}

	create(sessionId?: string) {
		return this.#call<CreateSessionResponse>("POST", "/v0/sessions", sessionId ? { sessionId } : {});
	}

	prompt(sessionId: string, spec: ScenarioSpec, requestId: string = crypto.randomUUID()) {
		return this.#call<{ submissionId: number }>("POST", `/v0/sessions/${sessionId}/prompt`, {
			text: `${SCENARIO_PREFIX}${JSON.stringify(spec)}`,
			requestId,
		});
	}

	state(sessionId: string) {
		return this.#call<SessionState>("GET", `/v0/sessions/${sessionId}`);
	}

	audit(sessionId: string) {
		return this.#call<{ events: { kind: string; actor: string; detail: Record<string, unknown> }[] }>(
			"GET",
			`/v0/sessions/${sessionId}/audit`,
		);
	}

	/** Poll until the latest input settles with DONE or FAILED. */
	async settle(
		sessionId: string,
		options: { timeoutMs?: number; intervalMs?: number; onState?: (state: SessionState) => Promise<void> | void } = {},
	): Promise<{ state: SessionState; done: boolean; result: { steps: number; outputs: string[]; errors: boolean[] } | undefined }> {
		const deadline = Date.now() + (options.timeoutMs ?? 180_000);
		let last: SessionState | undefined;
		while (Date.now() < deadline) {
			try {
				last = await this.state(sessionId);
				await options.onState?.(last);
				const answer = last.answer ?? "";
				if (answer.startsWith("DONE ")) return { state: last, done: true, result: JSON.parse(answer.slice(5)) };
				if (answer.startsWith("FAILED")) return { state: last, done: false, result: undefined };
			} catch (error) {
				// A host that just died: keep polling (the caller may have switched base).
				if (!(error instanceof Error) || !/fetch|ECONNREFUSED|socket|50[23]|timed out|Unable to connect/i.test(error.message)) throw error;
			}
			await Bun.sleep(options.intervalMs ?? 200);
		}
		throw new Error(`session ${sessionId} did not settle; last answer: ${last?.answer ?? "(none)"}`);
	}
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}
