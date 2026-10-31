/**
 * Workspace objects in an S3-compatible bucket (MinIO on the compose stack), over `fetch` with SigV4 from aws4fetch,
 * so the same code runs under Bun and Node.
 */
import { KantelError } from "@kantel/contracts";
import { AwsClient } from "aws4fetch";
import type { ObjectBucket } from "./postgres.ts";

export interface S3ObjectsOptions {
	/** The endpoint, path-style: `http://127.0.0.1:59000`. */
	readonly endpoint: string;
	readonly bucket: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly region?: string;
	/** Prepended to every key, so several stores (or test runs) share one bucket apart. */
	readonly prefix?: string;
	/** Tests count requests through this; the global `fetch` when absent. */
	readonly fetch?: typeof fetch;
}

export interface S3Objects extends ObjectBucket {
	/** An HTTP range read; a store that ignores `Range` sends the whole object, which is sliced. */
	getRange(key: string, offset: number, length: number): Promise<Uint8Array | undefined>;
	/** Creates the bucket if it is missing. */
	ensureBucket(): Promise<void>;
}

export function createS3Objects(options: S3ObjectsOptions): S3Objects {
	const region = options.region ?? "us-east-1";
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		service: "s3",
		region,
	});
	const send = options.fetch ?? fetch;
	const base = `${options.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}`;
	const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
	const url = (key: string) =>
		`${base}/${[...(prefix === "" ? [] : prefix.split("/")), ...key.split("/")].map(encodeURIComponent).join("/")}`;

	async function request(target: string, init: RequestInit): Promise<Response> {
		// For s3, aws4fetch decodes the path and encodes it once for the canonical request, which is what S3 signs
		// (`singleEncode` would skip that encoding and break keys with `%` or spaces).
		const signed = await client.sign(target, init);
		return send(signed);
	}

	async function failure(response: Response, what: string): Promise<never> {
		const body = await response.text().catch(() => "");
		throw new KantelError("unavailable", `object store ${what} failed with ${response.status}`, {
			status: response.status,
			body: body.slice(0, 200),
		});
	}

	return {
		async get(key) {
			const response = await request(url(key), { method: "GET" });
			if (response.status === 404) {
				await response.body?.cancel();
				return undefined;
			}
			if (!response.ok) return failure(response, `GET ${key}`);
			return new Uint8Array(await response.arrayBuffer());
		},
		async getRange(key, offset, length) {
			const response = await request(url(key), {
				method: "GET",
				headers: { range: `bytes=${offset}-${offset + length - 1}` },
			});
			if (response.status === 404) {
				await response.body?.cancel();
				return undefined;
			}
			if (!response.ok) return failure(response, `GET ${key} (range)`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			// 206 is the range; a store that ignores ranges answers 200 with the whole object.
			return response.status === 206 ? bytes : bytes.slice(offset, offset + length);
		},
		async put(key, bytes) {
			const response = await request(url(key), {
				method: "PUT",
				body: bytes as Uint8Array<ArrayBuffer>,
				headers: { "content-length": String(bytes.byteLength) },
			});
			if (!response.ok) return failure(response, `PUT ${key}`);
			await response.body?.cancel();
		},
		async ensureBucket() {
			const exists = async () => {
				const head = await request(base, { method: "HEAD" });
				await head.body?.cancel();
				if (head.ok) return true;
				// 403 is someone else's bucket or bad credentials: creating would not help.
				if (head.status !== 404) return failure(head, "HEAD bucket");
				return false;
			};
			if (await exists()) return;
			// Outside us-east-1, S3 needs the region named in the request body.
			const body =
				region === "us-east-1"
					? undefined
					: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
			const created = await request(base, {
				method: "PUT",
				...(body === undefined ? {} : { body, headers: { "content-type": "application/xml" } }),
			});
			if (created.ok) {
				await created.body?.cancel();
				return;
			}
			// A 409 is either another process creating it meanwhile (ours, so it now answers HEAD) or another account's.
			// `BucketAlreadyExists` is always another account's: a HEAD that succeeds proves access, not ownership.
			if (created.status === 409) {
				const conflict = await created.text().catch(() => "");
				const theirs = conflict.includes("<Code>BucketAlreadyExists</Code>");
				if (!theirs && (conflict.includes("BucketAlreadyOwnedByYou") || (await exists()))) return;
				throw new KantelError("unavailable", `bucket ${options.bucket} belongs to someone else`, {
					status: 409,
					body: conflict.slice(0, 200),
				});
			}
			return failure(created, "create bucket");
		},
	};
}

/** An in-memory bucket for tests, counting reads of blobs and trees. */
export function createMemoryObjects(): ObjectBucket & { readonly counts: { blobs: number; trees: number } } {
	const objects = new Map<string, Uint8Array>();
	const counts = { blobs: 0, trees: 0 };
	return {
		counts,
		async get(key) {
			const bytes = objects.get(key);
			if (bytes === undefined) return undefined;
			if (key.includes("/blobs/")) counts.blobs++;
			else counts.trees++;
			return new Uint8Array(bytes);
		},
		async getRange(key, offset, length) {
			const bytes = objects.get(key);
			return bytes === undefined ? undefined : bytes.slice(offset, offset + length);
		},
		async put(key, bytes) {
			objects.set(key, new Uint8Array(bytes));
		},
	};
}
