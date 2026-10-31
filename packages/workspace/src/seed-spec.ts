/**
 * Seed spec v1 as a declarative file: `parseSeedSpec` checks a spec's shape, as read from a host app's or project's
 * `seed.json` (or a request body), and returns it typed. Every reader (the write API, a host loading its file, the
 * conformance suite) parses through here, so a spec means the same everywhere.
 *
 * It checks shape only. Paths are `create`'s to normalise (an `into` outside the workspace, a sparse directory with
 * `..`), so its rules hold whoever calls it; what a host can fetch is its seeders' to say.
 */
import {
	type ArchiveSeedSource,
	type GitSeedSource,
	KantelError,
	type MountRequest,
	type SandboxTier,
	type SeedDependencyStep,
	type SeedMethod,
	type SeedSource,
	type SeedSpec,
} from "@kantel/contracts";

/** The most sources one seed may name. */
export const MAX_SEED_SOURCES = 64;
/** The most dependency steps one seed may name. */
export const MAX_SEED_DEPS = 16;

const METHODS: readonly SeedMethod[] = ["snapshot", "mirror", "overlay", "archive", "clone", "lazy"];
const TIERS: readonly SandboxTier[] = ["isolate", "container"];
const PREPARE = ["on-change", "never", "eager"] as const;
const HYDRATION = ["lazy", "eager"] as const;

/** A spec from parsed JSON; `name` prefixes every message (`seed` by default). Rejects with `invalid`. */
export function parseSeedSpec(value: unknown, name = "seed"): SeedSpec {
	if (!isRecord(value)) throw invalid(`${name} must be an object`);
	if (value.version !== undefined && value.version !== 1) throw invalid(`${name}.version must be 1 when present`);
	const spec: { -readonly [key in keyof SeedSpec]: SeedSpec[key] } = {
		name: nonEmpty(value.name, `${name}.name`),
		sources: list(value.sources, `${name}.sources`, MAX_SEED_SOURCES).map((source, index) =>
			parseSource(source, `${name}.sources[${index}]`),
		),
	};
	if (value.version === 1) spec.version = 1;
	if (value.deps !== undefined) {
		spec.deps = list(value.deps, `${name}.deps`, MAX_SEED_DEPS).map((step, index) =>
			parseStep(step, `${name}.deps[${index}]`),
		);
	}
	if (value.mounts !== undefined) spec.mounts = parseMountRequests(value.mounts, `${name}.mounts`);
	if (value.tier !== undefined) spec.tier = oneOf(value.tier, TIERS, `${name}.tier`);
	if (value.size !== undefined) spec.size = nonEmpty(value.size, `${name}.size`);
	if (value.methods !== undefined) {
		const methods = list(value.methods, `${name}.methods`, METHODS.length).map((method, index) =>
			oneOf(method, METHODS, `${name}.methods[${index}]`),
		);
		if (new Set(methods).size !== methods.length) throw invalid(`${name}.methods must not repeat a method`);
		spec.methods = methods;
	}
	if (value.prepare !== undefined) spec.prepare = oneOf(value.prepare, PREPARE, `${name}.prepare`);
	if (value.staleWithin !== undefined) spec.staleWithin = count(value.staleWithin, `${name}.staleWithin`);
	if (value.hydration !== undefined) spec.hydration = oneOf(value.hydration, HYDRATION, `${name}.hydration`);
	return spec;
}

/** Mount requests, as a seed or a create body carries them. */
export function parseMountRequests(value: unknown, name: string): readonly MountRequest[] {
	return list(value, name).map((mount, index) => {
		const at = `${name}[${index}]`;
		if (!isRecord(mount)) throw invalid(`${at} must be an object`);
		const version = optionalString(mount.version, `${at}.version`);
		return {
			path: nonEmpty(mount.path, `${at}.path`),
			source: nonEmpty(mount.source, `${at}.source`),
			ref: nonEmpty(mount.ref, `${at}.ref`),
			...(version === undefined ? {} : { version }),
		};
	});
}

