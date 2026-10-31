// The M1 gateway: `bun src/gateway/main.ts` (or `pnpm --filter @harbour/selfhosted gateway`). It mounts the session,
// workspace read and audit query APIs behind the API-key authenticator and serves the console. Configuration is
// environment only:
//
//   PORT                        default 8080
//   HOST                        the address to listen on; default 0.0.0.0. 127.0.0.1 on the host's network
//   HARBOUR_CONSOLE_DIR         the console's build; default apps/console/dist in this checkout
//   HARBOUR_BOOTSTRAP_FILE      where the bootstrap's IDs and API key are written (mode 0600), and read back on the
//                               next start; default .harbour/bootstrap.json under the working directory
//   HARBOUR_DATABASE_URL        Postgres for the real components (durable.ts); unset, everything is in memory
//   HARBOUR_GATEWAY_SCHEMA      the schema their tables go in; default harbour_m1
//   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION
//                               where workspace trees go; required with HARBOUR_DATABASE_URL
//   HARBOUR_GATEWAY_S3_PREFIX   their key prefix in the bucket; default m1/workspaces/
//   HARBOUR_SKILLS_S3_PREFIX    the key prefix of skill files' bodies in the same bucket; default m1/skills/
//   HARBOUR_ORGANISATION_NAME   default "Harbour"
//   HARBOUR_PROJECT_NAME        default "default"
//   HARBOUR_PROJECTS            comma-separated names of more projects, such as the Docket workspaces of the Sal next to
//                               it (`sal,dev`): each made once and found by name after that, all on the bootstrap's
//                               operator key, and named with their IDs in the bootstrap file. Naming a new one issues a
//                               new key over them all and revokes the old one
//   HARBOUR_CALLBACK_ORIGINS    comma-separated origins host-tool callbacks may use, each `scheme://host[:port]` or
//                               `scheme://host:*` for any port on that host (callbacks.ts); default any https: URL.
//                               Next to Sal: `http://127.0.0.1:*`, where Sal's worker serves its host tools
//   HARBOUR_SMTP_URL            where sign-in codes are sent (see mail.ts); unset, sign-in by email answers 503
//   HARBOUR_MAIL_FROM           their From address; required with HARBOUR_SMTP_URL
//   HARBOUR_ADMIN_EMAIL         invited as an organisation admin at start, unless someone can already sign in with it,
//                               so a person can sign in by email one-time PIN (Harbour is invite-only)
//   HARBOUR_VAULT_CIPHER_KEY    the vault's 256-bit key, base64, sealing item values in Postgres; without it a gateway on
//                               Postgres has no vault (in memory, the vault has a random key of its own)
//   HARBOUR_EGRESS_KEY          the egress proxy's shared key (16 characters or more): mounts /v1/egress/decisions and
//                               /v1/egress/scope for it (egress.ts). Needs a vault
//   HARBOUR_EGRESS_GRANTS_FILE  the proxy's policy file, whose credentialed routes are imported into the vault for the
//                               bootstrap project at start; the secrets they name are read from this environment
//   HARBOUR_CPA_URL             CLIProxyAPI's API root with its /v1, such as http://127.0.0.1:8317/v1: sessions go to
//   HARBOUR_CPA_API_KEY         it through the model gateway (models.ts), with its client key (16 characters or more)
//                               kept in the vault, so it needs a vault. Both or neither; unset, the echo model
//   HARBOUR_MODEL_CONNECTORS, HARBOUR_MODEL_CONNECTORS_FILE
//                               instead of CPA, the platform model connectors as JSON (or a path to it): connectors of
//                               any preset, such as one LiteLLM, each naming the variable its key is in (apiKeyEnv),
//                               and optionally routes (models.ts, `modelConnectorsConfig`). Needs a vault too
//   HARBOUR_DEFAULT_MODEL       the model the `default` route serves, on CPA or on the first connector when the
//                               connectors config lists no routes; default claude-sonnet-5-5
//   HARBOUR_BROWSER_PROVIDER, HARBOUR_BROWSER_HOST_URL, HARBOUR_BROWSER_HOST_TOKEN, HARBOUR_BROWSER_VIEW_KEY,
//   HARBOUR_EMBED_ORIGINS, HARBOUR_BRWSR_API_KEY, HARBOUR_BRWSR_API_URL
//                               the sessions' browser (browser.ts): Harbour's own, on the browser host, or brwsr's.
//                               Unset, sessions have no browser
//   HARBOUR_PUBLIC_URL          where people reach the console, such as https://harbour.example.com: an embed link is
//                               made absolute against it, and passkeys are made for it. Default: the request's own
//                               origin, which is `http:`, so set it behind a TLS proxy
//   HARBOUR_CONNECTIONS, HARBOUR_CONNECTIONS_CIMD, HARBOUR_CONNECTIONS_PERSONAL
//                               connections (connections.ts, epic #322), on with HARBOUR_PUBLIC_URL and a vault unless
//                               HARBOUR_CONNECTIONS is `off`; CIMD `on` once the client metadata document is public
//
// It runs on node:http, so it needs nothing Bun-specific; the image runs it on Bun like the session hosts.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserBinding, browserConfig, createBrowserViews, gatewayBrowserProvider } from "./browser.ts";
import { callbackUrlAllowed, parseCallbackOrigins } from "./callbacks.ts";
import { type Bootstrap, bootstrap, createGatewayComponents } from "./components.ts";
import { connectionsConfig } from "./connections.ts";
import { createDurableGatewayComponents, type DurableConfig } from "./durable.ts";
import { importPolicyFile } from "./egress.ts";
import { createGateway } from "./gateway.ts";
import { createMailer, describeMail, mailConfig, plausibleAddress } from "./mail.ts";
import {
	type ConnectorItems,
	CPA_CONNECTOR_ID,
	describeConnectorProbe,
	modelGatewaySource,
	platformModels,
	probeConnector,
} from "./models.ts";
import { listen } from "./node-http.ts";
import { usageConfig } from "./usage.ts";

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env) {
	const origins = parseCallbackOrigins(env.HARBOUR_CALLBACK_ORIGINS);
	const adminEmail = env.HARBOUR_ADMIN_EMAIL?.trim() ?? "";
	if (adminEmail !== "" && !plausibleAddress(adminEmail)) throw new Error("HARBOUR_ADMIN_EMAIL must be one address");
	const egressKey = env.HARBOUR_EGRESS_KEY?.trim() ?? "";
	if (egressKey !== "" && egressKey.length < 16) throw new Error("HARBOUR_EGRESS_KEY must be 16 characters or more");
	const grantsFile = env.HARBOUR_EGRESS_GRANTS_FILE?.trim() ?? "";
	if (grantsFile !== "" && egressKey === "") throw new Error("HARBOUR_EGRESS_GRANTS_FILE needs HARBOUR_EGRESS_KEY");
	const models = platformModels(env);
	const durable = durableConfig(env);
	if (models !== undefined && durable !== undefined && durable.vaultCipherKey === undefined) {
		const keys = models.connectors.map((connector) => connector.keyVariable).join(", ");
		throw new Error(
			`${keys} ${models.connectors.length === 1 ? "is" : "are"} kept in the vault: set HARBOUR_VAULT_CIPHER_KEY`,
		);
	}
	const browser = browserConfig(env);
	const publicUrl = env.HARBOUR_PUBLIC_URL?.trim() ?? "";
	if (publicUrl !== "" && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
		throw new Error("HARBOUR_PUBLIC_URL must be an origin, such as https://harbour.example.com");
	}
	const connections = connectionsConfig(env, publicUrl === "" ? undefined : new URL(publicUrl).origin);
	return {
		...(browser === undefined ? {} : { browser }),
		...(connections === undefined ? {} : { connections }),
		...(publicUrl === "" ? {} : { publicOrigin: new URL(publicUrl).origin }),
		port: Number(env.PORT ?? "8080"),
		host: env.HOST?.trim() || "0.0.0.0",
		consoleDir: env.HARBOUR_CONSOLE_DIR ?? fileURLToPath(new URL("../../../console/dist", import.meta.url)),
		bootstrapFile: resolve(env.HARBOUR_BOOTSTRAP_FILE ?? ".harbour/bootstrap.json"),
		organisation: env.HARBOUR_ORGANISATION_NAME ?? "Harbour",
		project: env.HARBOUR_PROJECT_NAME ?? "default",
		projects: projectList(env.HARBOUR_PROJECTS),
		...(adminEmail === "" ? {} : { adminEmail }),
		callbackOrigins: origins,
		mail: mailConfig(env),
		durable,
		...(models === undefined ? {} : { models }),
		...(egressKey === ""
			? {}
			: { egress: { key: egressKey, ...(grantsFile === "" ? {} : { grantsFile: resolve(grantsFile) }) } }),
	};
}

