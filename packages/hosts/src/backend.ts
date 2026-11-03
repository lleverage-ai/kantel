/**
 * The compute API's `SandboxBackend` over the hosts that joined: each call is placed by the scheduler or relayed to the
 * sandbox's host over its WebSocket. The compute API keeps every record; this keeps only placements (the registry's).
 *
 * A snapshot's `ref` is `{hostId}/{snapshotId}`: a snapshot lives on its host's disk, so a sandbox made or forked from
 * it goes on that host. Desktops, browsers and SSH are reached through tunnel URLs with tickets (`tunnel.ts`): the
 * desktop's Selkies stream at a page on the gateway (`desktop.ts`), view-only enforced there when the ticket says so, Chromium's
 * DevTools WebSocket passed through for `connectOverCDP`, and sshd as raw TCP for an `ssh -o ProxyCommand=…`. Exposed ports
 * are offered when the gateway has a wildcard name for them (`ports.ts`), token-gated unless exposed `public`.
 */
import type {
	BackendCapabilities,
	BackendEgress,
	BackendFileEntry,
	BackendHost,
	BackendSize,
	BootOptions,
	ExecResult,
	Placement,
	SandboxBackend,
	SandboxSpec,
	TakenSnapshot,
} from "@kantel/compute";
import { KantelError } from "@kantel/contracts";
import { DESKTOP_PORT, desktopPath } from "./desktop.ts";
import type { PortRouter } from "./ports.ts";
import type { HostEgress, HostSandbox, SandboxTier } from "./protocol.ts";
import type { HostsService, HostView } from "./service.ts";
import { type DesktopMode, HOSTS_TUNNEL_PATH, MAX_TUNNEL_MINUTES, type TunnelTickets } from "./tunnel.ts";

export { DESKTOP_PORT } from "./desktop.ts";
/** Where the guest image's Chromium (CDP) and sshd listen; its desktop stream is `DESKTOP_PORT`. */
export const BROWSER_PORT = 9222;
export const SSH_PORT = 22;

const PUBLIC_KEY =
	/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;
const FINGERPRINT_MARK = "--kantel-host-key--";

/** Lets a key in for `user` (making a pair when none is given), and prints the private key and the host key's SHA256. */
const SSH_ACCESS_SCRIPT = [
	"set -e",
	"umask 077",
	"mkdir -p ~/.ssh",
	'if [ -z "$KANTEL_PUBLIC_KEY" ]; then',
	"  d=$(mktemp -d)",
	'  ssh-keygen -q -t ed25519 -N "" -C kantel-access -f "$d/key"',
	'  cat "$d/key.pub" >> ~/.ssh/authorized_keys',
	'  cat "$d/key"',
	'  rm -rf "$d"',
	"else",
	// Once: a ProxyCommand asks again for each connection with the same key.
	'  grep -qxF "$KANTEL_PUBLIC_KEY" ~/.ssh/authorized_keys 2>/dev/null || printf "%s\\n" "$KANTEL_PUBLIC_KEY" >> ~/.ssh/authorized_keys',
	"fi",
	`echo ${FINGERPRINT_MARK}`,
	"ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f2",
].join("\n");

const SIZE_NAMES = new Set(["small", "default", "large", "xlarge"]);

export interface HostBackendOptions {
	readonly hosts: HostsService;
	/** Where clients reach the gateway, for tunnel URLs: `https://kantel.example.com`. */
	readonly publicUrl: string;
	/** Issues tunnel tickets, kept where every gateway replica's upgrade handler checks them (`createTunnelTickets`). */
	readonly tickets: TunnelTickets;
	/**
	 * Signs the Kantel-Sandbox and Kantel-Account headers hosts add for an account whose proxy settings ask for
	 * attribution, so its upstream can trust them. Absent, they go unsigned.
	 */
	readonly attributionKey?: string;
	/** Serves exposed ports on the gateway's wildcard name; without it, microVMs expose none. */
	readonly ports?: PortRouter;
	readonly now?: () => number;
}

/**
 * An account's proxy settings as a host's egress: its traffic goes through the host's proxy, which applies the rules,
 * then on to the upstream with the account's headers (held by the host, never the sandbox). Hosts pass traffic to the
 * upstream only with their data-path switch on (`--proxy-data-path`); the rules apply either way.
 */
export function hostEgress(egress: BackendEgress | undefined, attributionKey?: string): HostEgress | undefined {
	if (egress === undefined) return undefined;
	return {
		mode: "proxy",
		allow: [...egress.allow],
		deny: [...egress.deny],
		defaultDeny: egress.defaultAction === "deny",
		...(egress.upstream === undefined
			? {}
			: { upstream: egress.upstream.url, headers: { ...egress.upstream.headers } }),
		...(egress.attribution && attributionKey !== undefined ? { attributionKey } : {}),
	};
}

