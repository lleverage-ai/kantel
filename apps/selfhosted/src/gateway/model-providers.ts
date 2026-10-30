/**
 * Model providers on the self-hosted gateway (`@harbour/models/providers`): what the console's onboarding and any
 * host app call to connect an organisation's models (`/v1/model-providers`).
 *
 * - A provider's key goes into the gateway's vault and its connector into the model gateway's directory, built at the
 *   first call that needs it; the store keeps the connector and routes (never a key) so the next start replays them.
 * - Without the model gateway (no CPA configured), the providers are listed but key providers are unavailable: there is
 *   no gateway to serve them, and sessions stay on the echo model.
 * - Subscriptions need CPA's management key (`HARBOUR_CPA_MANAGEMENT_KEY`).
 */
import type { AuditSink, ModelConnectors, ModelProviders, ProjectAccess } from "@harbour/contracts";
import { HarbourError } from "@harbour/contracts";
import type { CpaManagement } from "@harbour/models/cpa-management";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelProviders, lateModelConnectors, type ModelProviderStore } from "@harbour/models/providers";
import type { HarbourVault } from "@harbour/vault/engine";

export const NO_GATEWAY_REASON = "This deployment runs no model gateway: set HARBOUR_CPA_URL and HARBOUR_CPA_API_KEY";

export function gatewayModelProviders(options: {
	/** The gateway's directory, once built; absent without a model gateway. */
	readonly connectors?: () => Promise<ModelConnectors>;
	readonly subscriptions?: CpaManagement;
	readonly vault: () => HarbourVault | undefined;
	readonly access: ProjectAccess;
	readonly audit: AuditSink;
	readonly store: ModelProviderStore;
}): ModelProviders {
	const vault = (): HarbourVault => {
		const found = options.vault();
		if (found === undefined) {
			throw new HarbourError("unavailable", "A provider's key is kept in the vault: set HARBOUR_VAULT_CIPHER_KEY");
		}
		return found;
	};
	return createModelProviders({
		connectors:
			options.connectors === undefined ? createMemoryModelConnectors() : lateModelConnectors(options.connectors),
		vault: { putItem: (ctx, input) => vault().putItem(ctx, input) },
		access: options.access,
		audit: options.audit,
		store: options.store,
		// One directory serves every organisation, so a connector's ID names its organisation.
		connectorId: (organisationId, providerId) => `org-${organisationId}-${providerId}`,
		...(options.connectors === undefined ? { keyProviders: { reason: NO_GATEWAY_REASON } } : {}),
		...(options.subscriptions === undefined ? {} : { subscriptions: options.subscriptions }),
	});
}
