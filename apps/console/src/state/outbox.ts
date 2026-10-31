// The messages the person has sent from this screen that the session's stream hasn't shown yet: an optimistic send.
// A message shows in the transcript the moment it is sent, under an ID of its own (`local:<requestId>`), and the
// composer clears at once. The send carries the message's requestId, which the host keeps on the user item it makes
// (`UserItem.requestId`), so when the stream brings that item the local copy goes and the transcript keys both by the
// requestId (`messageKeys` in @kantel/ui): one row, updated in place, never two and never moved.
//
// Messages go one at a time, in the order they were sent, so the host takes them in that order. A message that fails
// stays where it was, marked failed, with Try again (the same requestId, so a send the host took before its answer
// was lost still happens once) and Edit (back to the composer). The ones queued behind it fail with it rather than
// overtake it.

import type { TranscriptItem, UserAttachment, UserItem, UserItemVia } from "@kantel/protocol";

export type OutgoingVia = Exclude<UserItemVia, "followUp">;

export type OutgoingStatus =
	/** Waiting for the message before it to go. */
	| "queued"
	/** On its way. */
	| "sending"
	/** The host took it; its item hasn't come down the stream yet. */
	| "sent"
	| "failed";

export type Outgoing<O = unknown> = {
	readonly requestId: string;
	readonly via: OutgoingVia;
	readonly text: string;
	/** When it was sent (epoch ms), the local item's time. */
	readonly at: number;
	readonly attachments?: readonly UserAttachment[];
	readonly status: OutgoingStatus;
	/** Why it failed, when it did and the host said. */
	readonly reason?: string;
	/** What else the host sends with it, as chosen when it was sent (the model and thinking level, say). */
	readonly options?: O;
};

/** Sends one message to the host; rejects when the host didn't take it. */
export type Deliver<O> = (message: Outgoing<O>) => Promise<void>;

/** The transcript item an outgoing message shows as until the session's own arrives. */
export const outgoingId = (requestId: string): string => `local:${requestId}`;

export function outgoingItem(message: Outgoing): UserItem {
	return {
		kind: "user",
		id: outgoingId(message.requestId),
		at: message.at,
		text: message.text,
		via: message.via,
		requestId: message.requestId,
		...(message.attachments === undefined || message.attachments.length === 0
			? {}
			: { attachments: message.attachments }),
	};
}

/**
 * The requestIds among `wanted` that the session's items already have, looked for from the end, where a message just
 * sent arrives, stopping once all are found.
 */
export function echoed(items: readonly TranscriptItem[], wanted: ReadonlySet<string>): Set<string> {
	const found = new Set<string>();
	if (wanted.size === 0) return found;
	for (let index = items.length - 1; index >= 0 && found.size < wanted.size; index -= 1) {
		const item = items[index];
		if (item?.kind === "user" && item.requestId !== undefined && wanted.has(item.requestId)) found.add(item.requestId);
	}
	return found;
}

/**
 * The transcript's items: the session's, then each outgoing message the session doesn't have yet, in the order they
 * were sent. A message whose item has arrived is never shown twice, even before the outbox has settled. The
 * session's own array comes back, unchanged, when there is nothing outgoing to show.
 */
export function withOutbox(items: readonly TranscriptItem[], outbox: readonly Outgoing[]): readonly TranscriptItem[] {
	if (outbox.length === 0) return items;
	const arrived = echoed(items, new Set(outbox.map((message) => message.requestId)));
	const shown = outbox.filter((message) => !arrived.has(message.requestId));
	return shown.length === 0 ? items : [...items, ...shown.map(outgoingItem)];
}

/** Whether a message is still going: queued or on its way. */
export const inFlight = (message: Outgoing): boolean => message.status === "queued" || message.status === "sending";

const reasonOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** One session screen's outgoing messages, for `useSyncExternalStore`. */
export class Outbox<O = undefined> {
	private messages: readonly Outgoing<O>[] = [];
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly deliver: Deliver<O>,
		private readonly newId: () => string = () => crypto.randomUUID(),
		private readonly now: () => number = Date.now,
	) {}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getState = (): readonly Outgoing<O>[] => this.messages;

	/** Shows the message at once and sends it after any still going before it. */
	send(
		via: OutgoingVia,
		text: string,
		extra: { readonly attachments?: readonly UserAttachment[]; readonly options?: O } = {},
	): Outgoing<O> {
		const { attachments = [], options } = extra;
		const message: Outgoing<O> = {
			requestId: this.newId(),
			via,
			text,
			at: this.now(),
			...(attachments.length === 0 ? {} : { attachments }),
			...(options === undefined ? {} : { options }),
			status: "queued",
		};
		this.set([...this.messages, message]);
		this.pump();
		return message;
	}

	/**
	 * Sends a failed message again, with its requestId. It goes to the end, after anything sent since, so it shows where
	 * the host will put it.
	 */
	retry(requestId: string): void {
		const message = this.messages.find((candidate) => candidate.requestId === requestId);
		if (message === undefined || message.status !== "failed") return;
		const { reason: _reason, ...rest } = message;
		this.set([...this.messages.filter((candidate) => candidate !== message), { ...rest, status: "queued" }]);
		this.pump();
	}

	/** Takes a failed message out, to put its words back in the composer. */
	take(requestId: string): Outgoing<O> | undefined {
		const message = this.messages.find((candidate) => candidate.requestId === requestId);
		if (message === undefined || message.status !== "failed") return undefined;
		this.set(this.messages.filter((candidate) => candidate !== message));
		return message;
	}

	/**
	 * Lets go of every message the session's items now have. Whatever state it was in: a send whose answer was lost, or
	 * still to come, has still reached the session.
	 */
	settle(items: readonly TranscriptItem[]): void {
		if (this.messages.length === 0) return;
		const arrived = echoed(items, new Set(this.messages.map((message) => message.requestId)));
		if (arrived.size === 0) return;
		this.set(this.messages.filter((message) => !arrived.has(message.requestId)));
	}

	private set(messages: readonly Outgoing<O>[]): void {
		this.messages = messages;
		for (const listener of this.listeners) listener();
	}

	private update(requestId: string, change: (message: Outgoing<O>) => Outgoing<O>): void {
		const index = this.messages.findIndex((message) => message.requestId === requestId);
		const message = this.messages[index];
		if (message === undefined) return;
		const next = [...this.messages];
		next[index] = change(message);
		this.set(next);
	}

	/** Sends the first queued message, unless one is on its way. */
	private pump(): void {
		if (this.messages.some((message) => message.status === "sending")) return;
		const message = this.messages.find((candidate) => candidate.status === "queued");
		if (message === undefined) return;
		const sending: Outgoing<O> = { ...message, status: "sending" };
		this.update(message.requestId, () => sending);
		this.deliver(sending).then(
			() => {
				this.update(message.requestId, (current) => ({ ...current, status: "sent" }));
				this.pump();
			},
			(reason: unknown) => {
				// The ones queued behind it fail too: sent now, they would land before it.
				const failed = reasonOf(reason);
				let after = false;
				this.set(
					this.messages.map((current) => {
						if (current.requestId === message.requestId) {
							after = true;
							return { ...current, status: "failed", reason: failed };
						}
						return after && current.status === "queued" ? { ...current, status: "failed" } : current;
					}),
				);
				this.pump();
			},
		);
	}
}
