// The members page as plain state and a small flow object with no React in it: the organisation's people, and an
// admin resetting one person's passkeys with a confirmation (#132). Tested against the real identity and passkey
// handlers; the page only renders what the flow says.
//
// A reset removes every passkey the person has, so they can enrol a new one on their sign-in alone. Harbour lets only
// a person with the organisation's admin role do it, and audits it as `identity.passkey.reset`.

import { authenticationFailureOf, isHarbourError } from "@harbour/contracts";

/** A person in the organisation, as `GET /v1/members` names them. */
export interface MemberRow {
	readonly userId: string;
	readonly name: string;
}

/**
 * What the page calls: the identity client's `members` and the passkey client's `reset` fit. Failures reject with
 * their `HarbourError`s: `forbidden` (with an `invalid` authentication failure once signed out), `not_found`,
 * `not_supported` when the deployment has no passkeys, or anything else when Harbour can't answer.
 */
export interface MembersApi {
	list(): Promise<readonly MemberRow[]>;
	/** `POST /v1/members/:userId/passkeys/reset`: how many passkeys were removed. */
	resetPasskeys(userId: string): Promise<{ readonly removed: number }>;
}

export type MembersProblem =
	| { readonly kind: "signed-out" }
	| { readonly kind: "forbidden" }
	| { readonly kind: "not-found" }
	| { readonly kind: "not-supported" }
	| { readonly kind: "unavailable" };

export interface MembersState {
	/** Undefined until the first list arrives. */
	readonly members?: readonly MemberRow[];
	readonly loading: boolean;
	readonly loadProblem?: MembersProblem;
	/** The person whose reset is being confirmed. */
	readonly confirming?: string;
	/** The person whose passkeys are being reset. */
	readonly resetting?: string;
	readonly resetProblem?: { readonly userId: string; readonly problem: MembersProblem };
	/** The last reset that went through, until another is asked for. */
	readonly done?: { readonly userId: string; readonly removed: number };
}

export const initialMembers = (): MembersState => ({ loading: true });

/** What a failed call means for the page. */
export function membersProblem(error: unknown): MembersProblem {
	if (authenticationFailureOf(error) === "invalid") return { kind: "signed-out" };
	if (isHarbourError(error, "forbidden")) return { kind: "forbidden" };
	if (isHarbourError(error, "not_found")) return { kind: "not-found" };
	if (isHarbourError(error, "not_supported")) return { kind: "not-supported" };
	return { kind: "unavailable" };
}

/** The sentence for a reset that went through. */
export function resetText(name: string, removed: number): string {
	if (removed === 0) return `${name} had no passkeys to remove.`;
	return `Removed ${removed === 1 ? "1 passkey" : `${removed} passkeys`} from ${name}. They can set up a new one on the connection request page.`;
}

export interface MembersFlow {
	getState(): MembersState;
	subscribe(listener: () => void): () => void;
	load(): Promise<void>;
	askReset(userId: string): void;
	cancelReset(): void;
	reset(): Promise<void>;
}

export interface MembersFlowOptions {
	readonly api: MembersApi;
	readonly initial?: MembersState;
}

export function createMembersFlow(options: MembersFlowOptions): MembersFlow {
	const { api } = options;
	let state: MembersState = options.initial ?? initialMembers();
	let loads = 0;
	const listeners = new Set<() => void>();
	const set = (next: MembersState) => {
		state = next;
		for (const listener of listeners) listener();
	};
	const without = (from: MembersState, ...keys: readonly Exclude<keyof MembersState, "loading">[]): MembersState => {
		const copy: { -readonly [P in keyof MembersState]: MembersState[P] } = { ...from };
		for (const key of keys) delete copy[key];
		return copy;
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		async load() {
			const call = ++loads;
			set({ ...without(state, "loadProblem"), loading: true });
			try {
				const members = await api.list();
				if (call === loads) set({ ...without(state, "loadProblem"), members, loading: false });
			} catch (error) {
				if (call === loads) set({ ...state, loading: false, loadProblem: membersProblem(error) });
			}
		},

		askReset(userId) {
			if (state.resetting !== undefined) return;
			set({ ...without(state, "resetProblem", "done"), confirming: userId });
		},

		cancelReset() {
			if (state.resetting !== undefined) return;
			set(without(state, "confirming"));
		},

		async reset() {
			const userId = state.confirming;
			if (userId === undefined || state.resetting !== undefined) return;
			set({ ...without(state, "resetProblem", "done"), resetting: userId });
			try {
				const { removed } = await api.resetPasskeys(userId);
				set({ ...without(state, "confirming", "resetting"), done: { userId, removed } });
			} catch (error) {
				set({ ...without(state, "resetting"), resetProblem: { userId, problem: membersProblem(error) } });
			}
		},
	};
}
