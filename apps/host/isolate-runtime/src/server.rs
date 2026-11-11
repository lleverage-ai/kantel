//! kantel-host's isolate protocol: GET /healthz, POST /warm, /load, /exec, /unload. The shapes match
//! apps/host/isolate/src/host.ts; see CONTRACT.md.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::config::{
    Config, DEFAULT_MEMORY_MIB, DEFAULT_WALL, MAX_MEMORY_MIB, MAX_WALL, MIN_MEMORY_MIB,
};
use crate::isolate::{PY_READY, ShellCmd, ShellHandle, engine, spawn_shell};
use crate::limits::Command;

struct Session {
    handle: Arc<ShellHandle>,
    last_used: Instant,
    /// Commands running in this sandbox now; a session is idle (evictable) only when this is zero.
    inflight: Arc<AtomicUsize>,
}

/// Keeps a session counted as in-flight for a command's lifetime, so it isn't evicted while executing, and marks it
/// used when the command ends (review finding H6).
struct Busy {
    inflight: Arc<AtomicUsize>,
    sessions: Arc<std::sync::Mutex<HashMap<String, Session>>>,
    id: String,
}
impl Drop for Busy {
    fn drop(&mut self) {
        self.inflight.fetch_sub(1, Ordering::SeqCst);
        if let Some(s) = self.sessions.lock().unwrap().get_mut(&self.id) {
            s.last_used = Instant::now();
        }
    }
}

pub struct App {
    sessions: Arc<std::sync::Mutex<HashMap<String, Session>>>,
    pool: std::sync::Mutex<Vec<ShellHandle>>,
    want: AtomicUsize,
    cfg: Config,
}

impl App {
    pub fn new(cfg: Config) -> Arc<App> {
        Arc::new(App {
            sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
            pool: std::sync::Mutex::new(Vec::new()),
            want: AtomicUsize::new(cfg.pool),
            cfg,
        })
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/warm", post(warm))
        .route("/load", post(load))
        .route("/exec", post(exec))
        .route("/reseed", post(reseed))
        .route("/unload", post(unload))
        .layer(axum::extract::DefaultBodyLimit::max(128 << 20))
        .with_state(app)
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn rss_mib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse::<u64>().ok())
        })
        .map(|kib| kib / 1024)
        .unwrap_or(0)
}

async fn healthz(State(app): State<Arc<App>>) -> Json<Value> {
    expire(&app);
    let stats = &engine().stats;
    Json(json!({
        "ok": true,
        "want": app.want.load(Ordering::Relaxed),
        "idle": app.pool.lock().unwrap().len(),
        "sessions": app.sessions.lock().unwrap().len(),
        "runtime": "deno_core",
        "version": env!("CARGO_PKG_VERSION"),
        "v8": deno_core::v8::V8::get_version(),
        "warm": is_warm(&app),
        "v8Sandbox": crate::v8_sandbox_enabled(),
        "transports": ["tcp", "unix"],
        "capabilities": { "javascript": true, "python": true },
        "memoryEnforced": true,
        "pythonReady": PY_READY.load(Ordering::Relaxed),
        "maxRuns": app.cfg.max_runs,
        "rssMiB": rss_mib(),
        "counters": {
            "nodeRuns": stats.node_runs.load(Ordering::Relaxed),
            "pythonRuns": stats.python_runs.load(Ordering::Relaxed),
            "rebuilds": stats.rebuilds.load(Ordering::Relaxed),
            "terminations": {
                "cpu": stats.terminations_cpu.load(Ordering::Relaxed),
                "memory": stats.terminations_memory.load(Ordering::Relaxed),
                "wall": stats.terminations_wall.load(Ordering::Relaxed),
            },
        },
    }))
}

/// Pre-load the shell pool to the configured size (called at start-up).
pub fn warm_pool(app: &App) {
    refill_pool(app);
}

fn refill_pool(app: &App) {
    let want = app.want.load(Ordering::Relaxed);
    let mut pool = app.pool.lock().unwrap();
    while pool.len() < want {
        pool.push(spawn_shell(Arc::from(""), DEFAULT_MEMORY_MIB, true));
    }
}

