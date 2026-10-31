// The members page as plain state and a small flow object with no React in it: the organisation's people, an admin
// resetting one person's passkeys with a confirmation (#132), and inviting people by email with a role, the pending
// invites and revoking one. Tested against the real identity and passkey handlers; the page only renders what the flow
// says.
//
// A reset removes every passkey the person has, so they can enrol a new one on their sign-in alone. An invite lets a
// person in when they sign in with its email, with its role across the organisation. Kantel lets only a person with
// the organisation's admin role do either, and audits both.

import { authenticationFailureOf, isKantelError, type Role } from "@kantel/contracts";

/** A person in the organisation, as `GET /v1/members` names them. */
export interface MemberRow {
	readonly userId: string;
	readonly name: string;
}

/**
 * What the page calls: the identity client's `members` and the passkey client's `reset` fit. Failures reject with
 * their `KantelError`s: `forbidden` (with an `invalid` authentication failure once signed out), `not_found`,
 * `not_supported` when the deployment has no passkeys, or anything else when Kantel can't answer.
 */
export interface MembersApi {
	list(): Promise<readonly MemberRow[]>;
	/** `POST /v1/members/:userId/passkeys/reset`: how many passkeys were removed. */
	resetPasskeys(userId: string): Promise<{ readonly removed: number }>;
	/** `GET /v1/invites`: the pending invites, oldest first. */
	listInvites(): Promise<readonly InviteRow[]>;
	/** `POST /v1/invites`: `conflict` for an email already invited or a member's, `invalid` for no email. */
	invite(input: { readonly email: string; readonly role: Role }): Promise<InviteSent>;
	/** `POST /v1/invites/:id/revoke`: `not_found` once it is no longer pending. */
	revokeInvite(inviteId: string): Promise<void>;
}

/** A pending invite, as `GET /v1/invites` lists it. */
export interface InviteRow {
	readonly id: string;
	readonly email: string;
	readonly role: Role;
	readonly expiresAt: number;
}

/** An invite that went through: the link to send the person, and whether Kantel emailed it to them. */
export interface InviteSent {
	readonly invite: InviteRow;
	readonly link: string;
	readonly emailed: boolean;
}

export type MembersProblem =
	| { readonly kind: "signed-out" }
	| { readonly kind: "forbidden" }
	| { readonly kind: "not-found" }
	| { readonly kind: "not-supported" }
	| { readonly kind: "conflict" }
	| { readonly kind: "invalid" }
	| { readonly kind: "unavailable" };

/** The invite dialog: open, sending, refused, or done with the link to share. */
export interface InviteDialogState {
	readonly sending: boolean;
	readonly problem?: MembersProblem;
	readonly sent?: InviteSent;
}

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
	/** Undefined until the first list arrives. */
	readonly invites?: readonly InviteRow[];
	/** Open while someone is being invited. */
	readonly inviting?: InviteDialogState;
	/** The invite being revoked. */
	readonly revoking?: string;
	readonly revokeProblem?: { readonly inviteId: string; readonly problem: MembersProblem };
}

/** Only the signed-in person and nobody invited: the page asks them to invite someone. */
export function onlyYou(state: MembersState, viewer: string | undefined): boolean {
	if (state.members === undefined || state.invites === undefined || state.invites.length > 0) return false;
	return state.members.every((member) => member.userId === viewer);
}

export const initialMembers = (): MembersState => ({ loading: true });

/** What a failed call means for the page. */
export function membersProblem(error: unknown): MembersProblem {
	if (authenticationFailureOf(error) === "invalid") return { kind: "signed-out" };
	if (isKantelError(error, "forbidden")) return { kind: "forbidden" };
	if (isKantelError(error, "not_found")) return { kind: "not-found" };
	if (isKantelError(error, "not_supported")) return { kind: "not-supported" };
	if (isKantelError(error, "conflict")) return { kind: "conflict" };
	if (isKantelError(error, "invalid")) return { kind: "invalid" };
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
	openInvite(): void;
	closeInvite(): void;
	invite(input: { readonly email: string; readonly role: Role }): Promise<void>;
	revokeInvite(inviteId: string): Promise<void>;
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
				const [members, invites] = await Promise.all([api.list(), api.listInvites()]);
				if (call === loads) set({ ...without(state, "loadProblem"), members, invites, loading: false });
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

		openInvite() {
			if (state.inviting !== undefined) return;
			set({ ...without(state, "revokeProblem"), inviting: { sending: false } });
		},

		closeInvite() {
			if (state.inviting?.sending === true) return;
			set(without(state, "inviting"));
		},

		async invite(input) {
			if (state.inviting === undefined || state.inviting.sending || state.inviting.sent !== undefined) return;
			set({ ...state, inviting: { sending: true } });
			try {
				const sent = await api.invite(input);
				const invites = [...(state.invites ?? []).filter((row) => row.id !== sent.invite.id), sent.invite];
				set({ ...state, invites, ...(state.inviting === undefined ? {} : { inviting: { sending: false, sent } }) });
			} catch (error) {
				const problem = membersProblem(error);
				set({ ...state, ...(state.inviting === undefined ? {} : { inviting: { sending: false, problem } }) });
			}
		},

		async revokeInvite(inviteId) {
			if (state.revoking !== undefined) return;
			set({ ...without(state, "revokeProblem"), revoking: inviteId });
			try {
				await api.revokeInvite(inviteId);
				const invites = (state.invites ?? []).filter((row) => row.id !== inviteId);
				set({ ...without(state, "revoking"), invites });
			} catch (error) {
				const problem = membersProblem(error);
				// Accepted or revoked elsewhere meanwhile: it is not pending, so it leaves the list all the same.
				if (problem.kind === "not-found") {
					set({ ...without(state, "revoking"), invites: (state.invites ?? []).filter((row) => row.id !== inviteId) });
				} else {
					set({ ...without(state, "revoking"), revokeProblem: { inviteId, problem } });
				}
			}
		},
	};
}
