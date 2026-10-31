#!/usr/bin/env node
/**
 * `kantel-tunnel`: serves a local MCP server's tools to a Kantel tool server through the tunnel. Status goes to
 * stderr a line at a time; a fatal stop (a revoked token, a removed server, the MCP server exiting) exits non-zero,
 * and SIGINT or SIGTERM closes the tunnel and the server cleanly.
 *
 * Its names from before the rename still work: the `harbour-tunnel` command and `--harbour` for `--kantel`; and
 * HARBOUR_URL and HARBOUR_TUNNEL_TOKEN (before the rename) when the KANTEL_ ones aren't set.
 */
import { parseArgs } from "node:util";
import { httpEndpoint, isLoopbackUrl } from "./http.ts";
import { type StdioEndpoint, stdioEndpoint } from "./stdio.ts";
import { openTunnel, type TunnelEndpoint, type TunnelStatus } from "./tunnel.ts";

const USAGE = `Usage: kantel-tunnel --kantel <origin> --server <ts_…> [--token <hbt_…>] (-- <stdio command> | --url <loopback MCP URL>)

Serves a local MCP server's tools to a Kantel tool server.

  --kantel <origin>     Kantel's origin, such as https://kantel.example.com (or KANTEL_URL)
  --server <ts_…>       The tool server's ID
  --token <hbt_…>       A tunnel token of that server (better: KANTEL_TUNNEL_TOKEN, so it isn't in ps)
  -- <command…>         Run this stdio MCP server
  --url <url>           Bridge this Streamable HTTP MCP server, on 127.0.0.1, localhost or [::1]
  --allow-remote-url    Let --url be somewhere other than loopback
  -h, --help            Show this
`;

function say(line: string): void {
	process.stderr.write(`kantel-tunnel: ${line}\n`);
}

function usageError(problem: string): number {
	process.stderr.write(`kantel-tunnel: ${problem}\n\n${USAGE}`);
	return 2;
}

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	const split = argv.indexOf("--");
	const flags = split === -1 ? argv : argv.slice(0, split);
	const command = split === -1 ? [] : argv.slice(split + 1);
	let values: ReturnType<typeof parse>["values"];
	try {
		values = parse(flags).values;
	} catch (error) {
		return usageError(error instanceof Error ? error.message : String(error));
	}
	if (values.help === true) {
		process.stdout.write(USAGE);
		return 0;
	}
	// --harbour, HARBOUR_URL and HARBOUR_TUNNEL_TOKEN: the names from before the rename.
	const harbour = values.kantel ?? values.harbour ?? env.KANTEL_URL ?? env.HARBOUR_URL;
	const token = values.token ?? env.KANTEL_TUNNEL_TOKEN ?? env.HARBOUR_TUNNEL_TOKEN;
	const serverId = values.server;
	if (harbour === undefined || harbour.length === 0) return usageError("--kantel (or KANTEL_URL) is needed");
	if (serverId === undefined || serverId.length === 0) return usageError("--server is needed");
	if (token === undefined || token.length === 0) return usageError("--token (or KANTEL_TUNNEL_TOKEN) is needed");
	if (command.length > 0 === (values.url !== undefined)) {
		return usageError("give either -- <stdio command> or --url <url>, not both or neither");
	}

	let endpoint: TunnelEndpoint;
	let child: StdioEndpoint | undefined;
	try {
		if (values.url !== undefined) {
			endpoint = httpEndpoint(values.url, { allowRemote: values["allow-remote-url"] === true });
		} else {
			child = stdioEndpoint(command);
			endpoint = child;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const remote = values.url !== undefined && URL.canParse(values.url) && !isLoopbackUrl(new URL(values.url));
		return usageError(remote ? `${message}; pass --allow-remote-url to bridge it anyway` : message);
	}

	let exitCode = 0;
	let stopping = false;
	return new Promise<number>((resolve) => {
		const onStatus = (status: TunnelStatus): void => {
			switch (status.state) {
				case "connected":
					say(`connected to ${harbour} as ${serverId}`);
					break;
				case "reconnecting":
					say(`disconnected (${status.reason}); reconnecting in ${Math.max(1, Math.round(status.delayMs / 1000))}s`);
					break;
				case "stopped":
					stopping = true;
					if (status.fatal) say(`stopped: ${status.reason}`);
					resolve(status.fatal ? 1 : exitCode);
					break;
			}
		};
		let tunnel: ReturnType<typeof openTunnel>;
		try {
			tunnel = openTunnel({ harbour, serverId, token, endpoint, onStatus });
		} catch (error) {
			void endpoint.close?.();
			resolve(usageError(error instanceof Error ? error.message : String(error)));
			return;
		}
		const stop = (code: number): void => {
			if (stopping) return;
			stopping = true;
			exitCode = code;
			void tunnel.close();
		};
		for (const signal of ["SIGINT", "SIGTERM"] as const) {
			process.on(signal, () => {
				// A second one doesn't wait for the clean close.
				if (stopping) process.exit(130);
				stop(0);
			});
		}
		void child?.exited.then((exit) => {
			if (stopping) return;
			const how =
				exit.error ?? (exit.signal !== null ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`);
			say(`stopped: the MCP server ${exit.error === undefined ? how : `couldn't start: ${how}`}`);
			stop(1);
		});
	});
}

function parse(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		options: {
			kantel: { type: "string" },
			harbour: { type: "string" },
			server: { type: "string" },
			token: { type: "string" },
			url: { type: "string" },
			"allow-remote-url": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});
}

process.exit(await main(process.argv.slice(2), process.env));
