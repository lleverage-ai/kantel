// The session host: runs Pi Durable sessions while it holds their leases.
//
// Any host answers any request. A request for a session another live host
// owns is forwarded to it; a session whose owner died (lease expired) is
// taken over by whichever host touches it first, or by the takeover loop,
// which wakes exactly when the next active lease expires.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Storage, type SubmissionId, type Wake } from "@earendil-works/pi-durable";
import pg from "pg";
import type {
	CreateSessionResponse,
	Lease,
	Manifest,
	SandboxTier,
	SandboxTierRunner,
	SessionState,
	ToolCallSummary,
} from "../../../spike/contracts/index.ts";
import type { Audit } from "./audit.ts";
import { holdLiveness, LeaseLost, type PostgresLeases } from "./lease.ts";
import { openPostgresStorage, piSchemaFor } from "./pi-postgres.ts";
import type { ContainerRunner } from "./sandbox/container.ts";
import { isSpecPrompt, type StepsScenario, scriptedResponse, stepsResponse } from "./scenario-model.ts";
import { createKantelTools, type ExecRecord, runCommand, type ToolDeps } from "./tools.ts";
import { type MinioWorkspace, sha256Hex } from "./workspace.ts";

export interface HostOptions {
	hostId: string;
	hostUrl: string;
	databaseUrl: string;
	leaseTtlMs: number;
	/** How often to look for sessions whose owner died. */
	takeoverPollMs: number;
	/** Close an idle session (no work, no wake time) after this long, releasing its lease and connection. */
	idleCloseMs: number;
}

interface OpenSession {
	sessionId: string;
	workspaceId: string;
	lease: Lease;
	harness: Harness;
	storage: Storage;
	renew: ReturnType<typeof setInterval>;
	faux: ReturnType<typeof fauxProvider>;
	openedAt: number;
	takeover: boolean;
	/** A scripted scenario in the shared format, if the session was set up with one. */
	scenario?: StepsScenario;
	/** Crash this host after this many more commands have committed (the scenario's kill switch). */
	killAfterExec?: number;
	respond: (context: TranscriptContext) => AssistantMessage;
	tools: ToolDeps;
	/** The lease's immutable fence, which every metadata write checks too. */
	fence: { sessionId: string; owner: string; fence: number };
	/** Resumes the harness at its next sleep's due time (Pi arms no timer of its own when `onWake` is set). */
	wakeTimer?: ReturnType<typeof setTimeout>;
	/** Closes the session once it has been idle for `idleCloseMs`. */
	idleTimer?: ReturnType<typeof setTimeout>;
	/** When a request was last routed to this session here (epoch ms). */
	lastUsed?: number;
}

const FAUX_STEPS = 200;

// The parts of Pi Durable's root view this host reads. Pi types the view as
// unknown; these are the fields the spike relies on, all optional.
interface ViewPart {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}
interface ViewMessage {
	role?: string;
	content?: ViewPart[];
	stopReason?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	details?: { tier?: SandboxTier };
}
interface ViewEntry {
	id?: unknown;
	model?: ViewMessage[];
}
interface LiveTool {
	callId?: string;
	id?: string;
	name?: string;
	toolName?: string;
	arguments?: unknown;
	args?: unknown;
	output?: unknown;
}
interface RootView {
	entries?: ViewEntry[];
	docs?: { "pi.live"?: { tools?: Record<string, LiveTool> } };
}
const textOf = (parts: ViewPart[] | undefined) =>
	(parts ?? []).map((part) => (part.type === undefined || part.type === "text" ? (part.text ?? "") : "")).join("");

export class SessionHost {
	readonly #open = new Map<string, OpenSession>();
	readonly #opening = new Map<string, Promise<OpenSession | undefined>>();
	readonly #closing = new Map<string, Promise<void>>();
	#takeoverTimer: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;
	#liveness: pg.Client | undefined;
	/** This incarnation's lease owner name: host ID plus a boot ID, so a restarted host is a new owner. */
	readonly owner: string;
	/** Takeovers this host performed: session, time the lease was free, time resumed. */
	readonly takeovers: {
		sessionId: string;
		previousOwner?: string;
		fence: number;
		/** When the previous lease would have expired (its last renewal plus the TTL). */
		previousExpiresAt?: number;
		acquiredAt: number;
		resumedAt: number;
	}[] = [];

