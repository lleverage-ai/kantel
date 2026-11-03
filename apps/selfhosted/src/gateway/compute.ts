/**
 * The compute plane on the self-hosted gateway (`@kantel/compute`): accounts, sandboxes, snapshots, scoped `ksk_` keys,
 * webhooks, OpenTelemetry export and hosts under `/v1`. Experimental: on only with `KANTEL_COMPUTE=experimental`; with
 * it off there is nothing here and none of its routes answer.
 *
 * Sandboxes run on the stub backend (a just-bash shell over files in memory) until the host scheduler lands, and the
 * records are in memory too, so they are gone after a restart. The super-admin's key is the exception: the gateway
 * keeps its secret in the bootstrap file and makes it again on each start, so the installer's first key keeps working.
 *
 * A person signed in to the console (or with an OIDC or Access token) is a compute person under their user ID, and a
 * super-admin when they are an admin of the deployment's organisation.
 */

import { type ComputeApi, createComputeApi, type PersonIdentity } from "@kantel/compute";
import { bootstrapSuperAdmin } from "@kantel/compute/serve";
import { createStubBackend } from "@kantel/compute/stub";
import type { Authenticator } from "@kantel/contracts";

/** How often webhook deliveries that are due are sent. */
const WEBHOOK_INTERVAL_MS = 1000;
/** How often telemetry is exported. */
const TELEMETRY_INTERVAL_MS = 60_000;

/** Whether the compute plane is on: `KANTEL_COMPUTE=experimental`. */
export function computeEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.KANTEL_COMPUTE?.trim().toLowerCase() === "experimental";
}

export interface GatewayCompute {
	readonly api: ComputeApi;
	/** The super-admin key's secret, for the bootstrap file. */
	readonly superAdminKey: string;
	/** `/v1/deployment`'s line about it. */
	readonly binding: string;
	close(): Promise<void>;
}

/** The person a gateway sign-in is, or undefined for a key or no sign-in (a `ksk_` key is the compute API's own). */
async function personOf(authenticator: Authenticator, request: Request): Promise<PersonIdentity | undefined> {
	try {
		const caller = await authenticator.authenticate(request);
		if (caller.actor.kind !== "human") return undefined;
		return { userId: caller.actor.userId, name: caller.actor.userId, superAdmin: caller.role === "admin" };
	} catch {
		return undefined;
	}
}

/** The compute API over the stub backend, signed in with the gateway's `authenticator`. */
export async function gatewayCompute(options: {
	readonly authenticator: Authenticator;
	/** The super-admin key's secret from an earlier start, if any. */
	readonly superAdminKey?: string;
	readonly publicUrl?: string;
	readonly now?: () => number;
}): Promise<GatewayCompute> {
	const api = createComputeApi({
		backend: createStubBackend(),
		authenticatePerson: (request) => personOf(options.authenticator, request),
		...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	const superAdminKey = await bootstrapSuperAdmin(api.store, options.superAdminKey, (options.now ?? Date.now)());
	api.dispatcher.start(WEBHOOK_INTERVAL_MS);
	api.exporter.start(TELEMETRY_INTERVAL_MS);
	return {
		api,
		superAdminKey,
		binding: "memory, stub backend (experimental)",
		async close() {
			await api.close();
		},
	};
}
