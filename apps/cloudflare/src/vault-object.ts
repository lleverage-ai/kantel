/**
 * `HarbourVault`: the VaultDO. A thin wrapper, as `VaultDurableObjectCore` intends: every vault record in this object's
 * own SQLite, audit events in the stack's D1 audit store, and the core built from the Worker's secrets
 * (`src/vault.ts`). One object, named `vault` (`src/route.ts`), serves the deployment.
 *
 * - `fetch`: the egress decision API, for the egress gateway and the model gateway by shared key, through the
 *   Worker's route or a service binding to it.
 * - `decideEgress` and `readConnectorCredential`: the same calls over RPC, for code in this Worker that already holds a
 *   component's system context.
 */
import { DurableObject } from "cloudflare:workers";
import type {
	ConnectorCredential,
	ConnectorCredentialRequest,
	EgressDecision,
	EgressRequest,
	SystemContext,
} from "@harbour/contracts";
import { d1Driver } from "@harbour/sql/sqlite";
import type { VaultDurableObjectCore } from "@harbour/vault-cloudflare";
import type { Env } from "./stack-object.ts";
import { createVaultCore, vaultAuditSink, vaultUnavailable } from "./vault.ts";

export class HarbourVault extends DurableObject<Env> {
	#core: VaultDurableObjectCore | undefined;

	/** The vault, built on first use. A failed build (no key yet) is tried again on the next call, not remembered. */
	#vault(): VaultDurableObjectCore {
		if (this.#core === undefined) {
			const storage = this.ctx.storage;
			this.#core = createVaultCore({
				sql: storage.sql,
				transactionSync: (work) => storage.transactionSync(work),
				audit: vaultAuditSink(d1Driver(this.env.DB)),
				vars: this.env,
			});
		}
		return this.#core;
	}

	override async fetch(request: Request): Promise<Response> {
		let core: VaultDurableObjectCore;
		try {
			core = this.#vault();
		} catch (error) {
			console.error("harbour: the vault did not start", error instanceof Error ? error.message : "unknown error");
			return vaultUnavailable(error);
		}
		return core.fetch(request);
	}

	decideEgress(ctx: SystemContext, request: EgressRequest): Promise<EgressDecision> {
		return this.#vault().decideEgress(ctx, request);
	}

	readConnectorCredential(ctx: SystemContext, request: ConnectorCredentialRequest): Promise<ConnectorCredential> {
		return this.#vault().readConnectorCredential(ctx, request);
	}
}
