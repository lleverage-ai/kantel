/**
 * A small argument parser: `--flag value`, `--flag=value`, repeated flags collected in order, booleans (`--flag`,
 * `--flag=false`, `--no-flag`), one-letter aliases (`-h`), and `--`, after which everything is left as it is.
 */
import { UsageError } from "./errors.ts";

/** One flag a command takes. */
export interface FlagSpec {
	readonly type: "string" | "boolean";
	/** It may be given more than once; each value is kept, in order. */
	readonly multiple?: boolean;
	/** A one-letter alias, such as `h` for `-h`. */
	readonly short?: string;
	/** The value's placeholder in help, such as `<minutes>`. */
	readonly value?: string;
	readonly description: string;
	/** Left out of help, such as an alias of another flag. */
	readonly hidden?: boolean;
}

export interface FlagSpecs {
	readonly [name: string]: FlagSpec;
}

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
	readonly flags: { readonly [name: string]: FlagValue };
	readonly positionals: readonly string[];
	/** What followed `--`, or undefined when there was no `--`. */
	readonly rest: readonly string[] | undefined;
}

function booleanOf(name: string, inline: string | undefined): boolean {
	if (inline === undefined || inline === "true") return true;
	if (inline === "false") return false;
	throw new UsageError(`--${name} takes no value (or true or false), not "${inline}"`);
}

/** Parses `argv` against `specs`; an unknown flag or a missing value is a `UsageError`. */
export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
	const flags: { [name: string]: FlagValue } = {};
	const positionals: string[] = [];
	let rest: string[] | undefined;
	const shorts = new Map<string, string>();
	for (const [name, spec] of Object.entries(specs)) if (spec.short !== undefined) shorts.set(spec.short, name);

	const set = (name: string, spec: FlagSpec, value: string | boolean): void => {
		if (spec.multiple === true && typeof value === "string") {
			const previous = flags[name];
			flags[name] = [...(Array.isArray(previous) ? previous : []), value];
		} else flags[name] = value;
	};
	const valueAfter = (index: number, label: string): string => {
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) throw new UsageError(`${label} needs a value`);
		return next;
	};

	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (token === undefined) continue;
		if (token === "--") {
			rest = argv.slice(index + 1);
			break;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
			const inline = eq === -1 ? undefined : token.slice(eq + 1);
			const spec = specs[name];
			if (spec === undefined) {
				const positive = name.startsWith("no-") ? specs[name.slice(3)] : undefined;
				if (positive?.type === "boolean" && positive.multiple !== true && inline === undefined) {
					flags[name.slice(3)] = false;
					continue;
				}
				throw new UsageError(`unknown flag --${name}`);
			}
			if (spec.type === "boolean") {
				set(name, spec, booleanOf(name, inline));
				continue;
			}
			if (inline !== undefined) set(name, spec, inline);
			else {
				set(name, spec, valueAfter(index, `--${name}`));
				index++;
			}
			continue;
		}
		if (token.length > 1 && token.startsWith("-") && !/^-\d/.test(token)) {
			const name = shorts.get(token.slice(1));
			const spec = name === undefined ? undefined : specs[name];
			if (name === undefined || spec === undefined) throw new UsageError(`unknown flag ${token}`);
			if (spec.type === "boolean") set(name, spec, true);
			else {
				set(name, spec, valueAfter(index, token));
				index++;
			}
			continue;
		}
		positionals.push(token);
	}
	return { flags, positionals, rest };
}

/** A string flag's value: the last one given, or undefined. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
	const value = args.flags[name];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.at(-1);
	return undefined;
}

/** A boolean flag's value, or undefined when it wasn't given. */
export function booleanFlag(args: ParsedArgs, name: string): boolean | undefined {
	const value = args.flags[name];
	return typeof value === "boolean" ? value : undefined;
}

/** A repeatable flag's values, in order. */
export function listFlag(args: ParsedArgs, name: string): string[] {
	const value = args.flags[name];
	if (Array.isArray(value)) return value;
	return typeof value === "string" ? [value] : [];
}
