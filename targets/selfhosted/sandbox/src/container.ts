/**
 * The self-hosted container tier: a `ContainerBackend` (from @kantel/sandbox/tiered) that runs each container lease in
 * its own long-lived Docker container, on gVisor (`runsc-kvm` by default), over the Docker Engine API on a unix socket.
 *
 * - Lifetime: the container is created on the lease's first command and removed (with its volumes) when the lease
 *   ends. Labels name the lease, session, workspace and the lease's expiry, so a host that restarts can find and remove
 *   what it left behind (`reapExpired`), and a lease that comes back to a restarted host gets a fresh container.
 * - Workspace: copied in and out, no host path shared. /workspace is an anonymous volume, because gVisor keeps root
 *   filesystem writes inside the sandbox (`overlay2=root:self`) where the archive API cannot see them, but writes a
 *   volume through to the host. Files go in through the archive API (PUT), into
 *   a root-owned staging volume, which gVisor serves to the sandbox with its shared file access for mounts, and the
 *   sandbox user copies them from there into /workspace (see `STAGE_DIR`).
 * - Re-base: before every command (and every `pending`) the working copy is re-based on the workspace head, as the
 *   Cloudflare spike's container agent does (spikes/cloudflare/container/server.ts): the diff between the version the
 *   container last synced and the head is applied, except for paths the container itself changed since (the container
 *   wins). Its own changes stay in the container until the sandbox commits them (`pending`, then `committed`).
 * - Change detection: see `SCAN_SCRIPT`. After every command, and before every re-base, a script inside the container
 *   hashes /workspace and the host compares the result with what it last synced or saw.
 * - Mounts (`/project` and the like) are copied once, at create, into a named volume each, mounted read-only.
 * - Network: none at all by default. With `network`, the container joins that (internal) Docker network, whose only
 *   way out is the vault proxy, and every HTTP(S) client is pointed at the proxy and trusts the vault's CA.
 */
import {
	type CallContext,
	type Clock,
	isKantelError,
	KantelError,
	type Mount,
	type SandboxLease,
	systemClock,
	type WorkspaceRecord,
} from "@kantel/contracts";
import type { BackendExec, BackendOutput, ContainerBackend, PendingChanges } from "@kantel/sandbox/tiered";
import { normalizeWorkspacePath } from "@kantel/workspace";
import { listAll, type ModedChange, type StoredWorkspaces } from "@kantel/workspace/stored";
import { DockerClient, type ExecOutput } from "./docker.ts";
import { readTar, SANDBOX_GID, SANDBOX_UID, type TarEntry, writeTar } from "./tar.ts";

export interface DockerContainerBackendOptions {
	readonly workspaces: StoredWorkspaces;
	/** Default /var/run/docker.sock. */
	readonly socketPath?: string;
	/** The sandbox image: images/sandbox (bash, git, coreutils, python3, user 1000). */
	readonly image: string;
	/** Docker runtime; default `runsc-kvm` (gVisor on KVM). Use `runsc` inside a VM without nested KVM. */
	readonly runtime?: string;
	readonly memoryBytes?: number;
	readonly nanoCpus?: number;
	/**
	 * The vault proxy, the only way out. Absent: the container has no network at all (`NetworkMode: none`). See
	 * `SandboxNetwork`.
	 */
	readonly network?: SandboxNetwork;
	/**
	 * The credentials the vault proxy knows each lease by. Absent: requests through the proxy carry none, and the proxy
	 * cannot tell one lease's from another's.
	 */
	readonly proxyCredentials?: ProxyCredentials;
	/** Prefix of every label this backend sets and filters on; default `kantel`. */
	readonly labelPrefix?: string;
	readonly clock?: Clock;
	/** A command's deadline when its request sets none; default 120 s. */
	readonly execTimeoutMs?: number;
	/** Bytes kept of each of stdout and stderr; beyond it the output is cut and `truncated` set. Default 1 MiB. */
	readonly maxOutputBytes?: number;
	/**
	 * Directory names that stay local to the container in both directions: neither synced in from the head nor collected
	 * from the container, at any depth. Default `.git` and `node_modules` (`LOCAL_ONLY`). The gateway leaves `.git` out,
	 * so a repository outlives its container and the isolate's git reads see it, as Cloudflare's container agent does.
	 */
	readonly localOnly?: readonly string[];
}

/**
 * How sandboxes reach the vault proxy.
 *
 * - `isolation: "shared"` (the default): `name` is an existing internal network whose only exit is the proxy, and every
 *   lease's container joins it. Sandboxes on it can reach each other.
 * - `isolation: "per-lease"`: each lease gets an internal network of its own, `<name>-<random>`, created with its
 *   container and removed with it, and the proxy's container (`proxyContainer`) is connected to it under the proxy
 *   URL's host name. The proxy is the container's only peer, so no sandbox can reach another. Needs a host name, not an
 *   address, in `proxyUrl`.
 */
export interface SandboxNetwork {
	readonly name: string;
	/** Such as `http://vault-proxy:3128`. */
	readonly proxyUrl: string;
	readonly isolation?: "shared" | "per-lease";
	/** With `per-lease`: the proxy's container name or ID. Default: the proxy URL's host. */
	readonly proxyContainer?: string;
	/**
	 * With `per-lease`: an IPv4 range, such as `10.248.0.0/16`, that each lease's network takes a free /28 of. Default:
	 * Docker's own address pools, which hold only about 30 networks on a daemon with default settings.
	 */
	readonly subnetPool?: string;
}

/**
 * Per-lease credentials for the vault proxy. The backend puts the token in the container's `HTTP(S)_PROXY` as
 * `http://sbx:<token>@<proxy>`, so every request the sandbox sends through the proxy carries it (as
 * `Proxy-Authorization: Basic`); the proxy resolves it to the lease's organisation, project, agent and session, which
 * is what the vault decides egress on. The token is not a credential for anything else.
 */
export interface ProxyCredentials {
	/**
	 * The token for the lease, each time its container is created (again after a host restart). `ctx` is the call that
	 * creates it. Letters, digits, `-`, `_`, `.` and `~` only.
	 */
	issue(input: { readonly ctx: CallContext; readonly lease: SandboxLease }): Promise<string>;
	/**
	 * Called before the lease's container and network are removed (`ended`, the janitor, and before every container is
	 * created for it, the first included, so it may come for a lease that has no token). Must be safe to repeat: a
	 * failure fails that call and leaves the lease's resources, so a retry or the janitor revokes it again.
	 */
	revoke(leaseId: string): Promise<void>;
}

export interface DockerContainerBackend extends ContainerBackend {
	/**
	 * Removes containers (and mount volumes) whose `<prefix>.expires-at` label is at or before `now` (default: the
	 * clock's now) and whose lease this backend is neither serving nor creating a container for: the orphan janitor after
	 * a host restart. Returns how many
	 * containers it removed. A renewed lease keeps the expiry it had when its container was created, so a live lease of
	 * this backend is never reaped.
	 */
	reapExpired(now?: number): Promise<number>;
	/** Waits for calls in flight and closes the Docker connections. Containers are left for `ended` or the janitor. */
	close(): Promise<void>;
}

const WORKSPACE = "/workspace";
/** A volume for each command's stdin and output files, outside /workspace so it is never synced or collected. */
const IO_DIR = "/var/harbour";
/**
 * Why maintenance never runs as root on /workspace. The scan, the collection and the re-base all run as the sandbox user
 * (never root), from `/`, with Python in isolated mode (`PYTHON`), so nothing under /workspace is ever imported or run
 * by them. Background processes a command started keep running between calls and can swap a directory for a symlink at
 * any moment, so whatever the host checked before using a path (the scan's view, the re-base's plan) may be stale when
 * it is used; as the sandbox user, following such a symlink reaches only what the user could already reach. The one
 * step that needs more is getting the head's files in: the Docker daemon extracts archives as root and resolves symlinks
 * on the way, so it never extracts into /workspace. It extracts into a fresh directory of STAGE_DIR, a volume owned by
 * root (0755) that the user can read but not write, and so cannot plant a symlink in; APPLY_SCRIPT then copies the
 * files into place as the user, and root removes the stage (in which the user can have changed nothing) afterwards.
 * What the sandbox user cannot read (a file or directory it made unreadable) is skipped by the scan, reported on its
 * stderr, and taken as unchanged.
 */
