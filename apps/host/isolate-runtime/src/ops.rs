//! The ops the guests call. All three kinds share one extension (one startup snapshot per process), but each op
//! works only for the isolate kind whose state is present, and the guest can't reach any op anyway: main.js removes
//! Deno, __bootstrap, __infra and __kantel before guest code runs. Ops never panic on guest input (no unwrap/expect
//! on guest-controlled data): a panic in an op would take the whole process down.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use deno_core::{JsBuffer, OpState, op2, v8};
use deno_error::JsErrorBox;
use serde_json::Value;
use sha2::Digest;

use crate::bridges::{FetchReq, egress_fetch, valid_sha};
use crate::hostbuf::{HeldBytes, HostBytes, budget_of};
use crate::isolate::{Ctx, Engine, Kind, RunResult, RunState, engine, run_child};
use crate::limits::Refusal;

fn jerr(e: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(e.to_string())
}

fn ctx(state: &Rc<RefCell<OpState>>) -> Result<Ctx, JsErrorBox> {
    state
        .borrow()
        .try_borrow::<Ctx>()
        .cloned()
        .ok_or_else(|| JsErrorBox::generic("no isolate context"))
}

fn ctx_sync(state: &OpState) -> Result<Ctx, JsErrorBox> {
    state
        .try_borrow::<Ctx>()
        .cloned()
        .ok_or_else(|| JsErrorBox::generic("no isolate context"))
}

// --- logging, randomness, digests (every kind) --------------------------------------------------------------------

#[op2(fast)]
fn op_kt_log(#[smi] level: u32, #[string] msg: &str) {
    if engine().debug {
        let line: String = msg.chars().take(4000).collect();
        match level {
            3 => tracing::error!(target: "guest", "{line}"),
            2 => tracing::warn!(target: "guest", "{line}"),
            _ => tracing::debug!(target: "guest", "{line}"),
        }
    }
}

#[op2(fast)]
fn op_kt_random(#[buffer] buf: &mut [u8]) -> Result<(), JsErrorBox> {
    getrandom::fill(buf).map_err(jerr)
}

#[op2]
fn op_kt_digest(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
    #[string] alg: &str,
    #[buffer] data: &[u8],
) -> Result<HostBytes, JsErrorBox> {
    let digest = match alg {
        "md5" => md5::Md5::digest(data).to_vec(),
        "sha1" => sha1::Sha1::digest(data).to_vec(),
        "sha256" => sha2::Sha256::digest(data).to_vec(),
        "sha384" => sha2::Sha384::digest(data).to_vec(),
        "sha512" => sha2::Sha512::digest(data).to_vec(),
        other => return Err(JsErrorBox::generic(format!("unsupported digest {other}"))),
    };
    HostBytes::charge(isolate, &state, digest)
}

/// UTF-8 bytes of a string, for the guest's TextEncoder and Buffer (in place of deno_core's `core.encode`, whose
/// result a stock build doesn't charge to the isolate). Lone surrogates become U+FFFD, as TextEncoder does.
#[op2]
fn op_kt_encode(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
    #[string] text: String,
) -> Result<HostBytes, JsErrorBox> {
    HostBytes::charge(isolate, &state, text.into_bytes())
}

// --- zlib (shell's gzip, node's zlib) -----------------------------------------------------------------------------

/// Inflated output is bounded so a zip bomb can't take the process down.
const ZLIB_MAX_OUTPUT: usize = 256 * 1024 * 1024;

#[op2]
fn op_kt_zlib(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
    #[string] kind: &str,
    #[buffer] data: &[u8],
    #[smi] level: u32,
) -> Result<HostBytes, JsErrorBox> {
    let out = zlib(kind, data, level, ZLIB_MAX_OUTPUT).map_err(JsErrorBox::generic)?;
    HostBytes::charge(isolate, &state, out)
}

