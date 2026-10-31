/**
 * The console's browser storage keys were `harbour.*` before the rename and are `kantel.*` now: the
 * signed-in session, the sidebar, the sessions view, recent repositories, the preview's width and the debug switches.
 * `moveLegacyKeys` copies each `harbour.*` value this browser still has to its `kantel.*` key, unless that key is
 * already set, so nobody is signed out or loses a setting. The old keys stay, so a rollback finds them too.
 *
 * Not the theme (`harbour.theme`): its CSS uses the old token names, and `@kantel/ui`'s theme controller maps it.
 */

type KeyStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

const LEGACY_PREFIX = "harbour.";
const PREFIX = "kantel.";
const NOT_MOVED = new Set(["harbour.theme"]);

/** Copies every `harbour.*` key to its `kantel.*` key where that isn't set. Returns the new keys it wrote. */
export function moveLegacyKeys(storage: KeyStorage | undefined): string[] {
	if (storage === undefined) return [];
	const moved: string[] = [];
	try {
		const legacy: string[] = [];
		for (let index = 0; index < storage.length; index += 1) {
			const key = storage.key(index);
			if (key?.startsWith(LEGACY_PREFIX) === true && !NOT_MOVED.has(key)) legacy.push(key);
		}
		for (const key of legacy) {
			const next = PREFIX + key.slice(LEGACY_PREFIX.length);
			const value = storage.getItem(key);
			if (value === null || storage.getItem(next) !== null) continue;
			storage.setItem(next, value);
			moved.push(next);
		}
	} catch {
		// Storage that throws (private browsing, a full quota): the console starts as for a new visitor.
	}
	return moved;
}

const safely = (read: () => Storage): KeyStorage | undefined => {
	try {
		return read();
	} catch {
		return undefined;
	}
};

moveLegacyKeys(safely(() => globalThis.localStorage));
moveLegacyKeys(safely(() => globalThis.sessionStorage));
