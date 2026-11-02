// The default compose stack (deploy/compose/compose.yaml, what install.sh starts) gives the gateway's sessions Kantel's
// own browsers with no overlay and no settings: the gateway's environment, as Compose fills it in, configures the
// browser host that the same file starts, with the same token and view key, and waits for it to be healthy. The old
// browser.yaml overlay still loads and adds nothing, and KANTEL_BROWSER_PROVIDER=off turns the browser off.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { browserConfig } from "../../src/gateway/browser.ts";

const COMPOSE_DIR = new URL("../../../../deploy/compose/", import.meta.url);

type Env = { readonly [name: string]: string | undefined };

interface Service {
	readonly image?: string;
	readonly environment?: { readonly [name: string]: string | number };
	readonly depends_on?: { readonly [name: string]: { readonly condition: string } };
	readonly networks?: readonly string[] | { readonly [name: string]: unknown };
	readonly volumes?: readonly string[];
}

interface ComposeFile {
	readonly services?: { readonly [name: string]: Service };
	readonly networks?: { readonly [name: string]: { readonly name?: string } | null };
	readonly volumes?: { readonly [name: string]: unknown };
}

/** Compose's interpolation as far as these files use it: `${NAME}`, `${NAME:-default}` (nested) and `$$`. */
function interpolate(text: string, env: Env): string {
	let out = "";
	let at = 0;
	while (at < text.length) {
		if (text.startsWith("$$", at)) {
			out += "$";
			at += 2;
		} else if (text.startsWith("${", at)) {
			const [value, end] = expression(text, at + 2, env);
			out += value;
			at = end;
		} else {
			out += text[at];
			at += 1;
		}
	}
	return out;
}

/** The value of the expression starting at `from` (just after `${`), and where it ends (just after its `}`). */
function expression(text: string, from: number, env: Env): [string, number] {
	const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(from))?.[0];
	if (name === undefined) throw new Error(`bad interpolation at ${from}`);
	let at = from + name.length;
	let fallback = "";
	if (text.startsWith(":-", at)) {
		at += 2;
		let depth = 0;
		let raw = "";
		while (at < text.length && !(text[at] === "}" && depth === 0)) {
			if (text.startsWith("${", at)) {
				depth += 1;
				raw += "${";
				at += 2;
				continue;
			}
			if (text[at] === "}") depth -= 1;
			raw += text[at];
			at += 1;
		}
		fallback = interpolate(raw, env);
	}
	if (text[at] !== "}") throw new Error(`unclosed interpolation at ${from}`);
	const set = env[name];
	return [set === undefined || set === "" ? fallback : set, at + 1];
}

function load(file: string, env: Env = {}): ComposeFile {
	return parse(interpolate(readFileSync(new URL(file, COMPOSE_DIR), "utf8"), env)) as ComposeFile;
}

const environment = (service: Service | undefined): { [name: string]: string } =>
	Object.fromEntries(Object.entries(service?.environment ?? {}).map(([name, value]) => [name, String(value)]));

const networksOf = (service: Service | undefined): string[] =>
	Array.isArray(service?.networks) ? [...service.networks] : Object.keys(service?.networks ?? {});

