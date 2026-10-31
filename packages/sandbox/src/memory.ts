/**
 * In-memory sandboxes, for tests and local runs. There is no real shell: a tiny interpreter runs a portable command
 * subset over a working copy of the workspace. Isolate leases commit after every command that changed files;
 * container leases keep their own working copy and commit when released.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	DEFAULT_TIER_ROUTES,
	type ExecRequest,
	type ExecResult,
	isKantelError,
	KantelError,
	type LeaseEndReason,
	type Mount,
	type ProjectAccess,
	type Role,
	requireSystem,
	type Sandboxes,
	type SandboxLease,
	type SandboxTier,
	type SandboxUsage,
	type SessionEndHook,
	type SessionId,
	type SystemContext,
	systemClock,
	systemContext,
	type TierRoute,
	type WorkspaceId,
	type WorkspaceRecord,
	type Workspaces,
	type WorkspaceVersion,
} from "@kantel/contracts";
import { isUnderMount, normalizeWorkspacePath } from "@kantel/workspace";
import { isAssignmentWord, routeTool, tokenizeShell } from "./index.ts";

const DEFAULT_TTL_MS = 15 * 60_000;
const TIERS: readonly SandboxTier[] = ["isolate", "container"];
const SWEEPER: Actor = { kind: "system", component: "sandbox.sweeper" };
/** Looks a workspace up in the caller's organisation, before the caller's own access is checked. */
const LOOKUP: Actor = { kind: "system", component: "sandbox" };
/** The sandbox appends its audit events as itself. */
const AUDIT_CONTEXT: SystemContext = systemContext("sandbox");

export interface MemorySandboxesOptions {
	readonly workspaces: Workspaces;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** The tool-to-tier table; `DEFAULT_TIER_ROUTES` when absent. */
	readonly routes?: readonly TierRoute[];
	readonly defaultTtlMs?: number;
	/**
	 * Project access (settled question 7). Without it the sandboxes check only the organisation; every target and every
	 * conformance run passes one.
	 */
	readonly access?: ProjectAccess;
	/** The session-end hook (settled question 8); when given, `releaseSession` is registered as the `sandbox` teardown. */
	readonly sessionEnd?: SessionEndHook;
}

/** Uncommitted changes over a workspace version. The in-memory shell only creates and overwrites files. */
interface WorkingCopy {
	base: WorkspaceVersion;
	readonly puts: Map<string, Uint8Array>;
	readonly dirs: Set<string>;
}

interface LeaseState {
	lease: SandboxLease;
	readonly organisationId: string;
	readonly projectId?: string;
	/** The container's own working copy; isolate leases start a fresh one per command. */
	readonly working?: WorkingCopy;
	busyMs: number;
	releasing?: Promise<SandboxLease>;
}

