// Read-only mounts (experimental): bundles and bucket sources over the API, a create's mounts checked and handed to the
// backend, each mount's status, what hosts are given, signed file URLs and archive extraction, and that all of it is
// refused with mounts off.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { MOUNTS_OFF } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { ExecRequest, ExecResult, SandboxBackend, SandboxSpec } from "../src/backend.ts";
import { createMemoryBundleStore } from "../src/bundles.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";
import { entryPath, linkStaysInside, TarCheck } from "../src/tar.ts";
import { bytesToBase64 } from "../src/util.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
};
const KEY = bytesToBase64(new Uint8Array(32).fill(7));

const opened: ComputeApi[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
});

const encode = (text: string) => new TextEncoder().encode(text);
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

interface TarEntry {
	readonly name: string;
	/** `0` file (default), `5` directory, `2` symlink, `1` hard link, `3` device, `6` FIFO, `x` pax. */
	readonly type?: string;
	readonly data?: Uint8Array;
	readonly link?: string;
}

/** A ustar archive of `entries`, written as tar writes one. */
function tarOf(entries: readonly TarEntry[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const data = entry.data ?? new Uint8Array();
		const header = new Uint8Array(512);
		const put = (text: string, offset: number, length: number) => header.set(encode(text).subarray(0, length), offset);
		const octal = (value: number, offset: number, length: number) =>
			put(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
		put(entry.name, 0, 100);
		octal(entry.type === "5" ? 0o755 : 0o644, 100, 8);
		octal(1000, 108, 8);
		octal(1000, 116, 8);
		octal(data.length, 124, 12);
		octal(0, 136, 12);
		header.fill(0x20, 148, 156);
		put(entry.type ?? "0", 156, 1);
		put(entry.link ?? "", 157, 100);
		put("ustar\0", 257, 6);
		put("00", 263, 2);
		let sum = 0;
		for (const byte of header) sum += byte;
		put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
		blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
	let at = 0;
	for (const block of blocks) {
		out.set(block, at);
		at += block.length;
	}
	return out;
}

/** A pax header naming the next entry's path. */
function paxPath(path: string): TarEntry {
	const record = (length: number) => `${length} path=${path}\n`;
	let length = record(0).length;
	while (record(length).length !== length) length = record(length).length;
	return { name: "PaxHeader", type: "x", data: encode(record(length)) };
}

function check(entries: readonly TarEntry[], maxBytes = 1 << 20) {
	const checker = new TarCheck({ maxBytes });
	const bytes = tarOf(entries);
	// In awkward pieces, as a stream brings them.
	for (let at = 0; at < bytes.length; at += 333) checker.push(bytes.subarray(at, at + 333));
	return checker.end();
}

type ExecHook = (sandboxId: string, request: ExecRequest) => Promise<ExecResult | undefined>;

function setup(options: { readonly mounts?: boolean; readonly exec?: ExecHook } = {}) {
	const stub = createStubBackend();
	const specs: SandboxSpec[] = [];
	const backend: SandboxBackend = {
		...stub,
		create: async (spec) => {
			specs.push(spec);
			return stub.create(spec);
		},
		exec: async (sandboxId, request) => (await options.exec?.(sandboxId, request)) ?? stub.exec(sandboxId, request),
	};
	const bundles = createMemoryBundleStore();
	const api = createComputeApi({
		backend,
		secretsKey: KEY,
		...(options.mounts === false ? {} : { mounts: { bundles, maxBundleBytes: 1 << 20 } }),
		authenticatePerson: async (request) => {
			const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
			return token === undefined ? undefined : PEOPLE[token];
		},
		fetch: async () => new Response(null, { status: 204 }),
	});
	opened.push(api);
	const fetchApi = (input: string | Request | URL, init?: RequestInit) =>
		api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 }));
	const client = (token: string) => createKantelClient({ baseUrl: BASE_URL, token, fetch: fetchApi });
	return { api, stub, bundles, specs, fetchApi, tom: client("tom-token"), ann: client("ann-token") };
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

const SKILLS = tarOf([
	{ name: "skills/", type: "5" },
	{ name: "skills/a.md", data: encode("# A") },
]);

