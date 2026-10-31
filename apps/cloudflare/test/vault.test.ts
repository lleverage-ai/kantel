// The VaultDO's portable half in Node: `createVaultCore` over `node:sqlite` standing in for the object's SQLite, its
// audit events in a SQL audit store standing in for D1, the egress decision API as the Worker routes it, and the
// deploy's vault secrets.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createSqlAuditStore } from "@harbour/audit/sql";
import { type CallContext, isHarbourError } from "@harbour/contracts";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { createEgressDecisionClient } from "@harbour/vault/egress-api";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { deployConfig, deployValues } from "../scripts/deploy-config.ts";
import { VAULT_SECRETS, vaultSecrets } from "../scripts/vault-secrets.ts";
import { routeRequest, STACK_NAME, VAULT_BODY_LIMIT, VAULT_NAME } from "../src/route.ts";
import {
	COMPONENT_TOKENS,
	componentKeys,
	createVaultCore,
	isVaultPath,
	type VaultVars,
	vaultAuditSink,
} from "../src/vault.ts";
import { objectStorage } from "./object-storage.ts";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const MODEL_GATEWAY_TOKEN = "model-gateway-token-0123456789";
const human: CallContext = { actor: { kind: "human", userId: "admin-1" }, organisationId: "org-a" };
const BASE = "https://harbour.test";

function vaultOver(objectDb: DatabaseSync, auditDb: DatabaseSync, vars: VaultVars) {
	const storage = objectStorage(objectDb);
	return createVaultCore({
		sql: storage.sql,
		transactionSync: storage.transactionSync,
		audit: vaultAuditSink(syncSqliteDriver(auditDb)),
		vars,
	});
}

const configured: VaultVars = { HARBOUR_VAULT_KEY: KEY, HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: MODEL_GATEWAY_TOKEN };

async function withConnectorItem(vault: ReturnType<typeof vaultOver>) {
	return vault.vault.putItem(human, {
		owner: { kind: "organisation", organisationId: "org-a" },
		name: "llm-key",
		hosts: ["llm.example.com"],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: "vault-do-test-value",
	});
}

const credentialRequest = (vaultItemId: string) => ({
	connectorId: "org-llm",
	owner: { kind: "organisation", organisationId: "org-a" } as const,
	vaultItemId,
	baseUrl: "http://llm.example.com/v1",
	scope: { organisationId: "org-a", projectId: "proj-a", agentId: "agent-1", sessionId: "session-1" },
});

describe("the VaultDO's core", () => {
	it("keeps the vault across a restart and serves the model gateway's key read over the egress API", async () => {
		const objectDb = new DatabaseSync(":memory:");
		const auditDb = new DatabaseSync(":memory:");
		const item = await withConnectorItem(vaultOver(objectDb, auditDb, configured));

		// The object restarts: a new core over the same SQLite sees the item and opens its value with the same key.
		const restarted = vaultOver(objectDb, auditDb, configured);
		const client = createEgressDecisionClient({
			baseUrl: BASE,
			token: MODEL_GATEWAY_TOKEN,
			fetch: async (input, init) => restarted.fetch(new Request(input, init)),
		});
		expect((await client.readConnectorCredential(credentialRequest(item.id))).value).toBe("vault-do-test-value");

		// No value reaches the object's rows or the audit store.
		const rows = JSON.stringify(objectDb.prepare("SELECT * FROM vault_items").all());
		expect(rows).toContain(item.id);
		expect(rows).not.toContain("vault-do-test-value");
		const audit = createSqlAuditStore({ driver: syncSqliteDriver(auditDb) });
		const events = await audit.query(human, {});
		expect(events.items.map((event) => event.type)).toContain("vault.use.injected");
		expect(JSON.stringify(events)).not.toContain("vault-do-test-value");
	});

	it("refuses a caller without a component's key, and every caller when no component has one", async () => {
		const objectDb = new DatabaseSync(":memory:");
		const auditDb = new DatabaseSync(":memory:");
		const item = await withConnectorItem(vaultOver(objectDb, auditDb, configured));
		const post = (vault: ReturnType<typeof vaultOver>, token?: string) =>
			vault.fetch(
				new Request(`${BASE}/v1/connector-credentials`, {
					method: "POST",
					headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
					body: JSON.stringify(credentialRequest(item.id)),
				}),
			);
		const vault = vaultOver(objectDb, auditDb, configured);
		expect((await post(vault)).status).toBe(403);
		expect((await post(vault, "not-the-model-gateway-token")).status).toBe(403);
		const noComponents = vaultOver(objectDb, auditDb, { HARBOUR_VAULT_KEY: KEY });
		const refused = await post(noComponents, MODEL_GATEWAY_TOKEN);
		expect(refused.status).toBe(403);
		expect(await refused.text()).not.toContain("vault-do-test-value");
	});

	it("will not start without a key, or with one that is not 32 bytes", () => {
		const start = (vars: VaultVars) => () =>
			vaultOver(new DatabaseSync(":memory:"), new DatabaseSync(":memory:"), vars);
		expect(start({ HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: MODEL_GATEWAY_TOKEN })).toThrow(
			expect.objectContaining({ code: "unavailable" }),
		);
		expect(start({ HARBOUR_VAULT_KEY: "  " })).toThrow(expect.objectContaining({ code: "unavailable" }));
		expect(start({ HARBOUR_VAULT_KEY: btoa("too short") })).toThrow(expect.objectContaining({ code: "invalid" }));
		try {
			start({ HARBOUR_VAULT_KEY: KEY, HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN: "short" })();
			expect.unreachable();
		} catch (error) {
			expect(isHarbourError(error) && error.code).toBe("invalid");
		}
	});

	it("names each component by its own secret", () => {
		expect(
			componentKeys({
				HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: " model-token-0123456789 ",
				HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN: "",
			}),
		).toEqual({ "model-gateway": "model-token-0123456789" });
		// The deploy writes exactly the secrets the stack reads: the vault's key, the components' keys, CPA's key,
		// brwsr's key, and Harbour's own browsers' view and seal keys.
		expect([...VAULT_SECRETS].sort()).toEqual(
			[
				"HARBOUR_VAULT_KEY",
				"HARBOUR_CPA_API_KEY",
				"HARBOUR_BRWSR_API_KEY",
				"HARBOUR_BROWSER_VIEW_KEY",
				"HARBOUR_BROWSER_SEAL_KEY",
				...Object.values(COMPONENT_TOKENS),
			].sort(),
		);
	});
});

