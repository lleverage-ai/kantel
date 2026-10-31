// Kantel self-hosted gateway and session host (M0 spike).
//
//   bun src/main.ts host       serve the spike API and run sessions
//   bun src/main.ts migrate    apply sql/ and exit
//
// Every host is also a gateway: a request for a session owned elsewhere is
// forwarded to its owner. Configuration is environment only; see
// deploy/compose/compose.yaml for the full list.

import pg from "pg";
import type { CreateSessionRequest, PromptRequest } from "../../../spike/contracts/index.ts";
import { Audit } from "./audit.ts";
import { NotFound, SessionHost } from "./host.ts";
import { PostgresLeases } from "./lease.ts";
import { ContainerRunner } from "./sandbox/container.ts";
import { IsolateRunner } from "./sandbox/isolate.ts";
import type { StepsScenario } from "./scenario-model.ts";
import { MinioWorkspace } from "./workspace.ts";

/** The JSON bodies of the shared scenario surface (spikes/scenario/README.md in M0-CF1). */
interface SharedInput {
	scenario?: StepsScenario;
	workspaceId?: string;
	content?: string;
	text?: string;
	requestId?: string;
	afterExec?: number;
	command?: string;
	tier?: string;
}

const env = (name: string, fallback?: string): string => {
	const value = process.env[name] ?? fallback;
	if (value === undefined) throw new Error(`missing ${name}`);
	return value;
};

export function config() {
	return {
		hostId: env("KANTEL_HOST_ID", "host-local"),
		hostUrl: env("KANTEL_HOST_URL", "http://127.0.0.1:8080"),
		port: Number(env("PORT", "8080")),
		databaseUrl: env("KANTEL_DATABASE_URL", "postgres://harbour:harbour@127.0.0.1:55432/harbour"),
		leaseTtlMs: Number(env("KANTEL_LEASE_TTL_MS", "10000")),
		takeoverPollMs: Number(env("KANTEL_TAKEOVER_POLL_MS", "500")),
		idleCloseMs: Number(env("KANTEL_IDLE_CLOSE_MS", "300000")),
		s3: {
			endpoint: env("S3_ENDPOINT", "http://127.0.0.1:59000"),
			bucket: env("S3_BUCKET", "harbour"),
			accessKeyId: env("S3_ACCESS_KEY", "harbour"),
			secretAccessKey: env("S3_SECRET_KEY", "harbour-dev-secret"),
		},
		isolateUrl: env("KANTEL_ISOLATE_URL", "http://127.0.0.1:58080"),
		/** When set, every route but /healthz needs `Authorization: Bearer <token>`. */
		spikeToken: process.env.KANTEL_SPIKE_TOKEN || undefined,
		container: {
			socket: env("DOCKER_SOCKET", "/var/run/docker.sock"),
			image: env("KANTEL_SANDBOX_IMAGE", "harbour-sandbox:dev"),
			runtime: env("KANTEL_SANDBOX_RUNTIME", "runc"),
			network: env("KANTEL_SANDBOX_NETWORK", "harbour-sandbox"),
			vaultContainer: env("KANTEL_VAULT_CONTAINER", "harbour-vault-proxy"),
			proxyUrl: env("KANTEL_VAULT_PROXY_URL", "http://vault-proxy:3128"),
			memoryBytes: Number(env("KANTEL_SANDBOX_MEMORY_BYTES", String(512 * 1024 * 1024))),
			nanoCpus: Number(env("KANTEL_SANDBOX_NANO_CPUS", String(1_000_000_000))),
		},
	};
}

export async function migrate(pool: pg.Pool) {
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock(42424242)");
		const dir = new URL("../sql/", import.meta.url).pathname;
		for (const name of [...new Bun.Glob("*.sql").scanSync(dir)].sort()) {
			await client.query(await Bun.file(`${dir}${name}`).text());
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock(42424242)").catch(() => undefined);
		client.release();
	}
}

