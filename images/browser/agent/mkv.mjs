// Copied from tvdavies/brwsr@0d22bf8 (container/agent/mkv.mjs) for Kantel's browser runtime
// (docs/design/browser-runtime.md). Kantel changes: none.
// A minimal Matroska writer for a live stream of JPEG frames, so ffmpeg can
// read the screencast from a pipe with each frame's real timestamp. Every
// frame is its own Cluster; the Segment has an unknown size, as in any live
// Matroska stream. Timestamps are milliseconds.

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimestampScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  FlagLacing: [0x9c],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timestamp: [0xe7],
  SimpleBlock: [0xa3],
};

/** An 8-byte EBML size (always valid, and simple). */
function size(n) {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  b.writeUIntBE(Math.floor(n / 2 ** 32), 1, 3);
  b.writeUInt32BE(n >>> 0, 4);
  return b;
}
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function el(id, body) {
  return Buffer.concat([Buffer.from(id), size(body.length), body]);
}
function uint(id, n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  return el(id, Buffer.from(bytes));
}
const str = (id, s) => el(id, Buffer.from(s, "utf8"));

/** Header for one MJPEG video track of the given size. */
export function mkvHeader(width, height) {
  const ebml = el(
    ID.EBML,
    Buffer.concat([
      uint(ID.EBMLVersion, 1),
      uint(ID.EBMLReadVersion, 1),
      uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8),
      str(ID.DocType, "matroska"),
      uint(ID.DocTypeVersion, 4),
      uint(ID.DocTypeReadVersion, 2),
    ]),
  );
  const info = el(ID.Info, Buffer.concat([uint(ID.TimestampScale, 1_000_000), str(ID.MuxingApp, "brwsr"), str(ID.WritingApp, "brwsr")]));
  const track = el(
    ID.TrackEntry,
    Buffer.concat([
      uint(ID.TrackNumber, 1),
      uint(ID.TrackUID, 1),
      uint(ID.TrackType, 1),
      uint(ID.FlagLacing, 0),
      str(ID.CodecID, "V_MJPEG"),
      el(ID.Video, Buffer.concat([uint(ID.PixelWidth, width), uint(ID.PixelHeight, height)])),
    ]),
  );
  return Buffer.concat([ebml, Buffer.from(ID.Segment), UNKNOWN_SIZE, info, el(ID.Tracks, track)]);
}

/** One frame (a JPEG) at `ms` milliseconds, as a Cluster holding one keyframe SimpleBlock. */
export function mkvFrame(ms, jpeg) {
  // Track 1 (vint 0x81), relative timestamp 0, flags: keyframe.
  const block = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x80]), jpeg]);
  return el(ID.Cluster, Buffer.concat([uint(ID.Timestamp, Math.max(0, Math.round(ms))), el(ID.SimpleBlock, block)]));
}

/** Width and height from a JPEG's SOF marker, or null. */
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
