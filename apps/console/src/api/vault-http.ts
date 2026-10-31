// The vault page's seam over the vault approval API (`@harbour/vault/approval-api`), for when the console talks to a
// real Harbour (`source=api`). Same-origin, like the session API: behind Cloudflare Access the browser's cookie signs
// each call in, so no credential is sent. The page's loaders (`@harbour/ui`'s `loadVaultRequest`, `loadActiveGrants`)
// run unchanged on the client as a `Vault`; the server decides who the caller is and what they may see.

import { createHarbourClient } from "@harbour/api/sdk";
import type { CallContext, Decision, PasskeyAssertion, Proposal } from "@harbour/contracts";
import { createPasskeyClient, type PasskeyClient } from "@harbour/identity/passkey/http";
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
import { browserHasPasskeys, consolePasskey, registerPasskey } from "./passkey.ts";

export interface ApiVaultOptions extends VaultApprovalClientOptions {
	/** The vault's host for the page header. Default the page's own: the API is served on this origin. */
	readonly host?: string;
	/**
	 * Asks for a passkey before an approval. By default, when the approval API says the viewer needs one
	 * (`passkeyRequired`), `webAuthnPasskey` over the API's challenge (`consolePasskey`); otherwise none, and the page
	 * says the approval rests on the sign-in.
	 */
	readonly passkey?: PasskeyCheck;
	/** The person's passkeys, for registering one. Default identity's routes on this origin. */
	readonly passkeys?: Pick<PasskeyClient, "registrationOptions" | "register">;
	/** For tests: the browser's credentials container, and whether it has passkeys. */
	readonly credentials?: Pick<CredentialsContainer, "get" | "create">;
	/** Where the public API is served, for saving a rule from an approval. Default `/v1`, on this origin. */
	readonly apiBaseUrl?: string;
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
	if (signedIn.actor.kind !== "human") throw new Error("The connection request page is for a signed-in person");
	const vault = approvalClientAsVault(client);
	// The context is the server's to decide; this one only satisfies the loaders' signature.
	const ctx: CallContext = { actor: signedIn.actor, organisationId: signedIn.organisationId };
	const describe = requesterDescriber(client);
	// The decisions made on this page, for the settled view: the API has no read for a past decision.
	const decisions = new Map<string, Decision>();
	const viewer = { userId: signedIn.actor.userId, name: signedIn.name ?? "You" };

	// The passkey assertion for each proposal, kept by the passkey check for the decision that follows it.
	const assertions = new Map<string, PasskeyAssertion>();
	const passkey =
		options.passkey ??
		consolePasskey({
			approvals: client,
			keep: (proposalId, assertion) => assertions.set(proposalId, assertion),
			...(options.credentials === undefined ? {} : { credentials: options.credentials }),
		});
	const hasPasskeys = options.credentials !== undefined || browserHasPasskeys();
	const passkeys =
		options.passkeys ?? createPasskeyClient({ ...(options.headers === undefined ? {} : { headers: options.headers }) });

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
			// An assertion is good for one decision: taken here whether the vault approves or refuses.
			const passkeyAssertion = input.outcome === "approve" ? assertions.get(input.proposalId) : undefined;
			assertions.delete(input.proposalId);
			const decision = await client.decide(passkeyAssertion === undefined ? input : { ...input, passkeyAssertion });
			decisions.set(decision.id, decision);
			return decision;
		},
		stop: (grantId) => client.revokeGrant(grantId, "Stopped on the connection request page").then(() => undefined),
		// The server checks the person may add rules to the connection, and that the rule covers the approved request.
		alwaysAllow: async (connectionId, approvalId, rule) => {
			const api = createHarbourClient({
				baseUrl: options.apiBaseUrl ?? "/v1",
				...(options.headers === undefined ? {} : { headers: options.headers }),
				...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			});
			if (rule.action !== "allow") throw new Error("Always allow saves an allow rule");
			await api.createConnectionRuleFromApproval(connectionId, { approvalId, rule: { ...rule, action: "allow" } });
		},
		...(options.passkey !== undefined || signedIn.passkeyRequired === true ? { passkey } : {}),
		// A host with passkeys, and a person without one yet: offer to set one up, after which approving needs it.
		...(options.passkey === undefined && signedIn.passkeyRequired === false && hasPasskeys
			? {
					registerPasskey: async () =>
						(await registerPasskey(passkeys, options.credentials ?? globalThis.navigator?.credentials))
							? passkey
							: undefined,
				}
			: {}),
	};
}
