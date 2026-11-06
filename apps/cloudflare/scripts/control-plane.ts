/**
 * Whether the deploy must make a new version of `harbour`, the control plane's Worker. A new version resets every one
 * of its Durable Objects, and with them every host link, kantel ssh tunnel, desktop, browser and streamed command they
 * hold, so the deploy (.github/workflows/cloudflare-deploy.yml) makes one only when the Worker would differ. The
 * console's files are another Worker's (wrangler.console.jsonc), so a change to the console alone never needs one.
 *
 * The Worker's fingerprint is a SHA-256 over what a version is made of: the bundle `wrangler deploy --dry-run` writes
 * (its `--outdir`, less the dated note wrangler leaves there), the config handed to wrangler (wrangler.deploy.json: bindings, vars, routes), the container apps'
 * build contexts when the config has any, and the secrets file the deploy uploads with it, when there is one. Only the
 * digest is kept, as the version's message (`fingerprint <hex>`); nothing in it reads back to a secret.
 *
 * `harbour` is up to date when every version its latest deployment serves carries this fingerprint. Anything else (no
 * deployment, a version made by hand such as `wrangler secret put`, a gradual rollout of two, an error asking
 * Cloudflare) deploys, as every deploy did before.
 *
 * Usage:
 *   node scripts/control-plane.ts fingerprint --bundle dist/harbour --config wrangler.deploy.json [--secrets-file f]
 *   node scripts/control-plane.ts check --config wrangler.deploy.json --fingerprint <hex>
 *     prints `deploy=true|false` (and appends it to $GITHUB_OUTPUT), with the reason on stderr.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The version message's prefix: `fingerprint <hex>`. */
export const FINGERPRINT_PREFIX = "fingerprint ";

/** The note `wrangler deploy --outdir` leaves, naming the time it built: left out of the fingerprint. */
export const OUTDIR_README = "README.md";

/** Every file under `dir`, as paths relative to it with `/` separators, sorted. */
export function filesUnder(dir: string): string[] {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) found.push(relative(dir, path).split(sep).join("/"));
		}
	};
	walk(dir);
	return found.sort();
}

export interface FingerprintInput {
	/** The dry run's `--outdir`. */
	readonly bundle: string;
	/** wrangler.deploy.json. */
	readonly config: string;
	/** The secrets file uploaded with the version, if any. */
	readonly secretsFile?: string;
}

/**
 * The container apps' build contexts (and Dockerfiles) the config names: each as the config writes it, which labels it
 * in the fingerprint, and resolved from the config's directory, which is read. Never labelled by its absolute path, so
 * two runners checked out in different places agree.
 */
function containerSources(configPath: string): { readonly label: string; readonly path: string }[] {
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		containers?: { image?: unknown; image_build_context?: unknown }[];
	};
	const base = dirname(resolve(configPath));
	return (config.containers ?? []).flatMap((app) =>
		[app.image_build_context, app.image]
			.filter((path): path is string => typeof path === "string" && !path.includes("://"))
			.map((path) => ({ label: path, path: resolve(base, path) })),
	);
}

/** The Worker's fingerprint (above), as lowercase hex. */
export function fingerprint(input: FingerprintInput): string {
	const hash = createHash("sha256");
	// Each part named and length-prefixed, so moving bytes from one file to another can't keep the digest.
	const add = (label: string, bytes: Uint8Array) => {
		hash.update(`${label}\0${bytes.byteLength}\0`);
		hash.update(bytes);
	};
	for (const file of filesUnder(input.bundle)) {
		// Wrangler's note on the outdir, which says when it was built: not part of the Worker.
		if (file === OUTDIR_README) continue;
		add(`bundle/${file}`, readFileSync(join(input.bundle, file)));
	}
	add("config", readFileSync(input.config));
	for (const { label, path } of containerSources(input.config)) {
		if (statSync(path).isDirectory()) {
			for (const file of filesUnder(path)) add(`container:${label}/${file}`, readFileSync(join(path, file)));
		} else {
			add(`container:${label}`, readFileSync(path));
		}
	}
	// Only the secrets' digest goes into the whole one.
	if (input.secretsFile !== undefined) {
		add("secrets", createHash("sha256").update(readFileSync(input.secretsFile)).digest());
	}
	return hash.digest("hex");
}

