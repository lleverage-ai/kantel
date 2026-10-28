/**
 * SessionDO for the readiness spike. One class, two paths:
 *
 * - **Cold (today's path, M0-CF1's bench):** a SessionDO that has never existed is set up (workspace lookup in R2,
 *   Pi Durable `Harness.open` on empty SQLite, a conversation), then lists the workspace in a Dynamic Worker loaded for
 *   the first time, with the head and manifest read from R2.
 * - **Pre-loaded (option (a)):** a pool object is warmed before anyone owns it: Harness opened, conversation created,
 *   and its own Dynamic Worker loaded under a slot ID (no workspace binding, egress props naming only the slot) and run
 *   once, so just-bash is compiled and warm. The hand-out writes the slot-to-session map once, takes the manifest from
 *   the WorkspaceDO (or R2) and lists the workspace in that isolate with a `WorkspaceScope` passed per call.
 *
 * Every answer says which DO instance and which isolate served it, so the bench can tell a reused isolate (and a DO
 * still in memory) from a reload after hibernation or eviction.
 */
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ExecRequest, Manifest } from "@harbour/isolate-host/src/sandbox.ts";
import ISOLATE_BUNDLE from "../dist/isolate.bundle.txt";
import { where } from "./where.ts";
import { readHead, readManifest, WorkspaceScope } from "./workspace.ts";

/** M0-CF1's listing command. */
export const LIST_COMMAND = "ls -1R /workspace | wc -l";
const MODEL = { provider: "harbour-script", modelId: "scripted" } as const;

type IsolateInfo = { readonly boot: string; readonly calls: number };
type Listed = { entries: number; bytes: number; isolate: IsolateInfo };
type Executed = { exitCode: number; stdout: string; stderr: string; isolate: IsolateInfo };
type SandboxStub = {
	list(manifest: Manifest, scope?: WorkspaceScope): Promise<Listed>;
	exec(request: ExecRequest, scope?: WorkspaceScope): Promise<Executed>;
};

export type KeepAlive = "none" | "timer" | "alarm";

type State = {
	kind: "cold" | "slot";
	conversationId: string;
	sessionId?: string;
	workspaceId?: string;
	slot?: string;
	warmedAt?: number;
	warmBoot?: string;
	warmInstance?: string;
	keepAlive?: KeepAlive;
	keepAliveUntil?: number;
	pings?: number;
};

/** Changes whenever the bundle changes, so a deploy never reuses an isolate with old code. */
const BUNDLE_ID = (() => {
	let hash = 2166136261;
	for (let i = 0; i < ISOLATE_BUNDLE.length; i += 997) hash = Math.imul(hash ^ ISOLATE_BUNDLE.charCodeAt(i), 16777619);
	return `${ISOLATE_BUNDLE.length.toString(36)}${(hash >>> 0).toString(36)}`;
})();

const PING_MS = 20_000;

