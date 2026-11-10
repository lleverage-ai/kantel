/**
 * What a sandbox takes from its environments, which it has in order: where two set the same variable, secret file path
 * or repository path, the later one wins. Grants add up (deny wins in the proxy, so their order doesn't matter). Every
 * reader (a create, an attach or detach, a boot's egress, the host's protected values, the views) works it out here,
 * so the rule lives in one place.
 */
import type { computeSchema } from "@kantel/api";
import type { StoredEnvironment, StoredEnvironmentFile, StoredEnvironmentVariable, StoredSandbox } from "./store.ts";

/** At most this many environments on one sandbox. */
export const MAX_SANDBOX_ENVIRONMENTS = 10;

/** A sandbox's environments' IDs, in order: `environmentIds`, or the one `environmentId` of a sandbox made before. */
export const environmentIdsOf = (sandbox: Pick<StoredSandbox, "environmentIds" | "environmentId">): readonly string[] =>
	sandbox.environmentIds ?? (sandbox.environmentId === undefined ? [] : [sandbox.environmentId]);

/** The fields that record a sandbox's environments, both written: `environmentId` (the first) for older readers. */
export const environmentFields = (ids: readonly string[]): { environmentIds?: string[]; environmentId?: string } =>
	ids.length === 0
		? { environmentIds: undefined, environmentId: undefined }
		: { environmentIds: [...ids], environmentId: ids[0] };

export interface Winner<T> {
	readonly environment: StoredEnvironment;
	readonly item: T;
}

export interface EnvironmentResolution {
	/** Each variable's name, and the environment whose variable it takes. */
	readonly variables: ReadonlyMap<string, Winner<StoredEnvironmentVariable>>;
	/** Each secret file's path, and whose file is written there. */
	readonly files: ReadonlyMap<string, Winner<StoredEnvironmentFile>>;
	/** Each clone path, and whose repository is cloned there. */
	readonly repos: ReadonlyMap<string, Winner<computeSchema.EnvironmentRepo>>;
	/** Every environment's grants, in order. */
	readonly grants: readonly computeSchema.EgressGrant[];
}

/** Works out what `environments` (in order) give a sandbox. `repoPath` is where a repository is cloned. */
export function resolveEnvironments(
	environments: readonly StoredEnvironment[],
	repoPath: (repo: computeSchema.EnvironmentRepo) => string,
): EnvironmentResolution {
	const variables = new Map<string, Winner<StoredEnvironmentVariable>>();
	const files = new Map<string, Winner<StoredEnvironmentFile>>();
	const repos = new Map<string, Winner<computeSchema.EnvironmentRepo>>();
	const grants: computeSchema.EgressGrant[] = [];
	for (const environment of environments) {
		for (const item of environment.variables) variables.set(item.name, { environment, item });
		for (const item of environment.files) files.set(item.path, { environment, item });
		for (const item of environment.repos) repos.set(repoPath(item), { environment, item });
		grants.push(...environment.grants);
	}
	return { variables, files, repos, grants };
}

/**
 * The layers of a sandbox's env besides its environments: those it keeps, or, for a sandbox made before it kept them,
 * its env but its placeholders, under its environments.
 */
export function envLayersOf(
	sandbox: Pick<StoredSandbox, "envLayers" | "env" | "placeholders">,
): NonNullable<StoredSandbox["envLayers"]> {
	if (sandbox.envLayers !== undefined) return sandbox.envLayers;
	const placeholders = new Set(Object.values(sandbox.placeholders ?? {}));
	const base: { [name: string]: string } = {};
	for (const [name, value] of Object.entries(sandbox.env)) if (!placeholders.has(value)) base[name] = value;
	return { base, own: {} };
}

/**
 * A sandbox's env from its layers and environments: `base`, then each environment's plain values and placeholders in
 * order (later wins), then `own`. A protected variable with no placeholder in `placeholders` gets one from `mint`, which
 * the answer's `placeholders` holds with the ones it had (kept, so a variable's placeholder never changes).
 */
export function composeEnv(
	layers: NonNullable<StoredSandbox["envLayers"]>,
	resolution: EnvironmentResolution,
	placeholders: { readonly [name: string]: string },
	mint: () => string,
): { env: { [name: string]: string }; placeholders: { [name: string]: string } } {
	const env: { [name: string]: string } = { ...layers.base };
	const kept: { [name: string]: string } = { ...placeholders };
	for (const [name, { item }] of resolution.variables) {
		if (item.protected) {
			kept[name] ??= mint();
			env[name] = kept[name];
		} else if (item.value !== undefined) env[name] = item.value;
	}
	Object.assign(env, layers.own);
	return { env, placeholders: kept };
}

/** The names of `own` that would hide a protected variable of the environments: refused, as at create. */
export const protectedClashes = (
	own: { readonly [name: string]: string },
	resolution: EnvironmentResolution,
): string[] => Object.keys(own).filter((name) => resolution.variables.get(name)?.item.protected === true);

/**
 * The protected variables a sandbox has: the winning variable of each name its env carries its own placeholder for,
 * protected and with a value. One shadowed by a plain variable, or by its own env, isn't: its placeholder isn't in the
 * sandbox's env, and nothing swaps it.
 */
export function protectedWinners(
	sandbox: Pick<StoredSandbox, "env" | "placeholders">,
	resolution: EnvironmentResolution,
): { name: string; placeholder: string; winner: Winner<StoredEnvironmentVariable> }[] {
	const out: { name: string; placeholder: string; winner: Winner<StoredEnvironmentVariable> }[] = [];
	for (const [name, placeholder] of Object.entries(sandbox.placeholders ?? {})) {
		const winner = resolution.variables.get(name);
		if (winner === undefined || !winner.item.protected || winner.item.sealed === undefined) continue;
		if (sandbox.env[name] !== placeholder) continue;
		out.push({ name, placeholder, winner });
	}
	return out;
}

/**
 * The version a sandbox's protected values are answered at: its environments' newest, or its floor (moved on by a
 * detach or a delete) when that is later. Versions are times that only move on, so the greatest is the newest.
 */
export const secretsVersionOf = (
	environments: readonly StoredEnvironment[],
	floor: number | undefined,
): number | undefined => {
	const versions = [
		...environments.map((environment) => environment.secretsVersion),
		...(floor === undefined ? [] : [floor]),
	];
	return versions.length === 0 ? undefined : Math.max(...versions);
};

/** What of each environment a sandbox doesn't take from it, for the view. */
export function shadowedOf(
	environment: StoredEnvironment,
	resolution: EnvironmentResolution,
	own: { readonly [name: string]: string },
	repoPath: (repo: computeSchema.EnvironmentRepo) => string,
): computeSchema.SandboxEnvironment["shadowed"] {
	return {
		variables: environment.variables
			.map((variable) => variable.name)
			.filter((name) => resolution.variables.get(name)?.environment.id !== environment.id || name in own),
		files: environment.files
			.map((file) => file.path)
			.filter((path) => resolution.files.get(path)?.environment.id !== environment.id),
		repos: environment.repos
			.map(repoPath)
			.filter((path) => resolution.repos.get(path)?.environment.id !== environment.id),
	};
}
