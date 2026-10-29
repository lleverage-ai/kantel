/**
 * The pieces of branching a session's history (`SessionBranching`) that need no runtime state: which conversation a
 * session shows, and copying one conversation's history into a new session's first conversation.
 *
 * A Harbour session is one Pi Durable Harness. Its transcript is the active conversation's: the root at first, and
 * after an edit a fork of it from just before the edited message (`Conversation.fork`), so the rewound history stays in
 * storage, unshown. Which one is active is a Session document, written in its own commit after the fork, so a session
 * reopened later shows the same one. A fork into a new session copies the entries instead: each session has its own
 * storage, and Pi forks only within one.
 */

import {
	type ContextEdit,
	type ConversationId,
	defineDoc,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	type Tx,
} from "@earendil-works/pi-durable";

/** The session's active conversation; absent (the default) means the root. */
export const ACTIVE_CONVERSATION = defineDoc<{ conversationId?: number }>({
	kind: "harbour.active-conversation",
	version: 1,
	scope: "session",
	initial: () => ({}),
	// One small value, rewritten whole on each edit.
	checkpointWhen: () => true,
});

/**
 * A forked session's skills (#210): the revisions its source pinned, as the source's `harbour.context` entry records
 * them, which the fork mounts on its first prompt in place of pinning its own. The fork's transcript carries the source's
 * listing, so its `/skills` must show the same revisions. `mounted` is set once the host has mounted them, so a fork
 * mounts once, and a failed mount is tried again on the next prompt. Absent (the default) on every other session.
 */
export const FORK_SKILLS = defineDoc<{
	skills?: { skillId: string; revision: number }[];
	mounted?: boolean;
}>({
	kind: "harbour.fork-skills",
	version: 1,
	scope: "session",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/**
 * Appends `entries` (one conversation's visible history, as `Conversation.context` gives it) to `conversationId`, in
 * the order they were written, inside the commit that creates it. Heads and context edits are pointed at the copies;
 * an edit of an entry not copied is left out. Tasks that wrote the originals don't exist here, so attribution goes.
 */
export async function copyEntries(
	tx: Tx,
	conversationId: ConversationId,
	entries: readonly EntryRecord[],
): Promise<void> {
	const copied = new Map<EntryId, EntryId>();
	for (const entry of [...entries].sort((left, right) => left.id - right.id)) {
		const head = entry.head === undefined ? undefined : entry.head === entry.id ? "self" : copied.get(entry.head);
		const edits = entry.edits
			?.map((edit): ContextEdit | undefined => {
				const target = copied.get(edit.target);
				return target === undefined ? undefined : { ...edit, target };
			})
			.filter((edit): edit is ContextEdit => edit !== undefined);
		const draft: EntryDraft = {
			kind: entry.kind,
			...(entry.model === undefined ? {} : { model: entry.model }),
			...(entry.data === undefined ? {} : { data: entry.data }),
			// A head the copy can't point at starts the context at the copy itself, as near as the copy can come.
			...(entry.head === undefined ? {} : { head: head ?? "self" }),
			...(edits === undefined || edits.length === 0 ? {} : { edits }),
		};
		const record = await tx.appendEntry(conversationId, draft);
		copied.set(entry.id, record.id);
	}
}

/** The visible entry just before `id`: where an edit of the message `id` forks from. `undefined` when it is the first. */
export function entryBefore(entries: readonly EntryRecord[], id: EntryId): EntryRecord | undefined {
	let before: EntryRecord | undefined;
	for (const entry of entries) {
		if (entry.id < id && (before === undefined || entry.id > before.id)) before = entry;
	}
	return before;
}
