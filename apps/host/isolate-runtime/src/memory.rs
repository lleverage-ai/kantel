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
//! use kantel_isolate::memory::{self, Budget};
//!
//! // Inside a tokio runtime context, as for any deno_core runtime.
//! let budget = Budget::new(256 << 20);
//! let mut rt = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
//!     create_params: Some(memory::create_params(&budget)),
//!     ..Default::default()
//! });
//! let mut watch = memory::watch(&mut rt, &budget);
//! budget.arm(true); // While the isolate runs guest code: a total over the limit stops it.
//! // ... run code ...
//! budget.arm(false);
//! watch.remove(&mut rt); // Before the isolate is dropped.
//! # }
//! ```
//!
//! WebAssembly memory isn't allocated through the ArrayBuffer allocator: it is counted only when the guest reserves
//! it in the budget, as Kantel's wasm guard does (`guest/common/wasm-guard.js`, through `op_kt_wasm_reserve`).

use std::sync::Arc;

use deno_core::{JsRuntime, v8};

pub use crate::limits::{Budget, Refusal};

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

/// Hold `rt`'s isolate (made with [`create_params`] for the same budget) to `budget`.
pub fn watch(rt: &mut JsRuntime, budget: &Arc<Budget>) -> MemoryWatch {
    let handle = rt.v8_isolate().thread_safe_handle();
    budget.set_handle(handle.clone());
    rt.add_near_heap_limit_callback(crate::limits::near_heap_limit(budget, handle));
    MemoryWatch(crate::limits::gc_watch(rt.v8_isolate(), budget))
}