interface HostSnapshot {
	readonly id: string;
	readonly sizeBytes: number;
}

interface HostFileEntry {
	readonly name: string;
	readonly path: string;
	readonly type: string;
	readonly size: number;
	readonly modTimeMs?: number;
}

const snapshotId = () =>
	`snap_${[...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

function parseRef(ref: string): { hostId: string; snapshotId: string } {
	const [hostId, id, extra] = ref.split("/");
	if (hostId === undefined || id === undefined || extra !== undefined || hostId === "" || id === "") {
		throw new KantelError("not_found", "No such snapshot");
	}
	return { hostId, snapshotId: id };
}

const fromBase64 = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function fileEntry(entry: HostFileEntry): BackendFileEntry {
	return {
		name: entry.name,
		path: entry.path,
		kind: entry.type === "dir" ? "directory" : entry.type === "symlink" ? "symlink" : "file",
		size: entry.size,
		...(entry.modTimeMs === undefined ? {} : { modifiedAt: entry.modTimeMs }),
	};
}

function capabilitiesOf(tier: SandboxTier, host: HostView | undefined, ports: boolean) {
	const vm = tier === "microvm";
	return {
		exec: true,
		files: true,
		ssh: vm,
		desktop: vm,
		browser: vm,
		ports: vm && ports,
		docker: vm,
		kvm: vm && host?.nestedVirtualisation === true,
		pause: vm,
	};
}

export function createHostBackend(options: HostBackendOptions): SandboxBackend {
	const { hosts } = options;
	const now = options.now ?? Date.now;
	const httpBase = options.publicUrl.replace(/\/+$/, "");
	const wsBase = httpBase.replace(/^http/, "ws");

	const call = <T>(sandboxId: string, method: string, params: object = {}, signal?: AbortSignal, timeoutMs?: number) =>
		hosts.sandboxes.call<T>(sandboxId, method, params, {
			...(signal === undefined ? {} : { signal }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		});

	async function tierOf(sandboxId: string): Promise<{ tier: SandboxTier; hostId: string }> {
		const placement = await hosts.sandboxes.placement(sandboxId);
		if (placement === undefined) throw new KantelError("not_found", "No such sandbox on any host");
		return { tier: placement.tier, hostId: placement.hostId };
	}

	async function placed(sandboxId: string, sandbox: HostSandbox, hostId: string): Promise<Placement> {
		const placement = await hosts.sandboxes.placement(sandboxId);
		const host = await hosts.get(hostId).catch(() => undefined);
		const tier = placement?.tier ?? (sandbox.tier as SandboxTier);
		return {
			hostId,
			...(placement === undefined || tier === "isolate"
				? {}
				: {
						resources: {
							vcpus: placement.vcpus,
							memoryMb: placement.memoryMiB,
							diskGb: placement.diskGiB,
						},
					}),
			capabilities: capabilitiesOf(tier, host, options.ports !== undefined),
		};
	}

	const egressOf = (egress: BackendEgress | undefined) => {
		const out = hostEgress(egress, options.attributionKey);
		return out === undefined ? {} : { egress: out };
	};

	/**
	 * A disk is where it is: a sandbox or snapshot runs again only on its own host, and only when that host is one the
	 * service named eligible (online or draining, the account's own or shared, the type and labels).
	 */
	const mayUse = (hostId: string, eligible: readonly string[]) => {
		if (!eligible.includes(hostId)) {
			throw new KantelError("unavailable", `The host its disk is on (${hostId}) can't take it now`);
		}
	};

	async function boot(
		sandboxId: string,
		method: "sandbox.start" | "sandbox.resume",
		how: BootOptions,
	): Promise<Placement> {
		const { hostId } = await tierOf(sandboxId);
		mayUse(hostId, how.eligibleHosts);
		const egress = how.egress;
		const sandbox = await call<HostSandbox>(sandboxId, method, egressOf(egress));
		return placed(sandboxId, sandbox, hostId);
	}

	async function ticketFor(
		sandboxId: string,
		port: number,
		ttlMinutes: number,
		grantee?: string,
		desktop?: DesktopMode,
	): Promise<string> {
		await tierOf(sandboxId);
		return options.tickets.issue({
			sandboxId,
			port,
			expiresAt: now() + Math.max(1, Math.min(ttlMinutes, MAX_TUNNEL_MINUTES)) * 60_000,
			...(grantee === undefined ? {} : { grantee }),
			...(desktop === undefined ? {} : { desktop }),
		});
	}

	/** The desktop's Selkies page (desktop.ts); view-only is the ticket's, kept in its row, so the gateway enforces it. */
	async function desktopPage(
		sandboxId: string,
		ttlMinutes: number,
		viewOnly: boolean,
		grantee: string | undefined,
	): Promise<string> {
		const mode: DesktopMode = viewOnly ? "view" : "control";
		return `${httpBase}${desktopPath(await ticketFor(sandboxId, DESKTOP_PORT, ttlMinutes, grantee, mode), mode)}`;
	}

	async function tunnel(sandboxId: string, port: number, ttlMinutes: number, grantee: string | undefined) {
		return `${wsBase}${HOSTS_TUNNEL_PATH}/${await ticketFor(sandboxId, port, ttlMinutes, grantee)}`;
	}

	async function createOne(spec: SandboxSpec): Promise<Placement> {
		const from = spec.fromSnapshot === undefined ? undefined : parseRef(spec.fromSnapshot);
		if (from !== undefined) mayUse(from.hostId, spec.eligibleHosts);
		const { sandbox, hostId } = await hosts.sandboxes.create({
			sandboxId: spec.sandboxId,
			tier: spec.type,
			...(spec.type === "microvm" && spec.size !== undefined ? { size: spec.size } : {}),
			owner: spec.accountId,
			env: spec.env,
			hostIds: from === undefined ? spec.eligibleHosts : [from.hostId],
			...(from === undefined ? {} : { from: from.snapshotId }),
			...egressOf(spec.egress),
		});
		return placed(spec.sandboxId, sandbox, hostId);
	}

	return {
		async capabilities(): Promise<BackendCapabilities> {
			const views = (await hosts.list()).filter((host) => host.state !== "revoked");
			const types = new Set<SandboxTier>();
			const sizes = new Map<string, BackendSize>();
			const backendHosts: BackendHost[] = [];
			for (const host of views) {
				for (const tier of host.tiers) types.add(tier);
				for (const size of host.sizes ?? []) {
					if (!SIZE_NAMES.has(size.name) || sizes.has(size.name)) continue;
					sizes.set(size.name, {
						name: size.name as BackendSize["name"],
						vcpus: size.vcpus,
						memoryMb: size.memoryMiB,
						diskGb: size.diskGiB,
					});
				}
				backendHosts.push({
					id: host.id,
					name: host.name,
					...(host.version === undefined ? {} : { version: host.version }),
					...(host.os === undefined ? {} : { os: host.os }),
					...(host.arch === undefined ? {} : { arch: host.arch }),
					tiers: [...host.tiers],
					kvm: host.kvm,
					nestedVirtualisation: host.nestedVirtualisation,
					capacity: { ...host.capacity },
					labels: { ...host.labels },
					connected: host.state === "online" || host.state === "draining",
					...(host.lastSeenAt === undefined ? {} : { lastSeenAt: host.lastSeenAt }),
					...(host.accountId === undefined ? {} : { accountId: host.accountId }),
				});
			}
			return { types: [...types], sizes: [...sizes.values()], hosts: backendHosts };
		},
		create: createOne,
		start: (sandboxId, how) => boot(sandboxId, "sandbox.start", how),
		resume: (sandboxId, how) => boot(sandboxId, "sandbox.resume", how),
		recover: (sandboxId, how) => boot(sandboxId, "sandbox.start", how),
		async updateEgress(sandboxId, egress) {
			await call(sandboxId, "sandbox.egress", { egress: hostEgress(egress, options.attributionKey) ?? null });
		},
		async stop(sandboxId, { keepMemory }): Promise<TakenSnapshot> {
			const { tier, hostId } = await tierOf(sandboxId);
			if (keepMemory && tier !== "microvm") throw new KantelError("not_supported", "An isolate can't pause");
			// A stopped sandbox's ports end with it (the compute API forgets them when it starts again).
			await options.ports?.forget(sandboxId);
			const snap = await call<HostSnapshot>(sandboxId, "sandbox.stop", {
				snapshotId: snapshotId(),
				memory: keepMemory,
			});
			return { ref: `${hostId}/${snap.id}`, sizeBytes: snap.sizeBytes };
		},
		async fork(source, targets: readonly SandboxSpec[]): Promise<Placement[]> {
			const out: Placement[] = [];
			if (source.snapshot !== undefined) {
				for (const target of targets) out.push(await createOne({ ...target, fromSnapshot: source.snapshot }));
				return out;
			}
			// A live fork pauses the source for its snapshot only; forks stay on the source's host.
			const { hostId: sourceHost } = await tierOf(source.sandboxId);
			for (const target of targets) mayUse(sourceHost, target.eligibleHosts);
			for (const target of targets) {
				const { sandbox, hostId } = await hosts.sandboxes.fork(source.sandboxId, {
					newId: target.sandboxId,
					...egressOf(target.egress),
				});
				out.push(await placed(target.sandboxId, sandbox, hostId));
			}
			return out;
		},
		async destroy(sandboxId) {
			await options.ports?.forget(sandboxId);
			try {
				await hosts.sandboxes.delete(sandboxId);
			} catch (error) {
				if (!(error instanceof KantelError && error.code === "not_found")) throw error;
			}
		},
		async exec(sandboxId, request): Promise<ExecResult> {
			const result = await call<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>(
				sandboxId,
				"sandbox.exec",
				{
					command: request.command,
					...(request.cwd === undefined ? {} : { cwd: request.cwd }),
					...(request.env === undefined ? {} : { env: request.env }),
					...(request.stdin === undefined ? {} : { stdin: toBase64(new TextEncoder().encode(request.stdin)) }),
					...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				},
				request.signal,
				// The command's own limit, and some for the answer to come back; with none, an hour.
				request.timeoutMs === undefined ? 3_600_000 : request.timeoutMs + 10_000,
			);
			return {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				timedOut: result.timedOut === true,
			};
		},
		async readFile(sandboxId, path, range) {
			const answer = await call<{ data: string; fileSize?: number }>(
				sandboxId,
				"sandbox.files.read",
				range === undefined ? { path } : { path, offset: range.offset, length: range.length },
			);
			const bytes = fromBase64(answer.data);
			// A kantel-host from before ranged reads answers the whole file, without its fileSize.
			if (answer.fileSize === undefined) {
				const size = bytes.byteLength;
				if (range === undefined) return { bytes, size };
				const start = Math.min(range.offset, size);
				return { bytes: bytes.subarray(start, Math.min(start + range.length, size)), size };
			}
			return { bytes, size: answer.fileSize };
		},
		async writeFile(sandboxId, path, content, mode) {
			await call(sandboxId, "sandbox.files.write", {
				path,
				data: toBase64(content),
				...(mode === undefined ? {} : { mode }),
			});
			return { name: path.split("/").pop() ?? path, path, kind: "file", size: content.length, modifiedAt: now() };
		},
		async deleteFile(sandboxId, path) {
			await call(sandboxId, "sandbox.files.delete", { path, recursive: true });
		},
		async listFiles(sandboxId, path) {
			const { entries } = await call<{ entries: HostFileEntry[] | null }>(sandboxId, "sandbox.files.list", { path });
			return (entries ?? []).map(fileEntry);
		},
		async takeSnapshot(sandboxId): Promise<TakenSnapshot> {
			const { hostId } = await tierOf(sandboxId);
			const snap = await call<HostSnapshot>(sandboxId, "snapshot.save", { snapshotId: snapshotId() });
			return { ref: `${hostId}/${snap.id}`, sizeBytes: snap.sizeBytes };
		},
		async listSnapshotFiles(ref, path) {
			const { hostId, snapshotId: id } = parseRef(ref);
			const { entries } = await hosts.hub.call<{ entries: HostFileEntry[] | null }>(hostId, "snapshot.tree", {
				snapshotId: id,
				path,
			});
			return (entries ?? []).map(fileEntry);
		},
		async readSnapshotFile(ref, path) {
			const { hostId, snapshotId: id } = parseRef(ref);
			const { data } = await hosts.hub.call<{ data: string }>(hostId, "snapshot.read", { snapshotId: id, path });
			return fromBase64(data);
		},
		async deleteSnapshot(ref) {
			const { hostId, snapshotId: id } = parseRef(ref);
			await hosts.hub.call(hostId, "snapshot.delete", { snapshotId: id });
		},
		async exposePort(sandboxId, port, { public: isPublic, subdomain, grantee }) {
			const { tier } = await tierOf(sandboxId);
			if (options.ports === undefined || tier !== "microvm") {
				throw new KantelError("not_supported", "This control plane has no name for exposed ports");
			}
			return options.ports.expose(sandboxId, port, {
				public: isPublic,
				subdomain,
				...(grantee === undefined ? {} : { grantee }),
			});
		},
		async hidePort(sandboxId, port) {
			await options.ports?.hide(sandboxId, port);
		},
		async openSsh(sandboxId, { publicKey, ttlMinutes, grantee }) {
			const { tier } = await tierOf(sandboxId);
			if (tier !== "microvm") throw new KantelError("not_supported", "An isolate has no SSH");
			const key = publicKey?.trim();
			if (key !== undefined && !PUBLIC_KEY.test(key))
				throw new KantelError("invalid", "publicKey is one OpenSSH public key");
			const run = await call<{ exitCode: number; stdout: string; stderr: string }>(sandboxId, "sandbox.exec", {
				command: SSH_ACCESS_SCRIPT,
				env: { KANTEL_PUBLIC_KEY: key ?? "" },
			});
			if (run.exitCode !== 0)
				throw new KantelError("unavailable", `The sandbox could not let the key in: ${run.stderr}`);
			const [privateKey = "", fingerprint = ""] = run.stdout.split(`${FINGERPRINT_MARK}\n`);
			const url = await tunnel(sandboxId, SSH_PORT, ttlMinutes, grantee);
			const gateway = new URL(options.publicUrl);
			const port = Number(gateway.port || (gateway.protocol === "https:" ? 443 : 80));
			return {
				host: gateway.hostname,
				port,
				user: "user",
				// Any WebSocket client that pipes stdin and stdout as binary frames does; websocat is one.
				command: `ssh -o ProxyCommand='websocat --binary ${url}' user@${sandboxId}`,
				proxyUrl: url,
				...(key === undefined && privateKey.trim() !== "" ? { privateKey: `${privateKey.trim()}\n` } : {}),
				...(fingerprint.trim() === "" ? {} : { hostKeyFingerprint: fingerprint.trim() }),
			};
		},
		async openDesktop(sandboxId, { ttlMinutes, viewOnly, grantee }) {
			const { tier } = await tierOf(sandboxId);
			if (tier !== "microvm") throw new KantelError("not_supported", "An isolate has no desktop");
			// Selkies' page (desktop.ts), whose stream goes through the gateway with the same ticket.
			const url = await desktopPage(sandboxId, ttlMinutes, viewOnly, grantee);
			return { url, embedUrl: url };
		},
		async openBrowser(sandboxId, { ttlMinutes, viewOnly, grantee }) {
			const { tier } = await tierOf(sandboxId);
			if (tier !== "microvm") throw new KantelError("not_supported", "An isolate has no browser");
			// Chromium's browser-wide DevTools target, passed through the tunnel with its path.
			const version = await call<{ exitCode: number; stdout: string }>(sandboxId, "sandbox.exec", {
				command: "curl -fsS --max-time 5 http://127.0.0.1:9222/json/version",
			});
			let target: string | undefined;
			try {
				const parsed = JSON.parse(version.stdout) as { webSocketDebuggerUrl?: unknown };
				if (typeof parsed.webSocketDebuggerUrl === "string") target = new URL(parsed.webSocketDebuggerUrl).pathname;
			} catch {
				target = undefined;
			}
			if (version.exitCode !== 0 || target === undefined || !target.startsWith("/devtools/browser/")) {
				throw new KantelError("unavailable", "The sandbox's browser isn't up yet");
			}
			const cdpUrl = `${await tunnel(sandboxId, BROWSER_PORT, ttlMinutes, grantee)}${target}`;
			// People watch and drive Chromium where it runs: on the desktop.
			return { url: await desktopPage(sandboxId, ttlMinutes, viewOnly, grantee), cdpUrl };
		},
		async revokeHost(hostId) {
			await hosts.revoke(hostId).catch((error: unknown) => {
				if (!(error instanceof KantelError && error.code === "not_found")) throw error;
			});
		},
		async updateHost(hostId, change) {
			await hosts.update(hostId, change).catch((error: unknown) => {
				if (!(error instanceof KantelError && error.code === "not_found")) throw error;
			});
		},
		async usage(sandboxId) {
			const { tier } = await tierOf(sandboxId);
			if (tier !== "microvm") throw new KantelError("not_supported", "An isolate reports no usage");
			const { stdout } = await call<{ stdout: string }>(sandboxId, "sandbox.exec", {
				command: "cat /proc/loadavg; nproc; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
			});
			const lines = stdout.trim().split("\n");
			const load = Number(lines[0]?.split(" ")[0] ?? 0);
			const cpus = Math.max(1, Number(lines[1] ?? 1));
			const kb = (name: string) => Number(/(\d+)/.exec(lines.find((line) => line.startsWith(name)) ?? "")?.[1] ?? 0);
			return {
				cpu: Math.min(1, Math.max(0, load / cpus)),
				memoryBytes: Math.max(0, kb("MemTotal") - kb("MemAvailable")) * 1024,
			};
		},
	};
}
