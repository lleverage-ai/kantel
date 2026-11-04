// `kantel e2e`, end to end through the gateway: an admin starts the organisation's chain from the CLI, enrols the host
// with a ticket, adds a member's device from its card, and both run commands and read files in a sandbox over Noise
// sessions the hub relays as stream frames. The CLI talks to the real compute API, and the host is kantel-host's
// TypeScript twin (e2e-host.ts). What the hub carried is checked for the command, its output and the file's bytes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@kantel/cli";
import { utf8 } from "@kantel/e2e/bytes";
import { contains } from "@kantel/e2e/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type Gateway, hostJoins, joined, PEOPLE, SECRET_COMMAND, SECRET_OUTPUT, setup } from "./e2e-host.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** One person's `kantel`, with a config directory (and so a device) of their own. */
async function cli(s: Gateway, who: keyof typeof PEOPLE, account: string) {
	const configDir = await mkdtemp(join(tmpdir(), `kantel-e2e-${who}-`));
	dirs.push(configDir);
	return async (...argv: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const decoder = new TextDecoder();
		const sink = (into: string[]) => ({
			isTTY: false,
			write(chunk: string | Uint8Array) {
				into.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
				return true;
			},
		});
		const code = await run([...argv, "--account", account], {
			env: { KANTEL_URL: "https://kantel.test", KANTEL_API_KEY: who },
			fetch: s.gatewayFetch,
			configDir,
			home: configDir,
			stdout: sink(out),
			stderr: sink(err),
			connect: s.tunnel,
		});
		return { code, stdout: out.join(""), stderr: err.join("") };
	};
}

async function organisation() {
	const s = await setup();
	const org = await s.root.createOrganisation({ name: "Acme" });
	const invite = await s.root.createInvite(org.id, { role: "member" });
	await s.as("bob").joinOrganisation({ code: invite.code as string });
	const sandbox = await s.root.createSandbox({ account: org.id, type: "microvm", wait: true });
	return { ...s, org, sandbox };
}

describe("kantel e2e", () => {
	it("enrols a host and a member's device, and runs their commands through a hub that sees only ciphertext", async () => {
		const s = await organisation();
		const root = await cli(s, "root", s.org.id);
		const bob = await cli(s, "bob", s.org.id);

		// The admin starts the chain; the genesis goes to members out of band.
		const init = await root("e2e", "init", "--label", "root's laptop", "--json");
		expect(init.stderr).toBe("");
		expect(init.code).toBe(0);
		const { genesis } = JSON.parse(init.stdout) as { genesis: string };

		// The host joins with the admin's ticket, as `kantel-host e2e join <ticket>` does.
		const ticket = await root("e2e", "host-ticket", "rack-1", "--json");
		expect(ticket.stderr).toBe("");
		expect(ticket.code).toBe(0);
		await hostJoins(s, (JSON.parse(ticket.stdout) as { ticket: string }).ticket);

		// The admin's own command.
		const exec = await root("e2e", "exec", s.sandbox.id, "--", "sh", "-c", SECRET_COMMAND);
		expect(exec.stderr).toBe("");
		expect(exec.code).toBe(0);
		expect(exec.stdout).toBe(`${SECRET_OUTPUT}\n`);
		expect(s.host.ran.at(-1)?.method).toBe("sandbox.exec");

		// Bob trusts the genesis he was given and sends his card; until it is added, the host won't let him in.
		const joinedBob = await bob("e2e", "join", s.org.id, genesis, "--json");
		expect(joinedBob.stderr).toBe("");
		expect(joinedBob.code).toBe(0);
		const { card } = JSON.parse(joinedBob.stdout) as { card: string };
		const early = await bob("e2e", "exec", s.sandbox.id, "--", "id");
		expect(early.code).not.toBe(0);
		expect(early.stderr).toMatch(/isn't in the space's chain/);

		const added = await root("e2e", "add-device", "--member", card);
		expect(added.stderr).toMatch(/check it with them/);
		expect(added.code).toBe(0);
		const bobs = await bob("e2e", "cat", s.sandbox.id, "/home/user/.env");
		expect(bobs.stderr).toBe("");
		expect(bobs.code).toBe(0);
		expect(bobs.stdout).toBe(`${SECRET_OUTPUT}\n`);
		expect(s.host.ran.at(-1)).toMatchObject({ method: "sandbox.files.read", params: { path: "/home/user/.env" } });

		// Nothing the hub carried, either way, held the command, the path or the output.
		const carried = joined([...s.host.frames.toHost, ...s.host.frames.toGateway]);
		expect(carried.byteLength).toBeGreaterThan(0);
		for (const secret of [SECRET_COMMAND, SECRET_OUTPUT, "/home/user/.env", "sandbox.exec", "sandbox.files.read"]) {
			expect(contains(carried, utf8(secret))).toBe(false);
		}

		// Status shows both devices and the host, verified from this device's genesis.
		const status = await bob("e2e", "status", "--json");
		const view = JSON.parse(status.stdout) as { inChain: boolean; devices: unknown[]; hosts: unknown[]; mode: string };
		expect(view).toMatchObject({ inChain: true, mode: "on" });
		expect(view.devices).toHaveLength(2);
		expect(view.hosts).toHaveLength(1);

		// Taking Bob out: the host refuses him at his next session.
		expect((await root("e2e", "remove-member", PEOPLE.bob.userId)).code).toBe(0);
		const after = await bob("e2e", "exec", s.sandbox.id, "--", "id");
		expect(after.code).not.toBe(0);
		expect(after.stderr).toMatch(/isn't in the space's chain|isn't a member/);
	});

	it("won't let a member who isn't an admin start the chain, nor trust a chain from another genesis", async () => {
		const s = await organisation();
		const bob = await cli(s, "bob", s.org.id);
		const started = await bob("e2e", "init");
		expect(started.code).not.toBe(0);
		expect(started.stderr).toMatch(/admin/);

		const root = await cli(s, "root", s.org.id);
		expect((await root("e2e", "init")).code).toBe(0);
		// A genesis that isn't the gateway's chain's: every read fails rather than trusting what the gateway says.
		const wrong = "a".repeat(43);
		expect((await bob("e2e", "join", s.org.id, wrong)).code).toBe(0);
		const status = await bob("e2e", "status");
		expect(status.code).not.toBe(0);
		expect(status.stderr).toMatch(/genesis/i);
	});
});
