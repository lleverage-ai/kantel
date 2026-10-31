// The API keys page as plain state and a small flow object with no React in it: the list, the form for a new key,
// the secret shown once, and revoking with a confirmation. Tested against the real identity handler
// (`@harbour/identity/http`); the page only renders what the flow says.
//
// The secret lives in the state only between the create call answering and the person pressing Done. Nothing else
// in the flow, and nothing the server sends later, ever holds it.

import {
	API_KEY_NAME_MAX_LENGTH,
	type ApiKey,
	type ApiKeyScope,
	authenticationFailureOf,
	type CreateApiKeyRequest,
	type HeldRole,
	type IssuedApiKey,
	isHarbourError,
	ORGANISATION_KEY_MAX_ROLE,
	type Role,
	roleSatisfies,
} from "@harbour/contracts";
import { compactAge, DAY } from "../primitives/format.ts";

/**
 * What the page calls: the identity client's `listApiKeys`, `createApiKey` and `revokeApiKey` fit. Failures reject
 * with its `HarbourError`s: `forbidden` (with an `invalid` authentication failure once signed out), `invalid`,
 * `not_found`, or anything else when Harbour can't answer.
 */
export interface ApiKeysApi {
	list(): Promise<readonly ApiKey[]>;
	create(input: CreateApiKeyRequest): Promise<IssuedApiKey>;
	revoke(keyId: string): Promise<void>;
}

/** A project a key can be issued for, by name. */
export interface KeyProject {
	readonly id: string;
	readonly name: string;
}

/**
 * The projects the caller may issue keys for: every one with `admin` across the organisation, else those it is admin
 * of (the roles `GET /v1/me` lists). Harbour lets only an admin of each of a key's projects issue, see or revoke it;
 * an operator reaches the page but administers none. With no roles known, every project, and Harbour decides.
 */
export function administeredProjects(
	projects: readonly KeyProject[],
	roles: readonly HeldRole[] | undefined,
): readonly KeyProject[] {
	if (roles === undefined) return projects;
	if (roles.some((held) => held.projectId === undefined && held.role === "admin")) return projects;
	const admin = new Set(roles.filter((held) => held.role === "admin").map((held) => held.projectId));
	return projects.filter((project) => admin.has(project.id));
}

/**
 * Whether the caller may issue an organisation key: an organisation-wide admin. With no roles known, yes, and Harbour
 * decides.
 */
export const mayIssueOrganisationKeys = (roles: readonly HeldRole[] | undefined): boolean =>
	roles === undefined || roles.some((held) => held.projectId === undefined && held.role === "admin");

/** The roles a key of `scope` may hold: an organisation key's are capped at `ORGANISATION_KEY_MAX_ROLE`. */
export const rolesForScope = (scope: ApiKeyScope, roles: readonly Role[]): readonly Role[] =>
	scope === "organisation" ? roles.filter((role) => roleSatisfies(ORGANISATION_KEY_MAX_ROLE, role)) : roles;

/** A key's scope: `projects` when it says none. */
export const keyScope = (key: Pick<ApiKey, "scope">): ApiKeyScope => key.scope ?? "projects";

/** Whether the key may create projects (`POST /v1/projects`). */
export const keyCreatesProjects = (key: Pick<ApiKey, "permissions">): boolean =>
	key.permissions?.includes("create_projects") ?? false;

export type KeyExpiry = "never" | "30d" | "90d" | "365d";

export const KEY_EXPIRY_DAYS: Readonly<Record<Exclude<KeyExpiry, "never">, number>> = {
	"30d": 30,
	"90d": 90,
	"365d": 365,
};

export interface KeyDraft {
	readonly name: string;
	/** `projects`: the key acts in `projectId`. `organisation`: in every project of the organisation. */
	readonly scope: ApiKeyScope;
	readonly projectId: string;
	readonly role: Role;
	readonly expiry: KeyExpiry;
	/** For an organisation key: it may create projects too. */
	readonly createProjects: boolean;
}

export type ApiKeysProblem =
	| { readonly kind: "signed-out" }
	| { readonly kind: "forbidden" }
	| { readonly kind: "not-found" }
	/** The server's own words, for a request it refused as malformed. */
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "unavailable" };

export interface ApiKeysState {
	/** Undefined until the first list arrives. */
	readonly keys?: readonly ApiKey[];
	readonly loading: boolean;
	readonly loadProblem?: ApiKeysProblem;
	/** The new key's form, while it is open. */
	readonly draft?: KeyDraft & {
		readonly busy: boolean;
		readonly nameError?: string;
		readonly problem?: ApiKeysProblem;
	};
	/** A key just issued, with its secret: shown once, until `dismissSecret`. */
	readonly issued?: IssuedApiKey;
	/** The key whose revocation is waiting for a confirmation. */
	readonly confirming?: string;
	/** The key being revoked. */
	readonly revoking?: string;
	readonly revokeProblem?: { readonly keyId: string; readonly problem: ApiKeysProblem };
}