/// Compress or decompress `data`. A decompression answers the whole output, checked to its end (a gzip or zlib
/// stream's checksum included), or an error: output over `cap` is refused, never cut short and called a success.
fn zlib(kind: &str, data: &[u8], level: u32, cap: usize) -> Result<Vec<u8>, String> {
    use std::io::{Read, Write};

    use flate2::Compression;
    let lvl = Compression::new(level.min(9));
    let err = |e: std::io::Error| format!("zlib: {e}");
    fn inflate(mut decoder: impl Read, cap: usize) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        // One byte past the cap tells "exactly the cap" (the decoder reached its end, checksum checked) from "more".
        (&mut decoder)
            .take(cap as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| format!("zlib: {e}"))?;
        if out.len() > cap {
            return Err(format!(
                "zlib: the output is larger than {} MiB, the most an isolate inflates",
                cap >> 20
            ));
        }
        Ok(out)
    }
    let mut out = Vec::new();
    match kind {
        "gzip" => {
            let mut e = flate2::write::GzEncoder::new(&mut out, lvl);
            e.write_all(data).map_err(err)?;
            e.finish().map_err(err)?;
        }
        "deflate" => {
            let mut e = flate2::write::ZlibEncoder::new(&mut out, lvl);
            e.write_all(data).map_err(err)?;
            e.finish().map_err(err)?;
        }
        "deflateraw" => {
            let mut e = flate2::write::DeflateEncoder::new(&mut out, lvl);
            e.write_all(data).map_err(err)?;
            e.finish().map_err(err)?;
        }
        "gunzip" => return inflate(flate2::read::MultiGzDecoder::new(data), cap),
        "inflate" => return inflate(flate2::read::ZlibDecoder::new(data), cap),
        "inflateraw" => return inflate(flate2::read::DeflateDecoder::new(data), cap),
        _ => return Err("zlib: unknown mode".into()),
    }
    Ok(out)
}

// --- STORE: the shell's lazy blob reads and uploads ---------------------------------------------------------------

#[op2]
async fn op_kt_blob_read(
    state: Rc<RefCell<OpState>>,
    #[string] sha: String,
) -> Result<HostBytes, JsErrorBox> {
    let c = ctx(&state)?;
    if c.kind != Kind::Shell {
        return Err(JsErrorBox::generic("not available here"));
    }
    if !valid_sha(&sha) {
        return Err(JsErrorBox::generic("blob: not a SHA-256 digest"));
    }
    // Only a digest this command's manifest named, or one it has written: not any blob of the account.
    if !c.allowed.lock().unwrap().contains(&sha) {
        return Err(JsErrorBox::generic("blob: not in this sandbox's files"));
    }
    // Cap the read at the sandbox's memory and charge it (finding M7): the host accepts 256 MiB blobs, but an
    // isolate can't hold a file larger than its own memory.
    let cap = c.budget.limit();
    let mut charge = crate::bridges::Charge::new(c.budget.clone());
    let bytes = engine()
        .store
        .get(&sha, cap, Some(&mut charge))
        .await
        .map_err(jerr)?;
    // The read's charge becomes the buffer's: the bytes stay charged until V8 frees the guest's buffer.
    let held = charge.keep();
    HostBytes::adopt(budget_of(&state.borrow()), bytes, held)
}

#[op2]
#[string]
async fn op_kt_blob_put(
    state: Rc<RefCell<OpState>>,
    #[buffer] bytes: JsBuffer,
) -> Result<String, JsErrorBox> {
    let c = ctx(&state)?;
    if c.kind != Kind::Shell {
        return Err(JsErrorBox::generic("not available here"));
    }
    let sha = engine().store.put(bytes.to_vec()).await.map_err(jerr)?;
    c.allowed.lock().unwrap().insert(sha.clone());
    Ok(sha)
}

// --- EGRESS: one request through the host's proxy -----------------------------------------------------------------

const MAX_CONCURRENT_FETCH: usize = 8;

