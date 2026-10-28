/**
 * `HarbourVault`: the VaultDO. A thin wrapper, as `VaultDurableObjectCore` intends: every vault record in this object's
 * own SQLite, audit events in the stack's D1 audit store, and the core built from the Worker's secrets
 * (`src/vault.ts`). One object, named `vault` (`src/route.ts`), serves the deployment.
 *
 * - `fetch`: the egress decision API, for the egress gateway and the model gateway by shared key, through the
 *   Worker's route or a service binding to it.
 * - `decideEgress` and `readConnectorCredential`: the same calls over RPC, for code in this Worker that already holds a
 *   component's system context.
 * - `cpaItem`: over RPC, the platform item holding CPA's key, made from the `HARBOUR_CPA_API_KEY` secret this object
 *   holds (`seedCpaItem`), so the key's value never leaves the vault except through a recorded connector read.
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
import { createVaultCore, seedCpaItem, vaultAuditSink, vaultUnavailable } from "./vault.ts";

/** Where the items this object made are remembered, by name. */
const SEEDED_PREFIX = "harbour.seeded-item.";

export class HarbourVault extends DurableObject<Env> {
	#core: VaultDurableObjectCore | undefined;
	/** One seed at a time, so two first calls make one item; a failed seed is tried again on the next call. */
	#cpaItem: Promise<string> | undefined;

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

	cpaItem(): Promise<string> {
		if (this.#cpaItem === undefined) {
			const storage = this.ctx.storage;
			const seeding = seedCpaItem(
				this.#vault(),
				{
					get: (name) => storage.get<string>(`${SEEDED_PREFIX}${name}`),
					put: (name, itemId) => storage.put(`${SEEDED_PREFIX}${name}`, itemId),
				},
				this.env,
			);
			this.#cpaItem = seeding;
			seeding.catch(() => {
				if (this.#cpaItem === seeding) this.#cpaItem = undefined;
			});
		}
		return this.#cpaItem;
	}
}
