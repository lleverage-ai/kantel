// The gateway's container tier on a real Docker daemon: a session's `git status`, `node -v` and `python3 -V` run in a
// container of the sandbox image, and what a container command writes is committed to the workspace, where the file
// tools see it. Skipped unless KANTEL_TEST_DOCKER=1, as the Docker backend's own tests (targets/selfhosted/sandbox):
//
//   docker build -t harbour-sandbox:dev images/sandbox
//   KANTEL_TEST_DOCKER=1 bun test test/gateway/container-tier.docker.test.ts
//
// Optional: KANTEL_TEST_SANDBOX_IMAGE, KANTEL_TEST_SANDBOX_RUNTIME (default `auto`, as compose) and
// KANTEL_TEST_DOCKER_SOCKET. No vault proxy: the container has no network. Everything it makes is labelled with a
// prefix of its own and removed afterwards.
import { type CallContext, systemContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { DockerClient } from "@kantel/selfhosted-sandbox";
import { afterAll, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";
import { containerTierConfig, prepareContainerTier } from "../../src/gateway/sandboxes.ts";

const enabled = process.env.KANTEL_TEST_DOCKER === "1";
const prefix = `kantel-gateway-test-${crypto.randomUUID().slice(0, 8)}`;
const socketPath = process.env.KANTEL_TEST_DOCKER_SOCKET;
const opened: GatewayComponents[] = [];

afterAll(async () => {
	for (const components of opened.splice(0)) await components.close();
	if (!enabled) return;
	const docker = new DockerClient(socketPath === undefined ? {} : { socketPath });
	try {
		for (const container of await docker.listContainers([`${prefix}.lease`]))
			await docker.removeContainer(container.Id);
		for (const volume of await docker.listVolumes([`${prefix}.lease`])) await docker.removeVolume(volume.Name);
	} finally {
		docker.close();
	}
});

describe.skipIf(!enabled)("the gateway's container tier on Docker", () => {
	it("runs git, node and python3 in a container, and commits what it writes", async () => {
		const config = containerTierConfig({
			KANTEL_SANDBOX_IMAGE: process.env.KANTEL_TEST_SANDBOX_IMAGE ?? "harbour-sandbox:dev",
			KANTEL_SANDBOX_RUNTIME: process.env.KANTEL_TEST_SANDBOX_RUNTIME ?? "auto",
			KANTEL_SANDBOX_LABEL_PREFIX: prefix,
			...(socketPath === undefined ? {} : { KANTEL_DOCKER_SOCKET: socketPath }),
		});
		if (config === undefined) throw new Error("no container tier");
		const containers = await prepareContainerTier(config, { log: () => {} });
		expect(containers.binding).toMatch(/Docker container tier/);
		const { models, script } = createScriptedModel();
		const components = createGatewayComponents({ models: { models }, containers });
		opened.push(components);
		const seeded = await bootstrap(components, { organisation: "Docker", project: "docker" });
		const key = await components.identity.authenticateApiKey(
			{ ...systemContext("container-tier-docker-test"), organisationId: seeded.organisationId },
			seeded.apiKey,
		);
		const operator: CallContext = {
			actor: key.actor,
			organisationId: seeded.organisationId,
			projectId: seeded.projectId,
		};
		const { runtime } = components.runtime;
		const session = await runtime.create(operator, {
			projectId: seeded.projectId,
			agentId: "echo",
			workspaceId: seeded.workspaceId,
		});
		const commands = [
			"git init -q . && git status --short --branch",
			"node -v",
			"python3 -V",
			'python3 -c \'open("from-python.txt", "w").write("tier two\\n")\'',
		];
		script.reply(...commands.map((command) => ({ toolCalls: [{ name: "bash", args: { command } }] })), {
			text: "Done",
		});
		const prompt = await runtime.prompt(operator, session.id, { text: "Run them" });
		expect(await runtime.wait(operator, session.id, prompt.id)).toMatchObject({ status: "answered", answer: "Done" });
		const results =
			script.requests
				.at(-1)
				?.messages.filter((message) => message.role === "tool")
				.map((message) => message.text) ?? [];
		expect(results[0]).toMatch(/## (No commits yet on|Initial commit on) /);
		expect(results[0]).toContain("README.md");
		expect(results[1]).toMatch(/v\d+\.\d+\.\d+/);
		expect(results[2]).toMatch(/Python 3\.\d+/);
		const leases = await components.sandboxes.leases(
			{ ...systemContext("container-tier-docker-test"), organisationId: seeded.organisationId },
			{ sessionId: session.id, live: true },
		);
		expect(leases.map((lease) => lease.tier)).toEqual(["container"]);
		// Committed after the command (checkpointContainer), so the workspace has it.
		const written = await components.workspaces.read(operator, seeded.workspaceId, "from-python.txt");
		expect(new TextDecoder().decode(written.content)).toBe("tier two\n");

		await runtime.close(operator, session.id);
		const docker = new DockerClient(socketPath === undefined ? {} : { socketPath });
		try {
			expect(await docker.listContainers([`${prefix}.lease`])).toEqual([]);
		} finally {
			docker.close();
		}
	}, 180_000);
});