describe("routing", () => {
	function namespace(name: string, seen: string[], hints: (string | undefined)[] = []) {
		return {
			idFromName: (objectName: string) => `${name}:${objectName}`,
			get: (id: string, options?: { locationHint?: string }) => {
				hints.push(options?.locationHint);
				return {
					fetch: async (request: Request) => {
						seen.push(`${id} ${new URL(request.url).pathname}`);
						return new Response(null, { status: 204 });
					},
				};
			},
		};
	}

	it("asks for both objects with the location hint: weur unless the Worker's var says otherwise", async () => {
		const hints: (string | undefined)[] = [];
		const env = {
			STACK: namespace("stack", [], hints),
			VAULTS: namespace("vault", [], hints),
			ASSETS: { fetch: async () => new Response(null, { status: 204 }) },
		};
		await routeRequest(new Request(`${BASE}/v1/sessions`), env);
		await routeRequest(new Request(`${BASE}/v1/egress/decisions`), env);
		await routeRequest(new Request(`${BASE}/v1/sessions`), { ...env, HARBOUR_LOCATION_HINT: " eeur " });
		expect(hints).toEqual(["weur", "weur", "eeur"]);
		await expect(
			routeRequest(new Request(`${BASE}/v1/sessions`), { ...env, HARBOUR_LOCATION_HINT: "ams" }),
		).rejects.toThrow(/HARBOUR_LOCATION_HINT must be one of/);
		// The console's assets need no object.
		await routeRequest(new Request(`${BASE}/`), { ...env, HARBOUR_LOCATION_HINT: "ams" });
	});

	it("sends the egress decision API to the one vault object and every other /v1 path to the stack", async () => {
		const seen: string[] = [];
		const env = {
			STACK: namespace("stack", seen),
			VAULTS: namespace("vault", seen),
			ASSETS: {
				fetch: async (request: Request) => {
					seen.push(`assets ${new URL(request.url).pathname}`);
					return new Response(null, { status: 204 });
				},
			},
		};
		for (const path of [
			"/v1/egress/decisions",
			"/v1/connector-credentials",
			"/v1/egress",
			"/v1/egress/decisions/x",
			"/v1/sessions",
			"/v1/connection-approvals/requests",
			"/v1/connection-approvals/requests/p-1/decision",
			"/v1/vault/proposals",
			"/v1/vault/proposals/p-1/decision",
			"/vault",
			"/vault/proposals/p-1",
			"/",
		]) {
			await routeRequest(new Request(`${BASE}${path}`), env);
		}
		expect(seen).toEqual([
			`vault:${VAULT_NAME} /v1/egress/decisions`,
			`vault:${VAULT_NAME} /v1/connector-credentials`,
			`stack:${STACK_NAME} /v1/egress`,
			`stack:${STACK_NAME} /v1/egress/decisions/x`,
			`stack:${STACK_NAME} /v1/sessions`,
			// The approval API is the stack's: it signs the person in and checks their project role before the VaultDO.
			`stack:${STACK_NAME} /v1/connection-approvals/requests`,
			`stack:${STACK_NAME} /v1/connection-approvals/requests/p-1/decision`,
			// Its deprecated alias, the same way.
			`stack:${STACK_NAME} /v1/vault/proposals`,
			`stack:${STACK_NAME} /v1/vault/proposals/p-1/decision`,
			"assets /vault",
			"assets /vault/proposals/p-1",
			"assets /",
		]);
		expect(isVaultPath("/v1/egress/decisions")).toBe(true);
		expect(isVaultPath("/v1/egress/decisions/")).toBe(false);
	});

	it("hands the vault its body whole, and refuses one past the limit before the vault sees it", async () => {
		const bodies: string[] = [];
		const vault = {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (request: Request) => {
					bodies.push(await request.text());
					return new Response(null, { status: 204 });
				},
			}),
		};
		const unused = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null) }) };
		const env = { STACK: unused, VAULTS: vault, ASSETS: { fetch: async () => new Response(null) } };
		const post = (body: BodyInit, headers: Record<string, string> = {}) =>
			routeRequest(new Request(`${BASE}/v1/egress/decisions`, { method: "POST", body, headers }), env);

		expect((await post('{"organisationId":"org-a"}')).status).toBe(204);
		expect(bodies).toEqual(['{"organisationId":"org-a"}']);
		expect((await post("x".repeat(VAULT_BODY_LIMIT))).status).toBe(204);
		// A body in several chunks reaches the vault whole and in order.
		const parts = ['{"organisationId":', '"org-b",', '"method":"GET"}'];
		const chunked = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
				controller.close();
			},
		});
		const whole = await routeRequest(
			new Request(`${BASE}/v1/egress/decisions`, { method: "POST", body: chunked, duplex: "half" } as RequestInit),
			env,
		);
		expect(whole.status).toBe(204);
		expect(bodies.at(-1)).toBe(parts.join(""));
		// A streamed body with no Content-Length is counted as it arrives, and reading stops past the limit.
		const chunk = new Uint8Array(16 * 1024);
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += 1;
				if (sent > 100) controller.close();
				else controller.enqueue(chunk);
			},
		});
		const streamed = await routeRequest(
			new Request(`${BASE}/v1/egress/decisions`, { method: "POST", body: stream, duplex: "half" } as RequestInit),
			env,
		);
		expect(streamed.status).toBe(413);
		expect(sent).toBeLessThan(100);
		expect((await post("x".repeat(VAULT_BODY_LIMIT + 1))).status).toBe(413);
		expect(bodies).toHaveLength(3);
	});
});