export function createMemorySandboxes(options: MemorySandboxesOptions): Sandboxes {
	const { workspaces } = options;
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const routes = options.routes ?? DEFAULT_TIER_ROUTES;
	const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
	const access = options.access;
	const leases = new Map<string, LeaseState>();
	const escalated = new Set<string>();

	/** Requires `needed` on `sessionId`'s project (and, when given, that the session belongs to `projectId`). */
	async function requireSession(
		ctx: CallContext,
		sessionId: SessionId,
		needed: Role,
		operation: string,
		extra: { readonly projectId?: string; readonly leaseId?: string } = {},
	): Promise<void> {
		await access?.require(ctx, {
			sessionId,
			needed,
			operation,
			...(extra.projectId === undefined ? {} : { projectId: extra.projectId }),
			...(extra.leaseId === undefined ? {} : { subject: { kind: "sandbox.lease", id: extra.leaseId } }),
		});
	}

	/** The workspace in the caller's organisation (`not_found` otherwise), read without the caller's project check. */
	function workspaceInOrganisation(ctx: CallContext, workspaceId: WorkspaceId): Promise<WorkspaceRecord> {
		return workspaces.get({ actor: LOOKUP, organisationId: ctx.organisationId }, workspaceId);
	}

	/** The leases of `sessionId` in the caller's organisation. */
	function leasesOf(ctx: CallContext, sessionId: SessionId): LeaseState[] {
		return [...leases.values()].filter(
			(state) => state.organisationId === ctx.organisationId && state.lease.sessionId === sessionId,
		);
	}

	function load(ctx: CallContext, leaseId: string): LeaseState {
		const state = leases.get(leaseId);
		if (state === undefined || state.organisationId !== ctx.organisationId) {
			throw new KantelError("not_found", `lease ${leaseId} not found`);
		}
		return state;
	}

	function event(
		state: Pick<LeaseState, "organisationId" | "projectId">,
		actor: Actor,
		sessionId: SessionId,
		fields: Pick<AuditEventInput, "id" | "type" | "subject" | "data">,
	): AuditEventInput {
		return {
			at: clock.now(),
			source: "sandbox",
			actor,
			organisationId: state.organisationId,
			...(state.projectId === undefined ? {} : { projectId: state.projectId }),
			sessionId,
			...(actor.kind === "agent" ? { agentId: actor.agentId } : {}),
			...fields,
		};
	}

	/** Ends a lease without committing; returns the audit event to append. */
	function end(state: LeaseState, reason: LeaseEndReason, actor: Actor, committedVersion?: number): AuditEventInput {
		const now = clock.now();
		state.lease = { ...state.lease, endedAt: now, endReason: reason };
		return event(state, actor, state.lease.sessionId, {
			id: `sandbox:lease:${state.lease.id}:released`,
			type: "sandbox.lease.released",
			subject: { kind: "sandbox.lease", id: state.lease.id },
			data: {
				tier: state.lease.tier,
				reason,
				heldMs: now - state.lease.acquiredAt,
				busyMs: state.busyMs,
				...(committedVersion === undefined ? {} : { committedVersion }),
			},
		});
	}

	/** Appends `event`. Takes the event already built, so the lease ends even without an audit sink. */
	async function emit(event: AuditEventInput): Promise<void> {
		await audit?.append(AUDIT_CONTEXT, [event]);
	}

	function pastTtl(state: LeaseState): boolean {
		return state.lease.endedAt === undefined && clock.now() >= state.lease.expiresAt;
	}

	/** Rejects with `expired` when the lease has ended or passed its TTL (ending it first in that case). */
	async function requireLive(state: LeaseState, actor: Actor): Promise<void> {
		if (pastTtl(state)) await emit(end(state, "expired", actor));
		if (state.lease.endedAt !== undefined || state.releasing !== undefined) {
			throw new KantelError("expired", `lease ${state.lease.id} has ended`, {
				endReason: state.lease.endReason ?? "released",
			});
		}
	}

	/** The session's live lease on `tier`, ending any that passed its TTL on the way. */
	function liveLease(organisationId: string, sessionId: SessionId, tier: SandboxTier, expired: AuditEventInput[]) {
		for (const state of leases.values()) {
			if (state.organisationId !== organisationId || state.lease.sessionId !== sessionId) continue;
			if (state.lease.tier !== tier || state.lease.endedAt !== undefined) continue;
			if (pastTtl(state)) {
				expired.push(end(state, "expired", SWEEPER));
				continue;
			}
			return state;
		}
		return undefined;
	}

	function ttl(ttlMs: number | undefined): number {
		const value = ttlMs ?? defaultTtlMs;
		if (!Number.isFinite(value) || value <= 0) throw new KantelError("invalid", "ttlMs must be a positive number");
		return value;
	}

	const sandboxes: Sandboxes = {
		async acquire(ctx, input) {
			const ttlMs = ttl(input.ttlMs);
			const workspace = await workspaceInOrganisation(ctx, input.workspaceId);
			await requireSession(ctx, input.sessionId, "operator", "sandbox.acquire", projectOf(workspace));
			const record = await workspaces.get(ctx, input.workspaceId);
			const expired: AuditEventInput[] = [];
			const existing = liveLease(ctx.organisationId, input.sessionId, input.tier, expired);
			await audit?.append(AUDIT_CONTEXT, expired);
			if (existing !== undefined) {
				throw new KantelError("conflict", `session ${input.sessionId} already holds a live ${input.tier} lease`, {
					leaseId: existing.lease.id,
				});
			}
			const now = clock.now();
			const lease: SandboxLease = {
				id: `lease_${crypto.randomUUID()}`,
				sessionId: input.sessionId,
				workspaceId: input.workspaceId,
				tier: input.tier,
				baseVersion: record.head,
				acquiredAt: now,
				expiresAt: now + ttlMs,
			};
			leases.set(lease.id, {
				lease,
				organisationId: ctx.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				...(input.tier === "container" ? { working: { base: record.head, puts: new Map(), dirs: new Set() } } : {}),
				busyMs: 0,
			});
			await audit?.append(AUDIT_CONTEXT, [
				event({ organisationId: ctx.organisationId, projectId: ctx.projectId }, ctx.actor, input.sessionId, {
					id: `sandbox:lease:${lease.id}:acquired`,
					type: "sandbox.lease.acquired",
					subject: { kind: "sandbox.lease", id: lease.id },
					data: {
						tier: lease.tier,
						workspaceId: lease.workspaceId,
						baseVersion: lease.baseVersion,
						expiresAt: lease.expiresAt,
					},
				}),
			]);
			return lease;
		},

		async renew(ctx, leaseId, ttlMs) {
			const value = ttl(ttlMs);
			const state = load(ctx, leaseId);
			await requireSession(ctx, state.lease.sessionId, "operator", "sandbox.renew", { leaseId });
			await requireLive(state, ctx.actor);
			state.lease = { ...state.lease, expiresAt: clock.now() + value };
			return state.lease;
		},

		async release(ctx, leaseId, reason = "released") {
			const state = load(ctx, leaseId);
			await requireSession(ctx, state.lease.sessionId, "operator", "sandbox.release", { leaseId });
			if (state.lease.endedAt !== undefined) return state.lease;
			state.releasing ??= (async () => {
				if (pastTtl(state) || reason === "expired") {
					// Expired leases are discarded, not committed.
					await emit(end(state, "expired", ctx.actor));
					return state.lease;
				}
				let committedVersion: number | undefined;
				const working = state.working;
				if (working !== undefined && working.puts.size > 0) {
					// The memory target re-bases by committing the container's files on top of the current head.
					const head = (await workspaces.get(ctx, state.lease.workspaceId)).head;
					const result = await workspaces.commit(ctx, state.lease.workspaceId, {
						baseVersion: head,
						changes: [...working.puts].map(([path, content]) => ({ op: "put", path, content })),
						writer: { sessionId: state.lease.sessionId, leaseId },
						message: `container lease ${leaseId}`,
					});
					committedVersion = result.version;
				}
				await emit(end(state, reason, ctx.actor, committedVersion));
				return state.lease;
			})();
			try {
				return await state.releasing;
			} finally {
				state.releasing = undefined;
			}
		},

		async exec(ctx, leaseId, request) {
			const state = load(ctx, leaseId);
			await requireSession(ctx, state.lease.sessionId, "operator", "sandbox.exec", { leaseId });
			await requireLive(state, ctx.actor);
			return execOn(ctx, state, request);
		},

		async run(ctx, input) {
			const workspace = await workspaceInOrganisation(ctx, input.workspaceId);
			await requireSession(ctx, input.sessionId, "operator", "sandbox.run", projectOf(workspace));
			const tier = sandboxes.route(input.tool, input.request.command);
			const expired: AuditEventInput[] = [];
			let state = liveLease(ctx.organisationId, input.sessionId, tier, expired);
			await audit?.append(AUDIT_CONTEXT, expired);
			if (state !== undefined && state.lease.workspaceId !== input.workspaceId) {
				throw new KantelError("conflict", `the session's ${tier} lease is on another workspace`, {
					leaseId: state.lease.id,
				});
			}
			if (state === undefined) {
				const lease = await sandboxes.acquire(ctx, {
					sessionId: input.sessionId,
					workspaceId: input.workspaceId,
					tier,
				});
				state = leases.get(lease.id)!;
			}
			const escalation = `${ctx.organisationId}\u0000${input.sessionId}`;
			if (tier === "container" && !escalated.has(escalation)) {
				escalated.add(escalation);
				await audit?.append(AUDIT_CONTEXT, [
					event(state, ctx.actor, input.sessionId, {
						id: `sandbox:escalated:${ctx.organisationId}:${input.sessionId}`,
						type: "sandbox.escalated",
						subject: { kind: "session", id: input.sessionId },
						data: { tool: input.tool, leaseId: state.lease.id, workspaceId: input.workspaceId },
					}),
				]);
			}
			return execOn(ctx, state, input.request);
		},

		route(tool, command) {
			return routeTool(routes, tool, command);
		},

		async leases(ctx, filter) {
			const held = leasesOf(ctx, filter.sessionId);
			// A session with no leases here lists nothing, as one in another organisation does.
			if (held.length === 0) return [];
			await requireSession(ctx, filter.sessionId, "viewer", "sandbox.leases");
			const found: SandboxLease[] = [];
			for (const state of held) {
				const live = state.lease.endedAt === undefined && !pastTtl(state);
				if (filter.live === undefined || filter.live === live) found.push(state.lease);
			}
			return found.sort((left, right) => left.acquiredAt - right.acquiredAt);
		},

		async releaseSession(ctx, sessionId, reason = "session_ended") {
			const held = leasesOf(ctx, sessionId).filter((state) => state.lease.endedAt === undefined);
			// Nothing held: a silent no-op, so the session-end teardown can run twice.
			if (held.length === 0) return;
			await requireSession(ctx, sessionId, "operator", "sandbox.releaseSession");
			for (const state of held) {
				if (state.lease.endedAt !== undefined) continue;
				await sandboxes.release(ctx, state.lease.id, reason);
			}
		},

		async sweep(ctx) {
			await requireSystem(ctx, "sandbox.sweep", { ...(audit === undefined ? {} : { audit }), clock });
			const swept: SandboxLease[] = [];
			const events: AuditEventInput[] = [];
			for (const state of leases.values()) {
				if (state.releasing !== undefined || !pastTtl(state)) continue;
				events.push(end(state, "expired", SWEEPER));
				swept.push(state.lease);
			}
			await audit?.append(AUDIT_CONTEXT, events);
			return swept;
		},

		async usage(ctx, sessionId) {
			const held = leasesOf(ctx, sessionId);
			if (held.length > 0) await requireSession(ctx, sessionId, "viewer", "sandbox.usage");
			const now = clock.now();
			const usage = new Map<SandboxTier, { leases: number; heldMs: number; busyMs: number }>(
				TIERS.map((tier) => [tier, { leases: 0, heldMs: 0, busyMs: 0 }]),
			);
			for (const state of held) {
				const totals = usage.get(state.lease.tier)!;
				totals.leases++;
				totals.heldMs += (state.lease.endedAt ?? now) - state.lease.acquiredAt;
				totals.busyMs += state.busyMs;
			}
			return [...usage].map(([tier, totals]): SandboxUsage => ({ tier, ...totals }));
		},
	};

	async function execOn(ctx: CallContext, state: LeaseState, request: ExecRequest): Promise<ExecResult> {
		const { lease } = state;
		const record = await workspaces.get(ctx, lease.workspaceId);
		const cwd = request.cwd === undefined || request.cwd === "" ? "" : normalizeWorkspacePath(request.cwd);
		// Containers re-base their working copy on the current head, so they see what the isolate committed.
		const working: WorkingCopy = state.working ?? { base: record.head, puts: new Map(), dirs: new Set() };
		working.base = record.head;
		const shell = new MemoryShell({
			ctx,
			workspaces,
			workspaceId: lease.workspaceId,
			mounts: record.mounts,
			working,
			tier: lease.tier,
			stdin: request.stdin ?? "",
			cwd,
		});
		const startedAt = clock.now();
		const outcome = await shell.run(request.command);
		let workspaceVersion = record.head;
		if (state.working === undefined && working.puts.size > 0) {
			const result = await workspaces.commit(ctx, lease.workspaceId, {
				baseVersion: working.base,
				changes: [...working.puts].map(([path, content]) => ({ op: "put", path, content })),
				writer: { sessionId: lease.sessionId, leaseId: lease.id },
				message: `isolate lease ${lease.id}`,
			});
			workspaceVersion = result.version;
		}
		const durationMs = clock.now() - startedAt;
		state.busyMs += durationMs;
		return { ...outcome, tier: lease.tier, leaseId: lease.id, workspaceVersion, durationMs };
	}

	options.sessionEnd?.register("sandbox", (ctx, end) => sandboxes.releaseSession(ctx, end.sessionId, end.reason));
	return sandboxes;
}

