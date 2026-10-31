/**
 * Portable identity helpers shared by every `IdentityDirectory` target: API key secrets, their prefixes and hashes,
 * and role ordering. Uses only WebCrypto and other globals, so it runs on Workers, Bun and Node.
 */
import {
	type Actor,
	API_KEY_LAST_USED_PRECISION_MS,
	API_KEY_NAME_MAX_LENGTH,
	API_KEY_PERMISSIONS,
	API_KEY_SCOPES,
	type ApiKey,
	type ApiKeyPermission,
	type ApiKeyScope,
	HarbourError,
	ORGANISATION_KEY_MAX_ROLE,
	type ProjectSettings,
	ROLES,
	type Role,
	roleSatisfies,
	THEME_PREFERENCE_PATTERN,
	type UserId,
	type UserPreferences,
} from "@harbour/contracts";

/** Every API key secret starts with this, so leaked keys are easy to spot and scan for. */
export const API_KEY_SECRET_PREFIX = "hbr_";

/** How many characters of a secret are kept as its displayable prefix. */
export const API_KEY_PREFIX_LENGTH = 12;

const API_KEY_RANDOM_BYTES = 32;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh API key secret: `hbr_` followed by 32 random bytes in unpadded base64url. */
export function generateApiKeySecret(): string {
	const bytes = new Uint8Array(API_KEY_RANDOM_BYTES);
	crypto.getRandomValues(bytes);
	return `${API_KEY_SECRET_PREFIX}${base64url(bytes)}`;
}

/** The part of a secret that may be stored and shown: its first 12 characters. */
export function apiKeyPrefix(secret: string): string {
	return secret.slice(0, API_KEY_PREFIX_LENGTH);
}

/** The lowercase hex SHA-256 of a secret; what a directory stores and looks keys up by. */
export async function hashApiKeySecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** The strongest of `roles`, or undefined when there are none. */
export function strongestRole(roles: Iterable<Role>): Role | undefined {
	let strongest: Role | undefined;
	for (const role of roles) {
		if (strongest === undefined || ROLES.indexOf(role) > ROLES.indexOf(strongest)) strongest = role;
	}
	return strongest;
}

/**
 * An API key's name as issued: trimmed, or undefined when none was given. Rejects with `invalid` one that is not a
 * string, is empty once trimmed or is longer than `API_KEY_NAME_MAX_LENGTH`.
 */
export function apiKeyName(name: unknown): string | undefined {
	if (name === undefined) return undefined;
	if (typeof name !== "string" || name.trim() === "")
		throw new HarbourError("invalid", "a key's name must not be empty");
	const trimmed = name.trim();
	if (trimmed.length > API_KEY_NAME_MAX_LENGTH) {
		throw new HarbourError("invalid", `a key's name is at most ${API_KEY_NAME_MAX_LENGTH} characters`);
	}
	return trimmed;
}

/**
 * An API key's permissions as issued: each once, in `API_KEY_PERMISSIONS`' order, or undefined when there are none.
 * Rejects with `invalid` anything but a list of the permissions that constant names.
 */
export function apiKeyPermissions(permissions: unknown): readonly ApiKeyPermission[] | undefined {
	if (permissions === undefined) return undefined;
	if (
		!Array.isArray(permissions) ||
		!permissions.every((permission) => (API_KEY_PERMISSIONS as readonly unknown[]).includes(permission))
	) {
		throw new HarbourError("invalid", `a key's permissions are a list of: ${API_KEY_PERMISSIONS.join(", ")}`);
	}
	const held = API_KEY_PERMISSIONS.filter((permission) => permissions.includes(permission));
	return held.length === 0 ? undefined : Object.freeze(held);
}

/** A key's scope as asked for: `projects` when absent. Rejects anything `API_KEY_SCOPES` doesn't name with `invalid`. */
export function apiKeyScope(scope: unknown): ApiKeyScope {
	if (scope === undefined) return "projects";
	if (!API_KEY_SCOPES.includes(scope as ApiKeyScope)) {
		throw new HarbourError("invalid", `a key's scope is one of: ${API_KEY_SCOPES.join(", ")}`);
	}
	return scope as ApiKeyScope;
}

/**
 * Checks a new key's projects, role and permissions against its scope, as every directory's `issueApiKey` does, with
 * `invalid`: a `projects` key names at least one project and never carries `create_projects`; an `organisation` key
 * names none and holds at most `ORGANISATION_KEY_MAX_ROLE`.
 */
