// `kantel e2e`, end to end through the gateway: an admin starts the organisation's chain from the CLI, enrols the host
// with a ticket, adds a member's device from its card, and both run commands and read files in a sandbox over Noise
// sessions the hub relays as stream frames. The CLI talks to the real compute API, and the host is kantel-host's
// TypeScript twin (e2e-host.ts). What the hub carried is checked for the command, its output and the file's bytes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunOptions, run } from "@kantel/cli";
import { utf8 } from "@kantel/e2e/bytes";
import { contains } from "@kantel/e2e/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type Gateway, hostJoins, joined, PEOPLE, SECRET_COMMAND, SECRET_OUTPUT, setup } from "./e2e-host.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** One person's `kantel`, with a config directory (and so a device) of their own. */
async function cli(
	s: Gateway,
	who: keyof typeof PEOPLE,
	account: string,
	fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = s.gatewayFetch,
	extra: Partial<RunOptions> = {},
) {
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
			fetch,
			configDir,
			home: configDir,
			stdout: sink(out),
			stderr: sink(err),
			connect: s.tunnel,
			...extra,
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

		// Turning E2E on retires the space's existing sandboxes: the CLI lists them and wants --yes.
		const unconfirmed = await root("e2e", "init", "--label", "root's laptop");
		expect(unconfirmed.code).not.toBe(0);
		expect(unconfirmed.stderr).toContain(`retires ${s.org.id}'s 1 existing sandbox: ${s.sandbox.id}`);
		expect(unconfirmed.stderr).toContain("kantel e2e init --yes");

		// The admin starts the chain; the genesis goes to members out of band.
		const init = await root("e2e", "init", "--label", "root's laptop", "--yes", "--json");
		expect(init.stderr).toBe("");
		expect(init.code).toBe(0);
		const { genesis } = JSON.parse(init.stdout) as { genesis: string };

		// The host joins with the admin's ticket, as `kantel-host e2e join <ticket>` does.
		const ticket = await root("e2e", "host-ticket", "rack-1", "--json");
		expect(ticket.stderr).toBe("");
		expect(ticket.code).toBe(0);
		await hostJoins(s, (JSON.parse(ticket.stdout) as { ticket: string }).ticket);
		// Sessions reach sandboxes made while E2E is on.
		const sandbox = await s.root.createSandbox({ account: s.org.id, type: "microvm", wait: true });

		// The admin's own command.
		const exec = await root("e2e", "exec", sandbox.id, "--", "sh", "-c", SECRET_COMMAND);
		expect(exec.stderr).toBe("");
		expect(exec.code).toBe(0);
		expect(exec.stdout).toBe(`${SECRET_OUTPUT}\n`);
		expect(s.host.ran.at(-1)?.method).toBe("sandbox.exec");

		// Bob trusts the genesis he was given and sends his card; until it is added, the host won't let him in.
		const joinedBob = await bob("e2e", "join", s.org.id, genesis, "--json");
		expect(joinedBob.stderr).toBe("");
		expect(joinedBob.code).toBe(0);
		const { card } = JSON.parse(joinedBob.stdout) as { card: string };
		const early = await bob("e2e", "exec", sandbox.id, "--", "id");
		expect(early.code).not.toBe(0);
		expect(early.stderr).toMatch(/isn't in the space's chain/);

		const added = await root("e2e", "add-device", "--member", card);
		expect(added.stderr).toMatch(/check it with them/);
		expect(added.code).toBe(0);
		const bobs = await bob("e2e", "cat", sandbox.id, "/home/user/.env");
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
		const after = await bob("e2e", "exec", sandbox.id, "--", "id");
		expect(after.code).not.toBe(0);
		expect(after.stderr).toMatch(/isn't in the space's chain|isn't a member/);
	});

	it("won't let a member who isn't an admin start the chain, nor trust a chain from another genesis", async () => {
		const s = await organisation();
		const bob = await cli(s, "bob", s.org.id);
		const started = await bob("e2e", "init", "--yes");
		expect(started.code).not.toBe(0);
		expect(started.stderr).toMatch(/admin/);

		const root = await cli(s, "root", s.org.id);
		expect((await root("e2e", "init", "--yes")).code).toBe(0);
		// A genesis that isn't the gateway's chain's: every read fails rather than trusting what the gateway says.
		const wrong = "a".repeat(43);
		expect((await bob("e2e", "join", s.org.id, wrong)).code).toBe(0);
		const status = await bob("e2e", "status");
		expect(status.code).not.toBe(0);
		expect(status.stderr).toMatch(/genesis/i);
	});

	it("won't take a chain from the gateway that goes back on one this device verified", async () => {
		const s = await organisation();
		// A gateway that, once told to, answers the chain as it was before its newest entry.
		let rollBack = false;
		const fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const response = await s.gatewayFetch(input, init);
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (!rollBack || (init?.method ?? "GET") !== "GET" || !url.pathname.endsWith("/e2e/chain")) return response;
			const { entries } = (await response.json()) as { entries: unknown[] };
			return Response.json({ entries: entries.slice(0, -1) });
		};
		const root = await cli(s, "root", s.org.id, fetch);
		expect((await root("e2e", "init", "--yes")).code).toBe(0);
		// The admin takes Bob out (he was in); the gateway then hides that.
		expect((await root("e2e", "add-member", PEOPLE.bob.userId)).code).toBe(0);
		expect((await root("e2e", "remove-member", PEOPLE.bob.userId)).code).toBe(0);
		rollBack = true;
		const status = await root("e2e", "status");
		expect(status.code).not.toBe(0);
		expect(status.stderr).toMatch(/goes back on what this device verified/);
	});

	it("turning E2E off and on again wants --yes, as it retires the space's sandboxes again", async () => {
		const s = await organisation();
		const root = await cli(s, "root", s.org.id);
		expect((await root("e2e", "init", "--yes")).code).toBe(0);
		const off = await root("e2e", "mode", "off");
		expect(off.code).toBe(0);
		expect(off.stdout).toMatch(/Turning it on again retires every sandbox/);
		const on = await root("e2e", "mode", "on");
		expect(on.code).not.toBe(0);
		expect(on.stderr).toContain(s.sandbox.id);
		expect(on.stderr).toContain("kantel e2e mode on --yes");
		expect((await root("e2e", "mode", "on", "--yes")).code).toBe(0);
		// On to strict retires nothing more.
		expect((await root("e2e", "mode", "strict")).code).toBe(0);
	});

	it("adds a new member's device with one JSON result", async () => {
		const s = await organisation();
		const root = await cli(s, "root", s.org.id);
		const bob = await cli(s, "bob", s.org.id);
		expect((await root("e2e", "init", "--yes")).code).toBe(0);
		const { card } = JSON.parse((await bob("e2e", "device", "--json")).stdout) as { card: string };
		const added = await root("e2e", "add-device", "--member", card, "--json");
		expect(added.code).toBe(0);
		const result = JSON.parse(added.stdout) as { space: string; seq: number };
		// The genesis, the member and the device.
		expect(result).toMatchObject({ space: s.org.id, seq: 2 });
	});

	it("signs a change onto the chain it was decided on: a race refuses it, never demoting an admin or skipping --yes", async () => {
		const s = await organisation();
		// Two commands of the same device: one runs in the middle of the other, between its check and its append.
		const dir = await mkdtemp(join(tmpdir(), "kantel-e2e-race-"));
		dirs.push(dir);
		const same = { configDir: dir, home: dir };
		const root = await cli(s, "root", s.org.id, s.gatewayFetch, same);
		let meanwhile: (() => Promise<unknown>) | undefined;
		const racing = async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (meanwhile !== undefined && init?.method === "POST" && url.pathname.endsWith("/e2e/chain")) {
				const run = meanwhile;
				meanwhile = undefined;
				await run();
			}
			return s.gatewayFetch(input, init);
		};
		const raced = await cli(s, "root", s.org.id, racing, same);
		expect((await root("e2e", "init", "--yes")).code).toBe(0);
		const bob = await cli(s, "bob", s.org.id);
		const { card } = JSON.parse((await bob("e2e", "device", "--json")).stdout) as { card: string };
		const members = async () =>
			(JSON.parse((await root("e2e", "status", "--json")).stdout) as { members: Record<string, string> }).members;

		// Bob isn't a member when add-device --member looks; another command makes him an admin before it appends.
		meanwhile = () => root("e2e", "add-member", PEOPLE.bob.userId, "--admin");
		const lost = await raced("e2e", "add-device", "--member", card);
		expect(lost.code).not.toBe(0);
		expect(lost.stderr).toMatch(/The chain changed while this ran/);
		expect((await members())[PEOPLE.bob.userId]).toBe("admin");
		// Run again, it adds only the device, and Bob stays an admin.
		const again = await root("e2e", "add-device", "--member", card, "--json");
		expect(again.code).toBe(0);
		expect(JSON.parse(again.stdout)).toMatchObject({ space: s.org.id });
		expect((await members())[PEOPLE.bob.userId]).toBe("admin");

		// On to strict needs no --yes; turned off meanwhile, it would turn it on again without one, so it is refused.
		meanwhile = () => root("e2e", "mode", "off");
		const strict = await raced("e2e", "mode", "strict");
		expect(strict.code).not.toBe(0);
		expect(strict.stderr).toMatch(/The chain changed while this ran/);
		const status = JSON.parse((await root("e2e", "status", "--json")).stdout) as { mode: string };
		expect(status.mode).toBe("off");
		// Asked again, it wants --yes, as it retires the space's sandboxes.
		const asked = await root("e2e", "mode", "strict");
		expect(asked.code).not.toBe(0);
		expect(asked.stderr).toContain("kantel e2e mode strict --yes");
	});
});
