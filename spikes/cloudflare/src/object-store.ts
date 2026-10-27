/**
 * An in-memory `ObjectStore` with R2's conditional-put semantics (`etagMatches`; `etagDoesNotMatch`, with `"*"` for
 * create-only), for the conformance tests. The deployed spike passes its R2 bucket instead.
 */
import type { Conditional, ObjectStore, StoredObject } from "./workspace.ts";

export class MemoryObjectStore implements ObjectStore {
	readonly #objects = new Map<string, { etag: string; bytes: Uint8Array }>();
	#next = 0;
	/** Objects written so far, for tests that count round trips. */
	puts = 0;
	gets = 0;

	async get(key: string): Promise<StoredObject | null> {
		this.gets++;
		const object = this.#objects.get(key);
		if (object === undefined) return null;
		const bytes = object.bytes;
		return {
			etag: object.etag,
			text: async () => new TextDecoder().decode(bytes),
			arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
		};
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: { onlyIf?: Conditional },
	): Promise<{ etag: string } | null> {
		this.puts++;
		const existing = this.#objects.get(key);
		const onlyIf = options?.onlyIf;
		const notMatch = onlyIf?.etagDoesNotMatch;
		if (notMatch !== undefined && existing !== undefined && (notMatch === "*" || notMatch === existing.etag))
			return null;
		if (onlyIf?.etagMatches !== undefined && existing?.etag !== onlyIf.etagMatches) return null;
		const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
		const etag = `e${++this.#next}`;
		this.#objects.set(key, { etag, bytes });
		return { etag };
	}

	keys(): string[] {
		return [...this.#objects.keys()];
	}
}
