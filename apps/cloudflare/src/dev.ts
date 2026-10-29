/**
 * The local entry point (`wrangler dev --env dev`, `pnpm dev`). It is the deployed Worker plus a few things a laptop
 * cannot get from Cloudflare, under `/__dev/`:
 *
 * - `GET /__dev/access-token?email=<email>`: a token from a mock Access issuer for the dev team domain and AUD, to send
 *   as `Cf-Access-Jwt-Assertion`. The gateway verifies it with the real `cloudflareAccessProvider`; only the signing
 *   keys are local. The dev admin is `HARBOUR_ADMIN_EMAIL` from the dev vars.
 * - `GET /__dev/api-key`: an `hbr_` operator key for the default project, as a host app would hold.
 * - `POST /__dev/vault-seed`: vault requests for the console's vault page (`src/dev-vault-seed.ts`): three sessions of
 *   the default agent ask the VaultDO for six things, three of them settled by the admin. It also invites
 *   `viewer@harbour.test` as a viewer on the default project, to open a forwarded request without the operator role.
 *   Each call adds a new set.
 *
 * Without the model gateway, sessions run on the echo model with one errand (`src/dev-browser-model.ts`): `browse <url>`
 * asks for a browser, opens the URL once someone allows it in the console, and takes a screenshot. With
 * `HARBOUR_BRWSR_API_KEY` in `.dev.vars` that is a real brwsr browser.
 *
 * This file is never the deployed entry point (wrangler.jsonc's top-level `main` is src/index.ts), so none of these
 * routes nor the mock issuer is in the deployed bundle; the deploy workflow checks that.
 */
import { type CallContext, HarbourError, type SessionRecord } from "@harbour/contracts";
import { createMockAccess, type MockAccess } from "@harbour/identity/testing";
import { createDevBrowserModels } from "./dev-browser-model.ts";
import { type DevVaultSeedInput, seedDevVault } from "./dev-vault-seed.ts";
import { routeRequest } from "./index.ts";
import { namedObject, VAULT_NAME } from "./route.ts";
import { DEFAULT_AGENT_ID, type StackOptions } from "./stack.ts";
import { type Env, HarbourStackBase, STACK_NAME } from "./stack-object.ts";
import { HarbourVault as DeployedHarbourVault } from "./vault-object.ts";

const DEV_PREFIX = "/__dev/";
/**
 * The person `POST /__dev/vault-seed` invites as a viewer on the default project. Not exported: everything an entry
 * point exports must be a handler or a class.
 */
const DEV_VIEWER_EMAIL = "viewer@harbour.test";

/** The VaultDO with one more RPC method, for `POST /__dev/vault-seed`. */
export class HarbourVault extends DeployedHarbourVault {
	devSeed(input: DevVaultSeedInput) {
		return seedDevVault(this.vaultCore().vault, input);
	}
}

export class HarbourStack extends HarbourStackBase {
	#access: MockAccess | undefined;
	#apiKey: Promise<string> | undefined;

	#mockAccess(): MockAccess {
		const teamDomain = this.env.HARBOUR_ACCESS_TEAM_DOMAIN ?? "";
		const audience = this.env.HARBOUR_ACCESS_AUD ?? "";
		this.#access ??= createMockAccess({ teamDomain, audience });
		return this.#access;
	}

	protected override stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return { ...super.stackOptions(), accessFetch: this.#mockAccess().fetch };
	}

	protected override stackModels(): StackOptions["models"] {
		return super.stackModels() ?? (() => ({ models: createDevBrowserModels() }));
	}

	async #seedVault(): Promise<Response> {
		const { stack } = await this.ready();
		const { admin, project, organisation } = stack;
		// Invited once: identity takes a second user with the same email, and then signs neither in.
		const bindings = await stack.identity.listRoleBindings(admin, { projectId: project.id });
		const invited = await Promise.all(
			bindings.flatMap((binding) =>
				binding.principal.kind === "user" ? [stack.identity.getUser(admin, binding.principal.userId)] : [],
			),
		);
		if (!invited.some((user) => user.email === DEV_VIEWER_EMAIL)) {
			const viewer = await stack.identity.createUser(admin, { name: "Riley Viewer", email: DEV_VIEWER_EMAIL });
			await stack.identity.grantRole(admin, {
				principal: { kind: "user", userId: viewer.id },
				role: "viewer",
				projectId: project.id,
			});
		}
		const session = (title: string) =>
			stack.runtime.runtime.create(admin, { projectId: project.id, agentId: DEFAULT_AGENT_ID, title });
		const agentIn = (record: SessionRecord): CallContext => ({
			actor: { kind: "agent", agentId: record.agentId, sessionId: record.id },
			organisationId: organisation.id,
			projectId: project.id,
		});
		const [release, linear, billing] = await Promise.all([
			session("Ship the 0.4 release"),
			session("Keep the triage queue moving"),
			session("Check the month's payouts"),
		]);
		const vaults = this.env.VAULTS as unknown as DurableObjectNamespace<HarbourVault>;
		const seeded = await namedObject(vaults, VAULT_NAME, this.env).devSeed({
			admin: { actor: admin.actor, organisationId: admin.organisationId },
			agents: { release: agentIn(release), linear: agentIn(linear), billing: agentIn(billing) },
		});
		return Response.json({ ...seeded, projectId: project.id, viewer: DEV_VIEWER_EMAIL });
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith(DEV_PREFIX)) return super.fetch(request);
		if (url.pathname === `${DEV_PREFIX}access-token`) {
			const email = url.searchParams.get("email") ?? this.env.HARBOUR_ADMIN_EMAIL ?? "";
			const token = await this.#mockAccess().sign({ sub: `dev-${email}`, email }, { expiresInSeconds: 3600 });
			return Response.json({ header: "cf-access-jwt-assertion", token });
		}
		if (url.pathname === `${DEV_PREFIX}api-key`) {
			this.#apiKey ??= (async () => {
				const { stack } = await this.ready();
				const service = await stack.identity.createServiceIdentity(stack.admin, { name: "dev host" });
				const issued = await stack.identity.issueApiKey(stack.admin, {
					serviceId: service.id,
					projectIds: [stack.project.id],
					role: "operator",
					name: "Dev host",
				});
				return issued.secret;
			})();
			const { stack } = await this.ready();
			return Response.json({ secret: await this.#apiKey, projectId: stack.project.id });
		}
		if (url.pathname === `${DEV_PREFIX}vault-seed`) {
			if (request.method !== "POST") return Response.json({ error: { code: "not_supported" } }, { status: 405 });
			try {
				return await this.#seedVault();
			} catch (error) {
				const message = error instanceof HarbourError ? error.message : String(error);
				return Response.json({ error: { code: "unavailable", message } }, { status: 503 });
			}
		}
		return Response.json({ error: { code: "not_found", message: "No such dev route" } }, { status: 404 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith(DEV_PREFIX)) return namedObject(env.STACK, STACK_NAME, env).fetch(request);
		return routeRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
