// The site's few constants, in one place. Plain JS so astro.config.mjs can import them too.

/** Kantel's public repository. It doesn't exist yet: this is the one line to change if the name does. */
export const GITHUB_URL = "https://github.com/lleverage-ai/kantel";

/** The site's own origin, which serves install.sh and the docs. */
export const SITE_URL = "https://kantel.dev";

/** The one-line install. Plain `curl … | sh`, so it pastes the same into bash, zsh and fish. */
export const INSTALL_COMMAND = `curl -fsSL ${SITE_URL}/install.sh | sh`;

/** The shape of the command that adds a Linux machine as a host. The console fills in the URL and a one-time token. */
export const HOST_JOIN_COMMAND = `curl -fsSL ${SITE_URL}/host.sh | sudo sh -s -- join <your Kantel URL> --token <token from the console>`;

export const LLEVERAGE_URL = "https://lleverage.ai";
