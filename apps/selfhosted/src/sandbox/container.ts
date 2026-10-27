// The container tier: one short-lived container per escalated command,
// started on the same workspace version the isolate last committed.
//
// - Runtime: HARBOUR_SANDBOX_RUNTIME (runc or runsc). runsc is gVisor; it needs
//   the runtime registered with the Docker daemon (see deploy/compose/README.md).
// - Network: each container gets its own `internal` network whose only other
//   member is the vault proxy (connected for the command, as `vault-proxy`),
//   so a sandbox can reach neither the internet nor another sandbox.
//   HTTP(S)_PROXY carries a per-sandbox token the vault resolves to the
//   session; the token is not a credential for anything.
// - Workspace: copied in and out through Docker's archive API, so no host path
//   is shared with the sandbox.
// - TLS: the vault intercepts HTTPS, so the vault's CA goes in with the
//   workspace and every TLS client is pointed at it.

import type pg from "pg";
import type {
	Manifest,
	SandboxExecRequest,
	SandboxExecResult,
	SandboxTierRunner,
} from "../../../../spike/contracts/index.ts";
import type { MinioWorkspace } from "../workspace.ts";
import { sha256Hex } from "../workspace.ts";
import { readTar, type TarEntry, writeTar } from "./tar.ts";

export interface ContainerRunnerOptions {
	socket: string;
	image: string;
	runtime: string;
	/** Name prefix of the per-command sandbox networks. */
	network: string;
	/** The vault proxy's container, connected to each sandbox network. */
	vaultContainer: string;
	proxyUrl: string;
	memoryBytes: number;
	nanoCpus: number;
}

const decoder = new TextDecoder();
const CA_PATH = "/etc/harbour/ca.crt";

/** Docker's multiplexed log stream: 8-byte frame headers, stream 1 stdout, 2 stderr. */
function demux(bytes: Uint8Array): { stdout: string; stderr: string } {
	const out: Uint8Array[] = [];
	const err: Uint8Array[] = [];
	let offset = 0;
	while (offset + 8 <= bytes.length) {
		const stream = bytes[offset];
		const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0);
		const frame = bytes.subarray(offset + 8, offset + 8 + size);
		(stream === 2 ? err : out).push(frame);
		offset += 8 + size;
	}
	const join = (parts: Uint8Array[]) => decoder.decode(Buffer.concat(parts));
	return { stdout: join(out), stderr: join(err) };
}

export class ContainerRunner implements SandboxTierRunner {
	readonly tier = "container" as const;

	/** The host incarnation that starts containers, for the dead-owner janitor. */
	owner = "unknown";

	constructor(
		private readonly options: ContainerRunnerOptions,
		private readonly workspace: MinioWorkspace,
		private readonly pool: pg.Pool,
	) {}

