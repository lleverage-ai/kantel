/**
 * The compute API's `SandboxBackend` over the hosts that joined: each call is placed by the scheduler or relayed to the
 * sandbox's host over its WebSocket. The compute API keeps every record; this keeps only placements (the registry's).
 *
 * A snapshot's `ref` is `{hostId}/{snapshotId}`: a snapshot lives on its host's disk, so a sandbox made or forked from
 * it goes on that host. A template snapshot's `ref` is the same, and a sandbox made from it goes on its host too, or
 * boots the template fresh elsewhere when that host is full. Desktops, browsers and SSH are reached through tunnel URLs
 * with tickets (`tunnel.ts`): the desktop's Selkies stream at a page on the gateway (`desktop.ts`), view-only enforced
 * there when the ticket says so, Chromium's DevTools WebSocket passed through for `connectOverCDP`, and sshd as raw TCP for an `ssh -o ProxyCommand=…`. Exposed ports
 * are offered when the gateway has a wildcard name for them (`ports.ts`), token-gated unless exposed `public`.
 *
 * Mounts go to a host with every create, start, resume, fork and recover, but only those its features say it can do
 * (`mountHandoff`); the others are answered `failed`. Large files stream over `sandbox.files.open` on a host that
 * reports `file-streams`; on one that doesn't, `not_supported` sends the compute service back to `readFile` and
 * `writeFile`.
 */
import type {
	BackendCapabilities,
	BackendEgress,
	BackendFileEntry,
	BackendHost,
	BackendMount,
	BackendSize,
	BootOptions,
	BuiltTemplate,
	ExecResult,
	FileStream,
	Placement,
	SandboxBackend,
	SandboxSpec,
	SandboxTemplateBoot,
	TakenSnapshot,
	TemplateRuntime,
} from "@kantel/compute";
import { type ErrorCode, isKantelError, KantelError } from "@kantel/contracts";
import { BROWSER_STREAM_PORT, DESKTOP_PORT, desktopPath } from "./desktop.ts";
import type { FileStreamHandle, PortSink } from "./hub.ts";
import type { PortRouter } from "./ports.ts";
import {
	FILE_STREAM_ACK_BYTES,
	FILE_STREAM_FRAME_MAX_BYTES,
	FILE_STREAM_WINDOW_BYTES,
	HOST_E2E_PORT,
	HOST_FEATURES,
	HOST_WRITE_FILE_MAX_BYTES,
	type HostEgress,
	type HostGuest,
	HostMethods,
	type HostMount,
	type HostSandbox,
	type HostTemplateBoot,
	type SandboxTier,
} from "./protocol.ts";
import {
	type CreateSandboxInput,
	type HostsService,
	kantelErrorFromHost,
	mountHandoff,
	type SandboxPlacement,
} from "./service.ts";
import { type DesktopMode, HOSTS_TUNNEL_PATH, MAX_TUNNEL_MINUTES, type TunnelTickets } from "./tunnel.ts";

export { BROWSER_STREAM_PORT, DESKTOP_PORT } from "./desktop.ts";
/** Where the guest image's Chromium (CDP) and sshd listen; its desktop stream is `DESKTOP_PORT`. */
export const BROWSER_PORT = 9222;
export const SSH_PORT = 22;
/**
 * Printed before Chromium's DevTools version by `openBrowser`'s command when the machine runs Chromium on its own
 * display now, with that display up. The image's `kantel-browser` records where it started Chromium in its unit's
 * runtime directory (BROWSER_DISPLAY_RECORD): gone when the unit stops and on a cold boot, kept in memory. That one
 * record is the answer whatever made it so: the host's boot argument, `desktop.env`, a template's setup, a pause under
 * an older host; an image from before it has none, and its Chromium is on the desktop.
 */
export const BROWSER_SURFACE_MARK = "kantel-browser-surface\n";
export const BROWSER_DISPLAY_RECORD = "/run/kantel-browser/display";
const BROWSER_SURFACE_CHECK = `[ "$(cat ${BROWSER_DISPLAY_RECORD} 2>/dev/null)" = :2 ] && [ -S /tmp/.X11-unix/X2 ] && printf 'kantel-browser-surface\\n'; `;

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

