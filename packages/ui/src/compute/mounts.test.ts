import { describe, expect, it } from "vitest";
import {
	API_SERVER,
	ATTACHMENTS_DIGEST,
	createComputeFixtures,
	DATASETS_ID,
	LLEVERAGE,
	MODELS_DIGEST,
	ORG_FILES_ID,
	SKILLS_DIGEST,
} from "./fixtures.ts";
import {
	bucketPathText,
	bucketWhereText,
	credentialsText,
	endpointHost,
	inUseText,
	MOUNT_STATUS_LABELS,
	MOUNT_STATUS_STATUS,
	mountedByText,
	shortDigest,
} from "./mounts.ts";

describe("a mount's words", () => {
	it("shortens a digest to its algorithm and both ends", () => {
		expect(shortDigest(SKILLS_DIGEST)).toBe("sha256:3f2a…9c01");
		expect(shortDigest(`sha256:${"0".repeat(60)}beef`)).toBe("sha256:0000…beef");
		// Nothing to gain on a short one, or one without an algorithm but long.
		expect(shortDigest("sha256:3f2a9c01")).toBe("sha256:3f2a9c01");
		expect(shortDigest("3f2a7c1e9b4d8a6f9c01")).toBe("3f2a…9c01");
		expect(shortDigest("")).toBe("");
	});

	it("shows a ready mount as done, a pending one in progress and a failed one as an error", () => {
		expect(MOUNT_STATUS_STATUS).toEqual({ ready: "done", pending: "working", failed: "error" });
		expect(MOUNT_STATUS_LABELS).toEqual({ ready: "Ready", pending: "Pending", failed: "Failed" });
	});

	it("counts the sandboxes that mount something, with nothing for none", () => {
		expect(mountedByText(0)).toBeUndefined();
		expect(mountedByText(1)).toBe("1 sandbox");
		expect(mountedByText(2)).toBe("2 sandboxes");
		expect(mountedByText(1200)).toBe("1,200 sandboxes");
	});

	it("says why one can't be deleted while a sandbox mounts it", () => {
		expect(inUseText(0)).toBeUndefined();
		expect(inUseText(1)).toBe("Mounted by 1 sandbox; delete it first");
		expect(inUseText(3)).toBe("Mounted by 3 sandboxes; delete them first");
	});

	it("writes a bucket mount's place as bucket and prefix, or the prefix where the bucket isn't known", () => {
		expect(bucketPathText("org-files", "skills/")).toBe("org-files/skills/");
		expect(bucketPathText("org-files", "")).toBe("org-files/");
		expect(bucketPathText(undefined, "skills/")).toBe("skills/");
		expect(bucketPathText(undefined, "")).toBeUndefined();
	});

	it("says where a bucket is from its endpoint's host and its region", () => {
		expect(endpointHost("https://acct.r2.cloudflarestorage.com")).toBe("acct.r2.cloudflarestorage.com");
		expect(endpointHost("not a url")).toBe("not a url");
		expect(bucketWhereText("https://acct.r2.cloudflarestorage.com", "auto")).toBe(
			"acct.r2.cloudflarestorage.com, region auto",
		);
		expect(bucketWhereText(undefined, "eu-west-1")).toBe("Region eu-west-1");
		expect(bucketWhereText("https://minio.internal:9000/", undefined)).toBe("minio.internal:9000");
		expect(bucketWhereText(undefined, "")).toBeUndefined();
	});

	it("says whether a bucket source has credentials, never what they are", () => {
		expect(credentialsText(true)).toBe("Set");
		expect(credentialsText(false)).toBe("None (public)");
	});
});

describe("the sample mounts", () => {
	it("count the sandboxes that mount each bundle and bucket source", async () => {
		const mounts = createComputeFixtures().mounts;
		if (mounts === undefined) throw new Error("No mounts in the sample data");
		const bundles = await mounts.bundles(LLEVERAGE.id);
		expect(bundles.map((bundle) => [bundle.digest, bundle.mountedBy])).toEqual([
			[SKILLS_DIGEST, 2],
			[ATTACHMENTS_DIGEST, 1],
			[MODELS_DIGEST, 0],
		]);
		const sources = await mounts.bucketSources(LLEVERAGE.id);
		expect(sources.map((source) => [source.id, source.mountedBy])).toEqual([
			[ORG_FILES_ID, 2],
			[DATASETS_ID, 0],
		]);
	});

	it("delete one nothing mounts, and refuse one a sandbox does until the sandbox is gone", async () => {
		const source = createComputeFixtures();
		const mounts = source.mounts;
		if (mounts === undefined) throw new Error("No mounts in the sample data");
		await mounts.removeBundle(LLEVERAGE.id, MODELS_DIGEST);
		await mounts.removeBucketSource(DATASETS_ID);
		await expect(mounts.removeBundle(LLEVERAGE.id, ATTACHMENTS_DIGEST)).rejects.toMatchObject({ code: "conflict" });
		await source.sandboxes.remove(API_SERVER.id);
		await mounts.removeBundle(LLEVERAGE.id, ATTACHMENTS_DIGEST);
		expect((await mounts.bundles(LLEVERAGE.id)).map((bundle) => bundle.digest)).toEqual([SKILLS_DIGEST]);
		expect((await mounts.bucketSources(LLEVERAGE.id)).map((bucket) => bucket.id)).toEqual([ORG_FILES_ID]);
	});

	it("are empty with the empty sample data, and absent with mounts off", async () => {
		const empty = createComputeFixtures({ empty: true }).mounts;
		expect(await empty?.bundles(LLEVERAGE.id)).toEqual([]);
		expect(await empty?.bucketSources(LLEVERAGE.id)).toEqual([]);
		const off = createComputeFixtures({ noMounts: true });
		expect(off.mounts).toBeUndefined();
		expect((await off.sandboxes.get(API_SERVER.id)).mounts).toBeUndefined();
	});
});
