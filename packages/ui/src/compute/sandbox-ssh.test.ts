import { describe, expect, it } from "vitest";
import { CLI_INSTALL_COMMAND, cliSshCommand, sshWithoutCliCommand } from "./compute-model.ts";
import { publicKeyProblem } from "./sandbox-ssh.tsx";

const RELAY = { sandboxId: "sbx_3ucrku3aio", user: "user", host: "app.kantel.dev", port: 443 };
const URL = "wss://app.kantel.dev/v1/hosts/tunnel/C9Kd0r-jfuU36OaE.PUuh3fNVUMx2M";

describe("the SSH box's commands", () => {
	it("leads with the CLI's command, which carries no token, and installs the CLI from kantel.dev", () => {
		expect(cliSshCommand("sbx_3ucrku3aio")).toBe("kantel ssh sbx_3ucrku3aio");
		expect(cliSshCommand("sbx_3ucrku3aio", true)).toBe("kantel e2e ssh sbx_3ucrku3aio");
		expect(CLI_INSTALL_COMMAND).toBe("curl -fsSL https://kantel.dev/cli.sh | sh");
	});

	it("puts a downloaded key in plain ssh through websocat, made private first so ssh will use it", () => {
		expect(sshWithoutCliCommand({ ...RELAY, proxyUrl: URL }, "~/Downloads/kantel-sbx_3ucrku3aio")).toBe(
			"chmod 600 ~/Downloads/kantel-sbx_3ucrku3aio && ssh -i ~/Downloads/kantel-sbx_3ucrku3aio -o IdentitiesOnly=yes " +
				`-o 'ProxyCommand=websocat --binary ${URL}' user@sbx_3ucrku3aio`,
		);
		// A key the person pasted is already theirs: ssh finds it as it always does.
		expect(sshWithoutCliCommand({ ...RELAY, proxyUrl: URL })).toBe(
			`ssh -o 'ProxyCommand=websocat --binary ${URL}' user@sbx_3ucrku3aio`,
		);
	});

	it("dials an SSH gateway where there is one, and keeps a % in the relay's URL literal for ssh", () => {
		expect(sshWithoutCliCommand({ ...RELAY, host: "ssh.example.com", port: 2222 })).toBe(
			"ssh -p 2222 user@ssh.example.com",
		);
		expect(sshWithoutCliCommand({ ...RELAY, proxyUrl: "wss://h/t%41" })).toContain("--binary wss://h/t%%41'");
		expect(sshWithoutCliCommand(RELAY, "/home/ada/my key")).toBe(
			"chmod 600 '/home/ada/my key' && ssh -i '/home/ada/my key' -o IdentitiesOnly=yes -p 443 user@app.kantel.dev",
		);
	});
});

describe("publicKeyProblem", () => {
	it("takes one OpenSSH public key, or nothing (Kantel makes a pair), and says what's wrong with anything else", () => {
		expect(publicKeyProblem("")).toBeUndefined();
		expect(publicKeyProblem("  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample ada@laptop\n")).toBeUndefined();
		expect(publicKeyProblem("ecdsa-sha2-nistp256 AAAAE2VjZHNh")).toBeUndefined();
		expect(publicKeyProblem("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----")).toMatch(
			/private key/,
		);
		expect(publicKeyProblem("ssh-ed25519 AAAA one\nssh-ed25519 BBBB two")).toMatch(/one OpenSSH public key/);
		expect(publicKeyProblem("hello")).toMatch(/one OpenSSH public key/);
	});
});
