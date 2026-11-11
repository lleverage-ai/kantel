//! Per-isolate limits: one memory budget (V8 heap, ArrayBuffers and wasm memory together), a CPU budget per command
//! (an isolate's own thread CPU, plus its children's, against one total) and a wall-clock deadline.
//!
//! - Heap: each isolate starts with a 128 MiB V8 heap limit; the near-heap-limit callback raises it to the isolate's
//!   memoryMiB (so a pooled isolate can serve any size) and past that terminates the isolate.
//! - ArrayBuffers: allocated through [`Budget`], which refuses an allocation that would take the isolate past its
//!   memoryMiB (counting wasm reservations and the last sampled heap size) and terminates the isolate.
//! - Wasm memory: reserved in the same [`Budget`] by the guest's wasm guard (op_kt_wasm_reserve).
//! - The watchdog, one thread for the process, ticks every few milliseconds over every running command: it adds
//!   each isolate thread's CPU time to its command's total and terminates past the budget or the deadline, and asks
//!   each isolate (an interrupt, run on its own thread) for its heap size, terminating if heap + budget is over.

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
            Term::Cpu => format!("{what}: stopped: exceeded the CPU limit ({} ms)\n", cpu.as_millis()),
            Term::Wall => format!("{what}: stopped: timed out after {} ms\n", wall.as_millis()),
            Term::Cancel => format!("{what}: stopped\n"),
            Term::Exit => String::new(),
        }
    }
}

/// One isolate's memory budget for ArrayBuffers and WebAssembly memory. The V8 heap is bounded separately by the
/// isolate's heap limit (memoryMiB) and the near-heap-limit callback; typed-array/ArrayBuffer backing stores and
/// wasm memory are outside the heap, so they draw on this budget, also capped at memoryMiB. (So heap and
/// buffers/wasm are each bounded by memoryMiB rather than summed into one figure — see README "Known gaps".)
pub struct Budget {
    limit: AtomicUsize,
    used: AtomicUsize,
    /// Set when this budget refused an allocation; the isolate is being terminated.
    pub exceeded: AtomicBool,
    handle: OnceLock<v8::IsolateHandle>,
}

