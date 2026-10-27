// The session host: runs Pi Durable sessions while it holds their leases.
//
// Any host answers any request. A request for a session another live host
// owns is forwarded to it; a session whose owner died (lease expired) is
// taken over by whichever host touches it first, or by the takeover loop,
// which wakes exactly when the next active lease expires.

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Storage, type Wake } from "@earendil-works/pi-durable";
import pg from "pg";
import type {
	CreateSessionResponse,
	Lease,
	SandboxTierRunner,
	SessionState,
	ToolCallSummary,
} from "../../../spike/contracts/index.ts";
import type { Audit } from "./audit.ts";
import { holdLiveness, LeaseLost, type PostgresLeases } from "./lease.ts";
import { openPostgresStorage, piSchemaFor } from "./pi-postgres.ts";
import { scriptedResponse } from "./scenario-model.ts";
import type { ContainerRunner } from "./sandbox/container.ts";
import { createHarbourTools } from "./tools.ts";
import type { MinioWorkspace } from "./workspace.ts";

export interface HostOptions {
	hostId: string;
	hostUrl: string;
	databaseUrl: string;
	leaseTtlMs: number;
	/** How often to look for sessions whose owner died. */
	takeoverPollMs: number;
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
}

const FAUX_STEPS = 200;

export class SessionHost {
	readonly #open = new Map<string, OpenSession>();
	readonly #opening = new Map<string, Promise<OpenSession | undefined>>();
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

	async create(sessionId: string = crypto.randomUUID()): Promise<CreateSessionResponse> {
		const workspaceId = `ws-${sessionId}`;
		await this.workspace.create(workspaceId);
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
		if (open !== undefined) return Promise.resolve(open);
		const pending = this.#opening.get(sessionId);
		if (pending !== undefined) return pending;
		const opening = this.#doOpen(sessionId).finally(() => this.#opening.delete(sessionId));
		this.#opening.set(sessionId, opening);
		return opening;
	}

	async #doOpen(sessionId: string): Promise<OpenSession | undefined> {
		const row = (await this.pool.query(`SELECT workspace_id, pi_schema FROM harbour.sessions WHERE id = $1`, [sessionId]))
			.rows[0];
		if (row === undefined) throw new NotFound(`unknown session ${sessionId}`);
		const before = await this.pool.query(`SELECT owner, fence, expires_at FROM harbour.session_leases WHERE session_id = $1`, [
			sessionId,
		]);
		const lease = await this.leases.acquire(sessionId, this.owner, this.options.hostUrl, this.options.leaseTtlMs);
		if (lease === undefined) return undefined;
		const takeover = lease.fence > 1;
		const previousOwner = before.rows[0]?.owner as string | undefined;
		const previousExpiresAt = before.rows[0] ? new Date(before.rows[0].expires_at).getTime() : undefined;
		const acquiredAt = Date.now();
		await this.audit.record(sessionId, "lease", takeover ? "takeover" : "acquire", {
			fence: lease.fence,
			previousOwner: takeover ? previousOwner : undefined,
		});
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
		const faux = fauxProvider();
		faux.setResponses(Array(FAUX_STEPS).fill(scriptedResponse));
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const session = {} as OpenSession;
		registry.install(
			createHarbourTools({
				workspace: this.workspace,
				isolate: this.isolate,
				container: this.container,
				audit: this.audit,
				session: () => ({ sessionId, workspaceId: row.workspace_id, fence: () => fence }),
			}),
		);
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				onWake: (wake) => void this.#onWake(sessionId, wake),
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
			this.takeovers.push({ sessionId, previousOwner, fence: lease.fence, previousExpiresAt, acquiredAt, resumedAt: Date.now() });
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
				session.faux.appendResponses(Array(FAUX_STEPS).fill(scriptedResponse));
			}
		} catch (error) {
			console.error(`[${this.options.hostId}] lost ${session.sessionId}:`, error);
			await this.#close(session, "lease lost");
		}
	}

	async #onWake(sessionId: string, wake: Wake): Promise<void> {
		await this.pool
			.query(`UPDATE harbour.sessions SET status = $2, wake_at = $3, updated_at = now() WHERE id = $1`, [
				sessionId,
				wake.active ? "active" : "idle",
				wake.at === undefined ? null : new Date(wake.at),
			])
			.catch((error) => console.error("wake update failed", error));
	}

	#forget(session: OpenSession, why: string) {
		clearInterval(session.renew);
		if (this.#open.get(session.sessionId) === session) {
			this.#open.delete(session.sessionId);
			console.log(`[${this.options.hostId}] closed ${session.sessionId}: ${why}`);
		}
	}

	async #close(session: OpenSession, why: string, release = false) {
		this.#forget(session, why);
		await session.harness.close(context).catch(() => undefined);
		if (release) await this.leases.release(session.lease).catch(() => undefined);
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
		await this.pool.query(`UPDATE harbour.sessions SET status = 'active', updated_at = now() WHERE id = $1`, [
			session.sessionId,
		]);
		const root = await session.harness.root(context);
		const submission = await root.submit({ type: "input", content: text, requestId }, context);
		return { submissionId: submission.id };
	}

	async state(session: OpenSession): Promise<SessionState> {
		const root = await session.harness.root(context);
		const view = await root.viewState(context);
		const value = view.value as any;
		view.dispose?.();
		const toolResults: ToolCallSummary[] = [];
		const calls = new Map<string, { name: string; args: unknown }>();
		let answer: string | undefined;
		for (const entry of value.entries as any[]) {
			for (const message of entry.model ?? []) {
				if (message.role === "assistant") {
					const texts: string[] = [];
					for (const part of message.content ?? []) {
						if (part.type === "toolCall") calls.set(part.id, { name: part.name, args: part.arguments });
						if (part.type === "text") texts.push(part.text);
					}
					if (message.stopReason !== "toolUse" && texts.length > 0) answer = texts.join("");
				} else if (message.role === "toolResult") {
					const call = calls.get(message.toolCallId);
					toolResults.push({
						id: message.toolCallId,
						name: message.toolName,
						args: call?.args,
						isError: message.isError,
						output: (message.content ?? []).map((p: any) => p.text ?? "").join(""),
						tier: message.details?.tier,
					});
				} else if (message.role === "user") {
					answer = undefined;
				}
			}
		}
		const live = value.docs?.["pi.live"] ?? {};
		const running: ToolCallSummary[] = Object.values((live.tools ?? {}) as Record<string, any>).map((tool: any) => ({
			id: tool.callId ?? tool.id ?? "",
			name: tool.name ?? tool.toolName ?? "",
			args: tool.arguments ?? tool.args,
			output: typeof tool.output === "string" ? tool.output.slice(-500) : undefined,
		}));
		const status = (await this.pool.query(`SELECT status FROM harbour.sessions WHERE id = $1`, [session.sessionId])).rows[0]
			?.status;
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
		const value = (view.value as any).docs?.["pi.live"];
		view.dispose?.();
		return value ?? null;
	}

	ownedSessions(): string[] {
		return [...this.#open.keys()];
	}
}

export class NotFound extends Error {
	override name = "NotFound";
}