const STAGE_DIR = "/var/harbour-stage";
/** The working directory of every maintenance exec: never /workspace, whose contents the user controls. */
const MAINTENANCE_CWD = "/";
/**
 * Python for maintenance scripts: `-I` (isolated: neither the working directory nor the user site directory is on
 * `sys.path`, and every PYTHON* variable is ignored) and `-S` (no `site` import), then `-c` and the script.
 */
const PYTHON: readonly string[] = ["python3", "-I", "-S", "-c"];
const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_GID}`;
const ROOT_USER = "0:0";
const CA_PATH = "/etc/harbour/ca.crt";
const DEFAULT_RUNTIME = "runsc-kvm";
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** After a command's deadline, `timeout` sends SIGTERM, then SIGKILL this many seconds later. */
const KILL_AFTER_S = 5;
/** How long past a command's deadline the host waits for the exec before giving up with `aborted`. */
const HOST_GRACE_MS = 30_000;
/** Bytes of arguments per maintenance exec, well under Linux's 128 KiB per argument and ARG_MAX. */
const ARGUMENT_BUDGET = 96 * 1024;
/** Workspace blobs read at once. */
const BLOB_BATCH = 16;
/** File bytes per archive PUT, so a large re-base is not held in memory at once. */
const ARCHIVE_BUDGET = 64 * 1024 * 1024;
/**
 * Directory names that stay local to the container in both directions, as in the spike: dependency trees and git
 * metadata are neither synced in nor collected. A head path with such a segment never reaches the container.
 */
const LOCAL_ONLY: readonly string[] = [".git", "node_modules"];
/**
 * Ownership and modes inside a read-only mount. The mount itself is what refuses writes, with EROFS ("Read-only file
 * system"), which the sandbox contract expects. The files belong to the sandbox user with ordinary modes so that no
 * permission check can refuse first with EACCES (gVisor checks permissions before the mount's writability); the user
 * cannot change them, since chmod and chown on a read-only mount fail too.
 */
const MOUNT_UID = SANDBOX_UID;
const MOUNT_GID = SANDBOX_GID;
const MOUNT_FILE_MODE = 0o644;
const MOUNT_DIR_MODE = 0o755;

/**
 * Change detection: a Python script run as the sandbox user inside the container walks /workspace without following
 * symlinks and prints one JSON array of entries: `["f", path, mode, sha256]` for a regular file, `["d", path, mode]` for
 * a directory, `["l", ...]` for a symlink, `["o", ...]` for any other kind, `["u", path, mode]` for a file it could not
 * read and `["s", path]` for a path it could not list or stat (`""` for /workspace itself). It reports each of the last
 * two on stderr and goes on: the host takes what it knew at and under such a path as unchanged. The host compares the
 * files with what it last synced or saw (path -> digest and mode); the digests are the workspace's own (hex SHA-256 of
 * the content), so a file synced from the head compares equal without the host reading it back.
 *
 * Why this and not the alternatives: a GET of /workspace's archive would move every byte of the working copy over the
 * socket twice per command, where hashing in place moves only digests; `find | xargs sha256sum` needs a pass per
 * attribute and escapes unusual file names, where one Python process reads each file once and emits exact JSON. The
 * image already carries python3 (images/sandbox). Every file is hashed on every scan; a size and mtime cache, as the
 * spike's agent keeps, is the obvious next step for large trees.
 */
const SCAN_SCRIPT = [
	"import hashlib, json, os, stat, sys",
	"skip = {name.encode() for name in json.loads(sys.argv[1])}",
	'root = b"/workspace"',
	"entries = []",
	'stack = [b""]',
	"def report(path, error):",
	'    sys.stderr.write("skipped %s: %s\\n" % (path.decode("utf-8", "replace") or ".", error))',
	"while stack:",
	"    rel = stack.pop()",
	"    try:",
	'        listing = list(os.scandir(root + b"/" + rel if rel else root))',
	"    except OSError as error:",
	"        report(rel, error)",
	'        entries.append(["s", rel.decode("utf-8")])',
	"        continue",
	"    for item in listing:",
	"        if item.name in skip:",
	"            continue",
	'        path = rel + b"/" + item.name if rel else item.name',
	"        try:",
	'            name = path.decode("utf-8")',
	"        except UnicodeDecodeError:",
	"            continue",
	"        try:",
	"            info = item.stat(follow_symlinks=False)",
	"        except OSError as error:",
	"            report(path, error)",
	'            entries.append(["s", name])',
	"            continue",
	"        mode = stat.S_IMODE(info.st_mode)",
	"        if stat.S_ISDIR(info.st_mode):",
	'            entries.append(["d", name, mode])',
	"            stack.append(path)",
	"        elif stat.S_ISLNK(info.st_mode):",
	'            entries.append(["l", name, mode])',
	"        elif not stat.S_ISREG(info.st_mode):",
	'            entries.append(["o", name, mode])',
	"        else:",
	"            digest = hashlib.sha256()",
	"            try:",
	"                fd = os.open(item.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)",
	'                with os.fdopen(fd, "rb") as handle:',
	"                    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):",
	'                        entries.append(["o", name, mode])',
	"                        continue",
	"                    while True:",
	"                        block = handle.read(1 << 20)",
	"                        if not block:",
	"                            break",
	"                        digest.update(block)",
	"            except OSError as error:",
	"                report(path, error)",
	'                entries.append(["u", name, mode])',
	"                continue",
	'            entries.append(["f", name, mode, digest.hexdigest()])',
	'json.dump(entries, sys.stdout, separators=(",", ":"))',
].join("\n");

/**
 * Prints a tar (PAX) of the given regular files under /workspace, each read whole first so a file changing meanwhile
 * cannot corrupt the archive. Run as the sandbox user, so only what the user can read is ever collected.
 */
const COLLECT_SCRIPT = [
	"import io, json, os, stat, sys, tarfile",
	'out = tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT)',
	"for path in json.loads(sys.argv[1]):",
	"    try:",
	'        fd = os.open(os.path.join("/workspace", path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)',
	"    except OSError:",
	"        continue",
	'    with os.fdopen(fd, "rb") as handle:',
	"        info = os.fstat(handle.fileno())",
	"        if not stat.S_ISREG(info.st_mode):",
	"            continue",
	"        try:",
	"            data = handle.read()",
	"        except OSError:",
	"            continue",
	"    member = tarfile.TarInfo(path)",
	"    member.size = len(data)",
	"    member.mode = stat.S_IMODE(info.st_mode)",
	"    member.mtime = int(info.st_mtime)",
	"    out.addfile(member, io.BytesIO(data))",
	"out.close()",
].join("\n");

/**
 * Applies a re-base inside the container, as the sandbox user (see `STAGE_DIR`): removes paths, creates directories,
 * and copies each staged file into place with its mode (replacing whatever is there; the final path component is opened
 * with O_NOFOLLOW, so it never writes through a symlink there, but a background job can still swap a parent directory
 * between planning and writing, which only redirects the write to somewhere user 1000 could already write).
 * Its argument is the stage directory, holding `plan.json` (`{"remove": [path, ...], "dirs": [path, ...], "writes":
 * [[path, staged name, mode], ...]}`) and the staged files. A path it cannot apply (one the user made unwritable, say)
 * is reported on stderr and in the JSON array of paths it prints, and the rest goes on.
 */
const APPLY_SCRIPT = [
	"import json, os, shutil, stat, sys",
	"stage = sys.argv[1]",
	'with open(os.path.join(stage, "plan.json"), "rb") as handle:',
	"    plan = json.load(handle)",
	'root = "/workspace"',
	"failed = []",
	"def report(path, error):",
	"    failed.append(path)",
	'    sys.stderr.write("could not apply %s: %s\\n" % (path, error))',
	'for path in plan["remove"]:',
	"    target = os.path.join(root, path)",
	"    try:",
	"        if stat.S_ISDIR(os.lstat(target).st_mode):",
	"            shutil.rmtree(target)",
	"        else:",
	"            os.unlink(target)",
	"    except FileNotFoundError:",
	"        pass",
	"    except OSError as error:",
	"        report(path, error)",
	'for path in plan["dirs"]:',
	"    try:",
	"        os.makedirs(os.path.join(root, path), 0o755, exist_ok=True)",
	"    except OSError as error:",
	"        report(path, error)",
	'for path, name, mode in plan["writes"]:',
	"    target = os.path.join(root, path)",
	"    try:",
	"        os.makedirs(os.path.dirname(target), 0o755, exist_ok=True)",
	"        try:",
	"            os.unlink(target)",
	"        except FileNotFoundError:",
	"            pass",
	"        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)",
	'        with os.fdopen(fd, "wb") as out, open(os.path.join(stage, name), "rb") as source:',
	"            shutil.copyfileobj(source, out, 1 << 20)",
	"            os.fchmod(out.fileno(), mode)",
	"    except OSError as error:",
	"        report(path, error)",
	"json.dump(failed, sys.stdout)",
].join("\n");

/**
 * Kills every process of the sandbox user: `kill -1` signals every process the caller may signal except itself and the
 * container's init (PID 1, the keep-alive loop, which just starts another sleep). Twice, for a child forked while the
 * first went round.
 */
const KILL_ALL_SCRIPT = "kill -KILL -1 2>/dev/null; kill -KILL -1 2>/dev/null; true";

/**
 * Wraps every command: enters its working directory, feeds it its stdin file (or /dev/null), sends its output to files
 * in IO_DIR and prints at most `limit` bytes of each once it exits. Output goes through files so that a background
 * process the command started, still holding its stdout, cannot keep the exec (and the caller) waiting.
 * Arguments: cwd, stdin file or "", output path prefix, limit, then the command (already under `timeout`).
 */
const WRAPPER_SCRIPT = [
	'cd -- "$1" || exit 1',
	"in=$2 out=$3 limit=$4",
	"shift 4",
	'if [ -n "$in" ]; then "$@" <"$in" >"$out.out" 2>"$out.err"; else "$@" </dev/null >"$out.out" 2>"$out.err"; fi',
	"status=$?",
	'head -c "$limit" "$out.out"',
	'head -c "$limit" "$out.err" >&2',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
	'rm -f -- "$out.out" "$out.err" ${in:+"$in"}',
	'exit "$status"',
].join("\n");

/** PID 1: sleeps, reaps orphans (the shell waits on its children) and exits on SIGTERM. */
const KEEPALIVE_SCRIPT = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";

interface FileState {
	readonly digest: string;
	readonly mode: number;
}

type Kind = "f" | "d" | "l" | "o";

interface DirtyEntry {
	readonly op: "put" | "delete";
	readonly stamp: number;
}

/** What the host knows of one lease's container. Lost with the process, which is safe: see `#create`. */
interface LeaseState {
	readonly leaseId: string;
	readonly workspaceId: string;
	readonly containerId: string;
	/** The workspace version the working copy is based on; null before the first re-base. */
	version: number | null;
	/** Each tracked file as of the last scan or re-base: what a later scan compares with. */
	index: Map<string, FileState>;
	/** What each path under /workspace is, as of the last scan, updated by re-bases. */
	kinds: Map<string, Kind>;
	/** Paths the container changed and that are not committed yet, each with the scan that last saw it change. */
	dirty: Map<string, DirtyEntry>;
}

