// The gateway on its real components (durable.ts), against the compose stack's Postgres and MinIO: the end-to-end pass,
// then a restart on the same schema that must keep the deployment, its sessions, workspace and audit trail; and a
// session shaped like a host app's worker that lists its skills, reads one at `/skills`, is given memory and calls its host's
// tool after a restart.
//
// Runs when KANTEL_TEST_POSTGRES_URL and KANTEL_TEST_S3_ENDPOINT are set (bindings.ts sets them in CI). Each run gets
// fresh schemas and its own object prefix, all removed afterwards.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallContext, type HostToolCall, systemContext } from "@kantel/contracts";
import { bearer, createSessionApiClient } from "@kantel/runtime/http";
import { createScriptedModel } from "@kantel/runtime/testing";
import { AwsClient } from "aws4fetch";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { callbackUrlAllowed, parseCallbackOrigins } from "../../src/gateway/callbacks.ts";
import { type Bootstrap, bootstrap, type GatewayComponents } from "../../src/gateway/components.ts";
import { createDurableGatewayComponents, type DurableConfig, withSearchPath } from "../../src/gateway/durable.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { runGatewayE2e } from "./e2e.ts";

const databaseUrl = process.env.KANTEL_TEST_POSTGRES_URL ?? "";
const s3Endpoint = process.env.KANTEL_TEST_S3_ENDPOINT ?? "";
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const prefix = `m1-sh1/${run}`;
const config: DurableConfig = {
	databaseUrl,
	schema: `m1sh_gateway_${run}`,
	s3: {
		endpoint: s3Endpoint,
		bucket: process.env.KANTEL_TEST_S3_BUCKET ?? "harbour-m1-sh1",
		accessKeyId: process.env.KANTEL_TEST_S3_ACCESS_KEY ?? "harbour",
		secretAccessKey: process.env.KANTEL_TEST_S3_SECRET_KEY ?? "harbour-dev-secret",
		prefix,
		skillsPrefix: `${prefix}/skills`,
	},
	log: () => {},
};
const names = { organisation: "Durable", project: "durable" };
const schemas: string[] = [];

async function sql(text: string): Promise<pg.QueryResult> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		return await client.query(text);
	} finally {
		await client.end();
	}
}

