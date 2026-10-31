/**
 * Connection secrets in the Kantel vault: each token, key and client secret is a vault item, sealed with the vault's
 * key, bound to its hosts, and opened only for one request to one of them, with a vault use recorded each time.
 * `vault` is the vault itself (self-hosted) or its Durable Object over RPC (Cloudflare).
 */
import { type ConnectionSecrets, systemContext } from "@kantel/contracts";
import type { CredentialStore } from "./ports.ts";

const CONTEXT = systemContext("connections");

export function vaultCredentials(vault: ConnectionSecrets): CredentialStore {
	return {
		async put(input) {
			const { itemId } = await vault.connectionSecret(CONTEXT, {
				op: "put",
				owner: input.owner,
				name: input.name,
				hosts: input.hosts,
				value: input.value,
			});
			if (itemId === undefined) throw new Error("The vault stored no item");
			return itemId;
		},
		async replace(ref, value) {
			await vault.connectionSecret(CONTEXT, { op: "replace", itemId: ref, value });
		},
		async open(input) {
			const { value } = await vault.connectionSecret(CONTEXT, {
				op: "open",
				itemId: input.ref,
				host: input.host,
				organisationId: input.organisationId,
				...(input.scope === undefined
					? {}
					: {
							session: {
								sessionId: input.scope.sessionId,
								...(input.scope.projectId === undefined ? {} : { projectId: input.scope.projectId }),
								agentId: input.scope.agentId,
							},
						}),
				purpose: input.purpose,
			});
			if (value === undefined) throw new Error("The vault opened no value");
			return value;
		},
		async remove(ref) {
			await vault.connectionSecret(CONTEXT, { op: "clear", itemId: ref });
		},
		async find(input) {
			if (input.refs.length === 0 || input.texts.length === 0) return [];
			const { found } = await vault.connectionSecret(CONTEXT, {
				op: "find",
				organisationId: input.organisationId,
				itemIds: input.refs,
				texts: input.texts,
			});
			return found ?? [];
		},
	};
}
