/**
 * `HarbourVault`: the VaultDO. A thin wrapper, as `VaultDurableObjectCore` intends: every vault record in this object's
 * own SQLite, audit events in the stack's D1 audit store, and the core built from the Worker's secrets
 * (`src/vault.ts`). One object, named `vault` (`src/route.ts`), serves the deployment.
 *
 * - `fetch`: the egress decision API, for the egress gateway and the model gateway by shared key, through the
 *   Worker's route or a service binding to it.
 * - `decideEgress` and `readConnectorCredential`: the same calls over RPC, for code in this Worker that already holds a
 *   component's system context. `assertSessionOpen` too: the model gateway asks it before each call, so blocking a
 *   session stops its model calls at once.
 * - `connectionSecret`: the connections service's tokens, keys and client secrets over RPC (epic #322).
 * - `cpaItem`: over RPC, the platform item holding CPA's key, made from the `HARBOUR_CPA_API_KEY` secret this object
 *   holds (`seedCpaItem`), so the key's value never leaves the vault except through a recorded connector read.
 * - `approvalCall`: the vault approval API's calls over RPC, for `HarbourStack`, which serves that API to people
 *   (`answerApprovalCall` in `src/vault.ts`).
 * - `ceilingCall`: the organisation's ceiling over RPC, for the connections service's rules (#332).
 */
import { DurableObject } from "cloudflare:workers";
import type {
	CallContext,
	ConnectionSecretCall,
	ConnectionSecretResult,
	ConnectorCredential,
	ConnectorCredentialRequest,
	EgressDecision,
	EgressRequest,
	ModelCallScope,
	SystemContext,
} from "@harbour/contracts";
import { d1Driver } from "@harbour/sql/sqlite";
import type { VaultDurableObjectCore } from "@harbour/vault-cloudflare";
import type { Env } from "./stack-object.ts";
import {
	type ApprovalCallResult,
	answerApprovalCall,
	answerCeilingCall,
	createVaultCore,
	seedCpaItem,
	vaultAuditSink,
	vaultUnavailable,
} from "./vault.ts";

/** Where the items this object made are remembered, by name. */
const SEEDED_PREFIX = "harbour.seeded-item.";

export class HarbourVault extends DurableObject<Env> {
	#core: VaultDurableObjectCore | undefined;
	/** One seed at a time, so two first calls make one item; a failed seed is tried again on the next call. */
	#cpaItem: Promise<string> | undefined;

	/** The vault, built on first use. A failed build (no key yet) is tried again on the next call, not remembered. */
	protected vaultCore(): VaultDurableObjectCore {
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
			core = this.vaultCore();
		} catch (error) {
			console.error("harbour: the vault did not start", error instanceof Error ? error.message : "unknown error");
			return vaultUnavailable(error);
		}
		return core.fetch(request);
	}

	decideEgress(ctx: SystemContext, request: EgressRequest): Promise<EgressDecision> {
		return this.vaultCore().decideEgress(ctx, request);
	}

	readConnectorCredential(ctx: SystemContext, request: ConnectorCredentialRequest): Promise<ConnectorCredential> {
		return this.vaultCore().readConnectorCredential(ctx, request);
	}

	/** The connections service's secrets (epic #322): tokens, keys and client secrets, kept and opened here. */
	connectionSecret(ctx: SystemContext, call: ConnectionSecretCall): Promise<ConnectionSecretResult> {
		return this.vaultCore().connectionSecret(ctx, call);
	}

	/** The model gateway's check before each call: refused for a session an operator blocked, or one that ended. */
	assertSessionOpen(ctx: SystemContext, scope: ModelCallScope): Promise<void> {
		return this.vaultCore().assertSessionOpen(ctx, scope);
	}

	/** One vault approval API call from `HarbourStack`, which has signed the person in and checked project access. */
	approvalCall(method: string, ctx: CallContext, args: readonly unknown[]): Promise<ApprovalCallResult> {
		return answerApprovalCall(() => this.vaultCore().vault, method, ctx, args);
	}

	/** The organisation's ceiling for the connections service (#332), which bounds connection rules as it does grants. */
	ceilingCall(method: string, ctx: CallContext, args: readonly unknown[]): Promise<ApprovalCallResult> {
		return answerCeilingCall(() => this.vaultCore().vault, method, ctx, args);
	}

	cpaItem(): Promise<string> {
		if (this.#cpaItem === undefined) {
			const storage = this.ctx.storage;
			const seeding = seedCpaItem(
				this.vaultCore(),
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
