import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { accessVerdict } from "../scripts/check-access.ts";
import {
	BROWSER_CONTAINERS,
	CONSOLE_BINDING,
	CONSOLE_WORKER,
	consoleDeployConfig,
	DEPLOY_VARIABLES,
	deployConfig,
	deployValues,
	instanceTypeProblem,
	LOCATION_HINTS,
	missingVariables,
	SANDBOX_CONTAINERS,
	zoneOf,
} from "../scripts/deploy-config.ts";
import { gatewayConfig } from "../src/config.ts";
import { DEFAULT_LOCATION_HINT, LOCATION_HINTS as ROUTE_LOCATION_HINTS } from "../src/route.ts";

const configured = {
	CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
	KANTEL_HOSTNAME: "harbour.myslop.app",
	KANTEL_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/",
	KANTEL_ACCESS_AUD: "a".repeat(64),
	KANTEL_MODELS_VPC_SERVICE_ID: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
	KANTEL_ADMIN_EMAIL: "admin@kantel.test",
};

const wranglerJsonc = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const { rawConfig } = experimental_readRawConfig({ config: wranglerJsonc });
const consoleJsonc = fileURLToPath(new URL("../wrangler.console.jsonc", import.meta.url));
const consoleRaw = experimental_readRawConfig({ config: consoleJsonc }).rawConfig;

