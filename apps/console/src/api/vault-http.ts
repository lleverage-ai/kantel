// The vault page's seam over the vault approval API (`@harbour/vault/approval-api`), for when the console talks to a
// real Harbour (`source=api`). Same-origin, like the session API: behind Cloudflare Access the browser's cookie signs
// each call in, so no credential is sent. The page's loaders (`@harbour/ui`'s `loadVaultRequest`, `loadActiveGrants`)
// run unchanged on the client as a `Vault`; the server decides who the caller is and what they may see.

import type { CallContext, Decision, Proposal } from "@harbour/contracts";
import {
	type DescribeRequester,
	loadActiveGrants,
	loadVaultRequest,
	type PasskeyCheck,
	type RequesterLabels,
} from "@harbour/ui";
import {
	approvalClientAsVault,
	createVaultApprovalClient,
	type VaultApprovalClient,
	type VaultApprovalClientOptions,
} from "@harbour/vault/approval-api";
import { sessionPath } from "../app/router.ts";
import type { ConsoleVault } from "./oversight.ts";

export interface ApiVaultOptions extends VaultApprovalClientOptions {
	/** The vault's host for the page header. Default the page's own: the API is served on this origin. */
	readonly host?: string;
	/**
	 * Asks for a passkey before an approval. Harbour has no passkey registration or assertion check yet, so by default
	 * there is none: the page says the approval rests on the Access sign-in and asks for no passkey.
	 */
	readonly passkey?: PasskeyCheck;
}

/**
 * The requester in the page's names, from `GET /proposals/:id/requester`, with a link to the session in this console.
 * A name the caller may not read is left out; a failed read leaves only the organisation's ID.
 */
export function requesterDescriber(client: Pick<VaultApprovalClient, "requester">): DescribeRequester {
	return async (proposal: Proposal): Promise<RequesterLabels> => {
		const names = await client.requester(proposal.id).catch(() => ({}) as Awaited<ReturnType<typeof client.requester>>);
		const { sessionId, onBehalfOf } = proposal.requester;
		return {
			organisation: names.organisation ?? proposal.organisationId,
			...(names.project === undefined ? {} : { project: names.project }),
			...(names.agent === undefined ? {} : { agent: names.agent }),
			...(names.session === undefined ? {} : { session: names.session }),
			...(sessionId === undefined || proposal.projectId === undefined
				? {}
				: { sessionHref: sessionPath(proposal.projectId, sessionId) }),
			...(names.person === undefined ? {} : { person: names.person }),
			...(onBehalfOf === undefined ? {} : { personId: onBehalfOf }),
		};
	};
}

/**
 * The vault page on the gateway this console is served by. Resolves once the API has said who is signed in; rejects
 * when it can't (no approval API, or not a person), and the console then shows no vault page.
 */
export async function apiVault(options: ApiVaultOptions = {}): Promise<ConsoleVault> {
	const client = createVaultApprovalClient(options);
	const signedIn = await client.viewer();
	if (signedIn.actor.kind !== "human") throw new Error("The vault page is for a signed-in person");
	const vault = approvalClientAsVault(client);
	// The context is the server's to decide; this one only satisfies the loaders' signature.
	const ctx: CallContext = { actor: signedIn.actor, organisationId: signedIn.organisationId };
	const describe = requesterDescriber(client);
	// The decisions made on this page, for the settled view: the API has no read for a past decision.
	const decisions = new Map<string, Decision>();
	const viewer = { userId: signedIn.actor.userId, name: signedIn.name ?? "You" };
	return {
		host: options.host ?? globalThis.location?.host ?? "",
		viewer,
		request: (proposalId) =>
			loadVaultRequest(vault, ctx, proposalId, describe, {
				decisions,
				decider: (decision) =>
					decision.decidedBy.kind === "human" && decision.decidedBy.userId === viewer.userId ? viewer.name : undefined,
			}),
		grants: () => loadActiveGrants(vault, ctx, describe),
		decide: async (input) => {
			const decision = await client.decide(input);
			decisions.set(decision.id, decision);
			return decision;
		},
		stop: (grantId) => client.revokeGrant(grantId, "Stopped on the vault page").then(() => undefined),
		...(options.passkey === undefined ? {} : { passkey: options.passkey }),
	};
}