/** Per lease, kept apart from the state so it outlives it: once set, the lease runs no more commands. */
type Fence = "closing" | "ended";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a proxy token may hold: it goes into a URL's userinfo unescaped. */
const PROXY_TOKEN = /^[A-Za-z0-9._~-]+$/;
/** The user name in the proxy URL; the token is the password, as the vault proxy reads it. */
const PROXY_USER = "sbx";
/** Each per-lease network is a /28 of the subnet pool: the gateway, the proxy and the sandbox, with room to spare. */
const LEASE_SUBNET_PREFIX = 28;
const LEASE_SUBNET_SIZE = 2 ** (32 - LEASE_SUBNET_PREFIX);
/** Random /28s tried before giving up on a crowded pool. */
const SUBNET_ATTEMPTS = 8;

export function createDockerContainerBackend(options: DockerContainerBackendOptions): DockerContainerBackend {
	return new DockerContainerTier(options);
}

class DockerContainerTier implements DockerContainerBackend {
	readonly #workspaces: StoredWorkspaces;
	readonly #docker: DockerClient;
	readonly #image: string;
	readonly #runtime: string;
	readonly #memoryBytes: number | undefined;
	readonly #nanoCpus: number | undefined;
	readonly #network: SandboxNetwork | undefined;
	readonly #subnets: { readonly base: number; readonly count: number } | undefined;
	readonly #credentials: ProxyCredentials | undefined;
	readonly #prefix: string;
	readonly #clock: Clock;
	readonly #execTimeoutMs: number;
	readonly #maxOutputBytes: number;
	readonly #localOnly: readonly string[];
	readonly #states = new Map<string, LeaseState>();
	/** Leases whose container is being created: served, though not in `#states` yet, so the janitor leaves them alone. */
	readonly #creating = new Set<string>();
	readonly #fences = new Map<string, Fence>();
	readonly #queues = new Map<string, Promise<void>>();
	/** Counts scans across all leases; `pending` hands it out and `committed` takes it back. */
	#stamp = 0;
	#closed = false;
	#ca: { readonly pem: Uint8Array; readonly at: number } | undefined;

	constructor(options: DockerContainerBackendOptions) {
		this.#workspaces = options.workspaces;
		this.#docker = new DockerClient(options.socketPath === undefined ? {} : { socketPath: options.socketPath });
		this.#image = options.image;
		this.#runtime = options.runtime ?? DEFAULT_RUNTIME;
		this.#memoryBytes = options.memoryBytes;
		this.#nanoCpus = options.nanoCpus;
		this.#network = options.network;
		this.#subnets = checkNetwork(options.network);
		this.#credentials = options.proxyCredentials;
		if (this.#credentials !== undefined && this.#network === undefined) {
			throw new KantelError(
				"invalid",
				"proxyCredentials needs a network: without one there is no proxy to send them to",
			);
		}
		this.#prefix = options.labelPrefix ?? "harbour";
		this.#clock = options.clock ?? systemClock;
		this.#execTimeoutMs = positive(options.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS, "execTimeoutMs");
		this.#maxOutputBytes = positive(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
		this.#localOnly = checkLocalOnly(options.localOnly ?? LOCAL_ONLY);
	}

	// ---- ContainerBackend ----------------------------------------------------------------------------------------------