/// Decrements the isolate's in-flight fetch count when the op ends (even if cancelled).
struct FetchSlot(Arc<std::sync::atomic::AtomicUsize>);
impl Drop for FetchSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Aborts the spawned I/O task if the op future is dropped (isolate terminated or command ended), so a withheld or
/// slow response can't keep running and holding memory after the run is over (review finding H5).
struct AbortOnDrop(tokio::task::AbortHandle);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[op2]
async fn op_kt_fetch(
    state: Rc<RefCell<OpState>>,
    #[string] req: String,
    #[buffer] body: JsBuffer,
) -> Result<HostBytes, JsErrorBox> {
    let c = ctx(&state)?;
    let req: FetchReq = serde_json::from_str(&req).map_err(jerr)?;
    // Allow-list methods: no CONNECT, no arbitrary verbs.
    let method = req.method.to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err(JsErrorBox::generic(format!(
            "fetch: method {method} is not allowed"
        )));
    }
    let before = c.fetches.fetch_add(1, Ordering::SeqCst);
    if before >= MAX_CONCURRENT_FETCH {
        c.fetches.fetch_sub(1, Ordering::SeqCst);
        return Err(JsErrorBox::generic(
            "fetch: too many concurrent requests from this sandbox",
        ));
    }
    let _slot = FetchSlot(c.fetches.clone());
    let body = body.to_vec();
    let sandbox = c.sandbox_id.to_string();
    let budget = c.budget.clone();
    let remaining = c
        .command
        .deadline
        .saturating_duration_since(std::time::Instant::now());
    let eng = engine();
    let handle = eng.io.spawn(async move {
        let mut charge = crate::bridges::Charge::new(budget);
        let out = tokio::time::timeout(
            remaining,
            egress_fetch(&engine().egress, &sandbox, req, body, Some(&mut charge)),
        )
        .await;
        // The body and its charge, still held by the Charge (given back if the op is dropped before taking it).
        out.map(|r| r.map(|bytes| (bytes, charge)))
    });
    let _abort = AbortOnDrop(handle.abort_handle());
    let out = handle.await;
    match out.map_err(jerr)? {
        // The body's charge becomes the result's: the bytes stay charged until V8 frees the guest's buffer.
        Ok(Ok((bytes, charge))) => HostBytes::adopt(Some(c.budget.clone()), bytes, charge.keep()),
        Ok(Err(e)) => Err(JsErrorBox::generic(format!("fetch failed: {e:#}"))),
        Err(_) => Err(JsErrorBox::generic("fetch timed out")),
    }
}

// --- the shell runs node/python in a fresh isolate ----------------------------------------------------------------

#[op2]
async fn op_kt_run(
    state: Rc<RefCell<OpState>>,
    #[string] kind: String,
    #[string] meta: String,
    #[buffer] payload: JsBuffer,
) -> Result<HostBytes, JsErrorBox> {
    let c = ctx(&state)?;
    if c.kind != Kind::Shell {
        return Err(JsErrorBox::generic("not available here"));
    }
    let child = match kind.as_str() {
        "node" => Kind::Node,
        "python" | "python3" => Kind::Python,
        _ => return Err(JsErrorBox::generic("unknown runtime")),
    };
    let out = run_child(child, &c, meta, payload.to_vec()).await;
    HostBytes::adopt(budget_of(&state.borrow()), out, 0)
}

#[op2(fast)]
fn op_kt_cancel_run(state: &mut OpState, #[smi] run_id: u32) {
    if let Ok(c) = ctx_sync(state) {
        c.cancel_child(run_id);
    }
}

// --- node/python read the run's files and stdin -------------------------------------------------------------------

#[op2]
fn op_kt_file(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
    #[string] path: &str,
) -> Result<HostBytes, JsErrorBox> {
    let bytes = {
        let state = state.borrow();
        let run = state
            .try_borrow::<RunState>()
            .ok_or_else(|| JsErrorBox::generic("no run"))?;
        run.file(path).map_err(jerr)?
    };
    HostBytes::charge(isolate, &state, bytes)
}

