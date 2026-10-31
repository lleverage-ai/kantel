/**
 * Writes `wrangler.deploy.json`, the config the deploy workflow (.github/workflows/cloudflare-deploy.yml) hands to
 * wrangler: `wrangler.jsonc` plus what only the deployment knows, from the repository variables in #17's Account setup.
 * Wrangler's config can't read environment variables, so this fills them in:
 *
 * - `account_id` from `CLOUDFLARE_ACCOUNT_ID`;
 * - the zone route `<KANTEL_HOSTNAME>/*` on the hostname's zone (console and gateway on one hostname);
 * - the Access team domain and AUD, and the first admin's email, as vars;
 * - the `MODELS` VPC service binding (CLIProxyAPI through the `sal-app` tunnel) from `KANTEL_MODELS_VPC_SERVICE_ID`;
 * - optionally, personal connections in every session for a deployment with one person (`KANTEL_CONNECTIONS_PERSONAL`,
 *   as the var of the same name);
 * - optionally, client ID metadata documents offered to authorisation servers (`KANTEL_CONNECTIONS_CIMD`, as the var
 *   of the same name), once a Cloudflare Access Bypass covers the document's path;
 * - optionally, where the data lives (`OPTIONAL_DEPLOY_VARIABLES`): another D1 database for `DB`
 *   (`KANTEL_D1_DATABASE_NAME` with its `KANTEL_D1_DATABASE_ID`), another bucket for `WORKSPACES`
 *   (`KANTEL_R2_BUCKET`), and the objects' location hint (`KANTEL_LOCATION_HINT`). Unset, `wrangler.jsonc`'s own
 *   names and hint stand, so the deploy binds exactly what it did before. They exist so data made in another region
 *   can be swapped in without a code change; the database and bucket must exist first, or wrangler's automatic
 *   provisioning creates a bucket of that name wherever it likes (the database is bound by ID, so a wrong one fails).
 *
 * `--mode deploy` needs every variable and refuses to write a config without them. `--mode dry-run` fills a missing
 * one with a placeholder, so `wrangler deploy --dry-run` still checks the whole config's shape before the account is
 * set up. The `dev` environment is dropped: it is local only and never deployed.
 *
 * Usage: node scripts/deploy-config.ts --mode deploy|dry-run [--out wrangler.deploy.json]
 */
// First: HARBOUR_* settings from before the rename still count (TASK-4231).
import "@kantel/contracts/legacy-env";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { VAULT_SECRETS } from "./vault-secrets.ts";

export const DEPLOY_VARIABLES = [
	"CLOUDFLARE_ACCOUNT_ID",
	"KANTEL_HOSTNAME",
	"KANTEL_ACCESS_TEAM_DOMAIN",
	"KANTEL_ACCESS_AUD",
	"KANTEL_MODELS_VPC_SERVICE_ID",
	"KANTEL_ADMIN_EMAIL",
] as const;

export type DeployVariable = (typeof DEPLOY_VARIABLES)[number];

/** Set only to move the data: each overrides what `wrangler.jsonc` names. */
export const OPTIONAL_DEPLOY_VARIABLES = [
	"KANTEL_D1_DATABASE_NAME",
	"KANTEL_D1_DATABASE_ID",
	"KANTEL_R2_BUCKET",
	"KANTEL_LOCATION_HINT",
	// Kantel's own browsers (src/browser-object.ts): `on` adds their container app (images/browser, held to WEUR), and
	// KANTEL_BROWSER_PROVIDER says which provider the broker uses (`brwsr` unless it says `harbour`).
	"KANTEL_BROWSER_CONTAINERS",
	"KANTEL_BROWSER_PROVIDER",
	// The container tier (src/sandbox-object.ts): `on` adds its container app (images/sandbox, held to WEUR) and turns
	// escalation on (the KANTEL_SANDBOX_CONTAINERS var).
	"KANTEL_SANDBOX_CONTAINERS",
	// The origins (such as a host app's) that may frame a browser's embed page, besides the console.
	"KANTEL_EMBED_ORIGINS",
	// `on` for a deployment with one person (src/connections.ts): every session acting for them is theirs alone, so
	// their personal connections work in all their sessions. Unset or `off`, a session is seen by its project.
	"KANTEL_CONNECTIONS_PERSONAL",
	// `on` once `/v1/connections/oauth/client-metadata.json` is reachable without signing in (an Access Bypass on only
	// that path): authorisation servers that support CIMD then fetch it, before Kantel tries DCR (#338).
	"KANTEL_CONNECTIONS_CIMD",
	// The deployment's own OAuth clients (src/connections.ts, #326): a JSON array of
	// `{ templateId?, issuer?, clientId, secretEnv?, scopes?, label? }`. Public clients need nothing else; a confidential
	// one's secret is a Worker secret named by its `secretEnv`, never in this variable.
	"KANTEL_OAUTH_CLIENTS",
] as const;
export type OptionalDeployVariable = (typeof OPTIONAL_DEPLOY_VARIABLES)[number];

