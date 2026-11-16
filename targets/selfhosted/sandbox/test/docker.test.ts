/**
 * DockerClient deadlines against a stub Docker API on a unix socket that answers every request after a delay. No
 * Docker daemon needed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "../src/docker.ts";

const DELAY_MS = 300;

interface Stub {
	readonly socketPath: string;
	readonly seen: string[];
	close(): Promise<void>;
}

/** Answers like dockerd would, `DELAY_MS` late, as when it is stuck in a forced removal's kill path. */
async function stubDocker(): Promise<Stub> {
	const dir = await mkdtemp(join(tmpdir(), "kantel-docker-stub-"));
	const socketPath = join(dir, "docker.sock");
	const seen: string[] = [];
	const server: Server = createServer((request, response) => {
		const route = `${request.method} ${(request.url ?? "").split("?")[0]}`;
		seen.push(route);
		request.resume();
		setTimeout(() => {
			if (response.destroyed) return;
			if (route === "POST /containers/create") {
				response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ Id: "c1" }));
			} else if (route === "GET /containers/json") {
				response.writeHead(200, { "content-type": "application/json" }).end("[]");
			} else {
				response.writeHead(204).end();
			}
		}, DELAY_MS);
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		socketPath,
		seen,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("DockerClient deadlines", () => {
	const cleanups: (() => unknown)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function client(options: { requestTimeoutMs: number; lifecycleTimeoutMs: number }) {
		const stub = await stubDocker();
		cleanups.push(() => stub.close());
		const docker = new DockerClient({ socketPath: stub.socketPath, ...options });
		cleanups.push(() => docker.close());
		return { docker, stub };
	}

	it("gives container create, start and remove the lifecycle deadline", async () => {
		const { docker, stub } = await client({ requestTimeoutMs: 100, lifecycleTimeoutMs: 5_000 });
		await expect(docker.createContainer({ Image: "x" }, "box")).resolves.toBe("c1");
		await expect(docker.startContainer("c1")).resolves.toBeUndefined();
		await expect(docker.removeContainer("c1")).resolves.toBe(true);
		expect(stub.seen).toEqual(["POST /containers/create", "POST /containers/c1/start", "DELETE /containers/c1"]);
	});

	it("keeps the ordinary deadline for other calls", async () => {
		const { docker } = await client({ requestTimeoutMs: 100, lifecycleTimeoutMs: 5_000 });
		const listed = docker.listContainers(["a"]);
		await expect(listed).rejects.toThrow(KantelError);
		await expect(listed).rejects.toThrow("docker GET /containers/json timed out after 100 ms");
		await expect(docker.removeNetwork("n1")).rejects.toThrow("timed out after 100 ms");
	});

	it("times lifecycle calls out at their own deadline", async () => {
		const { docker } = await client({ requestTimeoutMs: 5_000, lifecycleTimeoutMs: 100 });
		await expect(docker.removeContainer("c1")).rejects.toThrow("docker DELETE /containers/c1 timed out after 100 ms");
		await expect(docker.createContainer({ Image: "x" })).rejects.toThrow(
			"docker POST /containers/create timed out after 100 ms",
		);
		await expect(docker.startContainer("c1")).rejects.toThrow("timed out after 100 ms");
		await expect(docker.listContainers(["a"])).resolves.toEqual([]);
	});
});