	async exec(input: BackendExec): Promise<BackendOutput> {
		const { ctx, lease, record, request } = input;
		this.#checkOpen();
		this.#checkFence(lease.id);
		return this.#serial(lease.id, async () => {
			// Checked again: a release may have fenced the lease while this call waited its turn.
			this.#checkFence(lease.id);
			const timings: Record<string, number> = {};
			let at = performance.now();
			const step = (phase: string) => {
				const now = performance.now();
				timings[phase] = round(now - at);
				at = now;
			};
			let state = this.#states.get(lease.id);
			if (state === undefined) {
				state = await this.#create(ctx, lease, record);
				step("container.create");
			}
			const current = state;
			await this.#guard(current, () => this.#rebase(ctx, current, record.head));
			step("container.sync");
			const output = await this.#guard(current, () => this.#command(current, request));
			step("container.exec");
			await this.#guard(current, () => this.#scan(current));
			step("container.scan");
			return { ...output, timings };
		});
	}

	async pending(
		input: Omit<BackendExec, "request">,
		options: { readonly final?: boolean } = {},
	): Promise<PendingChanges> {
		const { ctx, lease, record } = input;
		this.#checkOpen();
		// Fenced at once, before waiting for the lease's turn: a command that arrives from now on is refused.
		if (options.final === true && !this.#fences.has(lease.id)) this.#fences.set(lease.id, "closing");
		return this.#serial(lease.id, async () => {
			const state = this.#states.get(lease.id);
			if (state === undefined) return { changes: [], stamp: this.#stamp };
			return this.#guard(state, async () => {
				// The final snapshot is final only once nothing can change the working copy after it: every process the
				// sandbox user still runs (background jobs of earlier commands) is killed first.
				if (options.final === true) await this.#killAll(state);
				if (!(await this.#rebase(ctx, state, record.head))) await this.#scan(state);
				const stamp = this.#stamp;
				const puts: string[] = [];
				const changes: ModedChange[] = [];
				for (const [path, entry] of state.dirty) {
					if (entry.op === "put") puts.push(path);
					else changes.push({ op: "delete", path });
				}
				const collected = await this.#collect(state, puts);
				let later: number | undefined;
				for (const path of puts) {
					const file = collected.get(path);
					if (file !== undefined) {
						changes.push({ op: "put", path, content: file.data, mode: file.mode & 0o777 });
						continue;
					}
					// Unreadable to the sandbox user, or gone since the scan: not in this set, so `committed` with this stamp
					// must not clear it. The next scan settles what it is.
					later ??= ++this.#stamp;
					state.dirty.set(path, { op: "put", stamp: later });
				}
				return { changes, stamp };
			});
		});
	}

	async committed(lease: SandboxLease, version: number, stamp: number): Promise<void> {
		return this.#serial(lease.id, async () => {
			const state = this.#states.get(lease.id);
			if (state === undefined) return;
			for (const [path, entry] of [...state.dirty]) if (entry.stamp <= stamp) state.dirty.delete(path);
			// The committed version holds the working copy's changes up to `stamp` on top of the head it was re-based on.
			// A working copy already re-based past it stays where it is.
			if (state.version !== null) state.version = Math.max(state.version, version);
		});
	}

	async ended(lease: SandboxLease, _options: { readonly discard: boolean }): Promise<void> {
		// The container goes either way: a released lease's changes were committed before this call, an expired lease's
		// are discarded.
		this.#fences.set(lease.id, "ended");
		return this.#serial(lease.id, async () => {
			this.#states.delete(lease.id);
			await this.#removeLease(lease.id);
		});
	}

	// ---- janitor and shutdown ----------------------------------------------------------------------------------------

	async reapExpired(now: number = this.#clock.now()): Promise<number> {
		this.#checkOpen();
		const leaseKey = this.#label("lease");
		const expiryKey = this.#label("expires-at");
		const live = (leaseId: string) => this.#states.has(leaseId) || this.#creating.has(leaseId);
		type Found = { containers: string[]; networks: string[]; volumes: string[] };
		const byLease = new Map<string, Found>();
		const unleased: Found = { containers: [], networks: [], volumes: [] };
		const collect = (labels: Readonly<Record<string, string>> | null | undefined, kind: keyof Found, id: string) => {
			const expiresAt = Number(labels?.[expiryKey]);
			if (!Number.isFinite(expiresAt) || expiresAt > now) return;
			const leaseId = labels?.[leaseKey];
			if (leaseId !== undefined && live(leaseId)) return;
			let found = unleased;
			if (leaseId !== undefined) {
				found = byLease.get(leaseId) ?? { containers: [], networks: [], volumes: [] };
				byLease.set(leaseId, found);
			}
			found[kind].push(id);
		};
		for (const item of await this.#docker.listContainers([expiryKey])) collect(item.Labels, "containers", item.Id);
		for (const item of await this.#docker.listNetworks([expiryKey])) collect(item.Labels, "networks", item.Id);
		for (const item of await this.#docker.listVolumes([expiryKey])) collect(item.Labels, "volumes", item.Name);
		const remove = async (found: Found): Promise<number> => {
			let removed = 0;
			for (const id of found.containers) if (await this.#docker.removeContainer(id)) removed++;
			for (const id of found.networks) await this.#removeNetwork(id);
			for (const name of found.volumes) await this.#docker.removeVolume(name);
			return removed;
		};
		let removed = await remove(unleased);
		for (const [leaseId, found] of byLease) {
			// In the lease's turn, as its container's creation is, and checked again there: a command may have started a
			// new container for it since the listing, and its token must not be revoked.
			removed += await this.#serial(leaseId, async () => {
				if (live(leaseId)) return 0;
				// Credentials first: a revocation that fails leaves the lease's resources, and so the lease, for the next pass.
				await this.#credentials?.revoke(leaseId);
				return remove(found);
			});
		}
		return removed;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.allSettled([...this.#queues.values()]);
		this.#docker.close();
	}

	// ---- lifecycle -----------------------------------------------------------------------------------------------------

	/**
	 * Creates and starts the lease's container. Anything an earlier process left for this lease is removed first: its
	 * working copy cannot be trusted without the state that went with it, so the lease starts again from the head (its
	 * uncommitted changes are lost, as when a container dies).
	 */
	async #create(ctx: CallContext, lease: SandboxLease, record: WorkspaceRecord): Promise<LeaseState> {
		// Served from before its first labelled resource exists until it is in `#states` (or creation failed), so the
		// janitor never removes what is being created, whatever the expiry on its labels.
		this.#creating.add(lease.id);
		try {
			return await this.#createContainer(ctx, lease, record);
		} finally {
			this.#creating.delete(lease.id);
		}
	}

	async #createContainer(ctx: CallContext, lease: SandboxLease, record: WorkspaceRecord): Promise<LeaseState> {
		await this.#removeLease(lease.id);
		const labels: Record<string, string> = {
			[this.#label("lease")]: lease.id,
			[this.#label("session")]: lease.sessionId,
			[this.#label("workspace")]: lease.workspaceId,
			[this.#label("expires-at")]: String(lease.expiresAt),
		};
		try {
			const mounts = await this.#stageMounts(ctx, record, labels);
			const network = await this.#networkConfig(ctx, lease, labels);
			const id = await this.#docker.createContainer({
				Image: this.#image,
				Entrypoint: ["/bin/sh", "-c", KEEPALIVE_SCRIPT],
				User: SANDBOX_USER,
				WorkingDir: WORKSPACE,
				Env: [`HOME=${WORKSPACE}`, ...network.env],
				Labels: { ...labels, [this.#label("role")]: "sandbox" },
				HostConfig: {
					Runtime: this.#runtime,
					NetworkMode: network.mode,
					...(network.extraHosts.length === 0 ? {} : { ExtraHosts: network.extraHosts }),
					// NoCopy: the volumes start empty rather than with whatever the image has at those paths, so the working
					// copy is exactly the workspace and nothing of the image's is mistaken for the container's own change.
					Mounts: [
						{ Type: "volume", Target: WORKSPACE, VolumeOptions: { NoCopy: true } },
						{ Type: "volume", Target: IO_DIR, VolumeOptions: { NoCopy: true } },
						{ Type: "volume", Target: STAGE_DIR, VolumeOptions: { NoCopy: true } },
						...mounts,
					],
					...(this.#memoryBytes === undefined ? {} : { Memory: this.#memoryBytes }),
					...(this.#nanoCpus === undefined ? {} : { NanoCpus: this.#nanoCpus }),
					SecurityOpt: ["no-new-privileges"],
					CapDrop: ["NET_RAW", "MKNOD", "AUDIT_WRITE"],
				},
			});
			// Before start, so the volumes' roots belong to the sandbox user (the stage's to root) and the CA is in the
			// image's layer.
			const setup: TarEntry[] = [
				{ type: "dir", path: WORKSPACE.slice(1), mode: 0o755 },
				{ type: "dir", path: IO_DIR.slice(1), mode: 0o700 },
				{ type: "dir", path: STAGE_DIR.slice(1), mode: 0o755, uid: 0, gid: 0 },
			];
			if (network.ca !== undefined) {
				setup.push(
					{ type: "dir", path: "etc/harbour", mode: 0o755, uid: 0, gid: 0 },
					{ type: "file", path: CA_PATH.slice(1), mode: 0o644, data: network.ca, uid: 0, gid: 0 },
				);
			}
			await this.#docker.putArchive(id, "/", writeTar(setup));
			await this.#docker.startContainer(id);
			const state: LeaseState = {
				leaseId: lease.id,
				workspaceId: lease.workspaceId,
				containerId: id,
				version: null,
				index: new Map(),
				kinds: new Map(),
				dirty: new Map(),
			};
			this.#states.set(lease.id, state);
			return state;
		} catch (error) {
			await this.#removeLease(lease.id).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Revokes the lease's proxy credentials, then removes every container, then every network and volume, labelled with
	 * it. Credentials first, so a revocation that fails leaves the lease's resources for a retry or the janitor rather
	 * than a live token with nothing left to find it by. Safe to repeat.
	 */
	async #removeLease(leaseId: string): Promise<void> {
		const label = `${this.#label("lease")}=${leaseId}`;
		await this.#credentials?.revoke(leaseId);
		for (const container of await this.#docker.listContainers([label])) {
			await this.#docker.removeContainer(container.Id);
		}
		if (this.#network?.isolation === "per-lease") {
			for (const network of await this.#docker.listNetworks([label])) await this.#removeNetwork(network.Id);
		}
		for (const volume of await this.#docker.listVolumes([label])) await this.#docker.removeVolume(volume.Name);
	}

	/** Disconnects the proxy from a lease's network, which then has no members left, and removes it. */
	async #removeNetwork(id: string): Promise<void> {
		if (this.#network !== undefined) await this.#docker.disconnectNetwork(id, this.#proxyContainer(this.#network));
		await this.#docker.removeNetwork(id);
	}

	#proxyContainer(network: SandboxNetwork): string {
		return network.proxyContainer ?? new URL(network.proxyUrl).hostname;
	}

	/**
	 * A new internal network for one lease, labelled as its other resources are, with the proxy connected to it under
	 * the proxy URL's host name. With a subnet pool, it takes a random free /28 of it; Docker refuses one that overlaps
	 * a network it has, and another is tried.
	 */
	async #createLeaseNetwork(
		network: SandboxNetwork,
		labels: Readonly<Record<string, string>>,
	): Promise<{ readonly id: string; readonly proxyAddress: string }> {
		const networkLabels = { ...labels, [this.#label("role")]: "network" };
		const name = () => `${network.name}-${randomHex(6)}`;
		let id: string | undefined;
		if (this.#subnets === undefined) {
			id = await this.#docker.createInternalNetwork(name(), networkLabels);
		} else {
			for (let attempt = 1; id === undefined; attempt++) {
				const index = Math.floor(Math.random() * this.#subnets.count);
				const subnet = `${ipv4(this.#subnets.base + index * LEASE_SUBNET_SIZE)}/${LEASE_SUBNET_PREFIX}`;
				try {
					id = await this.#docker.createInternalNetwork(name(), networkLabels, subnet);
				} catch (error) {
					if (attempt >= SUBNET_ATTEMPTS) throw error;
				}
			}
		}
		const host = new URL(network.proxyUrl).hostname;
		await this.#docker.connectNetwork(id, this.#proxyContainer(network), [host]);
		const inspected = await this.#docker.inspectNetwork(id);
		const proxyName = this.#proxyContainer(network);
		const proxy = Object.entries(inspected.Containers ?? {}).find(
			([containerId, container]) => container.Name === proxyName || containerId.startsWith(proxyName),
		)?.[1];
		const proxyAddress = proxy?.IPv4Address.split("/")[0];
		if (proxyAddress === undefined || proxyAddress === "") {
			throw new KantelError("unavailable", `the vault proxy ${proxyName} did not join the lease's network`);
		}
		return { id, proxyAddress };
	}

	/**
	 * Copies each mount's files into a named volume and returns the read-only mounts of them. A volume can only be
	 * written through a container, and the archive API refuses a read-only mount, so a never-started staging container
	 * holds the volumes writable for the copy and is removed straight after. Mounts are pinned when the container is
	 * created: a remount during the lease is not seen until the next lease.
	 */
	async #stageMounts(
		ctx: CallContext,
		record: WorkspaceRecord,
		labels: Readonly<Record<string, string>>,
	): Promise<object[]> {
		if (record.mounts.length === 0) return [];
		for (const mount of record.mounts) {
			for (const reserved of [WORKSPACE, IO_DIR, STAGE_DIR]) {
				if (overlaps(mount.path, reserved)) {
					throw new KantelError("invalid", `mount ${mount.path} overlaps ${reserved} in the container`, {
						path: mount.path,
					});
				}
			}
		}
		const entries: TarEntry[] = [];
		for (const mount of record.mounts) entries.push(...(await this.#mountEntries(ctx, record, mount)));
		const volumes: { readonly name: string; readonly mount: Mount }[] = [];
		for (const mount of record.mounts) {
			const name = await this.#docker.createVolume({
				...labels,
				[this.#label("role")]: "mount",
				[this.#label("mount")]: mount.path,
			});
			volumes.push({ name, mount });
		}
		const stager = await this.#docker.createContainer({
			Image: this.#image,
			Entrypoint: ["true"],
			Labels: { ...labels, [this.#label("role")]: "stage" },
			HostConfig: {
				NetworkMode: "none",
				Mounts: volumes.map(({ name, mount }) => ({
					Type: "volume",
					Source: name,
					Target: mount.path,
					VolumeOptions: { NoCopy: true },
				})),
			},
		});
		try {
			await this.#docker.putArchive(stager, "/", writeTar(entries));
		} finally {
			await this.#docker.removeContainer(stager);
		}
		return volumes.map(({ name, mount }) => ({
			Type: "volume",
			Source: name,
			Target: mount.path,
			ReadOnly: true,
			VolumeOptions: { NoCopy: true },
		}));
	}

	async #mountEntries(ctx: CallContext, record: WorkspaceRecord, mount: Mount): Promise<TarEntry[]> {
		const owner = { uid: MOUNT_UID, gid: MOUNT_GID };
		const root = mount.path.slice(1);
		const entries: TarEntry[] = [{ type: "dir", path: root, mode: MOUNT_DIR_MODE, ...owner }];
		const listed = await listAll(this.#workspaces, ctx, record.id, { path: mount.path });
		const directories = listed
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path.slice(1))
			.sort();
		for (const path of directories) entries.push({ type: "dir", path, mode: MOUNT_DIR_MODE, ...owner });
		const files = listed.filter((entry) => entry.kind === "file");
		const contents = await inBatches(files, async (entry) => {
			const { content } = await this.#workspaces.read(ctx, record.id, entry.path);
			return content;
		});
		files.forEach((entry, i) => {
			entries.push({ type: "file", path: entry.path.slice(1), mode: MOUNT_FILE_MODE, data: contents[i]!, ...owner });
		});
		return entries;
	}

	async #networkConfig(
		ctx: CallContext,
		lease: SandboxLease,
		labels: Readonly<Record<string, string>>,
	): Promise<{
		readonly mode: string;
		readonly extraHosts: string[];
		readonly env: string[];
		readonly ca?: Uint8Array;
	}> {
		const network = this.#network;
		if (network === undefined) return { mode: "none", extraHosts: [], env: [] };
		const url = new URL(network.proxyUrl);
		const host = url.hostname;
		const extraHosts: string[] = [];
		let mode = network.name;
		// The CA first: it needs no lease resources, so a proxy that is down fails the lease before any are made.
		const ca = await this.#vaultCa(network.proxyUrl);
		if (network.isolation === "per-lease") {
			const created = await this.#createLeaseNetwork(network, labels);
			mode = created.id;
			extraHosts.push(`${host}:${created.proxyAddress}`);
		} else if (!isIpLiteral(host)) {
			// gVisor cannot reach Docker's embedded DNS on a user-defined network, so the proxy's address on this network
			// goes into /etc/hosts.
			const inspected = await this.#docker.inspectNetwork(network.name);
			const proxy = Object.values(inspected.Containers ?? {}).find((container) => container.Name === host);
			const address = proxy?.IPv4Address.split("/")[0];
			if (address === undefined || address === "") {
				throw new KantelError("unavailable", `the vault proxy ${host} is not on network ${network.name}`);
			}
			extraHosts.push(`${host}:${address}`);
		}
		let proxy = network.proxyUrl;
		if (this.#credentials !== undefined) {
			// A labelled marker first, so that whatever fails after the token is issued, the janitor still finds the lease
			// and revokes it: on a shared network, with no mounts, the lease may have no other resource yet.
			await this.#docker.createVolume({ ...labels, [this.#label("role")]: "credentials" });
			const token = await this.#credentials.issue({ ctx, lease });
			if (!PROXY_TOKEN.test(token)) {
				throw new KantelError("invalid", "a proxy token may hold only letters, digits, '-', '_', '.' and '~'");
			}
			const withToken = new URL(network.proxyUrl);
			withToken.username = PROXY_USER;
			withToken.password = token;
			proxy = withToken.href.replace(/\/$/, "");
		}
		return {
			mode,
			extraHosts,
			env: [
				`HTTP_PROXY=${proxy}`,
				`HTTPS_PROXY=${proxy}`,
				`http_proxy=${proxy}`,
				`https_proxy=${proxy}`,
				"NO_PROXY=",
				...["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE"].map(
					(name) => `${name}=${CA_PATH}`,
				),
			],
			ca,
		};
	}

	/** The vault's CA: it intercepts the sandbox's HTTPS, so it is the only CA a sandbox needs. Cached for a minute. */
	async #vaultCa(proxyUrl: string): Promise<Uint8Array> {
		if (this.#ca !== undefined && Date.now() - this.#ca.at < 60_000) return this.#ca.pem;
		let response: Response;
		try {
			response = await fetch(new URL("/ca.crt", proxyUrl), { signal: AbortSignal.timeout(5000) });
		} catch (error) {
			throw new KantelError("unavailable", `the vault CA could not be fetched: ${String(error)}`);
		}
		if (!response.ok) throw new KantelError("unavailable", `the vault CA could not be fetched: ${response.status}`);
		this.#ca = { pem: new Uint8Array(await response.arrayBuffer()), at: Date.now() };
		return this.#ca.pem;
	}

	// ---- re-base, scan, collect --------------------------------------------------------------------------------------

	/**
	 * Re-bases the working copy on `head`: applies the diff between the version it holds and `head`, leaving alone every
	 * path the container has changed (or put a file under), and never writing through a symlink. Scans first when there
	 * is anything to apply, so a change the container made since its last scan counts as its own. Returns whether it
	 * scanned.
	 */
	async #rebase(ctx: CallContext, state: LeaseState, head: number): Promise<boolean> {
		// A record read before this lease's own commit landed names an older head: the working copy is already past it.
		if (state.version !== null && state.version >= head) return false;
		const target = await this.#files(ctx, state.workspaceId, head);
		const source =
			state.version === null ? new Map<string, FileState>() : await this.#files(ctx, state.workspaceId, state.version);
		const puts: [string, FileState][] = [];
		for (const [path, file] of target) {
			const before = source.get(path);
			if (before === undefined || before.digest !== file.digest || before.mode !== file.mode) puts.push([path, file]);
		}
		const removes = [...source.keys()].filter((path) => !target.has(path));
		if (puts.length === 0 && removes.length === 0) {
			state.version = head;
			return false;
		}
		await this.#scan(state);
		const { kinds, index } = state;
		// The index before planning, for a removal the container then refuses.
		const previous = new Map(index);
		const remove = new Set<string>();
		const directories = new Set<string>();
		const writes: [string, FileState][] = [];
		for (const path of removes) {
			if (this.#containerOwns(state, path) || underSymlink(kinds, path)) continue;
			index.delete(path);
			const kind = kinds.get(path);
			// Already gone, or a directory the container made there: its own, kept.
			if (kind === undefined || kind === "d") continue;
			remove.add(path);
			kinds.delete(path);
		}
		for (const [path, file] of puts) {
			if (this.#containerOwns(state, path) || !this.#prepareParents(state, path, remove, directories)) continue;
			const kind = kinds.get(path);
			if (kind !== undefined && kind !== "f") {
				// A directory (with nothing of the container's under it) or a symlink where the head has a file: replaced,
				// never written through.
				remove.add(path);
				dropSubtree(kinds, path);
			}
			kinds.set(path, "f");
			writes.push([path, file]);
		}
		const failed = await this.#apply(ctx, state, head, [...remove], [...directories].sort(), writes);
		// A path the sandbox user could not change (it made it unwritable) keeps what the index knew of it, so the next
		// scan finds it unchanged: the working copy misses that part of the head, and never reverts it in a commit.
		for (const [path, file] of writes) if (!failed.has(path)) index.set(path, file);
		for (const path of remove) {
			const known = previous.get(path);
			if (failed.has(path) && known !== undefined) index.set(path, known);
		}
		state.version = head;
		return true;
	}

	/**
	 * Makes `path`'s parents directories in the plan. False, planning nothing more, when a parent is a symlink or a file
	 * the container has changed: the container's state wins.
	 */
	#prepareParents(state: LeaseState, path: string, remove: Set<string>, directories: Set<string>): boolean {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join("/");
			const kind = state.kinds.get(parent);
			if (kind === "d") continue;
			if (kind === "l" || (kind !== undefined && state.dirty.has(parent))) return false;
			if (kind !== undefined) {
				// A stale file (or other non-directory) where the head now has a directory.
				remove.add(parent);
				state.index.delete(parent);
			}
			state.kinds.set(parent, "d");
			directories.add(parent);
		}
		return true;
	}

	/** True when the container has an uncommitted change at `path`, or has put a file under it. */
	#containerOwns(state: LeaseState, path: string): boolean {
		if (state.dirty.has(path)) return true;
		const prefix = `${path}/`;
		for (const [candidate, entry] of state.dirty) if (entry.op === "put" && candidate.startsWith(prefix)) return true;
		return false;
	}

	/** The head's files at `version`, without local-only paths, as path -> digest and mode. */
	async #files(ctx: CallContext, workspaceId: string, version: number): Promise<Map<string, FileState>> {
		const files = new Map<string, FileState>();
		for (const entry of await listAll(this.#workspaces, ctx, workspaceId, { version })) {
			if (entry.kind !== "file" || entry.digest === undefined || isLocalOnly(entry.path, this.#localOnly)) continue;
			files.set(entry.path, { digest: entry.digest, mode: (entry.mode ?? 0o644) & 0o777 });
		}
		return files;
	}

	/**
	 * Removes `remove`, creates `directories` and writes `writes` (from the head at `version`), all as the sandbox user:
	 * the files go into a stage of STAGE_DIR (see there) with a plan, and APPLY_SCRIPT moves them into place. In runs of
	 * up to ARCHIVE_BUDGET file bytes, the first carrying the removals and directories. Returns the paths the container
	 * could not change.
	 */
	async #apply(
		ctx: CallContext,
		state: LeaseState,
		version: number,
		remove: readonly string[],
		directories: readonly string[],
		writes: readonly [string, FileState][],
	): Promise<Set<string>> {
		const failed = new Set<string>();
		const owner = { uid: 0, gid: 0 };
		let stage = crypto.randomUUID();
		let plan: { remove: string[]; dirs: string[]; writes: [string, string, number][] } = {
			remove: [...remove],
			dirs: [...directories],
			writes: [],
		};
		let files: TarEntry[] = [];
		let bytes = 0;
		const flush = async () => {
			if (plan.remove.length === 0 && plan.dirs.length === 0 && plan.writes.length === 0) return;
			// Root-owned and world-readable, in a directory only root can write: the sandbox user reads the files, and
			// APPLY_SCRIPT gives each its mode as it copies it.
			const archive = writeTar([
				{ type: "dir", path: stage, mode: 0o755, ...owner },
				{
					type: "file",
					path: `${stage}/plan.json`,
					mode: 0o644,
					data: encoder.encode(JSON.stringify(plan)),
					...owner,
				},
				...files,
			]);
			const directory = `${STAGE_DIR}/${stage}`;
			let result: ExecOutput;
			try {
				await this.#docker.putArchive(state.containerId, STAGE_DIR, archive);
				result = await this.#docker.exec(state.containerId, {
					cmd: [...PYTHON, APPLY_SCRIPT, directory],
					user: SANDBOX_USER,
					workingDir: MAINTENANCE_CWD,
					timeoutMs: this.#execTimeoutMs,
				});
			} finally {
				// As root, safely: the user can write nothing in STAGE_DIR. A stage left behind (the container gone, say) is
				// outside /workspace, never synced, and goes with the container.
				await this.#docker
					.exec(state.containerId, {
						cmd: ["rm", "-rf", "--", directory],
						user: ROOT_USER,
						workingDir: MAINTENANCE_CWD,
						timeoutMs: this.#execTimeoutMs,
					})
					.catch(() => undefined);
			}
			if (result.exitCode !== 0) {
				throw new KantelError(
					"unavailable",
					`re-base could not apply the head's files (${result.exitCode}): ${decoder.decode(result.stderr).slice(0, 500)}`,
				);
			}
			let refused: unknown;
			try {
				refused = JSON.parse(decoder.decode(result.stdout));
			} catch {
				throw new KantelError("unavailable", "applying the re-base returned malformed output");
			}
			if (Array.isArray(refused)) for (const path of refused) if (typeof path === "string") failed.add(path);
			stage = crypto.randomUUID();
			plan = { remove: [], dirs: [], writes: [] };
			files = [];
			bytes = 0;
		};
		for (let start = 0; start < writes.length; start += BLOB_BATCH) {
			const batch = writes.slice(start, start + BLOB_BATCH);
			const bodies = await Promise.all(
				batch.map(([, file]) => this.#workspaces.readBlob(ctx, state.workspaceId, file.digest, { version })),
			);
			batch.forEach(([path, file], i) => {
				const data = bodies[i]!;
				const name = String(plan.writes.length);
				plan.writes.push([path, name, file.mode]);
				files.push({ type: "file", path: `${stage}/${name}`, mode: 0o644, data, ...owner });
				bytes += data.length;
			});
			if (bytes >= ARCHIVE_BUDGET) await flush();
		}
		await flush();
		return failed;
	}

	/**
	 * Kills every process the sandbox user runs in the container (see KILL_ALL_SCRIPT), as that user, so it can reach
	 * nothing else.
	 */
	async #killAll(state: LeaseState): Promise<void> {
		await this.#docker.exec(state.containerId, {
			cmd: ["sh", "-c", KILL_ALL_SCRIPT],
			user: SANDBOX_USER,
			workingDir: MAINTENANCE_CWD,
			timeoutMs: this.#execTimeoutMs,
		});
	}

	/** Scans /workspace (see SCAN_SCRIPT) and marks what changed since the last scan or re-base as dirty. */
	async #scan(state: LeaseState): Promise<void> {
		const result = await this.#docker.exec(state.containerId, {
			cmd: [...PYTHON, SCAN_SCRIPT, JSON.stringify(this.#localOnly)],
			user: SANDBOX_USER,
			workingDir: MAINTENANCE_CWD,
			timeoutMs: this.#execTimeoutMs,
		});
		if (result.exitCode !== 0) {
			throw new KantelError(
				"unavailable",
				`scanning the working copy failed (${result.exitCode}): ${decoder.decode(result.stderr).slice(0, 500)}`,
			);
		}
		let listed: unknown;
		try {
			listed = JSON.parse(decoder.decode(result.stdout));
		} catch {
			throw new KantelError("unavailable", "scanning the working copy returned malformed output");
		}
		if (!Array.isArray(listed)) throw new KantelError("unavailable", "scanning the working copy returned no list");
		const stamp = ++this.#stamp;
		const seen = new Map<string, FileState>();
		const kinds = new Map<string, Kind>();
		const skipped: string[] = [];
		for (const item of listed as unknown[]) {
			if (!Array.isArray(item)) continue;
			const [kind, path, mode, digest] = item as [unknown, unknown, unknown, unknown];
			if (kind === "s" && typeof path === "string" && (path === "" || trackable(path))) {
				skipped.push(path);
				continue;
			}
			if (typeof path !== "string" || typeof mode !== "number" || !trackable(path)) continue;
			if (kind === "f" && typeof digest === "string") {
				kinds.set(path, "f");
				seen.set(path, { digest, mode: mode & 0o777 });
			} else if (kind === "u") {
				// Could not be read: unchanged as far as anyone can tell.
				kinds.set(path, "f");
				const known = state.index.get(path);
				if (known !== undefined) seen.set(path, known);
			} else if (kind === "d" || kind === "l" || kind === "o") {
				kinds.set(path, kind);
			}
		}
		// Could not be listed or looked at (the sandbox user made it unreadable): everything at and under it is unchanged
		// as far as anyone can tell, so it keeps what was known of it.
		for (const prefix of skipped) {
			const within = (candidate: string) => prefix === "" || candidate === prefix || candidate.startsWith(`${prefix}/`);
			for (const [path, file] of state.index) if (within(path) && !seen.has(path)) seen.set(path, file);
			for (const [path, kind] of state.kinds) if (within(path) && !kinds.has(path)) kinds.set(path, kind);
		}
		for (const [path, file] of seen) {
			const known = state.index.get(path);
			if (known === undefined || known.digest !== file.digest || known.mode !== file.mode) {
				state.dirty.set(path, { op: "put", stamp });
			}
		}
		for (const path of state.index.keys()) if (!seen.has(path)) state.dirty.set(path, { op: "delete", stamp });
		state.index = seen;
		state.kinds = kinds;
	}

	/** The current contents and modes of `paths`, read as the sandbox user; a path that cannot be read is absent. */
	async #collect(
		state: LeaseState,
		paths: readonly string[],
	): Promise<Map<string, { data: Uint8Array; mode: number }>> {
		const collected = new Map<string, { data: Uint8Array; mode: number }>();
		for (const chunk of chunkJson(paths)) {
			const result = await this.#docker.exec(state.containerId, {
				cmd: [...PYTHON, COLLECT_SCRIPT, chunk],
				user: SANDBOX_USER,
				workingDir: MAINTENANCE_CWD,
				timeoutMs: this.#execTimeoutMs,
			});
			if (result.exitCode !== 0) {
				throw new KantelError(
					"unavailable",
					`collecting the working copy's changes failed (${result.exitCode}): ${decoder.decode(result.stderr).slice(0, 500)}`,
				);
			}
			for (const entry of readTar(result.stdout)) {
				if (entry.type === "file") collected.set(entry.path, { data: entry.data, mode: entry.mode });
			}
		}
		return collected;
	}

	// ---- commands ------------------------------------------------------------------------------------------------------

	async #command(state: LeaseState, request: BackendExec["request"]): Promise<BackendOutput> {
		const timeoutMs = positive(request.timeoutMs, this.#execTimeoutMs, "timeoutMs");
		const cwd =
			request.cwd === undefined || request.cwd === ""
				? WORKSPACE
				: `${WORKSPACE}/${normalizeWorkspacePath(request.cwd)}`;
		const argv = typeof request.command === "string" ? ["sh", "-c", request.command] : [...request.command];
		if (argv.length === 0 || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
			throw new KantelError("invalid", "a command is a non-empty string or argv without NUL characters");
		}
		const env: string[] = [];
		for (const [name, value] of Object.entries(request.env ?? {})) {
			if (!ENV_NAME.test(name) || typeof value !== "string" || value.includes("\0")) {
				throw new KantelError("invalid", `bad environment variable ${name}`, { name });
			}
			env.push(`${name}=${value}`);
		}
		const token = crypto.randomUUID();
		let stdinPath = "";
		if (request.stdin !== undefined) {
			stdinPath = `${IO_DIR}/${token}.in`;
			await this.#docker.putArchive(
				state.containerId,
				IO_DIR,
				writeTar([{ type: "file", path: `${token}.in`, mode: 0o600, data: encoder.encode(request.stdin) }]),
			);
		}
		const limit = this.#maxOutputBytes;
		const started = performance.now();
		const result = await this.#docker.exec(state.containerId, {
			cmd: [
				"sh",
				"-c",
				WRAPPER_SCRIPT,
				"kantel-exec",
				cwd,
				stdinPath,
				`${IO_DIR}/${token}`,
				String(limit + 1),
				"timeout",
				"-k",
				String(KILL_AFTER_S),
				(timeoutMs / 1000).toFixed(3),
				...argv,
			],
			user: SANDBOX_USER,
			env,
			timeoutMs: timeoutMs + KILL_AFTER_S * 1000 + HOST_GRACE_MS,
		});
		const elapsed = performance.now() - started;
		const truncated = result.stdout.length > limit || result.stderr.length > limit;
		const stdout = decoder.decode(result.stdout.subarray(0, limit));
		let stderr = decoder.decode(result.stderr.subarray(0, limit));
		// `timeout` exits 124 after SIGTERM, 137 when it had to SIGKILL.
		if ((result.exitCode === 124 || result.exitCode === 137) && elapsed >= timeoutMs) {
			stderr += `timed out after ${timeoutMs} ms\n`;
		}
		return { exitCode: result.exitCode, stdout, stderr, ...(truncated ? { truncated: true } : {}) };
	}

	// ---- helpers -------------------------------------------------------------------------------------------------------

	/**
	 * Runs `work` on the lease's container; when Docker says the container is gone or stopped (404, 409), forgets it so
	 * the next command starts a new one from the head, and says so.
	 */
	async #guard<T>(state: LeaseState, work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			const status = isKantelError(error, "unavailable") ? error.details?.status : undefined;
			if (status !== 404 && status !== 409) throw error;
			if (this.#states.get(state.leaseId) === state) this.#states.delete(state.leaseId);
			await this.#removeLease(state.leaseId).catch(() => undefined);
			throw new KantelError(
				"unavailable",
				`the container for lease ${state.leaseId} is gone; its uncommitted changes are lost`,
				{ leaseId: state.leaseId },
			);
		}
	}

	/** Runs calls on one lease one at a time, so a re-base, a command and a commit never interleave. */
	#serial<T>(leaseId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(leaseId) ?? Promise.resolve();
		const next = previous.then(work, work);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(leaseId, settled);
		void settled.then(() => {
			if (this.#queues.get(leaseId) === settled) this.#queues.delete(leaseId);
		});
		return next;
	}

	#checkFence(leaseId: string): void {
		const fence = this.#fences.get(leaseId);
		if (fence !== undefined) {
			throw new KantelError("expired", `lease ${leaseId} ${fence === "closing" ? "is being released" : "has ended"}`, {
				leaseId,
			});
		}
	}

	#checkOpen(): void {
		if (this.#closed) throw new KantelError("unavailable", "the container backend is closed");
	}

	#label(name: string): string {
		return `${this.#prefix}.${name}`;
	}
}

