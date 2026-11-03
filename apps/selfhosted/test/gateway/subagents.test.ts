// Subagents on the self-hosted gateway (subagents.ts, @kantel/subagents): on unless KANTEL_SUBAGENTS says otherwise,
// the bootstrap's profiles name `subagent`, and a session that calls it over the API gets its child's answer back, with
// the child a session of its own on the same workspace. In memory and over a real socket, so this runs under Bun as
// well as vitest (CI's self-hosted job runs apps/selfhosted's tests with Bun, which has no node:sqlite).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel } from "@kantel/runtime/testing";
import { CODING_TOOLS } from "@kantel/sandbox/coding-tools";
import { SUBAGENT_CALL_LABEL, SUBAGENT_DEPTH_LABEL, SUBAGENT_TOOL } from "@kantel/subagents";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents } from "../../src/gateway/components.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { gatewayConfig } from "../../src/gateway/main.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { subagentsConfig } from "../../src/gateway/subagents.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The gateway in process with a scripted model, over a socket, its bootstrap done. */
async function serve(subagents: boolean) {
	const { models, script } = createScriptedModel();
	const components = createGatewayComponents({ models: { models }, subagents });
	cleanups.push(() => components.close());
	const seeded = await bootstrap(components, { organisation: "Subagents", project: "subagents" });
	const scratch = await mkdtemp(join(tmpdir(), "kantel-subagents-"));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	await writeFile(join(scratch, "index.html"), "<!doctype html>");
	const gateway = createGateway({ components, consoleDir: scratch });
	const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
	cleanups.push(async () => {
		await gateway.close();
		await server.close();
	});
	const call = async (path: string, init: RequestInit = {}) => {
		const response = await fetch(`${server.url}${path}`, {
			...init,
			headers: { authorization: `Bearer ${seeded.apiKey}`, "content-type": "application/json" },
		});
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};
	return { components, seeded, script, call };
}

