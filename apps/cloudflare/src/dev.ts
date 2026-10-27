/**
 * The local entry point (`wrangler dev --env dev`, `pnpm dev`). It is the deployed Worker plus two things a laptop
 * cannot get from Cloudflare, under `/__dev/`:
 *
 * - `GET /__dev/access-token?email=<email>`: a token from a mock Access issuer for the dev team domain and AUD, to send
 *   as `Cf-Access-Jwt-Assertion`. The gateway verifies it with the real `cloudflareAccessProvider`; only the signing
 *   keys are local. The dev admin is `HARBOUR_ADMIN_EMAIL` from the dev vars.
 * - `GET /__dev/api-key`: an `hbr_` operator key for the default project, as a host app would hold.
 *
 * This file is never the deployed entry point (wrangler.jsonc's top-level `main` is src/index.ts), so neither route
 * nor the mock issuer is in the deployed bundle; the deploy workflow checks that.
 */
import { createMockAccess, type MockAccess } from "@harbour/identity/testing";
import { routeRequest } from "./index.ts";
import type { StackOptions } from "./stack.ts";
import { type Env, HarbourStackBase, STACK_NAME } from "./stack-object.ts";

const DEV_PREFIX = "/__dev/";

export class HarbourStack extends HarbourStackBase {
	#access: MockAccess | undefined;
	#apiKey: Promise<string> | undefined;

	#mockAccess(): MockAccess {
		const teamDomain = this.env.HARBOUR_ACCESS_TEAM_DOMAIN ?? "";
		const audience = this.env.HARBOUR_ACCESS_AUD ?? "";
		this.#access ??= createMockAccess({ teamDomain, audience });
		return this.#access;
	}

	protected override stackOptions(): Omit<StackOptions, "config"> {
		return { accessFetch: this.#mockAccess().fetch };
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
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith(DEV_PREFIX)) return env.STACK.get(env.STACK.idFromName(STACK_NAME)).fetch(request);
		return routeRequest(request, env);
	},
} satisfies ExportedHandler<Env>;
