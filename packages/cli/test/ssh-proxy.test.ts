// `kantel ssh` through Kantel's relay: ssh's arguments, `kantel ssh-proxy`'s piping, and its refusals.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/commands.ts";
import { pipeTunnel, proxyUrlOf, SSH_URL_ENV, tunnelSshArgs, tunnelSshCommand } from "../src/ssh-proxy.ts";

const URL_ = "wss://kantel.test/v1/hosts/tunnel/eyJ4Ijox.c2ln";
const access = { user: "user", proxyUrl: URL_ };
const options = {
	self: ["/usr/bin/node", "/opt/kantel/main.js"],
	sandboxId: "sbx_4kq9x2mt",
	knownHosts: "/k/known_hosts",
};

/** A WebSocket the test drives: what was sent, and its open, message and close. */
function fakeSocket() {
	const sent: Uint8Array[] = [];
	let closed: { code?: number; reason?: string } | undefined;
	const socket = {
		binaryType: "blob" as WebSocket["binaryType"],
		readyState: 0,
		send: (data: Uint8Array) => void sent.push(data),
		close: (code?: number, reason?: string) => {
			closed = { code, reason };
		},
		onopen: null as ((event: Event) => void) | null,
		onmessage: null as ((event: MessageEvent) => void) | null,
		onclose: null as ((event: CloseEvent) => void) | null,
		onerror: null as ((event: Event) => void) | null,
	};
	return {
		socket,
		sent,
		closed: () => closed,
		open: () => socket.onopen?.(new Event("open")),
		message: (bytes: Uint8Array) =>
			socket.onmessage?.({
				data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			} as MessageEvent),
		close: (code: number, reason = "") => socket.onclose?.({ code, reason } as CloseEvent),
		error: () => socket.onerror?.(new Event("error")),
	};
}

/** stdin that yields `chunks`, then waits for `end` before it ends (as ssh's stays open). */
function stdinOf(chunks: Uint8Array[]) {
	let end: () => void = () => undefined;
	const ended = new Promise<void>((resolve) => {
		end = resolve;
	});
	return {
		end,
		stream: {
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) yield chunk;
				await ended;
			},
		},
	};
}

