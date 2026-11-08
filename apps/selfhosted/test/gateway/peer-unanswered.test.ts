// A call relayed to the replica holding the host says whether the host may have carried it out: one sent on whose answer
// was lost is `unanswered`, so what it would have placed is kept; one the peer refused before sending it on, or that
// never left, isn't.
import { createReplicaKey, type ReplicaRecord } from "@kantel/hosts/cluster";
import { HostCallError } from "@kantel/hosts/hub";
import { describe, expect, it } from "vitest";
import { createPeerTransport } from "../../src/gateway/cluster.ts";

const peer: ReplicaRecord = { id: "rep_b", url: "http://peer.test", publicKey: "", startedAt: 0, heartbeatAt: 0 };

async function failureOf(fetch: typeof globalThis.fetch, signal?: AbortSignal): Promise<HostCallError> {
	const transport = createPeerTransport({ replicaId: "rep_a", key: await createReplicaKey(), fetch });
	try {
		await transport.call(peer, "host_1", "sandbox.create", {}, signal === undefined ? {} : { signal });
	} catch (error) {
		if (error instanceof HostCallError) return error;
		throw error;
	}
	throw new Error("The call succeeded");
}

const answering = (lines: string, status = 200) =>
	(async () => new Response(lines, { status })) as unknown as typeof globalThis.fetch;

describe("a relayed call's failure", () => {
	it("carries the host's own error, answered", async () => {
		const error = await failureOf(answering(`${JSON.stringify({ error: { code: "capacity", message: "full" } })}\n`));
		expect(error.code).toBe("capacity");
		expect(error.unanswered).toBe(false);
	});

	it("carries the peer's word that the host never answered", async () => {
		const lost = { error: { code: "unavailable", message: "The host disconnected: gone", unanswered: true } };
		const error = await failureOf(answering(`${JSON.stringify(lost)}\n`));
		expect(error.unanswered).toBe(true);
		expect(error.disconnected).toBe(false);
	});

	it("carries the peer's word that the host wasn't there, so a stop waits for it (#737)", async () => {
		const gone = {
			error: { code: "unavailable", message: "The host disconnected: gone", unanswered: true, disconnected: true },
		};
		const error = await failureOf(answering(`${JSON.stringify(gone)}\n`));
		expect(error.disconnected).toBe(true);
		expect(error.unanswered).toBe(true);
		expect(
			(await failureOf(answering(`${JSON.stringify({ error: { code: "capacity", message: "full" } })}\n`)))
				.disconnected,
		).toBe(false);
	});

	it("is unanswered when the peer's answer never comes", async () => {
		expect((await failureOf(answering(""))).unanswered).toBe(true);
		expect((await failureOf(answering("", 502))).unanswered).toBe(true);
		const unreachable = (async () => {
			throw new TypeError("socket hang up");
		}) as unknown as typeof globalThis.fetch;
		expect((await failureOf(unreachable)).unanswered).toBe(true);
	});

	it("isn't unanswered when the peer refused it, or it never left", async () => {
		expect((await failureOf(answering("", 409))).unanswered).toBe(false);
		const aborted = new AbortController();
		aborted.abort();
		let sent = false;
		const spy = (async () => {
			sent = true;
			return new Response("");
		}) as unknown as typeof globalThis.fetch;
		const error = await failureOf(spy, aborted.signal);
		expect(sent).toBe(false);
		expect(error.unanswered).toBe(false);
	});
});
