import type { ArgsKey } from "./index.ts";

// A tool call's arguments as they stream: the model writes JSON, the provider parses what has arrived, and each
// parse is the last one with a string or two grown at the end. `argsAppends` says that growth as `args` ops; a
// change it can't say that way (a number arriving, a value rewritten) is a `replace` of the whole item.

/** Text appended to the string at `path` in a call's arguments. */
export type ArgsAppend = { readonly path: readonly ArgsKey[]; readonly append: string };

type Container = { [key: string]: unknown } | unknown[];

const isObject = (value: unknown): value is { [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The appends that turn `before` into `after`, or `undefined` when `after` isn't `before` with strings grown and
 * strings (and the objects and arrays that hold them) added. An empty list when nothing changed. An empty object or
 * array that holds no string yet (`"edits": [`) can't be said as an append: the caller replaces the item.
 */
export function argsAppends(before: unknown, after: unknown): ArgsAppend[] | undefined {
	const appends: ArgsAppend[] = [];
	return walk(before, after, [], appends) ? appends : undefined;
}

function walk(before: unknown, after: unknown, path: ArgsKey[], out: ArgsAppend[]): boolean {
	if (typeof after === "string") {
		const prior = before === undefined ? "" : before;
		if (typeof prior !== "string" || !after.startsWith(prior)) return false;
		// A new string is an append even when empty: the key has arrived and its value is on its way.
		if (after.length > prior.length || before === undefined) {
			out.push({ path: [...path], append: after.slice(prior.length) });
		}
		return true;
	}
	if (Array.isArray(after)) {
		const prior = before === undefined ? [] : before;
		if (!Array.isArray(prior) || prior.length > after.length) return false;
		// A new array must hold a string to be created by an append.
		if (before === undefined && after.length === 0) return false;
		for (let index = 0; index < after.length; index++) {
			if (!walk(prior[index], after[index], [...path, index], out)) return false;
		}
		return true;
	}
	if (isObject(after)) {
		const prior = before === undefined ? {} : before;
		if (!isObject(prior)) return false;
		for (const key of Object.keys(prior)) if (!(key in after)) return false;
		const keys = Object.keys(after);
		if (before === undefined && keys.length === 0) return false;
		for (const key of keys) if (!walk(prior[key], after[key], [...path, key], out)) return false;
		return true;
	}
	// Numbers, booleans and null only when they haven't changed.
	return before !== undefined && Object.is(before, after);
}

/**
 * `args` with `append` added to the string at `path`, copying only the objects on the way to it. A missing string
 * starts empty; missing containers are created, an array for a number key. `undefined` when the path runs into a
 * value that isn't a container or the leaf isn't a string.
 */
export function appendArgs(args: unknown, path: readonly ArgsKey[], append: string): unknown {
	if (path.length === 0) {
		if (args === undefined) return append;
		return typeof args === "string" ? args + append : undefined;
	}
	const [key, ...rest] = path as [ArgsKey, ...ArgsKey[]];
	let container: Container;
	if (args === undefined) container = typeof key === "number" ? [] : {};
	else if (typeof key === "number" && Array.isArray(args)) container = [...args];
	else if (typeof key === "string" && isObject(args)) container = { ...args };
	else return undefined;
	const child = appendArgs((container as { [key: string]: unknown })[key], rest, append);
	if (child === undefined) return undefined;
	(container as { [key: string]: unknown })[key] = child;
	return container;
}
