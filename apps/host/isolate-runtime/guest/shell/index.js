// The sandbox isolate's shell: just-bash over a filesystem the embedder chooses (Kantel's is shell/manifest-fs.js: a
// lazy in-memory one built from the manifest the host sends, its changes committed to the workspace at the end), with
// `node` and `python` run in a fresh isolate each (op_kt_run) over the same files, the commands an isolate lacks
// answered by stubs (shell/unavailable.js), and a parse-before-run check for those (shell/prescan.js).
//
// createShell(ops, { filesystem, commands, log }) takes any `ShellFilesystem`:
//
//   filesystem.open(request) -> {
//     fs,                  // a just-bash IFileSystem with the sandbox's files under /workspace
//     childIndex(chunks),  // the files as a node/python run sees them (manifest-fs.js has the format)
//     unchanged(),         // the reply's { manifest, changed, lazyReads? } when the command didn't run
//     finish(),            // save the command's changes: { manifest, changed, commit?, lazyReads? }, where `commit`
//                          // ({ status, error }) says when they weren't saved
//     adoptStaged(path, staged, mode),  // optional: keep a host command's staged output (its blob) as a file the
//                          // shell doesn't read, which finish() commits by its blob
//   }
//
// The embedder's host commands (src/host_commands.rs) are commands of the same name here, run on the host
// (op_kt_host_command) with the files as childIndex gives them; a name they take is never refused as unavailable.
//
// `commands` are the embedder's own guest commands, written in JavaScript: `{ name, run(args, ctx, shell), override }`.
// `run` gets just-bash's command context (`ctx.fs` is the command's filesystem, so what it writes there is the
// command's change like any other) and `shell.host(name, args, options)`, which runs one of the embedder's host
// commands as the shell would (its writes applied to the shell's files; `options` are `{ stdin, cwd, env }`, by default
// the command's own) and answers `{ exitCode, stdout, stderr }` as bytes. `run` answers just-bash's
// `{ stdout, stderr, exitCode }`. Nothing it gets can commit: its changes are saved by
// the shell command's one commit, as a host command's are. A name the shell already has (just-bash's commands, `node`,
// `python`, `python3`, a host command) is an error unless the command says `override: true`; one the isolate lacks
// (git, say) is the embedder's to take, and is then neither stubbed nor refused before running.
import { Bash, defineCommand, getCommandNames, getNetworkCommandNames } from "just-bash/browser";
import { latin1 } from "../common/text.js";
import { Chunks, egressFetch, unpack } from "../common/web.js";
import { describeFsError } from "./fs-errors.js";
import { abs, manifestFilesystem, normalise, ROOT, rel } from "./manifest-fs.js";
import { prescan } from "./prescan.js";
import { message, UNAVAILABLE } from "./unavailable.js";

// A filesystem error a redirection meets fails only its command (guest/just-bash-patches.ts's hook).
globalThis.__justBashFsError = describeFsError;

const UNAVAILABLE_BY_NAME = new Map(UNAVAILABLE);

/** The most output one command may make (parity with sandbox.ts: zlib's 128 MiB output cap). */
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

const fromLatin1 = (s) => {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
};

/** The commands the shell has of its own: just-bash's, and the runtimes it runs in a fresh isolate. */
const BUILT_IN = new Set([...getCommandNames(), ...getNetworkCommandNames(), "node", "python", "python3"]);

/** The embedder's guest commands by name, checked: each a name and a `run`, once, and a built-in only on purpose. */
function embedderCommands(commands) {
	if (!Array.isArray(commands)) throw new TypeError("createShell: commands is an array of { name, run, override }");
	const byName = new Map();
	for (const command of commands) {
		const { name, run, override = false } = command ?? {};
		if (typeof name !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(name) || typeof run !== "function") {
			throw new TypeError(`createShell: a command is { name, run(args, ctx, shell), override }, not ${String(name)}`);
		}
		if (byName.has(name)) throw new Error(`createShell: two commands named ${name}`);
		if (BUILT_IN.has(name) && override !== true) {
			throw new Error(`createShell: the shell has a ${name} command; pass override: true to replace it`);
		}
		byName.set(name, { name, run, override: override === true });
	}
	return byName;
}

