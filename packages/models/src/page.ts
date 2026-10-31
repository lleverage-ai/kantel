import { KantelError, type Page, type PageRequest } from "@kantel/contracts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Every item, reading `list` page by page. */
export async function allPages<T>(list: (page: PageRequest) => Promise<Page<T>>): Promise<readonly T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await list({ limit: MAX_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return items;
}

/** One page of `items`, in the order given. The cursor is the offset of the next item, opaque to callers. */
export function pageOf<T>(items: readonly T[], page: PageRequest | undefined): Page<T> {
	const limit = Math.min(Math.max(1, Math.floor(page?.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	let offset = 0;
	if (page?.cursor !== undefined) {
		offset = Number(page.cursor);
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new KantelError("invalid", "The cursor is not one this API gave");
	}
	const slice = items.slice(offset, offset + limit);
	const next = offset + slice.length;
	return next < items.length ? { items: slice, nextCursor: String(next) } : { items: slice };
}
