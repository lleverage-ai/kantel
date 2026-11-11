//! Bytes the host hands a guest, charged to the isolate's memory before the guest can see them.
//!
//! deno_core turns an op's `Vec<u8>` (and `core.encode`'s result) into an ArrayBuffer over the Rust-owned memory
//! (`new_backing_store_from_vec`), which an ArrayBuffer allocator never sees. In a stock build that memory was outside
//! the isolate's budget, and copying it into a budgeted buffer in JavaScript isn't a boundary: the guest can observe
//! the host buffer first (a replaced `length` getter, a destination's own `set`, an `Object.prototype.then` getter
//! when an async op's promise resolves with it) and keep it. So every op that returns bytes answers a [`HostBytes`]:
//!
//! - in a stock build its bytes are charged to the isolate's [`Budget`] in the op, before they are returned (refused
//!   with a RangeError past the isolate's memory, as an ArrayBuffer allocation is), and become the backing store of
//!   the guest's Uint8Array, which gives the charge back when V8 frees it;
//! - in a `v8-sandbox` build they are copied into a buffer from the isolate's own allocator (budgeted, in the
//!   sandbox), as the patched deno_core does for its own conversions.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use deno_core::convert::ToV8;
use deno_core::{OpState, v8};
use deno_error::JsErrorBox;

use crate::limits::Budget;

/// The isolate's budget, in its OpState from the moment the isolate is made (before any guest code), so the ops can
/// charge what they return whether or not a command has bound its context.
pub struct IsolateBudget(pub Arc<Budget>);

/// The isolate's budget (None only in the startup-snapshot builder, which runs no guest code).
pub fn budget_of(state: &OpState) -> Option<Arc<Budget>> {
    state.try_borrow::<IsolateBudget>().map(|b| b.0.clone())
}

const REFUSED: &str = "Array buffer allocation failed: out of memory (this isolate's memory limit counts host data too)";

/// Bytes an op returns to the guest, as a Uint8Array (see the module docs). In a stock build, made only by
/// [`HostBytes::charge`] or [`HostBytes::adopt`], so the bytes are charged before the op returns; dropped unconverted
/// (an op whose result is discarded), the charge is given back.
pub struct HostBytes(Inner);

enum Inner {
    #[cfg(not(feature = "v8-sandbox"))]
    Charged(Charged),
    Plain(Vec<u8>),
}

/// The bytes and their charge, given back when dropped: as a backing store, when V8 frees it (on any thread).
#[cfg(not(feature = "v8-sandbox"))]
struct Charged {
    bytes: Vec<u8>,
    budget: Arc<Budget>,
}

#[cfg(not(feature = "v8-sandbox"))]
impl AsMut<[u8]> for Charged {
    fn as_mut(&mut self) -> &mut [u8] {
        &mut self.bytes
    }
}

#[cfg(not(feature = "v8-sandbox"))]
impl Drop for Charged {
    fn drop(&mut self) {
        self.budget.give(self.bytes.len());
    }
}

impl HostBytes {
    /// Bytes for a synchronous op's result, charged now. Refused, it collects garbage and asks again (the heap figure
    /// from the last GC can be stale, and buffers the program has dropped are counted until V8 frees them); refused
    /// again, the op throws a RangeError. The OpState is borrowed only to find the budget, never across the GC.
    pub fn charge(
        isolate: &mut v8::Isolate,
        state: &Rc<RefCell<OpState>>,
        bytes: Vec<u8>,
    ) -> Result<HostBytes, JsErrorBox> {
        let budget = budget_of(&state.borrow());
        #[cfg(not(feature = "v8-sandbox"))]
        if let Some(budget) = budget
            && !bytes.is_empty()
        {
            if budget.take(bytes.len()).is_err() {
                isolate.low_memory_notification();
                if !budget.try_take(bytes.len()) {
                    return Err(JsErrorBox::range_error(REFUSED));
                }
            }
            return Ok(HostBytes(Inner::Charged(Charged { bytes, budget })));
        }
        #[cfg(feature = "v8-sandbox")]
        let _ = (isolate, budget);
        Ok(HostBytes(Inner::Plain(bytes)))
    }

    /// Bytes for an asynchronous op's result (no isolate to collect garbage on), of which `held` bytes are already
    /// charged to `budget` (a body charged as it arrived): the charge is made to match the bytes' length.
    pub fn adopt(
        budget: Option<Arc<Budget>>,
        bytes: Vec<u8>,
        held: usize,
    ) -> Result<HostBytes, JsErrorBox> {
        let Some(budget) = budget else {
            return Ok(HostBytes(Inner::Plain(bytes)));
        };
        #[cfg(not(feature = "v8-sandbox"))]
        {
            let len = bytes.len();
            if len > held {
                if !budget.try_take(len - held) {
                    budget.give(held);
                    return Err(JsErrorBox::range_error(REFUSED));
                }
            } else {
                budget.give(held - len);
            }
            Ok(HostBytes(Inner::Charged(Charged { bytes, budget })))
        }
        // The isolate's allocator charges the copy made at conversion.
        #[cfg(feature = "v8-sandbox")]
        {
            budget.give(held);
            Ok(HostBytes(Inner::Plain(bytes)))
        }
    }
}

impl<'a> ToV8<'a> for HostBytes {
    type Error = JsErrorBox;
    fn to_v8<'i>(
        self,
        scope: &mut v8::PinScope<'a, 'i>,
    ) -> Result<v8::Local<'a, v8::Value>, JsErrorBox> {
        let (buffer, len) = match self.0 {
            #[cfg(not(feature = "v8-sandbox"))]
            Inner::Charged(charged) => {
                let len = charged.bytes.len();
                let store = v8::ArrayBuffer::new_backing_store_from_bytes(Box::new(charged));
                (
                    v8::ArrayBuffer::with_backing_store(scope, &store.make_shared()),
                    len,
                )
            }
            Inner::Plain(bytes) => {
                let len = bytes.len();
                (plain(scope, bytes)?, len)
            }
        };
        let view = v8::Uint8Array::new(scope, buffer, 0, len)
            .ok_or_else(|| JsErrorBox::range_error(REFUSED))?;
        Ok(view.into())
    }
}

/// Stock build: empty bytes, or the snapshot builder's (no budget, and no guest code to see them).
#[cfg(not(feature = "v8-sandbox"))]
fn plain<'a>(
    scope: &mut v8::PinScope<'a, '_>,
    bytes: Vec<u8>,
) -> Result<v8::Local<'a, v8::ArrayBuffer>, JsErrorBox> {
    if bytes.is_empty() {
        return Ok(v8::ArrayBuffer::new(scope, 0));
    }
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes);
    Ok(v8::ArrayBuffer::with_backing_store(
        scope,
        &store.make_shared(),
    ))
}

/// Sandbox build: a copy in a buffer from the isolate's in-sandbox budget allocator (refused past memoryMiB), the
/// GC epilogue then holding heap + buffers + wasm to the limit, as for every other buffer in a sandbox build.
#[cfg(feature = "v8-sandbox")]
fn plain<'a>(
    scope: &mut v8::PinScope<'a, '_>,
    bytes: Vec<u8>,
) -> Result<v8::Local<'a, v8::ArrayBuffer>, JsErrorBox> {
    deno_core::serde_v8::sandbox::new_array_buffer(scope, &bytes)
        .ok_or_else(|| JsErrorBox::range_error(REFUSED))
}