function sink() {
	const chunks: Uint8Array[] = [];
	const text: string[] = [];
	return {
		chunks,
		text,
		stdout: { write: (c: Uint8Array) => chunks.push(c) },
		stderr: { write: (t: string) => text.push(t) },
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ssh through the relay", () => {
	it("runs this CLI as ssh's ProxyCommand, keeps host keys under the sandbox's ID, and keeps the URL out of ssh's arguments", () => {
		const args = tunnelSshArgs(access, { ...options, identityFile: "/k/sbx_4kq9x2mt" });
		expect(args).toEqual([
			"-i",
			"/k/sbx_4kq9x2mt",
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"ProxyCommand=/usr/bin/node /opt/kantel/main.js ssh-proxy",
			"-o",
			"HostKeyAlias=sbx_4kq9x2mt",
			"-o",
			"UserKnownHostsFile=/k/known_hosts",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"user@sbx_4kq9x2mt",
		]);
		expect(args.join(" ")).not.toContain(URL_);
	});

	it("quotes paths for the shell ssh runs the ProxyCommand with, and escapes ssh's % tokens", () => {
		const args = tunnelSshArgs(access, { ...options, self: ["/Users/me/my apps/node", "/x/100%/main.js"] });
		expect(args).toContain("ProxyCommand='/Users/me/my apps/node' /x/100%%/main.js ssh-proxy");
	});

	it("prints a command that carries the URL to ssh-proxy itself", () => {
		const command = tunnelSshCommand(access, { ...options, self: ["kantel"] });
		expect(command).toBe(
			`ssh -o 'ProxyCommand=kantel ssh-proxy --url ${URL_}' -o HostKeyAlias=sbx_4kq9x2mt -o UserKnownHostsFile=/k/known_hosts -o StrictHostKeyChecking=accept-new user@sbx_4kq9x2mt`,
		);
	});

	it("takes the URL from --url or the environment kantel ssh sets, and only a WebSocket URL", () => {
		expect(proxyUrlOf(URL_, {})).toBe(URL_);
		expect(proxyUrlOf(undefined, { [SSH_URL_ENV]: URL_ })).toBe(URL_);
		expect(() => proxyUrlOf(undefined, {})).toThrow(/needs --url/);
		expect(() => proxyUrlOf("https://kantel.test/x", {})).toThrow(/ws:\/\/ or wss:\/\//);
	});

	it("pipes stdin into the tunnel as binary frames and the tunnel's frames to stdout, until the sandbox closes", async () => {
		const fake = fakeSocket();
		const out = sink();
		const input = stdinOf([new TextEncoder().encode("SSH-2.0-OpenSSH_9.9\r\n")]);
		const done = pipeTunnel(URL_, { stdin: input.stream, ...out }, (url) => {
			expect(url).toBe(URL_);
			return fake.socket;
		});
		expect(fake.socket.binaryType).toBe("arraybuffer");
		fake.open();
		await tick();
		expect(new TextDecoder().decode(fake.sent[0])).toBe("SSH-2.0-OpenSSH_9.9\r\n");
		fake.message(new TextEncoder().encode("SSH-2.0-OpenSSH_9.6 sandbox\r\n"));
		expect(new TextDecoder().decode(out.chunks[0])).toBe("SSH-2.0-OpenSSH_9.6 sandbox\r\n");
		fake.close(1000);
		expect(await done).toBe(0);
		input.end();
	});

	it("closes the tunnel when ssh closes its side", async () => {
		const fake = fakeSocket();
		const out = sink();
		const input = stdinOf([]);
		void pipeTunnel(URL_, { stdin: input.stream, ...out }, () => fake.socket);
		fake.open();
		input.end();
		await tick();
		expect(fake.closed()).toEqual({ code: 1000, reason: "ssh closed its side" });
	});

	it("fails as ssh's own connection failures do when the gateway refuses the URL (expired, forged)", async () => {
		const fake = fakeSocket();
		const out = sink();
		const done = pipeTunnel(URL_, { stdin: stdinOf([]).stream, ...out }, () => fake.socket);
		fake.close(4003, "The tunnel URL is wrong or has expired");
		expect(await done).toBe(255);
		expect(out.text.join("")).toContain("The tunnel URL is wrong or has expired");
	});

	it("fails when the tunnel can't open or drops", async () => {
		const failed = fakeSocket();
		const out = sink();
		const refused = pipeTunnel(URL_, { stdin: stdinOf([]).stream, ...out }, () => failed.socket);
		failed.error();
		expect(await refused).toBe(255);

		const dropped = fakeSocket();
		const input = stdinOf([]);
		const done = pipeTunnel(URL_, { stdin: input.stream, ...sink() }, () => dropped.socket);
		dropped.open();
		dropped.close(1011, "The sandbox's host went away");
		expect(await done).toBe(255);
		input.end();
	});
});

describe("the commands", () => {
	let configDir = "";
	beforeEach(async () => {
		configDir = await mkdtemp(join(tmpdir(), "kantel-ssh-"));
	});
	afterEach(async () => {
		await rm(configDir, { recursive: true, force: true });
	});

	const kantel = async (argv: string[], answer: unknown) => {
		const out: string[] = [];
		const err: string[] = [];
		const decoder = new TextDecoder();
		const write = (into: string[]) => ({
			write: (chunk: string | Uint8Array) => into.push(typeof chunk === "string" ? chunk : decoder.decode(chunk)),
		});
		const code = await run(argv, {
			fetch: async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }),
			env: { KANTEL_URL: "https://kantel.test", KANTEL_API_KEY: "ksk_test" },
			stdout: write(out),
			stderr: write(err),
			stdin: { isTTY: true, async *[Symbol.asyncIterator]() {} },
			configDir,
			cwd: configDir,
		});
		return { code, stdout: out.join(""), stderr: err.join("") };
	};

	const answer = {
		host: "kantel.test",
		port: 443,
		user: "user",
		command: `ssh -o ProxyCommand='websocat --binary ${URL_}' user@sbx_4kq9x2mt`,
		proxyUrl: URL_,
		privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
		hostKeyFingerprint: "SHA256:hostkey",
		expiresAt: Date.now() + 10 * 60_000,
	};

	/** Runs `kantel` with an `ssh` on PATH that writes its arguments, one a line, and its relay URL, and exits 7. */
	const withFakeSsh = async (argv: string[]) => {
		const bin = join(configDir, "bin");
		const log = join(configDir, "ssh.log");
		await rm(bin, { recursive: true, force: true });
		await mkdir(bin);
		await writeFile(
			join(bin, "ssh"),
			`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\necho "url=$${SSH_URL_ENV}" >> '${log}'\nexit 7\n`,
		);
		await chmod(join(bin, "ssh"), 0o755);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path ?? ""}`;
		try {
			const result = await kantel(argv, answer);
			return { ...result, args: (await readFile(log, "utf8")).trimEnd().split("\n") };
		} finally {
			process.env.PATH = path;
		}
	};

	it("kantel ssh connects by default, through the relay, and exits with ssh's code", async () => {
		const { code, args } = await withFakeSsh(["ssh", "sbx_4kq9x2mt"]);
		expect(code).toBe(7);
		expect(args).toContain("HostKeyAlias=sbx_4kq9x2mt");
		expect(args.at(-2)).toBe("user@sbx_4kq9x2mt");
		// The URL goes to ssh-proxy in the environment, not in ssh's arguments.
		expect(args.at(-1)).toBe(`url=${URL_}`);
		expect(args.slice(0, -1).join(" ")).not.toContain(URL_);
	});

	it("kantel ssh <id> -- <command> runs that command over SSH, quoted as exec quotes it", async () => {
		const { code, args } = await withFakeSsh(["ssh", "sbx_4kq9x2mt", "--", "ls", "-la", "my dir"]);
		expect(code).toBe(7);
		expect(args.slice(-4, -1)).toEqual(["user@sbx_4kq9x2mt", "--", "ls -la 'my dir'"]);
		const line = await withFakeSsh(["ssh", "sbx_4kq9x2mt", "--", "make && make test"]);
		expect(line.args.at(-2)).toBe("make && make test");
	});

	it("kantel ssh wants its command after --, and --print takes none", async () => {
		const extra = await kantel(["ssh", "sbx_4kq9x2mt", "uname"], answer);
		expect(extra.code).toBe(2);
		expect(extra.stderr).toContain("after --");
		const both = await kantel(["ssh", "sbx_4kq9x2mt", "--print", "--", "uname"], answer);
		expect(both.code).toBe(2);
		expect(both.stderr).toContain("--print");
	});

	it("kantel ssh --print prints a ProxyCommand through the relay when the answer has a proxyUrl", async () => {
		const { code, stdout } = await kantel(["ssh", "sbx_4kq9x2mt", "--print"], answer);
		expect(code).toBe(0);
		expect(stdout).toContain(`ProxyCommand=kantel ssh-proxy --url ${URL_}`);
		expect(stdout).toContain(`-i ${join(configDir, "ssh", "sbx_4kq9x2mt")}`);
		expect(stdout).toContain(`UserKnownHostsFile=${join(configDir, "ssh", "known_hosts")}`);
		expect(stdout).toContain("user@sbx_4kq9x2mt");
		expect(stdout).not.toContain("PRIVATE KEY");
	});

	it("kantel ssh-proxy without a URL is a usage error", async () => {
		const { code, stderr } = await kantel(["ssh-proxy"], {});
		expect(code).toBe(2);
		expect(stderr).toContain("needs --url");
	});
});