function positive(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new KantelError("invalid", `${name} must be a positive number`);
	return value;
}

function round(ms: number): number {
	return Math.round(ms * 10) / 10;
}

function overlaps(left: string, right: string): boolean {
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function isLocalOnly(path: string, localOnly: readonly string[]): boolean {
	return path.split("/").some((segment) => localOnly.includes(segment));
}

/** Plain directory names only: the scan compares them with each path segment. */
function checkLocalOnly(names: readonly string[]): readonly string[] {
	for (const name of names) {
		if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
			throw new KantelError("invalid", `localOnly takes directory names, not ${JSON.stringify(name)}`);
		}
	}
	return [...names];
}

/** Whether a path the container has can be a workspace path; one that cannot is left alone, never collected. */
function trackable(path: string): boolean {
	try {
		normalizeWorkspacePath(path);
		return true;
	} catch {
		return false;
	}
}

function underSymlink(kinds: ReadonlyMap<string, Kind>, path: string): boolean {
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i++) if (kinds.get(parts.slice(0, i).join("/")) === "l") return true;
	return false;
}

function dropSubtree(kinds: Map<string, Kind>, path: string): void {
	const prefix = `${path}/`;
	for (const candidate of [...kinds.keys()]) if (candidate.startsWith(prefix)) kinds.delete(candidate);
	kinds.delete(path);
}

