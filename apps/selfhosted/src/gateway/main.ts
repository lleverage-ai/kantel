// The gateway: `bun src/gateway/main.ts` (or `pnpm --filter @kantel/selfhosted gateway`). It serves the compute plane
// and Kantel's identity, sign-in and audit APIs, and the console. Configuration is environment only:
//
//   PORT                        default 8080
//   HOST                        the address to listen on; default 0.0.0.0. 127.0.0.1 on the host's network
//   KANTEL_CONSOLE_DIR          the console's build; default apps/console/dist in this checkout
//   KANTEL_BOOTSTRAP_FILE       where the bootstrap's IDs and keys are written (mode 0600), and read back on the next
//                               start; default .harbour/bootstrap.json under the working directory
//   KANTEL_DATABASE_URL         Postgres for identity, sign-in, audit, the compute API's records and the registry of
//                               hosts (durable.ts), so they outlast a restart and gateways over one database share
//                               them; unset, everything is in memory
//   KANTEL_GATEWAY_SCHEMA       the schema their tables go in; default harbour_m1
//   KANTEL_ORGANISATION_NAME    default "Kantel"
//   KANTEL_PROJECT_NAME         default "default"
//   KANTEL_PROJECTS             comma-separated names of more projects: each made once and found by name after that,
//                               all on the bootstrap's operator key, and named with their IDs in the bootstrap file.
//                               Naming a new one issues a new key over them all and revokes the old one
//   KANTEL_SMTP_URL             where sign-in codes are sent (see mail.ts); unset, sign-in by email answers 503
//   KANTEL_MAIL_FROM            their From address; required with KANTEL_SMTP_URL
//   KANTEL_ADMIN_EMAIL          invited as an organisation admin at start, unless someone can already sign in with it,
//                               so a person can sign in by email one-time PIN (Kantel is invite-only)
//   KANTEL_PUBLIC_URL           where people reach the console, such as https://kantel.example.com: invites link to it,
//                               and hosts on other machines reach the gateway there. Default: the request's own origin
//   KANTEL_COMPUTE_BACKEND, KANTEL_COMPUTE_PUBLIC_URL
//                               the compute plane's API (compute.ts, @kantel/compute), always on: accounts, sandboxes,
//                               snapshots, `ksk_` keys, webhooks, OpenTelemetry and hosts; its super-admin key is
//                               `computeKey` in the bootstrap file. Sandboxes run on machines running kantel-host
//                               (@kantel/hosts) wherever KANTEL_COMPUTE_PUBLIC_URL or KANTEL_PUBLIC_URL says where they
//                               reach the gateway, else on the stub; KANTEL_COMPUTE_BACKEND=stub picks the stub. The
//                               other settings are in compute.ts
//
// Settings of the agent plane an older version read (S3_*, KANTEL_VAULT_CIPHER_KEY*, KANTEL_CPA_*, KANTEL_MODEL_*,
// KANTEL_BROWSER_*, KANTEL_CONNECTIONS*, KANTEL_EGRESS_*, KANTEL_SUBAGENTS and the rest) are ignored, and what they
// pointed at is left as it is.
//
// It runs on node:http, so it needs nothing Bun-specific; the image runs it on Bun.
// First: HARBOUR_* settings from before the rename still count.
import "@kantel/contracts/legacy-env";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { kantelSessionProvider } from "@kantel/identity/otp";
import { type Bootstrap, bootstrap, createGatewayComponents } from "./components.ts";
import { computeConfig, gatewayCompute, portRouterFor, withHostUpgrades } from "./compute.ts";
import { createDurableGatewayComponents, type DurableConfig } from "./durable.ts";
import { createGateway } from "./gateway.ts";
import { createMailer, describeMail, mailConfig, plausibleAddress } from "./mail.ts";
import { listen } from "./node-http.ts";

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env) {
	const adminEmail = env.KANTEL_ADMIN_EMAIL?.trim() ?? "";
	if (adminEmail !== "" && !plausibleAddress(adminEmail)) throw new Error("KANTEL_ADMIN_EMAIL must be one address");
	const publicUrl = env.KANTEL_PUBLIC_URL?.trim() ?? "";
	if (publicUrl !== "" && !/^https?:\/\/[^/]+\/?$/.test(publicUrl)) {
		throw new Error("KANTEL_PUBLIC_URL must be an origin, such as https://kantel.example.com");
	}
	return {
		compute: computeConfig(env),
		...(publicUrl === "" ? {} : { publicOrigin: new URL(publicUrl).origin }),
		port: Number(env.PORT ?? "8080"),
		host: env.HOST?.trim() || "0.0.0.0",
		consoleDir: env.KANTEL_CONSOLE_DIR ?? fileURLToPath(new URL("../../../console/dist", import.meta.url)),
		bootstrapFile: resolve(env.KANTEL_BOOTSTRAP_FILE ?? ".harbour/bootstrap.json"),
		organisation: env.KANTEL_ORGANISATION_NAME ?? "Kantel",
		project: env.KANTEL_PROJECT_NAME ?? "default",
		projects: projectList(env.KANTEL_PROJECTS),
		...(adminEmail === "" ? {} : { adminEmail }),
		mail: mailConfig(env),
		durable: durableConfig(env),
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

/** KANTEL_PROJECTS: comma-separated project names, each once. */
export function projectList(value: string | undefined): string[] {
	return [...new Set((value ?? "").split(",").map((name) => name.trim()))].filter((name) => name !== "");
}

/** The real components' configuration, or undefined (in memory) when KANTEL_DATABASE_URL is unset. */
export function durableConfig(env: NodeJS.ProcessEnv = process.env): DurableConfig | undefined {
	const databaseUrl = env.KANTEL_DATABASE_URL?.trim() ?? "";
	if (databaseUrl === "") return undefined;
	return { databaseUrl, schema: env.KANTEL_GATEWAY_SCHEMA?.trim() || "harbour_m1" };
}

/** What the last start wrote to the bootstrap file, if anything readable; an older version's file reads the same. */
export async function readBootstrap(path: string): Promise<Bootstrap | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Bootstrap>;
		const fields = ["organisationId", "projectId", "apiKey"] as const;
		return fields.every((field) => typeof parsed[field] === "string") ? (parsed as Bootstrap) : undefined;
	} catch {
		return undefined;
	}
}