/** The project a project-owned workspace belongs to, for checking that a session acts in it. */
function projectOf(workspace: WorkspaceRecord): { readonly projectId?: string } {
	return workspace.owner.kind === "project" ? { projectId: workspace.owner.projectId } : {};
}

interface ShellIo {
	readonly ctx: CallContext;
	readonly workspaces: Workspaces;
	readonly workspaceId: WorkspaceId;
	readonly mounts: readonly Mount[];
	readonly working: WorkingCopy;
	readonly tier: SandboxTier;
	readonly stdin: string;
	/** A relative workspace directory; `""` is the root. */
	readonly cwd: string;
}

/** Where a shell path points: the working copy, a read-only mount, or anywhere else (which does not exist here). */
type Location =
	| { readonly kind: "workspace"; readonly path: string }
	| { readonly kind: "mount"; readonly path: string }
	| { readonly kind: "outside"; readonly path: string };

type PathKind = "file" | "directory" | "missing";

interface Outcome {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	/** Set by `exit`: stop the command list. */
	readonly exit?: true;
}

interface Step {
	readonly words: string[];
	readonly redirects: { readonly target: string; readonly append: boolean }[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UNSUPPORTED = "is not supported by the in-memory shell";

/**
 * The portable command subset: `printf`, `echo`, `cat`, `ls [path]`, `mkdir [-p]`, `cd`, `exit`, `true`, `false`,
 * `git --version` (container tier only), `>` and `>>` redirection and `&&` lists. Parent directories of written files
 * are created implicitly.
 */
class MemoryShell {
	readonly #io: ShellIo;
	#cwd: Location;

	constructor(io: ShellIo) {
		this.#io = io;
		this.#cwd = { kind: "workspace", path: io.cwd };
	}

	async run(command: string | readonly string[]): Promise<Outcome> {
		if (typeof command !== "string") return this.#simple({ words: [...command], redirects: [] });
		const { tokens, problem } = tokenizeShell(command);
		if (problem !== undefined) return failure(2, `sh: ${problem} ${UNSUPPORTED}\n`);
		const steps: Step[] = [];
		let step: Step = { words: [], redirects: [] };
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (token.kind === "word") {
				step.words.push(token.value);
			} else if (token.value === ">" || token.value === ">>") {
				const target = tokens[index + 1];
				if (target?.kind !== "word") return failure(2, "sh: syntax error: redirection without a file\n");
				step.redirects.push({ target: target.value, append: token.value === ">>" });
				index++;
			} else if (token.value === "&&") {
				if (step.words.length === 0 && step.redirects.length === 0) return failure(2, "sh: syntax error near &&\n");
				steps.push(step);
				step = { words: [], redirects: [] };
			} else {
				return failure(2, `sh: ${token.value} ${UNSUPPORTED}\n`);
			}
		}
		if (step.words.length > 0 || step.redirects.length > 0) steps.push(step);
		else if (steps.length > 0) return failure(2, "sh: syntax error: command list ends with &&\n");

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		for (const current of steps) {
			const outcome = await this.#simple(current);
			stdout += outcome.stdout;
			stderr += outcome.stderr;
			exitCode = outcome.exitCode;
			if (outcome.exit === true || exitCode !== 0) break;
		}
		return { exitCode, stdout, stderr };
	}

	async #simple(step: Step): Promise<Outcome> {
		let start = 0;
		while (start < step.words.length && isAssignmentWord(step.words[start]!)) start++;
		// Like sh, open (and check) every redirection before running the command.
		const targets: Location[] = [];
		for (const redirect of step.redirects) {
			const location = this.#resolve(redirect.target);
			const reason = await this.#unwritable(location);
			if (reason !== undefined) return failure(1, `sh: cannot create ${redirect.target}: ${reason}\n`);
			targets.push(location);
		}
		const [name, ...args] = step.words.slice(start);
		const outcome = name === undefined ? success("") : await this.#command(name, args);
		if (targets.length === 0) return outcome;
		for (const [index, target] of targets.entries()) {
			const content = index === targets.length - 1 ? outcome.stdout : "";
			await this.#write(target, encoder.encode(content), step.redirects[index]!.append);
		}
		return { ...outcome, stdout: "" };
	}

