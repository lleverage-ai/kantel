import { AwsClient } from "aws4fetch";
import type { S3ObjectsOptions, SqlClient } from "../src/index.ts";

/** The test stack from the environment, or undefined when it is not configured. */
export function stackEnv(): { databaseUrl: string; s3: Omit<S3ObjectsOptions, "prefix"> } | undefined {
	const databaseUrl = process.env.HARBOUR_TEST_DATABASE_URL;
	const endpoint = process.env.HARBOUR_TEST_S3_ENDPOINT;
	if (databaseUrl === undefined || endpoint === undefined) return undefined;
	return {
		databaseUrl,
		s3: {
			endpoint,
			bucket: process.env.HARBOUR_TEST_S3_BUCKET ?? "harbour-m1-be23",
			accessKeyId: process.env.HARBOUR_TEST_S3_ACCESS_KEY ?? "harbour",
			secretAccessKey: process.env.HARBOUR_TEST_S3_SECRET_KEY ?? "harbour-dev-secret",
		},
	};
}

/** Drops the schemas a run created. */
export async function dropSchemas(db: SqlClient, schemas: Iterable<string>): Promise<void> {
	for (const schema of schemas) {
		if (!/^m1be23_[0-9a-f]{16}$/.test(schema)) throw new Error(`not a test schema: ${schema}`);
		await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	}
}

/** Deletes every object under a run's own prefix (never the bucket), with ListObjectsV2 and DeleteObject. */
export async function deletePrefix(s3: Omit<S3ObjectsOptions, "prefix">, prefix: string): Promise<number> {
	if (!/^m1-be23\/[0-9a-f-]{36}$/.test(prefix)) throw new Error(`not a test prefix: ${prefix}`);
	const client = new AwsClient({
		accessKeyId: s3.accessKeyId,
		secretAccessKey: s3.secretAccessKey,
		service: "s3",
		region: s3.region ?? "us-east-1",
	});
	const bucket = `${s3.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(s3.bucket)}`;
	let deleted = 0;
	let token: string | undefined;
	do {
		const query = new URLSearchParams({ "list-type": "2", prefix: `${prefix}/` });
		if (token !== undefined) query.set("continuation-token", token);
		const listing = await (await client.fetch(`${bucket}?${query}`)).text();
		const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => decodeXml(match[1]!));
		for (let start = 0; start < keys.length; start += 32) {
			await Promise.all(
				keys.slice(start, start + 32).map(async (key) => {
					const url = `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
					const response = await client.fetch(url, { method: "DELETE" });
					await response.body?.cancel();
				}),
			);
		}
		deleted += keys.length;
		token = /<IsTruncated>true<\/IsTruncated>/.test(listing)
			? decodeXml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(listing)?.[1] ?? "")
			: undefined;
	} while (token !== undefined && token !== "");
	return deleted;
}

function decodeXml(text: string): string {
	return text
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}