/**
 * Writes `content` to `path` readable by its owner only, whatever was there before: a new file with mode 0600 in the
 * same directory, renamed over the old one, so the secret never sits in a file with wider permissions.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
		// The mode passed to writeFile is masked by the umask; set it outright.
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** HARBOUR_PROJECTS: comma-separated project names, each once. */
export function projectList(value: string | undefined): string[] {
	return [...new Set((value ?? "").split(",").map((name) => name.trim()))].filter((name) => name !== "");
}

/** The real components' configuration, or undefined (in memory) when HARBOUR_DATABASE_URL is unset. */
export function durableConfig(env: NodeJS.ProcessEnv = process.env): DurableConfig | undefined {
	const databaseUrl = env.HARBOUR_DATABASE_URL?.trim() ?? "";
	if (databaseUrl === "") return undefined;
	const need = (name: string) => {
		const value = env[name]?.trim() ?? "";
		if (value === "") throw new Error(`${name} is required with HARBOUR_DATABASE_URL`);
		return value;
	};
	const region = env.S3_REGION?.trim();
	const vaultCipherKey = env.HARBOUR_VAULT_CIPHER_KEY?.trim() ?? "";
	const usage = usageConfig(env);
	return {
		...(vaultCipherKey === "" ? {} : { vaultCipherKey }),
		...(usage === undefined ? {} : { usage }),
		databaseUrl,
		schema: env.HARBOUR_GATEWAY_SCHEMA?.trim() || "harbour_m1",
		s3: {
			endpoint: need("S3_ENDPOINT"),
			bucket: need("S3_BUCKET"),
			accessKeyId: need("S3_ACCESS_KEY"),
			secretAccessKey: need("S3_SECRET_KEY"),
			...(region ? { region } : {}),
			prefix: env.HARBOUR_GATEWAY_S3_PREFIX?.trim() || "m1/workspaces/",
			skillsPrefix: env.HARBOUR_SKILLS_S3_PREFIX?.trim() || "m1/skills/",
		},
	};
}

