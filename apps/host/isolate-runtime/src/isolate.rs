//! Isolates and their lifecycle: one V8 isolate per shell sandbox (on its own thread, kept while the sandbox is
//! used), and a fresh isolate per `node`/`python` run (one run, then discarded), each from the one startup snapshot
//! the process builds. Limits (memory, CPU, wall) come from `limits`; the ops are in `ops`.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use deno_core::{
    JsRuntime, JsRuntimeForSnapshot, ModuleLoadResponse, ModuleLoader, ModuleResolveResponse, ModuleSource,
    ModuleSourceCode, ModuleSpecifier, ModuleType, PollEventLoopOptions, ResolutionKind,
    RuntimeOptions, v8,
};
use deno_error::JsErrorBox;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::bridges::Store;
use crate::config::{Config, DEFAULT_MEMORY_MIB};
use crate::limits::{Budget, Command, MIB, Term, allocator, near_heap_limit, watch};
use crate::ops::{SnapshotSink, kt};

const GUEST: &str = include_str!("../guest/dist/guest.js");

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Shell,
    Node,
    Python,
}

impl Kind {
    fn init_arg(self) -> &'static str {
        match self {
            Kind::Shell => "shell",
            Kind::Node => "node",
            Kind::Python => "python",
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Per-command context in an isolate's OpState

/// One isolate's running command. Cloneable: the ops hold it, and a child run shares its parent's `command` so the
/// parent command's CPU budget covers the child.
#[derive(Clone)]
pub struct Ctx {
    pub kind: Kind,
    pub sandbox_id: Arc<str>,
    pub command: Arc<Command>,
    pub budget: Arc<Budget>,
    /// SHA-256 digests the shell may read (its manifest's, and ones it wrote).
    pub allowed: Arc<Mutex<std::collections::HashSet<String>>>,
    /// In-flight egress fetches from this isolate.
    pub fetches: Arc<AtomicUsize>,
    /// node/python runs the shell started, by run id, so the shell can cancel one (just-bash `timeout`).
    pub children: Arc<Mutex<HashMap<u32, Arc<ChildControl>>>>,
}

impl Ctx {
    fn new(kind: Kind, sandbox_id: Arc<str>, command: Arc<Command>, budget: Arc<Budget>, allowed: std::collections::HashSet<String>) -> Ctx {
        Ctx {
            kind,
            sandbox_id,
            command,
            budget,
            allowed: Arc::new(Mutex::new(allowed)),
            fetches: Arc::new(AtomicUsize::new(0)),
            children: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub fn cancel_child(&self, run_id: u32) {
        if let Some(control) = self.children.lock().unwrap().get(&run_id) {
            control.cancel();
        }
    }
}

/// A node/python run the shell can cancel: it stops the child isolate once the child has registered itself.
#[derive(Default)]
pub struct ChildControl {
    watched: Mutex<Option<Arc<crate::limits::Watched>>>,
    cancelled: std::sync::atomic::AtomicBool,
}
impl ChildControl {
    fn register(&self, w: Arc<crate::limits::Watched>) {
        if self.cancelled.load(Ordering::SeqCst) {
            w.stop(Term::Cancel);
        }
        *self.watched.lock().unwrap() = Some(w);
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(w) = self.watched.lock().unwrap().as_ref() {
            w.stop(Term::Cancel);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// A node/python run's view of the files

#[derive(Clone)]
pub enum FileRef {
    /// Bytes inline in `payload` (files the command changed this run).
    Inline(usize, usize),
    /// A blob by digest (untouched files; read from STORE when the run opens it).
    Blob(String),
}

pub struct RunState {
    pub index: HashMap<String, FileRef>,
    pub payload: Arc<Vec<u8>>,
    pub stdin: Vec<u8>,
    /// node module loader: files the run wrote, by absolute path (Some = bytes, None = removed).
    pub overlay: Arc<Mutex<HashMap<String, Option<Vec<u8>>>>>,
    /// node module loader: each built-in's export names, so a `node:fs` import gets named exports.
    pub builtins: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

impl RunState {
    pub fn file(&self, path: &str) -> Result<Vec<u8>> {
        resolve_file(&self.index, &self.payload, path)
    }
}

/// Read one of a run's files synchronously (node's fs and python's FS are synchronous; the run has its own thread).
fn resolve_file(index: &HashMap<String, FileRef>, payload: &[u8], path: &str) -> Result<Vec<u8>> {
    match index.get(path) {
        None => bail!("ENOENT: {path}"),
        Some(FileRef::Inline(off, len)) => {
            payload.get(*off..off + len).map(|s| s.to_vec()).ok_or_else(|| anyhow!("bad inline file"))
        }
        Some(FileRef::Blob(sha)) => {
            let sha = sha.clone();
            let (tx, rx) = std::sync::mpsc::channel();
            engine().io.spawn(async move {
                let _ = tx.send(engine().store.get(&sha).await);
            });
            rx.recv()?.map_err(|e| anyhow!("{e}"))
        }
    }
}

#[derive(Default)]
pub struct RunResult(pub Option<Vec<u8>>);

// ---------------------------------------------------------------------------------------------------------------
// The process-wide engine: config, STORE, the snapshot, the pools, the run limiter and the shared wasm module.

pub struct Engine {
    pub cfg: Config,
    pub store: Arc<Store>,
    pub io: tokio::runtime::Handle,
    pub egress: crate::bridges::Target,
    pub debug: bool,
    snapshot: &'static [u8],
    assets: Mutex<HashMap<std::path::PathBuf, Arc<Vec<u8>>>>,
    python_snapshot_src: OnceLock<Arc<Vec<u8>>>,
    pub stats: Stats,
    /// Concurrent node/python runs across all sandboxes.
    pub runs: Arc<tokio::sync::Semaphore>,
}

#[derive(Default)]
pub struct Stats {
    pub node_runs: AtomicU64,
    pub python_runs: AtomicU64,
    pub terminations_cpu: AtomicU64,
    pub terminations_memory: AtomicU64,
    pub terminations_wall: AtomicU64,
    pub rebuilds: AtomicU64,
}

impl Stats {
    pub fn count_term(&self, t: Term) {
        match t {
            Term::Cpu => &self.terminations_cpu,
            Term::Memory => &self.terminations_memory,
            Term::Wall => &self.terminations_wall,
            _ => return,
        }
        .fetch_add(1, Ordering::Relaxed);
    }
}

static ENGINE: OnceLock<Engine> = OnceLock::new();
static WASM: Mutex<Option<(v8::CompiledWasmModule, String)>> = Mutex::new(None);

pub fn engine() -> &'static Engine {
    ENGINE.get().expect("engine not started")
}

impl Engine {
    pub fn init(cfg: Config, io: tokio::runtime::Handle, debug: bool) -> Result<&'static Engine> {
        let store = Arc::new(Store::new(cfg.store.clone()));
        let snapshot = build_snapshot();
        let egress = cfg.egress.clone();
        let runs = Arc::new(tokio::sync::Semaphore::new(cfg.max_runs));
        let built = Engine {
            cfg,
            store,
            io,
            egress,
            debug,
            snapshot,
            assets: Mutex::new(HashMap::new()),
            python_snapshot_src: OnceLock::new(),
            stats: Stats::default(),
            runs,
        };
        ENGINE.set(built).map_err(|_| anyhow!("engine already set"))?;
        Ok(engine())
    }

    pub fn snapshot(&self) -> &'static [u8] {
        self.snapshot
    }

    /// A Pyodide asset, by absolute path or relative to `--assets/pyodide`, read once and cached. Only inside that
    /// directory.
    pub fn read_asset(&self, path: &str) -> Result<Vec<u8>> {
        let path = path.strip_prefix("file://").unwrap_or(path);
        let base = &self.cfg.pyodide;
        let joined = if path.starts_with('/') { std::path::PathBuf::from(path) } else { base.join(path) };
        let canon = std::fs::canonicalize(&joined).map_err(|e| anyhow!("{}: {e}", joined.display()))?;
        if !canon.starts_with(base) {
            bail!("{}: outside the assets directory", joined.display());
        }
        let mut cache = self.assets.lock().unwrap();
        if let Some(b) = cache.get(&canon) {
            return Ok(b.as_ref().clone());
        }
        let bytes = Arc::new(std::fs::read(&canon)?);
        cache.insert(canon, bytes.clone());
        Ok(bytes.as_ref().clone())
    }

    /// A fresh copy of the Pyodide memory snapshot (read from disk once into an immutable source).
    pub fn python_snapshot(&self) -> Result<Vec<u8>> {
        let src = match self.python_snapshot_src.get() {
            Some(s) => s.clone(),
            None => {
                let bytes = Arc::new(std::fs::read(&self.cfg.python_snapshot).map_err(|e| anyhow!("python snapshot: {e}"))?);
                let _ = self.python_snapshot_src.set(bytes.clone());
                self.python_snapshot_src.get().cloned().unwrap_or(bytes)
            }
        };
        Ok(src.as_ref().clone())
    }

    pub fn cached_wasm_info() -> Option<String> {
        WASM.lock().unwrap().as_ref().map(|(_, i)| i.clone())
    }
    pub fn store_wasm(module: v8::CompiledWasmModule, info: String) {
        *WASM.lock().unwrap() = Some((module, info));
    }
}

/// The compiled Pyodide module another isolate compiled, as a WasmModuleObject in `scope` (undefined if none). The
/// lock is held only to build the object; `CompiledWasmModule` is a refcounted handle, not owned memory.
pub fn cached_wasm_object<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
    match WASM.lock().unwrap().as_ref() {
        Some((compiled, _)) => v8::WasmModuleObject::from_compiled_module(scope, compiled)
            .map(|m| m.into())
            .unwrap_or_else(|| v8::undefined(scope).into()),
        None => v8::undefined(scope).into(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// A live isolate

pub struct Live {
    pub rt: JsRuntime,
    pub handle: v8::IsolateHandle,
    pub budget: Arc<Budget>,
    #[allow(dead_code)]
    pub kind: Kind,
}

fn module_loader(kind: Kind) -> Option<Rc<dyn ModuleLoader>> {
    match kind {
        Kind::Node => Some(Rc::new(NodeModuleLoader::new())),
        Kind::Python => Some(Rc::new(AssetModuleLoader)),
        Kind::Shell => None,
    }
}

pub fn new_live(kind: Kind, mem_mib: usize) -> Live {
    let limit = mem_mib * MIB;
    let budget = Budget::new(limit);
    let params = v8::CreateParams::default().heap_limits(0, limit).array_buffer_allocator(allocator(&budget).make_shared());
    let mut rt = JsRuntime::new(RuntimeOptions {
        extensions: vec![kt::init()],
        startup_snapshot: Some(engine().snapshot()),
        create_params: Some(params),
        module_loader: module_loader(kind),
        ..Default::default()
    });
    let handle = rt.v8_isolate().thread_safe_handle();
    budget.set_handle(handle.clone());
    rt.add_near_heap_limit_callback(near_heap_limit(&budget, handle.clone()));
    if kind == Kind::Shell {
        // The shell never needs JS eval, and its isolate is long-lived, so eval and new Function throw there. A
        // node/python isolate is single-use (one run, then discarded) and its CommonJS loader builds a function from
        // the run's own source, so codegen stays on for those.
        deno_core::scope!(scope, &mut rt);
        scope.get_current_context().set_allow_generation_from_strings(false);
    }
    // Keep only this kind's entry; init removes Deno/__bootstrap/__infra/__kantel so guest code can't reach the ops.
    let init = format!("globalThis.__kantelEntry = globalThis.__kantel.init({:?});", kind.init_arg());
    rt.execute_script("kt:init", init).expect("guest init");
    Live { rt, handle, budget, kind }
}

/// Call `globalThis.__kantelEntry.<method>(args...)` and await the result as a string. The ops the guest used run on
/// the event loop, so this pumps it to settle any promise the call returns.
async fn call(rt: &mut JsRuntime, method: &str, args: &[&str]) -> Result<String> {
    let arg_list = args.iter().map(|a| lit(a)).collect::<Vec<_>>().join(",");
    let script = format!("globalThis.__kantelEntry.{method}({arg_list})");
    let value = rt.execute_script("kt:call", script).map_err(|e| anyhow!("{e}"))?;
    let resolved = rt.resolve(value);
    let value = rt.with_event_loop_promise(resolved, PollEventLoopOptions::default()).await.map_err(|e| anyhow!("{e}"))?;
    deno_core::scope!(scope, &mut *rt);
    let local = v8::Local::new(scope, value);
    Ok(local.to_rust_string_lossy(scope))
}

fn lit(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn bind(rt: &mut JsRuntime, ctx: Ctx) {
    rt.op_state().borrow_mut().put(ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Shell isolates: one thread each, kept while the sandbox is used

pub enum ShellCmd {
    Load { mem_mib: usize, reply: oneshot::Sender<()> },
    Exec { sandbox_id: Arc<str>, body: String, manifest: Value, command: Arc<Command>, reply: oneshot::Sender<Value> },
}

pub struct ShellHandle {
    pub tx: mpsc::UnboundedSender<ShellCmd>,
    #[allow(dead_code)]
    pub mem_mib: usize,
    pub sandbox_id: Arc<str>,
}

pub fn spawn_shell(sandbox_id: Arc<str>, mem_mib: usize, warmup: bool) -> ShellHandle {
    let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
    let id = sandbox_id.clone();
    std::thread::Builder::new()
        .name("kt-shell".into())
        .stack_size(8 * MIB)
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("shell tokio");
            let _entered = rt.enter();
            let mut live = new_live(Kind::Shell, mem_mib);
            if warmup {
                // Run one empty command so just-bash's code is compiled before the sandbox's first real command.
                let command = Command::new(Duration::from_secs(10), Duration::from_secs(10));
                bind(&mut live.rt, Ctx::new(Kind::Shell, id.clone(), command.clone(), live.budget.clone(), Default::default()));
                let guard = watch(live.handle.clone(), command, live.budget.clone());
                let _ = rt.block_on(call(&mut live.rt, "exec", &[r#"{"command":"true","manifest":{}}"#]));
                drop(guard);
            }
            rt.block_on(async move {
                while let Some(cmd) = rx.recv().await {
                    match cmd {
                        ShellCmd::Load { mem_mib, reply } => {
                            if mem_mib != live.budget.limit() / MIB {
                                live = new_live(Kind::Shell, mem_mib);
                            }
                            let _ = reply.send(());
                        }
                        ShellCmd::Exec { sandbox_id, body, manifest, command, reply } => {
                            live.budget.reset_exceeded();
                            let shas = crate::ops::manifest_shas(&manifest);
                            bind(
                                &mut live.rt,
                                Ctx::new(Kind::Shell, sandbox_id, command.clone(), live.budget.clone(), shas),
                            );
                            let guard = watch(live.handle.clone(), command.clone(), live.budget.clone());
                            let mem = live.budget.limit() / MIB;
                            // The shell isolate is long-lived and reused, so let the terminated call run to its error
                            // (terminate_execution makes execute_script / the event loop return Err) rather than
                            // abandoning it mid-op — abandoning while it awaits a child node/python op leaves the
                            // isolate in a state that aborts V8.
                            let result = call(&mut live.rt, "exec", &[body.as_str()]).await;
                            let term = guard.watched().term();
                            drop(guard);
                            let value = match (result, term) {
                                (Ok(s), None) => serde_json::from_str(&s).unwrap_or_else(|e| json!({ "error": format!("bad guest reply: {e}") })),
                                (_, Some(t)) if t != Term::Exit => {
                                    engine().stats.count_term(t);
                                    engine().stats.rebuilds.fetch_add(1, Ordering::Relaxed);
                                    // Clear the terminate flag and reuse the isolate for the sandbox's next command:
                                    // each exec builds its own bash and filesystem from the manifest (the host's
                                    // state), so nothing carries over, and a low-memory notification hands back what
                                    // the stopped command allocated. The isolate is reused, not rebuilt: dropping it
                                    // here, inside the running event-loop turn, would abort V8.
                                    live.rt.v8_isolate().cancel_terminate_execution();
                                    live.rt.v8_isolate().low_memory_notification();
                                    json!({
                                        "exitCode": t.exit_code(), "stdout": "",
                                        "stderr": t.message("kantel", mem, command.cpu_limit, command.wall),
                                        "manifest": manifest, "changed": [], "terminated": t.name(),
                                        "timings": {},
                                    })
                                }
                                (Ok(s), Some(_)) => serde_json::from_str(&s).unwrap_or_else(|_| json!({ "error": "guest stopped" })),
                                (Err(e), _) => json!({ "error": format!("{e:#}") }),
                            };
                            let _ = reply.send(value);
                        }
                    }
                }
            });
        })
        .expect("spawn shell thread");
    ShellHandle { tx, mem_mib, sandbox_id }
}

// ---------------------------------------------------------------------------------------------------------------
// node/python runs: one fresh isolate each, with a ready pool

pub struct Job {
    #[allow(dead_code)]
    pub ctx_kind: Kind,
    pub sandbox_id: Arc<str>,
    pub command: Arc<Command>,
    pub budget_mem: usize,
    pub run: RunState,
    pub meta: String,
    pub control: Arc<ChildControl>,
    pub reply: oneshot::Sender<Vec<u8>>,
    pub permit: tokio::sync::OwnedSemaphorePermit,
}

fn pack_error(code: i64, stderr: &str) -> Vec<u8> {
    crate::bridges::pack(&json!({ "exitCode": code, "stdout": "", "stderr": stderr, "writes": [], "removes": [], "mkdirs": [], "symlinks": [] }), &[])
}

/// Run `node`/`python` for the shell. The child isolate is watched under the shell command's budget, so its CPU
/// counts against the command total, and it shares the command's wall deadline.
pub async fn run_child(kind: Kind, parent: &Ctx, meta: String, payload: Vec<u8>) -> Vec<u8> {
    let eng = engine();
    let permit = match eng.runs.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            let name = if kind == Kind::Node { "node" } else { "python" };
            return pack_error(1, &format!("{name}: the runtime is busy (too many concurrent runs). Try again.\n"));
        }
    };
    let parsed: Value = match serde_json::from_str(&meta) {
        Ok(v) => v,
        Err(e) => return pack_error(1, &format!("runtime: bad request ({e})\n")),
    };
    let run_id = parsed["runId"].as_u64().unwrap_or(0) as u32;
    let index = parse_index(&parsed);
    let stdin = slice_of(&parsed["stdin"], &payload);
    let run = RunState {
        index,
        payload: Arc::new(payload),
        stdin,
        overlay: Arc::new(Mutex::new(HashMap::new())),
        builtins: Arc::new(Mutex::new(HashMap::new())),
    };
    let control = Arc::new(ChildControl::default());
    parent.children.lock().unwrap().insert(run_id, control.clone());
    let (reply, rx) = oneshot::channel();
    let job = Job {
        ctx_kind: kind,
        sandbox_id: parent.sandbox_id.clone(),
        command: parent.command.clone(),
        budget_mem: parent.budget.limit() / MIB,
        run,
        meta,
        control,
        reply,
        permit,
    };
    match kind {
        Kind::Node => {
            eng.stats.node_runs.fetch_add(1, Ordering::Relaxed);
            node_dispatch(job);
        }
        _ => {
            eng.stats.python_runs.fetch_add(1, Ordering::Relaxed);
            python_dispatch(job);
        }
    }
    let out = rx.await.unwrap_or_else(|_| pack_error(1, "runtime: the run's thread stopped\n"));
    parent.children.lock().unwrap().remove(&run_id);
    out
}

fn slice_of(v: &Value, payload: &[u8]) -> Vec<u8> {
    if let Some(a) = v.as_array() {
        let off = a.first().and_then(Value::as_u64).unwrap_or(0) as usize;
        let len = a.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
        return payload.get(off..off + len).map(|s| s.to_vec()).unwrap_or_default();
    }
    Vec::new()
}

fn parse_index(parsed: &Value) -> HashMap<String, FileRef> {
    let mut index = HashMap::new();
    if let Some(obj) = parsed["index"].as_object() {
        for (path, entry) in obj {
            if entry.get("kind").and_then(Value::as_str) != Some("file") {
                continue;
            }
            if let Some(sha) = entry.get("sha").and_then(Value::as_str) {
                index.insert(path.clone(), FileRef::Blob(sha.to_string()));
            } else if let Some(at) = entry.get("data").and_then(Value::as_array) {
                let off = at.first().and_then(Value::as_u64).unwrap_or(0) as usize;
                let len = at.get(1).and_then(Value::as_u64).unwrap_or(0) as usize;
                index.insert(path.clone(), FileRef::Inline(off, len));
            }
        }
    }
    index
}

// node pool -------------------------------------------------------------------------------------------------------

type Ready = std::sync::mpsc::Sender<Job>;
static NODE_POOL: Mutex<VecDeque<Ready>> = Mutex::new(VecDeque::new());
static NODE_BOOTING: AtomicUsize = AtomicUsize::new(0);

pub fn node_refill() {
    let want = engine().cfg.node_pool;
    let have = NODE_POOL.lock().unwrap().len() + NODE_BOOTING.load(Ordering::SeqCst);
    for _ in have..want {
        NODE_BOOTING.fetch_add(1, Ordering::SeqCst);
        std::thread::Builder::new().name("kt-node".into()).stack_size(8 * MIB).spawn(|| node_thread(None)).expect("node thread");
    }
}

fn node_dispatch(job: Job) {
    if job.budget_mem == DEFAULT_MEMORY_MIB {
        let ready = NODE_POOL.lock().unwrap().pop_front();
        node_refill();
        if let Some(tx) = ready {
            if let Err(e) = tx.send(job) {
                return node_dispatch(e.0);
            }
            return;
        }
    }
    std::thread::Builder::new().name("kt-node".into()).stack_size(8 * MIB).spawn(move || node_thread(Some(job))).expect("node thread");
}

fn node_thread(job: Option<Job>) {
    run_thread(Kind::Node, job, &NODE_POOL, &NODE_BOOTING);
}

// python pool -----------------------------------------------------------------------------------------------------

static PY_POOL: Mutex<VecDeque<Ready>> = Mutex::new(VecDeque::new());
static PY_BOOTING: AtomicUsize = AtomicUsize::new(0);
pub static PY_READY: AtomicUsize = AtomicUsize::new(0);

pub fn python_refill() {
    let want = engine().cfg.python_pool;
    let have = PY_POOL.lock().unwrap().len() + PY_BOOTING.load(Ordering::SeqCst);
    for _ in have..want {
        PY_BOOTING.fetch_add(1, Ordering::SeqCst);
        std::thread::Builder::new().name("kt-python".into()).stack_size(8 * MIB).spawn(|| python_thread(None)).expect("python thread");
    }
}

fn python_dispatch(job: Job) {
    if job.budget_mem == DEFAULT_MEMORY_MIB {
        let ready = PY_POOL.lock().unwrap().pop_front();
        if let Some(tx) = ready {
            PY_READY.fetch_sub(1, Ordering::Relaxed);
            python_refill();
            if let Err(e) = tx.send(job) {
                return python_dispatch(e.0);
            }
            return;
        }
        python_refill();
    }
    std::thread::Builder::new().name("kt-python".into()).stack_size(8 * MIB).spawn(move || python_thread(Some(job))).expect("python thread");
}

fn python_thread(job: Option<Job>) {
    run_thread(Kind::Python, job, &PY_POOL, &PY_BOOTING);
}

/// Shared body for a node/python worker thread: make an isolate, prepare it (python boots Pyodide), then run one job
/// (from the pool or the one passed), and reply. The isolate is dropped at the end: one run per isolate.
fn run_thread(kind: Kind, mut job: Option<Job>, pool: &'static Mutex<VecDeque<Ready>>, booting: &'static AtomicUsize) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("run tokio");
    let _entered = rt.enter();
    let mem = job.as_ref().map(|j| j.budget_mem).unwrap_or(DEFAULT_MEMORY_MIB);
    let mut live = new_live(kind, mem);
    let prepared = if kind == Kind::Python { python_boot(&mut live, &rt) } else { Ok(()) };
    let pooled = job.is_none();
    if pooled {
        booting.fetch_sub(1, Ordering::SeqCst);
        if let Err(e) = prepared {
            tracing::warn!("{} pool worker failed to start: {e:#}", kind.init_arg());
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        pool.lock().unwrap().push_back(tx);
        if kind == Kind::Python {
            PY_READY.fetch_add(1, Ordering::Relaxed);
        }
        job = match rx.recv() {
            Ok(j) => Some(j),
            Err(_) => return,
        };
    }
    let job = job.unwrap();
    if let Err(e) = prepared {
        let _ = job.reply.send(pack_error(1, &format!("{}: failed to start: {e:#}\n", kind.init_arg())));
        return;
    }
    run_one(&mut live, kind, job, &rt);
}

fn python_boot(live: &mut Live, rt: &tokio::runtime::Runtime) -> Result<()> {
    let args = json!({ "pyodide": engine().cfg.pyodide.display().to_string() }).to_string();
    let command = Command::new(Duration::from_secs(60), Duration::from_secs(90));
    bind(&mut live.rt, Ctx::new(Kind::Python, Arc::from("boot"), command.clone(), live.budget.clone(), Default::default()));
    let guard = watch(live.handle.clone(), command, live.budget.clone());
    let r = rt.block_on(async {
        load_pyodide_modules(&mut live.rt).await?;
        call(&mut live.rt, "boot", &[&args]).await.map(|_| ())
    });
    drop(guard);
    r.map_err(|e| anyhow!("python boot: {e}"))
}

/// Load Pyodide's two ES modules (static imports, host-driven) and leave their exports on globalThis for boot().
async fn load_pyodide_modules(rt: &mut JsRuntime) -> Result<()> {
    let base = engine().cfg.pyodide.display().to_string();
    let source = format!(
        "import {{ loadPyodide }} from \"file://{base}/pyodide.mjs\";\nimport createPyodideModule from \"file://{base}/pyodide.asm.mjs\";\nglobalThis.__pyodideLoad = loadPyodide;\nglobalThis.__pyodideModule = createPyodideModule;\n"
    );
    let spec = ModuleSpecifier::parse("file:///kantel/pyodide-boot.mjs")?;
    let id = rt.load_main_es_module_from_code(&spec, source).await.map_err(|e| anyhow!("{e}"))?;
    let eval = rt.mod_evaluate(id);
    rt.run_event_loop(PollEventLoopOptions::default()).await.map_err(|e| anyhow!("{e}"))?;
    eval.await.map_err(|e| anyhow!("{e}"))
}

fn run_one(live: &mut Live, kind: Kind, job: Job, rt: &tokio::runtime::Runtime) {
    live.budget.reset_exceeded();
    let Job { sandbox_id, command, run, meta, control, reply, permit, .. } = job;
    let what = kind.init_arg();
    let mem = live.budget.limit() / MIB;
    if kind == Kind::Node {
        // Make the run's files reachable to the module loader on this thread (overlay and builtins are shared, so
        // the loader sees what the run writes and which built-ins exist).
        set_node_env(run.overlay.clone(), run.builtins.clone(), run.index.clone(), run.payload.clone());
    }
    {
        let ctx = Ctx::new(kind, sandbox_id, command.clone(), live.budget.clone(), Default::default());
        let st = live.rt.op_state();
        let mut st = st.borrow_mut();
        st.put(ctx);
        st.put(run);
        st.put(RunResult(None));
    }
    let guard = watch(live.handle.clone(), command.clone(), live.budget.clone());
    control.register(guard.watched().clone());
    let result = rt.block_on(async {
        let fut = async {
            match kind {
                Kind::Node => run_node(&mut live.rt, &meta).await,
                _ => run_python(&mut live.rt, &meta).await,
            }
        };
        tokio::select! {
            biased;
            _ = guard.watched().tripped() => None,
            r = fut => Some(r),
        }
    });
    let term = guard.watched().term();
    drop(guard);
    drop(permit);
    // Clear any terminate flag before this isolate is dropped (V8 aborts if a realm is torn down mid-termination).
    live.rt.v8_isolate().cancel_terminate_execution();
    if kind == Kind::Node {
        clear_node_env();
    }
    let out = match (result, term) {
        (_, Some(t)) if t != Term::Exit => {
            engine().stats.count_term(t);
            pack_error(t.exit_code(), &t.message(what, mem, command.cpu_limit, command.wall))
        }
        (Some(Ok(())), _) => take_result(&mut live.rt).unwrap_or_else(|| pack_error(1, &format!("{what}: no result\n"))),
        (Some(Err(e)), _) => take_result(&mut live.rt).unwrap_or_else(|| pack_error(1, &format!("{what}: {e}\n"))),
        (None, _) => pack_error(1, &format!("{what}: stopped\n")),
    };
    let _ = reply.send(out);
    // The isolate is dropped by the caller when this function returns; its in-flight call (if any) was abandoned
    // unpolled above, so the drop is safe.
}

async fn run_node(rt: &mut JsRuntime, meta: &str) -> Result<()> {
    // start() returns {} or {esm, print?} — load the ES module it names, then finish().
    let start = call(rt, "start", &[meta]).await?;
    let parsed: Value = serde_json::from_str(&start).unwrap_or(json!({}));
    let mut err: Option<String> = None;
    if let Some(spec) = parsed["esm"].as_str() {
        if let Err(e) = load_main_module(rt, spec).await {
            err = Some(e);
        }
    }
    if err.is_none() {
        if let Err(e) = rt.run_event_loop(PollEventLoopOptions::default()).await {
            err = Some(e.to_string());
        }
    }
    let err_json = serde_json::to_string(&err).unwrap_or("null".into());
    rt.execute_script("kt:finish", format!("globalThis.__kantelEntry.finish({err_json})")).map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

async fn load_main_module(rt: &mut JsRuntime, spec: &str) -> std::result::Result<(), String> {
    let specifier = ModuleSpecifier::parse(spec).map_err(|e| e.to_string())?;
    let id = rt.load_main_es_module(&specifier).await.map_err(|e| e.to_string())?;
    let receiver = rt.mod_evaluate(id);
    rt.run_event_loop(PollEventLoopOptions::default()).await.map_err(|e| e.to_string())?;
    receiver.await.map_err(|e| e.to_string())
}

async fn run_python(rt: &mut JsRuntime, meta: &str) -> Result<()> {
    call(rt, "run", &[meta]).await.map(|_| ())
}

fn take_result(rt: &mut JsRuntime) -> Option<Vec<u8>> {
    rt.op_state().borrow_mut().try_take::<RunResult>().and_then(|r| r.0)
}

// ---------------------------------------------------------------------------------------------------------------
// Module loaders

/// python: resolves and loads only Pyodide's own ES modules, from `--assets` (op_read_asset enforces the directory).
struct AssetModuleLoader;
impl ModuleLoader for AssetModuleLoader {
    fn resolve(&self, specifier: &str, referrer: &str, _kind: ResolutionKind) -> ModuleResolveResponse {
        deno_core::resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }
    fn load(&self, specifier: &ModuleSpecifier, _referrer: Option<&deno_core::ModuleLoadReferrer>, _options: deno_core::ModuleLoadOptions) -> ModuleLoadResponse {
        let specifier = specifier.clone();
        let path = match specifier.to_file_path() {
            Ok(p) => p,
            Err(_) => return ModuleLoadResponse::Sync(Err(JsErrorBox::generic("python modules load only from file://"))),
        };
        let base = &engine().cfg.pyodide;
        let code = match std::fs::canonicalize(&path) {
            Ok(canon) if canon.starts_with(base) => std::fs::read_to_string(&canon),
            _ => return ModuleLoadResponse::Sync(Err(JsErrorBox::generic("python module outside the assets directory"))),
        };
        match code {
            Ok(code) => ModuleLoadResponse::Sync(Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), &specifier, None))),
            Err(e) => ModuleLoadResponse::Sync(Err(JsErrorBox::generic(e.to_string()))),
        }
    }
}

const BUILTIN_SCHEME: &str = "ktbuiltin:";

/// node: resolves the run's own files (file://) and node built-ins. Built-ins and CommonJS files imported from ESM
/// become synthetic ES modules; the files come from the run (overlay first, then the manifest) through the op state
/// — so this loader reaches them through a thread-local the run sets.
struct NodeModuleLoader;
thread_local! {
    static NODE_ENV: RefCell<Option<NodeEnv>> = const { RefCell::new(None) };
}
struct NodeEnv {
    overlay: Arc<Mutex<HashMap<String, Option<Vec<u8>>>>>,
    builtins: Arc<Mutex<HashMap<String, Vec<String>>>>,
    /// The run's manifest files, by manifest-relative path, read lazily (ESM imports only the files it names).
    index: HashMap<String, FileRef>,
    payload: Arc<Vec<u8>>,
}

impl NodeModuleLoader {
    fn new() -> NodeModuleLoader {
        NodeModuleLoader
    }
}

/// Make the run's files reachable to the loader on this thread (called before the module graph loads).
fn set_node_env(
    overlay: Arc<Mutex<HashMap<String, Option<Vec<u8>>>>>,
    builtins: Arc<Mutex<HashMap<String, Vec<String>>>>,
    index: HashMap<String, FileRef>,
    payload: Arc<Vec<u8>>,
) {
    NODE_ENV.with(|e| *e.borrow_mut() = Some(NodeEnv { overlay, builtins, index, payload }));
}

fn clear_node_env() {
    NODE_ENV.with(|e| *e.borrow_mut() = None);
}

impl ModuleLoader for NodeModuleLoader {
    fn resolve(&self, specifier: &str, referrer: &str, _kind: ResolutionKind) -> ModuleResolveResponse {
        let bare = specifier.strip_prefix("node:").unwrap_or(specifier);
        let is_builtin = NODE_ENV.with(|e| e.borrow().as_ref().is_some_and(|env| env.builtins.lock().unwrap().contains_key(bare)));
        if specifier.starts_with("node:") || is_builtin {
            return ModuleSpecifier::parse(&format!("{BUILTIN_SCHEME}{bare}")).map_err(|e| JsErrorBox::generic(e.to_string()));
        }
        deno_core::resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }
    fn load(&self, specifier: &ModuleSpecifier, _referrer: Option<&deno_core::ModuleLoadReferrer>, _options: deno_core::ModuleLoadOptions) -> ModuleLoadResponse {
        ModuleLoadResponse::Sync(node_load(specifier))
    }
}

fn node_load(specifier: &ModuleSpecifier) -> std::result::Result<ModuleSource, JsErrorBox> {
    let spec = specifier.as_str();
    if let Some(name) = spec.strip_prefix(BUILTIN_SCHEME) {
        let exports = NODE_ENV.with(|e| e.borrow().as_ref().and_then(|env| env.builtins.lock().unwrap().get(name).cloned()).unwrap_or_default());
        let named: String = exports
            .iter()
            .map(|n| format!("export const {n} = __m.{n};\n"))
            .collect();
        let code = format!(
            "const __m = globalThis[Symbol.for('kantel.node.builtin')]({});\nexport default __m;\n{named}",
            lit(name)
        );
        return Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), specifier, None));
    }
    let path = specifier.to_file_path().map_err(|_| JsErrorBox::generic(format!("cannot load {spec}")))?;
    let path_str = path.to_string_lossy().to_string();
    if path_str.ends_with(".wasm") {
        return Err(JsErrorBox::generic("importing .wasm modules isn't available in an isolate's node"));
    }
    let bytes = NODE_ENV.with(|e| -> Option<Vec<u8>> {
        let env = e.borrow();
        let env = env.as_ref()?;
        if let Some(entry) = env.overlay.lock().unwrap().get(&path_str) {
            return entry.clone();
        }
        // Manifest files live under /workspace; the loader's absolute path maps to a manifest-relative key.
        let rel = path_str.strip_prefix("/workspace/")?;
        resolve_file(&env.index, &env.payload, rel).ok()
    });
    let Some(bytes) = bytes else {
        return Err(JsErrorBox::generic(format!("Cannot find module '{path_str}'")));
    };
    let text = String::from_utf8_lossy(&bytes).to_string();
    if path_str.ends_with(".json") {
        let code = format!("export default {};", if text.trim().is_empty() { "null" } else { text.trim() });
        return Ok(ModuleSource::new(ModuleType::Json, ModuleSourceCode::String(code.into()), specifier, None));
    }
    let is_ts = path_str.ends_with(".ts") || path_str.ends_with(".mts") || path_str.ends_with(".cts");
    let source = if is_ts {
        crate::transpile::strip_types(&path_str, text).map_err(|e| JsErrorBox::generic(e.to_string()))?
    } else {
        text
    };
    // A CommonJS file imported from ESM: hand its module.exports back as the default export (named imports from a
    // CommonJS module aren't resolved — a known gap, see README).
    let cjs = path_str.ends_with(".cjs") || path_str.ends_with(".cts") || (!path_str.ends_with(".mjs") && !path_str.ends_with(".mts") && !looks_like_esm(&source));
    if cjs {
        let code = format!("const __m = globalThis[Symbol.for('kantel.node.require')]({});\nexport default (__m && __m.default !== undefined && __m.__esModule) ? __m.default : __m;", lit(&path_str));
        return Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(code.into()), specifier, None));
    }
    Ok(ModuleSource::new(ModuleType::JavaScript, ModuleSourceCode::String(source.into()), specifier, None))
}

fn looks_like_esm(source: &str) -> bool {
    // A cheap check for top-level ESM syntax; good enough to tell a .js module from a CommonJS one.
    for line in source.lines() {
        let line = line.trim_start();
        if line.starts_with("import ") || line.starts_with("import(") || line.starts_with("import{") || line.starts_with("export ") || line.starts_with("export{") || line.starts_with("export*") || line.starts_with("export default") {
            return true;
        }
    }
    source.contains("import.meta")
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot

fn build_snapshot() -> &'static [u8] {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("snapshot tokio");
    let _entered = rt.enter();
    let mut snap_rt = JsRuntimeForSnapshot::new(RuntimeOptions { extensions: vec![kt::init()], ..Default::default() });
    snap_rt.execute_script("kt:guest", GUEST).unwrap_or_else(|e| panic!("guest bundle failed to load: {e}"));
    Box::leak(snap_rt.snapshot())
}

// Keep the module private helpers used by other modules.
pub use self::snapshot_sink_helpers::*;
mod snapshot_sink_helpers {
    use super::*;

    /// Build and run the Pyodide snapshot: one isolate that boots Pyodide with _makeSnapshot and writes the bytes.
    pub fn make_python_snapshot(out: &std::path::Path) -> Result<()> {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let _entered = rt.enter();
        let mut live = new_live(Kind::Python, 1024);
        let sink = Rc::new(RefCell::new(None));
        {
            let st = live.rt.op_state();
            let mut st = st.borrow_mut();
            st.put(Ctx::new(Kind::Python, Arc::from("snapshot"), Command::new(Duration::from_secs(120), Duration::from_secs(180)), live.budget.clone(), Default::default()));
            st.put(SnapshotSink(sink.clone()));
        }
        let args = json!({ "pyodide": engine().cfg.pyodide.display().to_string(), "makeSnapshot": true }).to_string();
        rt.block_on(async {
            load_pyodide_modules(&mut live.rt).await?;
            call(&mut live.rt, "boot", &[&args]).await
        })
        .map_err(|e| anyhow!("boot for snapshot: {e}"))?;
        let bytes = sink.borrow_mut().take().ok_or_else(|| anyhow!("snapshot was not produced"))?;
        std::fs::write(out, &bytes)?;
        Ok(())
    }
}
