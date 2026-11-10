// Copies the CLI's installer, apps/cli/install-cli.sh, into public/ as cli.sh (the short link the console and the
// docs give: `curl -fsSL https://kantel.dev/cli.sh | sh`) and install-cli.sh (the release asset's own name). Run before
// every dev and build (the package's predev and prebuild), so the site serves the repository's one copy, never a fork.
// The copies are generated and ignored by git: edit apps/cli/install-cli.sh, never these.
//
// The copy is unstamped (tools/release/pack.sh stamps a release's version into its own copy), so it installs the latest
// GitHub Release, checking every file against that release's SHA256SUMS. _headers serves both as text.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../../../apps/cli/install-cli.sh");
const INSTALLER_COPIES = ["cli.sh", "install-cli.sh"];

let script = readFileSync(source, "utf8");
// The release's placeholder must still be there, or the copy would pin whatever version someone stamped in.
if (!/^KANTEL_RELEASE_VERSION="__KANTEL_VERSION__"$/m.test(script)) {
	console.error(
		`sync-installers: ${source} has no unstamped KANTEL_RELEASE_VERSION, so it wouldn't install the latest`,
	);
	process.exit(1);
}
// The unstamped copy installs the latest release, so it must read that release's files. Until the latest release has
// the native binaries (kantel-<os>-<arch>, since Kantel's CLI became a Go binary), the site serves that release's own
// installer instead, which matches its files; the release workflow redeploys the site once a release has them. CI
// (CI set) fails when GitHub can't be asked; a local build serves the repository's copy and says so.
// KANTEL_INSTALLER_RELEASE_CHECK=0 skips the check.
const LATEST = "https://github.com/lleverage-ai/kantel/releases/latest/download";
let from = "apps/cli/install-cli.sh";
if (process.env.KANTEL_INSTALLER_RELEASE_CHECK !== "0") {
	try {
		const sums = await fetch(`${LATEST}/SHA256SUMS`, { signal: AbortSignal.timeout(20_000) });
		if (!sums.ok) throw new Error(`SHA256SUMS: HTTP ${sums.status}`);
		if (!/\skantel-linux-amd64$/m.test(await sums.text())) {
			const theirs = await fetch(`${LATEST}/install-cli.sh`, { signal: AbortSignal.timeout(20_000) });
			if (!theirs.ok) throw new Error(`install-cli.sh: HTTP ${theirs.status}`);
			script = await theirs.text();
			from = "the latest release's own install-cli.sh (it has no native binaries yet)";
		}
	} catch (error) {
		if (process.env.CI) {
			console.error(`sync-installers: couldn't check the latest release's files: ${error.message}`);
			process.exit(1);
		}
		console.warn(`sync-installers: couldn't check the latest release (${error.message}): serving ${from}`);
	}
}
for (const name of INSTALLER_COPIES) writeFileSync(join(here, "../public", name), script, { mode: 0o644 });
// What was chosen, for check-links.mjs to hold the built copies to: the repository's, or a release's own (stamped).
writeFileSync(
	join(here, "../.cli-installer.json"),
	`${JSON.stringify({
		from: from === "apps/cli/install-cli.sh" ? "repository" : "release",
		sha256: createHash("sha256").update(script).digest("hex"),
	})}\n`,
);
console.log(`sync-installers: ${from} into public/ as ${INSTALLER_COPIES.join(" and ")}`);
