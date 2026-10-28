// The API keys page's seam on the gateway: the identity client's key routes (`GET` and `POST /v1/keys`,
// `POST /v1/keys/:id/revoke`), for someone the routes let in. The routes refuse a viewer, so the console lists the page
// only for an operator or above; which keys that person may see and change is the directory's to say.

import { type MeResponse, roleSatisfies } from "@harbour/contracts";
import type { IdentityClient } from "@harbour/identity/http";
import type { ConsoleKeys } from "./oversight.ts";

/** The keys seam for the signed-in person, or undefined when no role of theirs reaches the key routes. */
export function apiKeys(client: IdentityClient, me: Pick<MeResponse, "roles">): ConsoleKeys | undefined {
	if (!me.roles.some((held) => roleSatisfies(held.role, "operator"))) return undefined;
	return {
		roles: me.roles,
		api: {
			list: () => client.listApiKeys(),
			create: (input) => client.createApiKey(input),
			revoke: (keyId) => client.revokeApiKey(keyId),
		},
	};
}