#[op2]
fn op_kt_input(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
) -> Result<HostBytes, JsErrorBox> {
    let stdin = state
        .borrow()
        .try_borrow::<RunState>()
        .map(|r| r.stdin.clone())
        .unwrap_or_default();
    HostBytes::charge(isolate, &state, stdin)
}

#[op2(fast)]
fn op_kt_set_result(state: &mut OpState, #[buffer] data: &[u8]) {
    state.put(RunResult(Some(data.to_vec())));
}

#[op2(fast)]
fn op_kt_exit(state: &mut OpState) {
    if let Ok(c) = ctx_sync(state) {
        c.command.stop(crate::limits::Term::Exit);
        // End the child run now: terminate the isolate so its event loop and any pending timers stop (the guest has
        // already packed the result). Only a node/python child isolate, never the shell (op_kt_exit isn't reachable
        // there), so this never stops a sandbox mid-shell-command (finding H8).
        if c.kind != Kind::Shell {
            c.budget.stop_isolate();
        }
    }
}

// --- node's module loader: files written during the run, the builtins, and TypeScript -----------------------------

/// A module file the run wrote (`present`) or removed, for its imports. The kept copy is charged to the isolate
/// (HeldBytes) for as long as it is kept; the entry it replaces gives its charge back first. Not a fast call: a refused
/// charge collects garbage, which V8 forbids inside one.
#[op2(nofast)]
fn op_kt_overlay(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
    #[string] path: String,
    #[buffer] data: &[u8],
    present: bool,
) -> Result<(), JsErrorBox> {
    let Some(overlay) = state
        .borrow()
        .try_borrow::<RunState>()
        .map(|r| r.overlay.clone())
    else {
        return Ok(());
    };
    overlay.lock().unwrap().remove(&path);
    let entry = if present {
        Some(HeldBytes::hold(isolate, &state, data.to_vec())?)
    } else {
        None
    };
    overlay.lock().unwrap().insert(path, entry);
    Ok(())
}

#[op2(fast)]
fn op_kt_node_builtins(state: &mut OpState, #[string] json: &str) {
    if let Some(run) = state.try_borrow::<RunState>()
        && let Ok(map) =
            serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(json)
    {
        *run.builtins.lock().unwrap() = map;
    }
}

#[op2]
#[string]
fn op_kt_transpile(#[string] filename: &str, #[string] text: String) -> Result<String, JsErrorBox> {
    crate::transpile::strip_types(filename, text).map_err(jerr)
}

/// Where a script that failed to compile has its syntax error, for printing it as Node does. The guest compiles
/// CommonJS with `new Function`, which gives a SyntaxError no location, so on that failure it asks for this: the same
/// source compiled as a script with the file as its origin (wrapped as Node wraps a module, on the first line so the
/// line numbers hold). Answers JSON {line, start, end, source} (columns within the line), or "" if it compiles.
#[op2]
#[string]
fn op_kt_syntax_error<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    #[string] filename: String,
    #[string] source: String,
) -> String {
    const PREFIX: &str = "(function (exports, require, module, __filename, __dirname) {";
    let wrapped = format!("{PREFIX}{source}\n}})");
    let (Some(code), Some(name)) = (
        v8::String::new(scope, &wrapped),
        v8::String::new(scope, &filename),
    ) else {
        return String::new();
    };
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    v8::tc_scope!(let tc, scope);
    if v8::Script::compile(tc, code, Some(&origin)).is_some() {
        return String::new();
    }
    let Some(message) = tc.message() else {
        return String::new();
    };
    let line = message.get_line_number(tc).unwrap_or(0);
    let (mut start, mut end) = (message.get_start_column(), message.get_end_column());
    let mut text = message
        .get_source_line(tc)
        .map(|s| s.to_rust_string_lossy(tc))
        .unwrap_or_default();
    if line == 1 {
        // The wrapper's prefix is on the first line: take it off the source line and the columns.
        text = text
            .strip_prefix(PREFIX)
            .map(str::to_string)
            .unwrap_or(text);
        start = start.saturating_sub(PREFIX.len());
        end = end.saturating_sub(PREFIX.len());
    }
    serde_json::json!({ "line": line, "start": start, "end": end, "source": text }).to_string()
}