export class SessionDO extends DurableObject<Env> {
	#instance: string | undefined;
	readonly #constructedAt = Date.now();
	#harness: Harness | undefined;
	/** How many times this instance's loader callbacks ran: each is a load the Worker Loader had no cached code for. */
	#codeFetches = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS spike_state (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
	}

	// ---- shared ----------------------------------------------------------------------------------------------------

	#state(): State | undefined {
		const row = this.ctx.storage.sql.exec<{ body: string }>("SELECT body FROM spike_state WHERE id = 1").toArray()[0];
		return row === undefined ? undefined : (JSON.parse(row.body) as State);
	}

	#setState(state: State): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO spike_state (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body",
			JSON.stringify(state),
		);
	}

	#who() {
		this.#instance ??= crypto.randomUUID();
		return { instance: this.#instance, constructedAt: this.#constructedAt, codeFetches: this.#codeFetches };
	}

	/** Pi Durable on this object's SQLite, with Pi's coding tools and a scripted model, as M0-CF1's SessionDO opens it. */
	async #open(): Promise<Harness> {
		if (this.#harness !== undefined) return this.#harness;
		const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }] });
		faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("ok"))));
		const models = createModels();
		models.setProvider(faux.provider);
		const tools = [createBashTool(), createReadTool(), createWriteTool(), createEditTool()];
		const extension = defineExtension({
			name: "harbour-ready-spike",
			tools,
			sections: [section("preamble", () => "You are a Harbour spike agent working in /workspace.", { tag: false })],
		});
		const registry = createRegistry();
		registry.install(extension);
		const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: { extensions: [extension], documentRetentionMs: 0 },
				conversationCreated: (tx, conversation) =>
					conversation.owner === undefined && conversation.parent === undefined
						? configure(tx, conversation.id, { model: MODEL, thinkingLevel: "off", tools, cwd: "/workspace" })
						: undefined,
			},
			BACKGROUND_CONTEXT,
		);
		this.#harness = harness;
		return harness;
	}

	async #createConversation(): Promise<string> {
		const harness = await this.#open();
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		return String(conversation.id);
	}

	#load(id: string, env: Record<string, unknown>, egress: { session?: string; slot?: string }): SandboxStub {
		const worker = this.env.LOADER.get(`${id}:${BUNDLE_ID}`, async () => {
			this.#codeFetches += 1;
			return {
				compatibilityDate: "2026-10-01",
				mainModule: "sandbox.js",
				modules: { "sandbox.js": ISOLATE_BUNDLE },
				env,
				globalOutbound: this.ctx.exports.Egress({ props: egress }),
			};
		});
		return worker.getEntrypoint() as unknown as SandboxStub;
	}

	where() {
		return where();
	}

	async ping(): Promise<{ ok: true }> {
		return { ok: true };
	}

	// ---- cold: today's path -----------------------------------------------------------------------------------------

	/** M0-CF1's setup: workspace lookup in R2 (an existence check and a get, one head read each), Harness, conversation. */
	async setup(sessionId: string, workspaceId: string) {
		if (this.#state() !== undefined) throw new Error("session already set up");
		const started = Date.now();
		await readHead(this.env.WORKSPACES, workspaceId);
		await readHead(this.env.WORKSPACES, workspaceId);
		const looked = Date.now();
		const conversationId = await this.#createConversation();
		this.#setState({ kind: "cold", sessionId, workspaceId, conversationId });
		return { timings: { workspaceMs: looked - started, setupMs: Date.now() - started }, who: this.#who() };
	}

	/** M0-CF1's list: head and manifest from R2, then a Dynamic Worker never loaded before, bound to the workspace. */
	async coldList() {
		const state = this.#state();
		if (state?.kind !== "cold" || state.sessionId === undefined || state.workspaceId === undefined)
			throw new Error("not a cold session");
		const started = Date.now();
		const manifest = await readManifest(this.env.WORKSPACES, state.workspaceId);
		const read = Date.now();
		const sandbox = this.#load(
			`cold:${state.sessionId}`,
			{ WS: this.ctx.exports.Blobs({ props: { workspaceId: state.workspaceId } }) },
			{ session: state.sessionId },
		);
		const listed = await sandbox.list(manifest);
		const listedAt = Date.now();
		const ls = await sandbox.exec({ command: LIST_COMMAND, manifest });
		const lsAt = Date.now();
		if (ls.exitCode !== 0) throw new Error(`ls failed: ${ls.stderr}`);
		return {
			entries: listed.entries,
			lines: ls.stdout.trim(),
			isolate: ls.isolate,
			timings: { manifestMs: read - started, listMs: listedAt - read, lsMs: lsAt - listedAt },
			who: this.#who(),
		};
	}

	// ---- pre-loaded: option (a) -----------------------------------------------------------------------------------

	#slotSandbox(slot: string): SandboxStub {
		// No workspace binding: the workspace comes with each call. Egress props name only the slot.
		return this.#load(`slot:${slot}`, {}, { slot });
	}

	/** Warm one pool object before anyone owns it. */
	async warm(slot: string, keepAlive: KeepAlive = "none", keepAliveMs = 0) {
		if (this.#state() !== undefined) throw new Error("already warmed");
		const started = Date.now();
		const conversationId = await this.#createConversation();
		const opened = Date.now();
		const sandbox = this.#slotSandbox(slot);
		const scope = new WorkspaceScope(this.env.WORKSPACES, "");
		scope.revoke();
		// One call loads the isolate; a command on an empty tree runs just-bash once, so the hand-out's listing is warm.
		const loaded = await sandbox.list({}, scope);
		const loadedAt = Date.now();
		const ran = await sandbox.exec({ command: LIST_COMMAND, manifest: {} }, scope);
		const ranAt = Date.now();
		const who = this.#who();
		this.#setState({
			kind: "slot",
			conversationId,
			slot,
			warmedAt: ranAt,
			warmBoot: loaded.isolate.boot,
			warmInstance: who.instance,
			keepAlive,
			...(keepAlive === "none" ? {} : { keepAliveUntil: ranAt + keepAliveMs }),
			pings: 0,
		});
		if (keepAlive === "timer") this.#armTimer(slot);
		if (keepAlive === "alarm") await this.ctx.storage.setAlarm(Date.now() + PING_MS);
		return {
			isolate: ran.isolate,
			timings: { harnessMs: opened - started, loadMs: loadedAt - opened, firstExecMs: ranAt - loadedAt },
			who,
		};
	}

	/** Keep-alive by timer: a pending timer keeps the object in memory (not hibernatable, billed), pinging its isolate. */
	#armTimer(slot: string): void {
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#keepAlivePing(slot).then((again) => {
				if (again) this.#armTimer(slot);
			});
		}, PING_MS);
	}

	/** Keep-alive by alarm: the object may hibernate between alarms; each alarm pings the isolate. */
	override async alarm(): Promise<void> {
		const state = this.#state();
		if (state?.slot === undefined || state.keepAlive !== "alarm") return;
		if (await this.#keepAlivePing(state.slot)) await this.ctx.storage.setAlarm(Date.now() + PING_MS);
	}

	async #keepAlivePing(slot: string): Promise<boolean> {
		const state = this.#state();
		if (state === undefined || state.sessionId !== undefined || Date.now() >= (state.keepAliveUntil ?? 0)) return false;
		const scope = new WorkspaceScope(this.env.WORKSPACES, "");
		scope.revoke();
		await this.#slotSandbox(slot).list({}, scope);
		this.#setState({ ...state, pings: (state.pings ?? 0) + 1 });
		return true;
	}

	/**
	 * Hand this pool object to a new session: the slot-to-session map is written once, never reassigned; the manifest
	 * comes from the WorkspaceDO (hot) or R2; the listing runs in the slot's isolate with a scope for this workspace.
	 * If the object was hibernated or evicted, its Harness reopens in parallel with the listing.
	 */
	async handout(sessionId: string, workspaceId: string, manifestFrom: "workspace-do" | "r2") {
		const started = Date.now();
		const state = this.#state();
		if (state?.kind !== "slot" || state.slot === undefined) throw new Error("not a pool object");
		if (state.sessionId !== undefined) throw new Error("already handed out");
		this.#setState({ ...state, sessionId, workspaceId });
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		if (state.keepAlive === "alarm") await this.ctx.storage.deleteAlarm();
		const harnessInMemory = this.#harness !== undefined;
		let harnessAt = started;
		const harness = this.#open().then(() => {
			harnessAt = Date.now();
		});
		const manifest =
			manifestFrom === "r2"
				? await readManifest(this.env.WORKSPACES, workspaceId)
				: await this.env.WORKSPACE.getByName(workspaceId).manifest();
		const manifestAt = Date.now();
		const scope = new WorkspaceScope(this.env.WORKSPACES, workspaceId);
		try {
			const sandbox = this.#slotSandbox(state.slot);
			const listed = await sandbox.list(manifest, scope);
			const listedAt = Date.now();
			const ls = await sandbox.exec({ command: LIST_COMMAND, manifest }, scope);
			const lsAt = Date.now();
			await harness;
			if (ls.exitCode !== 0) throw new Error(`ls failed: ${ls.stderr}`);
			const who = this.#who();
			return {
				entries: listed.entries,
				lines: ls.stdout.trim(),
				isolate: { ...ls.isolate, reused: ls.isolate.boot === state.warmBoot },
				doInMemory: who.instance === state.warmInstance,
				harnessInMemory,
				idleMs: started - (state.warmedAt ?? started),
				keepAlive: state.keepAlive ?? "none",
				pings: state.pings ?? 0,
				timings: {
					manifestMs: manifestAt - started,
					listMs: listedAt - manifestAt,
					lsMs: lsAt - listedAt,
					harnessMs: harnessAt - started,
					handoutMs: Date.now() - started,
				},
				who,
			};
		} finally {
			scope.revoke();
		}
	}
}
