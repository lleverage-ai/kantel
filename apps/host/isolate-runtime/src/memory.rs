//! One memory budget for an isolate the embedder makes itself (a program isolate, say), on the stock V8 and on the
//! sandboxed one alike: the V8 heap, ArrayBuffers and WebAssembly memory held to one limit, as the runtime holds its
//! own isolates.
//!
//! The ArrayBuffer allocator is the part that differs between the two V8s. The stock V8 takes a Rust allocator
//! (`v8::new_rust_allocator`) that charges the budget; the sandboxed V8 has no Rust allocator at all (its
//! ArrayBuffers must live inside the sandbox) and takes Kantel's in-sandbox budget allocator, whose byte count the
//! budget reads. [`array_buffer_allocator`] picks the right one for the build, so an embedder never names either.
//!
//! ```no_run
//! # fn main() {
//! use std::time::Duration;
//!
//! use kantel_isolate::memory::{self, Budget};
//!
//! // Inside a tokio runtime context, as for any deno_core runtime.
//! let budget = Budget::new(256 << 20);
//! let mut rt = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
//!     create_params: Some(memory::create_params(&budget)),
//!     ..Default::default()
//! });
//! let mut watch = memory::watch(&mut rt, &budget);
//! // While guest code runs, on the isolate's thread: over the budget, its CPU or its wall clock, it is stopped.
//! let running = memory::enforce(&mut rt, &budget, Duration::from_secs(30), Duration::from_secs(60));
//! // ... run code; running.watched().term() says why it was stopped, if it was ...
//! drop(running);
//! watch.remove(&mut rt); // Before the isolate is dropped.
//! # }
//! ```
//!
//! WebAssembly memory isn't allocated through the ArrayBuffer allocator: it is counted only when the guest reserves
//! it in the budget, as Kantel's wasm guard does (`guest/common/wasm-guard.js`, through `op_kt_wasm_reserve`).

use std::sync::Arc;
use std::time::Duration;

use deno_core::{JsRuntime, v8};

pub use crate::limits::{Budget, Guard, Refusal, Term};
use crate::limits::{Command, Scope};

/// The ArrayBuffer allocator for an isolate held to `budget`, for this build's V8: a Rust allocator that charges the
/// budget on the stock V8, Kantel's in-sandbox budget allocator on the sandboxed one. Use it wherever
/// `v8::new_rust_allocator` would be (the sandboxed V8 doesn't have that).
pub fn array_buffer_allocator(budget: &Arc<Budget>) -> v8::SharedRef<v8::Allocator> {
    crate::limits::allocator(budget)
}

/// An isolate's creation parameters for `budget`: its heap limited to the budget's limit, and
/// [`array_buffer_allocator`].
pub fn create_params(budget: &Arc<Budget>) -> v8::CreateParams {
    v8::CreateParams::default()
        .heap_limits(0, budget.limit())
        .array_buffer_allocator(array_buffer_allocator(budget))
}

/// The budget's watch on one isolate: a GC epilogue that records the heap and stops the isolate when its total is
/// over the limit (while the budget is armed), and a near-heap-limit callback that stops it at the heap limit.
/// [`MemoryWatch::remove`] it before the isolate is dropped, so teardown's GC doesn't reach the budget.
pub struct MemoryWatch(crate::limits::GcWatch);

impl MemoryWatch {
    pub fn remove(&mut self, rt: &mut JsRuntime) {
        self.0.remove(rt.v8_isolate());
    }
}

/// Enforce the budget, and `cpu` (this thread's CPU time) and `wall`, on `rt`'s isolate while the returned guard
/// lives, as the runtime does for its own isolates: a GC that finds the total over the limit stops the isolate (at
/// the GC after it, or a moment later if the program stops allocating), as do the heap limit and the CPU and wall-clock
/// limits. Call it on the isolate's own thread just before guest code runs, after [`watch`]; drop the guard when it
/// ends, before the isolate is dropped. `guard.watched().term()` is why the isolate was stopped, if it was. Call
/// `budget.reset_exceeded()` before each run after the first, so a refusal in the last doesn't count against it.
pub fn enforce(rt: &mut JsRuntime, budget: &Arc<Budget>, cpu: Duration, wall: Duration) -> Guard {
    let handle = rt.v8_isolate().thread_safe_handle();
    crate::limits::watch(
        handle,
        Command::new(cpu, wall),
        budget.clone(),
        Scope::Command,
    )
}

/// Record `rt`'s isolate's heap in `budget` after every GC, and stop it at its heap limit. `rt` is made with
/// [`create_params`] for the same budget. The budget is enforced only while [`enforce`]'s guard lives.
pub fn watch(rt: &mut JsRuntime, budget: &Arc<Budget>) -> MemoryWatch {
    let handle = rt.v8_isolate().thread_safe_handle();
    budget.set_handle(handle.clone());
    rt.add_near_heap_limit_callback(crate::limits::near_heap_limit(budget, handle));
    MemoryWatch(crate::limits::gc_watch(rt.v8_isolate(), budget))
}
