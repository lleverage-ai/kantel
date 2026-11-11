//! Per-isolate limits: one memory limit (V8 heap, ArrayBuffers and wasm memory together), a CPU budget per command
//! (an isolate's own thread CPU, plus its children's, against one total) and a wall-clock deadline.
//!
//! - Memory: [`Budget`] holds the sum of the V8 heap (recorded after every GC by a GC epilogue on the isolate's own
//!   thread), ArrayBuffer backing stores and wasm memory to memoryMiB: a request for buffers or wasm memory that
//!   would take the sum past it is refused, and the epilogue stops the isolate when the sum is over it.
//! - Heap: the V8 heap limit stays at memoryMiB as the backstop between GCs; the near-heap-limit callback terminates
//!   the isolate there.
//! - Wasm memory: reserved in the same [`Budget`] by the guest's wasm guard (op_kt_wasm_reserve).
//! - The watchdog, one thread for the process, ticks every few milliseconds over every running command: it adds
//!   each isolate thread's CPU time to its command's total and terminates past the budget or the deadline. It reads
//!   only atomics and calls terminate_execution (thread-safe): touching V8 state from another thread aborts the
//!   process, which is why the heap is read in the GC epilogue instead.

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use deno_core::v8;

pub const MIB: usize = 1024 * 1024;
/// Heap V8 is given while a terminated execution unwinds (the isolate is discarded afterwards).
const UNWIND_HEADROOM: usize = 64 * MIB;
const TICK: Duration = Duration::from_millis(5);

/// Why a command was stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Term {
    Memory,
    Cpu,
    Wall,
    /// Cancelled by the shell (just-bash's `timeout`): not a limit.
    Cancel,
    /// The script called process.exit(): not a limit either.
    Exit,
}

impl Term {
    pub fn name(self) -> &'static str {
        match self {
            Term::Memory => "memory",
            Term::Cpu => "cpu",
            Term::Wall => "wall",
            Term::Cancel => "cancel",
            Term::Exit => "exit",
        }
    }
    pub fn exit_code(self) -> i64 {
        match self {
            Term::Memory => 137,
            Term::Cpu | Term::Wall => 152,
            Term::Cancel => 124,
            Term::Exit => 0,
        }
    }
    fn code(self) -> u8 {
        match self {
            Term::Memory => 1,
            Term::Cpu => 2,
            Term::Wall => 3,
            Term::Cancel => 4,
            Term::Exit => 5,
        }
    }
    fn from_code(c: u8) -> Option<Term> {
        Some(match c {
            1 => Term::Memory,
            2 => Term::Cpu,
            3 => Term::Wall,
            4 => Term::Cancel,
            5 => Term::Exit,
            _ => return None,
        })
    }
    pub fn message(self, what: &str, mem_mib: usize, cpu: Duration, wall: Duration) -> String {
        match self {
            Term::Memory => format!("{what}: stopped: exceeded the memory limit ({mem_mib} MiB)\n"),
            Term::Cpu => format!(
                "{what}: stopped: exceeded the CPU limit ({} ms)\n",
                cpu.as_millis()
            ),
            Term::Wall => format!("{what}: stopped: timed out after {} ms\n", wall.as_millis()),
            Term::Cancel => format!("{what}: stopped\n"),
            Term::Exit => String::new(),
        }
    }
}

