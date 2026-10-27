/**
 * `HarbourStack`: the Durable Object that hosts the in-memory stack and its gateway, so a deployment has one state
 * however many isolates its Worker runs in. It goes away binding by binding as #17's step 2 lands (SessionDO per
 * session, D1 for the directory and audit, R2 for workspaces, VaultDO); until then a restart of this object starts the
 * deployment afresh.
 */
import { DurableObject } from "cloudflare:workers";
import type { GatewayVars } from "./config.ts";
import { gatewayConfig } from "./config.ts";
import { createGateway, type Gateway } from "./gateway.ts";
import { createStack, type Stack, type StackOptions } from "./stack.ts";

export interface Env extends GatewayVars {
	readonly STACK: DurableObjectNamespace;
	readonly ASSETS: Fetcher;
}

/** The one stack object's name. */
export const STACK_NAME = "m1";

export abstract class HarbourStackBase extends DurableObject<Env> {
	#ready: Promise<{ stack: Stack; gateway: Gateway }> | undefined;

	/** How the stack is built; the dev entry point adds a mock Access issuer. */
	protected stackOptions(): Omit<StackOptions, "config"> {
		return {};
	}

	protected ready(): Promise<{ stack: Stack; gateway: Gateway }> {
		this.#ready ??= (async () => {
			const stack = await createStack({ ...this.stackOptions(), config: gatewayConfig(this.env) });
			return { stack, gateway: createGateway(stack) };
		})();
		// A failed start is retried by the next request rather than remembered.
		this.#ready.catch(() => {
			this.#ready = undefined;
		});
		return this.#ready;
	}

	override async fetch(request: Request): Promise<Response> {
		let gateway: Gateway;
		try {
			({ gateway } = await this.ready());
		} catch (error) {
			console.error("harbour: the stack did not start", error);
			return Response.json(
				{ error: { code: "unavailable", message: "Harbour is not configured correctly" } },
				{ status: 503 },
			);
		}
		return gateway.fetch(request);
	}
}
