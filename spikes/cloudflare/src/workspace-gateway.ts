import { WorkerEntrypoint } from "cloudflare:workers";
import type { WorkspaceChange, WorkspaceManifest, WorkspaceVersion } from "./contracts.ts";
import { R2Workspace } from "./workspace.ts";

type Props = { readonly workspaceId: string };

/**
 * The isolate's only handle on storage: one workspace, chosen by the loader through props. The isolate never gets the
 * R2 binding, a key, or another workspace's ID.
 */
export class WorkspaceGateway extends WorkerEntrypoint<Env, Props> {
  #workspace(): R2Workspace {
    return new R2Workspace(this.env.WORKSPACES, this.ctx.props.workspaceId);
  }

  async manifest(version: WorkspaceVersion): Promise<WorkspaceManifest> {
    return this.#workspace().manifest(version);
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    return this.#workspace().readBlob(hash);
  }

  /** Hashes on this side: the isolate's own hash is never trusted. */
  async putBlob(bytes: Uint8Array): Promise<string> {
    return this.#workspace().putBlob(bytes);
  }

  async commit(base: WorkspaceVersion, changes: readonly WorkspaceChange[]): Promise<WorkspaceVersion> {
    return this.#workspace().commit(base, changes);
  }
}