/// One isolate's memory: everything it holds counts against one limit, its memoryMiB.
///
/// - `used`: bytes this budget handed out — ArrayBuffer backing stores (stock build: the Rust allocator below), wasm
///   memory (the guest's wasm guard, op_kt_wasm_reserve) and host-side bodies being collected for it ([`Charge`]).
/// - In a `v8-sandbox` build, ArrayBuffer bytes are allocated by W2's C++ budget allocator inside the V8 sandbox and
///   counted there (`kantel__BudgetAllocator__Used`), not in `used`.
/// - `heap`: the V8 heap in use, recorded by [`gc_epilogue`] after every GC on the isolate's own thread (sampling it
///   from another thread aborts V8).
///
/// A request for more (`try_take`, the stock build's allocator) is refused when heap + buffers + wasm would pass the
/// limit, and the GC epilogue stops the isolate when the total is over it, so heap growth after the buffers are taken
/// is caught as well — and, in a sandbox build, buffers taken on top of the heap (the C++ allocator holds them to
/// memoryMiB on their own; V8 collects garbage as they grow, which runs the epilogue). The heap's own limit stays at
/// memoryMiB (the near-heap-limit callback) as the backstop between GCs.
///
/// [`Charge`]: crate::bridges::Charge
pub struct Budget {
    limit: AtomicUsize,
    used: AtomicUsize,
    /// V8 heap in use at the last GC (`used_heap_size`).
    heap: AtomicUsize,
    /// GCs seen, so a refusal blamed on the heap can be retried once after V8 has collected.
    gcs: AtomicU64,
    /// `gcs` when an allocation was last refused because of the heap figure (NO_REFUSAL if none is pending).
    refused_at: AtomicU64,
    /// A full GC found the total over the limit; over again at the next GC (by whose start V8 has freed the
    /// ArrayBuffers that one found dead), the isolate is stopped.
    suspect: AtomicBool,
    /// Set while a command runs (between `watch` and the guard's drop): only then may the GC epilogue terminate. GC while an isolate is torn down must not re-arm termination (V8 aborts).
    armed: AtomicBool,
    /// Set when this budget refused an allocation; the isolate is being terminated.
    pub exceeded: AtomicBool,
    handle: OnceLock<v8::IsolateHandle>,
    /// The C++ budget allocator's ArrayBuffer bytes (sandbox build): its own limit is memoryMiB, so the sum is checked
    /// here. Held so the allocator outlives every reader of the budget (a body still being collected on an I/O
    /// thread may outlive the isolate).
    #[cfg(feature = "v8-sandbox")]
    buffers: OnceLock<SandboxAllocator>,
}

const NO_REFUSAL: u64 = u64::MAX;

/// Why a request was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Over the limit with what this budget counts directly: no collection can help.
    Over,
    /// Over only once the heap at the last GC is added: a GC may free enough.
    Heap,
}