/** The D1 and R2 bindings the optional variables point elsewhere. */
export const D1_BINDING = "DB";
export const R2_BINDING = "WORKSPACES";

/** Durable Objects' location hints, as `src/route.ts`'s `LOCATION_HINTS` (a test keeps the two the same). */
export const LOCATION_HINTS = [
	"wnam",
	"enam",
	"sam",
	"weur",
	"eeur",
	"apac",
	"apac-ne",
	"apac-se",
	"oc",
	"afr",
	"me",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPTIONAL_CHECKS: Readonly<
	Record<OptionalDeployVariable, { readonly test: (value: string) => boolean; readonly expect: string }>
> = {
	KANTEL_D1_DATABASE_NAME: {
		test: (v) => /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(v),
		expect: "a D1 database name (lower-case letters, digits, hyphens and underscores)",
	},
	KANTEL_D1_DATABASE_ID: { test: (v) => UUID.test(v), expect: "the D1 database's ID (a UUID)" },
	KANTEL_R2_BUCKET: {
		test: (v) => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v),
		expect: "an R2 bucket name (3-63 lower-case letters, digits and hyphens)",
	},
	KANTEL_LOCATION_HINT: {
		test: (v) => (LOCATION_HINTS as readonly string[]).includes(v),
		expect: `one of ${LOCATION_HINTS.join(", ")}`,
	},
	KANTEL_BROWSER_CONTAINERS: { test: (v) => v === "on" || v === "off", expect: "on or off" },
	KANTEL_SANDBOX_CONTAINERS: { test: (v) => v === "on" || v === "off", expect: "on or off" },
	KANTEL_BROWSER_PROVIDER: { test: (v) => v === "brwsr" || v === "harbour", expect: "brwsr or harbour" },
	KANTEL_CONNECTIONS_PERSONAL: { test: (v) => v === "on" || v === "off", expect: "on or off" },
	KANTEL_CONNECTIONS_CIMD: { test: (v) => v === "on" || v === "off", expect: "on or off" },
	KANTEL_OAUTH_CLIENTS: {
		test: (v) => {
			try {
				return Array.isArray(JSON.parse(v));
			} catch {
				return false;
			}
		},
		expect: "a JSON array of OAuth clients",
	},
	KANTEL_EMBED_ORIGINS: {
		test: (v) => v.split(/[\s,]+/).every((origin) => /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(origin)),
		expect: "https:// origins without a path or wildcard, separated by spaces or commas",
	},
};

/**
 * The browsers' container app: images/browser, one container per `KantelBrowser`, held to WEUR beside the stack
 * (a Durable Object's location hint doesn't place its container; only the app's regions do). 1 vCPU and 3 GiB, as
 * brwsr's browsers, which a live view needs.
 */
export const BROWSER_CONTAINERS = [
	{
		class_name: "HarbourBrowser",
		image: "../../images/browser/Dockerfile",
		image_build_context: "../../images/browser",
		instance_type: { vcpu: 1, memory_mib: 3072, disk_mb: 4000 },
		constraints: { regions: ["WEUR"] },
		max_instances: 3,
	},
] as const;
/**
 * The sandbox containers' app: images/sandbox, one container per session's `KantelSandbox`, held to WEUR beside the
 * stack. 1 vCPU and 3 GiB (Cloudflare's least memory for a custom 1 vCPU instance), enough for `npm install`, a native
 * build or `pandoc`; the disk holds the 1.7 GB image and a working copy.
 */
