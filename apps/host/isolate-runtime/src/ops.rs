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
use crate::isolate::{Ctx, Engine, Kind, RunResult, RunState, engine, run_child};

fn jerr(e: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(e.to_string())
}

fn ctx(state: &Rc<RefCell<OpState>>) -> Result<Ctx, JsErrorBox> {
    state.borrow().try_borrow::<Ctx>().cloned().ok_or_else(|| JsErrorBox::generic("no isolate context"))
}

fn ctx_sync(state: &OpState) -> Result<Ctx, JsErrorBox> {
    state.try_borrow::<Ctx>().cloned().ok_or_else(|| JsErrorBox::generic("no isolate context"))
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
#[buffer]
fn op_kt_digest(#[string] alg: &str, #[buffer] data: &[u8]) -> Result<Vec<u8>, JsErrorBox> {
    Ok(match alg {
        "md5" => md5::Md5::digest(data).to_vec(),
        "sha1" => sha1::Sha1::digest(data).to_vec(),
        "sha256" => sha2::Sha256::digest(data).to_vec(),
        "sha384" => sha2::Sha384::digest(data).to_vec(),
        "sha512" => sha2::Sha512::digest(data).to_vec(),
        other => return Err(JsErrorBox::generic(format!("unsupported digest {other}"))),
    })
}

// --- zlib (shell's gzip, node's zlib) -----------------------------------------------------------------------------

#[op2]
#[buffer]
fn op_kt_zlib(#[string] kind: &str, #[buffer] data: &[u8], #[smi] level: u32) -> Result<Vec<u8>, JsErrorBox> {
    use std::io::{Read, Write};

    use flate2::Compression;
    let lvl = Compression::new(level.min(9));
    let mut out = Vec::new();
    // Inflated output is bounded so a zip bomb can't take the process down.
    let cap = 256u64 * 1024 * 1024;
    match kind {
        "gzip" => {
            let mut e = flate2::write::GzEncoder::new(&mut out, lvl);
            e.write_all(data).map_err(jerr)?;
            e.finish().map_err(jerr)?;
        }
        "deflate" => {
            let mut e = flate2::write::ZlibEncoder::new(&mut out, lvl);
            e.write_all(data).map_err(jerr)?;
            e.finish().map_err(jerr)?;
        }
        "deflateraw" => {
            let mut e = flate2::write::DeflateEncoder::new(&mut out, lvl);
            e.write_all(data).map_err(jerr)?;
            e.finish().map_err(jerr)?;
        }
        "gunzip" => {
            flate2::read::MultiGzDecoder::new(data).take(cap).read_to_end(&mut out).map_err(jerr)?;
        }
        "inflate" => {
            flate2::read::ZlibDecoder::new(data).take(cap).read_to_end(&mut out).map_err(jerr)?;
        }
        "inflateraw" => {
            flate2::read::DeflateDecoder::new(data).take(cap).read_to_end(&mut out).map_err(jerr)?;
        }
        _ => return Err(JsErrorBox::generic("zlib: unknown mode")),
    }
    Ok(out)
}

// --- STORE: the shell's lazy blob reads and uploads ---------------------------------------------------------------

#[op2]
#[buffer]
async fn op_kt_blob_read(state: Rc<RefCell<OpState>>, #[string] sha: String) -> Result<Vec<u8>, JsErrorBox> {
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
    engine().store.get(&sha, cap, Some(&mut charge)).await.map_err(jerr)
}

#[op2]
#[string]
async fn op_kt_blob_put(state: Rc<RefCell<OpState>>, #[buffer] bytes: JsBuffer) -> Result<String, JsErrorBox> {
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
#[buffer]
async fn op_kt_fetch(state: Rc<RefCell<OpState>>, #[string] req: String, #[buffer] body: JsBuffer) -> Result<Vec<u8>, JsErrorBox> {
    let c = ctx(&state)?;
    let req: FetchReq = serde_json::from_str(&req).map_err(jerr)?;
    // Allow-list methods: no CONNECT, no arbitrary verbs.
    let method = req.method.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS") {
        return Err(JsErrorBox::generic(format!("fetch: method {method} is not allowed")));
    }
    let before = c.fetches.fetch_add(1, Ordering::SeqCst);
    if before >= MAX_CONCURRENT_FETCH {
        c.fetches.fetch_sub(1, Ordering::SeqCst);
        return Err(JsErrorBox::generic("fetch: too many concurrent requests from this sandbox"));
    }
    let _slot = FetchSlot(c.fetches.clone());
    let body = body.to_vec();
    let sandbox = c.sandbox_id.to_string();
    let budget = c.budget.clone();
    let remaining = c.command.deadline.saturating_duration_since(std::time::Instant::now());
    let eng = engine();
    let handle = eng.io.spawn(async move {
        let mut charge = crate::bridges::Charge::new(budget);
        tokio::time::timeout(remaining, egress_fetch(&engine().egress, &sandbox, req, body, Some(&mut charge))).await
    });
    let _abort = AbortOnDrop(handle.abort_handle());
    let out = handle.await;
    match out.map_err(jerr)? {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(e)) => Err(JsErrorBox::generic(format!("fetch failed: {e:#}"))),
        Err(_) => Err(JsErrorBox::generic("fetch timed out")),
    }
}

