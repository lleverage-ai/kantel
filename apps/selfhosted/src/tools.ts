// The agent's tools. Each call runs on the session's workspace head and
// commits the next version under the session lease, so the next call, in
// either tier, sees this one's writes.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { LeaseFence, Manifest, SandboxTierRunner } from "../../../spike/contracts/index.ts";
import type { Audit } from "./audit.ts";
import { tierFor } from "./sandbox/router.ts";
import { type MinioWorkspace, sha256Hex } from "./workspace.ts";

export interface ToolHostSession {
	sessionId: string;
	workspaceId: string;
	fence(): LeaseFence;
}

export interface ToolDeps {
	workspace: MinioWorkspace;
	isolate: SandboxTierRunner;
	container: SandboxTierRunner;
	audit: Audit;
	/** Session for a Pi conversation. One Harness per session, so this is the open session. */
	session(): ToolHostSession;
}

const encoder = new TextEncoder();

function withParents(manifest: Manifest, path: string): Manifest {
	const next = { ...manifest };
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i++) {
		const dir = parts.slice(0, i).join("/");
		if (next[dir] === undefined) next[dir] = { kind: "dir" };
	}
	return next;
}

function cleanPath(path: string): string {
	const out: string[] = [];
	for (const part of path.replace(/^\/?workspace\/?/, "").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") throw new Error(`path escapes the workspace: ${path}`);
		out.push(part);
	}
	if (out.length === 0) throw new Error("empty path");
	return out.join("/");
}

export function createHarbourTools(deps: ToolDeps) {
	const bash = defineTool({
		name: "bash",
		description:
			"Run a shell command in the workspace (/workspace). Simple commands run in a fast isolate; git, bun, node and other real binaries run in a container on the same workspace version.",
		parameters: Type.Object({
			command: Type.String(),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		// Default policy, stated: a call cut off by a crash comes back
		// "interrupted" and is never rerun, because a shell command may have
		// partially run. Its workspace changes are never committed.
		replay: "unsafe",
		execute: async (args, api, context) => {
			const session = deps.session();
			const tier = tierFor(args.command);
			const head = await deps.workspace.head(session.workspaceId);
			const manifest = await deps.workspace.manifest(session.workspaceId, head.version);
			const runner = tier === "container" ? deps.container : deps.isolate;
			if (tier === "container") {
				await deps.audit.record(session.sessionId, "sandbox", "escalate", {
					to: "container",
					version: head.version,
					program: args.command.split(/\s+/)[0],
				});
			}
			const started = performance.now();
			const result = await runner.exec(
				{
					sessionId: session.sessionId,
					workspaceId: session.workspaceId,
					version: head.version,
					command: args.command,
					timeoutMs: args.timeoutMs,
				},
				manifest,
				context.abortSignal,
			);
			const execMs = performance.now() - started;
			let version = head;
			if (result.changed.length > 0) {
				version = await deps.workspace.commit(
					session.workspaceId,
					{ base: head.version, manifest: result.manifest, tier, changed: result.changed },
					session.fence(),
				);
			}
			const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
			return {
				output: [{ type: "text", text: output === "" ? `(exit ${result.exitCode}, no output)` : output }],
				isError: result.exitCode !== 0,
				details: {
					tier,
					exitCode: result.exitCode,
					base: head.version,
					version: version.version,
					seq: version.seq,
					changed: result.changed.slice(0, 50),
					timings: { ...result.timings, execMs: Math.round(execMs) },
				},
			};
		},
	});

	const write = defineTool({
		name: "write",
		description: "Write a text file in the workspace, creating parent directories.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		// A write of fixed content on a fixed base is idempotent: rerun it.
		replay: "safe",
		execute: async (args) => {
			const session = deps.session();
			const path = cleanPath(args.path);
			const head = await deps.workspace.head(session.workspaceId);
			const manifest = withParents(await deps.workspace.manifest(session.workspaceId, head.version), path);
			const bytes = encoder.encode(args.content);
			const sha = await deps.workspace.putBlob(session.workspaceId, bytes);
			if (sha !== sha256Hex(bytes)) throw new Error("blob hash mismatch");
			const before = manifest[path];
			if (before?.kind === "file" && before.sha === sha) {
				return { output: [{ type: "text", text: `${path} unchanged` }], details: { tier: "host", version: head.version } };
			}
			manifest[path] = { kind: "file", sha, size: bytes.length, mode: 0o644 };
			const next = await deps.workspace.commit(
				session.workspaceId,
				{ base: head.version, manifest, tier: "host", changed: [path] },
				session.fence(),
			);
			return {
				output: [{ type: "text", text: `wrote ${bytes.length} bytes to ${path}` }],
				details: { tier: "host", version: next.version, seq: next.seq },
			};
		},
	});

	return defineExtension({ name: "harbour", tools: [bash, write] });
}
