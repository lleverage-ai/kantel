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
//   HARBOUR_ORGANISATION_NAME   default "Harbour"
//   HARBOUR_PROJECT_NAME        default "default"
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
//
// It runs on node:http, so it needs nothing Bun-specific; the image runs it on Bun like the session hosts.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callbackUrlAllowed, parseCallbackOrigins } from "./callbacks.ts";
import { type Bootstrap, bootstrap, createGatewayComponents } from "./components.ts";
import { createDurableGatewayComponents, type DurableConfig } from "./durable.ts";
import { importPolicyFile } from "./egress.ts";
import { createGateway } from "./gateway.ts";
import { createMailer, describeMail, mailConfig, plausibleAddress } from "./mail.ts";
import { listen } from "./node-http.ts";

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env) {
	const origins = parseCallbackOrigins(env.HARBOUR_CALLBACK_ORIGINS);
	const adminEmail = env.HARBOUR_ADMIN_EMAIL?.trim() ?? "";
	if (adminEmail !== "" && !plausibleAddress(adminEmail)) throw new Error("HARBOUR_ADMIN_EMAIL must be one address");
	const egressKey = env.HARBOUR_EGRESS_KEY?.trim() ?? "";
	if (egressKey !== "" && egressKey.length < 16) throw new Error("HARBOUR_EGRESS_KEY must be 16 characters or more");
	const grantsFile = env.HARBOUR_EGRESS_GRANTS_FILE?.trim() ?? "";
	if (grantsFile !== "" && egressKey === "") throw new Error("HARBOUR_EGRESS_GRANTS_FILE needs HARBOUR_EGRESS_KEY");
	return {
		port: Number(env.PORT ?? "8080"),
		host: env.HOST?.trim() || "0.0.0.0",
		consoleDir: env.HARBOUR_CONSOLE_DIR ?? fileURLToPath(new URL("../../../console/dist", import.meta.url)),
		bootstrapFile: resolve(env.HARBOUR_BOOTSTRAP_FILE ?? ".harbour/bootstrap.json"),
		organisation: env.HARBOUR_ORGANISATION_NAME ?? "Harbour",
		project: env.HARBOUR_PROJECT_NAME ?? "default",
		...(adminEmail === "" ? {} : { adminEmail }),
		callbackOrigins: origins,
		mail: mailConfig(env),
		durable: durableConfig(env),
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
	return {
		...(vaultCipherKey === "" ? {} : { vaultCipherKey }),
		databaseUrl,
		schema: env.HARBOUR_GATEWAY_SCHEMA?.trim() || "harbour_m1",
		s3: {
			endpoint: need("S3_ENDPOINT"),
			bucket: need("S3_BUCKET"),
			accessKeyId: need("S3_ACCESS_KEY"),
			secretAccessKey: need("S3_SECRET_KEY"),
			...(region ? { region } : {}),
			prefix: env.HARBOUR_GATEWAY_S3_PREFIX?.trim() || "m1/workspaces/",
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
	const components =
		cfg.durable === undefined ? createGatewayComponents() : await createDurableGatewayComponents(cfg.durable);
	const previous = await readBootstrap(cfg.bootstrapFile);
	let seeded = await bootstrap(
		components,
		{
			organisation: cfg.organisation,
			project: cfg.project,
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
	await writePrivateFile(cfg.bootstrapFile, `${JSON.stringify(seeded, null, "\t")}\n`);

	const gateway = createGateway({
		components,
		consoleDir: cfg.consoleDir,
		...(cfg.mail === undefined ? {} : { mail: describeMail(cfg.mail), mailer: createMailer(cfg.mail) }),
		...(cfg.callbackOrigins.length === 0 ? {} : { allowCallbackUrl: callbackUrlAllowed(cfg.callbackOrigins) }),
		...(cfg.egress === undefined ? {} : { egress: { key: cfg.egress.key, scope } }),
	});
	const server = await listen(gateway.fetch, cfg.port, { host: cfg.host });
	console.log(
		`[gateway] listening on ${server.port}; organisation ${seeded.organisationId}, project ${seeded.projectId}; ` +
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
