import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	configure,
	createRegistry,
	defineExtension,
	type EntryRecord,
	Harness,
	type HarnessOptions,
	type SubmissionId,
	section,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	KantelError,
	type SandboxLease,
	type SandboxTier,
	type SystemContext,
} from "@kantel/contracts";
import { type ExecRecord, HarbourEnv } from "./env.ts";
import { SPIKE_OWNER, sessionContext } from "./identity.ts";
import { r2Store } from "./r2.ts";
import { CloudflareSandboxes, type LeaseRow, type LeaseStore } from "./sandbox.ts";
import { ContainerDOBackend, DynamicWorkerIsolate, stopContainer } from "./tiers.ts";
import { ObjectStoreWorkspaces } from "./workspace.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MODEL = { provider: "harbour-script", modelId: "scripted" } as const;

/** The scripted task: seed files, tool calls in order, and the final answer. See spikes/scenario. */
export interface Scenario {
	readonly name: string;
	readonly steps: readonly { readonly tool: string; readonly args: Readonly<Record<string, unknown>> }[];
	readonly finalAnswer: string;
	readonly seed: Readonly<Record<string, string>>;
}

type Meta = {
	sessionId: string;
	workspaceId: string;
	scenario: Scenario;
	conversationId?: ConversationId;
	/** Crash test: abort the object right after the Nth exec (1-based) has run, before its result is recorded. */
	killAfterExec?: number;
	/** Isolate generation: a new value loads a fresh Dynamic Worker. */
	isolateGeneration?: string;
	/**
	 * Prompted runs so far, and how many of them have had their leases ended. While `settledRuns < promptedRuns`, the
	 * next time the harness settles ends the session's leases. Counters, not a flag, so a prompt that arrives while an
	 * earlier run's leases are being released is not marked settled with it.
	 */
	promptedRuns?: number;
	settledRuns?: number;
};

type ToolResult = { toolCallId: string; toolName: string; isError: boolean; text: string };

/**
 * One Harbour session. Opens Pi Durable on this object's SQLite storage, with a scripted model and Pi's coding tools
 * over HarbourEnv, which runs on the `Workspaces` and `Sandboxes` contracts. Runs are driven from the alarm handler so the
 * object stays alive while it works and a crash is retried by the platform. Leases and the contract audit trail are
 * kept in the same SQLite database, so a restarted object still knows them.
 */