	async #command(name: string, args: readonly string[]): Promise<Outcome> {
		switch (name) {
			case "true":
				return success("");
			case "false":
				return failure(1, "");
			case "exit": {
				const arg = args[0] ?? "0";
				if (!/^\d+$/.test(arg)) return { ...failure(2, `sh: exit: Illegal number: ${arg}\n`), exit: true };
				return { exitCode: Number(arg) & 255, stdout: "", stderr: "", exit: true };
			}
			case "echo":
				return args[0] === "-n" ? success(args.slice(1).join(" ")) : success(`${args.join(" ")}\n`);
			case "printf":
				if (args[0] === undefined) return failure(2, "printf: usage: printf format [arguments]\n");
				return success(formatPrintf(args[0], args.slice(1)));
			case "cat":
				return this.#cat(args);
			case "ls":
				return this.#ls(args);
			case "mkdir":
				return this.#mkdir(args);
			case "cd":
				return this.#cd(args);
			case "git":
				if (this.#io.tier !== "container") return failure(127, "sh: git: command not found\n");
				if (args.length === 1 && args[0] === "--version") return success("git version 2.x (harbour-memory)\n");
				return failure(1, `git: only git --version ${UNSUPPORTED}\n`);
			default:
				return failure(127, `sh: ${name}: command not found\n`);
		}
	}