function isIpLiteral(host: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/**
 * Checks a network option and returns its subnet pool as a base address and the number of lease subnets in it.
 * Per-lease networks find the proxy by name, so the proxy URL needs a host name.
 */
function checkNetwork(network: SandboxNetwork | undefined): { base: number; count: number } | undefined {
	if (network === undefined) return undefined;
	const isolation = network.isolation ?? "shared";
	if (isolation !== "shared" && isolation !== "per-lease") {
		throw new KantelError("invalid", `network isolation must be "shared" or "per-lease", not ${String(isolation)}`);
	}
	if (isolation === "shared") {
		if (network.subnetPool !== undefined || network.proxyContainer !== undefined) {
			throw new KantelError("invalid", "subnetPool and proxyContainer apply only to per-lease networks");
		}
		return undefined;
	}
	if (isIpLiteral(new URL(network.proxyUrl).hostname)) {
		throw new KantelError("invalid", "per-lease networks need the proxy URL to name the proxy by host name");
	}
	if (network.subnetPool === undefined) return undefined;
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(network.subnetPool);
	const octets = match?.slice(1, 5).map(Number) ?? [];
	const prefix = Number(match?.[5]);
	if (match === null || octets.some((octet) => octet > 255) || prefix > LEASE_SUBNET_PREFIX || prefix < 8) {
		throw new KantelError(
			"invalid",
			`subnetPool must be an IPv4 range from /8 to /${LEASE_SUBNET_PREFIX}, such as 10.248.0.0/16`,
		);
	}
	const address = octets.reduce((sum, octet) => sum * 256 + octet, 0);
	const size = 2 ** (32 - prefix);
	if (address % size !== 0) throw new KantelError("invalid", `subnetPool ${network.subnetPool} has host bits set`);
	return { base: address, count: size / LEASE_SUBNET_SIZE };
}

function ipv4(address: number): string {
	return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");
}

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Splits arguments into runs whose total size stays within ARGUMENT_BUDGET. */
function chunkArguments(args: readonly string[]): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const arg of args) {
		const length = encoder.encode(arg).length + 1;
		if (current.length > 0 && size + length > ARGUMENT_BUDGET) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(arg);
		size += length;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** `paths` as JSON arrays, each within ARGUMENT_BUDGET, for one script argument each. */
function chunkJson(paths: readonly string[]): string[] {
	return chunkArguments(paths).map((chunk) => JSON.stringify(chunk));
}

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let start = 0; start < items.length; start += BLOB_BATCH) {
		results.push(...(await Promise.all(items.slice(start, start + BLOB_BATCH).map(run))));
	}
	return results;
}
