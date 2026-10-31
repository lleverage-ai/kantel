import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "@kantel/contracts";
import { createMockIdp, type MockIdp } from "@kantel/identity/testing";

/**
 * A mock OIDC identity provider served over real HTTP on 127.0.0.1 and a free port: its issuer is
 * `http://127.0.0.1:<port>`, so a provider with the global fetch discovers and fetches its keys over the loopback.
 */
export async function startHttpIdp(options: { readonly audience: string; readonly clock: Clock }): Promise<{
	readonly idp: MockIdp;
	/** The paths requested so far, in order. */
	readonly served: readonly string[];
	close(): Promise<void>;
}> {
	let idp: MockIdp | undefined;
	const served: string[] = [];
	const server = createServer((request, response) => {
		const path = request.url ?? "/";
		served.push(path);
		if (idp === undefined) {
			response.writeHead(503).end();
			return;
		}
		void idp.fetch(`${idp.issuer}${path}`).then(async (answer) => {
			response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "text/plain" });
			response.end(await answer.text());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	idp = createMockIdp({ issuer: `http://127.0.0.1:${port}`, audience: options.audience, clock: options.clock });
	return {
		idp,
		served,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}