	async #cat(args: readonly string[]): Promise<Outcome> {
		if (args.length === 0) return success(this.#io.stdin);
		let stdout = "";
		let stderr = "";
		for (const arg of args) {
			const location = this.#resolve(arg);
			const kind = await this.#kind(location);
			if (kind === "missing") stderr += `cat: ${arg}: No such file or directory\n`;
			else if (kind === "directory") stderr += `cat: ${arg}: Is a directory\n`;
			else stdout += decoder.decode(await this.#read(location));
		}
		return { exitCode: stderr === "" ? 0 : 1, stdout, stderr };
	}

	async #ls(args: readonly string[]): Promise<Outcome> {
		if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
			return failure(2, `ls: options and several paths ${UNSUPPORTED}\n`);
		}
		const target = args[0] ?? ".";
		const location = this.#resolve(target);
		const kind = await this.#kind(location);
		if (kind === "missing") return failure(2, `ls: cannot access '${target}': No such file or directory\n`);
		if (kind === "file") return success(`${target}\n`);
		return success((await this.#children(location)).map((name) => `${name}\n`).join(""));
	}

	async #mkdir(args: readonly string[]): Promise<Outcome> {
		const parents = args.includes("-p");
		const paths = args.filter((arg) => arg !== "-p");
		if (paths.some((arg) => arg.startsWith("-"))) return failure(2, `mkdir: options other than -p ${UNSUPPORTED}\n`);
		if (paths.length === 0) return failure(1, "mkdir: missing operand\n");
		let stderr = "";
		for (const path of paths) {
			const reason = await this.#mkdirOne(this.#resolve(path), parents);
			if (reason !== undefined) stderr += `mkdir: cannot create directory '${path}': ${reason}\n`;
		}
		return { exitCode: stderr === "" ? 0 : 1, stdout: "", stderr };
	}

