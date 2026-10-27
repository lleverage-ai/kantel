import type { S3ObjectsOptions } from "../src/index.ts";

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