export async function serveGateway(cfg = gatewayConfig()) {
	const computeHosts = cfg.compute.hosts;
	const components =
		cfg.durable === undefined
			? createGatewayComponents(computeHosts === undefined ? {} : { computeHosts })
			: await createDurableGatewayComponents({
					...cfg.durable,
					...(computeHosts === undefined ? {} : { computeHosts }),
				});
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
	// The compute plane signs people in as the gateway does, so it and the gateway share one authenticator.
	const authenticator = createAuthenticator({
		identity: components.identity,
		providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
	});
	// With hosts: the registry of hosts, and a fresh secret for this process's tunnel URLs.
	const hosts =
		components.computeHosts === undefined || computeHosts === undefined
			? undefined
			: (() => {
					const service = components.computeHosts;
					const ports = portRouterFor(computeHosts, service);
					return {
						service,
						config: computeHosts,
						tunnelSecret: new Uint8Array(randomBytes(32)),
						...(ports === undefined ? {} : { ports }),
					};
				})();
	const compute = await gatewayCompute({
		authenticator,
		identity: components.identity,
		...(previous?.computeKey === undefined ? {} : { superAdminKey: previous.computeKey }),
		...(cfg.publicOrigin === undefined ? {} : { publicUrl: cfg.publicOrigin }),
		...(hosts === undefined ? {} : { hosts }),
		...(components.computeStore === undefined ? {} : { store: components.computeStore }),
	});
	seeded = { ...seeded, computeKey: compute.superAdminKey };
	console.log(
		`[gateway] compute plane on: ${compute.binding}; the super-admin's key is computeKey in ${cfg.bootstrapFile}`,
	);
	await writePrivateFile(cfg.bootstrapFile, `${JSON.stringify(seeded, null, "\t")}\n`);

	const gateway = createGateway({
		components,
		authenticator,
		compute: compute.api,
		...(compute.hostRoutes === undefined ? {} : { computeHosts: compute.hostRoutes }),
		...(compute.portRoutes === undefined ? {} : { computePorts: compute.portRoutes }),
		consoleDir: cfg.consoleDir,
		...(cfg.mail === undefined ? {} : { mail: describeMail(cfg.mail), mailer: createMailer(cfg.mail) }),
		...(cfg.publicOrigin === undefined ? {} : { publicOrigin: cfg.publicOrigin }),
	});
	const onUpgrade = withHostUpgrades(hosts, undefined);
	const server = await listen(gateway.fetch, cfg.port, {
		host: cfg.host,
		...(onUpgrade === undefined ? {} : { onUpgrade }),
	});
	console.log(
		`[gateway] listening on ${server.port}; organisation ${seeded.organisationId}, project ${seeded.projectId}` +
			`${seeded.projects === undefined ? "" : `, projects ${JSON.stringify(seeded.projects)}`}; ` +
			`bootstrap key in ${cfg.bootstrapFile}; bindings ${JSON.stringify(components.bindings)}; ` +
			`mail ${cfg.mail === undefined ? "off" : JSON.stringify(describeMail(cfg.mail))}`,
	);

	const shutdown = async () => {
		await compute.close();
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
