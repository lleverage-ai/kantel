/**
 * A fake of boat.dev's REST API (https://boat.dev/api/v1), as a `fetch`: the sandbox endpoints the boat provider
 * calls, with boat's paths, bodies, error envelopes, states and webhook signatures, from boat's OpenAPI document.
 * For the adapter's tests and for running a gateway against boat without an account. Sandboxes live in memory and
 * their commands run in `shell.ts`'s tiny shell.
 *
 * What it checks, as boat does: the bearer key; a scoped key's actions; `Idempotency-Key` on create; that a resume
 * is of a stopped sandbox; that a delete names its sandbox in `X-Ascii-Confirm-Delete` and the sandbox is stopped;
 * paths under `/home/user` or `/tmp`; `timeoutSeconds` between 1 and 600. A resumed sandbox may be set to answer its
 * first commands `409 sandbox_restoring`, as a sandbox still copying its disk back does.
 */

import { signBoatWebhook } from "./boat.ts";
import { emptyTree, HOME, makeDirs, resolvePath, runShell, type ShellFiles } from "./shell.ts";

type State = "provisioning" | "ready" | "running" | "idle" | "archiving" | "archived" | "error" | "cancelled";

export interface FakeBoatSandbox {
	readonly id: string;
	name: string;
	state: State;
	type: "small" | "default" | "large" | "xlarge";
	labels: Record<string, string>;
	noEnv: boolean;
	ttlSeconds: number | null;
	tree: ShellFiles;
	createdAt: number;
	runningSince?: number;
	runningSeconds: number;
	deleted: boolean;
	/** Commands left to answer `409 sandbox_restoring` after a resume. */
	restoring: number;
	readonly commands: string[];
}

/** The actions boat's scoped keys carry, as the fake checks them. */
export type BoatAction =
	| "sandbox.create"
	| "sandbox.read"
	| "sandbox.stop"
	| "sandbox.resume"
	| "sandbox.fork"
	| "sandbox.delete"
	| "exec"
	| "file.read"
	| "file.write"
	| "host"
	| "snapshot.save";

/** What the `ci` preset allows in the fake: everything the provider needs. */
export const CI_ACTIONS: readonly BoatAction[] = [
	"sandbox.create",
	"sandbox.read",
	"sandbox.stop",
	"sandbox.resume",
	"sandbox.fork",
	"sandbox.delete",
	"exec",
	"file.read",
	"file.write",
	"host",
	"snapshot.save",
];

export interface FakeBoatOptions {
	/** Keys it accepts, each with its actions. Default one key, `boat_test`, with `CI_ACTIONS`. */
	readonly keys?: Readonly<Record<string, readonly BoatAction[]>>;
	readonly now?: () => number;
	/** Milliseconds a provision, resume or archive takes; 0 settles before the answer. Default 0. */
	readonly settleMs?: number;
	/** Commands a resumed sandbox answers `409 sandbox_restoring` before it runs them. Default 0. */
	readonly restoringCommands?: number;
	/** Starts allowed before boat answers 429 `rate_limited`. Default unlimited. */
	readonly startLimit?: number;
}

export interface FakeBoat {
	readonly fetch: typeof fetch;
	readonly sandboxes: ReadonlyMap<string, FakeBoatSandbox>;
	/** Every call, as `METHOD /path`, for tests. */
	readonly calls: readonly string[];
	/** A signed delivery of `type` for `sandboxId`, as boat sends it. */
	webhook(secret: string, type: string, sandboxId: string, at?: number): Promise<{ headers: Headers; body: string }>;
	/** Moves a sandbox to `state` behind the caller's back (boat's own auto-stop, a crash). */
	set(sandboxId: string, state: State): void;
}

const ID_CHARS = "23456789abcdefghjkmnpqrstuvwxyz";

