/**
 * Pi storage whose entry reads share their long strings with the entry the session already holds.
 *
 * A session holds each committed entry twice over: the object it wrote (which Pi's conversation view, the runtime's
 * projector and its stream keep) and, for the model context Pi's scheduler keeps per conversation, a copy parsed back
 * from SQL on the next read. A tool call's arguments or a tool result can be hundreds of kilobytes, so the parsed copy
 * doubles what a long session holds. `shareEntryStrings` keeps a weak reference to every entry it sees written or read
 * and, when the same entry is read again while one is still alive, gives the parsed record that entry's strings in
 * place of its own. Only strings are shared: the parsed objects stay the record's own (Pi freezes those it keeps),
 * strings are immutable, and a string is shared only where both hold the same text at the same place.
 */
import type { Storage } from "@earendil-works/pi-durable";

type EntryRecord = NonNullable<Awaited<ReturnType<Storage["entry"]>>>["entry"];

/** Strings shorter than this are cheaper to keep twice than to compare. */
const SHARED_MIN_LENGTH = 1024;

/** Dead references are swept when the map has grown to twice its size after the last sweep, and at least this many. */
const SWEEP_MIN = 256;

export function shareEntryStrings(storage: Storage): Storage {
	const held = new Map<number, WeakRef<EntryRecord>>();
	let sweepAt = SWEEP_MIN;
	const remember = (entry: EntryRecord) => {
		held.set(entry.id, new WeakRef(entry));
		if (held.size < sweepAt) return;
		for (const [id, ref] of held) if (ref.deref() === undefined) held.delete(id);
		sweepAt = Math.max(SWEEP_MIN, held.size * 2);
	};
	const share = (entry: EntryRecord): EntryRecord => {
		const original = held.get(entry.id)?.deref();
		if (original === undefined) remember(entry);
		else if (original !== entry) adoptStrings(entry, original);
		return entry;
	};
	const shared: Storage = {
		async commit(writes, context) {
			const seq = await storage.commit(writes, context);
			for (const write of writes) if (write.type === "entry") remember(write.value);
			return seq;
		},
		mintId: () => storage.mintId(),
		conversation: (id, context) => storage.conversation(id, context),
		scanConversations: (query, limit, cursor, context) => storage.scanConversations(query, limit, cursor, context),
		entry: (async (...args: unknown[]) => {
			const read = storage.entry as (...args: unknown[]) => ReturnType<Storage["entry"]>;
			const found = await read.apply(storage, args);
			if (found !== undefined) share(found.entry);
			return found;
		}) as Storage["entry"],
		async findLatestHeadMarker(conversationId, atOrBeforeEntryId, context) {
			const marker = await storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context);
			if (marker !== undefined) share(marker);
			return marker;
		},
		async scanEntries(query, limit, cursor, context) {
			const page = await storage.scanEntries(query, limit, cursor, context);
			for (const entry of page.items) share(entry);
			return page;
		},
		task: (id, context) => storage.task(id, context),
		scanTasks: (query, limit, cursor, context) => storage.scanTasks(query, limit, cursor, context),
		submission: (id, context) => storage.submission(id, context),
		scanSubmissions: (query, limit, cursor, context) => storage.scanSubmissions(query, limit, cursor, context),
		submissionByRequest: (conversationId, requestId, context) =>
			storage.submissionByRequest(conversationId, requestId, context),
		findDocument: (address, at, context) => storage.findDocument(address, at, context),
		document: (id, at, context) => storage.document(id, at, context),
		scanDocuments: (query, limit, cursor, context) => storage.scanDocuments(query, limit, cursor, context),
		close: (context) => storage.close(context),
	};
	return shared;
}

/**
 * Replace each long string in `target`, a freshly parsed record, with the equal string at the same place in `source`.
 * `target` is mutated, so it must not be frozen or held by anyone else yet.
 */
export function adoptStrings(target: unknown, source: unknown): void {
	if (target === null || typeof target !== "object" || source === null || typeof source !== "object") return;
	if (Object.isFrozen(target)) return;
	const into = target as Record<string, unknown>;
	const from = source as Record<string, unknown>;
	if (Array.isArray(into) !== Array.isArray(from)) return;
	for (const key of Object.keys(into)) {
		const value = into[key];
		const other = from[key];
		if (typeof value === "string") {
			if (value.length >= SHARED_MIN_LENGTH && other === value) into[key] = other;
		} else if (typeof value === "object" && value !== null) {
			adoptStrings(value, other);
		}
	}
}
