/**
 * kantel-console: the console's files (apps/console/dist), as a Worker of their own (wrangler.console.jsonc). Only
 * the `harbour` Worker reaches it, through its ASSETS service binding; `harbour` decides what is asked and what a miss
 * means (src/route.ts `consoleAsset`). Here every request is answered from the static assets, as they are.
 *
 * It is a Worker apart so that a console deploy never makes a new version of `harbour`, which would reset its Durable
 * Objects and cut every host link, SSH tunnel, desktop, browser and streamed command they hold.
 */
interface ConsoleEnv {
	readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
	fetch: (request: Request, env: ConsoleEnv) => env.ASSETS.fetch(request),
};
