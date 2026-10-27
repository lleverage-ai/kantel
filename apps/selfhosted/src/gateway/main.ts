// The M1 gateway: `bun src/gateway/main.ts` (or `pnpm --filter @harbour/selfhosted gateway`). It mounts the session,
// workspace read and audit query APIs behind the API-key authenticator and serves the console. Configuration is
// environment only:
//
//   PORT                        default 8080
//   HARBOUR_CONSOLE_DIR         the console's build; default apps/console/dist in this checkout
//   HARBOUR_BOOTSTRAP_FILE      where the in-memory bootstrap's IDs and API key are written (mode 0600);
//                               default .harbour/bootstrap.json under the working directory
//   HARBOUR_ORGANISATION_NAME   default "Harbour"
//   HARBOUR_PROJECT_NAME        default "default"
//   HARBOUR_CALLBACK_ORIGINS    comma-separated origins host-tool callbacks may use; default any https: URL
//
// It runs on node:http, so it needs nothing Bun-specific; the image runs it on Bun like the session hosts.
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, createGatewayComponents } from "./components.ts";
import { createGateway } from "./gateway.ts";
import { listen } from "./node-http.ts";

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env) {
	const origins = (env.HARBOUR_CALLBACK_ORIGINS ?? "")
		.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin !== "");
	return {
		port: Number(env.PORT ?? "8080"),
		consoleDir: env.HARBOUR_CONSOLE_DIR ?? fileURLToPath(new URL("../../../console/dist", import.meta.url)),
		bootstrapFile: resolve(env.HARBOUR_BOOTSTRAP_FILE ?? ".harbour/bootstrap.json"),
		organisation: env.HARBOUR_ORGANISATION_NAME ?? "Harbour",
		project: env.HARBOUR_PROJECT_NAME ?? "default",
		callbackOrigins: origins,
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

export async function serveGateway(cfg = gatewayConfig()) {
	const components = createGatewayComponents();
	const seeded = await bootstrap(components, { organisation: cfg.organisation, project: cfg.project });
	await writePrivateFile(cfg.bootstrapFile, `${JSON.stringify(seeded, null, "\t")}\n`);

	const gateway = createGateway({
		components,
		consoleDir: cfg.consoleDir,
		...(cfg.callbackOrigins.length === 0
			? {}
			: { allowCallbackUrl: (url: URL) => cfg.callbackOrigins.includes(url.origin) }),
	});
	const server = await listen(gateway.fetch, cfg.port);
	console.log(
		`[gateway] listening on ${server.port}; organisation ${seeded.organisationId}, project ${seeded.projectId}; ` +
			`bootstrap key in ${cfg.bootstrapFile}; bindings ${JSON.stringify(components.bindings)}`,
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
