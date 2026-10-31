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
	INVITE_EMAIL_MAX_LENGTH,
	KantelError,
	MAX_LAST_MODEL_LENGTH,
	type ModelThinking,
	ORGANISATION_KEY_MAX_ROLE,
	type ProjectSettings,
	ROLES,
	type Role,
	roleSatisfies,
	THEME_PREFERENCE_PATTERN,
	type UserId,
	type UserPreferences,
} from "@kantel/contracts";

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
		throw new KantelError("invalid", "a key's name must not be empty");
	const trimmed = name.trim();
	if (trimmed.length > API_KEY_NAME_MAX_LENGTH) {
		throw new KantelError("invalid", `a key's name is at most ${API_KEY_NAME_MAX_LENGTH} characters`);
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
		throw new KantelError("invalid", `a key's permissions are a list of: ${API_KEY_PERMISSIONS.join(", ")}`);
	}
	const held = API_KEY_PERMISSIONS.filter((permission) => permissions.includes(permission));
	return held.length === 0 ? undefined : Object.freeze(held);
}

/** A key's scope as asked for: `projects` when absent. Rejects anything `API_KEY_SCOPES` doesn't name with `invalid`. */
export function apiKeyScope(scope: unknown): ApiKeyScope {
	if (scope === undefined) return "projects";
	if (!API_KEY_SCOPES.includes(scope as ApiKeyScope)) {
		throw new KantelError("invalid", `a key's scope is one of: ${API_KEY_SCOPES.join(", ")}`);
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
		if (input.projectIds.length === 0) throw new KantelError("invalid", "a key needs at least one project");
		if (input.permissions?.includes("create_projects")) {
			throw new KantelError("invalid", "only an organisation key may create projects");
		}
		return;
	}
	if (input.projectIds.length > 0) throw new KantelError("invalid", "an organisation key names no project");
	if (!roleSatisfies(ORGANISATION_KEY_MAX_ROLE, input.role)) {
		throw new KantelError("invalid", `an organisation key's role is at most ${ORGANISATION_KEY_MAX_ROLE}`);
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
	if (actor.kind !== "human") throw new KantelError("forbidden", "only a person has settings");
	return actor.userId;
}

const THINKING_LEVELS: readonly ModelThinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Each setting Kantel keeps, and the value it takes: `undefined` when the value is fine, else why it isn't. */
const PREFERENCE_CHECKS: { readonly [K in keyof Required<UserPreferences>]: (value: unknown) => string | undefined } = {
	theme: (value) =>
		typeof value === "string" && THEME_PREFERENCE_PATTERN.test(value) ? undefined : "A theme is a theme's ID or system",
	lastModel: (value) =>
		typeof value === "string" && value.trim() !== "" && value.length <= MAX_LAST_MODEL_LENGTH
			? undefined
			: `A model is a model's ID, at most ${MAX_LAST_MODEL_LENGTH} characters`,
	lastThinking: (value) =>
		(THINKING_LEVELS as readonly unknown[]).includes(value)
			? undefined
			: `A thinking level is one of ${THINKING_LEVELS.join(", ")}`,
};

const isPreference = (field: string): field is keyof UserPreferences => Object.hasOwn(PREFERENCE_CHECKS, field);

/** The settings a stored value holds: each field Kantel keeps with a value it takes. Anything else reads as unset. */
export function keptPreferences(stored: unknown): UserPreferences {
	if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
	const kept: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(stored)) {
		if (isPreference(field) && PREFERENCE_CHECKS[field](value) === undefined) kept[field] = value;
	}
	return kept as UserPreferences;
}

/**
 * `current` with `change` applied: a field left out stays, `null` clears it. Rejects a change that isn't an object, a
 * field Kantel doesn't keep, a theme that isn't a `THEME_PREFERENCE_PATTERN`, a last model that isn't a model ID or a
 * last thinking level that isn't one, with `invalid`.
 */
export function changedPreferences(current: UserPreferences, change: unknown): UserPreferences {
	if (typeof change !== "object" || change === null || Array.isArray(change)) {
		throw new KantelError("invalid", "A change to your settings is an object");
	}
	const next: { -readonly [K in keyof UserPreferences]: UserPreferences[K] } = { ...current };
	for (const [field, value] of Object.entries(change)) {
		if (!isPreference(field)) throw new KantelError("invalid", `There is no setting called ${field}`);
		if (value === null) {
			delete next[field];
			continue;
		}
		const problem = PREFERENCE_CHECKS[field](value);
		if (problem !== undefined) throw new KantelError("invalid", problem);
		(next as Record<string, unknown>)[field] = value;
	}
	return next;
}

/** Each project setting Kantel keeps, and the values it takes. */
const PROJECT_SETTINGS: { readonly [K in keyof Required<ProjectSettings>]: readonly ProjectSettings[K][] } = {
	browserGoalMode: ["on", "off"],
	browserDecisionModel: ["clef", "jev"],
};

/** A project's settings as kept, keeping only the ones Kantel knows, with values it knows: anything else is dropped. */
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
 * setting Kantel doesn't keep, or a value it doesn't take, with `invalid`.
 */
export function changedProjectSettings(current: ProjectSettings, change: unknown): ProjectSettings {
	if (typeof change !== "object" || change === null || Array.isArray(change)) {
		throw new KantelError("invalid", "A change to a project's settings is an object");
	}
	const next: { [key: string]: string } = { ...current };
	for (const [field, value] of Object.entries(change)) {
		const values = (PROJECT_SETTINGS as { readonly [key: string]: readonly string[] | undefined })[field];
		if (values === undefined || !Object.hasOwn(PROJECT_SETTINGS, field)) {
			throw new KantelError("invalid", `There is no project setting called ${field}`);
		}
		if (value === null) {
			delete next[field];
			continue;
		}
		if (typeof value !== "string" || !values.includes(value)) {
			throw new KantelError("invalid", `${field} is ${values.join(" or ")}`);
		}
		next[field] = value;
	}
	return next as ProjectSettings;
}

/**
 * An invite's email, trimmed, or an `invalid` error when it is not plausibly one address: something before and after
 * one last `@`, at most `INVITE_EMAIL_MAX_LENGTH` characters, and nothing a mail header would choke on.
 */
export function inviteEmail(email: unknown): string {
	if (typeof email !== "string") throw new KantelError("invalid", "email must be a string");
	const trimmed = email.trim();
	const at = trimmed.lastIndexOf("@");
	if (
		trimmed.length === 0 ||
		trimmed.length > INVITE_EMAIL_MAX_LENGTH ||
		at < 1 ||
		at === trimmed.length - 1 ||
		/[\s,;<>"]/.test(trimmed) ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
		/[\u0000-\u001f\u007f]/.test(trimmed)
	) {
		throw new KantelError("invalid", "email is not an email address");
	}
	return trimmed;
}

/** An invite's role, or an `invalid` error. */
export function inviteRole(role: unknown): Role {
	if (typeof role !== "string" || !ROLES.includes(role as Role)) {
		throw new KantelError("invalid", "role must be viewer, operator or admin");
	}
	return role as Role;
}

/** The name a person who joins by invite gets: the sign-in's name, or their email's local part. */
export function inviteeName(name: unknown, email: string): string {
	if (typeof name === "string" && name.trim() !== "") return name.trim();
	const local = email.slice(0, email.lastIndexOf("@")).trim();
	return local === "" ? email : local;
}
