// The site's few constants, in one place. Plain JS so astro.config.mjs can import them too.

/** Kantel's public repository. */
export const GITHUB_URL = "https://github.com/lleverage-ai/kantel";

/** The site's own origin, which serves install.sh, the CLI's installer (cli.sh) and the docs. */
export const SITE_URL = "https://kantel.dev";

/**
 * The hosted console: where you sign in, and the API the CLI talks to. The one line to change if the hosted console
 * moves.
 */
export const CONSOLE_URL = "https://app.kantel.dev";

/**
 * The CLI's installer, packages/cli/install-cli.sh, which the build copies into public/ as cli.sh
 * (scripts/sync-installers.mjs). It installs the latest GitHub Release, and pastes the same into bash, zsh and fish.
 */
export const CLI_INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/cli.sh | sh`;

/**
 * What to run once the CLI is in (packages/cli/src/commands.ts): sign in to the hosted console through the browser,
 * then make a sandbox on one of your hosts.
 */
export const CLI_NEXT_COMMANDS = [
	{ command: `kantel login --url ${CONSOLE_URL}`, note: "approve it in the browser" },
	{ command: "kantel new", note: "a sandbox on your host" },
];

/**
 * The host installer the console's Add a host shows, from the latest GitHub Release, with --url and a one-time token.
 */
export const HOST_INSTALL_URL = `${GITHUB_URL}/releases/latest/download/install.sh`;

/** Self-hosting the control plane: public/install.sh. */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/install.sh | sh`;

export const LLEVERAGE_URL = "https://lleverage.ai";