impl Budget {
    pub fn new(limit: usize) -> Arc<Budget> {
        Arc::new(Budget {
            limit: AtomicUsize::new(limit),
            used: AtomicUsize::new(0),
            heap: AtomicUsize::new(0),
            gcs: AtomicU64::new(0),
            refused_at: AtomicU64::new(NO_REFUSAL),
            suspect: AtomicBool::new(false),
            armed: AtomicBool::new(false),
            exceeded: AtomicBool::new(false),
            handle: OnceLock::new(),
            #[cfg(feature = "v8-sandbox")]
            buffers: OnceLock::new(),
        })
    }
    pub fn set_handle(&self, h: v8::IsolateHandle) {
        let _ = self.handle.set(h);
    }
    pub fn limit(&self) -> usize {
        self.limit.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub fn used(&self) -> usize {
        self.used.load(Ordering::SeqCst)
    }
    /// The V8 heap in use at the last GC.
    pub fn heap(&self) -> usize {
        self.heap.load(Ordering::SeqCst)
    }
    /// ArrayBuffer bytes held by the C++ allocator (sandbox build; in a stock build they are in `used`).
    fn sandbox_buffers(&self) -> usize {
        #[cfg(feature = "v8-sandbox")]
        if let Some(a) = self.buffers.get() {
            return a.used();
        }
        0
    }
    /// Everything the isolate holds: heap + buffers + wasm (+ bodies in flight).
    pub fn total(&self) -> usize {
        self.used.load(Ordering::SeqCst) + self.heap() + self.sandbox_buffers()
    }
    pub fn reset_exceeded(&self) {
        self.exceeded.store(false, Ordering::SeqCst);
        self.suspect.store(false, Ordering::SeqCst);
        self.refused_at.store(NO_REFUSAL, Ordering::SeqCst);
    }
    /// Let the GC epilogue terminate this isolate for memory (while a command runs), or not.
    pub fn arm(&self, on: bool) {
        self.armed.store(on, Ordering::SeqCst);
    }
    /// Take `len` bytes, or say why not: the total (heap + buffers + wasm) would pass the limit.
    pub fn take(&self, len: usize) -> Result<(), Refusal> {
        let limit = self.limit();
        let before = self.used.fetch_add(len, Ordering::SeqCst);
        let direct = before
            .saturating_add(len)
            .saturating_add(self.sandbox_buffers());
        if direct > limit {
            self.used.fetch_sub(len, Ordering::SeqCst);
            return Err(Refusal::Over);
        }
        if direct.saturating_add(self.heap()) > limit {
            self.used.fetch_sub(len, Ordering::SeqCst);
            return Err(Refusal::Heap);
        }
        self.refused_at.store(NO_REFUSAL, Ordering::SeqCst);
        Ok(())
    }
    /// Take `len` bytes, or refuse (false) if the isolate's total would pass its limit.
    pub fn try_take(&self, len: usize) -> bool {
        self.take(len).is_ok()
    }
    /// A refusal blamed on the heap: true if it should only fail this attempt (no GC has run since the heap figure
    /// was last held against an allocation, so V8 collects and retries), false if the figure is from a GC after that
    /// (it's real: stop the isolate). V8 retries a refused ArrayBuffer allocation after a GC, up to three times.
    /// Only the stock build's Rust allocator asks (the sandbox build's C++ allocator has V8 retry on its own).
    #[cfg(any(test, not(feature = "v8-sandbox")))]
    fn soft_refusal(&self) -> bool {
        let gcs = self.gcs.load(Ordering::SeqCst);
        match self
            .refused_at
            .compare_exchange(NO_REFUSAL, gcs, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => true,
            Err(at) => at == gcs,
        }
    }
    pub fn give(&self, len: usize) {
        // Saturating subtract via CAS (never underflow if a guest over-releases).
        let mut cur = self.used.load(Ordering::SeqCst);
        loop {
            let next = cur.saturating_sub(len);
            match self
                .used
                .compare_exchange_weak(cur, next, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => break,
                Err(c) => cur = c,
            }
        }
    }
    /// The allocator refused: stop the isolate (its command answers `terminated: memory`). Only the Rust allocator
    /// calls this; under the V8 heap sandbox the C++ budget allocator handles refusal.
    #[cfg(not(feature = "v8-sandbox"))]
    fn refuse(&self) {
        self.exceeded.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.get() {
            h.terminate_execution();
        }
    }
    /// The total is over the limit (seen by the GC epilogue): stop the running command once, if one is running.
    fn trip(&self) {
        if self.armed.load(Ordering::SeqCst)
            && self
                .exceeded
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            && let Some(h) = self.handle.get()
        {
            h.terminate_execution();
        }
    }
    /// After a GC (`full`: a mark-compact): record the heap in use, and stop the isolate if heap + buffers + wasm is
    /// over the limit once dead ArrayBuffers can't be what is counted. Buffers count until V8 frees them: an old one
    /// that died is found only by a full GC, and freed by V8's sweeper after that GC's epilogue (by the next GC's
    /// start at the latest). So the total is held against the isolate when it is over at a full GC and still over
    /// at the GC after it.
    fn after_gc(&self, heap: usize, full: bool) {
        self.heap.store(heap, Ordering::SeqCst);
        self.gcs.fetch_add(1, Ordering::SeqCst);
        if self.total() <= self.limit() {
            self.suspect.store(false, Ordering::SeqCst);
        } else if self.suspect.load(Ordering::SeqCst) {
            self.trip();
        } else if full {
            self.suspect.store(true, Ordering::SeqCst);
        }
    }
    /// Terminate the isolate's running JavaScript (used by process.exit to end the run at once, without marking the
    /// budget exceeded — it is a clean exit, not a memory breach).
    pub fn stop_isolate(&self) {
        if let Some(h) = self.handle.get() {
            h.terminate_execution();
        }
    }
}

/// The GC epilogue callback (on the isolate's own thread, after every GC): records the heap in use in the isolate's
/// [`Budget`] and stops the isolate if its total is over the limit. `data` is the `Budget` (see [`gc_watch`]).
unsafe extern "C" fn gc_epilogue(
    isolate: v8::UnsafeRawIsolatePtr,
    gc_type: v8::GCType,
    _flags: v8::GCCallbackFlags,
    data: *mut std::ffi::c_void,
) {
    // SAFETY: `data` is the Budget gc_watch registered, kept alive by the GcWatch that removes this callback before
    // the isolate is dropped; the isolate pointer is the one running this GC, on this thread.
    let budget = unsafe { &*(data as *const Budget) };
    let mut isolate = unsafe { v8::Isolate::from_raw_isolate_ptr(isolate) };
    let stats = isolate.get_heap_statistics();
    budget.after_gc(
        stats.used_heap_size(),
        gc_type == v8::GCType::kGCTypeMarkSweepCompact,
    );
}

/// The GC epilogue registered on one isolate; [`GcWatch::remove`] takes it off again (before the isolate is
/// dropped, so teardown GC never reaches it).
pub struct GcWatch {
    budget: Option<Arc<Budget>>,
}

/// Record `budget`'s isolate's heap after every GC and stop it when its total memory is over (see [`Budget`]).
pub fn gc_watch(isolate: &mut v8::Isolate, budget: &Arc<Budget>) -> GcWatch {
    let data = Arc::as_ptr(budget) as *mut std::ffi::c_void;
    isolate.add_gc_epilogue_callback(gc_epilogue, data, v8::GCType::kGCTypeAll);
    GcWatch {
        budget: Some(budget.clone()),
    }
}

impl GcWatch {
    pub fn remove(&mut self, isolate: &mut v8::Isolate) {
        if let Some(budget) = self.budget.take() {
            isolate.remove_gc_epilogue_callback(
                gc_epilogue,
                Arc::as_ptr(&budget) as *mut std::ffi::c_void,
            );
        }
    }
}

// The Rust allocator: not in a V8 built with the heap sandbox, which allocates ArrayBuffers itself.
#[cfg(not(feature = "v8-sandbox"))]
fn b_take(b: &Budget, len: usize) -> bool {
    match b.take(len) {
        Ok(()) => true,
        // Over only with the heap counted: fail this attempt without stopping the isolate the first time, so V8
        // collects (which records a fresh heap figure) and retries; refused again after that GC, it is real.
        Err(Refusal::Heap) if b.soft_refusal() => false,
        Err(_) => {
            b.refuse();
            false
        }
    }
}
#[cfg(not(feature = "v8-sandbox"))]
unsafe extern "C" fn b_alloc(b: &Budget, len: usize) -> *mut std::ffi::c_void {
    if !b_take(b, len) {
        return std::ptr::null_mut();
    }
    let p = unsafe { libc::calloc(len.max(1), 1) };
    if p.is_null() {
        b.give(len);
    }
    p
}
#[cfg(not(feature = "v8-sandbox"))]
unsafe extern "C" fn b_alloc_uninit(b: &Budget, len: usize) -> *mut std::ffi::c_void {
    if !b_take(b, len) {
        return std::ptr::null_mut();
    }
    let p = unsafe { libc::malloc(len.max(1)) };
    if p.is_null() {
        b.give(len);
    }
    p
}
#[cfg(not(feature = "v8-sandbox"))]
unsafe extern "C" fn b_free(b: &Budget, data: *mut std::ffi::c_void, len: usize) {
    if !data.is_null() {
        unsafe { libc::free(data) };
        b.give(len);
    }
}
#[cfg(not(feature = "v8-sandbox"))]
unsafe extern "C" fn b_drop(b: *const Budget) {
    drop(unsafe { Arc::from_raw(b) });
}
#[cfg(not(feature = "v8-sandbox"))]
static VTABLE: v8::RustAllocatorVtable<Budget> = v8::RustAllocatorVtable {
    allocate: b_alloc,
    allocate_uninitialized: b_alloc_uninit,
    free: b_free,
    drop: b_drop,
};

// The allocator choice is behind one function so W2's V8 heap sandbox can swap it (the sandbox removes
// new_rust_allocator and refuses Rust-heap backing stores). With `--features v8-sandbox` the ArrayBuffer bytes are
// allocated by V8's own allocator inside the sandbox, bounded by W2's C++ budget allocator (to memoryMiB on its own);
// the Rust `Budget` above counts wasm reservations and reads the C++ allocator's bytes to hold the sum to memoryMiB.
// Without the feature (the default, dev build), the Rust allocator counts ArrayBuffers and wasm together.

#[cfg(not(feature = "v8-sandbox"))]
pub fn allocator(budget: &Arc<Budget>) -> v8::SharedRef<v8::Allocator> {
    // SAFETY: the vtable's functions match RustAllocatorVtable<Budget>; the Arc is released by b_drop.
    unsafe { v8::new_rust_allocator(Arc::into_raw(budget.clone()), &VTABLE) }.make_shared()
}

#[cfg(feature = "v8-sandbox")]
unsafe extern "C" {
    // Provided by W2's rusty_v8 budget-allocator patch (apps/host/isolate-runtime/v8/patches); links only against a
    // V8 built with v8/build-v8-sandbox.sh.
    fn kantel__BudgetAllocator__New(limit: usize) -> *mut v8::Allocator;
    fn kantel__BudgetAllocator__Used(allocator: *const v8::Allocator) -> usize;
}

/// The isolate's C++ budget allocator, shared with the isolate, so the budget can read its byte count from any
/// thread.
#[cfg(feature = "v8-sandbox")]
struct SandboxAllocator(v8::SharedRef<v8::Allocator>);

// SAFETY: the allocator's byte count is a std::atomic read, and SharedRef's count is a std::shared_ptr's (atomic);
// nothing else is reached through it.
#[cfg(feature = "v8-sandbox")]
unsafe impl Send for SandboxAllocator {}
#[cfg(feature = "v8-sandbox")]
unsafe impl Sync for SandboxAllocator {}

#[cfg(feature = "v8-sandbox")]
impl SandboxAllocator {
    fn used(&self) -> usize {
        let a: &v8::Allocator = &self.0;
        // SAFETY: the allocator was made by kantel__BudgetAllocator__New (allocator() below) and is alive (held).
        unsafe { kantel__BudgetAllocator__Used(a) }
    }
}

#[cfg(feature = "v8-sandbox")]
pub fn allocator(budget: &Arc<Budget>) -> v8::SharedRef<v8::Allocator> {
    // V8's in-sandbox allocator bounds ArrayBuffer bytes; the Rust Budget counts wasm reservations and the sum.
    // SAFETY: kantel__BudgetAllocator__New returns an owned Allocator* (never null: it aborts if V8 can't make its
    // default allocator); UniquePtr takes ownership, and unwrap checks it isn't null.
    let shared = unsafe { v8::UniquePtr::from_raw(kantel__BudgetAllocator__New(budget.limit())) }
        .unwrap()
        .make_shared();
    let _ = budget.buffers.set(SandboxAllocator(shared.clone()));
    shared
}

// ---------------------------------------------------------------------------------------------------------------
// CPU clocks

pub fn thread_cpu_clock() -> libc::clockid_t {
    let mut clock: libc::clockid_t = 0;
    unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut clock) };
    clock
}

