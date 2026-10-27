import { WorkerEntrypoint } from "cloudflare:workers";
import type { FileEntry } from "@harbour/contracts";
import { sessionContext } from "./identity.ts";
import type { WorkspacePort } from "./isolate/shell.ts";
import { workspacePort } from "./port.ts";
import { r2Store } from "./r2.ts";
import { type ModedFileEntry, ObjectStoreWorkspaces } from "./workspace.ts";

type Props = { readonly workspaceId: string; readonly sessionId: string };

/**
 * The isolate's only handle on storage: a read-only view of one workspace, chosen by the loader through props. The
 * isolate never gets the R2 binding, a write path, or another workspace's ID. What a command changes goes back to
 * the session's sandbox, which commits it.
 */
export class WorkspaceGateway extends WorkerEntrypoint<Env, Props> implements WorkspacePort {
	#port(): WorkspacePort {
		const workspaces = new ObjectStoreWorkspaces({ store: r2Store(this.env.WORKSPACES) });
		return workspacePort(workspaces, sessionContext(this.ctx.props.sessionId), this.ctx.props.workspaceId);
	}

	async entries(version: number): Promise<readonly ModedFileEntry[]> {
		return this.#port().entries(version);
	}

	async mountEntries(path: string): Promise<readonly FileEntry[]> {
		return this.#port().mountEntries(path);
	}

	async readBlob(digest: string): Promise<Uint8Array> {
		return this.#port().readBlob(digest);
	}

	async readMount(path: string): Promise<Uint8Array> {
		return this.#port().readMount(path);
	}
}