	async docker(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
		const { json, ...rest } = init;
		const response = await fetch(`http://docker${path}`, {
			...rest,
			...(json === undefined ? {} : { body: JSON.stringify(json), headers: { "content-type": "application/json" } }),
			unix: this.options.socket,
		} as RequestInit);
		if (!response.ok && response.status !== 304) {
			throw new Error(`docker ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
		}
		return response;
	}

	/**
	 * Remove sandbox containers whose owning host incarnation is dead (its
	 * liveness lock is gone), whatever session they were for. Catches what a
	 * killed host left between `create` and its own cleanup.
	 */
	async reapDeadOwners(isAlive: (owner: string) => Promise<boolean>): Promise<number> {
		const filters = encodeURIComponent(JSON.stringify({ label: ["harbour.owner"] }));
		const list = (await (await this.docker(`/containers/json?all=1&filters=${filters}`)).json()) as {
			Id: string;
			Labels: Record<string, string>;
		}[];
		let removed = 0;
		const alive = new Map<string, boolean>();
		const dead = async (owner: string | undefined) => {
			if (owner === undefined) return false;
			if (!alive.has(owner)) alive.set(owner, await isAlive(owner));
			return alive.get(owner) === false;
		};
		for (const container of list) {
			if (!(await dead(container.Labels["harbour.owner"]))) continue;
			await this.docker(`/containers/${container.Id}?force=1`, { method: "DELETE" }).catch(() => undefined);
			removed++;
		}
		for (const network of await this.#networks({ label: ["harbour.owner"] })) {
			if (await dead(network.Labels["harbour.owner"])) await this.#removeNetwork(network.Id);
		}
		return removed;
	}

	/** Remove containers (and their networks) a dead owner left behind for this session. */
	async reap(sessionId: string): Promise<number> {
		const filters = encodeURIComponent(JSON.stringify({ label: [`harbour.session=${sessionId}`] }));
		const list = (await (await this.docker(`/containers/json?all=1&filters=${filters}`)).json()) as { Id: string }[];
		for (const container of list) await this.docker(`/containers/${container.Id}?force=1`, { method: "DELETE" });
		for (const network of await this.#networks({ label: [`harbour.session=${sessionId}`] })) await this.#removeNetwork(network.Id);
		return list.length;
	}

	async #networks(filter: Record<string, string[]>): Promise<{ Id: string; Labels: Record<string, string> }[]> {
		const filters = encodeURIComponent(JSON.stringify(filter));
		return (await (await this.docker(`/networks?filters=${filters}`)).json()) as { Id: string; Labels: Record<string, string> }[];
	}

	/** A new internal network for one command, with the vault on it as `vault-proxy`. */
	async #createNetwork(sessionId: string, token: string): Promise<string> {
		const created = (await (
			await this.docker("/networks/create", {
				method: "POST",
				json: {
					Name: `${this.options.network}-${token.slice(0, 12)}`,
					Driver: "bridge",
					Internal: true,
					Labels: { "harbour.session": sessionId, "harbour.owner": this.owner },
				},
			})
		).json()) as { Id: string };
		try {
			await this.docker(`/networks/${created.Id}/connect`, {
				method: "POST",
				json: { Container: this.options.vaultContainer, EndpointConfig: { Aliases: ["vault-proxy"] } },
			});
		} catch (error) {
			await this.#removeNetwork(created.Id);
			throw error;
		}
		return created.Id;
	}

	async #removeNetwork(id: string): Promise<void> {
		await this.docker(`/networks/${id}/disconnect`, {
			method: "POST",
			json: { Container: this.options.vaultContainer, Force: true },
		}).catch(() => undefined);
		await this.docker(`/networks/${id}`, { method: "DELETE" }).catch(() => undefined);
	}

	#ca: { pem: Uint8Array; at: number } | undefined;

	/**
	 * The vault's CA certificate. The vault intercepts the sandbox's HTTPS to
	 * apply policy and inject credentials, so this is the only CA a sandbox
	 * needs: it has no route out except through the vault.
	 */
	async #vaultCa(): Promise<Uint8Array> {
		if (this.#ca !== undefined && Date.now() - this.#ca.at < 60_000) return this.#ca.pem;
		const response = await fetch(`${this.options.proxyUrl}/ca.crt`, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) throw new Error(`vault CA: ${response.status}`);
		this.#ca = { pem: new Uint8Array(await response.arrayBuffer()), at: Date.now() };
		return this.#ca.pem;
	}

	async #tarOf(workspaceId: string, manifest: Manifest): Promise<Uint8Array> {
		const entries: TarEntry[] = [
			{ type: "dir", path: "etc/harbour", mode: 0o755 },
			{ type: "file", path: CA_PATH.slice(1), mode: 0o644, data: await this.#vaultCa() },
			{ type: "dir", path: "workspace", mode: 0o755 },
		];
		const paths = Object.keys(manifest).sort();
		const blobs = await Promise.all(
			paths.map(async (path) => {
				const entry = manifest[path]!;
				return entry.kind === "file" ? this.workspace.readBlob(workspaceId, entry.sha) : undefined;
			}),
		);
		paths.forEach((path, i) => {
			const entry = manifest[path]!;
			const full = `workspace/${path}`;
			if (entry.kind === "dir") entries.push({ type: "dir", path: full, mode: 0o755 });
			else if (entry.kind === "symlink") entries.push({ type: "symlink", path: full, target: entry.target });
			else entries.push({ type: "file", path: full, mode: entry.mode, data: blobs[i]! });
		});
		return writeTar(entries);
	}

	async exec(request: SandboxExecRequest, manifest: Manifest, signal?: AbortSignal): Promise<SandboxExecResult> {
		const t0 = performance.now();
		const marks: Record<string, number> = {};
		const mark = (name: string) => {
			marks[name] = Math.round((performance.now() - t0) * 10) / 10;
		};
		const token = crypto.randomUUID();
		await this.pool.query(
			`INSERT INTO harbour.sandbox_tokens (token, session_id, tier, expires_at)
			 VALUES ($1, $2, 'container', now() + interval '1 hour')`,
			[token, request.sessionId],
		);
		const proxy = this.options.proxyUrl.replace("://", `://sbx:${token}@`);
		const cwd = `/workspace/${(request.cwd ?? "").replace(/^\/?workspace\/?/, "").replace(/^\/+/, "")}`.replace(/\/+$/, "");
		const pendingNetwork = this.#createNetwork(request.sessionId, token);
		pendingNetwork.catch(() => undefined); // awaited below; mark handled while the tar builds
		let network: string | undefined;
		let id: string | undefined;
		try {
			const archive = await this.#tarOf(request.workspaceId, manifest);
			mark("workspaceTarMs");
			network = await pendingNetwork;
			mark("networkMs");
			const created = (await (
				await this.docker(`/containers/create`, {
					method: "POST",
					json: {
						Image: this.options.image,
						Cmd: ["sh", "-c", request.command],
						WorkingDir: cwd || "/workspace",
						User: "1000:1000",
						Env: [
							`HTTP_PROXY=${proxy}`,
							`HTTPS_PROXY=${proxy}`,
							`http_proxy=${proxy}`,
							`https_proxy=${proxy}`,
							"NO_PROXY=",
							"HOME=/workspace",
							...["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE"].map(
								(name) => `${name}=${CA_PATH}`,
							),
							...Object.entries(request.env ?? {}).map(([k, v]) => `${k}=${v}`),
						],
						Labels: { "harbour.session": request.sessionId, "harbour.owner": this.owner, "harbour.tier": "container" },
						HostConfig: {
							NetworkMode: network,
							Runtime: this.options.runtime,
							Memory: this.options.memoryBytes,
							NanoCpus: this.options.nanoCpus,
							SecurityOpt: ["no-new-privileges"],
							CapDrop: ["NET_RAW", "MKNOD", "AUDIT_WRITE"],
						},
					},
				})
			).json()) as { Id: string };
			mark("createMs");
			id = created.Id;
			await this.docker(`/containers/${id}/archive?path=/`, {
				method: "PUT",
				body: archive as Uint8Array<ArrayBuffer>,
				headers: { "content-type": "application/x-tar" },
			});
			mark("copyInMs");
			await this.docker(`/containers/${id}/start`, { method: "POST" });
			mark("startMs");
			const timeout = request.timeoutMs ?? 120_000;
			const wait = this.docker(`/containers/${id}/wait`, { method: "POST" }).then((r) => r.json() as Promise<{ StatusCode: number }>);
			const timer = new Promise<never>((_, reject) => {
				const handle = setTimeout(() => reject(new Error(`container command timed out after ${timeout} ms`)), timeout);
				signal?.addEventListener("abort", () => {
					clearTimeout(handle);
					reject(new Error("aborted"));
				});
			});
			const { StatusCode } = await Promise.race([wait, timer]);
			mark("runMs");
			const logs = demux(new Uint8Array(await (await this.docker(`/containers/${id}/logs?stdout=1&stderr=1`)).arrayBuffer()));
			const exported = readTar(new Uint8Array(await (await this.docker(`/containers/${id}/archive?path=/workspace`)).arrayBuffer()));
			mark("copyOutMs");
			const next: Manifest = {};
			const changed: string[] = [];
			const uploads: Promise<unknown>[] = [];
			for (const entry of exported) {
				const path = entry.path.replace(/^workspace\/?/, "");
				if (path === "") continue;
				const before = manifest[path];
				if (entry.type === "dir") {
					next[path] = { kind: "dir" };
					if (before?.kind !== "dir") changed.push(path);
				} else if (entry.type === "symlink") {
					next[path] = { kind: "symlink", target: entry.target };
					if (before?.kind !== "symlink" || before.target !== entry.target) changed.push(path);
				} else {
					const sha = sha256Hex(entry.data);
					const mode = entry.mode & 0o777;
					next[path] = { kind: "file", sha, size: entry.data.length, mode };
					if (before?.kind !== "file" || before.sha !== sha || before.mode !== mode) {
						changed.push(path);
						uploads.push(this.workspace.putBlob(request.workspaceId, entry.data));
					}
				}
			}
			for (const path of Object.keys(manifest)) if (!(path in next)) changed.push(path);
			await Promise.all(uploads);
			mark("uploadMs");
			return { tier: "container", exitCode: StatusCode, ...logs, manifest: next, changed, timings: marks };
		} finally {
			if (id !== undefined) await this.docker(`/containers/${id}?force=1`, { method: "DELETE" }).catch(() => undefined);
			const made = network ?? (await pendingNetwork.catch(() => undefined));
			if (made !== undefined) await this.#removeNetwork(made);
			await this.pool.query(`DELETE FROM harbour.sandbox_tokens WHERE token = $1`, [token]).catch(() => undefined);
		}
	}
}
