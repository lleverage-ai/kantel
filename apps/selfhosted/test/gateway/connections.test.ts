// Connections on the self-hosted gateway (epic #322): on with a public URL and a vault, served at /v1/connections, the
// client metadata document public, and the session tools in the bootstrap's profile.
import { CONNECTION_TOOL_NAMES } from "@kantel/connections/tools";
import { type CallContext, EMAIL_OTP_ISSUER, type JsonValue, type Role } from "@kantel/contracts";
import { hashSessionToken } from "@kantel/identity/otp";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, test } from "vitest";
import { bootstrap, createGatewayComponents, ECHO_ROUTE } from "../../src/gateway/components.ts";
import { connectionsConfig, privateAddress, publicFetch, refreshSweeper } from "../../src/gateway/connections.ts";
import { createGateway } from "../../src/gateway/gateway.ts";

const ORIGIN = "https://harbour.example.com";

describe("connections on the self-hosted gateway", () => {
	test("are on with a public URL, and off when asked", () => {
		expect(connectionsConfig({}, undefined)).toBeUndefined();
		expect(connectionsConfig({ KANTEL_CONNECTIONS: "off" }, ORIGIN)).toBeUndefined();
		expect(connectionsConfig({ KANTEL_CONNECTIONS_CIMD: "on" }, ORIGIN)).toEqual({
			origin: ORIGIN,
			clientMetadataPublic: true,
			personal: false,
		});
	});

	test("serve the API to a signed-in caller, the metadata document to anyone, and the tools to sessions", async () => {
		const components = createGatewayComponents({
			connections: { origin: ORIGIN, clientMetadataPublic: true, personal: false },
		});
		const seeded = await bootstrap(components, { organisation: "Connections", project: "connections" });
		const gateway = createGateway({ components });
		try {
			expect(components.connections).toBeDefined();
			const catalogue = await gateway.fetch(
				new Request(`${ORIGIN}/v1/connections/catalogue?q=notion`, {
					headers: { authorization: `Bearer ${seeded.apiKey}` },
				}),
			);
			expect(catalogue.status).toBe(200);
			const listed = (await catalogue.json()) as { items: { id: string }[] };
			expect(listed.items.map((entry) => entry.id)).toContain("notion");

			const settings = await gateway.fetch(
				new Request(`${ORIGIN}/v1/connections/settings`, { headers: { authorization: `Bearer ${seeded.apiKey}` } }),
			);
			expect(await settings.json()).toEqual({ personal: false });

			const anonymous = await gateway.fetch(new Request(`${ORIGIN}/v1/connections`));
			expect(anonymous.status).toBe(401);

			const metadata = await gateway.fetch(new Request(`${ORIGIN}/v1/connections/oauth/client-metadata.json`));
			expect(metadata.status).toBe(200);
			expect(await metadata.json()).toMatchObject({
				client_id: `${ORIGIN}/v1/connections/oauth/client-metadata.json`,
				redirect_uris: [`${ORIGIN}/v1/connections/callback`],
			});

			const profile = await components.runtime.profiles.get(
				{
					actor: { kind: "system", component: "test" },
					organisationId: seeded.organisationId,
					projectId: seeded.projectId,
				},
				"echo",
			);
			expect(profile.tools).toEqual(
				expect.arrayContaining(["connections_list", "connection_call", "connection_request"]),
			);

			// Disconnecting a key (#329): Kantel deletes its copy and says only the service can revoke the key itself.
			const inOrganisation = {
				actor: { kind: "system", component: "test" },
				organisationId: seeded.organisationId,
			} as const;
			const service = await components.identity.createServiceIdentity(inOrganisation, { name: "connections admin" });
			const admin = await components.identity.issueApiKey(inOrganisation, {
				serviceId: service.id,
				projectIds: [seeded.projectId],
				role: "admin",
			});
			const authed = (method: string, path: string, body?: unknown) =>
				gateway.fetch(
					new Request(`${ORIGIN}${path}`, {
						method,
						headers: { authorization: `Bearer ${admin.secret}`, "content-type": "application/json" },
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				);
			const made = await authed("POST", "/v1/connections/keys", {
				owner: { kind: "project", organisationId: seeded.organisationId, projectId: seeded.projectId },
				custom: { hosts: ["api.example.com"], injection: { kind: "bearer" }, kind: "http" },
				value: "sk-live-abcdefghijklmnop",
			});
			expect(made.status).toBe(201);
			const key = (await made.json()) as { id: string };
			const removed = await authed("DELETE", `/v1/connections/${key.id}`);
			expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({
				connectionId: key.id,
				revocation: { outcome: "unsupported" },
				rulesRemoved: 0,
				approvalsWithdrawn: 0,
			});
			expect((await authed("GET", `/v1/connections/${key.id}`)).status).toBe(404);

			// Which connections a session may use (#335), read from the gateway's own sessions.
			const auth = { authorization: `Bearer ${seeded.apiKey}`, "content-type": "application/json" };
			const created = await gateway.fetch(
				new Request(`${ORIGIN}/v1/sessions`, {
					method: "POST",
					headers: auth,
					body: JSON.stringify({ projectId: seeded.projectId, agentId: "echo" }),
				}),
			);
			expect(created.status).toBe(201);
			const session = (await created.json()) as { id: string };
			const eligible = await gateway.fetch(
				new Request(`${ORIGIN}/v1/connections/eligible?sessionId=${session.id}&visibility=shared`, { headers: auth }),
			);
			expect(eligible.status).toBe(200);
			expect(await eligible.json()).toEqual({ items: [] });
			const share = await gateway.fetch(
				new Request(`${ORIGIN}/v1/connections/con_missing/shares`, {
					method: "POST",
					headers: auth,
					body: JSON.stringify({ projectId: seeded.projectId }),
				}),
			);
			expect(share.status).toBe(404);
		} finally {
			await gateway.close();
			await components.close();
		}
	});
});

describe("people and organisation sessions on the self-hosted gateway (#335)", () => {
	async function serve() {
		const { models, script } = createScriptedModel();
		const components = createGatewayComponents({
			models: { models },
			connections: { origin: ORIGIN, clientMetadataPublic: false, personal: false },
		});
		const seeded = await bootstrap(components, { organisation: "People", project: "people" });
		const gateway = createGateway({ components });
		const { organisationId, projectId } = seeded;
		const system: CallContext = { actor: { kind: "system", component: "test" }, organisationId };
		// An organisation-wide agent profile: it runs in organisation sessions and in any project's.
		await components.runtime.profiles.put(system, {
			id: "org-agent",
			organisationId,
			name: "Organisation agent",
			model: { route: ECHO_ROUTE },
			promptLayers: [],
			tools: [...CONNECTION_TOOL_NAMES],
			skills: [],
			sandbox: { tiers: ["isolate"] },
			memoryScopes: [],
		});
		/** A person with `role` across the organisation, signed in with a Kantel session. */
		const person = async (name: string, role: Role) => {
			const email = `${name.toLowerCase()}@harbour.example.com`;
			const user = await components.identity.createUser(system, { name, email });
			await components.identity.grantRole(system, { principal: { kind: "user", userId: user.id }, role });
			const token = `hbs_${crypto.randomUUID().replaceAll("-", "")}`;
			await components.otp.sessions.create({
				id: `s_${name}`,
				tokenHash: await hashSessionToken(token),
				userId: user.id,
				issuer: EMAIL_OTP_ISSUER,
				subject: email,
				email,
				createdAt: Date.now(),
				expiresAt: Date.now() + 3_600_000,
			});
			const call = async (method: string, path: string, body?: unknown) => {
				const response = await gateway.fetch(
					new Request(`${ORIGIN}${path}`, {
						method,
						headers: {
							authorization: `Bearer ${token}`,
							...(body === undefined ? {} : { "content-type": "application/json" }),
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				);
				const text = await response.text();
				// biome-ignore lint/suspicious/noExplicitAny: a test reads the API's JSON as it comes.
				return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as any };
			};
			return { user, call };
		};
		const key = async (
			as: Awaited<ReturnType<typeof person>>,
			name: string,
			owner: Record<string, string>,
			usage?: unknown,
		) => {
			const made = await as.call("POST", "/v1/connections/keys", {
				owner,
				name,
				custom: { kind: "http", hosts: [`${name}.example.com`], injection: { kind: "bearer" } },
				value: `sk-${name}-abcdefghijklmnop`,
				...(usage === undefined ? {} : { usage }),
			});
			expect(made.status).toBe(201);
			return made.body.id as string;
		};
		const start = async (as: Awaited<ReturnType<typeof person>>, body: Record<string, unknown>) => {
			const created = await as.call("POST", "/v1/sessions", { agentId: "org-agent", ...body });
			expect(created.status).toBe(201);
			return created.body as { id: string; projectId?: string };
		};
		/** One turn of tool calls in a session, then a reply; answers the tools' items. */
		type Snapshot = Awaited<ReturnType<typeof components.runtime.runtime.snapshot>>;
		type ToolItem = Extract<Snapshot["items"][number], { kind: "tool" }>;
		const run = async (sessionId: string, toolCalls: { name: string; args: JsonValue }[]) => {
			script.reply({ toolCalls }, { text: "Done." });
			const prompt = await components.runtime.runtime.prompt(system, sessionId, { text: "Go" });
			await components.runtime.runtime.wait(system, sessionId, prompt.id);
			return (await components.runtime.runtime.snapshot(system, sessionId)).items.filter(
				(item): item is ToolItem => item.kind === "tool",
			);
		};
		const close = async () => {
			await gateway.close();
			await components.close();
		};
		return { components, organisationId, projectId, system, person, key, start, run, close };
	}

	test("list a use in someone's private session only to them, not to an organisation admin", async () => {
		const { organisationId, projectId, person, key, start, run, close } = await serve();
		try {
			const tom = await person("Tom", "admin");
			const ana = await person("Ana", "admin");
			const id = await key(tom, "tom", { kind: "user", organisationId, userId: tom.user.id });
			// A rule refuses every request, so the uses are recorded with nothing sent.
			const rule = await tom.call("POST", `/v1/connections/${id}/rules`, {
				who: { kind: "any" },
				what: { kind: "any" },
				action: "deny",
			});
			expect(rule.status).toBe(201);
			const request = {
				name: "connection_request",
				args: { connectionId: id, method: "GET", url: "https://tom.example.com/" },
			};
			const mine = await start(tom, { projectId, visibility: "private" });
			await run(mine.id, [request]);
			const seen = await start(tom, { projectId });
			await run(seen.id, [request]);

			const own = await tom.call("GET", `/v1/connections/uses?connectionId=${id}`);
			expect(own.body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionId: mine.id,
						decidedBy: "rule",
						audience: { kind: "private", userId: tom.user.id },
					}),
					expect.objectContaining({ sessionId: seen.id, audience: { kind: "shared" } }),
				]),
			);
			// Ana, an organisation admin, sees the connection and the use others could see, never the private session's.
			expect((await ana.call("GET", `/v1/connections/${id}`)).status).toBe(200);
			const sessionsOf = (body: { items: { sessionId: string }[] }) => body.items.map((use) => use.sessionId);
			expect(sessionsOf((await ana.call("GET", `/v1/connections/uses?connectionId=${id}`)).body)).toEqual([seen.id]);
			const everything = await ana.call("GET", "/v1/connections/uses");
			expect(everything.status).toBe(200);
			expect(JSON.stringify(everything.body)).not.toContain(mine.id);
			expect((await ana.call("GET", `/v1/connections/uses?sessionId=${mine.id}`)).status).toBe(403);
		} finally {
			await close();
		}
	});

	test("give an organisation-level agent the organisation's connections, plus its project's, and nothing else", async () => {
		const { components, organisationId, projectId, system, person, key, start, run, close } = await serve();
		try {
			const tom = await person("Tom", "admin");
			const other = await components.identity.createProject(system, { name: "Other" });
			const organisation = { kind: "organisation", organisationId };
			const ids = {
				org: await key(tom, "org", organisation, { unattended: false, visibility: "shared" }),
				orgInProject: await key(tom, "org-in-project", organisation, {
					projects: [projectId],
					unattended: false,
					visibility: "shared",
				}),
				project: await key(tom, "project", { kind: "project", organisationId, projectId }),
				other: await key(tom, "other", { kind: "project", organisationId, projectId: other.id }),
				personal: await key(tom, "personal", { kind: "user", organisationId, userId: tom.user.id }),
			};
			const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
			const listed = async (sessionId: string) => {
				const output = (await run(sessionId, [{ name: "connections_list", args: {} }])).at(-1)?.output ?? "";
				return [...names.entries()]
					.filter(([id]) => output.includes(id))
					.map(([, name]) => name)
					.sort();
			};
			const eligible = async (sessionId: string, query = "") =>
				Object.fromEntries(
					(
						(await tom.call("GET", `/v1/connections/eligible?sessionId=${sessionId}${query}`)).body.items as {
							connection: { id: string };
							usable: boolean;
						}[]
					).map((entry) => [names.get(entry.connection.id), entry.usable]),
				);

			const inOrganisation = await start(tom, { scope: "organisation" });
			expect(inOrganisation.projectId).toBeUndefined();
			expect(await listed(inOrganisation.id)).toEqual(["org"]);
			expect(await eligible(inOrganisation.id)).toEqual({ org: true, orgInProject: false, personal: false });
			expect((await eligible(inOrganisation.id, "&visibility=private")).personal).toBe(true);
			await run(inOrganisation.id, [
				{
					name: "connection_request",
					args: { connectionId: ids.project, method: "GET", url: "https://project.example.com/" },
				},
			]);
			const uses = (await tom.call("GET", `/v1/connections/uses?sessionId=${inOrganisation.id}`)).body.items;
			expect(uses[0]).toMatchObject({
				connectionId: ids.project,
				outcome: "denied",
				reason: expect.stringContaining("It belongs to a project, and this is an organisation session"),
			});

			const inProject = await start(tom, { projectId });
			expect(await listed(inProject.id)).toEqual(["org", "orgInProject", "project"]);
			const inOther = await start(tom, { projectId: other.id });
			expect(await listed(inOther.id)).toEqual(["org", "other"]);
		} finally {
			await close();
		}
	});
});