describe("the default compose stack's browsers", () => {
	const compose = load("compose.yaml");
	const services = compose.services ?? {};
	const gateway = environment(services.gateway);
	const host = environment(services["browser-host"]);

	it("configures the gateway for Kantel's own browsers, on the browser host the file starts", () => {
		const config = browserConfig(gateway);
		expect(config).toMatchObject({ provider: "kantel", hostUrl: "http://browser-host:8790" });
		if (config?.provider !== "kantel") throw new Error("not Kantel's own browsers");
		expect(services["browser-host"]).toBeDefined();
		expect(host.PORT).toBe(new URL(config.hostUrl).port);
		// The host checks the gateway's token, and both sign and check view links with the same key.
		expect(host.KANTEL_BROWSER_HOST_TOKEN).toBe(config.hostToken);
		expect(host.KANTEL_BROWSER_VIEW_KEY).toBe(config.viewKey);
		expect(host.KANTEL_BROWSER_SEAL_KEY?.length).toBeGreaterThanOrEqual(32);
	});

	it("starts the gateway once the browser host is healthy, on a network they share", () => {
		expect(services.gateway?.depends_on?.["browser-host"]).toEqual({ condition: "service_healthy" });
		const shared = networksOf(services.gateway).filter((name) => networksOf(services["browser-host"]).includes(name));
		expect(shared).not.toEqual([]);
	});

	it("runs browsers of the image it builds, on the network it names, with their data on a volume", () => {
		expect(host.KANTEL_BROWSER_IMAGE).toBe(services["browser-image"]?.image);
		expect(services["browser-host"]?.depends_on?.["browser-image"]).toEqual({
			condition: "service_completed_successfully",
		});
		expect(networksOf(services["browser-host"])).toContain("browsers");
		expect(compose.networks?.browsers?.name).toBe(host.KANTEL_BROWSER_NETWORK);
		expect(host.KANTEL_BROWSER_STACK).toBe("harbour");
		expect(services["browser-host"]?.volumes).toContain("browserdata:/var/lib/harbour-browser");
		expect(Object.keys(compose.volumes ?? {})).toContain("browserdata");
	});

	it("follows a second stack's settings", () => {
		const second = load("compose.yaml", {
			COMPOSE_PROJECT_NAME: "kantel-second",
			KANTEL_IMAGE_TAG: "second",
			KANTEL_BROWSER_NETWORK: "kantel-second-browsers",
		});
		const secondHost = environment(second.services?.["browser-host"]);
		expect(secondHost.KANTEL_BROWSER_STACK).toBe("kantel-second");
		expect(secondHost.KANTEL_BROWSER_IMAGE).toBe("harbour-browser:second");
		expect(second.services?.["browser-image"]?.image).toBe("harbour-browser:second");
		expect(second.networks?.browsers?.name).toBe("kantel-second-browsers");
	});

	it("takes a deployment's own keys, and turns the browser off or over to brwsr when asked", () => {
		const keys = {
			KANTEL_BROWSER_HOST_TOKEN: "t".repeat(64),
			KANTEL_BROWSER_VIEW_KEY: "v".repeat(64),
			KANTEL_BROWSER_SEAL_KEY: "s".repeat(64),
		};
		const own = load("compose.yaml", keys).services ?? {};
		expect(browserConfig(environment(own.gateway))).toMatchObject({
			hostToken: keys.KANTEL_BROWSER_HOST_TOKEN,
			viewKey: keys.KANTEL_BROWSER_VIEW_KEY,
		});
		expect(environment(own["browser-host"]).KANTEL_BROWSER_SEAL_KEY).toBe(keys.KANTEL_BROWSER_SEAL_KEY);

		const off = load("compose.yaml", { KANTEL_BROWSER_PROVIDER: "off" }).services ?? {};
		expect(browserConfig(environment(off.gateway))).toBeUndefined();

		const brwsr = load("compose.yaml", { KANTEL_BROWSER_PROVIDER: "brwsr", KANTEL_BRWSR_API_KEY: "bk_0123456789" });
		expect(browserConfig(environment(brwsr.services?.gateway))).toMatchObject({ provider: "brwsr" });
	});

	it("keeps the old browser overlay loadable, adding nothing", () => {
		const overlay = load("browser.yaml");
		expect(overlay.services).toEqual({});
		expect(Object.keys(overlay)).toEqual(["services"]);
	});
});

describe("the gateway's browser switch", () => {
	it("turns the browser off with KANTEL_BROWSER_PROVIDER=off or none, whatever else is set", () => {
		const kantel = {
			KANTEL_BROWSER_HOST_URL: "http://browser-host:8790",
			KANTEL_BROWSER_HOST_TOKEN: "t".repeat(32),
			KANTEL_BROWSER_VIEW_KEY: "v".repeat(32),
			KANTEL_BRWSR_API_KEY: "bk_0123456789",
		};
		expect(browserConfig({ ...kantel, KANTEL_BROWSER_PROVIDER: "off" })).toBeUndefined();
		expect(browserConfig({ ...kantel, KANTEL_BROWSER_PROVIDER: " None " })).toBeUndefined();
		expect(browserConfig({ ...kantel, KANTEL_BROWSER_PROVIDER: "kantel" })).toMatchObject({ provider: "kantel" });
		// Off needs nothing else to be valid: a short token is no error when nothing uses it.
		expect(browserConfig({ KANTEL_BROWSER_PROVIDER: "off", KANTEL_BROWSER_HOST_TOKEN: "short" })).toBeUndefined();
	});
});
