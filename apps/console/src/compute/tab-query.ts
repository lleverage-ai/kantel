// What a new tab of the console needs in its address to show what this one does. A screen's page opens in a new tab
// from a link without its opener, and such a tab starts with none of this tab's session storage: the data source
// (`?source=`, main.tsx) and the hosting (`?hosting=`) this tab keeps there.

/** Where main.tsx keeps the data source a tab asked for (`?source=`). */
export const SOURCE_KEY = "kantel.console.source";
/** Where the compute app keeps the hosting a tab asked for (`?hosting=`). */
export const HOSTING_KEY = "kantel.compute.hosting";

/** This tab's session storage, or none where it can't be read (storage blocked). */
export function safeSession(): Pick<Storage, "getItem"> | undefined {
	try {
		return sessionStorage;
	} catch {
		return undefined;
	}
}

/**
 * The query for a new tab: the source and hosting this tab keeps in `session`, the hosting `search` asks for when it
 * keeps none, and the sample data `?data=` asked for. Empty when this tab shows the defaults.
 */
export function tabQueryOf(search: string, session: Pick<Storage, "getItem"> | undefined): string {
	const asked = new URLSearchParams(search);
	const kept = (key: string): string | undefined => {
		try {
			return session?.getItem(key) ?? undefined;
		} catch {
			return undefined;
		}
	};
	const params = new URLSearchParams();
	const source = kept(SOURCE_KEY);
	if (source === "api" || source === "recorded") params.set("source", source);
	const hosting = kept(HOSTING_KEY) ?? asked.get("hosting");
	if (hosting === "hosted" || hosting === "self-hosted") params.set("hosting", hosting);
	const data = asked.get("data");
	if (data === "sample" || data === "empty") params.set("data", data);
	return params.toString();
}