describe("deploy config", () => {
	it("needs every variable to deploy", () => {
		expect(missingVariables({})).toEqual([...DEPLOY_VARIABLES]);
		expect(() => deployValues({}, "deploy")).toThrow(
			/Cannot deploy: set the repository variables CLOUDFLARE_ACCOUNT_ID/,
		);
		for (const name of DEPLOY_VARIABLES) {
			const { [name]: _, ...without } = configured;
			expect(() => deployValues(without, "deploy"), name).toThrow(
				`Cannot deploy: set the repository variables ${name}`,
			);
			expect(() => deployValues({ ...configured, [name]: "  " }, "deploy"), name).toThrow(name);
		}
		expect(deployValues(configured, "deploy").placeholders).toEqual([]);
	});

	it("fills placeholders for a dry run before the account is set up, and names no account", () => {
		const values = deployValues({}, "dry-run");
		expect(values.placeholders).toEqual([...DEPLOY_VARIABLES]);
		expect(values.accountId).toBeUndefined();
		const config = deployConfig(rawConfig, values);
		expect(config.account_id).toBeUndefined();
		expect(config.routes).toEqual([{ pattern: "kantel.example.com/*", zone_name: "example.com" }]);
	});

	it("refuses a malformed variable in either mode", () => {
		for (const mode of ["deploy", "dry-run"] as const) {
			expect(() => deployValues({ ...configured, KANTEL_HOSTNAME: "https://harbour.myslop.app" }, mode)).toThrow(
				/KANTEL_HOSTNAME must be a host name/,
			);
			expect(() => deployValues({ ...configured, KANTEL_MODELS_VPC_SERVICE_ID: "atlas-app" }, mode)).toThrow(
				/KANTEL_MODELS_VPC_SERVICE_ID/,
			);
			const malformed: Record<string, readonly string[]> = {
				CLOUDFLARE_ACCOUNT_ID: ["0123", "my-account"],
				KANTEL_HOSTNAME: ["kantel", "kantel.example-", "harbour.myslop.app/v1", "myslop.app"],
				KANTEL_ACCESS_TEAM_DOMAIN: ["team", "https://team.cloudflareaccess.com/login"],
				KANTEL_ACCESS_AUD: ["not hex", "abc"],
				KANTEL_ADMIN_EMAIL: ["tom", "admin@kantel..test", "a b@kantel.test", "@kantel.test", "admin@kantel"],
			};
			for (const [name, values] of Object.entries(malformed)) {
				for (const value of values) {
					expect(() => deployValues({ ...configured, [name]: value }, mode), `${name}=${value}`).toThrow(
						`${name} must be`,
					);
				}
			}
		}
	});

	it("refuses an Access hostname under the ports domain, set or the default, and keeps one beside it", () => {
		for (const mode of ["deploy", "dry-run"] as const) {
			const refused: Record<string, string>[] = [
				{ KANTEL_HOSTNAME: "harbour.myslop.app", KANTEL_COMPUTE_PORTS_DOMAIN: "myslop.app" },
				{ KANTEL_HOSTNAME: "Console.Ports.Example.com", KANTEL_COMPUTE_PORTS_DOMAIN: "ports.example.com" },
				{ KANTEL_HOSTNAME: "ports.example.com", KANTEL_COMPUTE_PORTS_DOMAIN: "ports.example.com" },
				// Unset, the Worker's ports domain is kantel.run.
				{ KANTEL_HOSTNAME: "console.kantel.run" },
			];
			for (const env of refused) {
				expect(() => deployValues({ ...configured, ...env }, mode), JSON.stringify(env)).toThrow(
					/KANTEL_HOSTNAME can't be the ports domain/,
				);
			}
			const kept: Record<string, string>[] = [
				{ KANTEL_HOSTNAME: "harbour.myslop.app" },
				{ KANTEL_HOSTNAME: "harbour.myslop.app", KANTEL_COMPUTE_PORTS_DOMAIN: "kantel.run" },
				{ KANTEL_HOSTNAME: "console.example.com", KANTEL_COMPUTE_PORTS_DOMAIN: "ports.example.com" },
			];
			for (const env of kept) {
				expect(deployValues({ ...configured, ...env }, mode).hostname, JSON.stringify(env)).toBe(env.KANTEL_HOSTNAME);
			}
		}
	});

	it("adds the account, zone route, Access vars and the models VPC service to wrangler.jsonc", () => {
		const config = deployConfig(rawConfig, deployValues(configured, "deploy"));
		expect(config).toMatchObject({
			name: "harbour",
			account_id: configured.CLOUDFLARE_ACCOUNT_ID,
			workers_dev: false,
			preview_urls: false,
			routes: [{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }],
			vpc_services: [{ binding: "MODELS", service_id: configured.KANTEL_MODELS_VPC_SERVICE_ID }],
			vars: {
				KANTEL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
				KANTEL_ACCESS_AUD: configured.KANTEL_ACCESS_AUD,
				KANTEL_ADMIN_EMAIL: "admin@kantel.test",
			},
		});
		// The local dev environment (its mock Access issuer and dev routes) is never deployed.
		expect(config.env).toBeUndefined();
		expect(config.main).toBe("src/index.ts");
	});

	it("turns personal connections on only for a deployment whose variable says so", () => {
		const vars = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy")).vars as Record<string, string>;
		expect(vars({}).KANTEL_CONNECTIONS_PERSONAL).toBeUndefined();
		expect(vars({ KANTEL_CONNECTIONS_PERSONAL: "off" }).KANTEL_CONNECTIONS_PERSONAL).toBeUndefined();
		expect(vars({ KANTEL_CONNECTIONS_PERSONAL: "on" }).KANTEL_CONNECTIONS_PERSONAL).toBe("on");
		expect(() => deployValues({ ...configured, KANTEL_CONNECTIONS_PERSONAL: "yes" }, "deploy")).toThrow(
			"KANTEL_CONNECTIONS_PERSONAL must be on or off",
		);
		// Not in wrangler.jsonc, so no installer gets it by default.
		expect(JSON.stringify(rawConfig)).not.toContain("KANTEL_CONNECTIONS_PERSONAL");
	});

	it("offers CIMD only for a deployment whose variable says so (#338)", () => {
		const vars = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy")).vars as Record<string, string>;
		expect(vars({}).KANTEL_CONNECTIONS_CIMD).toBeUndefined();
		expect(vars({ KANTEL_CONNECTIONS_CIMD: "off" }).KANTEL_CONNECTIONS_CIMD).toBeUndefined();
		expect(vars({ KANTEL_CONNECTIONS_CIMD: "on" }).KANTEL_CONNECTIONS_CIMD).toBe("on");
		expect(() => deployValues({ ...configured, KANTEL_CONNECTIONS_CIMD: "yes" }, "deploy")).toThrow(
			"KANTEL_CONNECTIONS_CIMD must be on or off",
		);
		// Not in wrangler.jsonc: the document must be public first, which only the deployment knows.
		expect(JSON.stringify(rawConfig)).not.toContain("KANTEL_CONNECTIONS_CIMD");
	});

	it("sets the ports domain only for a deployment whose variable names its own, and routes its names to the Worker", () => {
		const config = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy"));
		// Unset, the Worker's own default (kantel.run, src/config.ts) stands, and nothing is routed for it.
		expect((config({}).vars as Record<string, string>).KANTEL_COMPUTE_PORTS_DOMAIN).toBeUndefined();
		expect(config({}).routes).toEqual([{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }]);
		const own = config({ KANTEL_COMPUTE_PORTS_DOMAIN: "kantel.run" });
		expect((own.vars as Record<string, string>).KANTEL_COMPUTE_PORTS_DOMAIN).toBe("kantel.run");
		// Port names, one label under the domain, as a bare pattern: wrangler finds the zone. The DNS is added outside.
		expect(own.routes).toEqual([{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }, "*.kantel.run/*"]);
		for (const bad of ["*.ports.example.com", "https://ports.example.com", "ports"]) {
			expect(() => deployValues({ ...configured, KANTEL_COMPUTE_PORTS_DOMAIN: bad }, "deploy")).toThrow(
				"KANTEL_COMPUTE_PORTS_DOMAIN must be a lower-case DNS name",
			);
		}
		expect(JSON.stringify(rawConfig)).not.toContain("KANTEL_COMPUTE_PORTS_DOMAIN");
	});

	it("turns email-code sign-in on with the public origin and its sender, binding mail to that sender only", () => {
		const config = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy"));
		const off = config({});
		expect(off.send_email).toBeUndefined();
		expect((off.vars as Record<string, string>).KANTEL_PUBLIC_URL).toBeUndefined();
		const on = config({ KANTEL_PUBLIC_URL: "https://app.kantel.dev/", KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev" });
		expect(on.send_email).toEqual([{ name: "SIGN_IN_MAIL", allowed_sender_addresses: ["sign-in@kantel.dev"] }]);
		expect(on.vars).toMatchObject({
			KANTEL_PUBLIC_URL: "https://app.kantel.dev",
			KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev",
		});
		expect((on.vars as Record<string, string>).KANTEL_SIGN_IN_DAILY_CAP).toBeUndefined();
		// The public origin's custom domain is attached outside the deploy: only the Access hostname's route is here.
		expect(on.routes).toEqual([{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }]);
		const capped = config({
			KANTEL_PUBLIC_URL: "https://app.kantel.dev",
			KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev",
			KANTEL_SIGN_IN_DAILY_CAP: "50",
		});
		expect((capped.vars as Record<string, string>).KANTEL_SIGN_IN_DAILY_CAP).toBe("50");
		for (const [env, message] of [
			[{ KANTEL_PUBLIC_URL: "https://app.kantel.dev" }, "Set both KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM"],
			[{ KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev" }, "Set both KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM"],
			[
				{ KANTEL_PUBLIC_URL: "http://app.kantel.dev", KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev" },
				"KANTEL_PUBLIC_URL must be an https:// origin",
			],
			[
				{ KANTEL_PUBLIC_URL: "https://harbour.myslop.app", KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev" },
				"another hostname than KANTEL_HOSTNAME",
			],
		] as const) {
			expect(() => deployValues({ ...configured, ...env }, "deploy")).toThrow(message);
		}
		expect(() => deployConfig({ ...rawConfig, send_email: [] }, deployValues(configured, "deploy"))).toThrow(
			"must not set send_email",
		);
	});

	it("turns accounts' own hosts on only when asked, and only with the public origin they dial", () => {
		const config = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy"));
		const publicOrigin = { KANTEL_PUBLIC_URL: "https://app.kantel.dev", KANTEL_SIGN_IN_FROM: "sign-in@kantel.dev" };
		// Unset, the Worker's own `""` (off) stands; `off` is passed on as it is.
		expect((config(publicOrigin).vars as Record<string, string>).KANTEL_ACCOUNT_HOSTS).toBe("");
		expect(
			(config({ ...publicOrigin, KANTEL_ACCOUNT_HOSTS: "off" }).vars as Record<string, string>).KANTEL_ACCOUNT_HOSTS,
		).toBe("off");
		const on = config({ ...publicOrigin, KANTEL_ACCOUNT_HOSTS: "experimental" });
		expect(on.vars).toMatchObject({
			KANTEL_ACCOUNT_HOSTS: "experimental",
			KANTEL_PUBLIC_URL: "https://app.kantel.dev",
		});
		// Nothing more is routed for it: hosts dial the public origin's custom domain.
		expect(on.routes).toEqual([{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }]);
		expect(() => deployValues({ ...configured, KANTEL_ACCOUNT_HOSTS: "experimental" }, "deploy")).toThrow(
			"KANTEL_ACCOUNT_HOSTS needs KANTEL_PUBLIC_URL",
		);
		// The origin may be the hosts' alone, with no sender: email sign-in and its mail binding stay off, and the Worker
		// takes the vars. Switched off again (a rollback), the origin alone stays valid.
		for (const value of ["experimental", "off"]) {
			const hostsOnly = config({ KANTEL_PUBLIC_URL: "https://hosts.example.com", KANTEL_ACCOUNT_HOSTS: value });
			const vars = hostsOnly.vars as Record<string, string>;
			expect(vars).toMatchObject({ KANTEL_PUBLIC_URL: "https://hosts.example.com", KANTEL_ACCOUNT_HOSTS: value });
			expect(vars.KANTEL_SIGN_IN_FROM).toBeUndefined();
			expect(hostsOnly.send_email).toBeUndefined();
			const runtime = gatewayConfig({
				KANTEL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
				KANTEL_ACCESS_AUD: "aud",
				KANTEL_PUBLIC_URL: vars.KANTEL_PUBLIC_URL,
				KANTEL_ACCOUNT_HOSTS: vars.KANTEL_ACCOUNT_HOSTS,
			});
			expect(runtime.emailSignIn).toBeUndefined();
			expect(runtime.accountHosts !== undefined).toBe(value === "experimental");
		}
		// With no switch, the origin is sign-in's and needs its sender.
		expect(() => deployValues({ ...configured, KANTEL_PUBLIC_URL: "https://hosts.example.com" }, "deploy")).toThrow(
			"Set both KANTEL_PUBLIC_URL and KANTEL_SIGN_IN_FROM",
		);
		expect(() => deployValues({ ...configured, ...publicOrigin, KANTEL_ACCOUNT_HOSTS: "on" }, "deploy")).toThrow(
			"KANTEL_ACCOUNT_HOSTS must be experimental or off",
		);
	});

	it("runs snapshot expiry on the deployed stack, and reads the switch strictly", () => {
		const access = { KANTEL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", KANTEL_ACCESS_AUD: "aud" };
		const deployed = deployConfig(rawConfig, deployValues(configured, "deploy")).vars as Record<string, string>;
		expect(deployed.KANTEL_SNAPSHOT_EXPIRY).toBe("on");
		expect(gatewayConfig({ ...access, KANTEL_SNAPSHOT_EXPIRY: "on" }).snapshotExpiry).toBe(true);
		expect(gatewayConfig({ ...access }).snapshotExpiry).toBeUndefined();
		expect(gatewayConfig({ ...access, KANTEL_SNAPSHOT_EXPIRY: "off" }).snapshotExpiry).toBeUndefined();
		expect(() => gatewayConfig({ ...access, KANTEL_SNAPSHOT_EXPIRY: "yes" })).toThrow("KANTEL_SNAPSHOT_EXPIRY");
	});

	it("passes where account hosts' latest kantel-host is read on, a URL or off, and leaves the default unset", () => {
		const vars = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy")).vars as Record<string, string>;
		expect(vars({}).KANTEL_HOST_RELEASES).toBe("");
		expect(vars({ KANTEL_HOST_RELEASES: "off" }).KANTEL_HOST_RELEASES).toBe("off");
		expect(vars({ KANTEL_HOST_RELEASES: "OFF" }).KANTEL_HOST_RELEASES).toBe("off");
		expect(vars({ KANTEL_HOST_RELEASES: "https://dl.example/latest.json" }).KANTEL_HOST_RELEASES).toBe(
			"https://dl.example/latest.json",
		);
		expect(() => deployValues({ ...configured, KANTEL_HOST_RELEASES: "latest.json" }, "deploy")).toThrow(
			"KANTEL_HOST_RELEASES must be an https:// URL, or off",
		);
		// What the Worker then reads: the mirror, or none.
		const hosts = { KANTEL_ACCOUNT_HOSTS: "experimental", KANTEL_PUBLIC_URL: "https://hosts.example.com" };
		const releasesUrl = (value: string) =>
			gatewayConfig({ ...hosts, KANTEL_HOST_RELEASES: vars({ KANTEL_HOST_RELEASES: value }).KANTEL_HOST_RELEASES })
				.accountHosts?.releasesUrl;
		expect(releasesUrl("https://dl.example/latest.json")).toBe("https://dl.example/latest.json");
		expect(releasesUrl("off")).toBeUndefined();
	});

	it("passes the templates switch on as it is, refusing anything but experimental or off", () => {
		const vars = (env: Record<string, string>) =>
			deployConfig(rawConfig, deployValues({ ...configured, ...env }, "deploy")).vars as Record<string, string>;
		expect(vars({}).KANTEL_TEMPLATES).toBe("");
		expect(vars({ KANTEL_TEMPLATES: "experimental" }).KANTEL_TEMPLATES).toBe("experimental");
		expect(vars({ KANTEL_TEMPLATES: "off" }).KANTEL_TEMPLATES).toBe("off");
		expect(() => deployValues({ ...configured, KANTEL_TEMPLATES: "on" }, "deploy")).toThrow(
			"KANTEL_TEMPLATES must be experimental or off",
		);
		const runtime = (value: string) =>
			gatewayConfig({
				KANTEL_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
				KANTEL_ACCESS_AUD: "aud",
				KANTEL_TEMPLATES: value,
			});
		expect(runtime("experimental").templates).toBe(true);
		expect(runtime("").templates).toBeUndefined();
		expect(runtime("off").templates).toBeUndefined();
		expect(() => runtime("on")).toThrow("KANTEL_TEMPLATES");
	});

	it("routes the hostname on its parent zone, never as a custom domain", () => {
		expect(zoneOf("harbour.myslop.app")).toBe("myslop.app");
		expect(zoneOf("kantel.example.co.uk")).toBe("example.co.uk");
		const config = deployConfig(
			rawConfig,
			deployValues({ ...configured, KANTEL_HOSTNAME: "Harbour.MySlop.app" }, "deploy"),
		);
		expect(config.routes).toEqual([{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }]);
		expect(JSON.stringify(config)).not.toContain("custom_domain");
	});

	it("binds the weur D1 and R2 by name by default, never the deleted first ones", () => {
		const config = deployConfig(rawConfig, deployValues(configured, "deploy"));
		expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "harbour-weur" }]);
		expect(config.r2_buckets).toEqual([{ binding: "WORKSPACES", bucket_name: "harbour-workspaces-weur" }]);
	});

	it("binds exactly today's D1, R2 and hint when the optional variables are unset", () => {
		const config = deployConfig(rawConfig, deployValues({ ...configured, KANTEL_R2_BUCKET: " " }, "deploy"));
		expect(config.d1_databases).toEqual(rawConfig.d1_databases);
		expect(config.r2_buckets).toEqual(rawConfig.r2_buckets);
		expect((config.vars as Record<string, string>).KANTEL_LOCATION_HINT).toBe(DEFAULT_LOCATION_HINT);
		expect(LOCATION_HINTS).toEqual(ROUTE_LOCATION_HINTS);
	});

	it("points DB, WORKSPACES and the objects' hint elsewhere when the variables say so", () => {
		const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
		const moved = {
			...configured,
			KANTEL_D1_DATABASE_NAME: "harbour-weur",
			KANTEL_D1_DATABASE_ID: id.toUpperCase(),
			KANTEL_R2_BUCKET: "harbour-workspaces-weur",
			KANTEL_LOCATION_HINT: "eeur",
		};
		for (const mode of ["deploy", "dry-run"] as const) {
			const config = deployConfig(rawConfig, deployValues(moved, mode));
			expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "harbour-weur", database_id: id }]);
			expect(config.r2_buckets).toEqual([{ binding: "WORKSPACES", bucket_name: "harbour-workspaces-weur" }]);
			expect((config.vars as Record<string, string>).KANTEL_LOCATION_HINT).toBe("eeur");
		}
		// Only R2: D1 stays as it is.
		const bucketOnly = deployConfig(
			rawConfig,
			deployValues({ ...configured, KANTEL_R2_BUCKET: "other-bucket" }, "deploy"),
		);
		expect(bucketOnly.d1_databases).toEqual(rawConfig.d1_databases);
	});

	it("refuses a D1 name without its ID, a bad ID, bucket or hint, and a base config without the binding", () => {
		const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
		expect(() => deployValues({ ...configured, KANTEL_D1_DATABASE_NAME: "harbour-weur" }, "deploy")).toThrow(
			/both KANTEL_D1_DATABASE_NAME and KANTEL_D1_DATABASE_ID/,
		);
		expect(() => deployValues({ ...configured, KANTEL_D1_DATABASE_ID: id }, "dry-run")).toThrow(/or neither/);
		const bad = {
			KANTEL_D1_DATABASE_ID: "kantel",
			KANTEL_R2_BUCKET: "Kantel_Workspaces",
			KANTEL_LOCATION_HINT: "ams",
		};
		for (const [name, value] of Object.entries(bad)) {
			const env = {
				...configured,
				KANTEL_D1_DATABASE_NAME: "harbour-weur",
				KANTEL_D1_DATABASE_ID: id,
				[name]: value,
			};
			expect(() => deployValues(env, "dry-run"), name).toThrow(name);
		}
		const values = deployValues({ ...configured, KANTEL_R2_BUCKET: "other-bucket" }, "deploy");
		const { r2_buckets: _, ...noBucket } = rawConfig;
		expect(() => deployConfig(noBucket, values)).toThrow(/no r2_buckets entry for WORKSPACES/);
	});

	it("sizes every container app as Cloudflare accepts a custom instance type", () => {
		for (const app of [...BROWSER_CONTAINERS, ...SANDBOX_CONTAINERS]) {
			expect(instanceTypeProblem(app.instance_type), app.class_name).toBeUndefined();
		}
		// What the first sandbox deploy asked for, and Cloudflare refused (VALIDATE_INPUT).
		expect(instanceTypeProblem({ vcpu: 1, memory_mib: 2048, disk_mb: 8000 })).toMatch(/3 GiB per vCPU/);
		expect(instanceTypeProblem({ vcpu: 0.5, memory_mib: 4096, disk_mb: 8000 })).toMatch(/outside 1 to 4/);
		expect(instanceTypeProblem({ vcpu: 1, memory_mib: 3072, disk_mb: 30_000 })).toMatch(/over 20 GB/);
		expect(SANDBOX_CONTAINERS[0].instance_type).toEqual({ vcpu: 1, memory_mib: 3072, disk_mb: 8000 });
		expect(SANDBOX_CONTAINERS[0].max_instances).toBe(10);
	});

	it("refuses a base config that names a route or account, or could serve outside Access", () => {
		const values = deployValues(configured, "deploy");
		expect(() => deployConfig({ ...rawConfig, routes: [] }, values)).toThrow(/must not set routes/);
		expect(() => deployConfig({ ...rawConfig, account_id: "x" }, values)).toThrow(/must not set account_id/);
		expect(() => deployConfig({ ...rawConfig, workers_dev: true }, values)).toThrow(/bypass Access/);
		const { preview_urls: _, ...noPreviewSetting } = rawConfig;
		expect(() => deployConfig(noPreviewSetting, values)).toThrow(/bypass Access/);
		// The release workflow's token is a Worker secret, set by hand: as a var, it would show in the dashboard.
		expect(() => deployConfig({ ...rawConfig, vars: { KANTEL_RELEASE_CHECK_TOKEN: "x" } }, values)).toThrow(
			/must not set KANTEL_RELEASE_CHECK_TOKEN as a var/,
		);
	});
});

// A new version of harbour resets every Durable Object and the host links, SSH tunnels, desktops, browsers and
// streamed commands they hold, so the console's files are another Worker's, and a console change never touches harbour.
describe("the console's own Worker", () => {
	it("serves harbour's console through a service binding, never assets of harbour's own", () => {
		const deployed = deployConfig(rawConfig, deployValues(configured, "deploy"));
		expect(deployed.assets).toBeUndefined();
		expect(deployed.services).toEqual([{ binding: CONSOLE_BINDING, service: CONSOLE_WORKER }]);
		expect(() =>
			deployConfig({ ...rawConfig, assets: { directory: "../console/dist" } }, deployValues(configured, "deploy")),
		).toThrow(/must not set assets/);
		const { services: _, ...unbound } = rawConfig;
		expect(() => deployConfig(unbound, deployValues(configured, "deploy"))).toThrow(/must bind ASSETS/);
	});

	it("adds only the account to wrangler.console.jsonc: no route, workers.dev or preview URL around Access", () => {
		const deployed = consoleDeployConfig(consoleRaw, deployValues(configured, "deploy"));
		const { $schema: _, ...base } = consoleRaw;
		expect(deployed).toEqual({ ...base, account_id: configured.CLOUDFLARE_ACCOUNT_ID });
		expect(deployed.name).toBe(CONSOLE_WORKER);
		expect(deployed.assets).toMatchObject({ directory: "../console/dist", binding: "ASSETS", run_worker_first: true });
		expect(consoleDeployConfig(consoleRaw, deployValues({}, "dry-run"))).not.toHaveProperty("account_id");
	});

	it("refuses a console config that could be reached any way but through harbour, or could hold objects", () => {
		const values = deployValues(configured, "deploy");
		expect(() => consoleDeployConfig({ ...consoleRaw, routes: [] }, values)).toThrow(/must not set routes/);
		expect(() => consoleDeployConfig({ ...consoleRaw, durable_objects: {} }, values)).toThrow(
			/must not set durable_objects/,
		);
		expect(() => consoleDeployConfig({ ...consoleRaw, workers_dev: true }, values)).toThrow(/bypass Access/);
		expect(() => consoleDeployConfig({ ...consoleRaw, name: "harbour" }, values)).toThrow(/must name the Worker/);
		expect(() =>
			consoleDeployConfig({ ...consoleRaw, assets: { directory: "../console/dist", binding: "ASSETS" } }, values),
		).toThrow(/run_worker_first true/);
	});
});

describe("access check", () => {
	const team = "team.cloudflareaccess.com";
	const login = `https://${team}/cdn-cgi/access/login/harbour.myslop.app?kid=abc&redirect_url=%2F`;

	it("passes a redirect to the team's Access sign-in", () => {
		expect(accessVerdict(302, login, team)).toEqual({ ok: true });
		expect(accessVerdict(302, login, `https://${team}/`)).toEqual({ ok: true });
	});

	it("fails anything that means Access isn't in front of the Worker", () => {
		const fails = (reason: RegExp) => ({ ok: false, reason: expect.stringMatching(reason) });
		expect(accessVerdict(200, null, team)).toEqual(fails(/HTTP 200/));
		expect(accessVerdict(401, null, team)).toEqual(fails(/HTTP 401/));
		expect(accessVerdict(302, null, team)).toEqual(fails(/without a Location/));
		expect(accessVerdict(302, "/login", team)).toEqual(fails(/unparseable/));
		expect(accessVerdict(302, "https://other.cloudflareaccess.com/cdn-cgi/access/login/x", team)).toEqual(
			fails(/not the Access team domain/),
		);
		expect(accessVerdict(302, `http://${team}/cdn-cgi/access/login/x`, team)).toEqual(
			fails(/not the Access team domain/),
		);
		expect(accessVerdict(302, `https://${team}/somewhere`, team)).toEqual(fails(/not \/cdn-cgi/));
		expect(accessVerdict(302, `https://${team}/cdn-cgi/access/login-elsewhere`, team)).toEqual(fails(/not \/cdn-cgi/));
	});
});
