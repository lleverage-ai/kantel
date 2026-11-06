/**
 * `kantel update`: replaces this kantel with a newer release by running that release's own installer
 * (`install-cli.sh`, stamped with its version), the one `curl -fsSL https://kantel.dev/cli.sh | sh` runs. The
 * installer checks each file against the release's SHA256SUMS, puts the console's files in beside it and updates
 * kantel-admin where it is installed, so the update is exactly a fresh install of that release in the same place.
 *
 * Only a kantel the installer put in is updated: one whose script is `kantel.mjs` (in `KANTEL_HOME`), usually run through
 * the link in `~/.local/bin`. One run from a checkout or installed some other way is left alone, with a note saying how.
 */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Env } from "./config.ts";
import { CliError } from "./errors.ts";

export const RELEASES = "https://github.com/lleverage-ai/kantel/releases";

/** Where the installer put this kantel: its files (`KANTEL_HOME`) and the directory its link is in, if it has one. */
export interface Install {
	readonly home: string;
	readonly bin?: string;
}

/**
 * Where `script` (the path this kantel was started as, `process.argv[1]`) was installed: undefined when it isn't the
 * installer's `kantel.mjs`, such as `src/main.ts` in a checkout.
 */
export async function installOf(script: string): Promise<Install | undefined> {
	const real = await realpath(script).catch(() => undefined);
	if (real === undefined || basename(real) !== "kantel.mjs") return undefined;
	const linked = await lstat(script).then(
		(stats) => stats.isSymbolicLink(),
		() => false,
	);
	return { home: dirname(real), ...(linked ? { bin: dirname(script) } : {}) };
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** A release version from what someone typed, without a leading `v`; a usage error when it isn't one. */
export function releaseVersion(input: string): string {
	const version = input.trim().replace(/^v/, "");
	if (!VERSION_PATTERN.test(version)) throw new CliError(`'${input}' isn't a version such as 0.2.0 or 0.3.0-rc.1`);
	return version;
}

/** Below zero when `a` is older than `b`, zero when they are the same, above when newer (semver precedence). */
export function compareVersions(a: string, b: string): number {
	const [, ...left] = VERSION_PATTERN.exec(a) ?? [];
	const [, ...right] = VERSION_PATTERN.exec(b) ?? [];
	for (let index = 0; index < 3; index++) {
		const difference = Number(left[index] ?? 0) - Number(right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	const [leftPre, rightPre] = [left[3], right[3]];
	if (leftPre === rightPre) return 0;
	// A prerelease comes before its release.
	if (leftPre === undefined) return 1;
	if (rightPre === undefined) return -1;
	return leftPre.localeCompare(rightPre, "en", { numeric: true });
}

/** The latest release's version, from where GitHub's `releases/latest` redirects (no API, so no rate limit). */
export async function latestRelease(fetcher: typeof fetch): Promise<string> {
	let response: Response;
	try {
		response = await fetcher(`${RELEASES}/latest`, { method: "HEAD", redirect: "manual" });
	} catch (error) {
		throw new CliError(`Couldn't reach GitHub to find the latest release: ${(error as Error).message}`);
	}
	const tag = /\/releases\/tag\/v([^/?#]+)$/.exec(response.headers.get("location") ?? "")?.[1];
	if (tag === undefined || !VERSION_PATTERN.test(tag)) {
		throw new CliError(`Couldn't tell the latest release from ${RELEASES}/latest (HTTP ${response.status})`);
	}
	return tag;
}

/** Runs the installer `sh <script> <args…>` with `env`, its output on this process's; answers its exit code. */
export type RunInstaller = (script: string, args: readonly string[], env: Env) => Promise<number>;

export const runInstaller: RunInstaller = (script, args, env) =>
	new Promise((done, fail) => {
		const child = spawn("sh", [script, ...args], { env: env as NodeJS.ProcessEnv, stdio: "inherit" });
		child.once("error", (error) => fail(new CliError(`Couldn't run sh: ${error.message}`)));
		child.once("exit", (code, signal) => done(code ?? (signal === null ? 1 : 128)));
	});

/** Downloads `version`'s installer (`KANTEL_RELEASE_URL`'s when that is set) and runs it to install there. */
export async function install(
	version: string,
	where: Install,
	io: { readonly fetch: typeof fetch; readonly env: Env; readonly run: RunInstaller },
): Promise<number> {
	const mirror = io.env.KANTEL_RELEASE_URL;
	const url =
		mirror !== undefined && mirror !== ""
			? `${mirror.replace(/\/$/, "")}/install-cli.sh`
			: `${RELEASES}/download/v${version}/install-cli.sh`;
	let response: Response;
	try {
		response = await io.fetch(url);
	} catch (error) {
		throw new CliError(`Couldn't download ${url}: ${(error as Error).message}`);
	}
	if (!response.ok) {
		throw new CliError(
			response.status === 404
				? `There is no release v${version} (${url})`
				: `Couldn't download ${url} (HTTP ${response.status})`,
		);
	}
	const directory = await mkdtemp(join(tmpdir(), "kantel-update-"));
	try {
		const script = join(directory, "install-cli.sh");
		await writeFile(script, await response.text(), { mode: 0o700 });
		return await io.run(script, ["--version", version, ...(where.bin === undefined ? [] : ["--dir", where.bin])], {
			...io.env,
			KANTEL_HOME: where.home,
			KANTEL_UPDATE: "1",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
