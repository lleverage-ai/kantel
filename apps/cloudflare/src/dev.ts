/**
 * The local entry point, for `wrangler dev --env dev`: the deployed Worker with a mock Cloudflare Access issuer in
 * place of the real one, so the console and the identity and audit APIs can be worked on without a Cloudflare account.
 *
 * - `GET /__dev/access-token?email=…`: a token the mock issuer signed for that email (default `KANTEL_ADMIN_EMAIL`), as
 *   `{ header, token }`. Send it as `Cf-Access-Jwt-Assertion`.
 * - `GET /__dev/api-key`: an operator API key on the default project, made once per object, as `{ secret, projectId }`.
 *
 * Nothing here is deployed: wrangler.jsonc's `dev` environment alone names this file.
 */
import { withKantelEnv } from "@kantel/contracts/env";
import { createMockAccess, type MockAccess } from "@kantel/identity/testing";
import { RetiredObject } from "./retired.ts";
import { namedObject, routeRequest, STACK_NAME } from "./route.ts";
import type { StackOptions } from "./stack.ts";
import { type Env, KantelStackBase } from "./stack-object.ts";

export { KantelSession, KantelTunnel } from "./index.ts";

const DEV_PREFIX = "/__dev/";

class KantelVault extends RetiredObject {}
class KantelBrowser extends RetiredObject {}
class KantelSandbox extends RetiredObject {}

export {
	KantelBrowser as HarbourBrowser,
	KantelSandbox as HarbourSandbox,
	KantelStack,
	KantelStack as HarbourStack,
	KantelVault,
	KantelVault as HarbourVault,
};

class KantelStack extends KantelStackBase {
	#access: MockAccess | undefined;
	#apiKey: Promise<string> | undefined;

	#mockAccess(): MockAccess {
		const teamDomain = this.env.KANTEL_ACCESS_TEAM_DOMAIN ?? "";
		const audience = this.env.KANTEL_ACCESS_AUD ?? "";
		this.#access ??= createMockAccess({ teamDomain, audience });
		return this.#access;
	}

	protected override stackOptions(): Omit<StackOptions, "config" | "storage"> {
		return { ...super.stackOptions(), accessFetch: this.#mockAccess().fetch };
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
