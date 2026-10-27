import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  type ConversationId,
  createRegistry,
  defineExtension,
  type EntryRecord,
  Harness,
  type HarnessOptions,
  section,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import type { Scenario, SessionState, SessionToolResult, WorkspaceVersion } from "./contracts.ts";
import { type ExecRecord, HarbourEnv } from "./env.ts";
import { ContainerTier, HarbourSandbox, IsolateTier } from "./sandbox.ts";
import { R2Workspace } from "./workspace.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const MODEL = { provider: "harbour-script", modelId: "scripted" } as const;

type Meta = {
  sessionId: string;
  workspaceId: string;
  scenario: Scenario;
  conversationId?: ConversationId;
  /** Crash test: abort the object right after the Nth exec (1-based) has committed, before its result is recorded. */
  killAfterExec?: number;
  /** Isolate generation: a new value loads a fresh Dynamic Worker. */
  isolateGeneration?: string;
};

/**
 * One Harbour session. Opens Pi Durable on this object's SQLite storage, with a scripted model and Pi's coding tools
 * over HarbourEnv. Runs are driven from the alarm handler so the object stays alive while it works and a crash is
 * retried by the platform.
 */
export class SessionDO extends DurableObject<Env> {
  #harness: Harness | undefined;
  #opening: Promise<Harness> | undefined;
  #head: WorkspaceVersion | undefined;
  readonly #openedAt = Date.now();
  #openMs: number | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS harbour_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS harbour_execs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS harbour_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body TEXT NOT NULL)",
    );
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
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM harbour_meta WHERE key = 'meta'").toArray()[0];
    return row === undefined ? undefined : (JSON.parse(row.value) as Meta);
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

  #workspace(meta: Meta): R2Workspace {
    return new R2Workspace(this.env.WORKSPACES, meta.workspaceId);
  }

  #headRef() {
    return {
      get: () => {
        if (this.#head === undefined) throw new Error("workspace head not loaded");
        return this.#head;
      },
      set: (version: WorkspaceVersion) => {
        this.#head = version;
      },
    };
  }

  #sandbox(meta: Meta, overrides: { containerName?: string; isolateGeneration?: string } = {}): HarbourSandbox {
    const generation = overrides.isolateGeneration ?? meta.isolateGeneration;
    return new HarbourSandbox(
      {
        isolate: new IsolateTier(this.env, this.ctx.exports, meta.sessionId, meta.workspaceId, generation),
        container: new ContainerTier(this.env, meta.sessionId, meta.workspaceId, overrides.containerName ?? meta.sessionId),
      },
      this.#headRef(),
    );
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
    // R2 is the truth for the head: a crash after a commit and before any local write cannot lose it.
    this.#head = await this.#workspace(meta).head();
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(storage, this.#options(meta), BACKGROUND_CONTEXT);
    void harness.closed.then((end) => {
      if (end.reason === "failed") this.ctx.abort("harness failed");
    });
    this.#harness = harness;
    harness.resume();
    this.#openMs = Math.round((performance.now() - started) * 10) / 10;
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
      return fauxAssistantMessage(fauxToolCall(step.tool, step.args as Record<string, never>, { id: `step-${completed}-try-${retry}` }), {
        stopReason: "toolUse",
      });
    };
    faux.setResponses(Array.from({ length: 500 }, () => respond));
    const models = createModels();
    models.setProvider(faux.provider);

    const env = new HarbourEnv(this.#workspace(meta), this.#sandbox(meta), this.#headRef(), (record) => this.#recordExec(record));
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
        console.error(JSON.stringify({ message: "harness report", info, error: error instanceof Error ? error.message : String(error) })),
    };
  }

  async #recordExec(record: ExecRecord): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO harbour_execs (at, body) VALUES (?, ?)", Date.now(), JSON.stringify(record));
    const meta = this.#requireMeta();
    if (meta.killAfterExec === undefined) return;
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM harbour_execs").one().n;
    if (count < meta.killAfterExec) return;
    // The command has run and its workspace commit has landed; its tool result has not. Crash here.
    const { killAfterExec: _, ...rest } = meta;
    this.#setMeta(rest);
    this.#event({ type: "kill", afterExec: count, command: record.command, version: record.version });
    await this.ctx.storage.setAlarm(Date.now() + 500);
    await this.ctx.storage.sync();
    this.ctx.abort("harbour spike: killed mid tool call");
  }

  override async alarm(): Promise<void> {
    if (this.#meta() === undefined) return;
    const harness = await this.#open();
    harness.resume();
    await harness.waitForIdle(BACKGROUND_CONTEXT);
  }

  // ---- HTTP surface (see spikes/scenario/README.md) ------------------------------------------------------------------

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
          await this.#sandbox(this.#requireMeta(), body).release();
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
    if (this.#meta() !== undefined) throw new Error("session already set up");
    const sessionId = body.sessionId;
    const workspaceId = body.workspaceId ?? `ws-${sessionId}`;
    const scenario: Scenario = body.scenario ?? { name: "none", steps: [], finalAnswer: "ok", seed: {} };
    const meta: Meta = { sessionId, workspaceId, scenario, ...(body.isolateGeneration ? { isolateGeneration: body.isolateGeneration } : {}) };
    const workspace = this.#workspace(meta);
    if (!(await workspace.exists())) await workspace.create(scenario.seed);
    const workspaceMs = performance.now() - started;
    this.#setMeta(meta);
    const harness = await this.#open();
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    this.#setMeta({ ...meta, conversationId: conversation.id });
    return {
      sessionId,
      workspaceId,
      conversationId: conversation.id,
      head: this.#head,
      timings: { "session.workspace": round(workspaceMs), "session.harnessOpen": this.#openMs ?? 0, "session.setup": round(performance.now() - started) },
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
    const sandbox = this.#sandbox(meta, body);
    const result = await sandbox.exec({
      command: body.command,
      ...(body.tier ? { tier: body.tier } : {}),
      ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
    });
    await this.#recordExec({ command: body.command, tier: result.tier, exitCode: result.exitCode, base: result.base, version: result.version, timings: result.timings });
    return result;
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

  async #state(submissionId: string | undefined): Promise<SessionState & Record<string, unknown>> {
    const meta = this.#requireMeta();
    const harness = await this.#open();
    const entries = await this.#entries();
    const timed: (SessionToolResult & { at: number })[] = [];
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
    const toolResults: SessionToolResult[] = timed.sort((a, b) => a.at - b.at).map(({ at: _, ...result }) => result);
    let submission: SessionState["submission"];
    if (submissionId !== undefined) {
      const record = await (await harness.submission(Number(submissionId) as unknown as SubmissionId, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
      if (record !== undefined) {
        submission = { id: submissionId, status: record.status, ...("reason" in record && record.reason ? { reason: String(record.reason) } : {}) };
        if (record.status === "done") {
          const answerEntry = entries.find((entry) => entry.id === record.answer);
          answer = answerEntry?.model
            ?.flatMap((m) => (m.role === "assistant" ? m.content : []))
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("");
        }
      }
    }
    const execs = this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM harbour_execs ORDER BY id")
      .toArray()
      .map((row) => JSON.parse(row.body) as ExecRecord);
    const events = this.ctx.storage.sql
      .exec<{ at: number; body: string }>("SELECT at, body FROM harbour_events ORDER BY id")
      .toArray()
      .map((row) => ({ at: row.at, ...JSON.parse(row.body) }));
    return {
      sessionId: meta.sessionId,
      ...(submission === undefined ? {} : { submission }),
      toolResults,
      ...(answer === undefined ? {} : { answer }),
      workspace: { id: meta.workspaceId, head: this.#head ?? "" },
      execs,
      events,
      process: { openedAt: this.#openedAt, harnessOpenMs: this.#openMs },
    };
  }

  async #fixture() {
    const meta = this.#requireMeta();
    const entries = await this.#entries();
    const uses = await this.env.VAULT.getByName("spike").uses(meta.sessionId);
    const state = await this.#state(undefined);
    return { format: "harbour-m0-session-fixture/1", recordedAt: new Date().toISOString(), scenario: meta.scenario.name, entries, execs: state.execs, events: state.events, vault: uses };
  }

  async #file(path: string): Promise<Response> {
    const meta = this.#requireMeta();
    await this.#open();
    const workspace = this.#workspace(meta);
    const manifest = await workspace.manifest(this.#headRef().get());
    const entry = manifest.entries[path];
    if (entry === undefined) return json({ error: "not found", head: this.#head }, 404);
    const bytes = await workspace.readBlob(entry.hash);
    return new Response(bytes, { headers: { "x-harbour-version": this.#head ?? "" } });
  }
}

type SetupBody = { sessionId: string; workspaceId?: string; scenario?: Scenario; isolateGeneration?: string };
type ExecBody = { command: string; tier?: "isolate" | "container"; timeoutMs?: number; containerName?: string; isolateGeneration?: string };

function isInterrupted(message: Message): boolean {
  if (message.role !== "toolResult" || !message.isError) return false;
  return message.content.some((c) => c.type === "text" && /interrupt/i.test(c.text));
}

function round(ms: number) {
  return Math.round(ms * 10) / 10;
}
