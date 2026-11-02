/**
 * Environments on the self-hosted gateway (sandbox tier 3): long-lived machines sessions attach to through `bash`'s
 * `env`, their broker, its store (Postgres when durable, memory otherwise) and the providers. Experimental: on only
 * with `KANTEL_ENVIRONMENTS=experimental`; with it off there is nothing here, no routes, no tables, no `env`.
 *
 * The provider is boat.dev when `KANTEL_BOAT_API_KEY` is set, and the in-process fake otherwise (for local runs and
 * tests: a tiny shell over an in-memory file tree that never runs a process). Give boat a key scoped to the `ci`
 * actions, never an account key: each machine is created with `noEnv`, so it holds none of the account's logins.
 */
import {
	type AuditSink,
	type CallContext,
	type EnvironmentProvider,
	type EnvironmentProviderKind,
	type EnvironmentSettings,
	environmentSettings,
	type ProjectAccess,
	type SessionTeardown,
} from "@kantel/contracts";
import { createEnvironmentsApi, type EnvironmentsApi } from "@kantel/environments";
import { withEnvironmentBash } from "@kantel/environments/bash";
import { createBoatProvider } from "@kantel/environments/boat";
import { createEnvironmentBroker, type EnvironmentBroker } from "@kantel/environments/broker";
import { createFakeProvider } from "@kantel/environments/fake";
import type { EnvironmentStore } from "@kantel/environments/store";

/** How often the broker expires leases and stops idle environments. */
export const ENVIRONMENT_SWEEP_MS = 30_000;

export interface GatewayEnvironmentsConfig {
	readonly settings: EnvironmentSettings;
	readonly provider: EnvironmentProviderKind;
	/** boat.dev's API key, scoped to the `ci` actions. */
	readonly boatApiKey?: string;
	/** boat.dev's webhook signing secret, `whsec_…`, for `POST /v1/environment-webhooks/boat`. */
	readonly boatWebhookSecret?: string;
	readonly boatApiUrl?: string;
	/**
	 * boat's own auto-stop, a backstop for the broker's idle stop, in seconds from each start. Default four hours; a
	 * boat account still on its trial allows two at most (`trial_auto_stop_required`).
	 */
	readonly boatAutoStopSeconds?: number;
}

/** Environments' configuration from the gateway's variables, or `undefined` when they are off. */
export function environmentsConfig(env: NodeJS.ProcessEnv): GatewayEnvironmentsConfig | undefined {
	const settings = environmentSettings(env);
	if (!settings.enabled) return undefined;
	const read = (name: string) => env[name]?.trim() ?? "";
	const boatApiKey = read("KANTEL_BOAT_API_KEY");
	const named = read("KANTEL_ENVIRONMENTS_PROVIDER").toLowerCase();
	const provider: EnvironmentProviderKind =
		named === "fake" ? "fake" : named === "boat" || boatApiKey !== "" ? "boat" : "fake";
	if (provider === "boat" && boatApiKey === "") {
		throw new Error("KANTEL_ENVIRONMENTS_PROVIDER=boat needs KANTEL_BOAT_API_KEY, a key scoped to the ci actions");
	}
	const secret = read("KANTEL_BOAT_WEBHOOK_SECRET");
	const apiUrl = read("KANTEL_BOAT_API_URL");
	const autoStop = read("KANTEL_BOAT_AUTO_STOP_MINUTES");
	const autoStopMinutes = autoStop === "" ? undefined : Number(autoStop);
	if (autoStopMinutes !== undefined && !(Number.isInteger(autoStopMinutes) && autoStopMinutes >= 30)) {
		throw new Error("KANTEL_BOAT_AUTO_STOP_MINUTES is a whole number of minutes, at least 30");
	}
	return {
		settings,
		provider,
		...(boatApiKey === "" ? {} : { boatApiKey }),
		...(secret === "" ? {} : { boatWebhookSecret: secret }),
		...(apiUrl === "" ? {} : { boatApiUrl: apiUrl }),
		...(autoStopMinutes === undefined ? {} : { boatAutoStopSeconds: autoStopMinutes * 60 }),
	};
}

/** What the gateway holds of environments once they are on. */
export interface GatewayEnvironments {
	readonly broker: EnvironmentBroker;
	/** The routes, given the gateway's sign-in. */
	api(authenticate: (request: Request) => Promise<CallContext>): EnvironmentsApi;
	/** `/v1/deployment`'s line about them. */
	readonly binding: string;
	close(): Promise<void>;
}

/**
 * The broker over `store`, with the runtime's tools ready before the runtime is built (`withTools`) and its access
 * check reached only when called. `attach` starts the sweeper once the runtime is up.
 */
export function gatewayEnvironments(options: {
	readonly config: GatewayEnvironmentsConfig;
	readonly store: EnvironmentStore;
	readonly storeName: string;
	readonly audit: AuditSink;
	readonly access: () => ProjectAccess;
	readonly log?: (message: string) => void;
	readonly sweepMs?: number;
	/** How boat is reached; a test's fake API. */
	readonly boatFetch?: typeof fetch;
}) {
	const log = options.log ?? ((message: string) => console.error(message));
	const { config } = options;
	const providers: Partial<Record<EnvironmentProviderKind, EnvironmentProvider>> = {
		fake: createFakeProvider(),
	};
	if (config.boatApiKey !== undefined) {
		providers.boat = createBoatProvider({
			apiKey: config.boatApiKey,
			...(config.boatApiUrl === undefined ? {} : { baseUrl: config.boatApiUrl }),
			...(config.boatAutoStopSeconds === undefined ? {} : { backstopSeconds: config.boatAutoStopSeconds }),
			...(options.boatFetch === undefined ? {} : { fetch: options.boatFetch }),
		});
	}
	const broker = createEnvironmentBroker({
		store: options.store,
		providers,
		defaultProvider: config.provider,
		settings: config.settings,
		access: options.access,
		audit: options.audit,
		log,
	});
	let timer: ReturnType<typeof setInterval> | undefined;
	const teardown: SessionTeardown = async (_ctx, end) => {
		await broker.release(end.sessionId, "session_ended");
	};
	return {
		broker,
		withTools: <T extends Parameters<typeof withEnvironmentBash>[0]>(tools: T) =>
			withEnvironmentBash(tools, () => broker),
		teardown,
		attach(): GatewayEnvironments {
			if (timer === undefined) {
				timer = setInterval(() => {
					broker.sweep().catch((error) => log(`[gateway] environments sweep failed: ${error}`));
				}, options.sweepMs ?? ENVIRONMENT_SWEEP_MS);
				timer.unref?.();
			}
			return {
				broker,
				api: (authenticate) =>
					createEnvironmentsApi({
						broker,
						authenticate,
						...(config.boatWebhookSecret === undefined ? {} : { boatWebhookSecret: config.boatWebhookSecret }),
					}),
				binding: `${options.storeName}, ${config.provider} (experimental)`,
				async close() {
					if (timer !== undefined) clearInterval(timer);
					timer = undefined;
				},
			};
		},
	};
}