export function createFakeBoat(options: FakeBoatOptions = {}): FakeBoat {
	const keys = options.keys ?? { boat_test: CI_ACTIONS };
	const now = options.now ?? (() => Date.now());
	const settleMs = options.settleMs ?? 0;
	const sandboxes = new Map<string, FakeBoatSandbox>();
	const idempotent = new Map<string, string>();
	const savedSnapshots = new Map<string, ShellFiles>();
	const calls: string[] = [];
	let starts = 0;
	let seq = 0;

	const newId = () => {
		seq += 1;
		let n = seq * 7919;
		let id = "";
		for (let i = 0; i < 8; i++) {
			id += ID_CHARS[n % ID_CHARS.length];
			n = Math.floor(n / ID_CHARS.length) + i * 13;
		}
		return `bx_${id}`;
	};
	const reply = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	const fail = (status: number, code: string, message: string) =>
		reply(status, {
			ok: false,
			type: "error",
			status,
			code,
			message,
			requestId: `req_${seq}`,
			error: { code, message, status },
		});
	const view = (sandbox: FakeBoatSandbox) => ({
		id: sandbox.id,
		name: sandbox.name,
		state: sandbox.state,
		type: sandbox.type,
		labels: sandbox.labels,
		error: sandbox.state === "error" ? "The machine stopped responding" : null,
		holdsCreatorLogins: !sandbox.noEnv,
		createdAt: new Date(sandbox.createdAt).toISOString(),
		desktopAvailable: false,
		snapshotAvailable: true,
		ttlSeconds: sandbox.ttlSeconds,
	});
	const later = (sandbox: FakeBoatSandbox, to: State) => {
		const apply = () => {
			if (sandbox.deleted) return;
			if (to === "ready") sandbox.runningSince = now();
			if (to === "archived" && sandbox.runningSince !== undefined) {
				sandbox.runningSeconds += Math.round((now() - sandbox.runningSince) / 1000);
				sandbox.runningSince = undefined;
			}
			sandbox.state = to;
		};
		if (settleMs <= 0) apply();
		else setTimeout(apply, settleMs);
	};
	const up = (sandbox: FakeBoatSandbox) => ["ready", "running", "idle"].includes(sandbox.state);
	const underHome = (path: string) => {
		const at = resolvePath(HOME, path);
		return at === HOME || at.startsWith(`${HOME}/`) || at === "/tmp" || at.startsWith("/tmp/") ? at : undefined;
	};
	const startCounted = () => {
		starts += 1;
		return options.startLimit !== undefined && starts > options.startLimit;
	};
	const make = (body: Record<string, unknown>, tree: ShellFiles): FakeBoatSandbox => {
		const sandbox: FakeBoatSandbox = {
			id: newId(),
			name: typeof body.name === "string" ? body.name : `Sandbox ${new Date(now()).toISOString()}`,
			state: "provisioning",
			type: (body.type as FakeBoatSandbox["type"]) ?? "default",
			labels: (body.labels as Record<string, string>) ?? {},
			noEnv: body.noEnv === true,
			ttlSeconds: body.ttlSeconds === undefined ? 3600 : (body.ttlSeconds as number | null),
			tree,
			createdAt: now(),
			runningSeconds: 0,
			deleted: false,
			restoring: 0,
			commands: [],
		};
		sandboxes.set(sandbox.id, sandbox);
		later(sandbox, "ready");
		return sandbox;
	};
	const clone = (tree: ShellFiles): ShellFiles => ({ files: new Map(tree.files), dirs: new Set(tree.dirs) });
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/^\/api\/v1/, "");
		calls.push(`${request.method} ${path}`);
		const key = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const actions = key === undefined ? undefined : keys[key];
		if (actions === undefined) return fail(401, "unauthorized", "Missing or invalid API key");
		const need = (action: BoatAction) =>
			actions.includes(action) ? undefined : fail(403, "forbidden", `This API key can't ${action}`);
		const body = async (): Promise<Record<string, unknown>> => {
			const text = await request.text();
			return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
		};

		if (request.method === "POST" && path === "/sandboxes") {
			const refused = need("sandbox.create");
			if (refused) return refused;
			const input = await body();
			const idem = request.headers.get("idempotency-key");
			const known = idem === null ? undefined : idempotent.get(idem);
			const existing = known === undefined ? undefined : sandboxes.get(known);
			if (existing !== undefined) {
				return reply(202, { ok: true, type: "sandbox.created", status: existing.state, sandbox: view(existing) });
			}
			if (startCounted()) return fail(429, "rate_limited", "Machine start limit reached (minute)");
			let tree = emptyTree();
			if (typeof input.from === "string") {
				const saved = savedSnapshots.get(input.from);
				if (saved === undefined) return fail(404, "snapshot_not_found", `No saved snapshot ${input.from}`);
				tree = clone(saved);
			}
			const sandbox = make(input, tree);
			if (idem !== null) idempotent.set(idem, sandbox.id);
			return reply(202, {
				ok: true,
				type: "sandbox.created",
				status: "provisioning",
				ttlSeconds: sandbox.ttlSeconds,
				sandbox: view(sandbox),
			});
		}

		if (request.method === "POST" && path === "/saved-snapshots") {
			const refused = need("snapshot.save");
			if (refused) return refused;
			const input = await body();
			const source = sandboxes.get(String(input.sandboxId));
			if (source === undefined || source.deleted) return fail(404, "not_found", "Sandbox not found");
			const name = String(input.name);
			if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return fail(400, "invalid_name", "Bad snapshot name");
			savedSnapshots.set(name, clone(source.tree));
			return reply(202, {
				ok: true,
				type: "snapshot.saving",
				status: "saving",
				snapshot: { name, status: "saving", sourceSandboxId: source.id, createdAt: new Date(now()).toISOString() },
			});
		}

		const match = /^\/sandboxes\/([^/]+)(\/.*)?$/.exec(path);
		if (match === null) return fail(404, "not_found", "No such route");
		const sandbox = sandboxes.get(decodeURIComponent(match[1] ?? ""));
		const rest = match[2] ?? "";
		if (sandbox === undefined || sandbox.deleted) return fail(404, "not_found", "Sandbox not found");

		if (request.method === "GET" && rest === "") {
			const refused = need("sandbox.read");
			if (refused) return refused;
			return reply(200, { ok: true, type: "sandbox.info", sandbox: view(sandbox) });
		}
		if (request.method === "DELETE" && rest === "") {
			const refused = need("sandbox.delete");
			if (refused) return refused;
			if (request.headers.get("x-ascii-confirm-delete") !== sandbox.id) {
				return fail(409, "confirmation_required", "X-Ascii-Confirm-Delete must name the sandbox");
			}
			if (up(sandbox) || sandbox.state === "archiving") {
				return fail(409, "sandbox_running", "Stop the sandbox before deleting its data");
			}
			sandbox.deleted = true;
			sandbox.state = "cancelled";
			return reply(202, { ok: true, type: "deletion.accepted", operationId: `del_${sandbox.id}` });
		}
		if (request.method === "POST" && rest === "/stop") {
			const refused = need("sandbox.stop");
			if (refused) return refused;
			if (sandbox.state !== "archived" && sandbox.state !== "archiving") {
				sandbox.state = "archiving";
				later(sandbox, "archived");
			}
			return reply(202, {
				ok: true,
				type: "sandbox.stopping",
				id: sandbox.id,
				status: sandbox.state === "archived" ? "archived" : "archiving",
				sandbox: view(sandbox),
			});
		}
		if (request.method === "POST" && rest === "/resume") {
			const refused = need("sandbox.resume");
			if (refused) return refused;
			const input = await body();
			if (sandbox.state !== "archived" && sandbox.state !== "error") {
				return fail(409, "sandbox_not_stopped", `The sandbox is ${sandbox.state}`);
			}
			if (startCounted()) return fail(429, "rate_limited", "Machine start limit reached (minute)");
			if (typeof input.type === "string") sandbox.type = input.type as FakeBoatSandbox["type"];
			if (input.noEnv === true) sandbox.noEnv = true;
			if (input.ttlSeconds !== undefined) sandbox.ttlSeconds = input.ttlSeconds as number | null;
			sandbox.state = "provisioning";
			sandbox.restoring = options.restoringCommands ?? 0;
			later(sandbox, "ready");
			return reply(202, {
				ok: true,
				type: "sandbox.resuming",
				id: sandbox.id,
				status: "resuming",
				sandbox: view(sandbox),
			});
		}
		if (request.method === "POST" && rest === "/fork") {
			const refused = need("sandbox.fork");
			if (refused) return refused;
			const input = await body();
			if (startCounted()) return fail(429, "rate_limited", "Machine start limit reached (minute)");
			// A fork of a no-env sandbox is always no-env.
			const fork = make({ ...input, noEnv: input.noEnv === true || sandbox.noEnv }, clone(sandbox.tree));
			return reply(202, { ok: true, type: "sandbox.forking", id: fork.id, status: "forking", sandbox: view(fork) });
		}
		if (request.method === "POST" && rest === "/commands") {
			const refused = need("exec");
			if (refused) return refused;
			const input = await body();
			if (!up(sandbox)) return fail(409, "sandbox_not_running", `The sandbox is ${sandbox.state}`);
			if (sandbox.restoring > 0) {
				sandbox.restoring -= 1;
				return fail(409, "sandbox_restoring", "The sandbox is still restoring its disk");
			}
			const timeout = input.timeoutSeconds;
			if (timeout !== undefined && (typeof timeout !== "number" || timeout < 1 || timeout > 600)) {
				return fail(400, "invalid_timeout", "timeoutSeconds must be between 1 and 600");
			}
			const command = String(input.command ?? "");
			sandbox.commands.push(command);
			const cwd = typeof input.cwd === "string" ? resolvePath(HOME, input.cwd) : HOME;
			if (!cwd.startsWith(HOME)) return fail(400, "invalid_cwd", "cwd must be inside the work directory");
			if (input.detached === true) {
				return reply(200, {
					ok: true,
					type: "command.started",
					success: true,
					processId: sandbox.commands.length,
					command,
					cwd,
				});
			}
			const result = sandbox.tree.dirs.has(cwd)
				? runShell(command, sandbox.tree, { cwd, env: { HOME } })
				: { exitCode: 1, stdout: "", stderr: `cd: ${cwd}: No such file or directory\n` };
			if (input.stream === true) {
				const frames = [
					{ type: "started", commandId: `cmd_${sandbox.commands.length}` },
					...(result.stdout === "" ? [] : [{ type: "stdout", data: result.stdout }]),
					...(result.stderr === "" ? [] : [{ type: "stderr", data: result.stderr }]),
					{ type: "exit", exitCode: result.exitCode, success: result.exitCode === 0, timedOut: false },
				];
				return new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
					status: 200,
					headers: { "content-type": "application/x-ndjson" },
				});
			}
			return reply(200, {
				ok: true,
				type: "command.result",
				success: result.exitCode === 0,
				exitCode: result.exitCode,
				signal: null,
				stdout: result.stdout,
				stderr: result.stderr,
				stdoutTruncated: false,
				stderrTruncated: false,
				timedOut: false,
				cwd,
			});
		}
		if (rest === "/files" || rest === "/files/list") {
			if (!up(sandbox)) return fail(409, "sandbox_not_running", `The sandbox is ${sandbox.state}`);
			if (request.method === "PUT") {
				const refused = need("file.write");
				if (refused) return refused;
				const input = await body();
				const at = underHome(String(input.path));
				if (at === undefined) return fail(400, "invalid_path", "Paths must be under /home/user or /tmp");
				const content = String(input.content ?? "");
				const bytes =
					input.encoding === "base64"
						? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0))
						: encoder.encode(content);
				makeDirs(sandbox.tree, at.slice(0, at.lastIndexOf("/")));
				sandbox.tree.files.set(at, bytes);
				return reply(200, { ok: true, type: "file.written", success: true, path: at, size: bytes.length });
			}
			const refused = need(request.method === "DELETE" ? "file.write" : "file.read");
			if (refused) return refused;
			const at = underHome(url.searchParams.get("path") ?? HOME);
			if (at === undefined) return fail(400, "invalid_path", "Paths must be under /home/user or /tmp");
			if (rest === "/files/list") {
				const prefix = `${at}/`;
				const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
				const files = [
					...[...sandbox.tree.dirs]
						.filter(direct)
						.map((p) => ({ name: p.slice(prefix.length), path: p, isDir: true, size: 0 })),
					...[...sandbox.tree.files]
						.filter(([p]) => direct(p))
						.map(([p, bytes]) => ({ name: p.slice(prefix.length), path: p, isDir: false, size: bytes.length })),
				];
				return reply(200, { ok: true, type: "file.list", success: true, path: at, files, truncated: false });
			}
			if (request.method === "DELETE") {
				const existed = sandbox.tree.files.delete(at) || sandbox.tree.dirs.has(at);
				for (const file of [...sandbox.tree.files.keys()])
					if (file.startsWith(`${at}/`)) sandbox.tree.files.delete(file);
				for (const dir of [...sandbox.tree.dirs])
					if (dir === at || dir.startsWith(`${at}/`)) sandbox.tree.dirs.delete(dir);
				return existed
					? reply(200, { ok: true, type: "file.deleted", success: true })
					: fail(404, "not_found", "No such file");
			}
			const file = sandbox.tree.files.get(at);
			if (file === undefined) return fail(404, "not_found", "No such file");
			const base64 = url.searchParams.get("encoding") === "base64";
			let text = "";
			if (base64) for (const byte of file) text += String.fromCharCode(byte);
			return reply(200, {
				ok: true,
				type: "file.read",
				success: true,
				path: at,
				encoding: base64 ? "base64" : "utf8",
				size: file.length,
				content: base64 ? btoa(text) : decoder.decode(file),
			});
		}
		if (request.method === "POST" && rest === "/host") {
			const refused = need("host");
			if (refused) return refused;
			const input = await body();
			const port = Number(input.port);
			const isPublic = input.public === true;
			return reply(200, {
				ok: true,
				type: "port.hosted",
				success: true,
				port,
				url: `https://${sandbox.id.slice(3)}-${port}.on.boat.dev${isPublic ? "" : "?_token=fake"}`,
				isProtected: !isPublic,
			});
		}
		if (request.method === "GET" && rest === "/usage") {
			const refused = need("sandbox.read");
			if (refused) return refused;
			const live = sandbox.runningSince === undefined ? 0 : Math.round((now() - sandbox.runningSince) / 1000);
			const seconds = sandbox.runningSeconds + live;
			return reply(200, {
				ok: true,
				type: "sandbox.usage",
				sandboxId: sandbox.id,
				sandboxType: sandbox.type,
				seconds,
				dollars: seconds / 100_000,
				running: up(sandbox),
			});
		}
		return fail(404, "not_found", "No such route");
	}

	return {
		fetch: (async (input: string | URL | Request, init?: RequestInit) =>
			handle(new Request(input instanceof URL ? input.toString() : input, init))) as typeof fetch,
		sandboxes,
		calls,
		async webhook(secret, type, sandboxId, at = now()) {
			seq += 1;
			const delivery = `evt_${seq.toString(16).padStart(32, "0")}`;
			const timestamp = String(Math.floor(at / 1000));
			const sandbox = sandboxes.get(sandboxId);
			const body = JSON.stringify({
				id: delivery,
				type,
				createdAt: new Date(at).toISOString(),
				data: { sandbox: { id: sandboxId, name: sandbox?.name ?? sandboxId } },
			});
			const headers = new Headers({
				"x-ascii-event": type,
				"x-ascii-delivery": delivery,
				"x-ascii-timestamp": timestamp,
				"x-ascii-signature": await signBoatWebhook(secret, delivery, timestamp, body),
				"x-ascii-attempt": "1",
			});
			return { headers, body };
		},
		set(sandboxId, state) {
			const sandbox = sandboxes.get(sandboxId);
			if (sandbox === undefined) return;
			later(sandbox, state);
		},
	};
}