impl Budget {
    pub fn new(limit: usize) -> Arc<Budget> {
        Arc::new(Budget {
            limit: AtomicUsize::new(limit),
            used: AtomicUsize::new(0),
            exceeded: AtomicBool::new(false),
            handle: OnceLock::new(),
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
    pub fn reset_exceeded(&self) {
        self.exceeded.store(false, Ordering::SeqCst);
    }
    /// Take `len` bytes, or refuse (false) if the isolate's buffers would pass its limit.
    pub fn try_take(&self, len: usize) -> bool {
        let before = self.used.fetch_add(len, Ordering::SeqCst);
        if before + len > self.limit() {
            self.used.fetch_sub(len, Ordering::SeqCst);
            return false;
        }
        true
    }
    pub fn give(&self, len: usize) {
        // Saturating subtract via CAS (never underflow if a guest over-releases).
        let mut cur = self.used.load(Ordering::SeqCst);
        loop {
            let next = cur.saturating_sub(len);
            match self.used.compare_exchange_weak(cur, next, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => break,
                Err(c) => cur = c,
            }
        }
    }
    /// The allocator refused: stop the isolate (its command answers `terminated: memory`).
    fn refuse(&self) {
        self.exceeded.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.get() {
            h.terminate_execution();
        }
    }
}

// The Rust allocator: not in a V8 built with the heap sandbox, which allocates ArrayBuffers itself.
#[cfg(not(feature = "v8-sandbox"))]
unsafe extern "C" fn b_alloc(b: &Budget, len: usize) -> *mut std::ffi::c_void {
    if !b.try_take(len) {
        b.refuse();
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
    if !b.try_take(len) {
        b.refuse();
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
static VTABLE: v8::RustAllocatorVtable<Budget> =
    v8::RustAllocatorVtable { allocate: b_alloc, allocate_uninitialized: b_alloc_uninit, free: b_free, drop: b_drop };

// The allocator choice is behind one function so W2's V8 heap sandbox can swap it (the sandbox removes
// new_rust_allocator and refuses Rust-heap backing stores). With `--features v8-sandbox` the ArrayBuffer bytes are
// allocated by V8's own allocator inside the sandbox, bounded by W2's C++ budget allocator; the Rust `Budget` above
// then only counts wasm reservations (op_kt_wasm_reserve). Without the feature (the default, dev build), the Rust
// allocator counts ArrayBuffers and wasm together.

#[cfg(not(feature = "v8-sandbox"))]
pub fn allocator(budget: &Arc<Budget>) -> v8::UniqueRef<v8::Allocator> {
    // SAFETY: the vtable's functions match RustAllocatorVtable<Budget>; the Arc is released by b_drop.
    unsafe { v8::new_rust_allocator(Arc::into_raw(budget.clone()), &VTABLE) }
}

#[cfg(feature = "v8-sandbox")]
unsafe extern "C" {
    // Provided by W2's rusty_v8 budget-allocator patch (apps/host/isolate-runtime/v8/patches); links only against a
    // V8 built with v8/build-v8-sandbox.sh.
    fn kantel__BudgetAllocator__New(limit: usize) -> *mut v8::Allocator;
}

#[cfg(feature = "v8-sandbox")]
pub fn allocator(budget: &Arc<Budget>) -> v8::UniqueRef<v8::Allocator> {
    // V8's in-sandbox allocator bounds ArrayBuffer bytes; the Rust Budget keeps counting wasm reservations.
    // SAFETY: kantel__BudgetAllocator__New returns an owned Allocator* (never null: it aborts if V8 can't make its
    // default allocator); UniquePtr takes ownership, and unwrap checks it isn't null.
    unsafe { v8::UniquePtr::from_raw(kantel__BudgetAllocator__New(budget.limit())) }.unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// CPU clocks

pub fn thread_cpu_clock() -> libc::clockid_t {
    let mut clock: libc::clockid_t = 0;
    unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut clock) };
    clock
}

pub fn cpu_time(clock: libc::clockid_t) -> Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
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
        let _ = self.term.compare_exchange(0, t.code(), Ordering::SeqCst, Ordering::SeqCst);
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
            if self.budget.exceeded.load(Ordering::SeqCst) { Some(Term::Memory) } else { None }
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
        let _ = self.term.compare_exchange(0, t.code(), Ordering::SeqCst, Ordering::SeqCst);
        self.handle.terminate_execution();
    }
    fn account(&self) {
        let now = cpu_time(self.clock);
        let mut last = self.last_cpu.lock().unwrap();
        let delta = now.saturating_sub(*last);
        *last = now;
        self.command.cpu_ns.fetch_add(delta.as_nanos() as u64, Ordering::Relaxed);
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
        self.w.done.store(true, Ordering::SeqCst);
    }
}

static WATCHED: Mutex<Vec<Weak<Watched>>> = Mutex::new(Vec::new());
static STARTED: OnceLock<()> = OnceLock::new();

/// Watch the isolate on the current thread for `command` until the returned guard is dropped.
pub fn watch(handle: v8::IsolateHandle, command: Arc<Command>, budget: Arc<Budget>) -> Guard {
    STARTED.get_or_init(|| {
        std::thread::Builder::new().name("kt-watchdog".into()).spawn(watchdog).expect("watchdog thread");
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
    WATCHED.lock().unwrap().push(Arc::downgrade(&w));
    Guard { w }
}

/// One watchdog thread for the process: every few milliseconds it adds each running isolate's thread CPU to its
/// command's total and terminates past the CPU budget or the wall deadline (the heap and ArrayBuffer/wasm limits are
/// enforced by the near-heap-limit callback and the budget allocator on the isolate's own thread, so the watchdog
/// never touches V8 state — doing so from another thread would abort the process).
fn watchdog() {
    loop {
        std::thread::sleep(TICK);
        let live: Vec<Arc<Watched>> = {
            let mut list = WATCHED.lock().unwrap();
            list.retain(|w| w.upgrade().is_some_and(|w| !w.done.load(Ordering::SeqCst)));
            list.iter().filter_map(|w| w.upgrade()).collect()
        };
        for w in live {
            if w.term().is_some() || w.done.load(Ordering::SeqCst) {
                continue;
            }
            w.account();
            if let Some(t) = w.command.term().filter(|t| *t != Term::Exit).or_else(|| w.command.over()) {
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
pub fn near_heap_limit(budget: &Arc<Budget>, handle: v8::IsolateHandle) -> impl FnMut(usize, usize) -> usize + 'static {
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
