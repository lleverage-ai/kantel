// Checks every internal link in the built site (dist/) resolves to a page or file, so a docs page that moves or a link
// that misses the /docs prefix fails the build instead of 404ing on kantel.dev. Run after `astro build`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_URL } from "../src/site.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");

function* htmlFiles(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* htmlFiles(path);
		else if (name.endsWith(".html")) yield path;
	}
}

/** Whether a site path (no query or fragment) is served from dist/. */
function served(path) {
	const decoded = decodeURIComponent(path);
	const file = join(dist, decoded);
	if (existsSync(file) && statSync(file).isFile()) return true;
	return existsSync(join(file, "index.html")) || existsSync(`${file.replace(/\/$/, "")}.html`);
}

const broken = [];
let checked = 0;
for (const file of htmlFiles(dist)) {
	const html = readFileSync(file, "utf8");
	for (const [, href] of html.matchAll(/\shref="(\/[^"#?]*)/g)) {
		if (href.startsWith("//")) continue;
		checked++;
		if (!served(href)) broken.push(`${relative(dist, file)}: ${href}`);
	}
}

if (broken.length > 0) {
	console.error(`check-links: ${broken.length} broken internal links:\n${[...new Set(broken)].join("\n")}`);
	process.exit(1);
}
console.log(`check-links: ${checked} internal links, all served`);

// install.sh can't import site.mjs, so it repeats the repository: the GitHub links and the installer must agree.
const installer = readFileSync(join(dist, "install.sh"), "utf8");
const repo = installer.match(/^DEFAULT_REPO="([^"]+)"$/m)?.[1];
if (`https://github.com/${repo}` !== GITHUB_URL) {
	console.error(`check-links: install.sh downloads ${repo}, but the site links to ${GITHUB_URL}`);
	process.exit(1);
}

// The CLI's installer is served at /cli.sh and /install-cli.sh as scripts/sync-installers.mjs chose it: the
// repository's own copy, or, while the latest release has no native binaries, that release's own installer, stamped
// with its version. Either way it downloads from the repository the site links to.
const repositoryInstaller = readFileSync(join(dist, "../../../apps/cli/install-cli.sh"), "utf8");
const chosen = JSON.parse(readFileSync(join(dist, "../.cli-installer.json"), "utf8"));
let cliInstaller = repositoryInstaller;
for (const name of ["cli.sh", "install-cli.sh"]) {
	const path = join(dist, name);
	const served = existsSync(path) ? readFileSync(path, "utf8") : "";
	const sha256 = createHash("sha256").update(served).digest("hex");
	const fits =
		sha256 === chosen.sha256 &&
		(chosen.from === "repository"
			? served === repositoryInstaller
			: /^KANTEL_RELEASE_VERSION="\d+\.\d+\.\d+"$/m.test(served));
	if (!fits) {
		console.error(`check-links: dist/${name} isn't the installer scripts/sync-installers.mjs chose; run it again`);
		process.exit(1);
	}
	cliInstaller = served;
}
const cliRepo = cliInstaller.match(/^REPO="([^"]+)"$/m)?.[1];
if (`https://github.com/${cliRepo}` !== GITHUB_URL) {
	console.error(`check-links: cli.sh downloads ${cliRepo}, but the site links to ${GITHUB_URL}`);
	process.exit(1);
}