	constructor(
		readonly options: HostOptions,
		private readonly pool: pg.Pool,
		private readonly leases: PostgresLeases,
		private readonly workspace: MinioWorkspace,
		private readonly isolate: SandboxTierRunner,
		private readonly container: ContainerRunner,
		private readonly audit: Audit,
	) {
		this.owner = `${options.hostId}/${crypto.randomUUID().slice(0, 8)}`;
		container.owner = this.owner;
	}

	/** Hold this incarnation's liveness lock. Losing that connection means losing every lease. */
	async start(): Promise<void> {
		const client = new pg.Client({ connectionString: this.options.databaseUrl });
		await client.connect();
		await holdLiveness(client, this.owner);
		const lost = (why: string) => {
			if (this.#stopped) return;
			console.error(`[${this.owner}] liveness connection ${why}; dropping every session`);
			for (const session of [...this.#open.values()]) void this.#close(session, "liveness lost");
			process.exit(1);
		};
		client.on("error", () => lost("failed"));
		client.on("end", () => lost("ended"));
		this.#liveness = client;
		this.startTakeoverLoop();
	}

	// ---------------------------------------------------------------- lifecycle

	async create(
		sessionId: string = crypto.randomUUID(),
		workspaceId = `ws-${sessionId}`,
	): Promise<CreateSessionResponse> {
		const existing = (await this.pool.query(`SELECT workspace_id FROM harbour.sessions WHERE id = $1`, [sessionId]))
			.rows[0];
		if (existing !== undefined) workspaceId = existing.workspace_id;
		else await this.workspace.create(workspaceId);
		await this.pool.query(
			`INSERT INTO harbour.sessions (id, workspace_id, pi_schema) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
			[sessionId, workspaceId, piSchemaFor(sessionId)],
		);
		const open = await this.#ensureOpen(sessionId);
		if (open === undefined) throw new Error(`session ${sessionId} is owned by another host`);
		return { sessionId, workspaceId, owner: this.options.hostId };
	}

	/** Open the session here if its lease is free. Undefined if another live host owns it. */
	#ensureOpen(sessionId: string): Promise<OpenSession | undefined> {
		const open = this.#open.get(sessionId);
		if (open !== undefined) {
			open.lastUsed = Date.now();
			return Promise.resolve(open);
		}
		// Closing here (idle): reopen once its storage is closed and its lease released.
		const closing = this.#closing.get(sessionId);
		if (closing !== undefined) return closing.then(() => this.#ensureOpen(sessionId));
		const pending = this.#opening.get(sessionId);
		if (pending !== undefined) return pending;
		const opening = this.#doOpen(sessionId).finally(() => this.#opening.delete(sessionId));
		this.#opening.set(sessionId, opening);
		return opening;
	}

	async #doOpen(sessionId: string): Promise<OpenSession | undefined> {
		const row = (
			await this.pool.query(`SELECT workspace_id, pi_schema, scenario FROM harbour.sessions WHERE id = $1`, [sessionId])
		).rows[0];
		if (row === undefined) throw new NotFound(`unknown session ${sessionId}`);
		const before = await this.pool.query(
			`SELECT owner, fence, expires_at FROM harbour.session_leases WHERE session_id = $1`,
			[sessionId],
		);
		const lease = await this.leases.acquire(sessionId, this.owner, this.options.hostUrl, this.options.leaseTtlMs);
		if (lease === undefined) return undefined;
		const previousOwner = before.rows[0]?.owner as string | undefined;
		// Reopening a session this incarnation closed when idle is not a takeover.
		const takeover = lease.fence > 1 && previousOwner !== this.owner;
		const previousExpiresAt = before.rows[0] ? new Date(before.rows[0].expires_at).getTime() : undefined;
		const acquiredAt = Date.now();
		await this.audit.record(sessionId, "lease", takeover ? "takeover" : "acquire", {
			fence: lease.fence,
			previousOwner: takeover ? previousOwner : undefined,
		});
		if (takeover)
			await this.audit.record(sessionId, "session", "reopen", { owner: this.owner, fence: lease.fence, previousOwner });
		// Containers a dead owner left behind for this session: their writes were
		// never committed (a command commits only when it finishes), so remove them.
		const reaped = await this.container.reap(sessionId);
		if (reaped > 0) await this.audit.record(sessionId, "sandbox", "reap", { containers: reaped });

		const fence = { sessionId, owner: lease.owner, fence: lease.fence };
		const storage = await openPostgresStorage({
			connectionString: this.options.databaseUrl,
			schema: row.pi_schema,
			fence: (client) => this.leases.check(fence, client),
		});
		const session = { scenario: row.scenario ?? undefined, fence } as OpenSession;
		session.respond = (ctx) =>
			session.scenario !== undefined && !isSpecPrompt(ctx)
				? stepsResponse(session.scenario, ctx)
				: scriptedResponse(ctx);
		const faux = fauxProvider();
		faux.setResponses(Array(FAUX_STEPS).fill(session.respond));
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		session.tools = {
			workspace: this.workspace,
			isolate: this.isolate,
			container: this.container,
			audit: this.audit,
			session: () => ({ sessionId, workspaceId: row.workspace_id, fence: () => fence }),
			afterExec: (record) => this.#afterExec(session, record),
		};
		registry.install(createKantelTools(session.tools));
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				onWake: (wake) => void this.#onWake(session, wake),
				onReport: (error, info) => {
					console.error(`[${this.options.hostId}] ${sessionId} ${info.type}:`, error);
				},
			},
			context,
		);
		Object.assign(session, {
			sessionId,
			workspaceId: row.workspace_id,
			lease,
			harness,
			storage,
			faux,
			openedAt: Date.now(),
			takeover,
			renew: setInterval(() => void this.#renew(session), Math.max(200, Math.floor(this.options.leaseTtlMs / 4))),
		});
		this.#open.set(sessionId, session);
		harness.closed.then(() => this.#forget(session, "harness closed"));
		await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		harness.resume();
		if (takeover) {
			this.takeovers.push({
				sessionId,
				previousOwner,
				fence: lease.fence,
				previousExpiresAt,
				acquiredAt,
				resumedAt: Date.now(),
			});
			console.log(`[${this.options.hostId}] took over ${sessionId} at fence ${lease.fence} from ${previousOwner}`);
		}
		return session;
	}

	async #renew(session: OpenSession): Promise<void> {
		if (this.#open.get(session.sessionId) !== session) return;
		try {
			const renewed = await this.leases.renew(session.lease, this.options.leaseTtlMs);
			if (renewed === undefined) throw new LeaseLost(session.lease);
			session.lease = renewed;
			if (session.faux.getPendingResponseCount() < FAUX_STEPS / 2) {
				session.faux.appendResponses(Array(FAUX_STEPS).fill(session.respond));
			}
		} catch (error) {
			console.error(`[${this.options.hostId}] lost ${session.sessionId}:`, error);
			await this.#close(session, "lease lost");
		}
	}

	/**
	 * The scenario's crash switch: die like a killed process right after a
	 * command has committed and before its tool result is recorded. Exit, not
	 * a signal: as PID 1 in its container this process would ignore SIGKILL.
	 * No lease is released and no session is closed; Postgres drops the
	 * liveness lock with the connection, and Docker restarts the container.
	 */
	async #afterExec(session: OpenSession, record: ExecRecord): Promise<void> {
		if (session.killAfterExec === undefined) return;
		session.killAfterExec -= 1;
		if (session.killAfterExec > 0) return;
		await this.audit.record(session.sessionId, "session", "kill", {
			owner: this.owner,
			command: record.command.slice(0, 200),
		});
		console.error(`[${this.owner}] scenario kill switch: exiting after "${record.command.slice(0, 60)}" committed`);
		process.exit(137);
	}

	/**
	 * Pi calls this instead of arming its own timer: persist the wake for crash
	 * recovery, resume the harness locally when a sleep is due, and close the
	 * session once it has nothing left to do.
	 */
	async #onWake(session: OpenSession, wake: Wake): Promise<void> {
		clearTimeout(session.wakeTimer);
		clearTimeout(session.idleTimer);
		session.wakeTimer = session.idleTimer = undefined;
		const live = () => this.#open.get(session.sessionId) === session;
		if (wake.at !== undefined) {
			session.wakeTimer = setTimeout(
				() => {
					if (live()) session.harness.resume();
				},
				Math.max(0, wake.at - Date.now()),
			);
		} else if (!wake.active && this.options.idleCloseMs > 0) {
			// Closes only after idleCloseMs with no request routed to the session
			// and no work started; a request in between pushes it back.
			const idle = () => {
				if (!live()) return;
				try {
					if (session.harness.wake().active) return;
				} catch {
					return; // the harness is already failing or closing; harness.closed forgets it
				}
				const wait = (session.lastUsed ?? 0) + this.options.idleCloseMs - Date.now();
				if (wait > 0) {
					session.idleTimer = setTimeout(idle, wait);
					session.idleTimer.unref?.();
				} else void this.#close(session, "idle", true);
			};
			session.idleTimer = setTimeout(idle, this.options.idleCloseMs);
			session.idleTimer.unref?.();
		}
		await this.#fenced(
			session,
			`UPDATE harbour.sessions SET status = $2, wake_at = $3, updated_at = now() WHERE id = $1`,
			[session.sessionId, wake.active ? "active" : "idle", wake.at === undefined ? null : new Date(wake.at)],
		).catch((error) => console.error(`[${this.owner}] wake update for ${session.sessionId} failed:`, error));
	}

	/** A session metadata write that commits only while this owner still holds the lease. */
	async #fenced(session: OpenSession, sql: string, params: unknown[]): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await this.leases.check(session.fence, client);
			await client.query(sql, params);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	#forget(session: OpenSession, why: string) {
		clearInterval(session.renew);
		clearTimeout(session.wakeTimer);
		clearTimeout(session.idleTimer);
		if (this.#open.get(session.sessionId) === session) {
			this.#open.delete(session.sessionId);
			console.log(`[${this.options.hostId}] closed ${session.sessionId}: ${why}`);
		}
	}

	async #close(session: OpenSession, why: string, release = false) {
		this.#forget(session, why);
		// Closes of one session queue up, so the barrier a reopen waits on always
		// covers every earlier close's lease release too.
		const previous = this.#closing.get(session.sessionId) ?? Promise.resolve();
		const done = (async () => {
			await previous;
			await session.harness.close(context).catch(() => undefined);
			if (release) await this.leases.release(session.lease).catch(() => undefined);
		})();
		this.#closing.set(session.sessionId, done);
		try {
			await done;
		} finally {
			if (this.#closing.get(session.sessionId) === done) this.#closing.delete(session.sessionId);
		}
	}

	/** Take over active sessions whose owner stopped renewing. */
	startTakeoverLoop() {
		let ticks = 0;
		const tick = async () => {
			if (this.#stopped) return;
			let delay = this.options.leaseTtlMs;
			try {
				// About every 10 s: sandbox containers whose host died.
				if (ticks++ % 20 === 0) {
					const reaped = await this.container.reapDeadOwners((owner) => this.leases.ownerAlive(owner));
					if (reaped > 0) await this.audit.record(null, "sandbox", "reap-dead-owner", { containers: reaped });
				}
				for (const sessionId of await this.leases.orphans()) {
					if (!this.#open.has(sessionId)) await this.#ensureOpen(sessionId).catch((e) => console.error(e));
				}
				const next = await this.leases.nextExpiryMs();
				// Poll often enough to notice a dead owner's dropped liveness lock,
				// and wake just after the next lease could expire.
				delay = Math.min(delay, this.options.takeoverPollMs);
				if (next !== undefined) delay = Math.min(delay, next + 25);
			} catch (error) {
				console.error("takeover scan failed", error);
				delay = 1000;
			}
			this.#takeoverTimer = setTimeout(tick, delay);
		};
		void tick();
	}

	async stop() {
		this.#stopped = true;
		clearTimeout(this.#takeoverTimer);
		for (const session of [...this.#open.values()]) await this.#close(session, "shutdown", true);
		await this.#liveness?.end().catch(() => undefined);
	}

	// ---------------------------------------------------------------- API

	/** The owner's URL if another live host owns the session, or the open session here. */
	async route(sessionId: string): Promise<{ forward: string } | { session: OpenSession }> {
		const session = await this.#ensureOpen(sessionId);
		if (session !== undefined) return { session };
		const lease = await this.leases.current(sessionId);
		if (lease !== undefined && lease.owner !== this.owner) return { forward: lease.ownerUrl };
		// The lease expired between the two reads: try once more.
		const retry = await this.#ensureOpen(sessionId);
		if (retry !== undefined) return { session: retry };
		throw new Error(`session ${sessionId}: no owner`);
	}

	async prompt(session: OpenSession, text: string, requestId: string) {
		await this.#fenced(session, `UPDATE harbour.sessions SET status = 'active', updated_at = now() WHERE id = $1`, [
			session.sessionId,
		]);
		const root = await session.harness.root(context);
		const submission = await root.submit({ type: "input", content: text, requestId }, context);
		return { submissionId: submission.id };
	}

	async state(session: OpenSession): Promise<SessionState> {
		const root = await session.harness.root(context);
		const view = await root.viewState(context);
		const value = view.value as unknown as RootView;
		view.dispose?.();
		const toolResults: ToolCallSummary[] = [];
		const calls = new Map<string, { name: string; args: unknown }>();
		let answer: string | undefined;
		for (const entry of value.entries ?? []) {
			for (const message of entry.model ?? []) {
				if (message.role === "assistant") {
					const texts: string[] = [];
					for (const part of message.content ?? []) {
						if (part.type === "toolCall") calls.set(part.id ?? "", { name: part.name ?? "", args: part.arguments });
						if (part.type === "text") texts.push(part.text ?? "");
					}
					if (message.stopReason !== "toolUse" && texts.length > 0) answer = texts.join("");
				} else if (message.role === "toolResult") {
					const call = calls.get(message.toolCallId ?? "");
					toolResults.push({
						id: message.toolCallId ?? "",
						name: message.toolName ?? "",
						args: call?.args,
						isError: message.isError,
						output: textOf(message.content),
						tier: message.details?.tier,
					});
				} else if (message.role === "user") {
					answer = undefined;
				}
			}
		}
		const live = value.docs?.["pi.live"] ?? {};
		const running: ToolCallSummary[] = Object.values(live.tools ?? {}).map((tool) => ({
			id: tool.callId ?? tool.id ?? "",
			name: tool.name ?? tool.toolName ?? "",
			args: tool.arguments ?? tool.args,
			output: typeof tool.output === "string" ? tool.output.slice(-500) : undefined,
		}));
		const status = (await this.pool.query(`SELECT status FROM harbour.sessions WHERE id = $1`, [session.sessionId]))
			.rows[0]?.status;
		return {
			sessionId: session.sessionId,
			workspaceId: session.workspaceId,
			status: status ?? "idle",
			owner: this.options.hostId,
			fence: session.lease.fence,
			workspace: await this.workspace.head(session.workspaceId),
			running,
			answer,
			toolResults,
		};
	}

	/** For the scenario's crash path: abort nothing, just report what is running. */
	async live(session: OpenSession): Promise<unknown> {
		const root = await session.harness.root(context);
		const view = await root.viewState(context);
		const value = (view.value as unknown as RootView).docs?.["pi.live"];
		view.dispose?.();
		return value ?? null;
	}

	ownedSessions(): string[] {
		return [...this.#open.keys()];
	}

	// ------------------------------------------- the shared scenario surface
	// The HTTP surface the Cloudflare spike defined in spikes/scenario/run.ts, so it
	// drives this target unchanged.

	/** Create the session and its workspace if needed, seeded from the scenario, and attach the scenario. */
	async setup(sessionId: string, scenario: StepsScenario | undefined, workspaceId?: string) {
		const t0 = performance.now();
		const created = await this.create(sessionId, workspaceId);
		const createMs = performance.now() - t0;
		const routed = await this.route(sessionId);
		if (!("session" in routed)) throw new Error(`session ${sessionId} is owned by another host`);
		const session = routed.session;
		if (scenario !== undefined) {
			await this.#fenced(session, `UPDATE harbour.sessions SET scenario = $2 WHERE id = $1`, [
				sessionId,
				JSON.stringify(scenario),
			]);
			session.scenario = scenario;
		}
		let head = await this.workspace.head(created.workspaceId);
		const seed = Object.entries(scenario?.seed ?? {});
		if (seed.length > 0 && Object.keys(await this.workspace.manifest(created.workspaceId, head.version)).length === 0) {
			const manifest: Manifest = {};
			for (const [rawPath, content] of seed) {
				const path = rawPath.replace(/^\/?workspace\/?/, "");
				const parts = path.split("/");
				for (let i = 1; i < parts.length; i++) manifest[parts.slice(0, i).join("/")] = { kind: "dir" };
				const bytes = new TextEncoder().encode(content);
				const sha = await this.workspace.putBlob(created.workspaceId, bytes);
				if (sha !== sha256Hex(bytes)) throw new Error("blob hash mismatch");
				manifest[path] = { kind: "file", sha, size: bytes.length, mode: 0o644 };
			}
			head = await this.workspace.commit(
				created.workspaceId,
				{ base: head.version, manifest, tier: "host", changed: Object.keys(manifest) },
				{ sessionId, owner: session.lease.owner, fence: session.lease.fence },
			);
		}
		const root = await session.harness.root(context);
		return {
			sessionId,
			workspaceId: created.workspaceId,
			conversationId: String(root.id),
			head: head.version,
			owner: this.owner,
			timings: { createMs: Math.round(createMs), setupMs: Math.round(performance.now() - t0) },
		};
	}

	armKill(session: OpenSession, afterExec: number) {
		session.killAfterExec = afterExec;
		return { armed: afterExec, owner: this.owner };
	}

	/** One sandbox command outside the model loop (measurements). */
	async exec(session: OpenSession, command: string, tier?: SandboxTier) {
		const run = await runCommand(session.tools, session.tools.session(), command, { tier });
		return { ...run.record, stdout: run.stdout, stderr: run.stderr };
	}

	async #entries(session: OpenSession): Promise<ViewEntry[]> {
		const root = await session.harness.root(context);
		const view = await root.viewState(context);
		const entries = (view.value as unknown as RootView).entries ?? [];
		view.dispose?.();
		return entries;
	}

	async #execs(sessionId: string): Promise<ExecRecord[]> {
		return (
			await this.pool.query(`SELECT body FROM harbour.execs WHERE session_id = $1 ORDER BY id`, [sessionId])
		).rows.map((row) => row.body);
	}

	async #events(sessionId: string) {
		const rows = await this.pool.query(
			`SELECT at, kind, detail FROM harbour.audit_events
			 WHERE session_id = $1 AND actor LIKE 'session:%' AND kind IN ('kill', 'reopen') ORDER BY id`,
			[sessionId],
		);
		return rows.rows.map((row) => ({ at: new Date(row.at).getTime(), type: row.kind, ...row.detail }));
	}

	/** The vault's decisions for this session, in the shared shape. Header names only, never values. */
	async vaultUses(sessionId: string) {
		const rows = await this.pool.query(
			`SELECT at, actor, kind, detail FROM harbour.audit_events
			 WHERE session_id = $1 AND actor LIKE 'vault:%' ORDER BY id`,
			[sessionId],
		);
		const decisions: Record<string, string> = {
			"vault.allow": "allowed",
			"vault.deny": "denied",
			"vault.error": "error",
			"vault.tunnel": "tunnelled",
		};
		return rows.rows.map((row) => {
			const d = row.detail as Record<string, unknown>;
			return {
				at: new Date(row.at).getTime(),
				tier: String(row.actor).split(":")[1],
				decision: decisions[row.kind] ?? row.kind,
				method: d.method,
				host: d.host,
				path: d.path,
				...(d.status === undefined ? {} : { status: d.status }),
				...(d.route === undefined ? {} : { route: d.route }),
				...(d.reason === undefined ? {} : { reason: d.reason }),
				...(typeof d.injected === "string" ? { injected: { header: d.injected } } : {}),
				...(typeof d.redactions === "number" ? { redactions: d.redactions } : {}),
			};
		});
	}

	async scenarioState(session: OpenSession, submissionId?: string) {
		// The submission's status first, then the entries. A run that ends in between commits its answer entry and its
		// `done` status together, so entries read before the status could miss an answer the status already points to:
		// a settled submission with no answer and its last tool results missing.
		const handle =
			submissionId === undefined
				? undefined
				: await session.harness.submission(Number(submissionId) as SubmissionId, context);
		const record = (await handle?.status(context)) as
			| { status: string; reason?: unknown; answer?: unknown }
			| undefined;
		const entries = await this.#entries(session);
		const timed: { at: number; toolCallId: string; toolName: string; isError: boolean; text: string }[] = [];
		for (const entry of entries) {
			for (const message of entry.model ?? []) {
				if (message.role !== "toolResult") continue;
				timed.push({
					at: message.timestamp ?? 0,
					toolCallId: message.toolCallId ?? "",
					toolName: message.toolName ?? "",
					isError: message.isError === true,
					text: (message.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""),
				});
			}
		}
		const toolResults = timed.sort((a, b) => a.at - b.at).map(({ at: _, ...result }) => result);
		let submission: { id: string; status: string; reason?: string } | undefined;
		let answer: string | undefined;
		if (submissionId !== undefined && record !== undefined) {
			submission = {
				id: submissionId,
				status: record.status,
				...(record.reason ? { reason: String(record.reason) } : {}),
			};
			if (record.status === "done") {
				answer = entries
					.find((entry) => entry.id === record.answer)
					?.model?.flatMap((m) => (m.role === "assistant" ? (m.content ?? []) : []))
					.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
					.join("");
			}
		}
		const head = await this.workspace.head(session.workspaceId);
		return {
			sessionId: session.sessionId,
			...(submission === undefined ? {} : { submission }),
			toolResults,
			...(answer === undefined ? {} : { answer }),
			workspace: { id: session.workspaceId, head: head.version },
			execs: await this.#execs(session.sessionId),
			events: await this.#events(session.sessionId),
			process: {
				owner: this.owner,
				fence: session.lease.fence,
				openedAt: session.openedAt,
				takeover: session.takeover,
			},
		};
	}

	async fixture(session: OpenSession) {
		return {
			format: "harbour-m0-session-fixture/1",
			recordedAt: new Date().toISOString(),
			target: "selfhosted",
			scenario: session.scenario?.name,
			entries: await this.#entries(session),
			execs: await this.#execs(session.sessionId),
			events: await this.#events(session.sessionId),
			vault: await this.vaultUses(session.sessionId),
		};
	}

	/** One file at the current head, or undefined. */
	async file(session: OpenSession, rawPath: string): Promise<{ bytes: Uint8Array; version: string } | undefined> {
		const path = rawPath.replace(/^\/?workspace\/?/, "").replace(/^\/+/, "");
		const head = await this.workspace.head(session.workspaceId);
		const entry = (await this.workspace.manifest(session.workspaceId, head.version))[path];
		if (entry?.kind !== "file") return undefined;
		return { bytes: await this.workspace.readBlob(session.workspaceId, entry.sha), version: head.version };
	}
}

export class NotFound extends Error {
	override name = "NotFound";
}