/** Deletes this run's objects, and only them. */
async function deleteRunObjects(): Promise<void> {
	const client = new AwsClient({
		accessKeyId: config.s3.accessKeyId,
		secretAccessKey: config.s3.secretAccessKey,
		service: "s3",
		region: "us-east-1",
	});
	const bucket = `${s3Endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.s3.bucket)}`;
	for (;;) {
		const listed = await client.fetch(`${bucket}?${new URLSearchParams({ "list-type": "2", prefix: `${prefix}/` })}`);
		const listing = await listed.text();
		if (!listed.ok) throw new Error(`listing ${prefix} failed with ${listed.status}`);
		const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)]
			.map((match) => (match[1] ?? "").replaceAll("&amp;", "&"))
			.filter((key) => key.startsWith(`${prefix}/`));
		if (keys.length === 0) return;
		for (const key of keys) {
			const response = await client.fetch(`${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, {
				method: "DELETE",
			});
			await response.body?.cancel();
			if (!response.ok) throw new Error(`deleting ${key} failed with ${response.status}`);
		}
	}
}

/** Components for `schema`, closed when `work` ends however it ends. */
async function withComponents<T>(
	schema: string,
	work: (components: GatewayComponents) => Promise<T>,
	models?: DurableConfig["models"],
): Promise<T> {
	schemas.push(schema);
	const components = await createDurableGatewayComponents({
		...config,
		schema,
		...(models === undefined ? {} : { models }),
	});
	try {
		return await work(components);
	} finally {
		await components.close();
	}
}

async function withGateway<T>(
	components: GatewayComponents,
	seeded: Bootstrap,
	consoleDir: string,
	work: (target: Parameters<typeof runGatewayE2e>[0]) => Promise<T>,
): Promise<T> {
	const gateway = createGateway({ components, consoleDir });
	try {
		const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
		try {
			return await work({ baseUrl: server.url, ...seeded });
		} finally {
			await server.close();
		}
	} finally {
		await gateway.close();
	}
}

describe.skipIf(databaseUrl === "" || s3Endpoint === "")("the gateway on Postgres and S3", () => {
	let scratch: string | undefined;

	afterAll(async () => {
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
		for (const schema of schemas) await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await deleteRunObjects();
	});

	test("serves every API end to end, and keeps its deployment across a restart", { timeout: 120_000 }, async () => {
		const consoleDir = await mkdtemp(join(tmpdir(), "kantel-durable-"));
		scratch = consoleDir;
		await writeFile(join(consoleDir, "index.html"), '<!doctype html><div id="root"></div>');

		let seeded: Bootstrap | undefined;
		let sessionsBefore = 0;
		let auditBefore = 0;
		const inProject = (deployment: Bootstrap): CallContext => ({
			actor: { kind: "system", component: "durable-test" },
			organisationId: deployment.organisationId,
			projectId: deployment.projectId,
		});

		await withComponents(config.schema, async (first) => {
			expect(first.bindings).toMatchObject({ identity: "postgres", audit: "postgres", workspaces: "postgres + s3" });
			const deployment = await bootstrap(first, names);
			seeded = deployment;
			await withGateway(first, deployment, consoleDir, async (target) => {
				const checks = await runGatewayE2e(target);
				expect(checks.filter((check) => !check.ok)).toEqual([]);
			});
			const ctx = inProject(deployment);
			sessionsBefore = (await first.runtime.directory.list(ctx, { projectId: deployment.projectId })).items.length;
			auditBefore = (await first.audit.query(ctx, { projectId: deployment.projectId }, { limit: 500 })).items.length;
			expect(sessionsBefore).toBeGreaterThan(0);
			expect(auditBefore).toBeGreaterThan(0);
		});
		if (seeded === undefined) throw new Error("no deployment");
		const previous = seeded;

		// A new process on the same database: the bootstrap finds its deployment instead of making another.
		await withComponents(config.schema, async (second) => {
			const again = await bootstrap(second, names, previous);
			expect(again).toEqual(previous);
			const ctx = inProject(again);
			const sessions = await second.runtime.directory.list(ctx, { projectId: again.projectId });
			expect(sessions.items.length).toBe(sessionsBefore);
			const audit = await second.audit.query(ctx, { projectId: again.projectId }, { limit: 500 });
			expect(audit.items.length).toBeGreaterThanOrEqual(auditBefore);
			// The README went in once: the restart's bootstrap did not commit it again.
			expect((await second.workspaces.get(ctx, again.workspaceId)).head).toBe(1);
			await withGateway(second, again, consoleDir, async (target) => {
				const checks = await runGatewayE2e(target);
				expect(checks.filter((check) => !check.ok)).toEqual([]);
			});
		});

		// The key still authenticates but its project is gone: the bootstrap starts over.
		await sql(`DELETE FROM ${config.schema}.identity_projects WHERE id = '${previous.projectId}'`);
		await withComponents(config.schema, async (third) => {
			const fresh = await bootstrap(third, names, previous);
			expect(fresh.projectId).not.toBe(previous.projectId);
		});

		// A key that does not authenticate at all (here, a fresh schema): the bootstrap starts over.
		await withComponents(`${config.schema}_b`, async (other) => {
			const fresh = await bootstrap(other, names, previous);
			expect(fresh.organisationId).not.toBe(previous.organisationId);
		});
	});

	test("a host app's tools on a loopback callback still answer after a restart, with nobody registering again", {
		timeout: 60_000,
	}, async () => {
		const schema = `${config.schema}_hosts`;
		const calls: HostToolCall[] = [];
		// A host app's worker's shape: one callback server on a loopback port the OS picks, a route per host.
		const endpoints = new Map<string, (request: Request) => Promise<Response>>();
		const host = await listen(
			async (request) => {
				const match = /^\/hosts\/([^/]+)$/.exec(new URL(request.url).pathname);
				const endpoint = match === null ? undefined : endpoints.get(decodeURIComponent(match[1] as string));
				return endpoint === undefined ? new Response("not found", { status: 404 }) : endpoint(request);
			},
			0,
			{ host: "127.0.0.1" },
		);
		const loopback = callbackUrlAllowed(parseCallbackOrigins("http://127.0.0.1:*"));
		const serve = async <T>(components: GatewayComponents, work: (baseUrl: string) => Promise<T>) => {
			const gateway = createGateway({ components, allowCallbackUrl: loopback });
			const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
			try {
				return await work(`${server.url}/v1`);
			} finally {
				await gateway.close();
				await server.close();
			}
		};
		try {
			let seeded: Bootstrap | undefined;
			const ctx = (deployment: Bootstrap): CallContext => ({
				actor: { kind: "service", serviceId: "atlas" },
				organisationId: deployment.organisationId,
				projectId: deployment.projectId,
			});
			const client = (baseUrl: string, deployment: Bootstrap) =>
				createSessionApiClient({
					baseUrl,
					credentials: bearer(deployment.apiKey),
					hostCallbacks: {
						url: (hostId) => `${host.url}/hosts/${encodeURIComponent(hostId)}`,
						serve: (hostId, endpoint) => {
							if (endpoint === undefined) endpoints.delete(hostId);
							else endpoints.set(hostId, endpoint);
						},
					},
				});

			// The first process: the host registers its tool, and the gateway stops.
			await withComponents(schema, async (first) => {
				const deployment = await bootstrap(first, names);
				seeded = deployment;
				await first.runtime.profiles.put(
					{ ...ctx(deployment), actor: { kind: "system", component: "durable-test" } },
					{
						id: "worker",
						organisationId: deployment.organisationId,
						projectId: deployment.projectId,
						name: "Worker",
						model: { route: "default" },
						promptLayers: [],
						tools: ["ping"],
						skills: [],
						sandbox: { tiers: [] },
						memoryScopes: [],
						hostId: "atlas",
					},
				);
				await serve(first, (baseUrl) =>
					client(baseUrl, deployment).hostTools.register(
						ctx(deployment),
						"atlas",
						[{ name: "ping", description: "Answers pong", inputSchema: { type: "object" }, replay: "safe" }],
						async (call) => {
							calls.push(call);
							return { output: "pong" };
						},
					),
				);
			});
			if (seeded === undefined) throw new Error("no deployment");
			const deployment = seeded;

			// The next process on the same schema calls the tool over the stored callback.
			const { models, script } = createScriptedModel();
			script.reply({ toolCalls: [{ name: "ping", args: {} }] });
			script.reply({ text: "The host said pong" });
			await withComponents(
				schema,
				async (second) => {
					await bootstrap(second, names, deployment);
					await serve(second, async (baseUrl) => {
						const api = client(baseUrl, deployment).runtime;
						const session = await api.create(ctx(deployment), {
							projectId: deployment.projectId,
							agentId: "worker",
						});
						const prompt = await api.prompt(ctx(deployment), session.id, { text: "Ping the host" });
						expect(await api.wait(ctx(deployment), session.id, prompt.id)).toMatchObject({
							status: "answered",
							answer: "The host said pong",
						});
					});
				},
				{ models },
			);
			expect(calls.map((call) => call.tool)).toEqual(["ping"]);
			expect(script.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", text: "pong" });
		} finally {
			await host.close();
		}
	});

	test("a session shaped like a host app's worker lists its skills, reads /skills, is given memory and calls its host after a restart", {
		timeout: 90_000,
	}, async () => {
		const schema = `${config.schema}_atlas`;
		const atlasNames = { ...names, projects: ["atlas", "dev"] };
		const calls: HostToolCall[] = [];
		const endpoints = new Map<string, (request: Request) => Promise<Response>>();
		const host = await listen(
			async (request) => {
				const match = /^\/hosts\/([^/]+)$/.exec(new URL(request.url).pathname);
				const endpoint = match === null ? undefined : endpoints.get(decodeURIComponent(match[1] as string));
				return endpoint === undefined ? new Response("not found", { status: 404 }) : endpoint(request);
			},
			0,
			{ host: "127.0.0.1" },
		);
		const loopback = callbackUrlAllowed(parseCallbackOrigins("http://127.0.0.1:*"));
		const serve = async <T>(components: GatewayComponents, work: (baseUrl: string) => Promise<T>) => {
			const gateway = createGateway({ components, allowCallbackUrl: loopback });
			const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
			try {
				return await work(`${server.url}/v1`);
			} finally {
				await gateway.close();
				await server.close();
			}
		};
		const skillMd =
			"---\nname: pr-review\ndescription: Review a pull request\n---\n\n# PR review\n\nRead the diff first.\n";
		const statement = "Kantel's self-hosted gateway listens on 127.0.0.1:58090 next to Atlas.";
		const prompt = "You are Atlas's worker.";
		// The task the session is given: memory is recalled by it, so it names what the concept is about.
		const task = "Review the PR that moves the gateway port";
		try {
			let seeded: Bootstrap | undefined;
			const inDev = (deployment: Bootstrap): CallContext => ({
				actor: { kind: "service", serviceId: "atlas" },
				organisationId: deployment.organisationId,
				projectId: deployment.projects?.dev ?? "",
			});
			const client = (baseUrl: string, deployment: Bootstrap) =>
				createSessionApiClient({
					baseUrl,
					credentials: bearer(deployment.apiKey),
					hostCallbacks: {
						url: (hostId) => `${host.url}/hosts/${encodeURIComponent(hostId)}`,
						serve: (hostId, endpoint) => {
							if (endpoint === undefined) endpoints.delete(hostId);
							else endpoints.set(hostId, endpoint);
						},
					},
				});

			// The first process: the bootstrap makes the host app's projects; the organisation's skill and memory are loaded as
			// a host adapter would; the host app's worker puts its profile and registers its host tool, and the gateway stops.
			await withComponents(schema, async (first) => {
				const deployment = await bootstrap(first, atlasNames);
				seeded = deployment;
				const dev = deployment.projects?.dev;
				expect(Object.keys(deployment.projects ?? {}).sort()).toEqual(["atlas", "dev"]);
				expect(dev).toMatch(/^prj_/);
				const system: CallContext = {
					actor: { kind: "system", component: "durable-test" },
					organisationId: deployment.organisationId,
				};
				const owner = { kind: "organisation", organisationId: deployment.organisationId } as const;
				await first.skills.importRevision(system, {
					owner,
					name: "pr-review",
					description: "Review a pull request",
					files: [{ path: "SKILL.md", content: skillMd }],
					source: { sourceId: "team-skills", ref: "r1" },
				});
				const space = await first.memory.createSpace(system, { owner, name: "Team memory" });
				await first.memory.importSnapshot(system, space.id, {
					sourceId: "team-memory",
					ref: "m1",
					concepts: [
						{
							id: "projects/kantel/gateway-port",
							title: "Kantel gateway port",
							description: "Where the self-hosted gateway listens",
							statement,
							scope: { kind: "global" },
							sources: ["https://github.com/tvdavies/harbour/issues/232"],
							setBy: "owner",
							status: "active",
							updatedAt: 1,
						},
					],
				});
				await serve(first, async (baseUrl) => {
					const atlas = client(baseUrl, deployment);
					await atlas.profiles.put(inDev(deployment), {
						id: "atlas-worker",
						organisationId: deployment.organisationId,
						projectId: dev,
						name: "Atlas worker",
						model: { route: "default" },
						promptLayers: [{ name: "atlas_preamble", text: prompt }],
						tools: ["read", "ls", "bash", "ping"],
						skills: ["pr-review"],
						sandbox: { tiers: ["isolate"] },
						memoryScopes: [space.id],
						hostId: "atlas",
					});
					await atlas.hostTools.register(
						inDev(deployment),
						"atlas",
						[{ name: "ping", description: "Answers pong", inputSchema: { type: "object" }, replay: "safe" }],
						async (call) => {
							calls.push(call);
							return { output: "pong" };
						},
					);
					// The skill and the space read back through the gateway's routes, with the operator key.
					const headers = { authorization: `Bearer ${deployment.apiKey}` };
					const listed = await fetch(`${baseUrl}/skills?projectId=${encodeURIComponent(dev ?? "")}`, { headers });
					expect(((await listed.json()) as { items: { name: string }[] }).items.map((item) => item.name)).toEqual([
						"pr-review",
					]);
					const recalled = await fetch(`${baseUrl}/memory/recall`, {
						method: "POST",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify({ spaceIds: [space.id], query: "gateway port" }),
					});
					expect(((await recalled.json()) as { text: string }).text).toContain(statement);
				});
			});
			if (seeded === undefined) throw new Error("no deployment");
			const deployment = seeded;

			// The next process on the same schema: the bootstrap finds the same projects and key, and a session in `dev` lists
			// its skill, reads it at /skills, is given the memory, sees no credential in its sandbox and calls the host.
			const { models, script } = createScriptedModel();
			script.reply(
				{ toolCalls: [{ name: "read", args: { path: "/skills/pr-review/SKILL.md" } }] },
				{ toolCalls: [{ name: "bash", args: { command: "env; ls -la /" } }] },
				{ toolCalls: [{ name: "ping", args: {} }] },
				{ text: "Reviewed" },
			);
			await withComponents(
				schema,
				async (second) => {
					expect(second.bindings).toMatchObject({ skills: "postgres + s3", memory: "postgres" });
					expect(await bootstrap(second, atlasNames, deployment)).toEqual(deployment);
					await serve(second, async (baseUrl) => {
						const api = client(baseUrl, deployment).runtime;
						const session = await api.create(inDev(deployment), {
							projectId: deployment.projects?.dev ?? "",
							agentId: "atlas-worker",
						});
						expect(session.workspaceId).toMatch(/^session_/);
						const submitted = await api.prompt(inDev(deployment), session.id, { text: task });
						expect(await api.wait(inDev(deployment), session.id, submitted.id)).toMatchObject({
							status: "answered",
							answer: "Reviewed",
						});
						// The workspace's /skills mount is read-only.
						const agent: CallContext = {
							actor: { kind: "agent", agentId: "atlas-worker", sessionId: session.id },
							organisationId: deployment.organisationId,
							projectId: session.projectId,
						};
						const workspace = await second.workspaces.get(agent, session.workspaceId ?? "");
						await expect(
							second.workspaces.commit(agent, workspace.id, {
								baseVersion: workspace.head,
								changes: [{ op: "put", path: "/skills/pr-review/SKILL.md", content: "changed" }],
								message: "try",
							}),
						).rejects.toThrow();
					});
				},
				{ models },
			);

			const [first, afterRead, afterBash, afterPing] = script.requests;
			// Kantel adds nothing to the system prompt: it is the profile's layer, whole.
			expect(first?.system).toBe(prompt);
			// The skills listing and the recall come once, as a user message before the prompt.
			const given = first?.messages[0]?.text ?? "";
			expect(first?.messages.map((message) => message.role)).toEqual(["user", "user"]);
			expect(given).toContain("<available_skills>");
			expect(given).toContain("<name>pr-review</name>");
			expect(given).toContain("/skills/pr-review/SKILL.md");
			expect(given).toContain(statement);
			expect(first?.messages[1]?.text).toBe(task);
			expect(afterRead?.messages.at(-1)).toMatchObject({
				role: "tool",
				text: expect.stringContaining("Read the diff"),
			});
			// No credential in the sandbox: its environment is the shell's own, with neither the operator key, the S3 secret
			// nor the database's URL, and the skills are there at /skills.
			const sandbox = afterBash?.messages.at(-1)?.text ?? "";
			expect(afterBash?.messages.at(-1)?.role).toBe("tool");
			for (const secret of [deployment.apiKey, config.s3.secretAccessKey, databaseUrl]) {
				expect(sandbox).not.toContain(secret);
			}
			expect(sandbox).not.toMatch(/KANTEL_|AWS_|S3_|PGPASSWORD|DATABASE_URL|API_KEY|SECRET|TOKEN/);
			expect(sandbox).toMatch(/ skills\n/);
			expect(afterPing?.messages.at(-1)).toMatchObject({ role: "tool", text: "pong" });
			expect(calls.map((call) => call.tool)).toEqual(["ping"]);
		} finally {
			await host.close();
		}
	});

	test("the bootstrap makes its named projects once, and a new name brings a new key over them all", {
		timeout: 60_000,
	}, async () => {
		await withComponents(`${config.schema}_projects`, async (components) => {
			const first = await bootstrap(components, { ...names, projects: ["atlas", "durable"] });
			// A name that is the first project's is that project.
			expect(first.projects?.durable).toBe(first.projectId);
			const again = await bootstrap(components, { ...names, projects: ["atlas", "durable"] }, first);
			expect(again).toEqual(first);
			const more = await bootstrap(components, { ...names, projects: ["atlas", "durable", "dev"] }, first);
			expect(more.projects?.atlas).toBe(first.projects?.atlas);
			expect(more.projects?.dev).toMatch(/^prj_/);
			expect(more.apiKey).not.toBe(first.apiKey);
			const system = { ...systemContext("durable-test"), organisationId: first.organisationId };
			await expect(components.identity.authenticateApiKey(system, first.apiKey)).rejects.toThrow();
			const key = await components.identity.authenticateApiKey(system, more.apiKey);
			expect([...(key.projectIds ?? [])].sort()).toEqual(
				[first.projectId, more.projects?.atlas, more.projects?.dev].sort(),
			);
		});
	});

	test("a session's file tools work on the S3 workspace directly; bash leases an isolate on its first command", {
		timeout: 60_000,
	}, async () => {
		const { models, script } = createScriptedModel();
		await withComponents(
			`${config.schema}_tools`,
			async (components) => {
				expect(components.bindings.sandboxes).toMatch(/leased on first bash/);
				const deployment = await bootstrap(components, names);
				const system = { ...systemContext("durable-test"), organisationId: deployment.organisationId };
				const key = await components.identity.authenticateApiKey(system, deployment.apiKey);
				const ctx: CallContext = {
					actor: key.actor,
					organisationId: deployment.organisationId,
					projectId: deployment.projectId,
				};
				const { runtime } = components.runtime;
				const session = await runtime.create(ctx, {
					projectId: deployment.projectId,
					agentId: "echo",
					workspaceId: deployment.workspaceId,
				});
				const live = () => components.sandboxes.leases(system, { sessionId: session.id, live: true });
				const run = async (text: string) => {
					const prompt = await runtime.prompt(ctx, session.id, { text });
					return runtime.wait(ctx, session.id, prompt.id);
				};

				script.reply(
					{ toolCalls: [{ name: "write", args: { path: "notes/new.md", content: "from the file tool\n" } }] },
					{ text: "Written" },
				);
				expect(await run("Write it")).toMatchObject({ status: "answered", answer: "Written" });
				const read = await components.workspaces.read(ctx, deployment.workspaceId, "notes/new.md");
				expect(new TextDecoder().decode(read.content)).toBe("from the file tool\n");
				expect(await live()).toEqual([]);

				script.reply({ toolCalls: [{ name: "bash", args: { command: "cat notes/new.md" } }] }, { text: "Ran" });
				expect(await run("Show it")).toMatchObject({ status: "answered", answer: "Ran" });
				expect(script.requests.at(-1)?.messages.at(-1)).toMatchObject({
					role: "tool",
					text: expect.stringContaining("from the file tool"),
				});
				expect((await live()).map((lease) => lease.tier)).toEqual(["isolate"]);

				await runtime.close(ctx, session.id);
				expect(await live()).toEqual([]);
			},
			{ models },
		);
	});

	test("reads a database URL as node-postgres does, a socket URL with no host included", () => {
		const socket = withSearchPath("postgres://harbour@/harbour?host=%2Fvar%2Frun%2Fpostgresql", "harbour_m1");
		expect(socket).toMatchObject({ user: "harbour", database: "harbour", host: "/var/run/postgresql" });
		expect(socket.options).toBe("-c search_path=harbour_m1");
	});

	test("leaves TLS settings for node-postgres to read, as it would from the URL", () => {
		const noVerify = new pg.Client(withSearchPath("postgres://u:p@db.example/kantel?ssl=no-verify", "harbour_m1"));
		expect((noVerify as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toEqual({
			rejectUnauthorized: false,
		});
		const required = new pg.Client(withSearchPath("postgres://u:p@db.example/kantel?sslmode=require", "harbour_m1"));
		expect((required as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toBeTruthy();
	});

	test("keeps its schema when the database URL brings options of its own", async () => {
		// A URL `options` that sets the search path elsewhere must not move the gateway's tables out of its schema.
		// Two `options` parameters: node-postgres takes the last, and so must the gateway.
		const url = new URL(databaseUrl);
		url.searchParams.append("options", "-c statement_timeout=1000");
		url.searchParams.append("options", "-c search_path=public -c statement_timeout=60000");
		const pool = new pg.Pool({ ...withSearchPath(url.toString(), config.schema), max: 1 });
		try {
			const shown = await pool.query(
				"SELECT current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout",
			);
			expect(shown.rows[0]).toEqual({ path: config.schema, timeout: "1min" });
		} finally {
			await pool.end();
		}
	});
});
