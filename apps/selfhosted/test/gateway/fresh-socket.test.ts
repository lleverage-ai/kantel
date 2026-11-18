// The sockets the gateway's Postgres connections use (fresh-socket.ts). That Bun's own lookup keeps a failed answer and
// these don't is shown on a real install (a gateway started while Compose's Postgres is stopped); here, that they
// connect and fail as `net`'s do.
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FreshLookupSocket, freshLookupStream, lookupFresh } from "../../src/gateway/fresh-socket.ts";

let server: Server;
let port: number;

beforeAll(async () => {
	server = createServer((socket) => socket.end("hello"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	port = typeof address === "object" && address !== null ? address.port : 0;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const outcome = (socket: FreshLookupSocket) =>
	new Promise<string>((resolve) => {
		socket.once("data", (data) => resolve(String(data)));
		socket.once("error", (error: NodeJS.ErrnoException) => resolve(`error ${error.code}`));
	});

describe("FreshLookupSocket", () => {
	it("looks a name up and connects to its address", async () => {
		const socket = freshLookupStream() as FreshLookupSocket;
		expect(socket.connect(port, "localhost")).toBe(socket);
		expect(await outcome(socket)).toBe("hello");
	});

	it("connects to an address as it is", async () => {
		const socket = new FreshLookupSocket();
		socket.connect(port, "127.0.0.1");
		expect(await outcome(socket)).toBe("hello");
	});

	it("fails with ENOTFOUND for a name that doesn't resolve", async () => {
		const socket = new FreshLookupSocket();
		socket.connect(port, "no-such-host.invalid");
		expect(await outcome(socket)).toBe("error ENOTFOUND");
		expect(socket.destroyed).toBe(true);
	});

	it("gives net every address, so it tries the next family when one can't be reached", async () => {
		expect((await lookupFresh("localhost")).map((each) => each.address)).toContain("127.0.0.1");
		// ::1 first, where nothing listens on the port; the server is on 127.0.0.1.
		const asked: string[] = [];
		const socket = new FreshLookupSocket(async (host) => {
			asked.push(host);
			return [
				{ address: "::1", family: 6 },
				{ address: "127.0.0.1", family: 4 },
			];
		});
		let connectedTo: string | undefined;
		socket.once("connect", () => (connectedTo = socket.remoteAddress));
		socket.connect(port, "postgres.example");
		expect(await outcome(socket)).toBe("hello");
		expect(asked).toEqual(["postgres.example"]);
		expect(connectedTo).toBe("127.0.0.1");
	});

	it("doesn't connect once destroyed during the lookup", async () => {
		let accepted = 0;
		server.once("connection", () => (accepted += 1));
		const socket = new FreshLookupSocket();
		socket.on("error", () => undefined);
		socket.connect(port, "localhost");
		socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(accepted).toBe(0);
	});
});
