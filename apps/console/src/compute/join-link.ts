// An invite email's link, `<console>/organisation#join=kji_…`: the console takes the code out of the address and keeps it
// for the tab, so it waits through signing in (or signing out, to sign in as the person the invite was made for), and
// then opens Join with it. The code is in the fragment, which a browser never sends, so no request log has it; once
// kept, the address loses it too, so it isn't left in the history or a copied link.

const KEY = "kantel.console.join";

/** The code an invite link carries in its fragment (`#join=kji_…`), or undefined. */
export function joinCodeOf(hash: string): string | undefined {
	const match = /^#join=([^&]+)$/.exec(hash);
	if (match?.[1] === undefined) return undefined;
	try {
		const code = decodeURIComponent(match[1]).trim();
		return code === "" ? undefined : code;
	} catch {
		return undefined;
	}
}

export interface JoinLink {
	/** Keeps the code `hash` carries, if any; whether it did, so the caller can take it out of the address. */
	take(hash: string): boolean;
	/** The code waiting for Join, if any. */
	pending(): string | undefined;
	/** Join is done with it, joined or closed. */
	forget(): void;
}

/** A join link kept in `storage` (the tab's), or for the page only where there is none (a private window). */
export function createJoinLink(storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">): JoinLink {
	let page: string | undefined;
	return {
		take(hash) {
			const code = joinCodeOf(hash);
			if (code === undefined) return false;
			page = code;
			try {
				storage().setItem(KEY, code);
			} catch {
				// No storage: it waits for this page only.
			}
			return true;
		},
		pending() {
			try {
				return storage().getItem(KEY) ?? page;
			} catch {
				return page;
			}
		},
		forget() {
			page = undefined;
			try {
				storage().removeItem(KEY);
			} catch {
				// Nothing kept.
			}
		},
	};
}
