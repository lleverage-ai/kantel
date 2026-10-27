/**
 * A minimal Docker Engine API client over the daemon's unix socket, using node:http: JSON requests, archive PUT and
 * GET, exec with demultiplexed output and its exit code, containers, volumes and networks. Only what the container
 * tier uses.
 *
 * Every failure is a HarbourError: `unavailable` for the daemon being unreachable, slow or refusing a request (with the
 * HTTP status in `details.status`), and `aborted` when an exec runs past its deadline.
 */
import { Agent, request as httpRequest } from "node:http";
import { type ErrorCode, HarbourError } from "@harbour/contracts";
import { concatBytes } from "./tar.ts";

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const decoder = new TextDecoder();

export interface DockerClientOptions {
	/** Default /var/run/docker.sock. */
	readonly socketPath?: string;
	/** Deadline for an ordinary API request (not an exec); default 30 s. */
	readonly requestTimeoutMs?: number;
}

export interface DockerRequest {
	readonly method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
	readonly path: string;
	readonly json?: unknown;
	readonly body?: Uint8Array;
	readonly contentType?: string;
	/** Statuses besides 2xx that are not errors, such as 304 or 404. */
	readonly allow?: readonly number[];
	readonly timeoutMs?: number;
	/** The error code for a request that runs past `timeoutMs`; `unavailable` by default. */
	readonly timeoutCode?: ErrorCode;
	/** Use a connection of its own, never reused: for exec start, whose connection Docker hijacks. */
	readonly fresh?: boolean;
}

export interface DockerResponse {
	readonly status: number;
	readonly body: Uint8Array;
}

export interface ContainerSummary {
	readonly Id: string;
	readonly Names?: readonly string[];
	readonly State?: string;
	readonly Labels: Readonly<Record<string, string>>;
}

export interface VolumeSummary {
	readonly Name: string;
	readonly Labels: Readonly<Record<string, string>> | null;
}

export interface NetworkSummary {
	readonly Id: string;
	readonly Containers?: Readonly<Record<string, { readonly Name: string; readonly IPv4Address: string }>>;
}

export interface ExecOptions {
	readonly cmd: readonly string[];
	/** `uid:gid` or a name; the container's user when absent. */
	readonly user?: string;
	readonly env?: readonly string[];
	readonly workingDir?: string;
	/** Past this the call rejects with `aborted` (the process may still be running in the container). */
	readonly timeoutMs?: number;
}

export interface ExecOutput {
	readonly exitCode: number;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}

/**
 * Splits Docker's multiplexed stream (a container's logs, an exec without a TTY) into stdout and stderr. Each frame is
 * an 8-byte header (stream: 1 stdout, 2 stderr; then a big-endian 32-bit length) and its payload. Frames may arrive
 * split across chunks.
 */
export class StreamDemuxer {
	readonly #stdout: Uint8Array[] = [];
	readonly #stderr: Uint8Array[] = [];
	readonly #header = new Uint8Array(8);
	#headerFill = 0;
	#stream = 0;
	#remaining = 0;

