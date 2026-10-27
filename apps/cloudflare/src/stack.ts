/**
 * The M1 stack the gateway serves, composed from each package's in-memory implementation until its Cloudflare binding
 * lands (#17, step 2): identity, the session runtime, workspaces and the audit store, behind one authenticator.
 *
 * Portable: no Cloudflare APIs, so the tests run it in Node and `HarbourStack` hosts it in one Durable Object, which
 * keeps one consistent state for the deployment while the state is in memory.
 */
import { createMemoryAuditStore } from "@harbour/audit/memory";
import {
	type AgentProfile,
	type AuditSink,
	type AuditStore,
	type Authenticator,
	type CallContext,
	type Clock,
	type IdentityDirectory,
	type Organisation,
	type Project,
	systemClock,
} from "@harbour/contracts";
import { createAuthenticator } from "@harbour/identity/authenticator";
import { cloudflareAccessProvider, type SignInProvider } from "@harbour/identity/jwt";
import { createMemoryIdentity } from "@harbour/identity/memory";
import type { MemoryRuntime } from "@harbour/runtime/memory";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import type { KeyedWorkspaces } from "@harbour/workspace";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import type { GatewayConfig } from "./config.ts";
import { createEchoModels } from "./echo-model.ts";

/** The context bootstrap runs in. Identity lets only a system actor create the first organisation and user. */
const BOOTSTRAP: CallContext = {
	actor: { kind: "system", component: "cloudflare.bootstrap" },
	organisationId: "bootstrap",
};

/** The agent every new deployment has, so a session can be created before any host registers its own profiles. */
export const DEFAULT_AGENT_ID = "assistant";

export interface StackOptions {
	readonly config: GatewayConfig;
	readonly clock?: Clock;
	/** Used to fetch Access's signing keys. Default the global `fetch`; tests and `wrangler dev` pass a mock issuer's. */
	readonly accessFetch?: typeof fetch;
}

export interface Stack {
	readonly identity: IdentityDirectory;
	readonly runtime: MemoryRuntime;
	readonly workspaces: KeyedWorkspaces;
	readonly audit: AuditStore;
	readonly authenticator: Authenticator;
	readonly organisation: Organisation;
	readonly project: Project;
	/** The organisation's first admin: the invited person, or a placeholder no one can sign in as. */
	readonly admin: CallContext;
}

/**
 * Builds the stack and bootstraps one organisation with one project, its first admin (invited by email when the config
 * names one) and the default agent profile.
 */
export async function createStack(options: StackOptions): Promise<Stack> {
	const clock = options.clock ?? systemClock;

	// Every component audits into one store. The store's own access check comes from the runtime, which is built after
	// identity, so the sink forwards to the store once it exists.
	let store: AuditStore | undefined;
	const sink: AuditSink = {
		async append(ctx, events) {
			if (store === undefined) throw new Error("audit store not ready");
			await store.append(ctx, events);
		},
	};

	const identity = createMemoryIdentity({ clock, audit: sink });
	const runtime = createMemoryRuntime({ clock, audit: sink, identity, models: createEchoModels() });
	const access = runtime.access;
	if (access === undefined) throw new Error("the runtime was built without project access");
	store = createMemoryAuditStore({ clock, access });
	const workspaces = createMemoryWorkspaces({ clock, audit: sink, access });

	const providers: SignInProvider[] = [];
	if (options.config.access !== undefined) {
		providers.push(
			cloudflareAccessProvider({
				teamDomain: options.config.access.teamDomain,
				audience: options.config.access.audience,
				...(options.accessFetch === undefined ? {} : { fetch: options.accessFetch }),
				clock,
			}),
		);
	}
	const authenticator = createAuthenticator({ identity, providers });

	const adminEmail = options.config.adminEmail;
	const founder = await identity.createUser(BOOTSTRAP, {
		name: adminEmail ?? "Bootstrap admin",
		...(adminEmail === undefined ? {} : { email: adminEmail }),
	});
	const organisation = await identity.createOrganisation(BOOTSTRAP, {
		name: "Harbour",
		admin: { kind: "user", userId: founder.id },
	});
	const admin: CallContext = { actor: { kind: "human", userId: founder.id }, organisationId: organisation.id };
	const project = await identity.createProject(admin, { name: "Default" });
	const profile: AgentProfile = {
		id: DEFAULT_AGENT_ID,
		organisationId: organisation.id,
		projectId: project.id,
		name: "Assistant",
		model: { route: "default" },
		promptLayers: [{ name: "role", text: "You are a helpful assistant running on Harbour." }],
		tools: [],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
	};
	await runtime.profiles.put(admin, profile);

	return { identity, runtime, workspaces, audit: store, authenticator, organisation, project, admin };
}
