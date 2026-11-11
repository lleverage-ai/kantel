// node:zlib for just-bash's gzip, gunzip and zcat, on the host's flate2 (op_kt_zlib). Output is bounded by the host.
const ops = globalThis.Deno.core.ops;

export const constants = { Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 };
const level = (options) => (options && typeof options.level === "number" && options.level >= 0 ? options.level : 6);
const asBytes = (d) =>
	typeof d === "string"
		? globalThis.Deno.core.encode(d)
		: d instanceof Uint8Array
			? d
			: new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength);
const run = (mode, d, options) => globalThis.Buffer.from(ops.op_kt_zlib(mode, asBytes(d), level(options)));

export const gzipSync = (d, o) => run("gzip", d, o);
export const gunzipSync = (d) => run("gunzip", d);
export const deflateSync = (d, o) => run("deflate", d, o);
export const inflateSync = (d) => run("inflate", d);
export const deflateRawSync = (d, o) => run("deflateraw", d, o);
export const inflateRawSync = (d) => run("inflateraw", d);
export const unzipSync = (d) => {
	const b = asBytes(d);
	return b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : inflateSync(b);
};
export default {
	constants,
	gzipSync,
	gunzipSync,
	deflateSync,
	inflateSync,
	deflateRawSync,
	inflateRawSync,
	unzipSync,
};