	push(chunk: Uint8Array): void {
		let offset = 0;
		while (offset < chunk.length) {
			if (this.#remaining === 0) {
				const take = Math.min(8 - this.#headerFill, chunk.length - offset);
				this.#header.set(chunk.subarray(offset, offset + take), this.#headerFill);
				this.#headerFill += take;
				offset += take;
				if (this.#headerFill === 8) {
					this.#stream = this.#header[0] ?? 1;
					this.#remaining = new DataView(this.#header.buffer).getUint32(4);
					this.#headerFill = 0;
				}
				continue;
			}
			const take = Math.min(this.#remaining, chunk.length - offset);
			(this.#stream === 2 ? this.#stderr : this.#stdout).push(chunk.slice(offset, offset + take));
			this.#remaining -= take;
			offset += take;
		}
	}

	get stdout(): Uint8Array {
		return concatBytes(this.#stdout);
	}

	get stderr(): Uint8Array {
		return concatBytes(this.#stderr);
	}
}

/** Demultiplexes a whole stream at once. */
export function demux(bytes: Uint8Array): { stdout: Uint8Array; stderr: Uint8Array } {
	const demuxer = new StreamDemuxer();
	demuxer.push(bytes);
	return { stdout: demuxer.stdout, stderr: demuxer.stderr };
}

const filters = (value: Readonly<Record<string, readonly string[]>>) => encodeURIComponent(JSON.stringify(value));

export class DockerClient {
	readonly socketPath: string;
	readonly #requestTimeoutMs: number;
	readonly #agent = new Agent({ keepAlive: true, maxSockets: 32 });

	constructor(options: DockerClientOptions = {}) {
		this.socketPath = options.socketPath ?? DEFAULT_DOCKER_SOCKET;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/** Sends a request and buffers the response body. */
	request(init: DockerRequest): Promise<DockerResponse> {
		const chunks: Uint8Array[] = [];
		return this.#send(init, (chunk) => chunks.push(chunk)).then((status) => ({ status, body: concatBytes(chunks) }));
	}

	async json<T>(init: DockerRequest): Promise<T> {
		const response = await this.request(init);
		if (response.body.length === 0) return undefined as T;
		try {
			return JSON.parse(decoder.decode(response.body)) as T;
		} catch {
			throw new HarbourError("unavailable", `docker ${init.method} ${init.path}: malformed JSON response`);
		}
	}

	// ---- containers --------------------------------------------------------------------------------------------------

	async createContainer(body: unknown, name?: string): Promise<string> {
		const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
		const created = await this.json<{ Id: string }>({ method: "POST", path: `/containers/create${query}`, json: body });
		return created.Id;
	}

	async startContainer(id: string): Promise<void> {
		await this.request({ method: "POST", path: `/containers/${encodeURIComponent(id)}/start`, allow: [304] });
	}

	/** Removes a container, killing it if it runs, with its anonymous volumes. False when it was already gone. */
	async removeContainer(id: string): Promise<boolean> {
		const response = await this.request({
			method: "DELETE",
			path: `/containers/${encodeURIComponent(id)}?force=1&v=1`,
			allow: [404],
		});
		return response.status !== 404;
	}

	/** Containers, running or not, carrying every one of `labels` (`key` or `key=value`). */
	listContainers(labels: readonly string[]): Promise<ContainerSummary[]> {
		return this.json<ContainerSummary[]>({
			method: "GET",
			path: `/containers/json?all=1&filters=${filters({ label: labels })}`,
		});
	}

	/** Extracts a tar archive into the directory `path` of the container. */
	async putArchive(id: string, path: string, archive: Uint8Array): Promise<void> {
		await this.request({
			method: "PUT",
			path: `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`,
			body: archive,
			contentType: "application/x-tar",
		});
	}

	/** A tar archive of `path` in the container. */
	async getArchive(id: string, path: string): Promise<Uint8Array> {
		const response = await this.request({
			method: "GET",
			path: `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`,
		});
		return response.body;
	}

	// ---- exec ----------------------------------------------------------------------------------------------------------

	/**
	 * Runs a process in a running container and waits for it: exec create, then exec start (the response is the
	 * multiplexed output, until the process and everything holding its output have exited), then exec inspect for the
	 * exit code.
	 */
	async exec(id: string, options: ExecOptions): Promise<ExecOutput> {
		const created = await this.json<{ Id: string }>({
			method: "POST",
			path: `/containers/${encodeURIComponent(id)}/exec`,
			json: {
				AttachStdin: false,
				AttachStdout: true,
				AttachStderr: true,
				Tty: false,
				Cmd: options.cmd,
				...(options.user === undefined ? {} : { User: options.user }),
				...(options.env === undefined ? {} : { Env: options.env }),
				...(options.workingDir === undefined ? {} : { WorkingDir: options.workingDir }),
			},
		});
		const output = new StreamDemuxer();
		await this.#send(
			{
				method: "POST",
				path: `/exec/${encodeURIComponent(created.Id)}/start`,
				json: { Detach: false, Tty: false },
				timeoutMs: options.timeoutMs ?? this.#requestTimeoutMs,
				timeoutCode: "aborted",
				fresh: true,
			},
			(chunk) => output.push(chunk),
		);
		// The stream ends when the process does; inspect can lag it by a moment.
		for (let attempt = 0; ; attempt++) {
			const inspected = await this.json<{ ExitCode: number | null; Running: boolean }>({
				method: "GET",
				path: `/exec/${encodeURIComponent(created.Id)}/json`,
			});
			if (!inspected.Running && inspected.ExitCode !== null) {
				return { exitCode: inspected.ExitCode, stdout: output.stdout, stderr: output.stderr };
			}
			if (attempt >= 50) {
				throw new HarbourError(
					"unavailable",
					`docker exec ${created.Id}: output ended but the process is still running`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	// ---- volumes and networks --------------------------------------------------------------------------------------

	async createVolume(labels: Readonly<Record<string, string>>): Promise<string> {
		const created = await this.json<{ Name: string }>({
			method: "POST",
			path: "/volumes/create",
			json: { Labels: labels },
		});
		return created.Name;
	}

	/** Removes a volume. False when it was already gone or is still in use. */
	async removeVolume(name: string): Promise<boolean> {
		const response = await this.request({
			method: "DELETE",
			path: `/volumes/${encodeURIComponent(name)}`,
			allow: [404, 409],
		});
		return response.status < 300;
	}

	async listVolumes(labels: readonly string[]): Promise<VolumeSummary[]> {
		const listed = await this.json<{ Volumes: VolumeSummary[] | null }>({
			method: "GET",
			path: `/volumes?filters=${filters({ label: labels })}`,
		});
		return listed.Volumes ?? [];
	}

	async inspectNetwork(name: string): Promise<NetworkSummary> {
		return this.json<NetworkSummary>({ method: "GET", path: `/networks/${encodeURIComponent(name)}` });
	}

	/** Closes pooled connections. */
	close(): void {
		this.#agent.destroy();
	}

	// ---- internals -------------------------------------------------------------------------------------------------

	/** Sends `init`, handing each body chunk to `sink`; resolves with the status once the body has ended. */
	#send(init: DockerRequest, sink: (chunk: Uint8Array) => void): Promise<number> {
		const label = `docker ${init.method} ${init.path.split("?")[0]}`;
		const timeoutMs = init.timeoutMs ?? this.#requestTimeoutMs;
		let body: Uint8Array | undefined;
		const headers: Record<string, string> = { host: "docker" };
		if (init.json !== undefined) {
			body = new TextEncoder().encode(JSON.stringify(init.json));
			headers["content-type"] = "application/json";
		} else if (init.body !== undefined) {
			body = init.body;
			headers["content-type"] = init.contentType ?? "application/octet-stream";
		}
		if (body !== undefined) headers["content-length"] = String(body.length);
		return new Promise<number>((resolve, reject) => {
			let settled = false;
			let timedOut = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error: HarbourError | undefined, status?: number) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				if (error !== undefined) reject(error);
				else resolve(status ?? 0);
			};
			const request = httpRequest(
				{
					socketPath: this.socketPath,
					path: init.path,
					method: init.method,
					headers,
					...(init.fresh === true ? { agent: false } : { agent: this.#agent }),
				},
				(response) => {
					const status = response.statusCode ?? 0;
					const ok = (status >= 200 && status < 300) || (init.allow ?? []).includes(status);
					const failure: Uint8Array[] = [];
					response.on("data", (chunk: Buffer) => {
						const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
						if (ok) sink(bytes);
						else failure.push(bytes.slice());
					});
					response.on("end", () => {
						if (ok) return finish(undefined, status);
						finish(
							new HarbourError("unavailable", `${label} failed: ${status} ${errorMessage(failure)}`, {
								status,
							}),
						);
					});
					response.on("error", (error) => finish(transportError(label, error, timedOut, init, timeoutMs)));
					// A hijacked exec stream ends with the connection rather than a terminating chunk.
					response.on("close", () => {
						if (!response.complete && !settled) {
							if (ok && init.fresh === true && !timedOut) return finish(undefined, status);
							finish(transportError(label, new Error("connection closed"), timedOut, init, timeoutMs));
						}
					});
				},
			);
			timer = setTimeout(() => {
				timedOut = true;
				request.destroy(new Error("timed out"));
				finish(transportError(label, new Error("timed out"), true, init, timeoutMs));
			}, timeoutMs);
			request.on("error", (error) => finish(transportError(label, error, timedOut, init, timeoutMs)));
			request.end(body === undefined ? undefined : Buffer.from(body.buffer, body.byteOffset, body.byteLength));
		});
	}
}

function errorMessage(parts: readonly Uint8Array[]): string {
	const text = decoder.decode(concatBytes(parts)).trim();
	try {
		const parsed = JSON.parse(text) as { message?: unknown };
		if (typeof parsed.message === "string") return parsed.message;
	} catch {
		// Not JSON: the text itself.
	}
	return text.slice(0, 500);
}

function transportError(
	label: string,
	error: Error,
	timedOut: boolean,
	init: DockerRequest,
	timeoutMs: number,
): HarbourError {
	if (timedOut) {
		return new HarbourError(init.timeoutCode ?? "unavailable", `${label} timed out after ${timeoutMs} ms`, {
			timeoutMs,
		});
	}
	return new HarbourError("unavailable", `${label}: ${error.message}`);
}
