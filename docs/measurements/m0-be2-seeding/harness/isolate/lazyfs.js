// A lazy, read-mostly workspace filesystem for isomorphic-git, in the shape the
// isolate tier would see: the manifest (paths and stat data) is listed once, file
// bodies are fetched on demand by byte range from one object, and writes go to an
// in-memory overlay. Works in Node and in a Worker; the backend supplies range reads.
//
// manifest: { entries: { [path]: { t: "f"|"d"|"l", size, mode, mtimeMs, ctimeMs, ino, uid, gid, dev, off?, target? } } }

const enc = new TextEncoder();
const dec = new TextDecoder();

function err(code, path) {
  const e = new Error(`${code}: ${path}`);
  e.code = code;
  return e;
}

function norm(p) {
  let s = p.replace(/\/+/g, "/");
  if (s.startsWith("/")) s = s.slice(1);
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s === ".") s = "";
  return s;
}

class Stats {
  constructor(e) {
    Object.assign(this, {
      type: e.t === "d" ? "dir" : e.t === "l" ? "symlink" : "file",
      mode: e.mode,
      size: e.size,
      ino: e.ino,
      uid: e.uid,
      gid: e.gid,
      dev: e.dev,
      mtimeMs: e.mtimeMs,
      ctimeMs: e.ctimeMs,
    });
  }
  isFile() { return this.type === "file"; }
  isDirectory() { return this.type === "dir"; }
  isSymbolicLink() { return this.type === "symlink"; }
}

export class LazyFs {
  /**
   * @param {object} manifest
   * @param {{ read(off: number, len: number, path: string, entry: object): Promise<Uint8Array> }} backend
   * @param {{ cacheBytes?: number, statSkewMs?: number }} opts
   */
  constructor(manifest, backend, opts = {}) {
    this.entries = new Map(Object.entries(manifest.entries));
    this.backend = backend;
    this.cacheBytes = opts.cacheBytes ?? 32 * 1024 * 1024;
    this.statSkewMs = opts.statSkewMs ?? 0; // >0 simulates stat data that does not match the index
    this.cache = new Map(); // path -> Uint8Array (LRU by insertion order)
    this.cached = 0;
    this.overlay = new Map(); // path -> Uint8Array | null (deleted)
    this.children = new Map();
    for (const p of this.entries.keys()) this.#link(p);
    this.stats = { reads: 0, bytes: 0, statCalls: 0 };
    const self = this;
    this.promises = {
      readFile: (p, o) => self.readFile(p, o),
      writeFile: (p, d, o) => self.writeFile(p, d, o),
      unlink: (p) => self.unlink(p),
      readdir: (p) => self.readdir(p),
      mkdir: (p) => self.mkdir(p),
      rmdir: (p) => self.rmdir(p),
      stat: (p) => self.stat(p),
      lstat: (p) => self.stat(p),
      readlink: (p) => self.readlink(p),
      symlink: () => Promise.reject(err("EPERM", "symlink")),
      chmod: () => Promise.resolve(),
    };
  }

  #link(p) {
    if (p === "") return;
    const i = p.lastIndexOf("/");
    const parent = i < 0 ? "" : p.slice(0, i);
    let set = this.children.get(parent);
    if (!set) this.children.set(parent, (set = new Set()));
    set.add(i < 0 ? p : p.slice(i + 1));
    if (!this.entries.has(parent) && parent !== "") {
      this.entries.set(parent, { t: "d", size: 0, mode: 0o40755, mtimeMs: 0, ctimeMs: 0, ino: 0, uid: 0, gid: 0, dev: 0 });
      this.#link(parent);
    }
  }

  async readFile(p, opts) {
    const path = norm(p);
    let data = this.overlay.get(path);
    if (data === null) throw err("ENOENT", path);
    if (!data) {
      const e = this.entries.get(path);
      if (!e || e.t === "d") throw err(e ? "EISDIR" : "ENOENT", path);
      data = this.cache.get(path);
      if (!data) {
        data = e.size === 0 ? new Uint8Array(0) : await this.backend.read(e.off, e.size, path, e);
        this.stats.reads++;
        this.stats.bytes += e.size;
        if (e.size <= this.cacheBytes / 4) {
          this.cache.set(path, data);
          this.cached += e.size;
          for (const [k, v] of this.cache) {
            if (this.cached <= this.cacheBytes) break;
            this.cache.delete(k);
            this.cached -= v.byteLength;
          }
        }
      }
    }
    const encoding = typeof opts === "string" ? opts : opts?.encoding;
    return encoding === "utf8" ? dec.decode(data) : data;
  }

  async writeFile(p, d) {
    const path = norm(p);
    const data = typeof d === "string" ? enc.encode(d) : new Uint8Array(d);
    this.overlay.set(path, data);
    if (!this.entries.has(path)) {
      this.entries.set(path, { t: "f", size: data.byteLength, mode: 0o100644, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: 0, uid: 0, gid: 0, dev: 0 });
      this.#link(path);
    } else {
      const e = this.entries.get(path);
      this.entries.set(path, { ...e, size: data.byteLength, mtimeMs: Date.now(), ctimeMs: Date.now() });
    }
  }

  async unlink(p) {
    const path = norm(p);
    if (!this.entries.has(path)) throw err("ENOENT", path);
    this.overlay.set(path, null);
    this.entries.delete(path);
  }

  async readdir(p) {
    const path = norm(p);
    const e = this.entries.get(path);
    if (path !== "" && (!e || e.t !== "d")) throw err(e ? "ENOTDIR" : "ENOENT", path);
    return [...(this.children.get(path) ?? [])].filter((n) => this.entries.has(path ? `${path}/${n}` : n));
  }

  async mkdir(p) {
    const path = norm(p);
    if (this.entries.has(path)) throw err("EEXIST", path);
    this.entries.set(path, { t: "d", size: 0, mode: 0o40755, mtimeMs: Date.now(), ctimeMs: Date.now(), ino: 0, uid: 0, gid: 0, dev: 0 });
    this.#link(path);
  }

  async rmdir(p) {
    this.entries.delete(norm(p));
  }

  async stat(p) {
    this.stats.statCalls++;
    const path = norm(p);
    const e = this.entries.get(path);
    if (!e && path !== "") throw err("ENOENT", path);
    const s = new Stats(e ?? { t: "d", size: 0, mode: 0o40755, mtimeMs: 0, ctimeMs: 0, ino: 0, uid: 0, gid: 0, dev: 0 });
    if (this.statSkewMs && s.type === "file" && !path.startsWith(".git/")) {
      s.mtimeMs += this.statSkewMs;
      s.ctimeMs += this.statSkewMs;
    }
    return s;
  }

  async readlink(p) {
    const e = this.entries.get(norm(p));
    if (!e || e.t !== "l") throw err("EINVAL", p);
    return e.target;
  }
}