// --- the shell runs node/python in a fresh isolate ----------------------------------------------------------------

#[op2]
#[buffer]
async fn op_kt_run(
    state: Rc<RefCell<OpState>>,
    #[string] kind: String,
    #[string] meta: String,
    #[buffer] payload: JsBuffer,
) -> Result<Vec<u8>, JsErrorBox> {
    let c = ctx(&state)?;
    if c.kind != Kind::Shell {
        return Err(JsErrorBox::generic("not available here"));
    }
    let child = match kind.as_str() {
        "node" => Kind::Node,
        "python" | "python3" => Kind::Python,
        _ => return Err(JsErrorBox::generic("unknown runtime")),
    };
    Ok(run_child(child, &c, meta, payload.to_vec()).await)
}

#[op2(fast)]
fn op_kt_cancel_run(state: &mut OpState, #[smi] run_id: u32) {
    if let Ok(c) = ctx_sync(state) {
        c.cancel_child(run_id);
    }
}

// --- node/python read the run's files and stdin -------------------------------------------------------------------

#[op2]
#[buffer]
fn op_kt_file(state: &mut OpState, #[string] path: &str) -> Result<Vec<u8>, JsErrorBox> {
    let run = state.try_borrow::<RunState>().ok_or_else(|| JsErrorBox::generic("no run"))?;
    run.file(path).map_err(jerr)
}

#[op2]
#[buffer]
fn op_kt_input(state: &mut OpState) -> Vec<u8> {
    state.try_borrow::<RunState>().map(|r| r.stdin.clone()).unwrap_or_default()
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

#[op2(fast)]
fn op_kt_overlay(state: &mut OpState, #[string] path: &str, #[buffer] data: &[u8], present: bool) {
    if let Some(run) = state.try_borrow::<RunState>() {
        run.overlay.lock().unwrap().insert(path.to_string(), if present { Some(data.to_vec()) } else { None });
    }
}

#[op2(fast)]
fn op_kt_node_builtins(state: &mut OpState, #[string] json: &str) {
    if let Some(run) = state.try_borrow::<RunState>() {
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, Vec<String>>>(json) {
            *run.builtins.lock().unwrap() = map;
        }
    }
}

#[op2]
#[string]
fn op_kt_transpile(#[string] filename: &str, #[string] text: String) -> Result<String, JsErrorBox> {
    crate::transpile::strip_types(filename, text).map_err(jerr)
}

// --- python: read a Pyodide asset, and its memory snapshot (its own copy, never a shared buffer) ------------------

#[op2]
#[buffer]
fn op_kt_read_asset(state: &mut OpState, #[string] path: String) -> Result<Vec<u8>, JsErrorBox> {
    let c = ctx_sync(state)?;
    if c.kind != Kind::Python {
        return Err(JsErrorBox::generic("not available here"));
    }
    engine().read_asset(&path).map_err(jerr)
}

#[op2]
#[buffer]
fn op_kt_python_snapshot(state: &mut OpState) -> Result<Vec<u8>, JsErrorBox> {
    let c = ctx_sync(state)?;
    if c.kind != Kind::Python {
        return Err(JsErrorBox::generic("not available here"));
    }
    // A fresh copy for this isolate: the guest never sees the shared source, and nothing it does can corrupt another
    // isolate's snapshot (the #[buffer] return copies into a V8-owned ArrayBuffer).
    engine().python_snapshot().map_err(jerr)
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

#[op2(fast)]
fn op_kt_wasm_reserve(state: &mut OpState, bytes: f64) -> bool {
    let Ok(c) = ctx_sync(state) else { return false };
    if !(0.0..=(u32::MAX as f64) * 16.0).contains(&bytes) {
        return false;
    }
    c.budget.try_take(bytes as usize)
}

#[op2(fast)]
fn op_kt_wasm_release(state: &mut OpState, bytes: f64) {
    if let Ok(c) = ctx_sync(state) {
        if bytes >= 0.0 {
            c.budget.give(bytes as usize);
        }
    }
}

#[op2]
#[string]
fn op_kt_wasm_inspect(#[buffer] bytes: &[u8], boot: bool) -> String {
    serde_json::to_string(&crate::wasm::inspect(bytes, boot)).unwrap_or_else(|_| "{\"error\":\"inspect failed\"}".into())
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
            if entry.get("kind").and_then(Value::as_str) == Some("file") {
                if let Some(sha) = entry.get("sha").and_then(Value::as_str) {
                    if valid_sha(sha) {
                        set.insert(sha.to_string());
                    }
                }
            }
        }
    }
    set
}

