// The members page's seam on the gateway: `GET /v1/members` and the invites (`GET` and `POST /v1/invites`,
// `POST /v1/invites/:id/revoke`) from the identity client, and an admin's passkey reset
// (`POST /v1/members/:userId/passkeys/reset`, #132) from the passkey client. Only a person with the organisation's
// admin role may invite or reset, so the console lists the page only for them; the routes check again.

import type { MeResponse } from "@kantel/contracts";
import type { IdentityClient } from "@kantel/identity/http";
import type { PasskeyClient } from "@kantel/identity/passkey/http";
import type { MembersApi } from "@kantel/ui";

export interface ConsoleMembers {
	readonly api: MembersApi;
	/** The signed-in person, marked as you in the list. */
	readonly viewer: string;
}

/** The members seam for the signed-in person, or undefined unless they are a person with the organisation's admin role. */
export function apiMembers(
	identity: Pick<IdentityClient, "members" | "listInvites" | "createInvite" | "revokeInvite">,
	passkeys: Pick<PasskeyClient, "reset">,
	me: Pick<MeResponse, "actor" | "roles">,
): ConsoleMembers | undefined {
	if (me.actor.kind !== "human") return undefined;
	if (!me.roles.some((held) => held.projectId === undefined && held.role === "admin")) return undefined;
	return {
		viewer: me.actor.userId,
		api: {
			list: () => identity.members(),
			resetPasskeys: (userId) => passkeys.reset(userId),
			listInvites: () => identity.listInvites(),
			invite: (input) => identity.createInvite(input),
			revokeInvite: (inviteId) => identity.revokeInvite(inviteId),
		},
	};
}
