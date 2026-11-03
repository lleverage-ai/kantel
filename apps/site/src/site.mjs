// The site's few constants, in one place. Plain JS so astro.config.mjs can import them too.

/** Kantel's public repository. */
export const GITHUB_URL = "https://github.com/lleverage-ai/kantel";

/** The site's own origin, which serves install.sh, the short install links in public/_redirects and the docs. */
export const SITE_URL = "https://kantel.dev";

/**
 * The hosted console: where you sign in, and the API the CLI talks to. The one line to change if the hosted console
 * moves.
 */
export const CONSOLE_URL = "https://app.kantel.dev";

/** Signing in to the hosted console. */
export const SIGN_IN_URL = CONSOLE_URL;

/** The CLI, from the latest GitHub Release (public/_redirects sends /cli.sh there). Pastes the same into bash, zsh and fish. */
export const CLI_INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/cli.sh | sh`;

/** Self-hosting the control plane: public/install.sh. */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/install.sh | sh`;

export const LLEVERAGE_URL = "https://lleverage.ai";
