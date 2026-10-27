/**
 * The isolate shell's read-only view of one workspace (`WorkspacePort`), over `ObjectStoreWorkspaces`. The deployed
 * WorkspaceGateway serves it to the Dynamic Worker; the tests hand it to the shell directly. It can list and read,
 * never write: the isolate's changes come back to the sandbox, which commits them.
 */
import type { CallContext, FileEntry, WorkspaceId } from "@harbour/contracts";
import type { WorkspacePort } from "./isolate/shell.ts";
import { listAll, type ModedFileEntry, type ObjectStoreWorkspaces } from "./workspace.ts";

export function workspacePort(workspaces: ObjectStoreWorkspaces, ctx: CallContext, id: WorkspaceId): WorkspacePort {
	return {
		async entries(version: number): Promise<readonly ModedFileEntry[]> {
			return listAll(workspaces, ctx, id, { version });
		},
		async mountEntries(path: string): Promise<readonly FileEntry[]> {
			return listAll(workspaces, ctx, id, { path });
		},
		async readBlob(digest: string): Promise<Uint8Array> {
			return workspaces.readBlob(ctx, id, digest);
		},
		async readMount(path: string): Promise<Uint8Array> {
			if (!path.startsWith("/")) throw new Error("readMount takes an absolute path under a mount");
			return (await workspaces.read(ctx, id, path)).content;
		},
	};
}