describe("the refresh sweeper (#328)", () => {
	test("sweeps on a timer, never two at once, logs a failure once, and stops on close", async () => {
		let sweeps = 0;
		let release: (() => void) | undefined;
		let fail = false;
		const lines: string[] = [];
		const sweeper = refreshSweeper(
			{
				sweep: async () => {
					sweeps += 1;
					if (fail) throw new Error("database down");
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { checked: 1, refreshed: 1, failed: 0 };
				},
			},
			10,
			(line) => lines.push(line),
		);
		const until = async (done: () => boolean) => {
			const deadline = Date.now() + 2_000;
			while (!done()) {
				if (Date.now() > deadline) throw new Error("timed out");
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		};
		await until(() => sweeps === 1);
		// A sweep still running isn't joined by another.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sweeps).toBe(1);
		fail = true;
		release?.();
		await until(() => sweeps >= 3);
		expect(lines.filter((line) => line.includes("the refresh sweep failed"))).toHaveLength(1);
		await sweeper.close();
		const stopped = sweeps;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sweeps).toBe(stopped);
	});
});

describe("the connections fetch", () => {
	test("refuses private, loopback and link-local addresses", async () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.20.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"::1",
			"fd00::1",
			"::ffff:127.0.0.1",
		]) {
			expect(privateAddress(address)).toBe(true);
		}
		expect(privateAddress("1.1.1.1")).toBe(false);
		expect(privateAddress("2606:4700:4700::1111")).toBe(false);
		let reached = 0;
		const guarded = publicFetch(async () => {
			reached += 1;
			return new Response("ok");
		});
		await expect(guarded("https://127.0.0.1/mcp")).rejects.toThrow(/not on the internet/);
		await expect(guarded("https://[::1]/mcp")).rejects.toThrow(/not on the internet/);
		await expect(guarded("https://localhost/mcp")).rejects.toThrow(/not on the internet/);
		expect(reached).toBe(0);
		expect(await (await guarded("https://1.1.1.1/")).text()).toBe("ok");
	});
});