/**
 * The shell isolate's entry point (`{ exec(json) }`). `ops` are the runtime's (the shell kind's); `filesystem` is a
 * `ShellFilesystem` (Kantel's manifest one by default); `log(level, line)` gets a line per command; `commands` are the
 * embedder's own guest commands (the header says how they run). A command clashing with a built-in throws here; one
 * clashing with a host command throws from every `exec`, as the host commands' names are known only then.
 */
export function createShell(ops, options = {}) {
	// The second argument was `log` alone before options; still accepted.
	const {
		filesystem = manifestFilesystem(ops),
		log,
		commands = [],
	} = typeof options === "function" ? { log: options } : options;
	const own = embedderCommands(commands);
	let nextRun = 1;
	// The embedder's host commands, by name: served, so neither stubbed nor refused.
	let hostNames;
	const hostCommands = () => {
		if (!hostNames) {
			const names = new Set(JSON.parse(ops.op_kt_host_commands()));
			const clash = [...own.values()].find((c) => names.has(c.name) && !c.override);
			// Every command fails alike, rather than the clash going unnoticed until the name is run.
			if (clash) throw new Error(`createShell: ${clash.name} is a host command; pass override: true to replace it`);
			hostNames = names;
		}
		return hostNames;
	};
	/** A name the isolate otherwise lacks that is served here: a host command's or the embedder's own. */
	const served = (name) => own.has(name) || hostCommands().has(name);
	/** The program's `{ command, reason }` if the isolate doesn't have it. */
	const unavailableProgram = (name) =>
		UNAVAILABLE_BY_NAME.has(name) && !served(name)
			? { command: name, reason: `${UNAVAILABLE_BY_NAME.get(name)}.` }
			: undefined;

	async function exec(request) {
		// A host command the embedder's own command clashes with fails every command, before any of it runs.
		hostCommands();
		const t0 = performance.now();
		const files = await filesystem.open(request);
		const { fs } = files;

		/** The first command that needed a microVM, and whether any child run was stopped (and why). */
		let needsMicrovm;
		let terminated;

		/** Where a file at `full` goes: in its directory as the shell resolves it (through symbolic links), what of it
		 * is missing made below the part that is there. */
		async function within(full) {
			const name = full.slice(full.lastIndexOf("/") + 1);
			const missing = [];
			let dir = full.slice(0, full.lastIndexOf("/")) || "/";
			for (;;) {
				try {
					const real = await fs.realpath(dir);
					const target = [real === "/" ? "" : real, ...missing].join("/");
					if (missing.length > 0) await fs.mkdir(target, { recursive: true });
					return `${target}/${name}`;
				} catch (error) {
					if (dir === "/") throw error;
					missing.unshift(dir.slice(dir.lastIndexOf("/") + 1));
					dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
				}
			}
		}

		/** Apply a node/python run's or a host command's file changes (removals, directories, writes, links). */
		async function apply(result, slice) {
			for (const path of result.removes ?? []) await fs.rm(abs(path), { recursive: true, force: true });
			for (const path of result.mkdirs ?? []) await fs.mkdir(abs(path), { recursive: true });
			for (const w of result.writes ?? []) {
				const full = await within(abs(w.path));
				if (w.staged) {
					if (!files.adoptStaged) throw new Error(`${w.path}: this shell's filesystem can't keep a staged output`);
					await fs.rm(full, { recursive: true, force: true });
					// Through a link out of the workspace, it isn't kept: nothing there is committed.
					const at = rel(full);
					if (at !== undefined && at !== "") files.adoptStaged(at, w.staged, w.mode);
					continue;
				}
				await fs.writeFile(full, slice(w.data).slice());
				if (w.mode !== undefined && w.mode !== 0o644) await fs.chmod(full, w.mode);
			}
			for (const s of result.symlinks ?? []) {
				const full = abs(s.path);
				await fs.rm(full, { force: true });
				await fs.mkdir(full.slice(0, full.lastIndexOf("/")) || "/", { recursive: true });
				await fs.symlink(s.target, full);
			}
		}

		// node / python: the workspace as the child sees it and stdin; the child's writes come back here, so they
		// reach the workspace like any other command's.
		const child = (name) =>
			defineCommand(name, async (args, ctx) => {
				const chunks = new Chunks();
				const index = await files.childIndex(chunks);
				const stdin = chunks.add(fromLatin1(String(ctx.stdin ?? "")));
				const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env ?? []);
				const runId = nextRun++;
				const meta = { args, cwd: ctx.cwd, env, index, stdin, runId };
				const onAbort = () => ops.op_kt_cancel_run(runId);
				ctx.signal?.addEventListener?.("abort", onAbort, { once: true });
				let raw;
				try {
					raw = await ops.op_kt_run(name, JSON.stringify(meta), chunks.bytes());
				} finally {
					ctx.signal?.removeEventListener?.("abort", onAbort);
				}
				const { meta: result, data } = unpack(raw);
				const slice = (at) => data.subarray(at[0], at[0] + at[1]);
				await apply(result, slice);
				if (result.needsMicrovm && !needsMicrovm) needsMicrovm = result.needsMicrovm;
				if (result.terminated) terminated = result.terminated;
				return {
					stdout: latin1(slice(result.stdout)),
					stdoutKind: "bytes",
					stderr: new TextDecoder().decode(slice(result.stderr)),
					exitCode: result.exitCode,
				};
			});

		// The embedder's: run on the host, with the files as they are now; their changes come back like a run's.
		// Answers the exit code, stdout and stderr as bytes, the host's writes applied.
		async function runHost(name, args, ctx, { stdin = ctx.stdin, cwd = ctx.cwd, env } = {}) {
			if (!hostCommands().has(name)) throw new Error(`${name}: no such host command`);
			const runId = nextRun++;
			// The shell's `timeout` cancels it on the host too, from before it is prepared: a cancellation while the
			// files are indexed stops it before it starts.
			const onAbort = () => ops.op_kt_host_cancel(runId);
			ctx.signal?.addEventListener?.("abort", onAbort, { once: true });
			let raw;
			try {
				const chunks = new Chunks();
				const index = await files.childIndex(chunks);
				const input = stdin instanceof Uint8Array ? stdin : fromLatin1(String(stdin ?? ""));
				const at = chunks.add(input);
				env ??= ctx.exportedEnv ?? Object.fromEntries(ctx.env ?? []);
				if (ctx.signal?.aborted) {
					return {
						exitCode: 130,
						stdout: new Uint8Array(0),
						stderr: new TextEncoder().encode(`${name}: cancelled\n`),
					};
				}
				const meta = { name, args, cwd: normalise(ctx.cwd, cwd), env, index, stdin: at, runId };
				raw = await ops.op_kt_host_command(JSON.stringify(meta), chunks.bytes());
			} finally {
				ctx.signal?.removeEventListener?.("abort", onAbort);
			}
			const { meta: result, data } = unpack(raw);
			const slice = (at) => data.subarray(at[0], at[0] + at[1]);
			await apply(result, slice);
			return { exitCode: result.exitCode, stdout: slice(result.stdout), stderr: slice(result.stderr) };
		}
		const asResult = (r) => ({
			stdout: latin1(r.stdout),
			stdoutKind: "bytes",
			stderr: new TextDecoder().decode(r.stderr),
			exitCode: r.exitCode,
		});
		const host = (name) => defineCommand(name, async (args, ctx) => asResult(await runHost(name, args, ctx)));
		// The embedder's own guest commands: what they get reaches the files only through the shell.
		const embedder = (command) =>
			defineCommand(command.name, async (args, ctx) =>
				command.run(args, ctx, {
					host: (name, hostArgs = [], options = {}) => runHost(name, hostArgs, ctx, options),
				}),
			);

		const unavailable = UNAVAILABLE.filter(([name]) => !served(name)).map(([name, reason]) =>
			defineCommand(name, async () => {
				needsMicrovm ??= { command: name, reason: `${reason}.` };
				return { stdout: "", stderr: message(name), exitCode: 127 };
			}),
		);
		const cwd = normalise(ROOT, request.cwd ?? ".");
		const bash = new Bash({
			fs,
			cwd,
			env: { HOME: ROOT, ...request.env },
			// Each name once: the embedder's own command replaces the shell's of that name (override, checked above).
			customCommands: [
				...unavailable,
				...["node", "python", "python3"].filter((name) => !own.has(name)).map(child),
				...[...hostCommands()].filter((name) => !own.has(name)).map(host),
				...[...own.values()].map(embedder),
			],
			executionLimits: { maxOutputSize: MAX_OUTPUT_BYTES },
			// The host's egress proxy decides what may leave; curl and wget get a plain fetch with no allow-list of
			// their own (as sandbox.ts does with workerd's globalOutbound).
			fetch: (url, init = {}) => egressFetch(url, init),
		});
		const t1 = performance.now();
		// Parse before running: a command that can't succeed past a program the isolate doesn't have stops before any
		// of it runs (guest/shell/prescan.js). What the parse can't show: a PATH of the request's own, or a working
		// directory outside the workspace, could make a name find a program the parse doesn't see.
		let refused;
		if (request.env?.PATH === undefined && (cwd === ROOT || cwd.startsWith(`${ROOT}/`))) {
			try {
				refused = prescan(bash.transform(request.command).ast, unavailableProgram);
			} catch {
				// A command the parser refuses fails as it always has, when it runs.
			}
		}
		if (refused) {
			const kept = files.unchanged();
			return {
				exitCode: 127,
				stdout: "",
				stderr: message(refused.command, "none"),
				manifest: kept.manifest,
				changed: kept.changed,
				timings: { fsMs: t1 - t0, execMs: 0, commitMs: 0, lazyReads: kept.lazyReads ?? 0 },
				needsMicrovm: refused,
				effects: "none",
			};
		}
		const result = await bash.exec(request.command);
		const t2 = performance.now();
		const saved = await files.finish();
		const t3 = performance.now();
		const response = {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			manifest: saved.manifest,
			changed: saved.changed,
			timings: { fsMs: t1 - t0, execMs: t2 - t1, commitMs: t3 - t2, lazyReads: saved.lazyReads ?? 0 },
		};
		// A command whose changes weren't saved didn't succeed, whatever the shell said.
		if (saved.commit) {
			response.commit = saved.commit;
			response.stderr += `${response.stderr && !response.stderr.endsWith("\n") ? "\n" : ""}kantel: the command's file changes ${saved.commit.status === "unknown" ? "may not have been" : "weren't"} saved: ${saved.commit.error}\n`;
			if (response.exitCode === 0) response.exitCode = 1;
		}
		// Only when the command failed: one that handled the missing program itself (`git --version || true`) ran.
		// Reached while running, so what came before it in the command may have run.
		if (needsMicrovm && result.exitCode !== 0) {
			response.needsMicrovm = needsMicrovm;
			response.effects = "possible";
		}
		if (terminated) response.terminated = terminated;
		if (log) log(1, `exec ${JSON.stringify(request.command).slice(0, 200)} -> ${result.exitCode}`);
		return response;
	}

	return {
		exec: async (json) => JSON.stringify(await exec(JSON.parse(json))),
	};
}