	async #mkdirOne(location: Location, parents: boolean): Promise<string | undefined> {
		if (location.kind === "mount") return "Read-only file system";
		if (location.kind === "outside") return "Permission denied";
		const kind = await this.#kind(location);
		if (kind === "file") return "File exists";
		if (kind === "directory") return parents ? undefined : "File exists";
		if (!isValidWorkspacePath(location.path)) return "Invalid argument";
		const segments = location.path.split("/");
		for (let depth = 1; depth < segments.length; depth++) {
			const ancestor = await this.#kind({ kind: "workspace", path: segments.slice(0, depth).join("/") });
			if (ancestor === "file") return "Not a directory";
			if (ancestor === "missing" && !parents) return "No such file or directory";
		}
		this.#io.working.dirs.add(location.path);
		return undefined;
	}

	async #cd(args: readonly string[]): Promise<Outcome> {
		const target = args[0];
		if (target === undefined) {
			this.#cwd = { kind: "workspace", path: "" };
			return success("");
		}
		const location = this.#resolve(target);
		if (location.kind === "outside" || (await this.#kind(location)) !== "directory") {
			return failure(2, `sh: cd: can't cd to ${target}\n`);
		}
		this.#cwd = location;
		return success("");
	}

	#resolve(arg: string): Location {
		if (arg === "") return { kind: "outside", path: "" };
		if (arg.startsWith("/") || this.#cwd.kind !== "workspace") {
			const segments = arg.startsWith("/") ? [] : this.#cwd.path.split("/").filter((segment) => segment !== "");
			for (const segment of arg.split("/")) {
				if (segment === "" || segment === ".") continue;
				if (segment === "..") segments.pop();
				else segments.push(segment);
			}
			const path = `/${segments.join("/")}`;
			return isUnderMount(path, this.#io.mounts) ? { kind: "mount", path } : { kind: "outside", path };
		}
		const segments = this.#cwd.path === "" ? [] : this.#cwd.path.split("/");
		for (const segment of arg.split("/")) {
			if (segment === "" || segment === ".") continue;
			if (segment !== "..") segments.push(segment);
			else if (segments.pop() === undefined) return { kind: "outside", path: arg };
		}
		return { kind: "workspace", path: segments.join("/") };
	}

	async #kind(location: Location): Promise<PathKind> {
		const { ctx, workspaces, workspaceId, working } = this.#io;
		if (location.kind === "outside") return "missing";
		if (location.kind === "workspace") {
			const { path } = location;
			if (path === "") return "directory";
			if (working.puts.has(path)) return "file";
			const prefix = `${path}/`;
			for (const key of [...working.puts.keys(), ...working.dirs]) {
				if (key === path || key.startsWith(prefix)) return "directory";
			}
		}
		try {
			const options = location.kind === "workspace" ? { version: working.base } : undefined;
			return (await workspaces.stat(ctx, workspaceId, location.path, options)).kind;
		} catch (error) {
			if (isKantelError(error, "not_found") || isKantelError(error, "invalid")) return "missing";
			throw error;
		}
	}

	async #read(location: Location): Promise<Uint8Array> {
		const { ctx, workspaces, workspaceId, working } = this.#io;
		if (location.kind === "workspace") {
			const put = working.puts.get(location.path);
			if (put !== undefined) return put;
			return (await workspaces.read(ctx, workspaceId, location.path, { version: working.base })).content;
		}
		return (await workspaces.read(ctx, workspaceId, location.path)).content;
	}

	async #children(location: Location): Promise<string[]> {
		const { ctx, workspaces, workspaceId, working } = this.#io;
		const names = new Set<string>();
		const add = (path: string) => names.add(path.slice(path.lastIndexOf("/") + 1));
		const listAll = async (path: string | undefined, version: WorkspaceVersion | undefined) => {
			let cursor: string | undefined;
			do {
				const page = await workspaces.list(ctx, workspaceId, {
					limit: 1000,
					...(path === undefined ? {} : { path }),
					...(version === undefined ? {} : { version }),
					...(cursor === undefined ? {} : { cursor }),
				});
				for (const entry of page.items) add(entry.path);
				cursor = page.nextCursor;
			} while (cursor !== undefined);
		};
		if (location.kind !== "workspace") {
			await listAll(location.path, undefined);
		} else {
			const { path } = location;
			try {
				await listAll(path === "" ? undefined : path, working.base);
			} catch (error) {
				// The directory may exist only in the working copy.
				if (!isKantelError(error, "not_found")) throw error;
			}
			const prefix = path === "" ? "" : `${path}/`;
			for (const key of [...working.puts.keys(), ...working.dirs]) {
				if (key.startsWith(prefix) && key.length > prefix.length) names.add(key.slice(prefix.length).split("/")[0]!);
			}
		}
		return [...names].sort();
	}

	/** Why `location` cannot be written as a file, or undefined when it can. */
	async #unwritable(location: Location): Promise<string | undefined> {
		if (location.kind === "mount") return "Read-only file system";
		if (location.kind === "outside") return "Permission denied";
		if (location.path === "" || (await this.#kind(location)) === "directory") return "Is a directory";
		if (!isValidWorkspacePath(location.path)) return "Invalid argument";
		const segments = location.path.split("/");
		for (let depth = 1; depth < segments.length; depth++) {
			const ancestor = await this.#kind({ kind: "workspace", path: segments.slice(0, depth).join("/") });
			if (ancestor === "file") return "Not a directory";
		}
		return undefined;
	}

	async #write(location: Location, content: Uint8Array, append: boolean): Promise<void> {
		if (location.kind !== "workspace") throw new Error("only the working copy is writable");
		let bytes = content;
		if (append && (await this.#kind(location)) === "file") {
			const existing = await this.#read(location);
			bytes = new Uint8Array(existing.byteLength + content.byteLength);
			bytes.set(existing);
			bytes.set(content, existing.byteLength);
		}
		this.#io.working.puts.set(location.path, bytes);
	}
}

