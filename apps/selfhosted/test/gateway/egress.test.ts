// The egress proxy's side of the gateway (src/gateway/egress.ts): the proxy's policy file imported into the vault, and
// the vault's decisions and the deployment's scope served behind the proxy's shared key, as apps/vault-proxy asks for
// them with HARBOUR_EGRESS_SOURCE=vault.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHostGrants } from "@harbour/vault/import";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Bootstrap, bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { EGRESS_SCOPE_PATH, importPolicyFile, policyGrants, type RedactingDecision } from "../../src/gateway/egress.ts";
import { createGateway, type Gateway } from "../../src/gateway/gateway.ts";

const KEY = "egress-test-key-0123456789";
const CANARY = "egress-canary-abcdef";
const POLICY = {
	routes: [
		{
			id: "research-site",
			host: "research-site",
			ports: [80],
			methods: ["GET", "HEAD"],
			pathPrefix: "/",
			inject: { header: "authorization", template: "Bearer {secret}", secretEnv: "HARBOUR_CANARY_SECRET" },
		},
		{ id: "example", host: "example.com", ports: [443], methods: ["GET", "HEAD"] },
		{
			id: "echo",
			host: "postman-echo.com",
			ports: [443],
			methods: ["GET"],
			pathPrefix: "/headers",
			inject: { header: "x-harbour-vault", template: "{secret}", secretEnv: "HARBOUR_CANARY_SECRET" },
		},
	],
};
const ENV = { HARBOUR_CANARY_SECRET: CANARY };

describe("policyGrants", () => {
	const scope = { organisationId: "org_1", projectId: "prj_1" } as never;

	test("imports each credentialed route for the project, and leaves the open ones to the proxy", () => {
		const { grants, leftToProxy } = policyGrants(POLICY, scope, ENV);
		expect(leftToProxy).toEqual(["example"]);
		expect(grants.map((grant) => grant.name)).toEqual(["research-site", "echo"]);
		expect(grants[0]).toMatchObject({
			hosts: ["research-site"],
			injection: { header: "authorization", template: "Bearer {key}" },
			value: CANARY,
			routes: [{ host: "research-site", methods: ["GET", "HEAD"], pathPrefix: "/" }],
			selector: scope,
		});
		expect(grants[1]?.routes[0]?.pathPrefix).toBe("/headers");
	});

	test("refuses a route whose secret is not set", () => {
		expect(() => policyGrants(POLICY, scope, {})).toThrow(/HARBOUR_CANARY_SECRET/);
	});

	test("refuses a file with no routes", () => {
		expect(() => policyGrants({}, scope, ENV)).toThrow(/routes/);
	});
});

