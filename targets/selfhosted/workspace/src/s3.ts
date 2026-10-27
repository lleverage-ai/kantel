/**
 * Workspace objects in an S3-compatible bucket (MinIO on the compose stack), over `fetch` with SigV4 from aws4fetch,
 * so the same code runs under Bun and Node.
 */
import { HarbourError } from "@harbour/contracts";
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
	/** Creates the bucket if it is missing. */
	ensureBucket(): Promise<void>;
}

export function createS3Objects(options: S3ObjectsOptions): S3Objects {
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		service: "s3",
		region: options.region ?? "us-east-1",
		retries: 2,
	});
	const send = options.fetch ?? fetch;
	const base = `${options.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(options.bucket)}`;
	const prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
	const url = (key: string) =>
		`${base}/${[...(prefix === "" ? [] : prefix.split("/")), ...key.split("/")].map(encodeURIComponent).join("/")}`;

	async function request(target: string, init: RequestInit): Promise<Response> {
		const signed = await client.sign(target, { ...init, aws: { singleEncode: true } });
		return send(signed);
	}

	async function failure(response: Response, what: string): Promise<never> {
		const body = await response.text().catch(() => "");
		throw new HarbourError("unavailable", `object store ${what} failed with ${response.status}`, {
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
			const head = await request(base, { method: "HEAD" });
			if (head.ok) return;
			const created = await request(base, { method: "PUT" });
			// Another process may have created it meanwhile.
			if (!created.ok && created.status !== 409) return failure(created, "create bucket");
			await created.body?.cancel();
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
		async put(key, bytes) {
			objects.set(key, new Uint8Array(bytes));
		},
	};
}
