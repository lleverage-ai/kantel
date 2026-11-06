// `kantel update`, with GitHub behind an injected fetch and the installer replaced by a recorder.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/commands.ts";
import { compareVersions, RELEASES } from "../src/update.ts";
import { VERSION } from "../src/version.ts";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "kantel-update-test-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** The installer's layout: `share/kantel/kantel.mjs`, linked from `bin/kantel`. Answers the link's path. */
async function installed(): Promise<string> {
	await mkdir(join(root, "share", "kantel"), { recursive: true });
	await mkdir(join(root, "bin"), { recursive: true });
	await writeFile(join(root, "share", "kantel", "kantel.mjs"), "");
	await rm(join(root, "bin", "kantel"), { force: true });
	await symlink(join(root, "share", "kantel", "kantel.mjs"), join(root, "bin", "kantel"));
	return join(root, "bin", "kantel");
}

interface Ran {
	readonly script: string;
	readonly body: string;
	readonly args: readonly string[];
	readonly home: string | undefined;
}

async function update(
	argv: readonly string[],
	options: { latest?: string; script?: string; exit?: number; env?: Record<string, string> } = {},
) {
	const fetched: string[] = [];
	const ran: Ran[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const fetch = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		fetched.push(url);
		if (url === `${RELEASES}/latest`) {
			return new Response(null, {
				status: 302,
				headers: { location: `${RELEASES}/tag/v${options.latest ?? "9.9.9"}` },
			});
		}
		if (url.endsWith("/install-cli.sh")) return new Response(`# installer from ${url}\n`);
		return new Response("missing", { status: 404 });
	};
	const code = await run(["update", ...argv], {
		fetch: fetch as typeof globalThis.fetch,
		env: options.env ?? {},
		stdout: { write: (chunk) => out.push(String(chunk)) },
		stderr: { write: (chunk) => err.push(String(chunk)) },
		configDir: join(root, "config"),
		script: options.script,
		runInstaller: async (script, args, env) => {
			ran.push({ script, body: await readFile(script, "utf8"), args, home: env.KANTEL_HOME });
			return options.exit ?? 0;
		},
	});
	return { code, stdout: out.join(""), stderr: err.join(""), fetched, ran };
}

describe("update", () => {
	it("runs the latest release's own installer where this kantel is installed", async () => {
		const result = await update([], { script: await installed() });
		expect(result.code).toBe(0);
		expect(result.ran).toHaveLength(1);
		expect(result.ran[0]?.body).toBe(`# installer from ${RELEASES}/download/v9.9.9/install-cli.sh\n`);
		expect(result.ran[0]?.args).toEqual(["--version", "9.9.9", "--dir", join(root, "bin")]);
		expect(result.ran[0]?.home).toBe(join(root, "share", "kantel"));
		expect(result.stderr).toContain(`Updating kantel ${VERSION} to 9.9.9`);
	});

	it("does nothing when this is the latest release, unless --force", async () => {
		const script = await installed();
		const same = await update([], { script, latest: VERSION });
		expect(same.code).toBe(0);
		expect(same.ran).toEqual([]);
		expect(same.stdout).toContain("is up to date");
		const forced = await update(["--force"], { script, latest: VERSION });
		expect(forced.ran).toHaveLength(1);
	});

	it("says whether there is a newer release with --check, installing nothing", async () => {
		const result = await update(["--check", "--json"], { script: await installed() });
		expect(result.code).toBe(0);
		expect(result.ran).toEqual([]);
		expect(JSON.parse(result.stdout)).toEqual({ current: VERSION, target: "9.9.9", updateAvailable: true });
	});

	it("installs the release --version names, older ones too, without asking GitHub for the latest", async () => {
		const result = await update(["--version", "v0.0.0-rc.1"], { script: await installed() });
		expect(result.code).toBe(0);
		expect(result.fetched).toEqual([`${RELEASES}/download/v0.0.0-rc.1/install-cli.sh`]);
		expect(result.ran[0]?.args.slice(0, 2)).toEqual(["--version", "0.0.0-rc.1"]);
		expect((await update(["--version", "latest"], { script: await installed() })).code).toBe(1);
	});

	it("refuses a kantel install-cli.sh didn't install, saying how to install the release", async () => {
		const result = await update([], { script: join(root, "src", "main.ts") });
		expect(result.code).toBe(1);
		expect(result.ran).toEqual([]);
		expect(result.stderr).toContain("wasn't installed by install-cli.sh");
		expect(result.stderr).toContain(`${RELEASES}/download/v9.9.9/install-cli.sh | sh`);
	});

	it("says so when the installer fails", async () => {
		const result = await update([], { script: await installed(), exit: 3 });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("failed (exit 3), so the installation may be incomplete");
		// The repair runs the release's installer itself: a half-updated kantel may already say it is 9.9.9, and a
		// release from before `update` has no such command.
		expect(result.stderr).toContain(
			`curl -fsSL ${RELEASES}/download/v9.9.9/install-cli.sh | KANTEL_HOME=${join(root, "share", "kantel")} sh -s -- --version 9.9.9 --dir ${join(root, "bin")}`,
		);
		const mirrored = await update(["--version", "1.2.3"], {
			script: await installed(),
			exit: 1,
			env: { KANTEL_RELEASE_URL: "https://mirror.test/k" },
		});
		expect(mirrored.stderr).toContain(
			"curl -fsSL https://mirror.test/k/install-cli.sh | KANTEL_RELEASE_URL=https://mirror.test/k KANTEL_HOME=",
		);
	});

	it("downloads the installer from KANTEL_RELEASE_URL, which needs --version", async () => {
		const env = { KANTEL_RELEASE_URL: "https://mirror.test/kantel/" };
		expect((await update([], { script: await installed(), env })).code).toBe(2);
		const result = await update(["--version", "1.2.3"], { script: await installed(), env });
		expect(result.fetched).toEqual(["https://mirror.test/kantel/install-cli.sh"]);
	});
});

describe("compareVersions", () => {
	it("orders versions as semver does", () => {
		expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
		expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBeGreaterThan(0);
	});
});