export const SANDBOX_CONTAINERS = [
	{
		class_name: "HarbourSandbox",
		image: "../../images/sandbox/Dockerfile",
		image_build_context: "../../images/sandbox",
		instance_type: { vcpu: 1, memory_mib: 3072, disk_mb: 8000 },
		constraints: { regions: ["WEUR"] },
		max_instances: 10,
	},
] as const;
/**
 * Why Cloudflare would refuse a custom instance type, or undefined. Its limits
 * (https://developers.cloudflare.com/containers/platform-details/limits/): 1 to 4 vCPU, at least 3 GiB of memory per
 * vCPU and at most 12 GiB, at most 20 GB of disk. `wrangler deploy --dry-run` doesn't check them, so a bad size fails
 * only the real deploy, after the Worker is uploaded.
 */
export function instanceTypeProblem(type: {
	readonly vcpu: number;
	readonly memory_mib: number;
	readonly disk_mb: number;
}): string | undefined {
	if (type.vcpu < 1 || type.vcpu > 4) return `vcpu ${type.vcpu} is outside 1 to 4`;
	if (type.memory_mib < type.vcpu * 3072) return `memory ${type.memory_mib} MiB is under 3 GiB per vCPU`;
	if (type.memory_mib > 12 * 1024) return `memory ${type.memory_mib} MiB is over 12 GiB`;
	if (type.disk_mb > 20_000) return `disk ${type.disk_mb} MB is over 20 GB`;
	return undefined;
}

export type DeployMode = "deploy" | "dry-run";

/** The binding name the model gateway will use for CLIProxyAPI (step 2 of #17). */
export const MODELS_BINDING = "MODELS";

/** Stand-ins for a dry run before the account is set up. Never deployed: deploy mode refuses a missing variable. */
const PLACEHOLDERS: Readonly<Record<Exclude<DeployVariable, "CLOUDFLARE_ACCOUNT_ID">, string>> = {
	KANTEL_HOSTNAME: "harbour.example.com",
	KANTEL_ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
	KANTEL_ACCESS_AUD: "0000000000000000000000000000000000000000000000000000000000000000",
	KANTEL_MODELS_VPC_SERVICE_ID: "00000000-0000-0000-0000-000000000000",
	KANTEL_ADMIN_EMAIL: "admin@example.com",
};

/** A host name with at least two labels, each 1-63 letters, digits or inner hyphens, ending in a letter label. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The zone `KANTEL_HOSTNAME` is routed on: its parent, so `harbour.myslop.app` is on `myslop.app`. Kantel serves on
 * a direct subdomain of its zone, which the zone's proxied wildcard DNS record already resolves.
 */
export function zoneOf(hostname: string): string {
	return hostname.slice(hostname.indexOf(".") + 1);
}

/** A plain address: a local part without spaces or a second @, at a valid host name. */
function isEmail(value: string): boolean {
	const at = value.lastIndexOf("@");
	if (at <= 0) return false;
	const local = value.slice(0, at);
	return /^[^\s@]{1,64}$/.test(local) && HOST.test(value.slice(at + 1));
}

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
		KANTEL_HOSTNAME: {
			// At least three labels: a subdomain of its zone, never the zone's apex.
			test: (v) => HOST.test(v) && v.split(".").length >= 3,
			expect: "a host name such as harbour.myslop.app (a subdomain of its zone), no scheme or path",
		},
		KANTEL_ACCESS_TEAM_DOMAIN: {
			test: (v) => HOST.test(hostOnly(v)),
			expect: "the Access team domain, such as <team>.cloudflareaccess.com",
		},
		KANTEL_ACCESS_AUD: {
			test: (v) => /^[0-9a-f]{32,128}$/i.test(v),
			expect: "the Access application's AUD tag (hex)",
		},
		KANTEL_MODELS_VPC_SERVICE_ID: {
			test: (v) => UUID.test(v),
			expect: "the Workers VPC service's ID (a UUID)",
		},
		KANTEL_ADMIN_EMAIL: { test: isEmail, expect: "an email address" },
	};