pub fn cpu_time(clock: libc::clockid_t) -> Duration {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(clock, &mut ts) } != 0 {
        return Duration::ZERO;
    }
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

// ---------------------------------------------------------------------------------------------------------------
// A command's account: CPU spent by every isolate working on it, its deadline, and why it was stopped.

pub struct Command {
    pub cpu_limit: Duration,
    pub deadline: Instant,
    pub wall: Duration,
    cpu_ns: AtomicU64,
    /// Set once: the first reason the command was stopped.
    term: AtomicU8,
}

impl Command {
    pub fn new(cpu_limit: Duration, wall: Duration) -> Arc<Command> {
        Arc::new(Command {
            cpu_limit,
            deadline: Instant::now() + wall,
            wall,
            cpu_ns: AtomicU64::new(0),
            term: AtomicU8::new(0),
        })
    }
    pub fn cpu(&self) -> Duration {
        Duration::from_nanos(self.cpu_ns.load(Ordering::Relaxed))
    }
    pub fn term(&self) -> Option<Term> {
        Term::from_code(self.term.load(Ordering::SeqCst))
    }
    pub fn stop(&self, t: Term) {
        let _ = self
            .term
            .compare_exchange(0, t.code(), Ordering::SeqCst, Ordering::SeqCst);
    }
    fn over(&self) -> Option<Term> {
        if self.cpu() > self.cpu_limit {
            Some(Term::Cpu)
        } else if Instant::now() >= self.deadline {
            Some(Term::Wall)
        } else {
            None
        }
    }
}

