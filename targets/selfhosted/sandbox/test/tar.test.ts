import { describe, expect, it } from "vitest";
import { demux } from "../src/docker.ts";
import { readTar, type TarEntry, writeTar } from "../src/tar.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("tar", () => {
	it("round-trips files and directories with their contents, modes and owners", () => {
		const entries: TarEntry[] = [
			{ type: "dir", path: "notes", mode: 0o755 },
			{ type: "file", path: "notes/a.md", mode: 0o644, data: encoder.encode("hello") },
			{ type: "file", path: "bin/run.sh", mode: 0o755, data: encoder.encode("#!/bin/sh\necho hi\n") },
			{ type: "file", path: "empty.txt", mode: 0o600, data: new Uint8Array() },
			{ type: "file", path: "etc/ca.crt", mode: 0o444, data: encoder.encode("pem"), uid: 0, gid: 0 },
		];
		const read = readTar(writeTar(entries, { mtime: 1_700_000_000 }));
		expect(read.map((entry) => [entry.type, entry.path, entry.mode.toString(8), entry.uid, entry.gid])).toEqual([
			["dir", "notes", "755", 1000, 1000],
			["file", "notes/a.md", "644", 1000, 1000],
			["file", "bin/run.sh", "755", 1000, 1000],
			["file", "empty.txt", "600", 1000, 1000],
			["file", "etc/ca.crt", "444", 0, 0],
		]);
		const files = read.filter((entry) => entry.type === "file");
		expect(files.map((entry) => decoder.decode(entry.data))).toEqual(["hello", "#!/bin/sh\necho hi\n", "", "pem"]);
	});

	it("keeps exact bytes across block boundaries", () => {
		for (const size of [511, 512, 513, 1024, 70_000]) {
			const data = new Uint8Array(size).map((_, i) => (i * 31 + size) % 256);
			const [entry] = readTar(writeTar([{ type: "file", path: "blob.bin", mode: 0o644, data }]));
			expect(entry?.type).toBe("file");
			expect(entry?.type === "file" ? Buffer.from(entry.data).equals(Buffer.from(data)) : false).toBe(true);
		}
	});

	it("carries long and non-ASCII paths in PAX headers", () => {
		const deep = `${"directory-name/".repeat(12)}file-with-a-long-name.txt`;
		const accented = `notes/${"é".repeat(60)}/ünïcødé.md`;
		expect(encoder.encode(deep).length).toBeGreaterThan(100);
		expect(encoder.encode(accented).length).toBeGreaterThan(100);
		const read = readTar(
			writeTar([
				{ type: "dir", path: `${"d".repeat(120)}`, mode: 0o750 },
				{ type: "file", path: deep, mode: 0o640, data: encoder.encode("deep") },
				{ type: "file", path: accented, mode: 0o644, data: encoder.encode("accented") },
				{ type: "file", path: "short.txt", mode: 0o644, data: encoder.encode("short") },
			]),
		);
		expect(read.map((entry) => [entry.path, entry.mode.toString(8)])).toEqual([
			["d".repeat(120), "750"],
			[deep, "640"],
			[accented, "644"],
			["short.txt", "644"],
		]);
	});

	it("skips symlinks, hard links and devices, and honours GNU long names", () => {
		const block = (name: string, type: string, size = 0, linkname = "") => {
			const header = new Uint8Array(512);
			const put = (text: string, offset: number) => header.set(encoder.encode(text), offset);
			put(name, 0);
			put("0000644\0", 100);
			put("0001750\0", 108);
			put("0001750\0", 116);
			put(`${size.toString(8).padStart(11, "0")}\0`, 124);
			put("00000000000\0", 136);
			put("        ", 148);
			put(type, 156);
			put(linkname, 157);
			put("ustar  \0", 257);
			let sum = 0;
			for (const byte of header) sum += byte;
			put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
			return header;
		};
		const pad = (data: Uint8Array) => {
			const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
			out.set(data);
			return out;
		};
		const longName = `${"x".repeat(150)}.txt`;
		const archive = Buffer.concat([
			block("link", "2", 0, "target"),
			block("hard", "1", 0, "target"),
			block("dev", "3"),
			block("././@LongLink", "L", longName.length + 1),
			pad(encoder.encode(`${longName}\0`)),
			block("truncated-name", "0", 2),
			pad(encoder.encode("ok")),
			new Uint8Array(1024),
		]);
		const read = readTar(new Uint8Array(archive));
		expect(read.map((entry) => entry.path)).toEqual([longName]);
		expect(read[0]?.type === "file" ? decoder.decode(read[0].data) : undefined).toBe("ok");
	});

	it("rejects absolute entry paths", () => {
		expect(() => writeTar([{ type: "file", path: "/etc/passwd", mode: 0o644, data: new Uint8Array() }])).toThrow();
	});
});

describe("demux", () => {
	it("splits Docker's multiplexed stream into stdout and stderr", () => {
		const frame = (stream: number, text: string) => {
			const payload = encoder.encode(text);
			const header = new Uint8Array(8);
			header[0] = stream;
			new DataView(header.buffer).setUint32(4, payload.length);
			return Buffer.concat([header, payload]);
		};
		const { stdout, stderr } = demux(
			new Uint8Array(Buffer.concat([frame(1, "out "), frame(2, "err"), frame(1, "more"), frame(1, "")])),
		);
		expect(decoder.decode(stdout)).toBe("out more");
		expect(decoder.decode(stderr)).toBe("err");
	});
});
