// Copies the CLI's installer, apps/cli/install-cli.sh, into public/ as cli.sh (the short link the console and the
// docs give: `curl -fsSL https://kantel.dev/cli.sh | sh`) and install-cli.sh (the release asset's own name). Run before
// every dev and build (the package's predev and prebuild), so the site serves the repository's one copy, never a fork.
// The copies are generated and ignored by git: edit apps/cli/install-cli.sh, never these.
//
// The copy is unstamped (tools/release/pack.sh stamps a release's version into its own copy), so it installs the latest
// GitHub Release, checking every file against that release's SHA256SUMS. _headers serves both as text.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "../../../apps/cli/install-cli.sh");
const INSTALLER_COPIES = ["cli.sh", "install-cli.sh"];

const script = readFileSync(source, "utf8");
// The release's placeholder must still be there, or the copy would pin whatever version someone stamped in.
if (!/^KANTEL_RELEASE_VERSION="__KANTEL_VERSION__"$/m.test(script)) {
	console.error(
		`sync-installers: ${source} has no unstamped KANTEL_RELEASE_VERSION, so it wouldn't install the latest`,
	);
	process.exit(1);
}
for (const name of INSTALLER_COPIES) writeFileSync(join(here, "../public", name), script, { mode: 0o644 });
console.log(`sync-installers: apps/cli/install-cli.sh into public/ as ${INSTALLER_COPIES.join(" and ")}`);