export interface DeployValues {
	/** Absent only in a dry run, which needs no account. */
	readonly accountId?: string;
	readonly hostname: string;
	readonly accessTeamDomain: string;
	readonly accessAud: string;
	readonly modelsVpcServiceId: string;
	readonly adminEmail: string;
	/** Another D1 database for `DB`, when set. */
	readonly d1?: { readonly name: string; readonly id: string };
	/** Another bucket for `WORKSPACES`, when set. */
	readonly r2Bucket?: string;
	/** The objects' location hint, when set. */
	readonly locationHint?: string;
	/** Whether the browsers' container app is deployed. */
	readonly browserContainers?: boolean;
	readonly sandboxContainers?: boolean;
	/** The browser provider, when set. */
	readonly browserProvider?: string;
	/** The origins that may frame a browser's embed page, when set. */
	readonly embedOrigins?: string;
	/** Whether every session acting for a person is theirs alone (a deployment with one person). */
	readonly connectionsPersonal?: boolean;
	/** Whether the client ID metadata document is public, so CIMD is offered (#338). */
	readonly connectionsCimd?: boolean;
	/** `KANTEL_OAUTH_CLIENTS`, as given. */
	readonly oauthClients?: string;
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
	const optional = (name: OptionalDeployVariable): string | undefined => {
		const given = (env[name] ?? "").trim();
		return given === "" ? undefined : given;
	};
	for (const name of OPTIONAL_DEPLOY_VARIABLES) {
		const given = optional(name);
		if (given !== undefined && !OPTIONAL_CHECKS[name].test(given)) {
			invalid.push(`${name} must be ${OPTIONAL_CHECKS[name].expect}`);
		}
	}
	const d1Name = optional("KANTEL_D1_DATABASE_NAME");
	const d1Id = optional("KANTEL_D1_DATABASE_ID");
	// Bound by ID as well as name, so a database that doesn't exist fails the deploy instead of being created.
	if ((d1Name === undefined) !== (d1Id === undefined)) {
		invalid.push("Set both KANTEL_D1_DATABASE_NAME and KANTEL_D1_DATABASE_ID, or neither");
	}
	if (invalid.length > 0) throw new Error(invalid.join("; "));
	const r2Bucket = optional("KANTEL_R2_BUCKET");
	const hint = optional("KANTEL_LOCATION_HINT");

	const value = (name: Exclude<DeployVariable, "CLOUDFLARE_ACCOUNT_ID">): string =>
		missing.includes(name) ? PLACEHOLDERS[name] : (env[name] ?? "").trim();
	const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
	return {
		...(accountId === "" ? {} : { accountId }),
		hostname: value("KANTEL_HOSTNAME").toLowerCase(),
		accessTeamDomain: hostOnly(value("KANTEL_ACCESS_TEAM_DOMAIN")).toLowerCase(),
		accessAud: value("KANTEL_ACCESS_AUD"),
		modelsVpcServiceId: value("KANTEL_MODELS_VPC_SERVICE_ID"),
		adminEmail: value("KANTEL_ADMIN_EMAIL"),
		...(d1Name === undefined || d1Id === undefined ? {} : { d1: { name: d1Name, id: d1Id.toLowerCase() } }),
		...(r2Bucket === undefined ? {} : { r2Bucket }),
		...(hint === undefined ? {} : { locationHint: hint }),
		...(optional("KANTEL_BROWSER_CONTAINERS") === "on" ? { browserContainers: true } : {}),
		...(optional("KANTEL_SANDBOX_CONTAINERS") === "on" ? { sandboxContainers: true } : {}),
		...(optional("KANTEL_BROWSER_PROVIDER") === undefined
			? {}
			: { browserProvider: optional("KANTEL_BROWSER_PROVIDER") }),
		...(optional("KANTEL_EMBED_ORIGINS") === undefined ? {} : { embedOrigins: optional("KANTEL_EMBED_ORIGINS") }),
		...(optional("KANTEL_CONNECTIONS_PERSONAL") === "on" ? { connectionsPersonal: true } : {}),
		...(optional("KANTEL_CONNECTIONS_CIMD") === "on" ? { connectionsCimd: true } : {}),
		...(optional("KANTEL_OAUTH_CLIENTS") === undefined ? {} : { oauthClients: optional("KANTEL_OAUTH_CLIENTS") }),
		placeholders: missing,
	};
}