describe("a tar's check", () => {
	it("counts files, directories and links, through pax names", () => {
		expect(
			check([
				{ name: "./", type: "5" },
				{ name: "a/", type: "5" },
				{ name: "a/b.txt", data: encode("hello") },
				{ name: "a/link", type: "2", link: "b.txt" },
				{ name: "up", type: "2", link: "a/../a/b.txt" },
				paxPath(`${"long/".repeat(40)}name.txt`),
				{ name: "ignored-for-pax", data: encode("xy") },
			]),
		).toEqual({ files: 2, directories: 1, symlinks: 2, bytes: 7 });
	});

	it("refuses names and links that leave the directory, and kinds it doesn't extract", () => {
		const refused = (entries: readonly TarEntry[]) => expect(() => check(entries)).toThrow();
		refused([{ name: "/etc/passwd", data: encode("x") }]);
		refused([{ name: "a/../../x", data: encode("x") }]);
		refused([paxPath("../../x"), { name: "fine", data: encode("x") }]);
		refused([{ name: "l", type: "2", link: "/etc" }]);
		refused([{ name: "a/l", type: "2", link: "../../x" }]);
		refused([
			{ name: "l", type: "2", link: "inside" },
			{ name: "l/escape", data: encode("x") },
		]);
		refused([{ name: "h", type: "1", link: "a" }]);
		refused([{ name: "dev", type: "3" }]);
		refused([{ name: "fifo", type: "6" }]);
		// Too large, and cut short.
		expect(() => check([{ name: "big", data: new Uint8Array(100) }], 10)).toThrow(/more than 10 bytes/);
		const cut = new TarCheck({ maxBytes: 1 << 20 });
		cut.push(tarOf([{ name: "f", data: new Uint8Array(1000) }]).subarray(0, 700));
		expect(() => cut.end()).toThrow(/part-way/);
		// Not a tar at all.
		expect(() => new TarCheck({ maxBytes: 10 }).push(new Uint8Array(512).fill(65))).toThrow(/isn't a tar/);
	});

	it("resolves names and links as tar does", () => {
		expect(entryPath("./a//b/./c")).toBe("a/b/c");
		expect(entryPath("./")).toBe("");
		expect(linkStaysInside("a/b/l", "../c")).toBe(true);
		expect(linkStaysInside("a/l", "../../c")).toBe(false);
		expect(linkStaysInside("l", "")).toBe(false);
	});
});

describe("mounts off", () => {
	it("refuses a create's mounts and every mounts route", async () => {
		const { tom } = setup({ mounts: false });
		const create = await failure(
			tom.createSandbox({
				type: "microvm",
				mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest: digestOf(SKILLS) } }],
			}),
		);
		expect(create.code).toBe("not_supported");
		expect(create.message).toBe(MOUNTS_OFF);
		for (const call of [
			tom.listBundles(),
			tom.uploadBundle(SKILLS.slice().buffer),
			tom.listBucketSources(),
			tom.createBucketSource({ name: "org", provider: "s3", bucket: "org" }),
		]) {
			expect((await failure(call)).code).toBe("not_supported");
		}
		// A create without mounts is as it always was.
		expect((await tom.createSandbox({ type: "microvm", wait: true })).mounts).toBeUndefined();
	});
});

describe("bundles", () => {
	it("are stored once by digest, listed, and refused for deletion while mounted", async () => {
		const { tom, ann, bundles, fetchApi } = setup();
		const digest = digestOf(SKILLS);
		const first = await tom.uploadBundle(SKILLS.slice().buffer);
		expect(first).toMatchObject({ digest, sizeBytes: SKILLS.length, mountedBy: 0 });
		// Again: 200, the same bundle.
		const again = await fetchApi(`${BASE_URL}/bundles`, {
			method: "POST",
			headers: { authorization: "Bearer tom-token", "content-type": "application/x-tar" },
			body: SKILLS.slice(),
		});
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual(first);
		// A digest that doesn't match is refused.
		const wrong = await failure(tom.uploadBundle(SKILLS.slice().buffer, { digest: `sha256:${"0".repeat(64)}` }));
		expect(wrong.code).toBe("invalid");
		expect((await tom.listBundles()).items).toEqual([first]);
		// Another account doesn't see it.
		expect((await ann.listBundles()).items).toEqual([]);
		expect((await failure(ann.getBundle(digest))).code).toBe("not_found");

		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest } }],
			wait: true,
		});
		expect((await tom.getBundle(digest)).mountedBy).toBe(1);
		expect((await failure(tom.deleteBundle(digest))).code).toBe("conflict");
		await tom.deleteSandbox(sandbox.id);
		await tom.deleteBundle(digest);
		expect((await tom.listBundles()).items).toEqual([]);
		expect(await bundles.open(digest)).toBeUndefined();
	});
});

