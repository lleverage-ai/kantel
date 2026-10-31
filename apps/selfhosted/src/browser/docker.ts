// The self-hosted browser host's machines: one Docker container of images/browser per browser, through the Docker
// Engine API on its unix socket. After brwsr's local container manager (tvdavies/brwsr@0d22bf8,
// scripts/dev-containers.mjs), which stands in for Cloudflare Containers the same way.
//
// - Runtime: KANTEL_BROWSER_RUNTIME (runc by default; runsc or runsc-kvm put Chromium under gVisor as well as its own
//   sandbox).
// - Network: with KANTEL_BROWSER_NETWORK the container joins that network and the host reaches its agent by address,
//   as in the compose stack; without it the agent's port is published on 127.0.0.1 only, for a host on the machine.
//   Either way only the agent's port is reachable, and the agent answers only calls with the per-start token.
// - Labels: `harbour.browser-host` (the stack) and `harbour.browser` (the browser ID), so the janitor removes only its
//   own stack's leftovers on a shared daemon.
// - Limits: KANTEL_BROWSER_MEMORY_MB (default 2048) and KANTEL_BROWSER_CPUS (default 1).
//
// It runs on node:http (and so on Bun's node:http too).

import http from "node:http";
import type { BrowserMachine } from "@kantel/browser/runtime";

export interface DockerOptions {
	readonly socket: string;
	readonly image: string;
	readonly stack: string;
	readonly runtime?: string;
	readonly network?: string;
	readonly memoryBytes: number;
	readonly nanoCpus: number;
}

export const AGENT_PORT = 8080;

interface DockerAnswer {
	readonly status: number;
	readonly body: string;
}

/** One Docker Engine API call. */
export function docker(socket: string, method: string, path: string, body?: unknown): Promise<DockerAnswer> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const request = http.request(
			{
				socketPath: socket,
				method,
				path,
				headers:
					payload === undefined
						? {}
						: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
				);
				response.on("error", reject);
			},
		);
		request.on("error", reject);
		request.setTimeout(60_000, () => request.destroy(new Error(`docker ${method} ${path} timed out`)));
		if (payload !== undefined) request.write(payload);
		request.end();
	});
}

const containerName = (stack: string, browserId: string) =>
	`harbour-browser-${stack}-${browserId}`.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 120);

/** Where the agent of a running container answers: an address on the network, or the published local port. */
export interface AgentAddress {
	readonly host: string;
	readonly port: number;
}

export interface DockerBrowserMachine extends BrowserMachine {
	/** Where the agent answers, once the container is running. */
	address(): AgentAddress | undefined;
}

export function dockerMachine(options: DockerOptions, browserId: string): DockerBrowserMachine {
	const name = containerName(options.stack, browserId);
	let address: AgentAddress | undefined;

	const inspect = async (): Promise<AgentAddress | undefined> => {
		const answer = await docker(options.socket, "GET", `/containers/${name}/json`);
		if (answer.status !== 200) return undefined;
		const info = JSON.parse(answer.body) as {
			State?: { Running?: boolean };
			NetworkSettings?: {
				Ports?: { [port: string]: { HostIp: string; HostPort: string }[] | null };
				Networks?: { [network: string]: { IPAddress?: string } };
			};
		};
		if (info.State?.Running !== true) return undefined;
		if (options.network !== undefined) {
			const ip = info.NetworkSettings?.Networks?.[options.network]?.IPAddress;
			return ip ? { host: ip, port: AGENT_PORT } : undefined;
		}
		const published = info.NetworkSettings?.Ports?.[`${AGENT_PORT}/tcp`]?.[0]?.HostPort;
		return published ? { host: "127.0.0.1", port: Number(published) } : undefined;
	};

	return {
		async start(env) {
			address = await inspect();
			if (address !== undefined) return;
			await docker(options.socket, "DELETE", `/containers/${name}?force=true`);
			const created = await docker(options.socket, "POST", `/containers/create?name=${encodeURIComponent(name)}`, {
				Image: options.image,
				Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
				Labels: { "harbour.browser-host": options.stack, "harbour.browser": browserId },
				ExposedPorts: { [`${AGENT_PORT}/tcp`]: {} },
				HostConfig: {
					...(options.runtime === undefined ? {} : { Runtime: options.runtime }),
					Memory: options.memoryBytes,
					NanoCpus: options.nanoCpus,
					ShmSize: 256 * 1024 * 1024,
					...(options.network === undefined
						? { PortBindings: { [`${AGENT_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] } }
						: { NetworkMode: options.network }),
				},
			});
			if (created.status !== 201)
				throw new Error(`docker create ${name}: ${created.status} ${created.body.slice(0, 300)}`);
			const started = await docker(options.socket, "POST", `/containers/${name}/start`);
			if (started.status !== 204 && started.status !== 304) {
				throw new Error(`docker start ${name}: ${started.status} ${started.body.slice(0, 300)}`);
			}
			for (let i = 0; i < 50 && address === undefined; i++) {
				address = await inspect();
				if (address === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (address === undefined) throw new Error(`docker ${name} has no address`);
		},
		async fetch(path, init) {
			if (address === undefined) address = await inspect();
			if (address === undefined) throw new Error(`browser ${browserId} is not running`);
			return fetch(`http://${address.host}:${address.port}${path}`, init);
		},
		async stop() {
			address = undefined;
			await docker(options.socket, "DELETE", `/containers/${name}?force=true`);
		},
		address: () => address,
	};
}

/** Removes every container of this stack's browser host: what a previous run of the host left behind. */
export async function removeLeftovers(options: DockerOptions, keep: ReadonlySet<string>): Promise<number> {
	const filters = encodeURIComponent(JSON.stringify({ label: [`harbour.browser-host=${options.stack}`] }));
	const listed = await docker(options.socket, "GET", `/containers/json?all=1&filters=${filters}`);
	if (listed.status !== 200) return 0;
	let removed = 0;
	for (const container of JSON.parse(listed.body) as { Id: string; Labels?: { [key: string]: string } }[]) {
		const browserId = container.Labels?.["harbour.browser"] ?? "";
		if (keep.has(browserId)) continue;
		await docker(options.socket, "DELETE", `/containers/${container.Id}?force=true`);
		removed += 1;
	}
	return removed;
}
