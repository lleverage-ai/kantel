// The gateway's sessions get coding tools on demand (#196), as on Cloudflare: a session on a workspace gets `read`,
// `write`, `edit`, `ls` and `bash` (those its profile names). The file tools work on the workspace directly, through
// the gateway's `Workspaces` (Postgres and S3 on the stack), as the session's agent, with no lease and no isolate.
// Only `bash` reaches a sandbox: `Sandboxes.run` leases the session's isolate on its first command, never before, and
// the runtime's `sandbox` session-end teardown releases it on abort and close. Building a session's environment acquires
// nothing (`@kantel/sandbox/coding-tools`).
//
//   isolate tier    #94's just-bash shell in the gateway's own process, over the same workspaces (as Cloudflare's
//                   default `in-process` backend). A lease holds no state outside its workspace, so leases are kept in
//                   memory and one lost to a restart costs nothing: the next command acquires another.
//   container tier  none yet: a command routed to it (`git`, `node`, `python`, the rest of `DEFAULT_TIER_ROUTES`) is
//                   refused `unavailable`. The Docker backend (`@kantel/selfhosted-sandbox`, #126) is the next step.
//
// The runtime is built before the workspaces and sandboxes (they need its project access), so its options reach them
// late: a session the runtime resumes as it starts has its tools, and they find the sandboxes when a command runs.
import type { AuditSink, CallContext, Clock, LeaseEndReason, ProjectAccess, SystemContext } from "@kantel/contracts";
import { KantelError } from "@kantel/contracts";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import { noContainers, sessionCodingTools, sessionEnvironments } from "@kantel/sandbox/coding-tools";
import type { IsolateEgress } from "@kantel/sandbox/egress";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import { createMemoryLeaseStore, createTieredSandboxes, type TieredSandboxes } from "@kantel/sandbox/tiered";
import type { StoredWorkspaces } from "@kantel/workspace/stored";

const NO_CONTAINERS = "The self-hosted gateway has no container tier yet; this command needs it";

/** What `/v1/deployment` says backs the sandboxes. */
export const SANDBOX_BINDING = "in-process isolate (just-bash), leased on first bash; no container tier";

export interface GatewaySandboxes {
	/** The runtime's coding tools, their environment and the sandbox teardown and sweep. */
	readonly runtimeOptions: Pick<SessionRuntimeOptions, "tools" | "environment" | "sandboxes">;
	/** Builds the sandboxes over the gateway's workspaces, once the runtime's project access exists. */
	attach(options: {
		readonly workspaces: StoredWorkspaces;
		readonly access: ProjectAccess;
		readonly audit: AuditSink;
		readonly clock?: Clock;
		/** The isolate's way out (#331): the connections egress gate. Absent: full internet and no credentials. */
		readonly egress?: IsolateEgress;
	}): TieredSandboxes;
}

export function createGatewaySandboxes(): GatewaySandboxes {
	let sandboxes: TieredSandboxes | undefined;
	let workspaces: StoredWorkspaces | undefined;
	const ready = <T>(value: T | undefined): T => {
		if (value === undefined) throw new KantelError("unavailable", "The gateway's sandboxes are not ready");
		return value;
	};
	return {
		runtimeOptions: {
			tools: sessionCodingTools(),
			environment: sessionEnvironments({
				sandboxes: () => ready(sandboxes),
				workspaces: () => ready(workspaces),
			}),
			sandboxes: {
				// A session can end before the sandboxes exist (resumed and aborted as the gateway starts): it holds no lease.
				releaseSession: (ctx: CallContext, sessionId: string, reason?: LeaseEndReason) =>
					sandboxes === undefined ? Promise.resolve() : sandboxes.releaseSession(ctx, sessionId, reason),
				sweep: async (ctx: SystemContext) => (sandboxes === undefined ? [] : sandboxes.sweep(ctx)),
			},
		},
		attach(options) {
			if (sandboxes !== undefined) throw new Error("the gateway's sandboxes are already attached");
			workspaces = options.workspaces;
			sandboxes = createTieredSandboxes({
				workspaces: options.workspaces,
				isolate: createInProcessIsolateBackend(
					options.workspaces,
					options.egress === undefined ? {} : { egress: options.egress },
				),
				container: noContainers(NO_CONTAINERS),
				leases: createMemoryLeaseStore(),
				audit: options.audit,
				access: options.access,
				...(options.clock === undefined ? {} : { clock: options.clock }),
			});
			return sandboxes;
		},
	};
}