function parseSource(value: unknown, name: string): SeedSource {
	if (!isRecord(value)) throw invalid(`${name} must be an object`);
	switch (value.kind) {
		case "files": {
			if (!isRecord(value.files)) throw invalid(`${name}.files must be an object of path to text`);
			for (const [path, content] of Object.entries(value.files)) {
				if (typeof content !== "string") throw invalid(`${name}.files[${JSON.stringify(path)}] must be text`);
			}
			return { kind: "files", files: value.files as Record<string, string> };
		}
		case "git": {
			const source: { -readonly [key in keyof GitSeedSource]: GitSeedSource[key] } = {
				kind: "git",
				repo: nonEmpty(value.repo, `${name}.repo`),
				ref: nonEmpty(value.ref, `${name}.ref`),
			};
			const commit = optionalString(value.commit, `${name}.commit`);
			if (commit !== undefined) {
				if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw invalid(`${name}.commit must be a full commit ID`);
				source.commit = commit;
			}
			const sparse = stringList(value.sparse, `${name}.sparse`);
			if (sparse !== undefined) source.sparse = sparse;
			const into = optionalPath(value.into, `${name}.into`);
			if (into !== undefined) source.into = into;
			if (value.history !== undefined) source.history = count(value.history, `${name}.history`);
			return source;
		}
		case "objects": {
			const into = optionalPath(value.into, `${name}.into`);
			return {
				kind: "objects",
				prefix: nonEmpty(value.prefix, `${name}.prefix`),
				...(into === undefined ? {} : { into }),
			};
		}
		case "archive": {
			const url = nonEmpty(value.url, `${name}.url`);
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				throw invalid(`${name}.url must be a URL`);
			}
			if (parsed.protocol !== "https:") throw invalid(`${name}.url must be an https: URL`);
			if (parsed.username !== "" || parsed.password !== "") {
				throw invalid(`${name}.url must not carry credentials; the host's egress adds them`);
			}
			const source: { -readonly [key in keyof ArchiveSeedSource]: ArchiveSeedSource[key] } = { kind: "archive", url };
			const digest = optionalString(value.digest, `${name}.digest`);
			if (digest !== undefined) {
				if (!/^[0-9a-f]{64}$/.test(digest)) throw invalid(`${name}.digest must be a hex sha256`);
				source.digest = digest;
			}
			if (value.strip !== undefined) source.strip = count(value.strip, `${name}.strip`);
			const into = optionalPath(value.into, `${name}.into`);
			if (into !== undefined) source.into = into;
			return source;
		}
		default:
			throw invalid(`${name}.kind must be files, git, objects or archive`);
	}
}

function parseStep(value: unknown, name: string): SeedDependencyStep {
	if (!isRecord(value)) throw invalid(`${name} must be an object`);
	const step: { -readonly [key in keyof SeedDependencyStep]: SeedDependencyStep[key] } = {
		run: nonEmpty(value.run, `${name}.run`),
		key: stringList(value.key, `${name}.key`) ?? throwInvalid(`${name}.key must be a list of non-empty strings`),
	};
	if (step.key.length === 0) throw invalid(`${name}.key must name at least one file or label`);
	const stepName = optionalString(value.name, `${name}.name`);
	if (stepName !== undefined) step.name = stepName;
	const outputs = stringList(value.outputs, `${name}.outputs`);
	if (outputs !== undefined) step.outputs = outputs;
	if (value.tier !== undefined) step.tier = oneOf(value.tier, TIERS, `${name}.tier`);
	return step;
}

const invalid = (message: string): KantelError => new KantelError("invalid", message);

function throwInvalid(message: string): never {
	throw invalid(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(value: unknown, name: string, max?: number): readonly unknown[] {
	if (!Array.isArray(value)) throw invalid(`${name} must be a list`);
	if (max !== undefined && value.length > max) throw invalid(`${name} has at most ${max} entries`);
	return value;
}

function nonEmpty(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw invalid(`${name} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return nonEmpty(value, name);
}

/** `into` may be `""` (the root); its normalisation is `create`'s. */
function optionalPath(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw invalid(`${name} must be a string`);
	return value;
}

function stringList(value: unknown, name: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
		throw invalid(`${name} must be a list of non-empty strings`);
	}
	return value as string[];
}

function count(value: unknown, name: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) throw invalid(`${name} must be a non-negative integer`);
	return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw invalid(`${name} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}