/** Where Kantel's initramfs puts the guest agent in an image (apps/host/internal/guest.InjectedBin). */
const INJECTED_AGENT = "/.kantel/bin/kantel-guest";

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
		// The hosts to intercept and the version only: the host fetches the values itself (secrets.fetch), so they never
		// ride a create's params, which the host keeps on disk.
		...(egress.protected === undefined
			? {}
			: { protected: { version: egress.protected.version, intercept: [...egress.protected.intercept] } }),
		...(egress.grants === undefined || egress.grants.length === 0
			? {}
			: {
					grants: egress.grants.map((grant) => ({
						action: grant.action,
						host: grant.host,
						...(grant.methods === undefined ? {} : { methods: [...grant.methods] }),
						...(grant.paths === undefined ? {} : { paths: [...grant.paths] }),
						rule: grant.rule,
					})),
				}),
		...(egress.revision === undefined ? {} : { revision: egress.revision }),
	};
}

interface HostSnapshot {
	readonly id: string;
	readonly sizeBytes: number;
	/** The host images version its root file system is (image patching); absent when unknown. */
	readonly base?: string;
}

/** A snapshot as the compute service keeps it: its ref on its host, its size and its base when the host said. */
const takenOn = (hostId: string, snap: HostSnapshot): TakenSnapshot => ({
	ref: `${hostId}/${snap.id}`,
	sizeBytes: snap.sizeBytes,
	...(snap.base === undefined || snap.base === "" ? {} : { base: snap.base }),
});

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

/** A template's base image as a host takes it: its name, and its digest unless there is none (the host's own image). */
function hostTemplateBase(baseImage: string, baseDigest: string): Pick<HostTemplateBoot, "baseImage" | "baseDigest"> {
	return {
		baseImage,
		...(baseDigest === "" ? {} : { baseDigest }),
	};
}

/**
 * A sandbox's template boot as the registry takes it, restoring `snapshotId` (on that host) when there is one, as the
 * create's size or shape.
 */
function hostTemplateBoot(
	template: SandboxTemplateBoot,
	snapshotId: string | undefined,
): NonNullable<CreateSandboxInput["template"]> {
	return {
		...hostTemplateBase(template.baseImage, template.baseDigest),
		...(template.setup === undefined ? {} : { setup: template.setup }),
		...(snapshotId === undefined ? {} : { snapshot: snapshotId }),
		// A custom image boots the root filesystem a build on the host made, which `rootfsKey` names.
		...(template.image === undefined ? {} : { image: { ...template.image } }),
		...(template.rootfsKey === undefined ? {} : { rootfsKey: template.rootfsKey }),
	};
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

/** A mount as a host is given it: its source by name only (a digest, a bucket source's ID), never a credential. */
export function hostMount(mount: BackendMount): HostMount {
	const { source } = mount;
	if (source.kind === "bundle") return { path: mount.path, kind: "bundle", digest: source.digest };
	return {
		path: mount.path,
		kind: "bucket",
		bucketSourceId: source.bucketSourceId,
		prefix: source.prefix,
		...(source.refreshTtlSeconds === undefined ? {} : { refreshTtlSeconds: source.refreshTtlSeconds }),
	};
}

/** A spec's or boot's mounts for the hosts service; absent when there are none. */
const mountsOf = (mounts: readonly BackendMount[] | undefined): HostMount[] | undefined =>
	mounts === undefined || mounts.length === 0 ? undefined : mounts.map(hostMount);

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
	"invalid",
	"not_found",
	"forbidden",
	"conflict",
	"expired",
	"refused",
	"exhausted",
	"unavailable",
	"aborted",
	"not_supported",
]);

/**
 * How a file stream ended, from the host's `stream.close` reason: `ok <size>`, the size; `error <code>: <message>`, the
 * error, with its code when it is one of Kantel's, else `unavailable`. Any other end (the host gone, the stream cut
 * short) is `unavailable`: the bytes didn't all arrive.
 */
