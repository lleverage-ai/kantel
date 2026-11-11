// Bring host bytes under the isolate's memory budget (review finding H4). Ops that return a buffer and the
// core.encode() builtin wrap a Rust-owned Vec as an external ArrayBuffer (new_backing_store_from_vec), which the
// budget ArrayBuffer allocator never sees, so a guest could retain gigabytes of them under a 256 MiB budget
// (`for (i<100) held.push(Buffer.from("x".repeat(16*1024*1024)))`).
//
// `budgetedCopy` copies the bytes into a `new Uint8Array`, whose backing store DOES go through the budget allocator:
// it is charged on allocation (and refused — V8 throws RangeError — when the budget is spent) and released when the
// copy is collected. The transient host buffer is freed promptly. In a V8-heap-sandbox build the allocator already
// charges host bytes (W2's serde_v8 patch), so this copy is only belt-and-braces there, never a second charge that
// sticks. Uses primordials so a guest can't swap Uint8Array/its set to dodge the copy.
import { Prim } from "./primordials.js";

const { newUint8Array, uint8Set } = Prim;

/** A budget-allocated copy of `bytes` (a Uint8Array). Throws RangeError if the isolate's budget can't hold it. */
export function budgetedCopy(bytes) {
	const out = newUint8Array(bytes.length);
	uint8Set(out, bytes);
	return out;
}