export const initialApiKeys = (): ApiKeysState => ({ loading: true });

/** What a failed call means for the page. */
export function apiKeysProblem(error: unknown): ApiKeysProblem {
	if (authenticationFailureOf(error) === "invalid") return { kind: "signed-out" };
	if (isHarbourError(error, "forbidden")) return { kind: "forbidden" };
	if (isHarbourError(error, "not_found")) return { kind: "not-found" };
	if (isHarbourError(error, "invalid")) return { kind: "invalid", message: error.message };
	return { kind: "unavailable" };
}

/** Whether a key still signs calls in at `now`. */
export const keyIsActive = (key: ApiKey, now: number): boolean =>
	key.revokedAt === undefined && (key.expiresAt === undefined || key.expiresAt > now);

/** Active keys first, then revoked and expired ones; newest first within each. */
export function sortKeys(keys: readonly ApiKey[], now: number): { active: ApiKey[]; ended: ApiKey[] } {
	const newest = (a: ApiKey, b: ApiKey) => b.createdAt - a.createdAt;
	return {
		active: keys.filter((key) => keyIsActive(key, now)).sort(newest),
		ended: keys.filter((key) => !keyIsActive(key, now)).sort(newest),
	};
}

/** "4m ago", or "just now". */
export const ago = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

/** "Expires in 29d", "Expires in 5h", "Expired 2d ago", or "No expiry". */
export function expiryText(key: Pick<ApiKey, "expiresAt">, now: number): string {
	if (key.expiresAt === undefined) return "No expiry";
	if (key.expiresAt <= now) return `Expired ${ago(key.expiresAt, now)}`;
	const left = key.expiresAt - now;
	if (left >= DAY) return `Expires in ${Math.floor(left / DAY)}d`;
	const hours = Math.floor(left / 3_600_000);
	return hours >= 1 ? `Expires in ${hours}h` : `Expires in ${Math.max(1, Math.floor(left / 60_000))}m`;
}

/** "Last used 4m ago", or "Never used". */
export const lastUsedText = (key: Pick<ApiKey, "lastUsedAt">, now: number): string =>
	key.lastUsedAt === undefined ? "Never used" : `Last used ${ago(key.lastUsedAt, now)}`;

/** The start of the secret every key shows, so a person can match it with the one in a host's config. */
export const prefixText = (key: Pick<ApiKey, "prefix">): string => `${key.prefix}…`;

export const keyName = (key: Pick<ApiKey, "name">): string => key.name ?? "Unnamed key";

/** The request for a draft, or the name's error. */
export function draftRequest(
	draft: KeyDraft,
	now: number,
): { readonly request: CreateApiKeyRequest } | { readonly nameError: string } {
	const name = draft.name.trim();
	if (name === "") return { nameError: "Name the key after what will use it." };
	if (name.length > API_KEY_NAME_MAX_LENGTH) {
		return { nameError: `Keep the name to ${API_KEY_NAME_MAX_LENGTH} characters.` };
	}
	const expiry = draft.expiry === "never" ? {} : { expiresAt: now + KEY_EXPIRY_DAYS[draft.expiry] * DAY };
	if (draft.scope === "organisation") {
		return {
			request: {
				name,
				scope: "organisation",
				// Never stronger than the cap, whatever the draft held before its scope changed.
				role: roleSatisfies(ORGANISATION_KEY_MAX_ROLE, draft.role) ? draft.role : ORGANISATION_KEY_MAX_ROLE,
				...(draft.createProjects ? { permissions: ["create_projects"] } : {}),
				...expiry,
			},
		};
	}
	return { request: { name, projectIds: [draft.projectId], role: draft.role, ...expiry } };
}

export interface ApiKeysFlow {
	getState(): ApiKeysState;
	subscribe(listener: () => void): () => void;
	/** Reads the list again. */
	load(): Promise<void>;
	/**
	 * Opens the form for a new project key, for the first project unless one is given; with no project to pick, for an
	 * organisation key.
	 */
	openCreate(projectId?: string): void;
	editDraft(patch: Partial<KeyDraft>): void;
	cancelCreate(): void;
	/** Issues the draft's key and shows its secret. */
	create(): Promise<void>;
	/** Forgets the secret for good. */
	dismissSecret(): void;
	askRevoke(keyId: string): void;
	cancelRevoke(): void;
	/** Revokes the key waiting for confirmation. */
	revoke(): Promise<void>;
}