/** What the last start wrote to the bootstrap file, if anything readable. */
async function readBootstrap(path: string): Promise<Bootstrap | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Bootstrap>;
		const fields = ["organisationId", "projectId", "workspaceId", "apiKey"] as const;
		return fields.every((field) => typeof parsed[field] === "string") ? (parsed as Bootstrap) : undefined;
	} catch {
		return undefined;
	}
}

export async function serveGateway(cfg = gatewayConfig()) {
	const modelGateway = cfg.models === undefined ? undefined : modelGatewaySource(cfg.models);
	const browser =
		cfg.browser === undefined
			? {}
			: { browserProvider: gatewayBrowserProvider(cfg.browser), browserBinding: browserBinding(cfg.browser) };
	const components =
		cfg.durable === undefined
			? createGatewayComponents({
					...(modelGateway === undefined ? {} : { modelGateway }),
					...browser,
					...(cfg.connections === undefined ? {} : { connections: cfg.connections }),
				})
			: await createDurableGatewayComponents({
					...cfg.durable,
					...(modelGateway === undefined ? {} : { modelGateway }),
					...browser,
					...(cfg.connections === undefined ? {} : { connections: cfg.connections }),
				});
	const browserViews = cfg.browser?.provider === "harbour" ? createBrowserViews(cfg.browser) : undefined;
	const previous = await readBootstrap(cfg.bootstrapFile);
	let seeded = await bootstrap(
		components,
		{
			organisation: cfg.organisation,
			project: cfg.project,
			projects: cfg.projects,
			...(cfg.adminEmail === undefined ? {} : { adminEmail: cfg.adminEmail }),
		},
		previous,
	);
	const scope = { organisationId: seeded.organisationId, projectId: seeded.projectId };
	if (cfg.egress !== undefined && components.vault === undefined) {
		throw new Error("HARBOUR_EGRESS_KEY needs a vault: set HARBOUR_VAULT_CIPHER_KEY");
	}
	// What this deployment imported before; a new one (a fresh database) starts with an empty vault.
	const before = previous?.organisationId === seeded.organisationId ? previous.egressGrants : undefined;
	if (before !== undefined) seeded = { ...seeded, egressGrants: before };
	if (cfg.egress?.grantsFile !== undefined && components.vault !== undefined) {
		const imported = await importPolicyFile(components.vault, scope, cfg.egress.grantsFile, process.env, before);
		seeded = { ...seeded, egressGrants: imported.digest };
		console.log(
			imported.result === undefined
				? `[gateway] egress grants from ${cfg.egress.grantsFile} already imported on this deployment's first start` +
						(imported.changed
							? "; the file has changed since, and is not imported again: change grants on the vault page"
							: "")
				: `[gateway] imported egress grants from ${cfg.egress.grantsFile}: ` +
						imported.result.imported.map((grant) => `${grant.name} (${grant.item})`).join(", ") +
						`; left to the proxy: ${imported.leftToProxy.join(", ") || "none"}`,
		);
	}
	if (modelGateway !== undefined && cfg.models !== undefined) {
		const models = cfg.models;
		// The items an earlier start of this deployment made; a fresh database has none. A file from before
		// `modelItems` has only CPA's.
		const made: ConnectorItems =
			previous !== undefined && previous.organisationId === seeded.organisationId
				? {
						...(previous.cpaItem === undefined ? {} : { [CPA_CONNECTOR_ID]: previous.cpaItem }),
						...previous.modelItems,
					}
				: {};
		const items = await modelGateway.seed(components.vault, made);
		const cpaItem = items[CPA_CONNECTOR_ID];
		seeded = { ...seeded, modelItems: items, ...(cpaItem === undefined ? {} : { cpaItem }) };
		for (const connector of models.connectors) {
			const routes = models.routes
				.filter((route) => route.connectorId === connector.id)
				.map((route) => `${route.name} to ${route.modelId}`);
			console.log(
				`[gateway] sessions on the model gateway: connector ${connector.id} (${connector.preset}) at ` +
					`${connector.baseUrl}, route${routes.length === 1 ? "" : "s"} ${routes.join(", ") || "(none)"}, its key ` +
					`in vault item ${items[connector.id]?.name}`,
			);
			// Not fatal: the upstream may come up after the gateway. A wrong key otherwise shows only as `no_model` on
			// every session.
			const probe = await probeConnector(models, connector);
			(probe.result === "ok" ? console.log : console.warn)(describeConnectorProbe(models, connector, probe));
		}
	}
	await writePrivateFile(cfg.bootstrapFile, `${JSON.stringify(seeded, null, "\t")}\n`);

	const gateway = createGateway({
		components,
		consoleDir: cfg.consoleDir,
		...(cfg.mail === undefined ? {} : { mail: describeMail(cfg.mail), mailer: createMailer(cfg.mail) }),
		...(cfg.callbackOrigins.length === 0 ? {} : { allowCallbackUrl: callbackUrlAllowed(cfg.callbackOrigins) }),
		...(cfg.egress === undefined ? {} : { egress: { key: cfg.egress.key, scope } }),
		...(browserViews === undefined ? {} : { browserViews }),
		...(cfg.browser?.provider === "harbour" && cfg.browser.embedOrigins !== undefined
			? { embedOrigins: cfg.browser.embedOrigins }
			: {}),
		...(cfg.publicOrigin === undefined ? {} : { publicOrigin: cfg.publicOrigin }),
	});
	const server = await listen(gateway.fetch, cfg.port, {
		host: cfg.host,
		...(browserViews === undefined
			? {}
			: { onUpgrade: (incoming, socket, head) => browserViews.upgrade(incoming, socket, head) }),
	});
	console.log(
		`[gateway] listening on ${server.port}; organisation ${seeded.organisationId}, project ${seeded.projectId}` +
			`${seeded.projects === undefined ? "" : `, projects ${JSON.stringify(seeded.projects)}`}; ` +
			`bootstrap key in ${cfg.bootstrapFile}; bindings ${JSON.stringify(components.bindings)}; ` +
			`mail ${cfg.mail === undefined ? "off" : JSON.stringify(describeMail(cfg.mail))}`,
	);

	const shutdown = async () => {
		await gateway.close();
		await server.close();
		await components.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await serveGateway();
}