/** What `wrangler deployments status --json` says, as far as this reads it. */
export interface Deployment {
	readonly versions?: readonly { readonly version_id?: unknown; readonly percentage?: unknown }[];
}

/** Why `harbour` must be deployed, or `undefined` when its deployment already serves this fingerprint. */
export function whyDeploy(
	deployment: Deployment | undefined,
	messageOf: (versionId: string) => string | undefined,
	wanted: string,
): string | undefined {
	if (deployment === undefined) return "there is no deployment of it yet, or Cloudflare didn't say which";
	const versions = deployment.versions ?? [];
	if (versions.length !== 1) return `its deployment serves ${versions.length} versions, not one`;
	const [only] = versions;
	if (typeof only?.version_id !== "string") return "its deployment names no version";
	const message = messageOf(only.version_id);
	if (message === undefined) return `Cloudflare didn't say what version ${only.version_id} is`;
	if (!message.startsWith(FINGERPRINT_PREFIX)) return `version ${only.version_id} wasn't made by this deploy`;
	const deployed = message.slice(FINGERPRINT_PREFIX.length).trim();
	if (deployed !== wanted)
		return `version ${only.version_id} is ${deployed.slice(0, 12)}, this is ${wanted.slice(0, 12)}`;
	return undefined;
}

/** `wrangler <args> --json`, parsed; `undefined` if it fails or says something else. */
function wranglerJson(args: string[]): unknown {
	const run = spawnSync("pnpm", ["exec", "wrangler", ...args, "--json"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (run.status !== 0) {
		console.error(
			`wrangler ${args.join(" ")} failed: ${(run.stderr || run.stdout).trim().split("\n").slice(-3).join(" ")}`,
		);
		return undefined;
	}
	try {
		return JSON.parse(run.stdout);
	} catch {
		console.error(`wrangler ${args.join(" ")} didn't answer JSON`);
		return undefined;
	}
}

function main(): void {
	const [command, ...rest] = process.argv.slice(2);
	const { values: args } = parseArgs({
		args: rest,
		options: {
			bundle: { type: "string" },
			config: { type: "string", default: "wrangler.deploy.json" },
			"secrets-file": { type: "string" },
			fingerprint: { type: "string" },
		},
	});
	if (command === "fingerprint") {
		if (args.bundle === undefined) throw new Error("Pass --bundle <the dry run's outdir>");
		const secretsFile = args["secrets-file"] === "" ? undefined : args["secrets-file"];
		console.log(fingerprint({ bundle: args.bundle, config: args.config, ...(secretsFile ? { secretsFile } : {}) }));
		return;
	}
	if (command === "check") {
		const wanted = args.fingerprint;
		if (wanted === undefined || !/^[0-9a-f]{64}$/.test(wanted)) throw new Error("Pass --fingerprint <hex>");
		const deployment = wranglerJson(["deployments", "status", "--config", args.config]) as Deployment | undefined;
		const why = whyDeploy(
			deployment,
			(id) => {
				const version = wranglerJson(["versions", "view", id, "--config", args.config]) as
					| { annotations?: Record<string, unknown> }
					| undefined;
				if (version === undefined) return undefined;
				const message = version.annotations?.["workers/message"];
				return typeof message === "string" ? message : "";
			},
			wanted,
		);
		const deploy = why !== undefined;
		console.error(deploy ? `harbour needs a new version: ${why}` : "harbour already serves this fingerprint");
		console.log(`deploy=${deploy}`);
		if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${deploy}\n`);
		return;
	}
	throw new Error("Pass fingerprint or check");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