// --- python: read a Pyodide asset, and its memory snapshot (its own copy, never a shared buffer) ------------------

#[op2]
fn op_kt_read_asset(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
    #[string] path: String,
) -> Result<HostBytes, JsErrorBox> {
    let c = ctx(&state)?;
    if c.kind != Kind::Python {
        return Err(JsErrorBox::generic("not available here"));
    }
    let bytes = engine().read_asset(&path).map_err(jerr)?;
    HostBytes::charge(isolate, &state, bytes)
}

#[op2]
fn op_kt_python_snapshot(
    isolate: &mut v8::Isolate,
    state: Rc<RefCell<OpState>>,
) -> Result<HostBytes, JsErrorBox> {
    let c = ctx(&state)?;
    if c.kind != Kind::Python {
        return Err(JsErrorBox::generic("not available here"));
    }
    // A fresh copy for this isolate, charged to it: the guest never sees the shared source, and nothing it does can
    // corrupt another isolate's snapshot.
    let bytes = engine().python_snapshot().map_err(jerr)?;
    HostBytes::charge(isolate, &state, bytes)
}

#[op2(fast)]
fn op_kt_write_snapshot(state: &mut OpState, #[buffer] data: &[u8]) {
    if let Some(sink) = state.try_borrow::<SnapshotSink>() {
        *sink.0.borrow_mut() = Some(data.to_vec());
    }
}

/// Where `python-snapshot` collects the bytes the guest made.
pub struct SnapshotSink(pub Rc<RefCell<Option<Vec<u8>>>>);

// --- wasm memory accounting (the guest's wasm guard) --------------------------------------------------------------

/// Reserve wasm memory against the isolate's one memory limit (heap + buffers + wasm). Refused only because of the
/// heap figure from the last GC, it collects garbage and asks again (the figure can be stale: garbage the program
/// has dropped since), so a run isn't refused memory it has. Not a fast op: a fast call may not collect garbage.
#[op2(nofast)]
fn op_kt_wasm_reserve(isolate: &mut v8::Isolate, state: Rc<RefCell<OpState>>, bytes: f64) -> bool {
    // The OpState borrow ends here, before any GC (whose callbacks may need it).
    let Ok(c) = ctx(&state) else { return false };
    if !(0.0..=(u32::MAX as f64) * 16.0).contains(&bytes) {
        return false;
    }
    match c.budget.take(bytes as usize) {
        Ok(()) => true,
        Err(Refusal::Heap) => {
            isolate.low_memory_notification();
            c.budget.try_take(bytes as usize)
        }
        Err(Refusal::Over) => false,
    }
}

#[op2(fast)]
fn op_kt_wasm_release(state: &mut OpState, bytes: f64) {
    if let Ok(c) = ctx_sync(state)
        && bytes >= 0.0
    {
        c.budget.give(bytes as usize);
    }
}

#[op2]
#[string]
fn op_kt_wasm_inspect(#[buffer] bytes: &[u8], boot: bool) -> String {
    serde_json::to_string(&crate::wasm::inspect(bytes, boot))
        .unwrap_or_else(|_| "{\"error\":\"inspect failed\"}".into())
}

/// The compiled Pyodide module another isolate in this process compiled, if any. Boot only (trusted).
#[op2]
fn op_kt_wasm_cached<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
    crate::isolate::cached_wasm_object(scope)
}

#[op2]
#[string]
fn op_kt_wasm_cached_info() -> String {
    Engine::cached_wasm_info().unwrap_or_default()
}