export function checkApiKeyScope(
	scope: ApiKeyScope,
	input: {
		readonly projectIds: readonly unknown[];
		readonly role: Role;
		readonly permissions: readonly ApiKeyPermission[] | undefined;
	},
): void {
	if (scope === "projects") {
		if (input.projectIds.length === 0) throw new HarbourError("invalid", "a key needs at least one project");
		if (input.permissions?.includes("create_projects")) {
			throw new HarbourError("invalid", "only an organisation key may create projects");
		}
		return;
	}
	if (input.projectIds.length > 0) throw new HarbourError("invalid", "an organisation key names no project");
	if (!roleSatisfies(ORGANISATION_KEY_MAX_ROLE, input.role)) {
		throw new HarbourError("invalid", `an organisation key's role is at most ${ORGANISATION_KEY_MAX_ROLE}`);
	}
}

/** Whether the actor calls with an API key: a key never issues an organisation key. */
export const callsWithKey = (actor: Actor): boolean => actor.kind === "service" && actor.keyId !== undefined;

/** A key's scope, `projects` when the record has none. */
export const scopeOfKey = (key: Pick<ApiKey, "scope">): ApiKeyScope => key.scope ?? "projects";

/** Whether a use at `now` should be recorded over `recorded`: none yet, or one older than the precision. */
export function lastUsedIsStale(recorded: number | undefined, now: number): boolean {
	return recorded === undefined || now - recorded >= API_KEY_LAST_USED_PRECISION_MS;
}

/** The person whose settings a call reads or changes: only a person has any, so any other actor is `forbidden`. */
export function preferencesOwner(actor: Actor): UserId {
	if (actor.kind !== "human") throw new HarbourError("forbidden", "only a person has settings");
	return actor.userId;
}

/**
 * `current` with `change` applied: a field left out stays, `null` clears it. Rejects a change that isn't an object, a
 * field Harbour doesn't keep, or a theme that isn't a `THEME_PREFERENCE_PATTERN`, with `invalid`.
 */
export function changedPreferences(current: UserPreferences, change: unknown): UserPreferences {
	if (typeof change !== "object" || change === null || Array.isArray(change)) {
		throw new HarbourError("invalid", "A change to your settings is an object");
	}
	const next: { theme?: string } = { ...current };
	for (const [field, value] of Object.entries(change)) {
		if (field !== "theme") throw new HarbourError("invalid", `There is no setting called ${field}`);
		if (value === null) {
			delete next.theme;
			continue;
		}
		if (typeof value !== "string" || !THEME_PREFERENCE_PATTERN.test(value)) {
			throw new HarbourError("invalid", "A theme is a theme's ID or system");
		}
		next.theme = value;
	}
	return next;
}

/** Each project setting Harbour keeps, and the values it takes. */
const PROJECT_SETTINGS: { readonly [K in keyof Required<ProjectSettings>]: readonly ProjectSettings[K][] } = {
	browserGoalMode: ["on", "off"],
	browserDecisionModel: ["clef", "jev"],
};

/** A project's settings as kept, keeping only the ones Harbour knows, with values it knows: anything else is dropped. */
export function knownProjectSettings(kept: unknown): ProjectSettings {
	if (typeof kept !== "object" || kept === null || Array.isArray(kept)) return {};
	const next: { -readonly [K in keyof ProjectSettings]: ProjectSettings[K] } = {};
	for (const [field, values] of Object.entries(PROJECT_SETTINGS) as [keyof ProjectSettings, readonly string[]][]) {
		const value = (kept as { readonly [key: string]: unknown })[field];
		if (typeof value === "string" && values.includes(value)) (next as { [key: string]: string })[field] = value;
	}
	return next;
}

/**
 * `current` with `change` applied: a field left out stays, `null` clears it. Rejects a change that isn't an object, a
 * setting Harbour doesn't keep, or a value it doesn't take, with `invalid`.
 */
export function changedProjectSettings(current: ProjectSettings, change: unknown): ProjectSettings {
	if (typeof change !== "object" || change === null || Array.isArray(change)) {
		throw new HarbourError("invalid", "A change to a project's settings is an object");
	}
	const next: { [key: string]: string } = { ...current };
	for (const [field, value] of Object.entries(change)) {
		const values = (PROJECT_SETTINGS as { readonly [key: string]: readonly string[] | undefined })[field];
		if (values === undefined || !Object.hasOwn(PROJECT_SETTINGS, field)) {
			throw new HarbourError("invalid", `There is no project setting called ${field}`);
		}
		if (value === null) {
			delete next[field];
			continue;
		}
		if (typeof value !== "string" || !values.includes(value)) {
			throw new HarbourError("invalid", `${field} is ${values.join(" or ")}`);
		}
		next[field] = value;
	}
	return next as ProjectSettings;
}
