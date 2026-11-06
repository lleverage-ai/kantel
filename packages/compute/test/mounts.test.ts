// Read-only mounts (experimental): bundles and bucket sources over the API, a create's mounts checked and handed to the
// backend, each mount's status, what hosts are given, signed file URLs and archive extraction, and that all of it is
// refused with mounts off.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { KantelError, MOUNTS_OFF } from "@kantel/contracts";
import { pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonIdentity } from "../src/auth.ts";
import type { SandboxBackend, SandboxSpec } from "../src/backend.ts";
import { createMemoryBundleStore } from "../src/bundles.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import type { BundleBlobStore } from "../src/mounts.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, createMemoryStore } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";
import { entryPath, linkStaysInside, MAX_LINK_NODES, TarCheck } from "../src/tar.ts";
import { bytesToBase64 } from "../src/util.ts";

const BASE_URL = "http://compute.test/v1";
const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	"tom-token": { userId: "usr_tom", name: "Tom", email: "tom@example.com" },
	"ann-token": { userId: "usr_ann", name: "Ann", email: "ann@example.com" },
};
const KEY = bytesToBase64(new Uint8Array(32).fill(7));

const opened: ComputeApi[] = [];
const databases: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const database of databases.splice(0)) await database.close();
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

interface SetupOptions {
	readonly mounts?: boolean;
	/** Replaces backend methods; given the stub to call through to. */
	readonly backend?: (stub: SandboxBackend) => Partial<SandboxBackend>;
	readonly basePath?: string;
	readonly now?: () => number;
	/** Default an in-memory one. */
	readonly store?: ComputeStore;
	/** Where bundles' bytes go; default a memory store of this setup's own. */
	readonly bundleStore?: BundleBlobStore;
}