async fn warm(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Json<Value> {
    let size = body["size"].as_u64().unwrap_or(0).min(64) as usize;
    app.want.store(size, Ordering::Relaxed);
    let a = app.clone();
    tokio::task::spawn_blocking(move || refill_pool(&a))
        .await
        .ok();
    Json(json!({ "ok": true, "idle": app.pool.lock().unwrap().len(), "want": size }))
}

/// Drop the isolates of sessions idle past the configured time. Only idle (no in-flight command) sessions are
/// evicted — never one that is executing, whose Arc would otherwise keep the thread alive uncounted (finding H6).
fn expire(app: &App) {
    let now = Instant::now();
    let idle = engine().cfg.idle;
    let mut sessions = app.sessions.lock().unwrap();
    sessions.retain(|_, s| {
        s.inflight.load(Ordering::SeqCst) > 0 || now.duration_since(s.last_used) < idle
    });
}

/// Evict the least-recently-used idle session to make room (for the `--max-sandboxes` cap). Returns false if every
/// session is busy.
fn evict_one_idle(sessions: &mut HashMap<String, Session>) -> bool {
    let victim = sessions
        .iter()
        .filter(|(_, s)| s.inflight.load(Ordering::SeqCst) == 0)
        .min_by_key(|(_, s)| s.last_used)
        .map(|(k, _)| k.clone());
    match victim {
        Some(id) => {
            sessions.remove(&id);
            true
        }
        None => false,
    }
}

/// The request's memoryMiB, or a 400 response (boxed: a Response is large, and the error path is rare).
fn clamp_memory(body: &Value) -> Result<usize, Box<Response>> {
    match &body["memoryMiB"] {
        Value::Null => Ok(DEFAULT_MEMORY_MIB),
        v => match v.as_u64() {
            Some(m) if m >= MIN_MEMORY_MIB as u64 && m <= MAX_MEMORY_MIB as u64 => Ok(m as usize),
            _ => Err(Box::new(err(
                StatusCode::BAD_REQUEST,
                format!("memoryMiB must be an integer {MIN_MEMORY_MIB}–{MAX_MEMORY_MIB}"),
            ))),
        },
    }
}

fn sandbox_id(body: &Value) -> Option<String> {
    body["sandboxId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .map(String::from)
}

/// The session's isolate: its own, a pooled one (default memory only), or a fresh one. Returns a 503 error response
/// when a new sandbox would exceed `--max-sandboxes` and every live sandbox is busy (kantel-host can retry).
fn assign(
    app: &App,
    id: &str,
    mem_mib: usize,
) -> std::result::Result<(Arc<ShellHandle>, &'static str), Box<Response>> {
    expire(app);
    let mut sessions = app.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(id) {
        s.last_used = Instant::now();
        return Ok((s.handle.clone(), "session"));
    }
    if sessions.len() >= app.cfg.max_sandboxes && !evict_one_idle(&mut sessions) {
        return Err(Box::new(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "sandbox capacity reached on this host; retry", "retryable": true })),
            )
                .into_response(),
        ));
    }
    let (handle, hit) = if mem_mib == DEFAULT_MEMORY_MIB {
        match app.pool.lock().unwrap().pop() {
            Some(mut h) => {
                h.sandbox_id = Arc::from(id);
                (h, "pool")
            }
            None => (spawn_shell(Arc::from(id), mem_mib, false), "miss"),
        }
    } else {
        (spawn_shell(Arc::from(id), mem_mib, false), "miss")
    };
    let handle = Arc::new(handle);
    sessions.insert(
        id.to_string(),
        Session {
            handle: handle.clone(),
            last_used: Instant::now(),
            inflight: Arc::new(AtomicUsize::new(0)),
        },
    );
    Ok((handle, hit))
}

/// Mark a session in-flight for a command's lifetime (so it isn't evicted) and get its handle.
fn begin(app: &App, id: &str) -> Option<Busy> {
    let sessions = app.sessions.lock().unwrap();
    let s = sessions.get(id)?;
    s.inflight.fetch_add(1, Ordering::SeqCst);
    Some(Busy {
        inflight: s.inflight.clone(),
        sessions: app.sessions.clone(),
        id: id.to_string(),
    })
}