export function fileStreamEnd(reason: string): { readonly size: number } | KantelError {
	const ok = /^ok (\d+)$/.exec(reason);
	if (ok?.[1] !== undefined) return { size: Number(ok[1]) };
	const failed = /^error ([^:\s]+): ?([\s\S]*)$/.exec(reason);
	if (failed?.[1] !== undefined) {
		const code = ERROR_CODES.has(failed[1]) ? (failed[1] as ErrorCode) : "unavailable";
		return new KantelError(code, failed[2] || "The sandbox's host couldn't stream the file");
	}
	return new KantelError("unavailable", `The file stream ended before it was done: ${reason}`);
}

/**
 * What a sandbox can do. A microVM's guest report, where its host sent one, says what its image has: an image without
 * a desktop, a browser or Docker can't offer them, and `/dev/kvm` must open inside for nesting. With no report (a host
 * from before the guest agent said), a microVM is Kantel's own image, which has them all. The browser alone
 * (`browserSurface`) only where the report says so: images from before it show the browser on the desktop.
 */
export function capabilitiesOf(tier: SandboxTier, nested: boolean, ports: boolean, guest?: HostGuest) {
	const vm = tier === "microvm";
	const report = vm ? guest : undefined;
	return {
		exec: true,
		files: true,
		ssh: vm,
		desktop: vm && (report?.desktop.available ?? true),
		browser: vm && (report?.browser.available ?? true),
		browserSurface: vm && report?.browserSurface?.available === true,
		ports: vm && ports,
		docker: vm && (report?.docker.available ?? true),
		kvm: vm && nested && (report?.docker.kvm ?? true),
		pause: vm,
		...(report === undefined ? {} : { guest: report }),
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

	/**
	 * The placement the compute API records. What the registry answered with the sandbox (its placement as written, and
	 * whether the host nests virtualisation) is taken as it is, so neither is read back; what it didn't answer is read,
	 * both at once.
	 */
	async function placed(
		sandboxId: string,
		sandbox: HostSandbox,
		hostId: string,
		known: Omit<SandboxPlacement, "sandbox" | "hostId"> = {},
	): Promise<Placement> {
		const [placement, nested] = await Promise.all([
			known.placement ?? hosts.sandboxes.placement(sandboxId),
			known.nestedVirtualisation ??
				hosts
					.get(hostId)
					.then((host) => host.nestedVirtualisation)
					.catch(() => undefined),
		]);
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
			capabilities: capabilitiesOf(tier, nested === true, options.ports !== undefined, sandbox.guest),
			...(sandbox.base === undefined || sandbox.base === ""
				? {}
				: {
						base: sandbox.base,
						...(typeof sandbox.baseAt === "number" && sandbox.baseAt > 0 ? { baseAt: sandbox.baseAt } : {}),
					}),
			...(known.mounts === undefined ? {} : { mounts: known.mounts }),
		};
	}

	/** What the host reports doing beyond protocol 1 (`HOST_FEATURES`). */
	const featuresOf = async (hostId: string): Promise<readonly string[]> => (await hosts.get(hostId)).features;

	/**
	 * Refuses a file stream with `not_supported` unless the sandbox's host can stream files, so the compute service falls
	 * back to `readFile` and `writeFile`.
	 */
	async function streamingHost(sandboxId: string): Promise<void> {
		const { hostId } = await tierOf(sandboxId);
		if (!(await featuresOf(hostId)).includes(HOST_FEATURES.fileStreams)) {
			throw new KantelError("not_supported", "This sandbox's host can't stream files");
		}
	}

	/** A read's bytes queued for its reader: kept at most `FILE_STREAM_WINDOW_BYTES` by the host's window. */
	interface ReadQueue {
		readonly chunks: Uint8Array[];
		end?: { readonly error?: Error };
		wake?: () => void;
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
		const revision = how.egressRevision ?? how.egress?.revision;
		// Mounted again on the new machine, those its host can do; the host is read only when there are some.
		const wanted = mountsOf(how.mounts);
		const mounts = mountHandoff(wanted === undefined ? undefined : await featuresOf(hostId), wanted);
		// With a revision the host takes the boot's egress as stated, none being its default (a clear); an update read
		// before this boot, with an older revision, is refused after it.
		const sandbox = await call<HostSandbox>(sandboxId, method, {
			...egressOf(how.egress),
			...(revision === undefined ? {} : { revision }),
			// Only a cold boot rebases; a host without image patching ignores the fields. With `rebaseTo` the host refuses
			// to land anywhere else.
			...(method === "sandbox.start" && how.rebase === true
				? { rebase: true, ...(how.rebaseTo === undefined ? {} : { rebaseTo: how.rebaseTo }) }
				: {}),
			...(mounts.send.length === 0 ? {} : { mounts: mounts.send }),
		});
		const statuses = mounts.status(sandbox);
		return placed(sandboxId, sandbox, hostId, statuses === undefined ? {} : { mounts: statuses });
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

	/**
	 * A Selkies page (desktop.ts): the desktop's, or with `port` the browser's alone. View-only is the ticket's, kept in
	 * its row, so the gateway enforces it; so is the stream it opens.
	 */
	async function desktopPage(
		sandboxId: string,
		ttlMinutes: number,
		viewOnly: boolean,
		grantee: string | undefined,
		port: number = DESKTOP_PORT,
	): Promise<string> {
		const mode: DesktopMode = viewOnly ? "view" : "control";
		return `${httpBase}${desktopPath(await ticketFor(sandboxId, port, ttlMinutes, grantee, mode), mode)}`;
	}

	async function tunnel(sandboxId: string, port: number, ttlMinutes: number, grantee: string | undefined) {
		return `${wsBase}${HOSTS_TUNNEL_PATH}/${await ticketFor(sandboxId, port, ttlMinutes, grantee)}`;
	}

	/**
	 * Places and makes one sandbox. A snapshot, the sandbox's or its template's, is on one host's disk: the sandbox goes
	 * there. A template snapshot only speeds a create up, so when its host has no room (`exhausted`) the template boots
	 * fresh on another eligible host instead (`bootedFresh`); a sandbox's own snapshot has nowhere else to go.
	 */
	async function createOne(spec: SandboxSpec): Promise<Placement> {
		const from = spec.fromSnapshot === undefined ? undefined : parseRef(spec.fromSnapshot);
		const templateFrom = spec.template?.snapshot === undefined ? undefined : parseRef(spec.template.snapshot);
		const pinned = from ?? templateFrom;
		if (pinned !== undefined) mayUse(pinned.hostId, spec.eligibleHosts);
		const mounts = mountsOf(spec.mounts);
		// The service sends the mounts the host it chooses can do, and answers each one's status.
		const create = (hostIds: readonly string[], templateSnapshot: string | undefined) =>
			hosts.sandboxes.create({
				sandboxId: spec.sandboxId,
				tier: spec.type,
				...(spec.type === "microvm" && spec.size !== undefined && spec.shape === undefined ? { size: spec.size } : {}),
				// A shape is placed as one: on a host with that named size (restored from its template snapshot), or as a
				// custom shape; a template's snapshot is restored only where it was built as that shape.
				...(spec.shape === undefined ? {} : { shape: { vcpus: spec.shape.vcpus, memoryMiB: spec.shape.memoryMb } }),
				owner: spec.accountId,
				env: spec.env,
				hostIds,
				...(from === undefined ? {} : { from: from.snapshotId }),
				...(spec.template === undefined ? {} : { template: hostTemplateBoot(spec.template, templateSnapshot) }),
				...egressOf(spec.egress),
				...(mounts === undefined ? {} : { mounts }),
			});
		if (templateFrom !== undefined) {
			const elsewhere = spec.eligibleHosts.filter((hostId) => hostId !== templateFrom.hostId);
			try {
				const { sandbox, hostId, ...known } = await create([templateFrom.hostId], templateFrom.snapshotId);
				const placement = await placed(spec.sandboxId, sandbox, hostId, known);
				// Its host couldn't restore the snapshot (gone, broken, made for another machine) and booted the template
				// fresh, running its setup.
				return sandbox.source === "boot" ? { ...placement, bootedFresh: true } : placement;
			} catch (error) {
				if (!isKantelError(error, "exhausted") || elsewhere.length === 0) throw error;
			}
			const { sandbox, hostId, ...known } = await create(elsewhere, undefined);
			return { ...(await placed(spec.sandboxId, sandbox, hostId, known)), bootedFresh: true };
		}
		const { sandbox, hostId, ...known } = await create(
			pinned === undefined ? spec.eligibleHosts : [pinned.hostId],
			undefined,
		);
		return placed(spec.sandboxId, sandbox, hostId, known);
	}

	return {
		async capabilities(): Promise<BackendCapabilities> {
			// What the hosts are, not what they hold: no placements are read.
			const views = (await hosts.list({ allocations: false })).filter((host) => host.state !== "revoked");
			const types = new Set<SandboxTier>();
			const sizes = new Map<string, BackendSize>();
			const backendHosts: BackendHost[] = [];
			for (const host of views) {
				for (const tier of host.tiers) types.add(tier);
				const own: BackendSize[] = [];
				for (const size of host.sizes ?? []) {
					if (!SIZE_NAMES.has(size.name)) continue;
					const named = {
						name: size.name as BackendSize["name"],
						vcpus: size.vcpus,
						memoryMb: size.memoryMiB,
						diskGb: size.diskGiB,
					};
					own.push(named);
					if (!sizes.has(size.name)) sizes.set(size.name, named);
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
					features: [...host.features],
					capacity: { ...host.capacity },
					sizes: own,
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
		async prepareRebase(sandboxId, { eligibleHosts, rebaseTo }) {
			const { hostId } = await tierOf(sandboxId);
			mayUse(hostId, eligibleHosts);
			// A host's sandbox is on host images: without a version to land on (the index unread, or naming no stable host
			// release) a rebase would land on whatever the host has, so it's refused before the sandbox stops.
			if (rebaseTo === undefined) {
				throw new KantelError(
					"unavailable",
					"Kantel's base image index names no stable host images now, so there's no latest base to restart on: try again later",
				);
			}
			// Asked now rather than read from the hello's facts, which an update since has left behind, and for this sandbox:
			// its tier's images, which a host config naming its root filesystem by path can hold back.
			const images = await hosts.hub
				.call<{ version?: string; state?: string }>(hostId, HostMethods.hostImages, { sandboxId })
				.catch((error: unknown) => {
					const mapped = kantelErrorFromHost(error);
					throw isKantelError(mapped, "not_supported")
						? new KantelError(
								"not_supported",
								`The host its disk is on (${hostId}) doesn't patch its images: turn on imagePatching in its config, or update kantel-host`,
							)
						: mapped;
				});
			const have = images.version ?? "";
			if (have !== rebaseTo) {
				throw new KantelError(
					"unavailable",
					`The host its disk is on (${hostId}) has images ${have === "" ? "that aren't versioned" : have}, not ${rebaseTo}, yet: try again once it has taken the update`,
				);
			}
			// Unknown when the host doesn't say: its start then refuses a machine still running on other images.
			return images.state === undefined ? {} : { running: images.state === "running" };
		},
		resume: (sandboxId, how) => boot(sandboxId, "sandbox.resume", how),
		// Recovering clears the sandbox's recorded ports (the compute API), so their exposures end with them: a URL the API
		// no longer lists, and can't hide, must not still reach the machine.
		recover: async (sandboxId, how) => {
			await options.ports?.forget(sandboxId);
			return boot(sandboxId, "sandbox.start", how);
		},
		async updateEgress(sandboxId, egress, revision) {
			await call(sandboxId, "sandbox.egress", {
				egress: hostEgress(egress, options.attributionKey) ?? null,
				// A null egress is ordered too: the host ignores one older than the egress it has.
				...(revision === undefined ? {} : { revision }),
			});
		},
		async updateSecrets(sandboxId, version) {
			// The host drops its copy; its next request that needs one fetches the new values.
			await call(sandboxId, HostMethods.secrets, { sandboxId, version });
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
			return takenOn(hostId, snap);
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
				const mounts = mountsOf(target.mounts);
				const { sandbox, hostId, ...known } = await hosts.sandboxes.fork(source.sandboxId, {
					newId: target.sandboxId,
					...egressOf(target.egress),
					// Its own placeholders, not its source's: the host gives the guest this environment.
					env: target.env,
					...(mounts === undefined ? {} : { mounts }),
				});
				out.push(await placed(target.sandboxId, sandbox, hostId, known));
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
			// Past the host's message limit the host would drop its whole link, every sandbox's calls and streams on it.
			if (content.length > HOST_WRITE_FILE_MAX_BYTES) {
				throw new KantelError(
					"invalid",
					`This sandbox's host takes files of at most ${HOST_WRITE_FILE_MAX_BYTES} bytes in one write; it can't stream larger ones`,
				);
			}
			await call(sandboxId, "sandbox.files.write", {
				path,
				data: toBase64(content),
				...(mode === undefined ? {} : { mode }),
			});
			return { name: path.split("/").pop() ?? path, path, kind: "file", size: content.length, modifiedAt: now() };
		},
		async readFileStream(sandboxId, path): Promise<FileStream> {
			await streamingHost(sandboxId);
			// The sink is made before the stream is opened: the host may send a small file whole before `openFile`
			// resolves. What arrives waits here until the reader takes it, and the reader's takings go back to the host
			// (`stream.ack`), which sends no more than FILE_STREAM_WINDOW_BYTES past them: a slow client holds the host
			// back, not the gateway's memory. That isn't left to the host, an account's own machine: a frame it sends once
			// the window is full, or one larger than FILE_STREAM_FRAME_MAX_BYTES, ends the read and frees what it holds, so
			// at most the window and one frame are ever kept.
			const queue: ReadQueue = { chunks: [] };
			let handle: FileStreamHandle | undefined;
			let cancelled = false;
			let received = 0;
			let taken = 0;
			let acked = 0;
			const ack = () => {
				if (handle === undefined || taken - acked < FILE_STREAM_ACK_BYTES) return;
				acked = taken;
				handle.ack(taken);
			};
			const body = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						while (queue.chunks.length === 0 && queue.end === undefined) {
							await new Promise<void>((resolve) => {
								queue.wake = resolve;
							});
						}
						const chunk = queue.chunks.shift();
						if (chunk !== undefined) {
							taken += chunk.byteLength;
							controller.enqueue(chunk);
							ack();
							return;
						}
						if (queue.end?.error !== undefined) controller.error(queue.end.error);
						else controller.close();
					},
					cancel() {
						cancelled = true;
						queue.chunks.length = 0;
						handle?.close();
					},
				},
				// Nothing pulled ahead of the reader, so what it has taken is what was handed to it.
				{ highWaterMark: 0 },
			);
			let overran = false;
			const sink: PortSink = {
				data(bytes) {
					if (cancelled || queue.end !== undefined) return;
					// The host sends a frame only while less than its window is unacked: `acked` is the most it can know of.
					if (received - acked >= FILE_STREAM_WINDOW_BYTES || bytes.byteLength > FILE_STREAM_FRAME_MAX_BYTES) {
						overran = true;
						queue.chunks.length = 0;
						queue.end = {
							error: new KantelError("unavailable", "The sandbox's host sent more of the file than it was asked for"),
						};
						handle?.close();
						queue.wake?.();
						return;
					}
					received += bytes.byteLength;
					queue.chunks.push(bytes);
					queue.wake?.();
				},
				end(reason) {
					if (cancelled || queue.end !== undefined) return;
					const end = fileStreamEnd(reason);
					if (end instanceof KantelError) queue.end = { error: end };
					else if (end.size !== received) {
						queue.end = {
							error: new KantelError(
								"unavailable",
								`The host sent ${received} bytes of a file it says has ${end.size}`,
							),
						};
					} else queue.end = {};
					queue.wake?.();
				},
			};
			const opened = await hosts.sandboxes.openFile(sandboxId, { path, op: "read" }, sink);
			handle = opened.stream;
			if (overran) handle.close();
			// What was taken before the handle came (nothing yet: no one had the body).
			ack();
			return { ...(opened.size === undefined ? {} : { size: opened.size }), body };
		},
		async extractArchive(sandboxId, archive, target) {
			const { hostId } = await tierOf(sandboxId);
			if (!(await featuresOf(hostId)).includes(HOST_FEATURES.filesExtract)) {
				throw new KantelError("not_supported", "This sandbox's host can't extract archives; upgrade kantel-host");
			}
			// As long as a large archive takes to write out.
			await call(sandboxId, HostMethods.fileExtract, { archive, target }, undefined, 30 * 60_000);
		},
		async placedOn(sandboxId) {
			const placement = await hosts.sandboxes.placement(sandboxId);
			return placement === undefined || placement.state === "deleted" ? undefined : placement.hostId;
		},
		async writeFileStream(sandboxId, path, body, mode) {
			await streamingHost(sandboxId);
			let settle: (reason: string) => void = () => undefined;
			const ended = new Promise<string>((resolve) => {
				settle = resolve;
			});
			let finished = false;
			// The host may end the stream first (an error): then the rest of the body isn't waited for. Its one end
			// handler cancels the body, which ends a read waiting on it, rather than each read racing the end: a race per
			// chunk would keep every chunk's reaction on `ended` until the transfer is over.
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let hostEnded = false;
			const { stream: handle } = await hosts.sandboxes.openFile(
				sandboxId,
				{ path, op: "write", ...(mode === undefined ? {} : { mode }) },
				{
					data: () => undefined,
					end: (reason) => {
						hostEnded = true;
						settle(reason);
						if (!finished) reader?.cancel().catch(() => undefined);
					},
				},
			);
			reader = body.getReader();
			try {
				for (;;) {
					const next = hostEnded ? undefined : await reader.read();
					// Ended by the host (its end cancelled the read): not the body's own end, so nothing is finished.
					if (next === undefined || hostEnded) {
						reader.cancel().catch(() => undefined);
						break;
					}
					if (next.done) {
						handle.finish();
						finished = true;
						break;
					}
					// Not more than the socket's buffer ahead of the host: a 500 MB body isn't held in memory.
					await handle.drained();
					handle.write(next.value);
				}
			} catch (error) {
				// The body failed (its client went away): nothing is moved into place.
				handle.close();
				throw error;
			}
			const end = fileStreamEnd(await ended);
			if (end instanceof KantelError) throw end;
			if (!finished)
				throw new KantelError("unavailable", "The sandbox's host ended the write before all of it arrived");
			return { size: end.size };
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
			return takenOn(hostId, snap);
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
		async templateRuntimes(): Promise<TemplateRuntime[]> {
			return (await hosts.templates.runtimes()).map((runtime) => ({
				hostId: runtime.hostId,
				kernel: runtime.guestKernel ?? "unknown",
				firecracker: runtime.firecracker ?? "unknown",
				...(runtime.customImages === true ? { customImages: true } : {}),
			}));
		},
		async buildTemplate(spec): Promise<BuiltTemplate> {
			const built = await hosts.templates.build(spec.hostId, {
				snapshotId: spec.snapshotId,
				...hostTemplateBase(spec.baseImage, spec.baseDigest),
				...(spec.setup === undefined ? {} : { setup: spec.setup }),
				...(spec.image === undefined ? {} : { image: { ...spec.image } }),
				env: { ...spec.env },
				vcpus: spec.shape.vcpus,
				memoryMiB: spec.shape.memoryMb,
				keyHash: spec.keyHash,
				owner: spec.accountId,
				...egressOf(spec.egress),
			});
			return {
				ref: `${spec.hostId}/${built.ref}`,
				hostId: spec.hostId,
				...(built.imageDigest === undefined ? {} : { imageDigest: built.imageDigest }),
				sizeBytes: built.sizeBytes,
				...(built.rootfsKey === undefined || spec.image === undefined ? {} : { rootfsKey: built.rootfsKey }),
			};
		},
		async deleteTemplateSnapshot(bytes) {
			// A host names a template snapshot's bytes by its ID, which its ref is too.
			const { hostId, snapshotId: id } =
				bytes.ref === undefined ? { hostId: bytes.hostId, snapshotId: bytes.snapshotId } : parseRef(bytes.ref);
			await hosts.templates.delete(hostId, id);
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
			const env = { KANTEL_PUBLIC_KEY: key ?? "" };
			type Run = { exitCode: number; stdout: string; stderr: string };
			// An injected agent serves SSH itself, with its own host key, and needs neither a shell nor ssh-keygen: its
			// ssh-access step first. An image that ships its agent (and sshd) has no /.kantel, so the script runs.
			const injected = await call<Run>(sandboxId, "sandbox.exec", { argv: [INJECTED_AGENT, "ssh-access"], env }).catch(
				() => undefined,
			);
			const run =
				injected?.exitCode === 0
					? injected
					: await call<Run>(sandboxId, "sandbox.exec", { command: SSH_ACCESS_SCRIPT, env });
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
		async openE2E(sandboxId, { ttlMinutes, grantee }) {
			const placement = await hosts.sandboxes.placement(sandboxId);
			if (placement === undefined) throw new KantelError("not_found", "The sandbox isn't on a host");
			// The ticket is for the host's E2E responder, not a port of the sandbox: the device authenticates the host by the
			// key the space's chain lists for `hostId`, so what the relay passes is only ever ciphertext.
			return { url: await tunnel(sandboxId, HOST_E2E_PORT, ttlMinutes, grantee), hostId: placement.hostId };
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
			// Chromium's browser-wide DevTools target, passed through the tunnel with its path. The same command says where
			// this machine's Chromium runs now (BROWSER_SURFACE_CHECK): the image's report is from one boot of it, and this
			// machine's display follows its own boot, its memory's and its setup.
			const version = await call<{ exitCode: number; stdout: string }>(sandboxId, "sandbox.exec", {
				command: `${BROWSER_SURFACE_CHECK}curl -fsS --max-time 5 http://127.0.0.1:9222/json/version`,
			});
			const ownDisplay = version.stdout.startsWith(BROWSER_SURFACE_MARK);
			let target: string | undefined;
			try {
				const json = ownDisplay ? version.stdout.slice(BROWSER_SURFACE_MARK.length) : version.stdout;
				const parsed = JSON.parse(json) as { webSocketDebuggerUrl?: unknown };
				if (typeof parsed.webSocketDebuggerUrl === "string") target = new URL(parsed.webSocketDebuggerUrl).pathname;
			} catch {
				target = undefined;
			}
			if (version.exitCode !== 0 || target === undefined || !target.startsWith("/devtools/browser/")) {
				throw new KantelError("unavailable", "The sandbox's browser isn't up yet");
			}
			const cdpUrl = `${await tunnel(sandboxId, BROWSER_PORT, ttlMinutes, grantee)}${target}`;
			// People watch and drive Chromium where it runs: on its own display, whose stream the guest starts for the first
			// viewer, or, in an image without one, on the desktop.
			if (ownDisplay) {
				const url = await desktopPage(sandboxId, ttlMinutes, viewOnly, grantee, BROWSER_STREAM_PORT);
				return { url, cdpUrl, surface: "browser" };
			}
			return { url: await desktopPage(sandboxId, ttlMinutes, viewOnly, grantee), cdpUrl, surface: "desktop" };
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
