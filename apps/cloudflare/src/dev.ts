/**
 * The local entry point (`wrangler dev --env dev`, `pnpm dev`). It is the deployed Worker plus a few things a laptop
 * cannot get from Cloudflare, under `/__dev/`:
 *
 * - `GET /__dev/access-token?email=<email>`: a token from a mock Access issuer for the dev team domain and AUD, to send
 *   as `Cf-Access-Jwt-Assertion`. The gateway verifies it with the real `cloudflareAccessProvider`; only the signing
 *   keys are local. The dev admin is `KANTEL_ADMIN_EMAIL` from the dev vars.
 * - `GET /__dev/api-key`: an `hbr_` operator key for the default project, as a host app would hold.
 * - `POST /__dev/vault-seed`: vault requests for the console's vault page (`src/dev-vault-seed.ts`): three sessions of
 *   the default agent ask the VaultDO for six things, three of them settled by the admin. It also invites
 *   `viewer@harbour.test` as a viewer on the default project, to open a forwarded request without the operator role.
 *   Each call adds a new set.
 *
 * Without the model gateway, sessions run on the echo model with one errand (`src/dev-browser-model.ts`): `browse <url>`
 * asks for a browser, opens the URL once someone allows it in the console, and takes a screenshot. With
 * `KANTEL_BRWSR_API_KEY` in `.dev.vars` that is a real brwsr browser; with `KANTEL_BROWSER_PROVIDER=harbour` (the dev
 * vars) it is one of Kantel's own, a `KantelBrowser` object whose container wrangler runs in local Docker.
 *
 * This file is never the deployed entry point (wrangler.jsonc's top-level `main` is src/index.ts), so none of these
 * routes nor the mock issuer is in the deployed bundle; the deploy workflow checks that.
 */
import { type CallContext, KantelError, type SessionRecord } from "@kantel/contracts";
import { withKantelEnv } from "@kantel/contracts/env";
import { createMockAccess, type MockAccess } from "@kantel/identity/testing";
import {
	createFakeModelUpstream,
	type FakeImagesScript,
	type FakeModelUpstream,
	type FakeUpstreamScript,
} from "@kantel/testing/models";
import { KantelBrowserBase } from "./browser-object.ts";
import { createDevBrowserModels } from "./dev-browser-model.ts";
import { type DevVaultSeedInput, seedDevVault } from "./dev-vault-seed.ts";
import { routeRequest } from "./index.ts";
import { namedObject, VAULT_NAME } from "./route.ts";
import { KantelSandboxBase } from "./sandbox-object.ts";
import { DEFAULT_AGENT_ID, type StackOptions } from "./stack.ts";
import { type Env, KantelStackBase, STACK_NAME } from "./stack-object.ts";

export { KantelBrowserDecisions } from "./index.ts";

// Under the deployed class names, as src/index.ts exports them: the dev env's bindings and migrations use them too.
export {
	KantelBrowser as HarbourBrowser,
	KantelSandbox as HarbourSandbox,
	KantelStack as HarbourStack,
	KantelVault as HarbourVault,
};

class KantelBrowser extends KantelBrowserBase {}
class KantelSandbox extends KantelSandboxBase {}

import { KantelVault as DeployedKantelVault } from "./vault-object.ts";

const DEV_PREFIX = "/__dev/";
/**
 * The person `POST /__dev/vault-seed` invites as a viewer on the default project. Not exported: everything an entry
 * point exports must be a handler or a class.
 */
const DEV_VIEWER_EMAIL = "viewer@harbour.test";

/** The VaultDO with one more RPC method, for `POST /__dev/vault-seed`. */
class KantelVault extends DeployedKantelVault {
	devSeed(input: DevVaultSeedInput) {
		return seedDevVault(this.vaultCore().vault, input);
	}
}

class KantelStack extends KantelStackBase {
	#access: MockAccess | undefined;
	#apiKey: Promise<string> | undefined;
	#fakeUpstream: FakeModelUpstream | undefined;

	#mockAccess(): MockAccess {
		const teamDomain = this.env.KANTEL_ACCESS_TEAM_DOMAIN ?? "";
		const audience = this.env.KANTEL_ACCESS_AUD ?? "";
		this.#access ??= createMockAccess({ teamDomain, audience });
		return this.#access;
	}

	protected override stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return { ...super.stackOptions(), accessFetch: this.#mockAccess().fetch };
	}

	/**
	 * With `KANTEL_DEV_FAKE_MODELS=on` (and any `KANTEL_CPA_API_KEY`), the gateway calls the fake upstream from
	 * `@kantel/testing` in place of CPA: a chat model and `gpt-image-1`, whose images are its fixed PNG. For working on
	 * the gateway's pages and `generate_image` without a key; set `KANTEL_IMAGE_MODEL=gpt-image-1` for the `images`
	 * route.
	 */
	protected override modelsUpstream(): ((request: Request) => Promise<Response>) | undefined {
		if ((this.env as { KANTEL_DEV_FAKE_MODELS?: string }).KANTEL_DEV_FAKE_MODELS !== "on") {
			return super.modelsUpstream();
		}
		this.#fakeUpstream ??= createFakeModelUpstream({
			models: [{ id: "claude-sonnet-5-5" }, { id: "gpt-5" }, { id: "gpt-image-1" }],
		});
		return this.#fakeUpstream.fetch;
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
		const vaults = this.env.VAULTS as unknown as DurableObjectNamespace<KantelVault>;
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
			const email = url.searchParams.get("email") ?? this.env.KANTEL_ADMIN_EMAIL ?? "";
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
				const message = error instanceof KantelError ? error.message : String(error);
				return Response.json({ error: { code: "unavailable", message } }, { status: 503 });
			}
		}
		if (url.pathname === `${DEV_PREFIX}fake-models` && request.method === "POST") {
			// Queues the fake upstream's next answers (`KANTEL_DEV_FAKE_MODELS=on`): `{ "next": [script…] }` for model calls,
			// such as a tool call, and `{ "images": [script…] }` for image calls.
			const fake = this.#fakeUpstream;
			if (fake === undefined) {
				return Response.json({ error: { code: "unavailable", message: "The fake upstream is off" } }, { status: 503 });
			}
			const body = (await request.json()) as { next?: FakeUpstreamScript[]; images?: FakeImagesScript[] };
			for (const script of body.next ?? []) fake.next(script);
			for (const script of body.images ?? []) fake.nextImages(script);
			return Response.json({ queued: (body.next?.length ?? 0) + (body.images?.length ?? 0) });
		}
		return Response.json({ error: { code: "not_found", message: "No such dev route" } }, { status: 404 });
	}
}

export default {
	async fetch(request: Request, raw: Env): Promise<Response> {
		const env = withKantelEnv(raw);
		const url = new URL(request.url);
		if (url.pathname.startsWith(DEV_PREFIX)) return namedObject(env.STACK, STACK_NAME, env).fetch(request);
		return routeRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