function setup(options: SetupOptions = {}) {
	const stub = createStubBackend();
	const specs: SandboxSpec[] = [];
	const backend: SandboxBackend = {
		...stub,
		create: async (spec) => {
			specs.push(spec);
			return stub.create(spec);
		},
		...options.backend?.(stub),
	};
	// The memory store, noting each generation kept and not yet deleted, so a test can see bytes left without a record.
	const memory = options.bundleStore ?? createMemoryBundleStore();
	const live = new Map<string, { readonly digest: string; readonly generation: number }>();
	const liveKey = (digest: string, generation: number) => `${digest}#${generation}`;
	const bundles: BundleBlobStore = {
		put: async (body, putOptions) => {
			const staged = await memory.put(body, putOptions);
			return {
				digest: staged.digest,
				sizeBytes: staged.sizeBytes,
				keep: async (generation) => {
					await staged.keep(generation);
					live.set(liveKey(staged.digest, generation), { digest: staged.digest, generation });
				},
				discard: () => staged.discard(),
			};
		},
		open: (digest, generation) => memory.open(digest, generation),
		delete: async (digest, generation) => {
			await memory.delete(digest, generation);
			live.delete(liveKey(digest, generation));
		},
		mark: (id) => memory.mark(id),
		marked: (id) => memory.marked(id),
	};
	const store = options.store ?? createMemoryStore();
	const baseUrl = `http://compute.test${options.basePath ?? "/v1"}`;
	const api = createComputeApi({
		backend,
		store,
		secretsKey: KEY,
		...(options.basePath === undefined ? {} : { basePath: options.basePath }),
		...(options.now === undefined ? {} : { now: options.now }),
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
	const client = (token: string) => createKantelClient({ baseUrl, token, fetch: fetchApi });
	const kept = {
		/** A digest's bytes: its records', or, with no record, any generation of it still kept (bytes left behind). */
		open: async (digest: string) => {
			for (const record of await store.bundles.list({ digest })) {
				const blob = await bundles.open(digest, record.generation ?? 0);
				if (blob !== undefined) return blob;
			}
			for (const left of live.values()) {
				if (left.digest === digest) return bundles.open(digest, left.generation);
			}
			return undefined;
		},
		/**
		 * Throws unless every record opens bytes of its own, the bytes kept are exactly the records' (none left behind), and
		 * no two records share a generation.
		 */
		consistent: async () => {
			const owned = new Set<string>();
			for (const record of await store.bundles.list()) {
				const key = liveKey(record.digest, record.generation ?? 0);
				expect(owned.has(key), `${record.id} shares its bytes`).toBe(false);
				owned.add(key);
				expect(await bundles.open(record.digest, record.generation ?? 0), `${record.id} has no bytes`).toBeDefined();
			}
			expect([...live.keys()].sort()).toEqual([...owned].sort());
		},
	};
	return {
		api,
		stub,
		store,
		bundles: kept,
		blobs: bundles,
		specs,
		fetchApi,
		client,
		tom: client("tom-token"),
		ann: client("ann-token"),
	};
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

	it("refuses a malformed pax header at once, however long, and still reads several records split across pieces", () => {
		const pax = (text: string): TarEntry => ({ name: "PaxHeader", type: "x", data: encode(text) });
		const next = { name: "file", data: encode("x") };
		const refused = (text: string) => expect(() => check([pax(text), next], 4 << 20)).toThrow(/bad pax header/);
		// Read as it was, this rescanned nearly all of the header for each byte it moved: about 10^12 steps.
		const started = performance.now();
		refused(`${"0".repeat(1_048_573)}1 \n`);
		expect(performance.now() - started).toBeLessThan(1_000);
		// A length that doesn't cover its own prefix and newline, or ends past the header or not on a newline.
		refused("1 \n");
		refused("3 a\n");
		refused("99 path=x\n");
		refused("10 path=xy\n");
		refused("x path=a\n");
		// Two records in one header, the first long enough to be cut across pieces.
		const record = (key: string, value: string) => {
			const body = ` ${key}=${value}\n`;
			let length = body.length + 1;
			while (`${length}${body}`.length !== length) length++;
			return `${length}${body}`;
		};
		const name = `${"long/".repeat(200)}name.txt`;
		expect(
			check([pax(`${record("path", name)}${record("mtime", "1.5")}`), { name: "ignored-for-pax", data: encode("x") }])
				.files,
		).toBe(1);
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

	it("resolves each link through the archive's other links, in either order", () => {
		const refused = (entries: readonly TarEntry[]) => expect(() => check(entries)).toThrow(/points out|over its own/);
		// Each fine alone; together, b is the directory above the top.
		refused([
			{ name: "a", type: "2", link: "." },
			{ name: "b", type: "2", link: "a/../outside" },
		]);
		refused([
			{ name: "b", type: "2", link: "a/../outside" },
			{ name: "a", type: "2", link: "." },
		]);
		// Through a link to a directory further down, and back up past the top.
		refused([
			{ name: "d/e/", type: "5" },
			{ name: "deep", type: "2", link: "d/e" },
			{ name: "x", type: "2", link: "deep/../../.." },
		]);
		// A loop.
		refused([
			{ name: "p", type: "2", link: "q" },
			{ name: "q", type: "2", link: "p" },
			{ name: "r", type: "2", link: "p/x" },
		]);
		// A link over an earlier one under it.
		refused([
			{ name: "a/l", type: "2", link: "x" },
			{ name: "a", type: "2", link: "." },
		]);
		// Chains that stay in.
		expect(
			check([
				{ name: "d/e/", type: "5" },
				{ name: "up", type: "2", link: "deep/../f" },
				{ name: "deep", type: "2", link: "d/e" },
				{ name: "d/e/f", type: "2", link: "../../deep" },
			]).symlinks,
		).toBe(3);
	});

	it("refuses an archive cut short in an entry's padding", () => {
		const whole = tarOf([
			{ name: "first", data: encode("complete") },
			{ name: "last", data: encode("cut") },
		]);
		// Up to the end of the last file's 3 bytes, without the rest of its block.
		const cut = new TarCheck({ maxBytes: 1 << 20 });
		cut.push(whole.subarray(0, 512 * 3 + 3));
		expect(() => cut.end()).toThrow(/part-way/);
		// The padding in pieces, then the end: fine.
		const pieces = new TarCheck({ maxBytes: 1 << 20 });
		for (let at = 0; at < whole.length; at += 7) pieces.push(whole.subarray(at, at + 7));
		expect(pieces.end().files).toBe(2);
	});

	it("checks many links in time linear in the archive", () => {
		const entries: TarEntry[] = [{ name: "inside/", type: "5" }];
		for (let index = 0; index < 20_000; index++) entries.push({ name: `l${index}`, type: "2", link: "inside" });
		const started = performance.now();
		expect(check(entries).symlinks).toBe(20_000);
		// A scan of every earlier link each time would be 200 million comparisons.
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("refuses links whose paths would come to too many nodes, however short their names", () => {
		// Each link a deep path under a prefix of its own: a node per component, 1,001 a link.
		const deep = `${"a/".repeat(1_000)}l`;
		const entries: TarEntry[] = [];
		const links = Math.ceil(MAX_LINK_NODES / 1_001) + 1;
		for (let index = 0; index < links; index++) {
			entries.push(paxPath(`d${index}/${deep}`), { name: "ignored-for-pax", type: "2", link: "." });
		}
		expect(() => check(entries)).toThrow(/directories and names/);
		// Fewer of them are fine.
		expect(check(entries.slice(0, 20)).symlinks).toBe(10);
	});

	it("keeps no name as the archive spelt it, only its path", () => {
		// A pax name of many `./` comes to a short path: an escaping link is named by that path.
		const entries: TarEntry[] = [
			paxPath(`${"./".repeat(1_500)}a`),
			{ name: "ignored-for-pax", type: "2", link: "." },
			paxPath(`${"./".repeat(1_500)}b`),
			{ name: "ignored-for-pax", type: "2", link: "a/.." },
			{ name: "c", type: "2", link: "b/../.." },
		];
		expect(() => check(entries)).toThrow(/points out: (c -> b\/\.\.\/\.\.|b -> a\/\.\.)/);
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
	it("keeps the record of an upload whose account closed as it published, should its bytes not go", async () => {
		const memory = createMemoryBundleStore();
		const failing: BundleBlobStore = {
			...memory,
			delete: async () => {
				throw new Error("the bucket went away");
			},
		};
		const { tom, store } = setup({ bundleStore: failing });
		const personal = (await tom.getCaller()).accountId;
		const insert = store.bundles.insert.bind(store.bundles);
		store.bundles.insert = async (record) => {
			const inserted = await insert(record);
			await store.accounts.update(personal, (account) => ({ ...account, closedAt: Date.now() }));
			return inserted;
		};
		await failure(tom.uploadBundle(SKILLS.slice().buffer));
		expect(await store.bundles.list({ accountId: personal })).toHaveLength(1);
	});

	it("undoes an upload, bytes and all, whose account closed as it published", async () => {
		const { tom, store, bundles } = setup();
		const personal = (await tom.getCaller()).accountId;
		const insert = store.bundles.insert.bind(store.bundles);
		store.bundles.insert = async (record) => {
			const inserted = await insert(record);
			await store.accounts.update(personal, (account) => ({ ...account, closedAt: Date.now() }));
			return inserted;
		};
		expect((await failure(tom.uploadBundle(SKILLS.slice().buffer))).code).toBe("conflict");
		expect(await store.bundles.list({ accountId: personal })).toEqual([]);
		await bundles.consistent();
	});

	it("refuses an upload to a closed account before taking its bytes", async () => {
		const { tom, store, bundles } = setup();
		const personal = (await tom.getCaller()).accountId;
		await store.accounts.update(personal, (account) => ({
			...account,
			closedAt: Date.now(),
		}));
		expect((await failure(tom.uploadBundle(SKILLS.slice().buffer))).code).toBe("conflict");
		expect(await store.bundles.list({ accountId: personal })).toEqual([]);
		await bundles.consistent();
	});

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

describe("bucket sources", () => {
	it("makes one for one Idempotency-Key, and refuses the key for another", async () => {
		const { tom } = setup();
		const body = { name: "org", provider: "s3" as const, bucket: "org" };
		const first = await tom.createBucketSource(body, { idempotencyKey: "bks-1" });
		expect(await tom.createBucketSource(body, { idempotencyKey: "bks-1" })).toEqual(first);
		expect((await tom.listBucketSources()).items).toHaveLength(1);
		const other = await tom
			.createBucketSource({ ...body, bucket: "other" }, { idempotencyKey: "bks-1" })
			.catch((error: unknown) => error);
		expect(other).toMatchObject({ code: "refused" });
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

	it("keep, serve and remove bundles only on gateways sharing the deployment's bundle store", async () => {
		const store = createMemoryStore();
		const shared = createMemoryBundleStore();
		const first = setup({ store, bundleStore: shared });
		const bundle = await first.tom.uploadBundle(SKILLS.slice().buffer);
		const sandbox = await first.tom.createSandbox({
			type: "microvm",
			mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest: bundle.digest } }],
			wait: true,
		});
		// A replica over the same records with a store of its own (a volume of its own): it lists the bundle, but
		// refuses to answer for bytes it can't reach, rather than taking a re-upload as kept, telling a host the bundle
		// is missing, or deleting the record and leaving the bytes behind.
		const apart = setup({ store });
		expect((await apart.tom.listBundles()).items.map((item) => item.digest)).toEqual([bundle.digest]);
		const upload = await failure(apart.tom.uploadBundle(SKILLS.slice().buffer));
		expect([upload.status, upload.code]).toEqual([503, "unavailable"]);
		expect(upload.message).toContain("KANTEL_BUNDLES_DIR");
		await expect(apart.api.service.bundleForHost(STUB_HOST_ID, sandbox.id, bundle.digest)).rejects.toMatchObject({
			code: "unavailable",
		});
		await first.tom.deleteSandbox(sandbox.id);
		expect((await failure(apart.tom.deleteBundle(bundle.digest))).code).toBe("unavailable");
		expect(await store.bundles.list()).toHaveLength(1);

		// One sharing the store does all three.
		const beside = setup({ store, bundleStore: shared });
		const again = await beside.fetchApi("http://compute.test/v1/bundles", {
			method: "POST",
			headers: { authorization: "Bearer tom-token" },
			body: SKILLS.slice(),
		});
		expect(again.status).toBe(200);
		await beside.tom.deleteBundle(bundle.digest);
		expect(await store.bundles.list()).toEqual([]);
		expect(await shared.open(bundle.digest, 1)).toBeUndefined();
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

describe("a host's report that lands before its boot's answer is written", () => {
	it("is kept on a first create and on a restart, and the answer's pending doesn't undo it", async () => {
		// The host settles the mount (its sandbox.mounts event) before the compute plane writes the boot's answer, which
		// still says pending: the order a bundle that finishes just after the create's wait gives.
		let service: { reportMounts: ComputeApi["service"]["reportMounts"] } | undefined;
		const early = (sandboxId: string) =>
			service?.reportMounts(STUB_HOST_ID, sandboxId, [{ path: "/mnt/skills", status: "ready" }]);
		const pendingAnswer = { mounts: [{ path: "/mnt/skills", status: "pending" as const }] };
		const { api, tom } = setup({
			backend: (stub) => ({
				create: async (spec) => {
					const placed = await stub.create(spec);
					await early(spec.sandboxId);
					return { ...placed, ...pendingAnswer };
				},
				start: async (sandboxId, options) => {
					const placed = await stub.start(sandboxId, options);
					await early(sandboxId);
					return { ...placed, ...pendingAnswer };
				},
			}),
		});
		service = api.service;
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest: bundle.digest } }],
			wait: true,
		});
		expect(sandbox.mounts?.map((mount) => mount.status)).toEqual(["ready"]);
		expect((await tom.getSandbox(sandbox.id)).mounts?.map((mount) => mount.status)).toEqual(["ready"]);

		await tom.stopSandbox(sandbox.id, { wait: true });
		const started = await tom.startSandbox(sandbox.id, { wait: true });
		expect(started.mounts?.map((mount) => mount.status)).toEqual(["ready"]);

		// A host the sandbox isn't on, once it runs: still dropped.
		await api.service.reportMounts("host_other", sandbox.id, [{ path: "/mnt/skills", status: "failed", error: "x" }]);
		expect((await tom.getSandbox(sandbox.id)).mounts?.map((mount) => mount.status)).toEqual(["ready"]);
	});

	it("is ordered by when the host set them: an earlier answer or replay never undoes a later report", async () => {
		// The boot answers one mount failed and one pending at t=100; its background finish retries both and reports them
		// ready at t=101. Whichever lands first, they end ready; a replay read at t=100 that lands last changes nothing.
		let service: { reportMounts: ComputeApi["service"]["reportMounts"] } | undefined;
		const both = ["/mnt/a", "/mnt/b"];
		const answer = {
			mounts: [
				{ path: "/mnt/a", status: "failed" as const, error: "fetching bundle: 503" },
				{ path: "/mnt/b", status: "pending" as const },
			],
			mountsAt: 100,
		};
		const ready = both.map((path) => ({ path, status: "ready" as const }));
		const replay = [{ path: "/mnt/a", status: "failed" as const, error: "fetching bundle: 503" }];
		let reportFirst = true;
		const { api, tom } = setup({
			backend: (stub) => ({
				create: async (spec) => {
					const placed = await stub.create(spec);
					if (reportFirst) await service?.reportMounts(STUB_HOST_ID, spec.sandboxId, ready, 101);
					return { ...placed, ...answer };
				},
				start: async (sandboxId, options) => ({ ...(await stub.start(sandboxId, options)), ...answer, mountsAt: 200 }),
			}),
		});
		service = api.service;
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const mounts = both.map((path) => ({ path, source: { kind: "bundle" as const, digest: bundle.digest } }));
		const statuses = async (id: string) => (await tom.getSandbox(id)).mounts?.map((mount) => mount.status);

		// The report first, then the answer set before it.
		const first = await tom.createSandbox({ type: "microvm", mounts, wait: true });
		expect(first.mounts?.map((mount) => mount.status)).toEqual(["ready", "ready"]);
		// A replay of what the host had at t=100 (its settled one: a's failure), landing late: dropped.
		await api.service.reportMounts(STUB_HOST_ID, first.id, replay, 100);
		expect(await statuses(first.id)).toEqual(["ready", "ready"]);

		// The answer first, then the report set after it.
		reportFirst = false;
		const second = await tom.createSandbox({ type: "microvm", mounts, wait: true });
		expect(second.mounts?.map((mount) => mount.status)).toEqual(["failed", "pending"]);
		await api.service.reportMounts(STUB_HOST_ID, second.id, ready, 101);
		expect(await statuses(second.id)).toEqual(["ready", "ready"]);
		await api.service.reportMounts(STUB_HOST_ID, second.id, replay, 100);
		expect(await statuses(second.id)).toEqual(["ready", "ready"]);

		// A restart starts the order again: its own answer, set later on the host, applies whole.
		await tom.stopSandbox(second.id, { wait: true });
		const started = await tom.startSandbox(second.id, { wait: true });
		expect(started.mounts?.map((mount) => mount.status)).toEqual(["failed", "pending"]);
		// And a report from before it (the last boot's, delayed) is older than what it has.
		await api.service.reportMounts(STUB_HOST_ID, second.id, ready, 150);
		expect(await statuses(second.id)).toEqual(["failed", "pending"]);

		// A host too old to say when: its reports are taken as they come.
		await api.service.reportMounts(STUB_HOST_ID, first.id, [{ path: "/mnt/a", status: "failed", error: "x" }]);
		expect(await statuses(first.id)).toEqual(["failed", "ready"]);
	});

	it("keeps the backend's own failure of a mount its host can't do, even when the host's answer is older", async () => {
		// A bundle and a bucket on a host that does only bundles: the bucket is never sent, so the hand-off's failure is the
		// only word it gets. The bundle's ready report (t=101) lands before the answer (t=100) is written.
		let service: { reportMounts: ComputeApi["service"]["reportMounts"] } | undefined;
		const answer = {
			mounts: [
				{ path: "/mnt/skills", status: "pending" as const },
				{
					path: "/mnt/data",
					status: "failed" as const,
					error: "This host can't mount buckets yet",
					unsent: true as const,
				},
			],
			mountsAt: 100,
		};
		const { api, tom } = setup({
			backend: (stub) => ({
				create: async (spec) => {
					const placed = await stub.create(spec);
					await service?.reportMounts(STUB_HOST_ID, spec.sandboxId, [{ path: "/mnt/skills", status: "ready" }], 101);
					return { ...placed, ...answer };
				},
			}),
		});
		service = api.service;
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const source = await tom.createBucketSource({ name: "org", provider: "s3", bucket: "org" });
		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [
				{ path: "/mnt/skills", source: { kind: "bundle", digest: bundle.digest } },
				{ path: "/mnt/data", source: { kind: "bucket", bucketSourceId: source.id, prefix: "org/" } },
			],
			wait: true,
		});
		const got = (await tom.getSandbox(sandbox.id)).mounts;
		expect(got?.map((mount) => [mount.path, mount.status, mount.error])).toEqual([
			["/mnt/skills", "ready", undefined],
			["/mnt/data", "failed", "This host can't mount buckets yet"],
		]);
		expect(got?.some((mount) => "unsent" in mount)).toBe(false);
	});

	it("leaves a mount pending when no report came, and a boot sets a settled one pending again", async () => {
		const { tom } = setup({
			backend: (stub) => ({
				create: async (spec) => ({
					...(await stub.create(spec)),
					mounts: [{ path: "/mnt/skills", status: "pending" }],
				}),
			}),
		});
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [{ path: "/mnt/skills", source: { kind: "bundle", digest: bundle.digest } }],
			wait: true,
		});
		expect(sandbox.mounts?.map((mount) => mount.status)).toEqual(["pending"]);
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
		const stopped = await fetchApi(download.url);
		expect(stopped.status).toBe(409);
		expect(await stopped.json()).toMatchObject({
			error: { code: "conflict", details: { code: "sandbox_stopped", sandboxId: sandbox.id, state: "stopped" } },
		});
		// The stub's files are slow at a megabyte, which the read in parts needs.
	}, 30_000);

	it("stop working once whoever made them may no longer: a revoked token or key, an expiring token", async () => {
		const { tom, client, fetchApi } = setup();
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.writeFile(sandbox.id, { path: "note.txt", content: "kept" });

		const issued = await tom.createPersonalToken({ name: "t", expiresInDays: 1 });
		const pat = client(issued.secret);
		const download = await pat.createDownloadUrl(sandbox.id, { path: "note.txt", ttlSeconds: 3600 });
		// No later than the token that made it.
		expect(download.expiresAt).toBeLessThanOrEqual(issued.token.expiresAt);
		expect((await fetchApi(download.url)).status).toBe(200);
		await tom.revokePersonalToken(issued.token.id);
		expect((await fetchApi(download.url)).status).toBe(404);

		const key = await tom.createApiKey({ name: "k", preset: "agent" });
		const upload = await client(key.secret).createUploadUrl(sandbox.id, { path: "up.txt" });
		await tom.revokeApiKey(key.key.id);
		expect((await fetchApi(upload.url, { method: "PUT", body: "x" })).status).toBe(404);

		// One made by someone who still may goes on working.
		const still = await tom.createDownloadUrl(sandbox.id, { path: "note.txt" });
		expect(await (await fetchApi(still.url)).text()).toBe("kept");
	});

	it("wait for a sandbox that is starting, as any call that needs it running does", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { tom, fetchApi } = setup({
			backend: (stub) => ({
				resume: async (sandboxId, options) => {
					await gate;
					return stub.resume(sandboxId, options);
				},
			}),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		await tom.writeFile(sandbox.id, { path: "note.txt", content: "kept" });
		const download = await tom.createDownloadUrl(sandbox.id, { path: "note.txt" });
		await tom.stopSandbox(sandbox.id, { wait: true });
		expect((await tom.resumeSandbox(sandbox.id, { wait: false })).state).toBe("starting");
		const held = fetchApi(download.url);
		await new Promise((resolve) => setTimeout(resolve, 100));
		release();
		const got = await held;
		expect(got.status).toBe(200);
		expect(await got.text()).toBe("kept");
	});

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
	it("are checked whole before the backend extracts them, gzipped or not, and never with a command", async () => {
		const execs: { target: string; staged: Uint8Array }[] = [];
		let commands = 0;
		const env = setup({
			backend: (stub) => ({
				extractArchive: async (sandboxId, archive, target) => {
					const read = await stub.readFile(sandboxId, archive);
					execs.push({ target, staged: read.bytes });
					await stub.deleteFile(sandboxId, archive);
				},
				exec: async (sandboxId, request) => {
					commands++;
					return stub.exec(sandboxId, request);
				},
			}),
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
		expect(execs[0]?.target).toBe("/home/user/work");
		// Nothing of the sandbox's own ran: a files-only caller can't have its shell's startup files run.
		expect(commands).toBe(0);

		// One bad entry, at the end: nothing is extracted.
		const bad = tarOf([
			{ name: "fine", data: encode("x") },
			{ name: "../escape", data: encode("x") },
		]);
		const refused = await failure(tom.extractArchive(sandbox.id, bad.slice().buffer, { path: "work" }));
		expect(refused.code).toBe("invalid");
		expect(refused.message).toMatch(/climbs out/);
		expect(execs).toHaveLength(1);
		// Cut short in its last block: nothing is extracted either.
		const cut = tarOf([
			{ name: "first", data: encode("complete") },
			{ name: "last", data: encode("cut") },
		]).subarray(0, 512 * 3 + 3);
		expect((await failure(tom.extractArchive(sandbox.id, cut.slice().buffer, { path: "work" }))).code).toBe("invalid");
		expect(execs).toHaveLength(1);
	});

	it("are refused where the backend can't extract them, rather than run with the sandbox's tar", async () => {
		let commands = 0;
		const { tom } = setup({
			backend: (stub) => ({
				exec: async (sandboxId, request) => {
					commands++;
					return stub.exec(sandboxId, request);
				},
			}),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const refused = await failure(tom.extractArchive(sandbox.id, SKILLS.slice().buffer, { path: "work" }));
		expect(refused.code).toBe("not_supported");
		expect(commands).toBe(0);
	});
});

describe("file streams a backend refuses", () => {
	const refusal = () => new KantelError("not_supported", "This sandbox's host can't stream files");

	it("fall back to the backend's reads and writes when it refuses before reading", async () => {
		const { tom, fetchApi } = setup({
			backend: () => ({
				readFileStream: async () => {
					throw refusal();
				},
				writeFileStream: async () => {
					throw refusal();
				},
			}),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const upload = await tom.createUploadUrl(sandbox.id, { path: "f.txt" });
		const put = await fetchApi(upload.url, { method: "PUT", body: "hello" });
		expect(await put.json()).toEqual({ path: "/home/user/f.txt", size: 5 });
		const download = await tom.createDownloadUrl(sandbox.id, { path: "f.txt" });
		expect(await (await fetchApi(download.url)).text()).toBe("hello");
	});

	it("aren't tried again once the backend has read some of the body, nor for other errors", async () => {
		let writes = 0;
		const { tom, fetchApi } = setup({
			backend: (stub) => ({
				writeFileStream: async (_sandboxId, _path, body) => {
					await body.getReader().read();
					throw refusal();
				},
				readFileStream: async () => {
					throw new KantelError("unavailable", "The host went away");
				},
				writeFile: async (...args) => {
					writes++;
					return stub.writeFile(...args);
				},
			}),
		});
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const upload = await tom.createUploadUrl(sandbox.id, { path: "f.txt" });
		expect((await fetchApi(upload.url, { method: "PUT", body: "hello" })).status).toBe(501);
		expect(writes).toBe(0);
		await tom.writeFile(sandbox.id, { path: "f.txt", content: "x" });
		const download = await tom.createDownloadUrl(sandbox.id, { path: "f.txt" });
		expect((await fetchApi(download.url)).status).toBe(503);
	});

	it("are minted under the API's own base path", async () => {
		const { tom, fetchApi } = setup({ basePath: "/api/compute" });
		const sandbox = await tom.createSandbox({ type: "microvm", wait: true });
		const upload = await tom.createUploadUrl(sandbox.id, { path: "f.txt" });
		expect(upload.url).toMatch(/^http:\/\/compute\.test\/api\/compute\/file-urls\/kfu_/);
		expect((await fetchApi(upload.url, { method: "PUT", body: "hi" })).status).toBe(200);
		const download = await tom.createDownloadUrl(sandbox.id, { path: "f.txt" });
		expect(await (await fetchApi(download.url)).text()).toBe("hi");
		expect((await fetchApi(download.url, { method: "HEAD" })).status).toBe(200);
	});
});

/** The stores the races below are run on: as they coordinate only through the store, each must hold them off. */
const STORES: readonly { readonly name: string; readonly make: () => Promise<ComputeStore | undefined> }[] = [
	{ name: "in memory", make: async () => undefined },
	{
		name: "in SQL",
		make: async () => {
			const database = await pgliteDatabase.open();
			databases.push(database);
			await migrateComputeStore(database.driver);
			return createSqlComputeStore(database.driver);
		},
	},
];

const sqlTimeout = pgliteDatabase.testTimeoutMs === undefined ? {} : { timeout: pgliteDatabase.testTimeoutMs };

describe.each(STORES)("sources and the sandboxes mounting them, stored $name", sqlTimeout, ({ make }) => {
	/** `setup` on this describe's kind of store. */
	const on = async (options: SetupOptions = {}) => {
		const store = await make();
		return setup({ ...options, ...(store === undefined ? {} : { store }) });
	};

	/** Runs `hook` once, the next time `target[method]` is called, before the call itself. */
	function once<T extends object, K extends keyof T>(target: T, method: K, hook: () => Promise<void>) {
		const original = target[method] as (...args: unknown[]) => Promise<unknown>;
		let armed = true;
		(target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
			if (armed) {
				armed = false;
				await hook();
			}
			return original.apply(target, args);
		};
	}

	const liveMounting = async (store: ComputeStore, matches: (mount: string) => boolean) =>
		(await store.sandboxes.list()).filter(
			(sandbox) =>
				sandbox.state !== "deleted" &&
				(sandbox.mounts ?? []).some((mount) =>
					matches(mount.source.kind === "bundle" ? mount.source.digest : mount.source.bucketSourceId),
				),
		);

	it("can't be deleted under a create that checked them, for either kind", async () => {
		let during: (() => Promise<void>) | undefined;
		const { tom, store } = await on({
			backend: (stub) => ({
				// Between the create's check of its mounts and its storing the sandbox.
				capabilities: async () => {
					const hook = during;
					during = undefined;
					await hook?.();
					return stub.capabilities();
				},
			}),
		});
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const source = await tom.createBucketSource({ name: "org", provider: "s3", bucket: "org" });
		const cases = [
			{
				mount: { path: "/mnt/s", source: { kind: "bundle" as const, digest: bundle.digest } },
				remove: () => tom.deleteBundle(bundle.digest),
				id: bundle.digest,
			},
			{
				mount: { path: "/mnt/b", source: { kind: "bucket" as const, bucketSourceId: source.id, prefix: "" } },
				remove: () => tom.deleteBucketSource(source.id),
				id: source.id,
			},
		];
		for (const { mount, remove, id } of cases) {
			during = async () => {
				await remove();
			};
			const refused = await failure(tom.createSandbox({ type: "microvm", mounts: [mount], wait: true }));
			expect(refused.code).toBe("conflict");
			expect(await liveMounting(store, (named) => named === id)).toEqual([]);
		}
	});

	it("refuse a create that checked them while a delete counting their sandboxes is under way", async () => {
		let during: (() => Promise<void>) | undefined;
		const { tom, store } = await on({
			backend: (stub) => ({
				capabilities: async () => {
					const hook = during;
					during = undefined;
					await hook?.();
					return stub.capabilities();
				},
			}),
		});
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const mount = { path: "/mnt/s", source: { kind: "bundle" as const, digest: bundle.digest } };
		// The create has checked its mounts; the delete then claims the bundle and stops before counting its sandboxes,
		// until the create has stored its own and looked for a claim.
		let count: () => void = () => undefined;
		const counting = new Promise<void>((resolve) => {
			count = resolve;
		});
		let deleted: Promise<unknown> | undefined;
		during = async () => {
			let claimed: () => void = () => undefined;
			const claim = new Promise<void>((resolve) => {
				claimed = resolve;
			});
			once(store.sandboxes, "list", async () => {
				claimed();
				await counting;
			});
			deleted = tom.deleteBundle(bundle.digest);
			await claim;
		};
		const outcome = await failure(tom.createSandbox({ type: "microvm", mounts: [mount], wait: true }));
		expect(outcome.code).toBe("conflict");
		count();
		await deleted;
		expect(await liveMounting(store, (named) => named === bundle.digest)).toEqual([]);
		expect(await store.bundles.list()).toEqual([]);
		// A sandbox let through is counted by a later delete.
		const again = await tom.uploadBundle(SKILLS.slice().buffer);
		const sandbox = await tom.createSandbox({ type: "microvm", mounts: [mount], wait: true });
		expect((await failure(tom.deleteBundle(again.digest))).code).toBe("conflict");
		// And its forks keep their own reference.
		const [fork] = (await tom.forkSandbox(sandbox.id, { wait: true })).items ?? [];
		await tom.deleteSandbox(sandbox.id);
		expect((await failure(tom.deleteBundle(again.digest))).code).toBe("conflict");
		if (fork !== undefined) await tom.deleteSandbox(fork.id);
		await tom.deleteBundle(again.digest);
	});

	// A record owns the generation of bytes its upload kept, so however an upload and a delete of the same digest
	// interleave or stall, each record opens its own bytes and none are left without a record (`consistent`).

	it("keep a bundle's bytes for an upload publishing them as another account deletes its own", async () => {
		const { tom, ann, store, bundles } = await on();
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		once(store.bundles, "insert", async () => {
			await tom.deleteBundle(digest);
		});
		await ann.uploadBundle(SKILLS.slice().buffer);
		expect((await ann.listBundles()).items.map((bundle) => bundle.digest)).toEqual([digest]);
		await bundles.consistent();
	});

	it("keep a bundle's bytes when a delete's removal of its own stalls while another account uploads them", async () => {
		let clock = 1_000_000;
		const { tom, ann, store, bundles, blobs } = await on({ now: () => clock });
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		// Tom's delete has removed his record and goes to remove its bytes, but stalls, long past any claim, while Ann
		// uploads the same bytes; then it lands.
		once(blobs, "delete", async () => {
			clock += 10 * 60_000;
			await ann.uploadBundle(SKILLS.slice().buffer);
		});
		await tom.deleteBundle(digest);
		expect((await store.bundles.list()).map((record) => record.accountId)).toEqual([
			(await ann.listBundles()).items[0]?.accountId,
		]);
		await bundles.consistent();
	});

	it("keep a bundle's bytes for an upload whose insert stalls while the last other record goes", async () => {
		let clock = 1_000_000;
		const { tom, ann, store, bundles } = await on({ now: () => clock });
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		once(store.bundles, "insert", async () => {
			clock += 10 * 60_000;
			await tom.deleteBundle(digest);
		});
		await ann.uploadBundle(SKILLS.slice().buffer);
		expect((await ann.listBundles()).items.map((bundle) => bundle.digest)).toEqual([digest]);
		await bundles.consistent();
	});

	it("keep a bundle's bytes for an upload whose stalled insert lands as a delete's held removal of the last other record does", async () => {
		let clock = 1_000_000;
		const { tom, ann, store, bundles, blobs } = await on({ now: () => clock });
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		// Ann's insert stalls; Tom deletes the last other record and his removal of its bytes is held; Ann's insert lands,
		// her upload answers, and only then does Tom's removal.
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => undefined;
		const removing = new Promise<void>((resolve) => {
			reached = resolve;
		});
		once(blobs, "delete", async () => {
			reached();
			await held;
		});
		let deleted: Promise<void> | undefined;
		once(store.bundles, "insert", async () => {
			clock += 10 * 60_000;
			deleted = tom.deleteBundle(digest);
			await removing;
		});
		await ann.uploadBundle(SKILLS.slice().buffer);
		release();
		await deleted;
		expect((await ann.listBundles()).items.map((bundle) => bundle.digest)).toEqual([digest]);
		await bundles.consistent();
	});

	it("leave no bytes behind for an upload whose record fails to go in as the last other record goes", async () => {
		const { tom, ann, store, bundles } = await on();
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		const insert = store.bundles.insert.bind(store.bundles);
		store.bundles.insert = async () => {
			store.bundles.insert = insert;
			await tom.deleteBundle(digest);
			throw new Error("the database went away");
		};
		await expect(ann.uploadBundle(SKILLS.slice().buffer)).rejects.toThrow();
		expect(await store.bundles.list()).toEqual([]);
		expect(await bundles.open(digest)).toBeUndefined();
		await bundles.consistent();
	});

	it("remove the bytes of the record a delete removed, when it was deleted and uploaded again since the delete read it", async () => {
		const { tom, store, bundles } = await on();
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		const first = (await store.bundles.list())[0]?.generation;
		// This delete has read the bundle and goes to claim it; first, another deletes it, and it is uploaded again.
		once(store.bundles, "update", async () => {
			await tom.deleteBundle(digest);
			await tom.uploadBundle(SKILLS.slice().buffer);
			expect((await store.bundles.list())[0]?.generation).not.toBe(first);
		});
		await tom.deleteBundle(digest);
		// It removed the record there now, and that record's bytes with it: none are left without a record.
		expect(await store.bundles.list()).toEqual([]);
		await bundles.consistent();
		expect(await bundles.open(digest)).toBeUndefined();
	});

	it("keep a record's bytes when its insert threw but went in", async () => {
		const { ann, store, bundles } = await on();
		const insert = store.bundles.insert.bind(store.bundles);
		store.bundles.insert = async (record) => {
			store.bundles.insert = insert;
			await insert(record);
			throw new Error("the answer was lost");
		};
		await expect(ann.uploadBundle(SKILLS.slice().buffer)).rejects.toThrow();
		expect(await store.bundles.list()).toHaveLength(1);
		await bundles.consistent();
	});

	it("leave no bytes behind for a re-upload as the account's record goes, nor for uploads of it at once", async () => {
		const { tom, store, bundles, fetchApi } = await on();
		const fetchStatus = async () =>
			(
				await fetchApi(`${BASE_URL}/bundles`, {
					method: "POST",
					headers: { authorization: "Bearer tom-token", "content-type": "application/x-tar" },
					body: SKILLS.slice(),
				})
			).status;
		const digest = digestOf(SKILLS);
		await tom.uploadBundle(SKILLS.slice().buffer);
		// A re-upload (Tom has it) whose look for his record comes just after his delete: it uploads it anew.
		once(store.bundles, "get", async () => {
			await tom.deleteBundle(digest);
		});
		await tom.uploadBundle(SKILLS.slice().buffer);
		expect(await store.bundles.list()).toHaveLength(1);
		await bundles.consistent();
		// Two uploads by one account at once, the second publishing first: the first keeps nothing of its own.
		await tom.deleteBundle(digest);
		let second: Promise<unknown> | undefined;
		once(store.bundles, "insert", async () => {
			second = tom.uploadBundle(SKILLS.slice().buffer);
			await second;
		});
		const first = await fetchStatus();
		await second;
		expect(first).toBe(200);
		expect(await store.bundles.list()).toHaveLength(1);
		await bundles.consistent();
		await tom.deleteBundle(digest);
		await bundles.consistent();
		expect(await bundles.open(digest)).toBeUndefined();
	});

	it("refuse a second delete under way, stop a delete too slow to trust its claim, and outlive a delete that died", async () => {
		let clock = 1_000_000;
		const { tom, store, bundles } = await on({ now: () => clock });
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const mount = { path: "/mnt/s", source: { kind: "bundle" as const, digest: bundle.digest } };

		// One delete has claimed the bundle and is counting its sandboxes: another is refused, not run alongside.
		let count: () => void = () => undefined;
		const counting = new Promise<void>((resolve) => {
			count = resolve;
		});
		let claimed: () => void = () => undefined;
		const claim = new Promise<void>((resolve) => {
			claimed = resolve;
		});
		once(store.sandboxes, "list", async () => {
			claimed();
			await counting;
		});
		const first = tom.deleteBundle(bundle.digest).catch((error: unknown) => error);
		await claim;
		expect((await failure(tom.deleteBundle(bundle.digest))).code).toBe("conflict");
		// The first takes longer than its claim can be trusted (it lapses, so a create could have slipped past it): it
		// stops, and the bundle and its bytes stay.
		clock += 45_000;
		count();
		expect((await first) instanceof KantelApiError && ((await first) as KantelApiError).code).toBe("unavailable");
		expect((await store.bundles.list()).map((record) => record.digest)).toEqual([bundle.digest]);
		expect((await store.bundles.list())[0]?.deleting).toBeUndefined();
		expect(await bundles.open(bundle.digest)).toBeDefined();

		// A delete that died after claiming: until the claim lapses a create reads the bundle as gone, then goes through.
		await store.bundles.update(`${bundle.accountId}/${bundle.digest}`, (current) => ({
			...current,
			deleting: { token: "dead", at: clock },
		}));
		expect((await failure(tom.createSandbox({ type: "microvm", mounts: [mount], wait: true }))).code).toBe("not_found");
		clock += 61_000;
		const sandbox = await tom.createSandbox({ type: "microvm", mounts: [mount], wait: true });
		// And a later delete counts it, whatever the dead claim said.
		expect((await failure(tom.deleteBundle(bundle.digest))).code).toBe("conflict");
		await tom.deleteSandbox(sandbox.id);
		await tom.deleteBundle(bundle.digest);
		expect(await store.bundles.list()).toEqual([]);
		expect(await bundles.open(bundle.digest)).toBeUndefined();
		await tom.uploadBundle(SKILLS.slice().buffer);
		expect(await bundles.open(bundle.digest)).toBeDefined();
		await bundles.consistent();
	});

	it("stay when a delete's final removal is held past its claim's lapse while a create takes them, for either kind", async () => {
		let clock = 1_000_000;
		const { tom, store, bundles } = await on({ now: () => clock });
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const source = await tom.createBucketSource({ name: "org", provider: "s3", bucket: "org" });
		const cases = [
			{
				collection: store.bundles as { deleteIf: unknown },
				mount: { path: "/mnt/s", source: { kind: "bundle" as const, digest: bundle.digest } },
				remove: () => tom.deleteBundle(bundle.digest),
				there: async () => (await store.bundles.list()).some((record) => record.digest === bundle.digest),
			},
			{
				collection: store.bucketSources as { deleteIf: unknown },
				mount: { path: "/mnt/b", source: { kind: "bucket" as const, bucketSourceId: source.id, prefix: "" } },
				remove: () => tom.deleteBucketSource(source.id),
				there: async () => (await store.bucketSources.get(source.id)) !== undefined,
			},
		];
		for (const { collection, mount, remove, there } of cases) {
			// The delete has claimed the source and counted no sandboxes; its removal is held until the claim has lapsed and
			// a create has taken the source.
			let made: string | undefined;
			once(collection, "deleteIf", async () => {
				clock += 61_000;
				made = (await tom.createSandbox({ type: "microvm", mounts: [mount], wait: true })).id;
			});
			const refused = await failure(remove());
			expect(refused.code).toBe("unavailable");
			expect(made).toBeDefined();
			expect(await there()).toBe(true);
			// The sandbox holds it: a later delete counts it, and once it's gone the source can go.
			expect((await failure(remove())).code).toBe("conflict");
			if (made !== undefined) await tom.deleteSandbox(made);
			await remove();
			expect(await there()).toBe(false);
		}
		expect(await bundles.open(bundle.digest)).toBeUndefined();
	});

	it("are given to the host the scheduler placed a starting sandbox on, and no other", async () => {
		let release: () => void = () => undefined;
		const booting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { api, tom } = await on({
			backend: (stub) => ({
				create: async (spec) => {
					await booting;
					return stub.create(spec);
				},
				placedOn: async () => "host_selected",
			}),
		});
		const bundle = await tom.uploadBundle(SKILLS.slice().buffer);
		const source = await tom.createBucketSource({
			name: "org",
			provider: "s3",
			bucket: "org",
			credentials: { accessKeyId: "AKIA", secretAccessKey: "s3cret" },
		});
		const sandbox = await tom.createSandbox({
			type: "microvm",
			mounts: [
				{ path: "/mnt/s", source: { kind: "bundle", digest: bundle.digest } },
				{ path: "/mnt/b", source: { kind: "bucket", bucketSourceId: source.id, prefix: "" } },
			],
		});
		expect(sandbox.state).toBe("starting");
		const blob = await api.service.bundleForHost("host_selected", sandbox.id, bundle.digest);
		expect(blob).toBeDefined();
		await blob?.body.cancel();
		expect((await api.service.bucketSourceForHost("host_selected", sandbox.id, source.id))?.id).toBe(source.id);
		// Another host, shared or the account's own: nothing, as it doesn't hold the placement.
		for (const other of [STUB_HOST_ID, "host_other"]) {
			expect(await api.service.bundleForHost(other, sandbox.id, bundle.digest)).toBeUndefined();
			expect(await api.service.bucketSourceForHost(other, sandbox.id, source.id)).toBeUndefined();
		}
		release();
	});
});
