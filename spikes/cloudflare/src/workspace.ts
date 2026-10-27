import {
  type Workspace,
  type WorkspaceChange,
  WorkspaceConflict,
  type WorkspaceEntry,
  type WorkspaceManifest,
  type WorkspaceVersion,
} from "./contracts.ts";

/**
 * R2-backed workspace. Layout under `ws/<id>/`:
 *   HEAD                 the current version, as text; replaced with a conditional put (etag match) on commit
 *   versions/<v>.json    immutable manifests
 *   blobs/<sha256>       content-addressed file bodies
 * The manifest is the listing, so listing never reads bodies; bodies are read lazily by hash.
 */
export class R2Workspace implements Workspace {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  /** Manifests are immutable, so a per-object cache is always valid. */
  readonly #manifests = new Map<WorkspaceVersion, WorkspaceManifest>();

  constructor(
    bucket: R2Bucket,
    readonly id: string,
  ) {
    this.#bucket = bucket;
    this.#prefix = `ws/${id}/`;
  }

  async exists(): Promise<boolean> {
    return (await this.#bucket.head(`${this.#prefix}HEAD`)) !== null;
  }

  /** Creates the workspace at v1 with the given files. Fails if it already exists. */
  async create(files: Readonly<Record<string, string | Uint8Array>>): Promise<WorkspaceVersion> {
    const entries: Record<string, WorkspaceEntry> = {};
    for (const [path, content] of Object.entries(files)) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const hash = await this.putBlob(bytes);
      const clean = normalisePath(path);
      entries[clean] = { path: clean, hash, size: bytes.byteLength, mode: 0o644 };
    }
    const manifest: WorkspaceManifest = { workspaceId: this.id, version: "v1", entries };
    await this.#bucket.put(`${this.#prefix}versions/v1.json`, JSON.stringify(manifest));
    const created = await this.#bucket.put(`${this.#prefix}HEAD`, "v1", { onlyIf: { etagDoesNotMatch: "*" } });
    if (created === null) throw new Error(`workspace ${this.id} already exists`);
    this.#manifests.set("v1", manifest);
    return "v1";
  }

  async head(): Promise<WorkspaceVersion> {
    const object = await this.#bucket.get(`${this.#prefix}HEAD`);
    if (object === null) throw new Error(`workspace ${this.id} does not exist`);
    return (await object.text()).trim();
  }

  async manifest(version: WorkspaceVersion): Promise<WorkspaceManifest> {
    const cached = this.#manifests.get(version);
    if (cached !== undefined) return cached;
    const object = await this.#bucket.get(`${this.#prefix}versions/${version}.json`);
    if (object === null) throw new Error(`workspace ${this.id} has no version ${version}`);
    const manifest = (await object.json()) as WorkspaceManifest;
    this.#manifests.set(version, manifest);
    return manifest;
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    const object = await this.#bucket.get(`${this.#prefix}blobs/${hash}`);
    return object === null ? null : new Uint8Array(await object.arrayBuffer());
  }

  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    await this.#bucket.put(`${this.#prefix}blobs/${hash}`, bytes);
    return hash;
  }

  async commit(base: WorkspaceVersion, changes: readonly WorkspaceChange[]): Promise<WorkspaceVersion> {
    const headObject = await this.#bucket.get(`${this.#prefix}HEAD`);
    if (headObject === null) throw new Error(`workspace ${this.id} does not exist`);
    const head = (await headObject.text()).trim();
    if (head !== base) throw new WorkspaceConflict(base, head);
    if (changes.length === 0) return base;

    const parent = await this.manifest(base);
    const entries: Record<string, WorkspaceEntry> = { ...parent.entries };
    for (const change of changes) {
      const path = normalisePath(change.path);
      if (change.kind === "delete") delete entries[path];
      else entries[path] = { path, hash: change.hash, size: change.size, mode: change.mode };
    }
    // The suffix keeps two racing writers from overwriting each other's manifest; only one wins the HEAD swap.
    const suffix = crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
    const version = `v${Number.parseInt(base.slice(1), 10) + 1}.${suffix}`;
    const manifest: WorkspaceManifest = { workspaceId: this.id, version, parent: base, entries };
    // A crash after this put and before HEAD leaves an orphaned manifest that nothing references.
    await this.#bucket.put(`${this.#prefix}versions/${version}.json`, JSON.stringify(manifest));
    const swapped = await this.#bucket.put(`${this.#prefix}HEAD`, version, {
      onlyIf: { etagMatches: headObject.etag },
    });
    if (swapped === null) throw new WorkspaceConflict(base, await this.head());
    this.#manifests.set(version, manifest);
    return version;
  }
}

export function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Changes that turn manifest `from` into manifest `to`; `from` undefined means an empty tree. */
export function diffManifests(
  from: WorkspaceManifest | undefined,
  to: WorkspaceManifest,
): { put: WorkspaceEntry[]; remove: string[] } {
  const put: WorkspaceEntry[] = [];
  const remove: string[] = [];
  const before = from?.entries ?? {};
  for (const entry of Object.values(to.entries)) {
    const old = before[entry.path];
    if (old === undefined || old.hash !== entry.hash || old.mode !== entry.mode) put.push(entry);
  }
  for (const path of Object.keys(before)) if (to.entries[path] === undefined) remove.push(path);
  return { put, remove };
}