#[op2(fast)]
fn op_kt_wasm_store(module: v8::Local<v8::Value>, #[string] info: String) {
    if let Ok(module) = TryInto::<v8::Local<v8::WasmModuleObject>>::try_into(module) {
        Engine::store_wasm(module.get_compiled_module(), info);
    }
}

deno_core::extension!(
    kt,
    ops = [
        op_kt_log,
        op_kt_random,
        op_kt_digest,
        op_kt_encode,
        op_kt_zlib,
        op_kt_blob_read,
        op_kt_blob_put,
        op_kt_fetch,
        op_kt_run,
        op_kt_cancel_run,
        op_kt_file,
        op_kt_input,
        op_kt_set_result,
        op_kt_exit,
        op_kt_overlay,
        op_kt_node_builtins,
        op_kt_transpile,
        op_kt_syntax_error,
        op_kt_read_asset,
        op_kt_python_snapshot,
        op_kt_write_snapshot,
        op_kt_wasm_reserve,
        op_kt_wasm_release,
        op_kt_wasm_inspect,
        op_kt_wasm_cached,
        op_kt_wasm_cached_info,
        op_kt_wasm_store,
    ],
);

/// The SHA-256 digests a manifest names, for the shell's allowed-read set.
pub fn manifest_shas(manifest: &Value) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Some(obj) = manifest.as_object() {
        for entry in obj.values() {
            if entry.get("kind").and_then(Value::as_str) == Some("file")
                && let Some(sha) = entry.get("sha").and_then(Value::as_str)
                && valid_sha(sha)
            {
                set.insert(sha.to_string());
            }
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::zlib;

    const CAP: usize = 4096;

    fn compress(kind: &str, data: &[u8]) -> Vec<u8> {
        zlib(kind, data, 0, usize::MAX).expect("compress")
    }

    #[test]
    fn decompression_is_whole_or_an_error() {
        for (enc, dec) in [
            ("gzip", "gunzip"),
            ("deflate", "inflate"),
            ("deflateraw", "inflateraw"),
        ] {
            // Below and exactly at the cap: the whole output.
            for len in [0, 100, CAP - 1, CAP] {
                let data: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
                let out = zlib(dec, &compress(enc, &data), 0, CAP)
                    .unwrap_or_else(|e| panic!("{dec} {len}: {e}"));
                assert_eq!(out, data, "{dec} {len}");
            }
            // Over the cap, by one byte and by a lot: refused, never a truncated success.
            for len in [CAP + 1, CAP * 64] {
                let data = vec![b'a'; len];
                let err = zlib(dec, &compress(enc, &data), 0, CAP).expect_err(dec);
                assert!(err.contains("larger than"), "{dec} {len}: {err}");
            }
        }
    }

    #[test]
    fn a_bad_checksum_at_the_cap_is_an_error() {
        let data = vec![b'z'; CAP];
        // gzip: CRC-32 then ISIZE in the last 8 bytes; zlib: Adler-32 in the last 4.
        for (enc, dec, from_end) in [("gzip", "gunzip", 8), ("deflate", "inflate", 4)] {
            let mut stream = compress(enc, &data);
            let at = stream.len() - from_end;
            stream[at] ^= 0xff;
            assert!(zlib(dec, &stream, 0, CAP).is_err(), "{dec}");
        }
    }

    #[test]
    fn a_truncated_stream_is_an_error() {
        let data: Vec<u8> = (0..CAP).map(|i| (i * 31 % 256) as u8).collect();
        for (enc, dec) in [
            ("gzip", "gunzip"),
            ("deflate", "inflate"),
            ("deflateraw", "inflateraw"),
        ] {
            let stream = compress(enc, &data);
            assert!(
                zlib(dec, &stream[..stream.len() / 2], 0, CAP).is_err(),
                "{dec}"
            );
        }
    }
}