async fn load(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Response {
    let started = Instant::now();
    let Some(id) = sandbox_id(&body) else {
        return err(StatusCode::BAD_REQUEST, "sandboxId required");
    };
    let mem_mib = match clamp_memory(&body) {
        Ok(m) => m,
        Err(r) => return *r,
    };
    let (handle, hit) = match assign(&app, &id, mem_mib) {
        Ok(v) => v,
        Err(r) => return *r,
    };
    let _busy = begin(&app, &id);
    let (reply, rx) = tokio::sync::oneshot::channel();
    if handle.tx.send(ShellCmd::Load { mem_mib, reply }).is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "isolate thread stopped");
    }
    let _ = rx.await;
    if hit == "pool" {
        let a = app.clone();
        tokio::task::spawn_blocking(move || refill_pool(&a));
    }
    Json(json!({ "ok": true, "hit": hit, "ms": started.elapsed().as_secs_f64() * 1e3, "memoryMiB": mem_mib })).into_response()
}

async fn exec(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Response {
    let started = Instant::now();
    let Some(id) = sandbox_id(&body) else {
        return err(StatusCode::BAD_REQUEST, "sandboxId required");
    };
    let mem_mib = match clamp_memory(&body) {
        Ok(m) => m,
        Err(r) => return *r,
    };
    let (handle, hit) = match assign(&app, &id, mem_mib) {
        Ok(v) => v,
        Err(r) => return *r,
    };
    let _busy = begin(&app, &id);
    let wall = body["timeoutMs"]
        .as_u64()
        .filter(|t| *t > 0)
        .map(|t| Duration::from_millis(t).min(MAX_WALL))
        .unwrap_or(DEFAULT_WALL);
    let manifest = body.get("manifest").cloned().unwrap_or(json!({}));
    let request = json!({
        "command": body["command"].as_str().unwrap_or(""),
        "cwd": body["cwd"],
        "env": body["env"],
        "manifest": manifest,
    });
    let command = Command::new(engine().cfg.cpu, wall);
    let (reply, rx) = tokio::sync::oneshot::channel();
    let send = ShellCmd::Exec {
        sandbox_id: Arc::from(id.as_str()),
        body: request.to_string(),
        manifest,
        command,
        reply,
    };
    if handle.tx.send(send).is_err() {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "isolate thread stopped");
    }
    match rx.await {
        Ok(mut value) => {
            if value.get("error").is_some() {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(value)).into_response();
            }
            value["hit"] = json!(hit);
            value["ms"] = json!(started.elapsed().as_secs_f64() * 1e3);
            Json(value).into_response()
        }
        Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "isolate thread stopped"),
    }
}

/// True once the pools are full and start-up work is done, so W3 can take the template snapshot (it waits for this).
fn is_warm(app: &App) -> bool {
    let idle = app.pool.lock().unwrap().len();
    idle >= app.want.load(Ordering::Relaxed)
        && PY_READY.load(Ordering::Relaxed) >= engine().cfg.python_pool
}

/// kantel-host calls this right after restoring a VM from the template snapshot. Every VM restored from one template
/// starts with the same V8 and Pyodide RNG state, because the pooled isolates were created before the snapshot. We
/// drop every idle pooled and session isolate so they are rebuilt fresh in this VM: the process entropy source (set
/// in main) seeds each new isolate's Math.random from the OS, so the VMs diverge. (Python's `random` is reseeded per
/// run in the guest; `entropy` is accepted for the contract and mixed into the OS-seeded pool.)
async fn reseed(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Json<Value> {
    if let Some(hex) = body["entropy"].as_str()
        && let Ok(bytes) = hex::decode(hex)
    {
        crate::seed_entropy(&bytes);
    }
    app.sessions.lock().unwrap().clear();
    app.pool.lock().unwrap().clear();
    // node's and python's ready isolates too: otherwise each restored VM's first runs share their Math.random.
    crate::isolate::renew_ready_pools();
    let a = app.clone();
    tokio::task::spawn_blocking(move || refill_pool(&a))
        .await
        .ok();
    Json(json!({ "ok": true, "idle": app.pool.lock().unwrap().len() }))
}

/// Not in the host protocol: forget a sandbox (its isolate thread ends when its handle drops). Used by tests and the
/// memory benchmark.
async fn unload(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Json<Value> {
    let removed = sandbox_id(&body)
        .and_then(|id| app.sessions.lock().unwrap().remove(&id))
        .is_some();
    Json(json!({ "ok": removed }))
}
