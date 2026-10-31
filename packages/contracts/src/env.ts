/**
 * Kantel's environment variables were Harbour's: `KANTEL_HOSTNAME` was `HARBOUR_HOSTNAME`, and so on for every one.
 * A deployment, a Worker secret or an operator's `.env` set before the rename keeps working: each entry point reads
 * its environment through one of these, so a `KANTEL_*` name that isn't set takes the value of its `HARBOUR_*` name.
 * The new name wins whenever it is set, even to an empty string, so a deployment can override an old value.
 *
 * Only the prefix moves. Values are untouched: a key keeps its bytes, a hostname its name.
 */

/** Today's prefix. */
export const ENV_PREFIX = "KANTEL_";
/** The prefix before the rename (TASK-4231), still read as a fallback. */
export const LEGACY_ENV_PREFIX = "HARBOUR_";

/** The `KANTEL_*` values an environment holds only under their `HARBOUR_*` names. */
export function legacyEnvAliases(env: object): Record<string, unknown> {
	const record = env as Record<string, unknown>;
	const aliases: Record<string, unknown> = {};
	for (const key of Object.keys(record)) {
		if (!key.startsWith(LEGACY_ENV_PREFIX)) continue;
		const name = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
		if (record[name] === undefined && record[key] !== undefined) aliases[name] = record[key];
	}
	return aliases;
}

/** One copy per environment object: a Worker's `env` is the same object for every request in an isolate. */
const filled = new WeakMap<object, object>();

/**
 * `env` with every unset `KANTEL_*` filled in from `HARBOUR_*`: a Worker's or Durable Object's `env`, or any record of
 * settings. Returns `env` itself when nothing needs filling in, so bindings and identity are kept; otherwise a copy,
 * made once per `env` object.
 */
export function withKantelEnv<T extends object>(env: T): T {
	const cached = filled.get(env);
	if (cached !== undefined) return cached as T;
	const aliases = legacyEnvAliases(env);
	const result = Object.keys(aliases).length === 0 ? env : ({ ...env, ...aliases } as T);
	filled.set(env, result);
	return result;
}

/** The same, in place: for `process.env` at the top of a Node entry point, before anything reads it. */
export function applyKantelEnv(env: Record<string, string | undefined>): void {
	Object.assign(env, legacyEnvAliases(env));
}