/** `list` with the entry for `binding` changed; refuses a list without one. */
function rebind(list: unknown, key: string, binding: string, change: Record<string, string>): unknown[] {
	const entries = Array.isArray(list) ? (list as unknown[]) : [];
	const bound = (entry: unknown) =>
		typeof entry === "object" && entry !== null && (entry as { binding?: unknown }).binding === binding;
	if (!entries.some(bound)) throw new Error(`wrangler.jsonc has no ${key} entry for ${binding} to point elsewhere`);
	return entries.map((entry) => (bound(entry) ? { ...(entry as object), ...change } : entry));
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
	// Every container app, whether this deploy adds it or not, so a dry run catches a size Cloudflare would refuse.
	for (const app of [...BROWSER_CONTAINERS, ...SANDBOX_CONTAINERS]) {
		const problem = instanceTypeProblem(app.instance_type);
		if (problem !== undefined) throw new Error(`${app.class_name}'s container instance type: ${problem}`);
	}
	const { $schema: _schema, env: _env, ...base } = raw;
	const data = {
		...(values.d1 === undefined
			? {}
			: {
					d1_databases: rebind(raw.d1_databases, "d1_databases", D1_BINDING, {
						database_name: values.d1.name,
						database_id: values.d1.id,
					}),
				}),
		...(values.r2Bucket === undefined
			? {}
			: { r2_buckets: rebind(raw.r2_buckets, "r2_buckets", R2_BINDING, { bucket_name: values.r2Bucket }) }),
	};
	const vars = typeof raw.vars === "object" && raw.vars !== null ? raw.vars : {};
	// A var would show the value in the dashboard, and wrangler refuses a var and a secret of one name.
	for (const name of VAULT_SECRETS) {
		if (name in vars) throw new Error(`wrangler.jsonc must not set ${name} as a var: it is a Worker secret`);
	}
	return {
		...base,
		...data,
		...(values.accountId === undefined ? {} : { account_id: values.accountId }),
		// A zone route, not a custom domain: the zone's `*.myslop.app/*` route to `myslop-apps` would take precedence over
		// a custom domain on the same hostname, while between routes the most specific pattern wins (#17, Route).
		routes: [{ pattern: `${values.hostname}/*`, zone_name: zoneOf(values.hostname) }],
		vars: {
			...vars,
			KANTEL_ACCESS_TEAM_DOMAIN: values.accessTeamDomain,
			KANTEL_ACCESS_AUD: values.accessAud,
			KANTEL_ADMIN_EMAIL: values.adminEmail,
			// Connections build their redirect URI and connect URLs from it (src/connections.ts).
			KANTEL_HOSTNAME: values.hostname,
			...(values.locationHint === undefined ? {} : { KANTEL_LOCATION_HINT: values.locationHint }),
			...(values.browserProvider === undefined ? {} : { KANTEL_BROWSER_PROVIDER: values.browserProvider }),
			...(values.embedOrigins === undefined ? {} : { KANTEL_EMBED_ORIGINS: values.embedOrigins }),
			...(values.sandboxContainers === true ? { KANTEL_SANDBOX_CONTAINERS: "on" } : {}),
			...(values.connectionsPersonal === true ? { KANTEL_CONNECTIONS_PERSONAL: "on" } : {}),
			...(values.connectionsCimd === true ? { KANTEL_CONNECTIONS_CIMD: "on" } : {}),
			...(values.oauthClients === undefined ? {} : { KANTEL_OAUTH_CLIENTS: values.oauthClients }),
		},
		...(values.browserContainers === true || values.sandboxContainers === true
			? {
					containers: [
						...(values.browserContainers === true ? BROWSER_CONTAINERS : []),
						...(values.sandboxContainers === true ? SANDBOX_CONTAINERS : []),
					],
				}
			: {}),
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
	const moved = [
		...(values.d1 === undefined ? [] : [`D1 ${values.d1.name} (${values.d1.id})`]),
		...(values.r2Bucket === undefined ? [] : [`R2 ${values.r2Bucket}`]),
		...(values.locationHint === undefined ? [] : [`location hint ${values.locationHint}`]),
	];
	if (moved.length > 0) console.log(`Overridden: ${moved.join(", ")}`);
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