/** `printf` with `%s`, `%d`, `%%` and the common backslash escapes; the format repeats while arguments remain. */
function formatPrintf(format: string, args: readonly string[]): string {
	let output = "";
	let next = 0;
	do {
		let converted = false;
		for (let index = 0; index < format.length; index++) {
			const char = format[index]!;
			const following = format[index + 1];
			if (char === "\\" && following !== undefined) {
				const escapes: { readonly [key: string]: string } = { n: "\n", t: "\t", r: "\r", "\\": "\\" };
				output += escapes[following] ?? `\\${following}`;
				index++;
			} else if (char === "%" && following === "%") {
				output += "%";
				index++;
			} else if (char === "%" && (following === "s" || following === "d")) {
				const arg = args[next++] ?? "";
				output += following === "d" ? String(Number.parseInt(arg, 10) || 0) : arg;
				converted = true;
				index++;
			} else {
				output += char;
			}
		}
		if (!converted) break;
	} while (next < args.length);
	return output;
}

function isValidWorkspacePath(path: string): boolean {
	try {
		normalizeWorkspacePath(path);
		return true;
	} catch {
		return false;
	}
}

function success(stdout: string): Outcome {
	return { exitCode: 0, stdout, stderr: "" };
}

function failure(exitCode: number, stderr: string): Outcome {
	return { exitCode, stdout: "", stderr };
}
