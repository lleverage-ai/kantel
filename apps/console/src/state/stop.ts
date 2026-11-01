// The composer's Stop. Stopping isn't a send, so it never puts the composer in its sending state: the session's own
// stream says when the run has ended, and the composer follows that, not the request.
//
// The host answers an abort only once the run has let go of everything it held, while the stream shows the run ended
// (the tool call interrupted, the session idle) at once. On the deployed console a container command still running
// held the answer until the command's own timeout, 64 s in one case, and a Stop that waited for the answer kept the
// send button spinning all that time, though the session would have taken the next message.
//
// So a press holds Stop (shown disabled, so the run isn't aborted twice) until the session's status leaves `running`
// or the request settles; a failed one shows why, and Stop can be pressed again. Once the status has moved on, the
// request's outcome no longer matters: the run it was for has ended.

import type { SessionStatus } from "@kantel/protocol";

const reasonOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** One session screen's Stop, for `useSyncExternalStore`: `getState` is whether a press is still waiting. */
export class Stopper {
	private stopping = false;
	/** Bumped by each press and by the run ending, so an earlier request's outcome is ignored. */
	private attempt = 0;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly cancel: () => Promise<void>,
		private readonly onFailure: (reason: string) => void = () => {},
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getState = (): boolean => this.stopping;

	/** Aborts the run, unless a press is already waiting. */
	stop = (): void => {
		if (this.stopping) return;
		const attempt = ++this.attempt;
		this.set(true);
		this.cancel().then(
			() => {
				if (attempt === this.attempt) this.set(false);
			},
			(reason: unknown) => {
				if (attempt !== this.attempt) return;
				this.set(false);
				this.onFailure(reasonOf(reason));
			},
		);
	};

	/** The session's status as the stream has it: anything but `running` means the run a press was for has ended. */
	settle(status: SessionStatus): void {
		if (!this.stopping || status === "running") return;
		this.attempt++;
		this.set(false);
	}

	private set(stopping: boolean): void {
		if (stopping === this.stopping) return;
		this.stopping = stopping;
		for (const listener of this.listeners) listener();
	}
}