/// One isolate running for a command, watched until the guard is dropped.
pub struct Watched {
    handle: v8::IsolateHandle,
    clock: libc::clockid_t,
    last_cpu: Mutex<Duration>,
    command: Arc<Command>,
    budget: Arc<Budget>,
    /// This isolate's own reason (a child stopped for its own memory doesn't stop the parent).
    term: AtomicU8,
    done: AtomicBool,
}

impl Watched {
    pub fn term(&self) -> Option<Term> {
        Term::from_code(self.term.load(Ordering::SeqCst)).or_else(|| {
            if self.budget.exceeded.load(Ordering::SeqCst) {
                Some(Term::Memory)
            } else {
                None
            }
        })
    }
    /// Resolves once this isolate has been stopped, so the run can abandon the in-flight call. Awaiting a terminated
    /// call to its error instead leaves the isolate in a state where dropping it aborts V8, so callers race this
    /// against the call and, when it wins, drop the call future unpolled. Polls because the watchdog is a separate
    /// thread; a command runs at most a few seconds so the 2 ms tick is negligible.
    pub async fn tripped(&self) {
        while self.term().is_none() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    /// Stop this isolate now for `t` (first reason wins).
    pub fn stop(&self, t: Term) {
        let _ = self
            .term
            .compare_exchange(0, t.code(), Ordering::SeqCst, Ordering::SeqCst);
        self.handle.terminate_execution();
    }
    fn account(&self) {
        let now = cpu_time(self.clock);
        let mut last = self.last_cpu.lock().unwrap();
        let delta = now.saturating_sub(*last);
        *last = now;
        self.command
            .cpu_ns
            .fetch_add(delta.as_nanos() as u64, Ordering::Relaxed);
    }
}

pub struct Guard {
    w: Arc<Watched>,
}

impl Guard {
    pub fn watched(&self) -> &Arc<Watched> {
        &self.w
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.w.account();
        self.w.budget.arm(false);
        self.w.done.store(true, Ordering::SeqCst);
    }
}

static WATCHED: Mutex<Vec<Weak<Watched>>> = Mutex::new(Vec::new());
static STARTED: OnceLock<()> = OnceLock::new();

/// Watch the isolate on the current thread for `command` until the returned guard is dropped.
pub fn watch(handle: v8::IsolateHandle, command: Arc<Command>, budget: Arc<Budget>) -> Guard {
    STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("kt-watchdog".into())
            .spawn(watchdog)
            .expect("watchdog thread");
    });
    let clock = thread_cpu_clock();
    let w = Arc::new(Watched {
        handle,
        clock,
        last_cpu: Mutex::new(cpu_time(clock)),
        command,
        budget,
        term: AtomicU8::new(0),
        done: AtomicBool::new(false),
    });
    w.budget.arm(true);
    WATCHED.lock().unwrap().push(Arc::downgrade(&w));
    Guard { w }
}