describe("a sandbox's mounts", () => {
	it("are checked, handed to the backend, and failed when the backend says nothing of them", async () => {
		const { tom, specs } = setup();
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const source = await tom.createBucketSource({
			name: "org files",
			provider: "s3",
			bucket: "org",
			region: "eu-west-1",
			credentials: { accessKeyId: "AKIA", secretAccessKey: "s3cret" },
		});
		const mounts = [
			{ path: "/mnt/skills", source: { kind: "bundle" as const, digest: bundle.digest } },
			{ path: "/mnt/org", source: { kind: "bucket" as const, bucketSourceId: source.id, prefix: "org/42/" } },
		];
		const sandbox = await tom.createSandbox({ type: "microvm", mounts, wait: true });
		expect(specs.at(-1)?.mounts).toEqual(mounts);
		// The stub backend predates mounts: both failed, saying why.
		expect(sandbox.mounts).toEqual([
			{ ...mounts[0], status: "failed", error: "This host can't mount bundles yet" },
			{ ...mounts[1], status: "failed", error: "This host can't mount buckets yet" },
		]);
		expect((await tom.getSandbox(sandbox.id)).mounts).toEqual(sandbox.mounts);
	});

	it("refuses isolates, bad or overlapping paths, and sources the account doesn't have", async () => {
		const { tom, ann } = setup();
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const at = (path: string) => ({ path, source: { kind: "bundle" as const, digest: bundle.digest } });
		const isolate = await failure(tom.createSandbox({ type: "isolate", mounts: [at("/mnt/a")] }));
		expect(isolate.code).toBe("not_supported");
		for (const mounts of [[at("/etc/skills")], [at("/mnt/a/../b")], [at("/mnt/a"), at("/mnt/a/b")], [at("/")]]) {
			expect((await failure(tom.createSandbox({ type: "microvm", mounts }))).code).toBe("invalid");
		}
		const elsewhere = await failure(ann.createSandbox({ type: "microvm", mounts: [at("/mnt/a")] }));
		expect(elsewhere.code).toBe("not_found");
		const bucket = await failure(
			tom.createSandbox({
				type: "microvm",
				mounts: [{ path: "/mnt/b", source: { kind: "bucket", bucketSourceId: "bks_missing", prefix: "" } }],
			}),
		);
		expect(bucket.code).toBe("not_found");
	});

	it("give hosts a bundle and a bucket source's credentials only for their own sandboxes, and take their reports", async () => {
		const { api, tom } = setup();
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const source = await tom.createBucketSource({
			name: "org files",
			provider: "s3",
			bucket: "org",
			credentials: { accessKeyId: "AKIA", secretAccessKey: "s3cret" },
		});
		// Never answered.
		expect(JSON.stringify(source)).not.toContain("s3cret");
		expect(source.hasCredentials).toBe(true);
		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [
				{ path: "/mnt/skills", source: { kind: "bundle", digest: bundle.digest } },
				{ path: "/mnt/org", source: { kind: "bucket", bucketSourceId: source.id, prefix: "" } },
			],
			wait: true,
		});
		const blob = await api.service.bundleForHost(STUB_HOST_ID, sandbox.id, bundle.digest);
		expect(new Uint8Array(await new Response(blob?.body).arrayBuffer())).toEqual(SKILLS);
		expect(await api.service.bundleForHost("host_other", sandbox.id, bundle.digest)).toBeUndefined();
		expect(await api.service.bundleForHost(STUB_HOST_ID, sandbox.id, `sha256:${"1".repeat(64)}`)).toBeUndefined();
		expect(await api.service.bucketSourceForHost(STUB_HOST_ID, sandbox.id, source.id)).toEqual({
			id: source.id,
			provider: "s3",
			bucket: "org",
			credentials: { accessKeyId: "AKIA", secretAccessKey: "s3cret" },
		});
		expect(await api.service.bucketSourceForHost("host_other", sandbox.id, source.id)).toBeUndefined();

		await api.service.reportMounts(STUB_HOST_ID, sandbox.id, [{ path: "/mnt/skills", status: "ready" }]);
		await api.service.reportMounts("host_other", sandbox.id, [{ path: "/mnt/org", status: "ready" }]);
		expect((await tom.getSandbox(sandbox.id)).mounts?.map((mount) => [mount.path, mount.status])).toEqual([
			["/mnt/skills", "ready"],
			["/mnt/org", "failed"],
		]);
		expect((await failure(tom.deleteBucketSource(source.id))).code).toBe("conflict");
	});
});

