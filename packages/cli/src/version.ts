import packageJson from "../package.json" with { type: "json" };

/** The CLI's version, from its package.json (bundled into the published build). */
export const VERSION: string = packageJson.version;