/// One watchdog thread for the process: every few milliseconds it adds each running isolate's thread CPU to its
/// command's total and terminates past the CPU budget or the wall deadline (memory is enforced on the isolate's own
/// thread: the budget, the GC epilogue and the near-heap-limit callback; the watchdog never touches V8 state — doing
/// so from another thread would abort the process — it only keeps terminating an isolate whose budget is exceeded).
fn watchdog() {
    loop {
        std::thread::sleep(TICK);
        let live: Vec<Arc<Watched>> = {
            let mut list = WATCHED.lock().unwrap();
            list.retain(|w| w.upgrade().is_some_and(|w| !w.done.load(Ordering::SeqCst)));
            list.iter().filter_map(|w| w.upgrade()).collect()
        };
        for w in live {
            if w.done.load(Ordering::SeqCst) {
                continue;
            }
            w.account();
            // Act on any reason, including budget.exceeded (a heap breach the near-heap callback couldn't terminate
            // on because it already fired once): keep calling terminate_execution (idempotent) rather than skipping,
            // so a reused isolate whose heap guard is spent is still stopped, and CPU/wall stay enforced.
            if let Some(t) = w
                .term()
                .or_else(|| w.command.term().filter(|t| *t != Term::Exit))
                .or_else(|| w.command.over())
            {
                w.command.stop(t);
                w.stop(t);
            }
        }
    }
}