describe("signed file URLs", () => {
	it("download and upload a file with no credential, bound to their path and method, until they expire", async () => {
		const { tom, fetchApi } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const big = new Uint8Array(1024 * 1024 + 17).map((_, index) => index % 251);

		const upload = await tom.createUploadUrl(sandbox.id, { path: "data/big.bin" });
		expect(upload).toMatchObject({ method: "PUT", path: "/home/user/data/big.bin" });
		expect(upload.url).toMatch(/^http:\/\/compute\.test\/v1\/file-urls\/kfu_[A-Za-z0-9]{40}$/);
		const put = await fetchApi(upload.url, { method: "PUT", body: big });
		expect(put.status).toBe(200);
		expect(await put.json()).toEqual({ path: "/home/user/data/big.bin", size: big.length });
		// Not for a download.
		expect((await fetchApi(upload.url)).status).toBe(400);

		const download = await tom.createDownloadUrl(sandbox.id, { path: "/home/user/data/big.bin", ttlSeconds: 60 });
		const got = await fetchApi(download.url);
		expect(got.status).toBe(200);
		expect(got.headers.get("content-length")).toBe(String(big.length));
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(big);
		const head = await fetchApi(download.url, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe(String(big.length));

		expect((await fetchApi(`${BASE_URL}/file-urls/kfu_nope`)).status).toBe(404);
		await tom.stopSandbox(sandbox.id, { wait: true });
		expect((await fetchApi(download.url)).status).toBe(409);
		// The stub's files are slow at a megabyte, which the read in parts needs.
	}, 30_000);

	it("refuse uploads, writes and archives into a mount", async () => {
		const { tom } = setup();
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest: bundle.digest } }],
			wait: true,
		});
		expect((await failure(tom.createUploadUrl(sandbox.id, { path: "/mnt/skills/x" }))).code).toBe("conflict");
		expect((await failure(tom.writeFile(sandbox.id, { path: "/mnt/skills/x", content: "x" }))).code).toBe("conflict");
		expect((await failure(tom.extractArchive(sandbox.id, SKILLS.slice().buffer, { path: "/mnt" }))).code).toBe(
			"conflict",
		);
		// Downloads from one are fine.
		expect((await tom.createDownloadUrl(sandbox.id, { path: "/mnt/skills/a.md" })).method).toBe("GET");
	});
});

describe("archives", () => {
	it("are checked whole before the sandbox's tar extracts them, gzipped or not", async () => {
		const execs: { command: string; staged: Uint8Array }[] = [];
		const env = setup({
			exec: async (sandboxId, request) => {
				const staged = /tar -x -p -f '([^']+)'/.exec(request.command)?.[1];
				if (staged === undefined) return undefined;
				const read = await env.stub.readFile(sandboxId, staged);
				execs.push({ command: request.command, staged: read.bytes });
				return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
			},
		});
		const { tom } = env;
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const archive = tarOf([
			{ name: "app/", type: "5" },
			{ name: "app/main.sh", data: encode("echo hi") },
			{ name: "app/current", type: "2", link: "main.sh" },
		]);
		expect(await tom.extractArchive(sandbox.id, gzipSync(archive), { path: "work" })).toEqual({
			path: "/home/user/work",
			files: 1,
			directories: 1,
			symlinks: 1,
			bytes: 7,
		});
		expect(execs[0]?.staged).toEqual(archive);
		expect(execs[0]?.command).toContain("-C '/home/user/work'");

		// One bad entry, at the end: nothing is extracted.
		const bad = tarOf([
			{ name: "fine", data: encode("x") },
			{ name: "../escape", data: encode("x") },
		]);
		const refused = await failure(tom.extractArchive(sandbox.id, bad.slice().buffer, { path: "work" }));
		expect(refused.code).toBe("invalid");
		expect(refused.message).toMatch(/climbs out/);
		expect(execs).toHaveLength(1);
	});
});