export class SessionDO extends DurableObject<Env> {
	#harness: Harness | undefined;
	#opening: Promise<Harness> | undefined;
	readonly #openedAt = Date.now();
	#openMs: number | undefined;
	/** A setup is in progress (it awaits R2 before it records the session). */
	#settingUp = false;
	readonly #leases: LeaseStore;
	readonly #audit: AuditSink;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS harbour_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		sql.exec(
			"CREATE TABLE IF NOT EXISTS harbour_execs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)",
		);
		sql.exec(
			"CREATE TABLE IF NOT EXISTS harbour_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)",
		);
		sql.exec("CREATE TABLE IF NOT EXISTS harbour_leases (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
		sql.exec("CREATE TABLE IF NOT EXISTS harbour_escalated (key TEXT PRIMARY KEY)");
		// Which container Durable Object holds each container lease, so commit and release reach the right one.
		sql.exec("CREATE TABLE IF NOT EXISTS harbour_lease_container (lease_id TEXT PRIMARY KEY, name TEXT NOT NULL)");
		sql.exec(
			"CREATE TABLE IF NOT EXISTS harbour_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)",
		);
		this.#leases = sqliteLeaseStore(sql);
		this.#audit = {
			append: async (_ctx: SystemContext, events: readonly AuditEventInput[]) => {
				for (const event of events) {
					sql.exec("INSERT OR IGNORE INTO harbour_audit (id, body) VALUES (?, ?)", event.id, JSON.stringify(event));
				}
			},
		};
		if (this.#meta() !== undefined) {
			// A restarted object resumes interrupted work without waiting for a request.
			void ctx.blockConcurrencyWhile(async () => {
				this.#event({ type: "reopen" });
				await this.#open();
			});
		}
	}

	// ---- state ---------------------------------------------------------------------------------------------------------

	#meta(): Meta | undefined {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM harbour_meta WHERE key = 'meta'")
			.toArray()[0];
		if (row === undefined) return undefined;
		const { settleOnIdle, ...meta } = JSON.parse(row.value) as Meta & { settleOnIdle?: boolean };
		// An earlier build marked an unsettled prompted run with a flag; read it as one outstanding run.
		if (settleOnIdle === true && meta.promptedRuns === undefined) {
			return { ...meta, promptedRuns: (meta.settledRuns ?? 0) + 1 };
		}
		return meta;
	}

	#setMeta(meta: Meta): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO harbour_meta (key, value) VALUES ('meta', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			JSON.stringify(meta),
		);
	}

	#event(body: Record<string, unknown>): void {
		this.ctx.storage.sql.exec("INSERT INTO harbour_events (at, body) VALUES (?, ?)", Date.now(), JSON.stringify(body));
	}

	#requireMeta(): Meta {
		const meta = this.#meta();
		if (meta === undefined) throw new Error("session is not set up");
		return meta;
	}

	#ctx(meta: Meta): CallContext {
		return sessionContext(meta.sessionId);
	}

	#workspaces(): ObjectStoreWorkspaces {
		return new ObjectStoreWorkspaces({ store: r2Store(this.env.WORKSPACES), audit: this.#audit });
	}

	#sandboxes(meta: Meta, overrides: { containerName?: string; isolateGeneration?: string } = {}): CloudflareSandboxes {
		const generation = overrides.isolateGeneration ?? meta.isolateGeneration;
		const workspaces = this.#workspaces();
		return new CloudflareSandboxes({
			workspaces,
			isolate: new DynamicWorkerIsolate(this.env, this.ctx.exports, meta.sessionId, generation),
			container: new ContainerDOBackend(this.env, (lease) => this.#containerFor(lease, meta, overrides.containerName)),
			leases: this.#leases,
			audit: this.#audit,
		});
	}

	/**
	 * The container a lease is bound to: chosen on its first use (the session ID, or the name a measurement route asks
	 * for) and fixed after that. Asking for another name while the lease lives is refused.
	 */
	#containerFor(lease: SandboxLease, meta: Meta, wanted: string | undefined): string {
		const sql = this.ctx.storage.sql;
		const bound = sql
			.exec<{ name: string }>("SELECT name FROM harbour_lease_container WHERE lease_id = ?", lease.id)
			.toArray()[0]?.name;
		if (bound !== undefined) {
			if (wanted !== undefined && wanted !== bound) {
				throw new KantelError("conflict", `lease ${lease.id} is bound to container ${bound}`, { leaseId: lease.id });
			}
			return bound;
		}
		const name = wanted ?? meta.sessionId;
		sql.exec("INSERT INTO harbour_lease_container (lease_id, name) VALUES (?, ?)", lease.id, name);
		return name;
	}

	// ---- harness -------------------------------------------------------------------------------------------------------

	#open(): Promise<Harness> {
		if (this.#harness !== undefined) return Promise.resolve(this.#harness);
		this.#opening ??= this.#doOpen().finally(() => {
			this.#opening = undefined;
		});
		return this.#opening;
	}

	async #doOpen(): Promise<Harness> {
		const started = performance.now();
		const meta = this.#requireMeta();
		const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
		const harness = await Harness.open(storage, this.#options(meta), BACKGROUND_CONTEXT);
		void harness.closed.then((end) => {
			if (end.reason === "failed") this.ctx.abort("harness failed");
		});
		this.#harness = harness;
		harness.resume();
		this.#openMs = round(performance.now() - started);
		return harness;
	}

	#options(meta: Meta): HarnessOptions {
		const scenario = meta.scenario;
		const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] });
		// Stateless script: the next step is the number of completed tool results since the prompt. An interrupted call
		// (a crash mid tool) does not count, so the script reissues it: the "may have partially run" path.
		const respond = (context: { messages: Message[] }) => {
			const messages = context.messages;
			let lastUser = -1;
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				if (messages[i]?.role === "user") {
					lastUser = i;
					break;
				}
			}
			const results = messages.slice(lastUser + 1).filter((m) => m.role === "toolResult");
			const completed = results.filter((m) => !isInterrupted(m)).length;
			const step = scenario.steps[completed];
			if (step === undefined) return fauxAssistantMessage(fauxText(scenario.finalAnswer));
			const retry = results.length - completed;
			return fauxAssistantMessage(
				fauxToolCall(step.tool, step.args as Record<string, never>, { id: `step-${completed}-try-${retry}` }),
				{ stopReason: "toolUse" },
			);
		};
		faux.setResponses(Array.from({ length: 500 }, () => respond));
		const models = createModels();
		models.setProvider(faux.provider);

		const env = new HarbourEnv(
			this.#ctx(meta),
			meta.sessionId,
			meta.workspaceId,
			this.#workspaces(),
			this.#sandboxes(meta),
			(record) => this.#recordExec(record),
		);
		const tools = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()];
		const extension = defineExtension({
			name: "harbour-spike",
			tools,
			sections: [section("preamble", () => "You are a Harbour spike agent working in /workspace.", { tag: false })],
		});
		const registry = createRegistry();
		registry.install(extension);
		return {
			models,
			registry,
			settings: { extensions: [extension], documentRetentionMs: 0 },
			env: () => env,
			conversationCreated: (tx, conversation) =>
				conversation.owner === undefined && conversation.parent === undefined
					? configure(tx, conversation.id, { model: MODEL, thinkingLevel: "off", tools, cwd: "/workspace" })
					: undefined,
			onWake: (wake) => {
				if (wake.active) void this.ctx.storage.setAlarm(Date.now() + 1_000);
				else if (wake.at !== undefined) void this.ctx.storage.setAlarm(wake.at);
			},
			onReport: (error, info) =>
				console.error(
					JSON.stringify({
						message: "harness report",
						info,
						error: error instanceof Error ? error.message : String(error),
					}),
				),
		};
	}

	async #recordExec(record: ExecRecord): Promise<void> {
		this.ctx.storage.sql.exec("INSERT INTO harbour_execs (at, body) VALUES (?, ?)", Date.now(), JSON.stringify(record));
		const meta = this.#requireMeta();
		if (meta.killAfterExec === undefined) return;
		const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM harbour_execs").one().n;
		if (count < meta.killAfterExec) return;
		// The command has run (an isolate command has committed its changes); its tool result has not. Crash here.
		const { killAfterExec: _, ...rest } = meta;
		this.#setMeta(rest);
		this.#event({ type: "kill", afterExec: count, command: record.command, version: record.version });
		await this.ctx.storage.setAlarm(Date.now() + 500);
		await this.ctx.storage.sync();
		this.ctx.abort("harbour spike: killed mid tool call");
	}

	override async alarm(): Promise<void> {
		const meta = this.#meta();
		if (meta === undefined) return;
		const harness = await this.#open();
		harness.resume();
		await harness.waitForIdle(BACKGROUND_CONTEXT);
		const sandboxes = this.#sandboxes(meta);
		// A prompted run has settled: commit and end the session's leases (a container's changes land in the workspace
		// here). A wake with no run (setup's, a retention timer) leaves the leases alone, so it cannot release a lease
		// that a direct /exec is using. The counters are in storage, so a run that crashed still ends its leases on resume.
		const target = this.#meta()?.promptedRuns ?? 0;
		if (target > (this.#meta()?.settledRuns ?? 0)) {
			await sandboxes.releaseSession(this.#ctx(meta), meta.sessionId, "released");
			// Re-read: a prompt may have arrived during the release. Only the runs counted before it are settled; a later
			// one keeps `settledRuns` below `promptedRuns`, and its own alarm ends its leases.
			const current = this.#requireMeta();
			this.#setMeta({ ...current, settledRuns: Math.max(current.settledRuns ?? 0, target) });
		}
		// Expire any lease past its TTL.
		await sandboxes.sweep();
	}

	// ---- HTTP surface (the one spikes/scenario/run.ts drives) ----------------------------------------------------------

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const action = url.pathname.split("/").at(-1);
		try {
			switch (`${request.method} ${action}`) {
				case "GET ping":
					return json({ ok: true });
				case "POST setup":
					return json(await this.#setup((await request.json()) as SetupBody));
				case "POST prompt":
					return json(await this.#prompt((await request.json()) as { content: string; requestId: string }));
				case "GET state":
					return json(await this.#state(url.searchParams.get("submission") ?? undefined));
				case "POST kill":
					return json(this.#armKill((await request.json()) as { afterExec: number }));
				case "POST exec":
					return json(await this.#exec((await request.json()) as ExecBody));
				case "GET fixture":
					return json(await this.#fixture());
				case "GET file":
					return this.#file(url.searchParams.get("path") ?? "");
				case "POST release": {
					const body = (await request.json().catch(() => ({}))) as { containerName?: string };
					const meta = this.#requireMeta();
					const name = body.containerName ?? meta.sessionId;
					// Only a container one of this session's leases used: never another session's.
					const bound = this.ctx.storage.sql
						.exec("SELECT 1 FROM harbour_lease_container WHERE name = ? LIMIT 1", name)
						.toArray().length;
					if (body.containerName !== undefined && bound === 0) {
						throw new KantelError("conflict", `container ${name} was not used by this session`);
					}
					// Release commits each lease through the container it is bound to; then stop the one named.
					await this.#sandboxes(meta).releaseSession(this.#ctx(meta), meta.sessionId, "released");
					await stopContainer(this.env, name, meta.sessionId);
					return json({ ok: true });
				}
				default:
					return json({ error: `no route ${request.method} ${url.pathname}` }, 404);
			}
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	}

	async #setup(body: SetupBody) {
		const started = performance.now();
		if (this.#meta() !== undefined || this.#settingUp) throw new Error("session already set up");
		// Reserved before the first await, so a second setup cannot interleave and overwrite this one's metadata (or a
		// prompt's counters) with its own.
		this.#settingUp = true;
		try {
			return await this.#initialise(body, started);
		} finally {
			this.#settingUp = false;
		}
	}

	async #initialise(body: SetupBody, started: number) {
		const sessionId = body.sessionId;
		const workspaceId = body.workspaceId ?? `ws-${sessionId}`;
		const scenario: Scenario = body.scenario ?? { name: "none", steps: [], finalAnswer: "ok", seed: {} };
		const meta: Meta = {
			sessionId,
			workspaceId,
			scenario,
			...(body.isolateGeneration ? { isolateGeneration: body.isolateGeneration } : {}),
		};
		const ctx = this.#ctx(meta);
		const workspaces = this.#workspaces();
		if (!(await workspaces.exists(ctx, workspaceId))) {
			await workspaces.createWithId(ctx, workspaceId, {
				owner: SPIKE_OWNER,
				sessionId,
				seed: { name: scenario.name, sources: [{ kind: "files", files: scenario.seed }] },
			});
		}
		const head = (await workspaces.get(ctx, workspaceId)).head;
		const workspaceMs = performance.now() - started;
		this.#setMeta(meta);
		const harness = await this.#open();
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		this.#setMeta({ ...this.#requireMeta(), conversationId: conversation.id });
		return {
			sessionId,
			workspaceId,
			conversationId: conversation.id,
			head,
			timings: {
				"session.workspace": round(workspaceMs),
				"session.harnessOpen": this.#openMs ?? 0,
				"session.setup": round(performance.now() - started),
			},
		};
	}

	async #prompt(body: { content: string; requestId: string }) {
		const meta = this.#requireMeta();
		const harness = await this.#open();
		const conversation = await harness.conversation(meta.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("conversation missing");
		const submission = await conversation.submit(
			{ type: "input", content: body.content, requestId: body.requestId, whenBusy: "followUp" },
			BACKGROUND_CONTEXT,
		);
		// Drive the run from the alarm handler, which keeps the object alive and is retried after a crash.
		const current = this.#requireMeta();
		this.#setMeta({ ...current, promptedRuns: (current.promptedRuns ?? 0) + 1 });
		await this.ctx.storage.setAlarm(Date.now());
		return { submissionId: submission.id };
	}

	#armKill(body: { afterExec: number }) {
		const meta = this.#requireMeta();
		const done = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM harbour_execs").one().n;
		this.#setMeta({ ...meta, killAfterExec: done + body.afterExec });
		return { killAfterExec: done + body.afterExec };
	}

	async #exec(body: ExecBody) {
		const meta = this.#requireMeta();
		await this.#open();
		const sandboxes = this.#sandboxes(meta, body);
		const input = {
			sessionId: meta.sessionId,
			workspaceId: meta.workspaceId,
			tool: "bash",
			request: { command: body.command, ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}) },
		};
		const result =
			body.tier === undefined
				? await sandboxes.run(this.#ctx(meta), input)
				: await sandboxes.runOn(this.#ctx(meta), { ...input, tier: body.tier });
		await this.#recordExec({
			command: body.command,
			tier: result.tier,
			exitCode: result.exitCode,
			leaseId: result.leaseId,
			base: result.baseVersion,
			version: result.workspaceVersion,
			timings: result.timings,
		});
		// Kept for the scripts that read the old field names: `version` is the contract's `workspaceVersion`.
		return { ...result, base: result.baseVersion, version: result.workspaceVersion };
	}

	async #entries(): Promise<EntryRecord[]> {
		const meta = this.#requireMeta();
		const harness = await this.#open();
		const conversation = await harness.conversation(meta.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return [];
		const entries: EntryRecord[] = [];
		let cursor: Parameters<typeof conversation.entries>[2];
		do {
			const page = await conversation.entries({}, 200, cursor, BACKGROUND_CONTEXT);
			entries.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return entries;
	}

	async #state(submissionId: string | undefined) {
		const meta = this.#requireMeta();
		const harness = await this.#open();
		const entries = await this.#entries();
		const timed: (ToolResult & { at: number })[] = [];
		let answer: string | undefined;
		for (const entry of entries) {
			for (const message of entry.model ?? []) {
				if (message.role === "toolResult") {
					timed.push({
						at: message.timestamp,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						isError: message.isError,
						text: message.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
					});
				}
			}
		}
		// Entry IDs are not in call order (a tool result is written when its task settles), so order by completion time.
		const toolResults: ToolResult[] = timed.sort((a, b) => a.at - b.at).map(({ at: _, ...result }) => result);
		let submission: { id: string; status: string; reason?: string } | undefined;
		if (submissionId !== undefined) {
			const record = await (
				await harness.submission(Number(submissionId) as unknown as SubmissionId, BACKGROUND_CONTEXT)
			)?.status(BACKGROUND_CONTEXT);
			if (record !== undefined) {
				submission = {
					id: submissionId,
					status: record.status,
					...("reason" in record && record.reason ? { reason: String(record.reason) } : {}),
				};
				if (record.status === "done") {
					const answerEntry = entries.find((entry) => entry.id === record.answer);
					answer = answerEntry?.model
						?.flatMap((m) => (m.role === "assistant" ? m.content : []))
						.map((c) => (c.type === "text" ? c.text : ""))
						.join("");
				}
			}
		}
		const sql = this.ctx.storage.sql;
		const execs = sql
			.exec<{ body: string }>("SELECT body FROM harbour_execs ORDER BY id")
			.toArray()
			.map((row) => JSON.parse(row.body) as ExecRecord);
		const events = sql
			.exec<{ at: number; body: string }>("SELECT at, body FROM harbour_events ORDER BY id")
			.toArray()
			.map((row) => ({ at: row.at, ...JSON.parse(row.body) }));
		const leases = [...this.#leases.all()].map((row) => row.lease);
		const head = (await this.#workspaces().get(this.#ctx(meta), meta.workspaceId)).head;
		return {
			sessionId: meta.sessionId,
			...(submission === undefined ? {} : { submission }),
			toolResults,
			...(answer === undefined ? {} : { answer }),
			workspace: { id: meta.workspaceId, head },
			execs,
			events,
			leases,
			process: { openedAt: this.#openedAt, harnessOpenMs: this.#openMs },
		};
	}

	async #fixture() {
		const meta = this.#requireMeta();
		const entries = await this.#entries();
		const uses = await this.env.VAULT.getByName("spike").uses(meta.sessionId);
		const state = await this.#state(undefined);
		const audit = this.ctx.storage.sql
			.exec<{ body: string }>("SELECT body FROM harbour_audit ORDER BY seq")
			.toArray()
			.map((row) => JSON.parse(row.body) as AuditEventInput);
		return {
			format: "harbour-m0-session-fixture/2",
			recordedAt: new Date().toISOString(),
			scenario: meta.scenario.name,
			entries,
			execs: state.execs,
			events: state.events,
			leases: state.leases,
			audit,
			vault: uses,
		};
	}

	async #file(path: string): Promise<Response> {
		const meta = this.#requireMeta();
		try {
			const file = await this.#workspaces().read(this.#ctx(meta), meta.workspaceId, path);
			return new Response(file.content, { headers: { "x-harbour-version": String(file.version) } });
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 404);
		}
	}
}

type SetupBody = { sessionId: string; workspaceId?: string; scenario?: Scenario; isolateGeneration?: string };
type ExecBody = {
	command: string;
	tier?: SandboxTier;
	timeoutMs?: number;
	containerName?: string;
	isolateGeneration?: string;
};

function sqliteLeaseStore(sql: SqlStorage): LeaseStore {
	return {
		get(id) {
			const row = sql.exec<{ body: string }>("SELECT body FROM harbour_leases WHERE id = ?", id).toArray()[0];
			return row === undefined ? undefined : (JSON.parse(row.body) as LeaseRow);
		},
		put(row) {
			sql.exec(
				"INSERT INTO harbour_leases (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
				row.lease.id,
				JSON.stringify(row),
			);
		},
		all() {
			return sql
				.exec<{ body: string }>("SELECT body FROM harbour_leases ORDER BY rowid")
				.toArray()
				.map((row) => JSON.parse(row.body) as LeaseRow);
		},
		escalated(key, mark) {
			const seen = sql.exec("SELECT key FROM harbour_escalated WHERE key = ?", key).toArray().length > 0;
			if (mark && !seen) sql.exec("INSERT INTO harbour_escalated (key) VALUES (?)", key);
			return seen;
		},
	};
}

function isInterrupted(message: Message): boolean {
	if (message.role !== "toolResult" || !message.isError) return false;
	return message.content.some((c) => c.type === "text" && /interrupt/i.test(c.text));
}

function round(ms: number) {
	return Math.round(ms * 10) / 10;
}