export interface ApiKeysFlowOptions {
	readonly api: ApiKeysApi;
	readonly projects: () => readonly KeyProject[];
	readonly now?: () => number;
	readonly initial?: ApiKeysState;
}

export function createApiKeysFlow(options: ApiKeysFlowOptions): ApiKeysFlow {
	const { api } = options;
	const now = options.now ?? Date.now;
	let state: ApiKeysState = options.initial ?? initialApiKeys();
	const listeners = new Set<() => void>();
	/** Only the latest list call lands, so a slow first read can't overwrite a later one. */
	let loads = 0;

	const set = (next: ApiKeysState) => {
		state = next;
		for (const listener of listeners) listener();
	};

	const without = (from: ApiKeysState, ...keys: readonly Exclude<keyof ApiKeysState, "loading">[]): ApiKeysState => {
		const copy: { -readonly [P in keyof ApiKeysState]: ApiKeysState[P] } = { ...from };
		for (const key of keys) delete copy[key];
		return copy;
	};

	const flow: ApiKeysFlow = {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		async load() {
			const call = ++loads;
			set({ ...without(state, "loadProblem"), loading: true });
			try {
				const keys = await api.list();
				if (call === loads) set({ ...without(state, "loadProblem"), keys, loading: false });
			} catch (error) {
				if (call === loads) set({ ...state, loading: false, loadProblem: apiKeysProblem(error) });
			}
		},

		openCreate(projectId) {
			if (state.draft !== undefined) return;
			const first = options.projects()[0];
			set({
				...without(state, "confirming"),
				draft: {
					name: "",
					scope: projectId === undefined && first === undefined ? "organisation" : "projects",
					projectId: projectId ?? first?.id ?? "",
					role: "operator",
					expiry: "never",
					createProjects: false,
					busy: false,
				},
			});
		},

		editDraft(patch) {
			const { draft } = state;
			if (draft === undefined || draft.busy) return;
			const { nameError, problem, ...rest } = draft;
			const next = { ...rest, ...patch };
			// An organisation key holds at most the cap: moving to that scope lowers a stronger role to it.
			const role =
				next.scope === "organisation" && !roleSatisfies(ORGANISATION_KEY_MAX_ROLE, next.role)
					? ORGANISATION_KEY_MAX_ROLE
					: next.role;
			set({
				...state,
				draft: { ...next, role, ...(patch.name === undefined && nameError ? { nameError } : {}) },
			});
		},

		cancelCreate() {
			if (state.draft?.busy) return;
			set(without(state, "draft"));
		},

		async create() {
			const { draft } = state;
			if (draft === undefined || draft.busy) return;
			const made = draftRequest(draft, now());
			if ("nameError" in made) {
				set({ ...state, draft: { ...draft, nameError: made.nameError } });
				return;
			}
			const { nameError, problem, ...rest } = draft;
			set({ ...state, draft: { ...rest, busy: true } });
			try {
				const issued = await api.create(made.request);
				const keys = [...(state.keys ?? []).filter((key) => key.id !== issued.key.id), issued.key];
				set({ ...without(state, "draft"), keys, issued });
			} catch (error) {
				const current = state.draft ?? rest;
				set({ ...state, draft: { ...current, busy: false, problem: apiKeysProblem(error) } });
				return;
			}
			// The server's list may hold changes from elsewhere; read it once the secret is on screen.
			void flow.load();
		},

		dismissSecret() {
			set(without(state, "issued"));
		},

		askRevoke(keyId) {
			if (state.revoking !== undefined) return;
			set({ ...without(state, "revokeProblem"), confirming: keyId });
		},

		cancelRevoke() {
			if (state.revoking !== undefined) return;
			set(without(state, "confirming"));
		},

		async revoke() {
			const keyId = state.confirming;
			if (keyId === undefined || state.revoking !== undefined) return;
			set({ ...without(state, "revokeProblem"), revoking: keyId });
			try {
				await api.revoke(keyId);
				const at = now();
				const keys = state.keys?.map((key) =>
					key.id === keyId && key.revokedAt === undefined ? { ...key, revokedAt: at } : key,
				);
				set({ ...without(state, "confirming", "revoking"), ...(keys === undefined ? {} : { keys }) });
			} catch (error) {
				set({ ...without(state, "revoking"), revokeProblem: { keyId, problem: apiKeysProblem(error) } });
				return;
			}
			void flow.load();
		},
	};
	return flow;
}