/// The near-heap-limit callback: the isolate reached its heap ceiling (memoryMiB). On the first hit it marks the
/// budget and terminates the running script; it then raises the limit so V8 can unwind. It terminates only once: GC
/// while the terminated isolate is being torn down re-enters this callback, and calling terminate_execution then
/// would re-arm the terminate flag mid-destroy and abort the process, so later hits only grant headroom.
pub fn near_heap_limit(
    budget: &Arc<Budget>,
    handle: v8::IsolateHandle,
) -> impl FnMut(usize, usize) -> usize + 'static {
    let budget = budget.clone();
    let mut fired = false;
    move |current, _initial| {
        budget.exceeded.store(true, Ordering::SeqCst);
        if !fired {
            fired = true;
            handle.terminate_execution();
        }
        current + UNWIND_HEADROOM
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_refuses_past_limit() {
        let b = Budget::new(10 * MIB);
        assert!(b.try_take(6 * MIB));
        assert!(!b.try_take(5 * MIB));
        b.give(6 * MIB);
        assert!(b.try_take(4 * MIB));
        assert_eq!(b.used(), 4 * MIB);
        // Over-release saturates at zero.
        b.give(10 * MIB);
        assert_eq!(b.used(), 0);
    }

    #[test]
    fn budget_holds_heap_buffers_and_wasm_to_one_limit() {
        let b = Budget::new(100 * MIB);
        b.after_gc(60 * MIB, false);
        assert_eq!(b.take(30 * MIB), Ok(()));
        // Fits on its own, not with the heap: a GC may help.
        assert_eq!(b.take(20 * MIB), Err(Refusal::Heap));
        // Over even without the heap: nothing helps.
        assert_eq!(b.take(80 * MIB), Err(Refusal::Over));
        assert_eq!(b.total(), 90 * MIB);
        b.after_gc(10 * MIB, false);
        assert_eq!(b.take(20 * MIB), Ok(()));
    }

    #[test]
    fn a_refusal_blamed_on_the_heap_is_soft_until_a_gc_has_run() {
        let b = Budget::new(100 * MIB);
        b.after_gc(80 * MIB, false);
        assert!(b.soft_refusal()); // let V8 collect and retry
        assert!(b.soft_refusal()); // no GC since: still the same figure
        b.after_gc(80 * MIB, false);
        assert!(!b.soft_refusal()); // collected and still over: real
        b.reset_exceeded();
        assert!(b.soft_refusal());
    }

    #[test]
    fn over_at_a_full_gc_and_the_next_stops_an_armed_isolate() {
        let b = Budget::new(100 * MIB);
        assert!(b.try_take(50 * MIB));
        // Not running a command: never stopped (teardown GC).
        b.after_gc(60 * MIB, true);
        b.after_gc(60 * MIB, false);
        assert!(!b.exceeded.load(Ordering::SeqCst));
        b.reset_exceeded();
        b.arm(true);
        // Over at minor GCs only: dead old buffers may be what is counted.
        b.after_gc(60 * MIB, false);
        b.after_gc(60 * MIB, false);
        assert!(!b.exceeded.load(Ordering::SeqCst));
        // Over at a full GC, then under (the buffers it found dead were freed).
        b.after_gc(60 * MIB, true);
        b.after_gc(40 * MIB, false);
        b.after_gc(60 * MIB, false);
        assert!(!b.exceeded.load(Ordering::SeqCst));
        // Over at a full GC and at the one after it.
        b.after_gc(60 * MIB, true);
        assert!(!b.exceeded.load(Ordering::SeqCst));
        b.after_gc(60 * MIB, false);
        assert!(b.exceeded.load(Ordering::SeqCst));
    }

    #[test]
    fn command_first_reason_wins() {
        let c = Command::new(Duration::from_secs(1), Duration::from_secs(1));
        assert_eq!(c.term(), None);
        c.stop(Term::Cpu);
        c.stop(Term::Wall);
        assert_eq!(c.term(), Some(Term::Cpu));
    }

    #[test]
    fn command_over_on_deadline() {
        let c = Command::new(Duration::from_secs(10), Duration::from_millis(0));
        assert_eq!(c.over(), Some(Term::Wall));
        let c = Command::new(Duration::from_secs(10), Duration::from_secs(10));
        c.cpu_ns.store(11_000_000_000, Ordering::Relaxed);
        assert_eq!(c.over(), Some(Term::Cpu));
    }

    #[test]
    fn exit_codes_match_the_contract() {
        assert_eq!(Term::Memory.exit_code(), 137);
        assert_eq!(Term::Cpu.exit_code(), 152);
        assert_eq!(Term::Wall.exit_code(), 152);
    }
}
