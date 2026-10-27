import { isHarbourError } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { createS3Objects } from "../src/index.ts";

type Reply = { status: number; body?: string };

/** A fake S3 answering each request in turn, recording what was sent. */
function scripted(replies: Reply[]) {
	const sent: { method: string; url: string; body: string; contentType: string | null; auth: boolean }[] = [];
	const fake: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		sent.push({
			method: request.method,
			url: request.url,
			body: await request.text(),
			contentType: request.headers.get("content-type"),
			auth: request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256") === true,
		});
		const reply = replies.shift();
		if (reply === undefined) throw new Error("unexpected request");
		return new Response(reply.body ?? null, { status: reply.status });
	};
	return { fake, sent };
}

const base = { endpoint: "http://s3.test", bucket: "b", accessKeyId: "k", secretAccessKey: "s" };

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isHarbourError(error) ? error.code : "not a HarbourError";
	}
	return undefined;
}

describe("createS3Objects", () => {
	it("signs requests and encodes each key segment once, under the prefix", async () => {
		const { fake, sent } = scripted([{ status: 200 }, { status: 404 }]);
		const objects = createS3Objects({ ...base, prefix: "lane/run", fetch: fake });
		await objects.put("org/org%2F%C3%A4/blobs/abc", new Uint8Array([1]));
		expect(await objects.get("org/x y/trees/t.json")).toBeUndefined();
		expect(sent.map((request) => [request.method, request.url, request.auth])).toEqual([
			["PUT", "http://s3.test/b/lane/run/org/org%252F%25C3%25A4/blobs/abc", true],
			["GET", "http://s3.test/b/lane/run/org/x%20y/trees/t.json", true],
		]);
	});

	it("creates a missing bucket, naming the region outside us-east-1", async () => {
		const { fake, sent } = scripted([{ status: 404 }, { status: 200 }]);
		await createS3Objects({ ...base, region: "eu-west-1", fetch: fake }).ensureBucket();
		expect(sent[1]).toMatchObject({ method: "PUT", contentType: "application/xml" });
		expect(sent[1]?.body).toContain("<LocationConstraint>eu-west-1</LocationConstraint>");

		const plain = scripted([{ status: 404 }, { status: 200 }]);
		await createS3Objects({ ...base, fetch: plain.fake }).ensureBucket();
		expect(plain.sent[1]?.body).toBe("");
	});

	it("accepts a creation race it lost to itself, and refuses another account's bucket", async () => {
		const ours = scripted([{ status: 404 }, { status: 409, body: "<Code>BucketAlreadyOwnedByYou</Code>" }]);
		await createS3Objects({ ...base, fetch: ours.fake }).ensureBucket();

		const raced = scripted([{ status: 404 }, { status: 409, body: "<Code>OperationAborted</Code>" }, { status: 200 }]);
		await createS3Objects({ ...base, fetch: raced.fake }).ensureBucket();

		const theirs = scripted([
			{ status: 404 },
			{ status: 409, body: "<Code>BucketAlreadyExists</Code>" },
			{ status: 404 },
		]);
		expect(await codeOf(createS3Objects({ ...base, fetch: theirs.fake }).ensureBucket())).toBe("unavailable");

		// Another account's bucket that lets us list it is still not ours, so HEAD is not asked.
		const readable = scripted([
			{ status: 404 },
			{ status: 409, body: "<Code>BucketAlreadyExists</Code>" },
			{ status: 200 },
		]);
		expect(await codeOf(createS3Objects({ ...base, fetch: readable.fake }).ensureBucket())).toBe("unavailable");
		expect(readable.sent).toHaveLength(2);

		const forbidden = scripted([{ status: 403 }]);
		expect(await codeOf(createS3Objects({ ...base, fetch: forbidden.fake }).ensureBucket())).toBe("unavailable");
		expect(forbidden.sent).toHaveLength(1);
	});

	it("answers unavailable when the store fails", async () => {
		const { fake } = scripted([{ status: 500, body: "boom" }, { status: 503 }]);
		const objects = createS3Objects({ ...base, fetch: fake });
		expect(await codeOf(objects.get("a"))).toBe("unavailable");
		expect(await codeOf(objects.put("a", new Uint8Array()))).toBe("unavailable");
	});
});