export async function build(cfg = config()) {
	const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 20 });
	await migrate(pool);
	const leases = new PostgresLeases(pool);
	const workspace = new MinioWorkspace(pool, leases, cfg.s3);
	await workspace.ensureBucket();
	const isolate = new IsolateRunner(cfg.isolateUrl);
	const container = new ContainerRunner(cfg.container, workspace, pool);
	const audit = new Audit(pool, cfg.hostId);
	const host = new SessionHost(
		{
			hostId: cfg.hostId,
			hostUrl: cfg.hostUrl,
			databaseUrl: cfg.databaseUrl,
			leaseTtlMs: cfg.leaseTtlMs,
			takeoverPollMs: cfg.takeoverPollMs,
			idleCloseMs: cfg.idleCloseMs,
		},
		pool,
		leases,
		workspace,
		isolate,
		container,
		audit,
	);
	return { cfg, pool, leases, workspace, isolate, container, audit, host };
}

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function forward(request: Request, base: string, body: string | undefined): Promise<Response> {
	const url = new URL(request.url);
	let response: Response;
	const headers: Record<string, string> = { "content-type": "application/json", "x-harbour-forwarded": "1" };
	const authorization = request.headers.get("authorization");
	if (authorization !== null) headers.authorization = authorization;
	try {
		response = await fetch(`${base}${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			body,
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		// The owner is down but its lease has not expired yet: the session moves
		// when it does. Retryable.
		return json({ error: `owner ${base} unreachable; retry after the lease expires` }, 503);
	}
	return new Response(response.body, {
		status: response.status,
		headers: { ...Object.fromEntries(response.headers), "x-harbour-forwarded-to": base },
	});
}

async function serve() {
	const app = await build();
	const { host, cfg, pool } = app;
	await host.start();

	const server = Bun.serve({
		port: cfg.port,
		idleTimeout: 120,
		async fetch(request) {
			const url = new URL(request.url);
			const parts = url.pathname.split("/").filter(Boolean);
			try {
				if (url.pathname === "/healthz")
					return json({ ok: true, host: cfg.hostId, sessions: host.ownedSessions().length });
				if (cfg.spikeToken !== undefined && request.headers.get("authorization") !== `Bearer ${cfg.spikeToken}`) {
					return json({ error: "unauthorised" }, 401);
				}
				if (parts[0] === "sessions" && parts[1] !== undefined)
					return await sharedSurface(request, url, parts[1], parts[2]);
				if (url.pathname === "/v0/target") {
					return json({ target: "selfhosted", host: cfg.hostId, owner: host.owner, leaseTtlMs: cfg.leaseTtlMs });
				}
				if (url.pathname === "/v0/takeovers") return json({ host: cfg.hostId, takeovers: host.takeovers });
				if (parts[0] !== "v0" || parts[1] !== "sessions") return json({ error: "not found" }, 404);
				if (parts.length === 2 && request.method === "POST") {
					const body = (await request.json().catch(() => ({}))) as CreateSessionRequest;
					return json(await host.create(body.sessionId));
				}
				const sessionId = parts[2];
				if (sessionId === undefined) return json({ error: "not found" }, 404);
				const body = request.method === "POST" ? await request.text() : undefined;
				const routed = await host.route(sessionId);
				if ("forward" in routed) {
					if (request.headers.get("x-harbour-forwarded")) return json({ error: "owner moved; retry" }, 503);
					return await forward(request, routed.forward, body);
				}
				const session = routed.session;
				if (parts.length === 3 && request.method === "GET") return json(await host.state(session));
				if (parts[3] === "prompt" && request.method === "POST") {
					const prompt = JSON.parse(body ?? "{}") as PromptRequest;
					return json(await host.prompt(session, prompt.text, prompt.requestId), 202);
				}
				if (parts[3] === "live" && request.method === "GET") return json(await host.live(session));
				if (parts[3] === "audit" && request.method === "GET") {
					const rows = await pool.query(
						`SELECT id, at, actor, kind, detail FROM harbour.audit_events WHERE session_id = $1 ORDER BY id`,
						[sessionId],
					);
					return json({ events: rows.rows });
				}
				if (parts[3] === "versions" && request.method === "GET") {
					const rows = await pool.query(
						`SELECT seq, version, base, tier, changed, fence, created_at FROM harbour.workspace_versions
						 WHERE workspace_id = $1 ORDER BY seq`,
						[session.workspaceId],
					);
					return json({ versions: rows.rows });
				}
				return json({ error: "not found" }, 404);
			} catch (error) {
				if (error instanceof NotFound) return json({ error: error.message }, 404);
				console.error(error);
				return json({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, 500);
			}
		},
	});
	/**
	 * The shared scenario surface (M0-CF1's spikes/scenario/README.md):
	 * /sessions/:id/{setup,prompt,state,kill,exec,vault,fixture,file}.
	 */
	async function sharedSurface(
		request: Request,
		url: URL,
		sessionId: string,
		action: string | undefined,
	): Promise<Response> {
		const body = request.method === "POST" ? await request.text() : undefined;
		const input = JSON.parse(body || "{}") as SharedInput;
		const known = (await pool.query(`SELECT 1 FROM harbour.sessions WHERE id = $1`, [sessionId])).rowCount === 1;
		if (action === "setup" && request.method === "POST" && !known) {
			return json(await host.setup(sessionId, input.scenario, input.workspaceId));
		}
		if (!known) return json({ error: `unknown session ${sessionId}` }, 404);
		const routed = await host.route(sessionId);
		if ("forward" in routed) {
			if (request.headers.get("x-harbour-forwarded")) return json({ error: "owner moved; retry" }, 503);
			return await forward(request, routed.forward, body);
		}
		const session = routed.session;
		switch (`${request.method} ${action}`) {
			case "POST setup":
				return json(await host.setup(sessionId, input.scenario, input.workspaceId));
			case "POST prompt":
				return json(
					await host.prompt(
						session,
						String(input.content ?? input.text ?? ""),
						String(input.requestId ?? crypto.randomUUID()),
					),
				);
			case "GET state":
				return json(await host.scenarioState(session, url.searchParams.get("submission") ?? undefined));
			case "POST kill":
				return json(host.armKill(session, Number(input.afterExec ?? 1)));
			case "POST exec":
				return json(
					await host.exec(
						session,
						String(input.command),
						input.tier === "isolate" || input.tier === "container" ? input.tier : undefined,
					),
				);
			case "GET vault":
				return json(await host.vaultUses(sessionId));
			case "GET fixture":
				return json(await host.fixture(session));
			case "GET file": {
				const file = await host.file(session, url.searchParams.get("path") ?? "");
				if (file === undefined) return json({ error: "not found" }, 404);
				return new Response(file.bytes as Uint8Array<ArrayBuffer>, { headers: { "x-harbour-version": file.version } });
			}
		}
		return json({ error: "not found" }, 404);
	}

	console.log(`[${cfg.hostId}] listening on ${server.port}, lease TTL ${cfg.leaseTtlMs} ms`);
	const shutdown = async () => {
		await host.stop();
		server.stop();
		await pool.end();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

if (import.meta.main) {
	const command = process.argv[2] ?? "host";
	if (command === "host") await serve();
	else if (command === "migrate") {
		const pool = new pg.Pool({ connectionString: config().databaseUrl });
		await migrate(pool);
		await pool.end();
	} else {
		console.error(`unknown command ${command}`);
		process.exit(2);
	}
}
