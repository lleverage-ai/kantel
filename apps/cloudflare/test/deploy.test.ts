import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { accessVerdict } from "../scripts/check-access.ts";
import { DEPLOY_VARIABLES, deployConfig, deployValues, missingVariables, zoneOf } from "../scripts/deploy-config.ts";

const configured = {
	CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
	HARBOUR_HOSTNAME: "harbour.myslop.app",
	HARBOUR_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/",
	HARBOUR_ACCESS_AUD: "a".repeat(64),
	HARBOUR_MODELS_VPC_SERVICE_ID: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
	HARBOUR_ADMIN_EMAIL: "admin@harbour.test",
};

const wranglerJsonc = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const { rawConfig } = experimental_readRawConfig({ config: wranglerJsonc });

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
		expect(config.routes).toEqual([{ pattern: "harbour.example.com/*", zone_name: "example.com" }]);
	});

	it("refuses a malformed variable in either mode", () => {
		for (const mode of ["deploy", "dry-run"] as const) {
			expect(() => deployValues({ ...configured, HARBOUR_HOSTNAME: "https://harbour.myslop.app" }, mode)).toThrow(
				/HARBOUR_HOSTNAME must be a host name/,
			);
			expect(() => deployValues({ ...configured, HARBOUR_MODELS_VPC_SERVICE_ID: "sal-app" }, mode)).toThrow(
				/HARBOUR_MODELS_VPC_SERVICE_ID/,
			);
			const malformed: Record<string, readonly string[]> = {
				CLOUDFLARE_ACCOUNT_ID: ["0123", "my-account"],
				HARBOUR_HOSTNAME: ["harbour", "harbour.example-", "harbour.myslop.app/v1", "myslop.app"],
				HARBOUR_ACCESS_TEAM_DOMAIN: ["team", "https://team.cloudflareaccess.com/login"],
				HARBOUR_ACCESS_AUD: ["not hex", "abc"],
				HARBOUR_ADMIN_EMAIL: ["tom", "admin@harbour..test", "a b@harbour.test", "@harbour.test", "admin@harbour"],
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

	it("adds the account, zone route, Access vars and the models VPC service to wrangler.jsonc", () => {
		const config = deployConfig(rawConfig, deployValues(configured, "deploy"));
		expect(config).toMatchObject({
			name: "harbour",
			account_id: configured.CLOUDFLARE_ACCOUNT_ID,
			workers_dev: false,
			preview_urls: false,
			routes: [{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }],
			vpc_services: [{ binding: "MODELS", service_id: configured.HARBOUR_MODELS_VPC_SERVICE_ID }],
			vars: {
				HARBOUR_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
				HARBOUR_ACCESS_AUD: configured.HARBOUR_ACCESS_AUD,
				HARBOUR_ADMIN_EMAIL: "admin@harbour.test",
			},
		});
		// The local dev environment (its mock Access issuer and dev routes) is never deployed.
		expect(config.env).toBeUndefined();
		expect(config.main).toBe("src/index.ts");
	});

	it("routes the hostname on its parent zone, never as a custom domain", () => {
		expect(zoneOf("harbour.myslop.app")).toBe("myslop.app");
		expect(zoneOf("harbour.example.co.uk")).toBe("example.co.uk");
		const config = deployConfig(
			rawConfig,
			deployValues({ ...configured, HARBOUR_HOSTNAME: "Harbour.MySlop.app" }, "deploy"),
		);
		expect(config.routes).toEqual([{ pattern: "harbour.myslop.app/*", zone_name: "myslop.app" }]);
		expect(JSON.stringify(config)).not.toContain("custom_domain");
	});

	it("leaves D1 and R2 to be provisioned by name on the first real deploy", () => {
		const config = deployConfig(rawConfig, deployValues(configured, "deploy"));
		expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "harbour" }]);
		expect(config.r2_buckets).toEqual([{ binding: "WORKSPACES", bucket_name: "harbour-workspaces" }]);
	});

	it("refuses a base config that names a route or account, or could serve outside Access", () => {
		const values = deployValues(configured, "deploy");
		expect(() => deployConfig({ ...rawConfig, routes: [] }, values)).toThrow(/must not set routes/);
		expect(() => deployConfig({ ...rawConfig, account_id: "x" }, values)).toThrow(/must not set account_id/);
		expect(() => deployConfig({ ...rawConfig, workers_dev: true }, values)).toThrow(/bypass Access/);
		const { preview_urls: _, ...noPreviewSetting } = rawConfig;
		expect(() => deployConfig(noPreviewSetting, values)).toThrow(/bypass Access/);
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