describe("subagents on the self-hosted gateway", () => {
	it("are on unless KANTEL_SUBAGENTS is set to anything but on", () => {
		expect(subagentsConfig({})).toBe(true);
		expect(subagentsConfig({ KANTEL_SUBAGENTS: "on" })).toBe(true);
		expect(subagentsConfig({ KANTEL_SUBAGENTS: "" })).toBe(true);
		expect(subagentsConfig({ KANTEL_SUBAGENTS: "off" })).toBe(false);
		expect(subagentsConfig({ KANTEL_SUBAGENTS: "no" })).toBe(false);
		expect(gatewayConfig({}).subagents).toBe(true);
		expect(gatewayConfig({ KANTEL_SUBAGENTS: "off" }).subagents).toBe(false);
	});

	it("are named in the bootstrap's profile and at /v1/deployment only when on", async () => {
		const on = await serve(true);
		const off = await serve(false);
		const echo = (components: typeof on.components, seeded: typeof on.seeded) =>
			components.runtime.profiles.get(
				{
					actor: { kind: "system", component: "test" },
					organisationId: seeded.organisationId,
					projectId: seeded.projectId,
				},
				"echo",
			);
		const tools = [...CODING_TOOLS, ...on.components.sessionTools];
		expect((await echo(on.components, on.seeded)).tools).toEqual([...tools, SUBAGENT_TOOL]);
		expect((await echo(off.components, off.seeded)).tools).toEqual(tools);
		expect(((await on.call("/v1/deployment")).body.bindings as Record<string, string>).subagents).toBe("on");
		expect(((await off.call("/v1/deployment")).body.bindings as Record<string, string>).subagents).toBe("off");
	});

	it("hand an API session's task to a child session on its workspace and answer with the child's answer", async () => {
		const { seeded, script, call } = await serve(true);
		const created = await call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: seeded.projectId, agentId: "echo", workspaceId: seeded.workspaceId }),
		});
		expect(created.status).toBe(201);
		const parentId = created.body.id as string;
		script.reply(
			{ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Read README.md and say its title.", title: "Title" } }] },
			// The child has the coding tools on the parent's workspace.
			{ toolCalls: [{ name: "read", args: { path: "README.md" } }] },
			{ text: "Kantel self-hosted" },
			{ text: "The subagent says: Kantel self-hosted" },
		);
		const prompted = await call(`/v1/sessions/${parentId}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "What's the README's title? Use a subagent." }),
		});
		expect(prompted.status).toBe(202);
		const submission = prompted.body.id as string;
		let result = await call(`/v1/sessions/${parentId}/result?submission=${submission}&timeoutMs=5000`);
		for (let attempt = 0; result.status === 202 && attempt < 10; attempt++) {
			result = await call(`/v1/sessions/${parentId}/result?submission=${submission}&timeoutMs=5000`);
		}
		expect(result.body).toMatchObject({ status: "answered", answer: "The subagent says: Kantel self-hosted" });
		// The child read the bootstrap's README on the parent's workspace.
		expect(script.requests[2]?.messages.some((message) => message.text.includes("# Kantel self-hosted"))).toBe(true);

		const children = (await call(`/v1/sessions?parentSessionId=${parentId}`)).body.items as {
			id: string;
			title?: string;
			workspaceId?: string;
			labels: Record<string, string>;
			createdBy: unknown;
		}[];
		expect(children).toHaveLength(1);
		const [child] = children;
		expect(child).toMatchObject({ title: "Title", workspaceId: seeded.workspaceId });
		expect(child?.labels[SUBAGENT_DEPTH_LABEL]).toBe("1");
		expect(child?.createdBy).toEqual({ kind: "agent", agentId: "echo", sessionId: parentId });
		// The console finds the child from the call by its label, as on Cloudflare.
		const snapshot = (await call(`/v1/sessions/${parentId}/snapshot`)).body.items as {
			kind: string;
			name?: string;
			callId?: string;
			status?: string;
			output?: string;
		}[];
		const tool = snapshot.find((item) => item.kind === "tool" && item.name === SUBAGENT_TOOL);
		expect(tool).toMatchObject({ status: "done", output: "Kantel self-hosted" });
		expect(child?.labels[SUBAGENT_CALL_LABEL]).toBe(tool?.callId);
		const found = (await call(`/v1/sessions?label.${SUBAGENT_CALL_LABEL}=${tool?.callId}`)).body.items as {
			id: string;
		}[];
		expect(found.map((session) => session.id)).toEqual([child?.id]);
	});

	it("work in the workspace of their own of a session created without one, as the console's are", async () => {
		const { seeded, script, call } = await serve(true);
		// No workspace: the session gets its own, bound to it (`withOwnWorkspaces`), and its child works in it through
		// the ancestor rule (`throughAncestors`), reading and writing what the parent sees.
		const created = await call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: seeded.projectId, agentId: "echo" }),
		});
		expect(created.status).toBe(201);
		const parentId = created.body.id as string;
		const workspaceId = created.body.workspaceId as string;
		expect(workspaceId).toMatch(/^session_/);
		script.reply(
			{ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Write notes/child.md and read it back." } }] },
			{ toolCalls: [{ name: "write", args: { path: "notes/child.md", content: "from the subagent\n" } }] },
			{ toolCalls: [{ name: "read", args: { path: "notes/child.md" } }] },
			{ text: "Written and read back" },
			{ toolCalls: [{ name: "read", args: { path: "notes/child.md" } }] },
			{ text: "The subagent wrote notes/child.md" },
		);
		const prompted = await call(`/v1/sessions/${parentId}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "Have a subagent write a note." }),
		});
		const submission = prompted.body.id as string;
		let result = await call(`/v1/sessions/${parentId}/result?submission=${submission}&timeoutMs=5000`);
		for (let attempt = 0; result.status === 202 && attempt < 10; attempt++) {
			result = await call(`/v1/sessions/${parentId}/result?submission=${submission}&timeoutMs=5000`);
		}
		expect(result.body).toMatchObject({ status: "answered", answer: "The subagent wrote notes/child.md" });
		const [child] = (await call(`/v1/sessions?parentSessionId=${parentId}`)).body.items as {
			id: string;
			workspaceId?: string;
		}[];
		expect(child?.workspaceId).toBe(workspaceId);
		const tools = (await call(`/v1/sessions/${child?.id}/snapshot`)).body.items as {
			kind: string;
			name?: string;
			status?: string;
		}[];
		expect(tools.filter((item) => item.kind === "tool").map((item) => [item.name, item.status])).toEqual([
			["write", "done"],
			["read", "done"],
		]);
		// The child read back what it wrote, and the parent then read the child's file in its own workspace.
		expect(script.requests[3]?.messages.some((message) => message.text.includes("from the subagent"))).toBe(true);
		expect(script.requests[5]?.messages.some((message) => message.text.includes("from the subagent"))).toBe(true);
	});

	it("aren't offered to a session when off", async () => {
		const { seeded, script, call } = await serve(false);
		const created = await call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: seeded.projectId, agentId: "echo" }),
		});
		script.reply({ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Anything" } }] }, { text: "No subagent" });
		const parentId = created.body.id as string;
		const prompted = await call(`/v1/sessions/${parentId}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "Try one" }),
		});
		await call(`/v1/sessions/${parentId}/result?submission=${prompted.body.id as string}&timeoutMs=5000`);
		// The session has no `subagent`: the model's call for one fails and starts nothing.
		const snapshot = (await call(`/v1/sessions/${parentId}/snapshot`)).body.items as {
			kind: string;
			status?: string;
		}[];
		expect(snapshot.find((item) => item.kind === "tool")?.status).toBe("error");
		expect((await call(`/v1/sessions?parentSessionId=${parentId}`)).body.items).toEqual([]);
	});
});