describe("the gateway's egress decisions", () => {
	let scratch: string;
	let file: string;
	let components: ReturnType<typeof createGatewayComponents>;
	let seeded: Bootstrap;
	let gateway: Gateway;

	beforeAll(async () => {
		scratch = await mkdtemp(join(tmpdir(), "harbour-egress-"));
		file = join(scratch, "vault-policy.json");
		await writeFile(file, JSON.stringify(POLICY));
		components = createGatewayComponents();
		seeded = await bootstrap(components, { organisation: "Egress", project: "egress" });
		const scope = { organisationId: seeded.organisationId, projectId: seeded.projectId };
		gateway = createGateway({ components, egress: { key: KEY, scope } });
	});

	afterAll(async () => {
		await gateway.close();
		await components.close();
		await rm(scratch, { recursive: true, force: true });
	});

	const ask = (path: string, init: RequestInit & { key?: string } = {}) =>
		gateway.fetch(
			new Request(`http://gateway${path}`, {
				...init,
				headers: { "content-type": "application/json", authorization: `Bearer ${init.key ?? KEY}` },
			}),
		);
	const decisionOf = async (response: Response) => (await response.json()) as RedactingDecision;
	const decide = (url: string, method = "GET", sessionId = "ses_m0_1") =>
		ask("/v1/egress/decisions", {
			method: "POST",
			body: JSON.stringify({
				organisationId: seeded.organisationId,
				projectId: seeded.projectId,
				sessionId,
				method,
				url,
			}),
		});

	test("imports the policy file once, and again only when its routes change", async () => {
		const vault = components.vault;
		if (vault === undefined) throw new Error("the in-memory components have no vault");
		const scope = { organisationId: seeded.organisationId, projectId: seeded.projectId };
		const first = await importPolicyFile(vault, scope, file, ENV);
		expect(first.result?.imported.map((grant) => grant.name)).toEqual(["research-site", "echo"]);
		expect(first.leftToProxy).toEqual(["example"]);
		const again = await importPolicyFile(vault, scope, file, ENV, first.digest);
		expect(again.result).toBeUndefined();
		expect(again.digest).toBe(first.digest);
		// A changed secret alone changes nothing: the grants are the same routes.
		const rotated = await importPolicyFile(vault, scope, file, { HARBOUR_CANARY_SECRET: "another-secret-1234" });
		expect(rotated.digest).toBe(first.digest);
		// A changed route does.
		const changedFile = join(scratch, "changed-policy.json");
		const changed = structuredClone(POLICY);
		changed.routes[2]!.pathPrefix = "/headers/";
		await writeFile(changedFile, JSON.stringify(changed));
		const moved = await importPolicyFile(vault, scope, changedFile, ENV, first.digest);
		expect(moved.digest).not.toBe(first.digest);
		expect(moved.result?.imported.map((grant) => grant.name)).toEqual(["research-site", "echo"]);
	});

	test("the proxy reads its organisation and project with its key", async () => {
		const response = await ask(EGRESS_SCOPE_PATH);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ organisationId: seeded.organisationId, projectId: seeded.projectId });
	});

	test("an allowed request carries the vault's credential, for the session", async () => {
		const response = await decide("https://research-site/");
		expect(response.status).toBe(200);
		const decision = await decisionOf(response);
		expect(decision).toMatchObject({ allow: true, inject: { header: "authorization", value: `Bearer ${CANARY}` } });
		expect(typeof decision.useId).toBe("string");
		// The item's value, not the header it renders, is what the proxy must redact.
		expect(decision.redact).toEqual([CANARY]);
		const echo = await decisionOf(await decide("https://postman-echo.com/headers"));
		expect(echo).toMatchObject({ allow: true, inject: { header: "x-harbour-vault", value: CANARY }, redact: [CANARY] });
		const vault = components.vault;
		if (vault === undefined) throw new Error("the in-memory components have no vault");
		const uses = await vault.listUses(
			{ actor: { kind: "system", component: "test" }, organisationId: seeded.organisationId },
			{ sessionId: "ses_m0_1" as never },
		);
		expect(uses.items.some((use) => use.id === decision.useId && use.outcome === "injected")).toBe(true);
	});

	test("a template around the key still names the bare key to redact", async () => {
		const vault = components.vault;
		if (vault === undefined) throw new Error("the in-memory components have no vault");
		const value = "wrapped-secret-0123";
		const imported = await importHostGrants(
			vault,
			{
				actor: { kind: "system", component: "test" },
				organisationId: seeded.organisationId,
				projectId: seeded.projectId,
			},
			[
				{
					name: "wrapped",
					hosts: ["wrapped.example"],
					injection: { header: "x-api", template: "tok-{key}-v1" },
					value,
					routes: [{ host: "wrapped.example", methods: ["GET"], pathPrefix: "/" }],
					selector: { organisationId: seeded.organisationId, projectId: seeded.projectId },
				},
			],
		);
		expect(imported.refused).toEqual([]);
		const decision = await decisionOf(await decide("https://wrapped.example/data"));
		expect(decision).toMatchObject({ allow: true, inject: { header: "x-api", value: `tok-${value}-v1` } });
		expect(decision.redact).toEqual([value]);
	});

	test("a request no grant covers is denied with a fix", async () => {
		const denied = await decisionOf(await decide("https://api.github.com/zen"));
		expect(denied.allow).toBe(false);
		expect(denied.inject).toBeUndefined();
		expect(denied.redact).toBeUndefined();
		expect(typeof denied.reason).toBe("string");
		expect(typeof denied.fix?.message).toBe("string");
		const wrongMethod = await decisionOf(await decide("https://research-site/", "POST"));
		expect(wrongMethod.allow).toBe(false);
		const wrongPath = await decisionOf(await decide("https://postman-echo.com/get"));
		expect(wrongPath.allow).toBe(false);
	});

	test("the vault injects only over https", async () => {
		const plain = await decisionOf(await decide("http://research-site/"));
		expect(plain.allow).toBe(false);
		expect(plain.inject).toBeUndefined();
	});

	test("without the proxy's key there is no decision and no scope", async () => {
		for (const key of ["wrong-key-0123456789", ""]) {
			const decision = await ask("/v1/egress/decisions", {
				key,
				method: "POST",
				body: JSON.stringify({ organisationId: seeded.organisationId, method: "GET", url: "https://research-site/" }),
			});
			expect(decision.status).toBe(403);
			expect(await decision.text()).not.toContain(CANARY);
			expect((await ask(EGRESS_SCOPE_PATH, { key })).status).toBe(403);
		}
		// Nor does an operator API key stand in for it.
		const asOperator = await gateway.fetch(
			new Request("http://gateway/v1/egress/decisions", {
				method: "POST",
				headers: { authorization: `Bearer ${seeded.apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({ organisationId: seeded.organisationId, method: "GET", url: "https://research-site/" }),
			}),
		);
		expect(asOperator.status).toBe(403);
	});

	test("a gateway with no egress key mounts no egress routes", async () => {
		const plain = createGateway({ components });
		const response = await plain.fetch(
			new Request("http://gateway/v1/egress/decisions", {
				method: "POST",
				headers: { authorization: `Bearer ${KEY}` },
				body: "{}",
			}),
		);
		expect(response.status).not.toBe(200);
		await plain.close();
	});
});
