/* The rules the Sandboxes page's selection and bulk actions keep, apart from React so they can be tested alone. */

/**
 * Each sandbox's changes made on the page, counted. An answer that took a while (one of a bulk stop) applies only if
 * nothing changed its sandbox after it was asked: a later stop, resume or delete wins, and a deleted one stays deleted.
 */
export class ChangeCounter {
	readonly #counts = new Map<string, number>();

	/** What to hand back to `take` when the answer comes. */
	ask(id: string): number {
		return this.#counts.get(id) ?? 0;
	}

	/** Whether a change applies, counting it if so: always for one with no `asked`, else only if nothing came after. */
	take(id: string, asked?: number): boolean {
		const count = this.#counts.get(id) ?? 0;
		if (asked !== undefined && asked !== count) return false;
		this.#counts.set(id, count + 1);
		return true;
	}
}

/**
 * What the list does with a change's answer: shows it unless a later change came first, and reads the list again
 * either way (a new sandbox's placeholder apart), so an answer overtaken by another still ends with what's there now.
 */
export function changeTaken(
	changes: ChangeCounter,
	id: string,
	asked?: number,
): { readonly show: boolean; readonly reload: boolean } {
	return { show: changes.take(id, asked), reload: !id.startsWith("pending_") };
}

/** The ticked IDs still shown: one a search, a filter or a delete hides is dropped, not kept for when it's back. */
export function keepShown(ticked: ReadonlySet<string>, shown: Iterable<string>): ReadonlySet<string> {
	const showing = new Set(shown);
	const kept = new Set([...ticked].filter((id) => showing.has(id)));
	return kept.size === ticked.size ? ticked : kept;
}

/** A bulk action's targets left after an attempt: only those that failed, so trying again doesn't repeat the rest. */
export function stillToDo<T>(targets: readonly T[], results: readonly PromiseSettledResult<unknown>[]): T[] {
	return targets.filter((_, at) => results[at]?.status === "rejected");
}

/**
 * What a confirmation asks about once an attempt on `attempted` has settled: the ones that failed, if it is still
 * asking about `attempted`; otherwise whatever it asks now. A confirmation closed while its attempt ran stays closed,
 * and one opened since keeps its own targets.
 */
export function retryTargets<T>(
	current: readonly T[] | undefined,
	attempted: readonly T[],
	results: readonly PromiseSettledResult<unknown>[],
): readonly T[] | undefined {
	return current === attempted ? stillToDo(attempted, results) : current;
}
