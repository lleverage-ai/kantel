// `kantel e2e`, end to end through the gateway: an admin starts the organisation's chain from the CLI, enrols the host
// with a ticket, adds a member's device from its card, and both run commands and read files in a sandbox over Noise
// sessions the hub relays as stream frames. The CLI talks to the real compute API, and the host is kantel-host's
// TypeScript twin (e2e-host.ts). What the hub carried is checked for the command, its output and the file's bytes.

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
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
		// Its history comes from the host, over a session too.
		const history = await root("e2e", "history", sandbox.id, "--output");
		expect(history.stderr).toBe("");
		expect(history.code).toBe(0);
		expect(history.stdout).toContain(SECRET_COMMAND);
		expect(history.stdout).toContain(`    ${SECRET_OUTPUT}`);
		expect(history.stdout).toContain("root's laptop");

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

	it("kantel console serves its own files, lets in only the browser with its link, and runs E2E calls itself", async () => {
		const s = await organisation();
		const seen: { url: string; authorization: string | null }[] = [];
		const watched = (input: string | URL | Request, init?: RequestInit) => {
			const req = new Request(input, init);
			seen.push({ url: req.url, authorization: req.headers.get("authorization") });
			return s.gatewayFetch(req);
		};
		const bundle = await mkdtemp(join(tmpdir(), "kantel-console-"));
		dirs.push(bundle);
		const theme = "document.documentElement.dataset.theme='dark'";
		await writeFile(
			join(bundle, "index.html"),
			`<!doctype html><title>Kantel</title><script>${theme}</script><script type="module" src="/assets/a.js"></script>`,
		);
		// What a browser does while the console runs; the console stops when it is done.
		let checked: (() => Promise<void>) | undefined;
		let opened: { url: string; origin: string } | undefined;
		const root = await cli(s, "root", s.org.id, watched, {
			served: async (c) => {
				opened = c;
				await checked?.();
			},
			openUrl: () => {
				throw new Error("--no-browser opened a browser");
			},
		});
		expect((await root("e2e", "init", "--label", "root's laptop", "--yes")).code).toBe(0);
		const ticket = await root("e2e", "host-ticket", "rack-1", "--json");
		await hostJoins(s, (JSON.parse(ticket.stdout) as { ticket: string }).ticket);
		const sandbox = await s.root.createSandbox({ account: s.org.id, type: "microvm", wait: true });

		/** A raw request, so the Host header and the path go as given. */
		const raw = (url: string, path: string, headers: Record<string, string> = {}) =>
			new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, failed) => {
				const { hostname, port } = new URL(url);
				const req = httpRequest({ hostname, port, path, headers }, (res) => {
					let body = "";
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
				});
				req.on("error", failed);
				req.end();
			});
		checked = async () => {
			const c = opened as { url: string; origin: string };
			expect(c.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			const key = new URL(c.url).searchParams.get("k") as string;
			// Without the link's key, or with another, nothing is served; nor to a page on another name (DNS rebinding).
			expect((await fetch(`${c.origin}/`)).status).toBe(403);
			expect((await fetch(`${c.origin}/?k=wrong`, { redirect: "manual" })).status).toBe(403);
			expect((await raw(c.origin, "/", { host: "evil.test" })).status).toBe(421);
			// The link swaps its key for a cookie.
			const entry = await fetch(c.url, { redirect: "manual" });
			expect(entry.status).toBe(303);
			const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0] as string;
			expect(entry.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict/);
			expect(cookie).toBe(`kantel_console=${key}`);
			const page = await fetch(`${c.origin}/sandboxes`, { headers: { cookie } });
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("<title>Kantel</title>");
			// Its own inline script runs by its hash; no other.
			const hash = createHash("sha256").update(theme).digest("base64");
			expect(page.headers.get("content-security-policy")).toContain(`script-src 'self' 'sha256-${hash}';`);
			// A path can't climb out of the console's files: it is one of its pages, or not found.
			for (const path of [
				"/%2e%2e/%2e%2e/etc/passwd",
				"/..%2f..%2f..%2fetc%2fpasswd",
				"/assets/..%2f..%2fpackage.json",
			]) {
				const climbed = await raw(c.origin, path, { cookie });
				expect(climbed.body).not.toMatch(/root:|"name"/);
			}

			// The API goes to the gateway with the CLI's key, never the browser's.
			const list = await fetch(`${c.origin}/v1/sandboxes?account=${s.org.id}`, {
				headers: { cookie, authorization: "Bearer bob" },
			});
			expect(list.status).toBe(200);
			expect(seen.at(-1)).toMatchObject({ authorization: "Bearer root" });
			expect(seen.at(-1)?.url).toBe(`https://kantel.test/v1/sandboxes?account=${s.org.id}`);

			// What the page knows of E2E here.
			const info = (await (await fetch(`${c.origin}/local/info`, { headers: { cookie } })).json()) as {
				local: boolean;
				device: { label: string };
				spaces: { id: string; mode: string }[];
			};
			expect(info).toMatchObject({ local: true, device: { label: "root's laptop" } });
			expect(info.spaces).toEqual([{ id: s.org.id, mode: "on" }]);

			// A call over a session must come from the console's own origin, and be one the console makes.
			const call = (body: object, origin: string | undefined = c.origin) =>
				fetch(`${c.origin}/local/e2e`, {
					method: "POST",
					headers: { cookie, "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
					body: JSON.stringify(body),
				});
			const exec = { sandboxId: sandbox.id, method: "sandbox.exec", params: { command: SECRET_COMMAND } };
			expect((await call(exec, "https://evil.test")).status).toBe(403);
			expect((await call({ ...exec, method: "sandbox.delete" })).status).toBe(400);
			const ran = await call(exec);
			expect(ran.status).toBe(200);
			expect(((await ran.json()) as { result: { stdout: string } }).result.stdout).toBe(`${SECRET_OUTPUT}\n`);
			expect(s.host.ran.at(-1)).toMatchObject({ method: "sandbox.exec", params: { command: SECRET_COMMAND } });
			const history = await call({ sandboxId: sandbox.id, method: "sandbox.history", params: {} });
			expect(((await history.json()) as { result: { items: { command: string }[] } }).result.items[0]?.command).toBe(
				SECRET_COMMAND,
			);
			// And none of it went through the gateway's API in the clear.
			expect(seen.some((call) => call.url.includes("exec") || call.url.includes("commands"))).toBe(false);
			const carried = joined([...s.host.frames.toHost, ...s.host.frames.toGateway]);
			for (const secret of [SECRET_COMMAND, SECRET_OUTPUT]) expect(contains(carried, utf8(secret))).toBe(false);
		};
		const ran = await root("console", "--no-browser", "--dir", bundle);
		expect(ran.stderr).toBe("");
		expect(ran.code).toBe(0);
		expect(ran.stdout).toContain("The console is at http://127.0.0.1:");
		// Stopped: it no longer answers.
		await expect(fetch(`${(opened as { origin: string }).origin}/`)).rejects.toThrow();
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

	it("finishes an init whose answer was lost, with the genesis it signed, and says the mode that chain has", async () => {
		const s = await organisation();
		const dir = await mkdtemp(join(tmpdir(), "kantel-e2e-init-"));
		dirs.push(dir);
		const same = { configDir: dir, home: dir };
		// The gateway takes the genesis, but its answer is lost, and so is the read after it.
		let lose = 2;
		const losing = async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const response = await s.gatewayFetch(input, init);
			if (lose > 0 && url.pathname.endsWith("/e2e/chain")) {
				lose--;
				throw new TypeError("fetch failed");
			}
			return response;
		};
		const lost = await (await cli(s, "root", s.org.id, losing, same))("e2e", "init", "--yes");
		expect(lost.code).not.toBe(0);
		const root = await cli(s, "root", s.org.id, s.gatewayFetch, same);
		// Asked for strict this time, it finishes the chain it started, which is on, and says so in both outputs.
		const json = await root("e2e", "init", "--mode", "strict", "--yes", "--json");
		expect(json.code).toBe(0);
		const result = JSON.parse(json.stdout) as { genesis: string; mode: string };
		expect(result.mode).toBe("on");
		const status = JSON.parse((await root("e2e", "status", "--json")).stdout) as { genesis: string; mode: string };
		expect(status).toMatchObject({ genesis: result.genesis, mode: "on" });
		// Done, init again says so rather than starting another.
		const again = await root("e2e", "init", "--mode", "strict", "--yes");
		expect(again.code).not.toBe(0);
		expect(again.stderr).toMatch(/This device trusts .*'s chain already/);
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
