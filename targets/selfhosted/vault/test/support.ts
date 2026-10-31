import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConformanceDeps } from "@kantel/testing/harness";
import type { KantelVaultUnderTest, VaultDurableSubject } from "@kantel/testing/vault";
import { createAesGcmCipher, randomCipherKey } from "@kantel/vault/cipher";
import {
	createEgressDecisionApi,
	createEgressDecisionClient,
	createSharedKeyAuthenticator,
} from "@kantel/vault/egress-api";
import { createVault } from "@kantel/vault/engine";
import type { VaultStore } from "@kantel/vault/store";

const GATEWAY_KEY = `egress-gateway-${crypto.randomUUID()}`;

/** Serves a fetch-style handler on a loopback port; resolves its base URL and a close. */
async function serve(handler: (request: Request) => Promise<Response>) {
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(chunk as Buffer);
		const headers = new Headers();
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (typeof value === "string") headers.set(name, value);
		}
		const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
		const response = await handler(
			new Request(`http://${incoming.headers.host}${incoming.url}`, {
				method: incoming.method ?? "GET",
				headers,
				...(body === undefined ? {} : { body }),
			}),
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

/**
 * The durable subject over one store: every `open()` is a new vault on it with the same key, the case's clock, audit
 * sink and access, as another process would build it. `rawRows` reads the database directly.
 */
export function durableSubject(
	deps: ConformanceDeps,
	store: VaultStore,
	rawRows: VaultDurableSubject["rawRows"],
): VaultDurableSubject {
	const key = randomCipherKey();
	const open = (): KantelVaultUnderTest =>
		createVault({
			store,
			cipher: createAesGcmCipher({ key }),
			clock: deps.clock,
			audit: deps.audit,
			access: deps.access,
		});
	return {
		open,
		rawRows,
		async serveEgressApi(vault) {
			const authenticate = createSharedKeyAuthenticator({ keys: { "egress-gateway": GATEWAY_KEY } });
			const server = await serve(createEgressDecisionApi({ vault, authenticate }));
			return {
				client: createEgressDecisionClient({ baseUrl: server.baseUrl, token: GATEWAY_KEY }),
				close: server.close,
			};
		},
	};
}
