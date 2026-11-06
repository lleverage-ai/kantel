/**
 * SSH through Kantel's relay, for `kantel ssh` on a control plane whose sandboxes run on its own hosts. A sandbox has
 * no address anyone can dial: the answer to `POST /v1/sandboxes/{id}/ssh` carries `proxyUrl`, a short-lived WebSocket
 * URL whose binary frames are the sandbox's sshd's bytes, relayed by the gateway over the connection the sandbox's
 * host keeps open. `ssh` reaches it through `-o ProxyCommand=…`, which runs `kantel ssh-proxy`: that pipes its stdin
 * and stdout through the WebSocket, and nothing more. SSH's own encryption and host key check run end to end inside it.
 *
 * Self-contained: the CLI's `ssh` command calls `tunnelSshArgs` when an answer has `proxyUrl`, and registers
 * `sshProxyCommand`'s `run` as `kantel ssh-proxy`.
 */

/** Where `kantel ssh` hands the URL to the ProxyCommand it starts, so the URL isn't in ssh's arguments. */
export const SSH_URL_ENV = "KANTEL_SSH_URL";

export interface TunnelAccess {
	readonly user: string;
	readonly proxyUrl: string;
}

export interface TunnelSshOptions {
	/** The command that runs this CLI, such as `[process.execPath, process.argv[1]]`. */
	readonly self: readonly string[];
	/** The sandbox's ID: ssh's name for it, and the name its host key is kept under. */
	readonly sandboxId: string;
	/** The known_hosts file the CLI keeps sandboxes' host keys in. */
	readonly knownHosts: string;
	/** A private key Kantel made for this access. */
	readonly identityFile?: string;
}

export function shellWord(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * ssh's arguments for access through the relay: `ProxyCommand` runs `kantel ssh-proxy`, which takes the URL from
 * `SSH_URL_ENV` (set it in ssh's environment). Host keys are kept under the sandbox's ID, in the CLI's own file, and
 * learnt the first time: the relay is reached over TLS with a URL the API signed for this sandbox alone.
 */
export function tunnelSshArgs(access: TunnelAccess, options: TunnelSshOptions): string[] {
	// ssh expands %-tokens in a ProxyCommand: a literal % is %%.
	const proxy = [...options.self, "ssh-proxy"].map(shellWord).join(" ").replaceAll("%", "%%");
	return [
		...(options.identityFile === undefined ? [] : ["-i", options.identityFile, "-o", "IdentitiesOnly=yes"]),
		"-o",
		`ProxyCommand=${proxy}`,
		"-o",
		`HostKeyAlias=${options.sandboxId}`,
		"-o",
		`UserKnownHostsFile=${options.knownHosts}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		`${access.user}@${options.sandboxId}`,
	];
}

/** A command line to print: the same, with the URL on `ssh-proxy`'s command line rather than in the environment. */
export function tunnelSshCommand(access: TunnelAccess, options: TunnelSshOptions): string {
	const args = tunnelSshArgs(access, options);
	const at = args.findIndex((arg) => arg.startsWith("ProxyCommand="));
	args[at] = `${args[at]} --url ${shellWord(access.proxyUrl)}`;
	return ["ssh", ...args].map(shellWord).join(" ");
}

export interface ProxyStreams {
	readonly stdin: AsyncIterable<string | Uint8Array>;
	readonly stdout: { write(chunk: Uint8Array): unknown };
	readonly stderr: { write(chunk: string): unknown };
}

type Socket = Pick<WebSocket, "binaryType" | "readyState" | "send" | "close"> & {
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
};

/**
 * `kantel ssh-proxy`: pipes stdin into the WebSocket at `url` as binary frames and its frames to stdout, until either
 * side ends. Resolves with the exit code: 0 when the sandbox's side closed normally, 255 (ssh's own code for a failed
 * connection) when the URL is refused, wrong or expired.
 */
export function pipeTunnel(
	url: string,
	streams: ProxyStreams,
	open: (url: string) => Socket = (target) => new WebSocket(target) as unknown as Socket,
): Promise<number> {
	return new Promise((done) => {
		let opened = false;
		let finished = false;
		const finish = (code: number, message?: string) => {
			if (finished) return;
			finished = true;
			if (message !== undefined) streams.stderr.write(`kantel ssh-proxy: ${message}\n`);
			done(code);
		};
		let socket: Socket;
		try {
			socket = open(url);
		} catch (error) {
			finish(255, `couldn't open the tunnel: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			opened = true;
			void (async () => {
				const encoder = new TextEncoder();
				try {
					for await (const chunk of streams.stdin) {
						if (finished) return;
						socket.send(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
					}
				} catch {
					// stdin closed under us: ssh has gone.
				}
				socket.close(1000, "ssh closed its side");
			})();
		};
		socket.onmessage = (event) => {
			const data = event.data;
			if (data instanceof ArrayBuffer) streams.stdout.write(new Uint8Array(data));
			else if (typeof data === "string") streams.stdout.write(new TextEncoder().encode(data));
		};
		socket.onerror = () => {
			if (!opened) finish(255, "couldn't open the tunnel: check the URL hasn't expired, and ask again");
		};
		socket.onclose = (event) => {
			if (!opened) return finish(255, `the tunnel was refused: ${event.reason || `code ${event.code}`}`);
			if (event.code === 1000 || event.code === 1005) return finish(0);
			// Most often Kantel restarting (a deploy closes every tunnel), which ends the SSH session and what it started.
			finish(
				255,
				`the tunnel closed: ${event.reason || `code ${event.code}`}. A command that must outlive the connection ` +
					"is safer as kantel exec <id> --detach -- <command>, then kantel attach <id> <command>",
			);
		};
	});
}

/** The URL `ssh-proxy` was given, from `--url` or the environment `kantel ssh` set. */
export function proxyUrlOf(flag: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
	const url = flag ?? env[SSH_URL_ENV];
	if (url === undefined || url === "") {
		throw new Error(`kantel ssh-proxy needs --url or ${SSH_URL_ENV}: run it as ssh's ProxyCommand from kantel ssh`);
	}
	if (!/^wss?:\/\//.test(url)) throw new Error("kantel ssh-proxy's URL is a ws:// or wss:// URL");
	return url;
}
