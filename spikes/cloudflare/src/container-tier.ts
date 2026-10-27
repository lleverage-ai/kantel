import { DurableObject } from "cloudflare:workers";
import type { ExecRequest, ExecResult, WorkspaceChange, WorkspaceVersion } from "./contracts.ts";
import { diffManifests, R2Workspace } from "./workspace.ts";

type Put = { path: string; mode: number; content: string };
type ContainerExecBody = {
  stdout: string;
  stderr: string;
  exitCode: number;
  base: string;
  changes: { put: Put[]; remove: string[] };
  timings: Record<string, number>;
  container: { bootedAt: number; execs: number };
};

export type ContainerExecArgs = ExecRequest & {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly base: WorkspaceVersion;
};

const PORT = 8080;
const INACTIVITY_MS = 3 * 60_000;
/** Instance size, chosen per start under the durable_object scheduling policy. */
const INSTANCE = "standard-1";
const SYNC_CONCURRENCY = 32;

/**
 * The container tier: one Durable Object per container, using the Durable Object Container API directly
 * (`durable_object` scheduling policy, so the object picks the image and instance size at start).
 *
 * No internet: `enableInternet: false`, and every HTTP and HTTPS request the container makes is intercepted and handed
 * to VaultGateway with tier "container", which applies the same policies as for the isolate.
 */
export class HarbourContainer extends DurableObject<Env> {
  /** The version the container's working copy matches, as far as this object knows. Lost on eviction, which is safe. */
  #held: WorkspaceVersion | null = null;

  #container(): Container {
    const container = this.ctx.container;
    if (container === undefined) throw new Error("no container attached to this Durable Object");
    return container;
  }

  async #start(sessionId: string): Promise<Record<string, number>> {
    const container = this.#container();
    const timings: Record<string, number> = {};
    let at = performance.now();
    const image = container.images.sandbox;
    if (image === undefined) throw new Error("image 'sandbox' missing from ctx.container.images");
    container.start({ image, instance: INSTANCE, enableInternet: false } as ContainerStartupOptions);
    this.ctx.waitUntil(container.monitor().catch((error) => console.error(JSON.stringify({ message: "container exited", error: String(error) }))));
    // Route all egress through the vault before the agent can make a request.
    const vault = this.ctx.exports.VaultGateway({ props: { sessionId, tier: "container" } });
    await container.interceptAllOutboundHttp(vault);
    await container.interceptOutboundHttps("*", vault);
    await container.setInactivityTimeout(INACTIVITY_MS);
    timings["container.start"] = round(performance.now() - at);
    at = performance.now();
    const port = container.getTcpPort(PORT);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await port.fetch("http://container/health");
        if (response.ok) break;
      } catch {
        // Not listening yet.
      }
      if (performance.now() - at > 60_000) throw new Error("container did not become ready within 60 s");
      await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 50 : 250));
    }
    timings["container.ready"] = round(performance.now() - at);
    return timings;
  }

  async #fetch(path: string, body?: unknown): Promise<Response> {
    return this.#container()
      .getTcpPort(PORT)
      .fetch(`http://container${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? "{}" : JSON.stringify(body),
      });
  }

  async exec(args: ContainerExecArgs): Promise<ExecResult & { container: ContainerExecBody["container"] }> {
    let timings: Record<string, number> = {};
    // A running container belongs to the session and workspace that started it: its working copy and its egress
    // audit are theirs. Stored durably, since this object can be evicted while the container keeps running.
    const owner = `${args.sessionId}/${args.workspaceId}`;
    if (!this.#container().running) {
      this.#held = null;
      // Claimed before starting, so a call that interleaves with the start sees the right owner.
      await this.ctx.storage.put("owner", owner);
      timings = await this.#start(args.sessionId);
    } else if ((await this.ctx.storage.get<string>("owner")) !== owner) {
      throw new Error("this container is in use by another session or workspace");
    }
    let at = performance.now();
    const step = (phase: string) => {
      const now = performance.now();
      timings[phase] = round(now - at);
      at = now;
    };

    const workspace = new R2Workspace(this.env.WORKSPACES, args.workspaceId);
    let body: ContainerExecBody | undefined;
    for (let attempt = 0; attempt < 2 && body === undefined; attempt += 1) {
      const sync = await this.#sync(workspace, this.#held, args.base);
      step(attempt === 0 ? "container.diff" : "container.resync");
      const response = await this.#fetch("/exec", {
        sync,
        command: args.command,
        cwd: args.cwd,
        env: args.env,
        timeoutMs: args.timeoutMs,
      });
      if (response.status === 409) {
        const { have } = (await response.json()) as { have: string | null };
        if (have === null) await this.#fetch("/reset");
        this.#held = have;
        continue;
      }
      if (!response.ok) throw new Error(`container exec failed: ${response.status} ${await response.text()}`);
      body = (await response.json()) as ContainerExecBody;
      this.#held = args.base;
    }
    if (body === undefined) throw new Error("container stayed out of sync after a full resync");
    step("container.request");

    const changes: WorkspaceChange[] = [];
    for (const file of body.changes.put) {
      const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
      const hash = await workspace.putBlob(bytes);
      changes.push({ kind: "put", path: file.path, hash, size: bytes.byteLength, mode: file.mode });
    }
    for (const path of body.changes.remove) changes.push({ kind: "delete", path });
    let version = args.base;
    if (changes.length > 0) {
      try {
        version = await workspace.commit(args.base, changes);
      } catch (error) {
        await this.#fetch("/reset");
        this.#held = null;
        throw error;
      }
      await this.#fetch("/ack", { base: args.base, version });
      this.#held = version;
    }
    step("container.commit");

    return {
      tier: "container",
      exitCode: body.exitCode,
      stdout: body.stdout,
      stderr: body.stderr,
      base: args.base,
      version,
      changed: changes.length,
      timings: { ...timings, ...body.timings },
      container: body.container,
    };
  }

  /** Stops the container now, as the cold-start harness needs. */
  async release(): Promise<void> {
    this.#held = null;
    const container = this.ctx.container;
    if (container?.running) await container.destroy();
    await this.ctx.storage.delete("owner");
  }

  async #sync(workspace: R2Workspace, from: WorkspaceVersion | null, to: WorkspaceVersion) {
    if (from === to) return { from, to, put: [], remove: [] };
    const target = await workspace.manifest(to);
    const source = from === null ? undefined : await workspace.manifest(from);
    const diff = diffManifests(source, target);
    const put: Put[] = [];
    // R2 reads in parallel batches: one at a time costs a round trip per file.
    for (let i = 0; i < diff.put.length; i += SYNC_CONCURRENCY) {
      const batch = diff.put.slice(i, i + SYNC_CONCURRENCY);
      const bodies = await Promise.all(batch.map((entry) => workspace.readBlob(entry.hash)));
      for (const [j, entry] of batch.entries()) {
        const bytes = bodies[j];
        if (bytes === null || bytes === undefined) throw new Error(`missing blob ${entry.hash} for ${entry.path}`);
        put.push({ path: entry.path, mode: entry.mode, content: toBase64(bytes) });
      }
    }
    return { from, to, put, remove: diff.remove };
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function round(ms: number) {
  return Math.round(ms * 10) / 10;
}