describe("the vault's deploy", () => {
	const wranglerJsonc = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
	const { rawConfig } = experimental_readRawConfig({ config: wranglerJsonc });
	const values = deployValues({}, "dry-run");

	it("binds the VaultDO beside the stack, with its own SQLite migration", () => {
		const config = deployConfig(rawConfig, values);
		expect(config.durable_objects).toEqual({
			bindings: [
				{ name: "STACK", class_name: "HarbourStack" },
				{ name: "VAULTS", class_name: "HarbourVault" },
				{ name: "BROWSERS", class_name: "HarbourBrowser" },
				{ name: "SANDBOXES", class_name: "HarbourSandbox" },
			],
		});
		expect(config.migrations).toEqual([
			{ tag: "v1", new_sqlite_classes: ["HarbourStack"] },
			{ tag: "v2", new_sqlite_classes: ["HarbourVault"] },
			{ tag: "v3", new_sqlite_classes: ["HarbourBrowser"] },
			{ tag: "v4", new_sqlite_classes: ["HarbourSandbox"] },
		]);
		// The vault's secrets are never vars of the deployed Worker; only the local dev environment has its own.
		for (const name of VAULT_SECRETS) expect(config.vars as Record<string, unknown>).not.toHaveProperty(name);
	});

	it("deploys the browsers' containers only when asked, held to WEUR, and keeps brwsr unless told otherwise", () => {
		const plain = deployConfig(rawConfig, values);
		expect(plain).not.toHaveProperty("containers");
		expect(plain.vars as Record<string, unknown>).not.toHaveProperty("HARBOUR_BROWSER_PROVIDER", "harbour");
		const on = deployConfig(
			rawConfig,
			deployValues({ HARBOUR_BROWSER_CONTAINERS: "on", HARBOUR_BROWSER_PROVIDER: "harbour" }, "dry-run"),
		);
		expect(on.containers).toEqual([
			expect.objectContaining({
				class_name: "HarbourBrowser",
				image: "../../images/browser/Dockerfile",
				constraints: { regions: ["WEUR"] },
			}),
		]);
		expect(on.vars).toMatchObject({ HARBOUR_BROWSER_PROVIDER: "harbour" });
	});

	it("deploys the sandbox containers only when asked, held to WEUR, with escalation on, beside the browsers'", () => {
		const plain = deployConfig(rawConfig, values);
		expect(plain).not.toHaveProperty("containers");
		expect(plain.vars).toMatchObject({ HARBOUR_SANDBOX_CONTAINERS: "off" });
		const sandbox = expect.objectContaining({
			class_name: "HarbourSandbox",
			image: "../../images/sandbox/Dockerfile",
			image_build_context: "../../images/sandbox",
			constraints: { regions: ["WEUR"] },
		});
		const on = deployConfig(rawConfig, deployValues({ HARBOUR_SANDBOX_CONTAINERS: "on" }, "dry-run"));
		expect(on.containers).toEqual([sandbox]);
		expect(on.vars).toMatchObject({ HARBOUR_SANDBOX_CONTAINERS: "on" });
		const both = deployConfig(
			rawConfig,
			deployValues({ HARBOUR_SANDBOX_CONTAINERS: "on", HARBOUR_BROWSER_CONTAINERS: "on" }, "dry-run"),
		);
		expect(both.containers).toEqual([expect.objectContaining({ class_name: "HarbourBrowser" }), sandbox]);
		expect(() => deployValues({ HARBOUR_SANDBOX_CONTAINERS: "yes" }, "dry-run")).toThrow(/HARBOUR_SANDBOX_CONTAINERS/);
	});

	it("refuses a browser setting it doesn't know", () => {
		expect(() => deployValues({ HARBOUR_BROWSER_CONTAINERS: "yes" }, "dry-run")).toThrow(/HARBOUR_BROWSER_CONTAINERS/);
		expect(() => deployValues({ HARBOUR_BROWSER_PROVIDER: "browserbase" }, "dry-run")).toThrow(
			/HARBOUR_BROWSER_PROVIDER/,
		);
	});

	it("sends the browser viewer page to the Worker first, for its framing headers, in both configs", () => {
		const first = (assets: unknown) => (assets as { run_worker_first?: string[] }).run_worker_first;
		expect(first(rawConfig.assets)).toContain("/browser/*");
		const dev = (rawConfig.env as { dev: { assets: unknown } }).dev;
		expect(first(dev.assets)).toContain("/browser/*");
	});

	it("passes the embed origins on, and refuses a wildcard, a path or plain http", () => {
		const origins = "https://app.lleverage.ai, https://staging.lleverage.ai";
		const config = deployConfig(rawConfig, deployValues({ HARBOUR_EMBED_ORIGINS: origins }, "dry-run"));
		expect(config.vars).toMatchObject({ HARBOUR_EMBED_ORIGINS: origins });
		for (const bad of ["https://*.lleverage.ai", "https://app.lleverage.ai/embed", "http://app.lleverage.ai"]) {
			expect(() => deployValues({ HARBOUR_EMBED_ORIGINS: bad }, "dry-run")).toThrow(/HARBOUR_EMBED_ORIGINS/);
		}
	});

	it("refuses a vault secret written into wrangler.jsonc as a var", () => {
		const vars = { ...(rawConfig.vars as Record<string, unknown>), HARBOUR_VAULT_KEY: KEY };
		expect(() => deployConfig({ ...rawConfig, vars }, values)).toThrow(/HARBOUR_VAULT_KEY as a var/);
	});

	it("writes only the vault secrets that are set, and refuses a malformed one without printing it", () => {
		expect(vaultSecrets({})).toEqual({});
		expect(vaultSecrets({ HARBOUR_VAULT_KEY: ` ${KEY} `, HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: "" })).toEqual({
			HARBOUR_VAULT_KEY: KEY,
		});
		const urlSafe = KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(vaultSecrets({ HARBOUR_VAULT_KEY: urlSafe })).toEqual({ HARBOUR_VAULT_KEY: urlSafe });
		for (const bad of [btoa("sixteen bytes!!!"), "not base64 at all!", `${KEY}x`]) {
			expect(() => vaultSecrets({ HARBOUR_VAULT_KEY: bad })).toThrow(/HARBOUR_VAULT_KEY must be 32 random bytes/);
			try {
				vaultSecrets({ HARBOUR_VAULT_KEY: bad });
			} catch (error) {
				expect(String(error)).not.toContain(bad);
			}
		}
		expect(() => vaultSecrets({ HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN: "short" })).toThrow(
			/HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN must be at least 16/,
		);
		expect(vaultSecrets({ HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: "a".repeat(16) })).toEqual({
			HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: "a".repeat(16),
		});
		expect(() => vaultSecrets({ HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: "a".repeat(15) })).toThrow(/at least 16/);
		// Fixed keys whose base64 has `+` and `/`, in every spelling the cipher accepts.
		const bytes = new Uint8Array(32).fill(0xfb);
		const standard = btoa(String.fromCharCode(...bytes));
		expect(standard).toMatch(/[+/]/);
		for (const spelling of [
			standard,
			standard.replace(/=+$/, ""),
			standard.replace(/\+/g, "-").replace(/\//g, "_"),
			standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
		]) {
			expect(vaultSecrets({ HARBOUR_VAULT_KEY: spelling }), spelling).toEqual({ HARBOUR_VAULT_KEY: spelling });
			expect(() =>
				vaultOver(new DatabaseSync(":memory:"), new DatabaseSync(":memory:"), { HARBOUR_VAULT_KEY: spelling }),
			).not.toThrow();
		}
	});

	describe("the secrets file the workflow hands wrangler", () => {
		const script = fileURLToPath(new URL("../scripts/vault-secrets.ts", import.meta.url));
		const TOKEN = "model-gateway-token-for-the-cli-0001";

		function run(env: Record<string, string>) {
			const dir = mkdtempSync(join(tmpdir(), "vault-secrets-"));
			const out = join(dir, "secrets.json");
			const githubOutput = join(dir, "github-output");
			writeFileSync(githubOutput, "");
			const inherited = Object.fromEntries(
				Object.entries(process.env).filter(([name]) => !name.startsWith("HARBOUR_VAULT_")),
			);
			const result = spawnSync(process.execPath, [script, "--out", out], {
				env: { ...inherited, GITHUB_OUTPUT: githubOutput, ...env },
				encoding: "utf8",
			});
			const printed = `${result.stdout}${result.stderr}`;
			const file = existsSync(out) ? { text: readFileSync(out, "utf8"), mode: statSync(out).mode & 0o777 } : undefined;
			const output = readFileSync(githubOutput, "utf8");
			rmSync(dir, { recursive: true, force: true });
			return { status: result.status, printed, file, output, out };
		}

		it("writes nothing and names no file when no vault secret is set, so the deploy runs without one", () => {
			const result = run({});
			expect(result.status).toBe(0);
			expect(result.file).toBeUndefined();
			expect(result.output).toBe("");
		});

		it("writes the set secrets to a private file, names it for the next step and prints no value", () => {
			const result = run({ HARBOUR_VAULT_KEY: KEY, HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: TOKEN });
			expect(result.status).toBe(0);
			expect(JSON.parse(result.file!.text)).toEqual({
				HARBOUR_VAULT_KEY: KEY,
				HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: TOKEN,
			});
			expect(result.file!.mode).toBe(0o600);
			expect(result.output).toBe(`file=${result.out}\n`);
			expect(result.printed).toContain("HARBOUR_VAULT_MODEL_GATEWAY_TOKEN");
			expect(result.printed).not.toContain(KEY);
			expect(result.printed).not.toContain(TOKEN);
		});

		it("fails on a malformed secret, writing nothing and printing no value", () => {
			const badKey = btoa("sixteen bytes!!!");
			const result = run({ HARBOUR_VAULT_KEY: badKey, HARBOUR_VAULT_MODEL_GATEWAY_TOKEN: TOKEN });
			expect(result.status).not.toBe(0);
			expect(result.file).toBeUndefined();
			expect(result.output).toBe("");
			expect(result.printed).toContain("HARBOUR_VAULT_KEY must be 32 random bytes");
			expect(result.printed).not.toContain(badKey);
			expect(result.printed).not.toContain(TOKEN);
		});
	});
});
