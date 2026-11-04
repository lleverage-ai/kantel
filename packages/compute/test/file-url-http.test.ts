// A signed file URL takes no credential: the compute API hands it to the service before anyone is signed in, whatever
// its method's body. With mounts off the service refuses it, so it answers 501 not_supported, not 401.
import { MOUNTS_OFF } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend } from "../src/stub-backend.ts";

const apis: ComputeApi[] = [];
afterEach(async () => {
	for (const api of apis.splice(0)) await api.close();
});

function api(): ComputeApi {
	const made = createComputeApi({ backend: createStubBackend() });
	apis.push(made);
	return made;
}

describe("signed file URLs over HTTP", () => {
	it("reach the service with no credential, for GET, HEAD and PUT", async () => {
		const compute = api();
		for (const init of [
			{ method: "GET" },
			{ method: "HEAD" },
			{ method: "PUT", body: new Uint8Array([1, 2, 3]) },
		] as const) {
			const response = await compute.fetch(new Request("http://compute.test/v1/file-urls/kfu_abc-DEF_123", init));
			expect(response?.status).toBe(501);
			expect(await response?.json()).toEqual({ error: { code: "not_supported", message: MOUNTS_OFF } });
		}
	});

	it("leave other methods and paths alone", async () => {
		const compute = api();
		const post = await compute.fetch(new Request("http://compute.test/v1/file-urls/kfu_abc", { method: "POST" }));
		expect(post?.status).toBe(405);
		expect(post?.headers.get("allow")).toBe("GET, HEAD, PUT");
		await post?.body?.cancel();
		// Not a token's shape: no route of the API's, so the gateway's turn.
		expect(await compute.fetch(new Request("http://compute.test/v1/file-urls/a.b"))).toBeUndefined();
		expect(await compute.fetch(new Request("http://compute.test/v1/file-urls/"))).toBeUndefined();
		// Under another base path, nothing.
		expect(await compute.fetch(new Request("http://compute.test/file-urls/kfu_abc"))).toBeUndefined();
		// Any other route still asks for a sign-in.
		const signedOut = await compute.fetch(new Request("http://compute.test/v1/sandboxes"));
		expect(signedOut?.status).toBe(401);
		await signedOut?.body?.cancel();
	});
});
