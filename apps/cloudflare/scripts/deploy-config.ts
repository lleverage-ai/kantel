/**
 * Writes `wrangler.deploy.json`, the config the deploy workflow (.github/workflows/cloudflare-deploy.yml) hands to
 * wrangler: `wrangler.jsonc` plus what only the deployment knows, from the repository variables in #17's Account setup.
 * Wrangler's config can't read environment variables, so this fills them in:
 *
 * - `account_id` from `CLOUDFLARE_ACCOUNT_ID`;
 * - the custom domain from `HARBOUR_HOSTNAME` (console and gateway on one hostname);
 * - the Access team domain and AUD, and the first admin's email, as vars;
 * - the `MODELS` VPC service binding (CLIProxyAPI through the `sal-app` tunnel) from `HARBOUR_MODELS_VPC_SERVICE_ID`.
 *
 * `--mode deploy` needs every variable and refuses to write a config without them. `--mode dry-run` fills a missing
 * one with a placeholder, so `wrangler deploy --dry-run` still checks the whole config's shape before the account is
 * set up. The `dev` environment is dropped: it is local only and never deployed.
 *
 * Usage: node scripts/deploy-config.ts --mode deploy|dry-run [--out wrangler.deploy.json]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEPLOY_VARIABLES = [
	"CLOUDFLARE_ACCOUNT_ID",
	"HARBOUR_HOSTNAME",
	"HARBOUR_ACCESS_TEAM_DOMAIN",
	"HARBOUR_ACCESS_AUD",
	"HARBOUR_MODELS_VPC_SERVICE_ID",
	"HARBOUR_ADMIN_EMAIL",
] as const;

export type DeployVariable = (typeof DEPLOY_VARIABLES)[number];
export type DeployMode = "deploy" | "dry-run";

/** The binding name the model gateway will use for CLIProxyAPI (step 2 of #17). */
export const MODELS_BINDING = "MODELS";

/** Stand-ins for a dry run before the account is set up. Never deployed: deploy mode refuses a missing variable. */
const PLACEHOLDERS: Readonly<Record<Exclude<DeployVariable, "CLOUDFLARE_ACCOUNT_ID">, string>> = {
	HARBOUR_HOSTNAME: "harbour.example.com",
	HARBOUR_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
	HARBOUR_ACCESS_AUD: "0000000000000000000000000000000000000000000000000000000000000000",
	HARBOUR_MODELS_VPC_SERVICE_ID: "00000000-0000-0000-0000-000000000000",
	HARBOUR_ADMIN_EMAIL: "admin@example.com",
};

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;

/** A team domain may be given as `https://team.cloudflareaccess.com/`, as `cloudflareAccessIssuer` accepts it. */
export function hostOnly(value: string): string {
	return value
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/+$/, "");
}

const CHECKS: Readonly<Record<DeployVariable, { readonly test: (value: string) => boolean; readonly expect: string }>> =
	{
		CLOUDFLARE_ACCOUNT_ID: { test: (v) => /^[0-9a-f]{32}$/i.test(v), expect: "a 32-character hex account ID" },
		HARBOUR_HOSTNAME: {
			test: (v) => HOST.test(v),
			expect: "a host name such as harbour.myslop.app, no scheme or path",
		},
		HARBOUR_ACCESS_TEAM_DOMAIN: {
			test: (v) => HOST.test(hostOnly(v)),
			expect: "the Access team domain, such as <team>.cloudflareaccess.com",
		},
		HARBOUR_ACCESS_AUD: {
			test: (v) => /^[0-9a-f]{32,128}$/i.test(v),
			expect: "the Access application's AUD tag (hex)",
		},
		HARBOUR_MODELS_VPC_SERVICE_ID: {
			test: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
			expect: "the Workers VPC service's ID (a UUID)",
		},
		HARBOUR_ADMIN_EMAIL: { test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), expect: "an email address" },
	};

export interface DeployValues {
	/** Absent only in a dry run, which needs no account. */
	readonly accountId?: string;
	readonly hostname: string;
	readonly accessTeamDomain: string;
	readonly accessAud: string;
	readonly modelsVpcServiceId: string;
	readonly adminEmail: string;
	/** The variables a dry run filled with placeholders. Always empty in deploy mode. */
	readonly placeholders: readonly DeployVariable[];
}

/** The variables that are unset or blank. */
export function missingVariables(env: Readonly<Record<string, string | undefined>>): DeployVariable[] {
	return DEPLOY_VARIABLES.filter((name) => (env[name] ?? "").trim() === "");
}

/**
 * Reads the deployment's values. Deploy mode refuses a missing variable; a dry run fills it with a placeholder. A
 * value that is set but malformed is refused in both modes, so a typo shows up in the dry run on the pull request.
 */
export function deployValues(env: Readonly<Record<string, string | undefined>>, mode: DeployMode): DeployValues {
	const missing = missingVariables(env);
	if (mode === "deploy" && missing.length > 0) {
		throw new Error(`Cannot deploy: set the repository variables ${missing.join(", ")}`);
	}
	const invalid = DEPLOY_VARIABLES.filter((name) => !missing.includes(name))
		.filter((name) => !CHECKS[name].test((env[name] ?? "").trim()))
		.map((name) => `${name} must be ${CHECKS[name].expect}`);
	if (invalid.length > 0) throw new Error(invalid.join("; "));

	const value = (name: Exclude<DeployVariable, "CLOUDFLARE_ACCOUNT_ID">): string =>
		missing.includes(name) ? PLACEHOLDERS[name] : (env[name] ?? "").trim();
	const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
	return {
		...(accountId === "" ? {} : { accountId }),
		hostname: value("HARBOUR_HOSTNAME").toLowerCase(),
		accessTeamDomain: hostOnly(value("HARBOUR_ACCESS_TEAM_DOMAIN")).toLowerCase(),
		accessAud: value("HARBOUR_ACCESS_AUD"),
		modelsVpcServiceId: value("HARBOUR_MODELS_VPC_SERVICE_ID"),
		adminEmail: value("HARBOUR_ADMIN_EMAIL"),
		placeholders: missing,
	};
}

type RawConfig = Readonly<Record<string, unknown>>;

/**
 * `wrangler.jsonc` with the deployment's values filled in. Refuses a base config that already names an account, a
 * route or a VPC service (those belong to the deployment), or that could serve on workers.dev or a preview URL, which
 * would bypass Access.
 */
export function deployConfig(raw: RawConfig, values: DeployValues): Record<string, unknown> {
	for (const key of ["account_id", "routes", "route", "vpc_services"]) {
		if (key in raw) throw new Error(`wrangler.jsonc must not set ${key}: the deploy fills it in`);
	}
	if (raw.workers_dev !== false || raw.preview_urls !== false) {
		throw new Error("wrangler.jsonc must set workers_dev and preview_urls to false: those URLs bypass Access");
	}
	const { $schema: _schema, env: _env, ...base } = raw;
	const vars = typeof raw.vars === "object" && raw.vars !== null ? raw.vars : {};
	return {
		...base,
		...(values.accountId === undefined ? {} : { account_id: values.accountId }),
		routes: [{ pattern: values.hostname, custom_domain: true }],
		vars: {
			...vars,
			HARBOUR_ACCESS_TEAM_DOMAIN: values.accessTeamDomain,
			HARBOUR_ACCESS_AUD: values.accessAud,
			HARBOUR_ADMIN_EMAIL: values.adminEmail,
		},
		vpc_services: [{ binding: MODELS_BINDING, service_id: values.modelsVpcServiceId }],
	};
}

async function main(): Promise<void> {
	const { values: args } = parseArgs({
		options: { mode: { type: "string" }, out: { type: "string", default: "wrangler.deploy.json" } },
	});
	const mode = args.mode;
	if (mode !== "deploy" && mode !== "dry-run") throw new Error("Pass --mode deploy or --mode dry-run");
	// Wrangler's own JSONC reader, so the comments in wrangler.jsonc are read exactly as wrangler reads them.
	const { experimental_readRawConfig } = await import("wrangler");
	const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
	const values = deployValues(process.env, mode);
	const out = resolve(args.out);
	writeFileSync(out, `${JSON.stringify(deployConfig(rawConfig, values), null, "\t")}\n`);
	console.log(`Wrote ${out} for ${mode === "deploy" ? `a deploy to ${values.hostname}` : "a dry run"}`);
	if (values.placeholders.length > 0) {
		console.log(`Placeholders (not set yet): ${values.placeholders.join(", ")}`);
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
